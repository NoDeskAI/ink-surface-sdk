import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';

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
  isDocumentDeleted(namespace: RuntimeSyncNamespace, documentId: string): Promise<boolean>;
  deleteDocument(namespace: RuntimeSyncNamespace, documentId: string): Promise<number>;
}

interface RuntimeDocumentDeletion {
  record_type: 'runtime_document_deletion';
  schema_version: 'inkloop.runtime_document_deletion.v1';
  document_id: string;
  tenant_id?: string;
  user_id?: string;
  deleted_at: string;
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

function deletionKey(namespace: RuntimeSyncNamespace, documentId: string): string {
  return `${namespace.tenant_id || ''}\u0000${namespace.user_id || ''}\u0000${documentId}`;
}

export class MemoryRuntimeSyncEventStore implements RuntimeSyncEventStore {
  private readonly events: StoredRuntimeEvent[] = [];
  private readonly deletedDocuments = new Map<string, RuntimeDocumentDeletion>();

  async findByEventId(namespace: RuntimeSyncNamespace, eventId: string): Promise<StoredRuntimeEvent | null> {
    return this.events.find((item) => sameNamespace(item, namespace) && item.event.event_id === eventId) ?? null;
  }

  async append(input: Omit<StoredRuntimeEvent, 'sequence'>): Promise<StoredRuntimeEvent> {
    if (await this.isDocumentDeleted({ tenant_id: input.tenant_id, user_id: input.user_id }, input.event.doc_id)) {
      throw Object.assign(new Error('runtime_document_deleted'), { code: 'runtime_document_deleted' });
    }
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

  async isDocumentDeleted(namespace: RuntimeSyncNamespace, documentId: string): Promise<boolean> {
    return this.deletedDocuments.has(deletionKey(namespace, documentId));
  }

  async deleteDocument(namespace: RuntimeSyncNamespace, documentId: string): Promise<number> {
    const before = this.events.length;
    const keep = this.events.filter((item) => !sameNamespace(item, namespace) || item.event.doc_id !== documentId);
    this.events.splice(0, this.events.length, ...keep);
    const key = deletionKey(namespace, documentId);
    if (!this.deletedDocuments.has(key)) this.deletedDocuments.set(key, {
      record_type: 'runtime_document_deletion', schema_version: 'inkloop.runtime_document_deletion.v1',
      document_id: documentId, ...namespace, deleted_at: new Date().toISOString(),
    });
    return before - keep.length;
  }
}

export class JsonlRuntimeSyncEventStore implements RuntimeSyncEventStore {
  private readonly events: StoredRuntimeEvent[] = [];
  private readonly deletedDocuments = new Map<string, RuntimeDocumentDeletion>();
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
        const item = JSON.parse(trimmed) as StoredRuntimeEvent | RuntimeDocumentDeletion;
        if ('record_type' in item && item.record_type === 'runtime_document_deletion' && item.document_id) {
          this.deletedDocuments.set(deletionKey(item, item.document_id), item);
          continue;
        }
        if ('sequence' in item && typeof item.sequence === 'number' && item.event?.event_id) this.events.push(item);
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
    let output: StoredRuntimeEvent | null = null;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      if (this.deletedDocuments.has(deletionKey(input, input.event.doc_id))) {
        throw Object.assign(new Error('runtime_document_deleted'), { code: 'runtime_document_deleted' });
      }
      const existing = this.events.find((item) => storedEventKey(item) === storedEventKey(input));
      if (existing) { output = existing; return; }
      const record: StoredRuntimeEvent = { ...input, sequence: nextSequence(this.events) };
      await appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8');
      this.events.push(record);
      output = record;
    });
    await this.writeQueue;
    if (!output) throw new Error('runtime_event_append_failed');
    return output;
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

  async isDocumentDeleted(namespace: RuntimeSyncNamespace, documentId: string): Promise<boolean> {
    await this.ready;
    await this.writeQueue.catch(() => undefined);
    return this.deletedDocuments.has(deletionKey(namespace, documentId));
  }

  async deleteDocument(namespace: RuntimeSyncNamespace, documentId: string): Promise<number> {
    await this.ready;
    let removed = 0;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const keep = this.events.filter((item) => {
        const shouldDelete = sameNamespace(item, namespace) && item.event.doc_id === documentId;
        if (shouldDelete) removed += 1;
        return !shouldDelete;
      });
      const key = deletionKey(namespace, documentId);
      const deletedDocuments = new Map(this.deletedDocuments);
      if (!deletedDocuments.has(key)) deletedDocuments.set(key, {
        record_type: 'runtime_document_deletion', schema_version: 'inkloop.runtime_document_deletion.v1',
        document_id: documentId, ...namespace, deleted_at: new Date().toISOString(),
      });
      const lines = [
        ...keep.map((item) => JSON.stringify(item)),
        ...[...deletedDocuments.values()].map((item) => JSON.stringify(item)),
      ];
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      this.events.splice(0, this.events.length, ...keep);
      this.deletedDocuments.clear();
      for (const [documentKey, deletion] of deletedDocuments) {
        this.deletedDocuments.set(documentKey, deletion);
      }
    });
    await this.writeQueue;
    return removed;
  }
}
