import type { RuntimeOutboxPort, RuntimeSyncEvent } from './types';

export interface RuntimeSyncAck {
  event_id: string;
  ok: boolean;
  ack_id?: string;
  error?: string;
}

export interface RuntimeSyncTransportPort {
  send(events: RuntimeSyncEvent[]): Promise<RuntimeSyncAck[]>;
}

export interface RuntimeSyncRunnerOptions {
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  now?: () => string;
}

export interface RuntimeSyncRunResult {
  scanned: number;
  eligible: number;
  sent: number;
  failed: number;
  deduped: number;
  skipped: number;
  attempted_event_ids: string[];
}

export interface HttpRuntimeSyncTransportConfig {
  endpoint: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseTime(input?: string): number {
  if (!input) return 0;
  const time = Date.parse(input);
  return Number.isFinite(time) ? time : 0;
}

function shouldAttempt(event: RuntimeSyncEvent, now: string, maxAttempts: number): boolean {
  if (event.status === 'sent') return false;
  if ((event.attempt_count ?? 0) >= maxAttempts) return false;
  if (event.status === 'failed' && event.next_retry_at && parseTime(event.next_retry_at) > parseTime(now)) return false;
  return event.status === 'pending' || event.status === 'failed';
}

function retryAt(now: string, retryDelayMs: number): string {
  return new Date(parseTime(now) + retryDelayMs).toISOString();
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function isRuntimeSyncAck(value: unknown): value is RuntimeSyncAck {
  if (!value || typeof value !== 'object') return false;
  const ack = value as RuntimeSyncAck;
  return typeof ack.event_id === 'string' && typeof ack.ok === 'boolean';
}

export class RuntimeSyncRunner {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly now: () => string;

  constructor(
    private readonly outbox: RuntimeOutboxPort,
    private readonly transport: RuntimeSyncTransportPort,
    options: RuntimeSyncRunnerOptions = {},
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 25);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
    this.now = options.now ?? nowIso;
  }

  async runOnce(): Promise<RuntimeSyncRunResult> {
    const now = this.now();
    const events = await this.outbox.listOutboxEvents();
    const nextEvents = events.map((event) => ({ ...event }));
    const eligibleIndexes = nextEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => shouldAttempt(event, now, this.maxAttempts));
    const groups = this.groupByDedupeKey(eligibleIndexes);
    const representatives = groups.map((group) => group[0]);
    const attemptedEventIds: string[] = [];
    let sent = 0;
    let failed = 0;
    let deduped = 0;

    for (const batch of chunk(representatives, this.batchSize)) {
      const batchEvents = batch.map(({ event }) => event);
      attemptedEventIds.push(...batchEvents.map((event) => event.event_id));
      let acks: RuntimeSyncAck[];
      try {
        acks = await this.transport.send(batchEvents);
      } catch (error) {
        acks = batchEvents.map((event) => ({
          event_id: event.event_id,
          ok: false,
          error: String((error as Error)?.message || error),
        }));
      }

      const ackById = new Map(acks.map((ack) => [ack.event_id, ack]));
      for (const item of batch) {
        const group = groups.find((candidate) => candidate[0].event.event_id === item.event.event_id) ?? [item];
        const ack = ackById.get(item.event.event_id) ?? { event_id: item.event.event_id, ok: false, error: 'missing transport ack' };
        if (ack.ok) {
          sent += group.length;
          deduped += Math.max(0, group.length - 1);
          this.markGroupSent(nextEvents, group, ack, now);
        } else {
          failed += group.length;
          this.markGroupFailed(nextEvents, group, ack.error || 'transport failed', now);
        }
      }
    }

    const latestEvents = await this.outbox.listOutboxEvents();
    await this.outbox.writeOutboxEvents(this.mergeUpdatedEvents(latestEvents, nextEvents));
    return {
      scanned: events.length,
      eligible: eligibleIndexes.length,
      sent,
      failed,
      deduped,
      skipped: events.length - eligibleIndexes.length,
      attempted_event_ids: attemptedEventIds,
    };
  }

  private groupByDedupeKey(items: Array<{ event: RuntimeSyncEvent; index: number }>): Array<Array<{ event: RuntimeSyncEvent; index: number }>> {
    const groups = new Map<string, Array<{ event: RuntimeSyncEvent; index: number }>>();
    for (const item of items) {
      const key = item.event.dedupe_key || item.event.event_id;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  private markGroupSent(events: RuntimeSyncEvent[], group: Array<{ event: RuntimeSyncEvent; index: number }>, ack: RuntimeSyncAck, now: string): void {
    const representativeId = group[0].event.event_id;
    for (const item of group) {
      events[item.index] = {
        ...events[item.index],
        status: 'sent',
        attempt_count: (events[item.index].attempt_count ?? 0) + 1,
        sent_at: now,
        updated_at: now,
        ack_id: ack.ack_id,
        last_error: undefined,
        next_retry_at: undefined,
        deduped_by_event_id: item.event.event_id === representativeId ? undefined : representativeId,
      };
    }
  }

  private markGroupFailed(events: RuntimeSyncEvent[], group: Array<{ event: RuntimeSyncEvent; index: number }>, error: string, now: string): void {
    for (const item of group) {
      events[item.index] = {
        ...events[item.index],
        status: 'failed',
        attempt_count: (events[item.index].attempt_count ?? 0) + 1,
        last_error: error,
        next_retry_at: retryAt(now, this.retryDelayMs),
        updated_at: now,
      };
    }
  }

  private mergeUpdatedEvents(latestEvents: RuntimeSyncEvent[], updatedEvents: RuntimeSyncEvent[]): RuntimeSyncEvent[] {
    const updatedById = new Map(updatedEvents.map((event) => [event.event_id, event]));
    const seen = new Set<string>();
    const merged = latestEvents.map((event) => {
      seen.add(event.event_id);
      return updatedById.get(event.event_id) ?? event;
    });
    for (const event of updatedEvents) {
      if (!seen.has(event.event_id)) merged.push(event);
    }
    return merged;
  }
}

export class HttpRuntimeSyncTransport implements RuntimeSyncTransportPort {
  constructor(private readonly config: HttpRuntimeSyncTransportConfig) {}

  async send(events: RuntimeSyncEvent[]): Promise<RuntimeSyncAck[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, this.config.requestTimeoutMs ?? 15_000));
    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({
          schema_version: 'inkloop.runtime_sync_batch.v1',
          events,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`Runtime sync failed: HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({})) as { acks?: unknown };
    if (!Array.isArray(payload.acks)) throw new Error('Runtime sync response must include an acks array.');
    if (!payload.acks.every(isRuntimeSyncAck)) throw new Error('Runtime sync response contains malformed acks.');
    return payload.acks;
  }
}
