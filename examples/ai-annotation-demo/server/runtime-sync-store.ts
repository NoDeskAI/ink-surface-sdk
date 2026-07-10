import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

export interface RuntimeSyncNamespace {
  tenant_id?: string;
  user_id?: string;
}

export interface StoredRuntimeEvent {
  sequence: number;
  event: RuntimeSyncEvent;
  tenant_id?: string;
  user_id?: string;
}

export interface RuntimeSyncEventStore {
  findByEventId(namespace: RuntimeSyncNamespace, eventId: string): Promise<StoredRuntimeEvent | null>;
  append(input: Omit<StoredRuntimeEvent, 'sequence'>): Promise<StoredRuntimeEvent>;
  eventsAfter(namespace: RuntimeSyncNamespace, cursor: number, limit: number): Promise<StoredRuntimeEvent[]>;
  latestSequence(namespace?: RuntimeSyncNamespace): Promise<number>;
  hasAfter(namespace: RuntimeSyncNamespace, cursor: number): Promise<boolean>;
}

function sameNamespace(item: StoredRuntimeEvent, namespace: RuntimeSyncNamespace): boolean {
  if (!namespace.tenant_id || !namespace.user_id) return !item.tenant_id && !item.user_id;
  return item.tenant_id === namespace.tenant_id && item.user_id === namespace.user_id;
}

function storedEventKey(item: Pick<StoredRuntimeEvent, 'tenant_id' | 'user_id' | 'event'>): string {
  return `${item.tenant_id || ''}\u0000${item.user_id || ''}\u0000${item.event.event_id}`;
}

function nextSequence(events: readonly StoredRuntimeEvent[]): number {
  return Math.max(0, ...events.map((item) => item.sequence)) + 1;
}

export class MemoryRuntimeSyncEventStore implements RuntimeSyncEventStore {
  private readonly events: StoredRuntimeEvent[] = [];

  async findByEventId(namespace: RuntimeSyncNamespace, eventId: string): Promise<StoredRuntimeEvent | null> {
    return this.events.find((item) => sameNamespace(item, namespace) && item.event.event_id === eventId) ?? null;
  }

  async append(input: Omit<StoredRuntimeEvent, 'sequence'>): Promise<StoredRuntimeEvent> {
    const existing = this.events.find((item) => storedEventKey(item) === storedEventKey(input));
    if (existing) return existing;
    const record: StoredRuntimeEvent = { ...input, sequence: nextSequence(this.events) };
    this.events.push(record);
    return record;
  }

  async eventsAfter(namespace: RuntimeSyncNamespace, cursor: number, limit: number): Promise<StoredRuntimeEvent[]> {
    return this.events.filter((item) => sameNamespace(item, namespace) && item.sequence > cursor).slice(0, limit);
  }

  async latestSequence(namespace?: RuntimeSyncNamespace): Promise<number> {
    const events = namespace ? this.events.filter((item) => sameNamespace(item, namespace)) : this.events;
    return Math.max(0, ...events.map((item) => item.sequence));
  }

  async hasAfter(namespace: RuntimeSyncNamespace, cursor: number): Promise<boolean> {
    return this.events.some((item) => sameNamespace(item, namespace) && item.sequence > cursor);
  }
}

export class JsonlRuntimeSyncEventStore implements RuntimeSyncEventStore {
  private readonly events: StoredRuntimeEvent[] = [];
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let raw = '';
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed) as StoredRuntimeEvent;
        if (typeof item.sequence === 'number' && item.event?.event_id) this.events.push(item);
      } catch {
        // Keep loading valid records even if a trailing or manually edited line is corrupt.
      }
    }
    const byIdentity = new Map<string, StoredRuntimeEvent>();
    for (const event of this.events.sort((a, b) => a.sequence - b.sequence)) {
      byIdentity.set(storedEventKey(event), event);
    }
    this.events.length = 0;
    this.events.push(...[...byIdentity.values()].sort((a, b) => a.sequence - b.sequence));
  }

  async findByEventId(namespace: RuntimeSyncNamespace, eventId: string): Promise<StoredRuntimeEvent | null> {
    await this.ready;
    return this.events.find((item) => sameNamespace(item, namespace) && item.event.event_id === eventId) ?? null;
  }

  async append(input: Omit<StoredRuntimeEvent, 'sequence'>): Promise<StoredRuntimeEvent> {
    await this.ready;
    const existing = this.events.find((item) => storedEventKey(item) === storedEventKey(input));
    if (existing) return existing;
    const record: StoredRuntimeEvent = { ...input, sequence: nextSequence(this.events) };
    this.events.push(record);
    const line = JSON.stringify(record) + '\n';
    this.writeQueue = this.writeQueue.then(() => appendFile(this.filePath, line, 'utf8'));
    await this.writeQueue;
    return record;
  }

  async eventsAfter(namespace: RuntimeSyncNamespace, cursor: number, limit: number): Promise<StoredRuntimeEvent[]> {
    await this.ready;
    return this.events.filter((item) => sameNamespace(item, namespace) && item.sequence > cursor).slice(0, limit);
  }

  async latestSequence(namespace?: RuntimeSyncNamespace): Promise<number> {
    await this.ready;
    const events = namespace ? this.events.filter((item) => sameNamespace(item, namespace)) : this.events;
    return Math.max(0, ...events.map((item) => item.sequence));
  }

  async hasAfter(namespace: RuntimeSyncNamespace, cursor: number): Promise<boolean> {
    await this.ready;
    return this.events.some((item) => sameNamespace(item, namespace) && item.sequence > cursor);
  }
}
