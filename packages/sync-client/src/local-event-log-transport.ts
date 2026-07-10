import { assertRuntimeSyncEvent, type RuntimeSyncEvent } from '../../runtime-schema/src/index.js';
import type {
  RuntimeSyncAck,
  RuntimeSyncPullRequest,
  RuntimeSyncPullResponse,
  RuntimeSyncTransportPort,
} from './index.js';

export interface LocalEventLogTransportStatus {
  operation: 'send' | 'pull';
  event_ids: string[];
  doc_ids: string[];
  count: number;
  latency_ms: number;
  at: string;
}

export interface LocalEventLogTransportConfig {
  expectedToken?: string;
  token?: string;
  requestOrigin?: string;
  allowOrigins?: string[];
  now?: () => string;
  logger?: (status: LocalEventLogTransportStatus) => void;
}

interface StoredEvent {
  sequence: number;
  event: RuntimeSyncEvent;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isLoopbackOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export class LocalEventLogTransport implements RuntimeSyncTransportPort {
  private readonly events: StoredEvent[] = [];
  private readonly now: () => string;

  constructor(private readonly config: LocalEventLogTransportConfig = {}) {
    this.now = config.now ?? nowIso;
  }

  async send(events: RuntimeSyncEvent[]): Promise<RuntimeSyncAck[]> {
    const started = Date.now();
    this.assertAuthorized();
    const acks: RuntimeSyncAck[] = [];
    for (const event of events) {
      assertRuntimeSyncEvent(event);
      const existing = this.events.find((item) => item.event.event_id === event.event_id);
      if (existing) {
        acks.push({ event_id: event.event_id, ok: true, ack_id: `local_ack_${existing.sequence}` });
        continue;
      }
      const sequence = this.events.length + 1;
      this.events.push({ sequence, event: { ...event, status: 'sent', sent_at: event.sent_at ?? this.now() } });
      acks.push({ event_id: event.event_id, ok: true, ack_id: `local_ack_${sequence}` });
    }
    this.log('send', events, started);
    return acks;
  }

  async pull(request: RuntimeSyncPullRequest): Promise<RuntimeSyncPullResponse> {
    const started = Date.now();
    this.assertAuthorized();
    const cursor = parseCursor(request.cursor);
    const limit = Math.max(1, Math.min(500, request.limit ?? 100));
    const selected = this.events.filter((item) => item.sequence > cursor).slice(0, limit);
    const nextCursor = String(selected.at(-1)?.sequence ?? this.events.at(-1)?.sequence ?? cursor);
    const events = selected.map((item) => ({ ...item.event }));
    this.log('pull', events, started);
    return {
      schema_version: 'inkloop.runtime_sync_pull.v1',
      events,
      next_cursor: nextCursor,
      has_more: this.events.some((item) => item.sequence > Number(nextCursor)),
    };
  }

  snapshot(): RuntimeSyncEvent[] {
    return this.events.map((item) => ({ ...item.event }));
  }

  private assertAuthorized(): void {
    if (this.config.expectedToken && this.config.token !== this.config.expectedToken) {
      throw new Error('Local runtime sync transport rejected unauthorized token.');
    }
    const allowed = this.config.allowOrigins ?? [];
    if (!isLoopbackOrigin(this.config.requestOrigin) && !allowed.includes(this.config.requestOrigin ?? '')) {
      throw new Error('Local runtime sync transport rejected non-loopback origin.');
    }
  }

  private log(operation: LocalEventLogTransportStatus['operation'], events: RuntimeSyncEvent[], started: number): void {
    this.config.logger?.({
      operation,
      event_ids: events.map((event) => event.event_id),
      doc_ids: unique(events.map((event) => event.doc_id)),
      count: events.length,
      latency_ms: Date.now() - started,
      at: this.now(),
    });
  }
}
