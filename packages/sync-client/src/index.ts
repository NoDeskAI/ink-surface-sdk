import { validateRuntimeSyncEvent, type RuntimeOutboxPort, type RuntimeSyncEvent } from '../../runtime-schema/src/index.js';

export interface RuntimeSyncAck {
  event_id: string;
  ok: boolean;
  ack_id?: string;
  error?: string;
}

export interface RuntimeSyncTransportPort {
  send(events: RuntimeSyncEvent[]): Promise<RuntimeSyncAck[]>;
  pull?(request: RuntimeSyncPullRequest): Promise<RuntimeSyncPullResponse>;
}

export interface RuntimeSyncRunnerOptions {
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  deviceId?: string;
  cursorKey?: string;
  pullLimit?: number;
  inbox?: RuntimeInboxPort;
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

export interface RuntimeDeviceCursor {
  device_id: string;
  cursor: string;
  updated_at: string;
}

export interface RuntimeSyncPullRequest {
  device_id: string;
  cursor?: string;
  limit?: number;
}

export interface RuntimeSyncPullResponse {
  schema_version: 'inkloop.runtime_sync_pull.v1';
  events: RuntimeSyncEvent[];
  next_cursor: string;
  has_more?: boolean;
}

export interface RuntimeInboxApplyResult {
  applied: number;
  skipped: number;
  conflicted: number;
  applied_event_ids: string[];
  skipped_event_ids: string[];
  conflict_event_ids: string[];
  applied_doc_ids?: string[];
  skipped_doc_ids?: string[];
  conflict_doc_ids?: string[];
}

export interface RuntimeInboxPort {
  getDeviceCursor(deviceId: string): Promise<RuntimeDeviceCursor | null>;
  writeDeviceCursor(cursor: RuntimeDeviceCursor): Promise<void>;
  applyRemoteEvents(events: RuntimeSyncEvent[]): Promise<RuntimeInboxApplyResult>;
}

export interface RuntimeSyncPullRunResult {
  device_id: string;
  previous_cursor?: string;
  next_cursor: string;
  received: number;
  applied: number;
  skipped: number;
  conflicted: number;
  applied_event_ids: string[];
  skipped_event_ids: string[];
  conflict_event_ids: string[];
  applied_doc_ids?: string[];
  skipped_doc_ids?: string[];
  conflict_doc_ids?: string[];
}

export class RuntimeSyncPullConflictError extends Error {
  constructor(
    message: string,
    readonly response: RuntimeSyncPullResponse,
    readonly applyResult: RuntimeInboxApplyResult,
  ) {
    super(message);
    this.name = 'RuntimeSyncPullConflictError';
  }
}

export interface RuntimeSyncRunOnceResult {
  push: RuntimeSyncRunResult;
  pull?: RuntimeSyncPullRunResult;
}

export interface HttpRuntimeSyncTransportConfig {
  endpoint: string;
  deviceId: string;
  pullEndpoint?: string;
  headers?: Record<string, string> | (() => Record<string, string>);
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

export function isRuntimeDeadLetter(event: RuntimeSyncEvent, maxAttempts: number): boolean {
  return event.status !== 'sent' && (event.attempt_count ?? 0) >= Math.max(1, maxAttempts);
}

export function rearmDeadLettersOnce(
  events: RuntimeSyncEvent[],
  maxAttempts: number,
  now: string,
): RuntimeSyncEvent[] {
  const attemptCount = Math.max(1, maxAttempts) - 1;
  return events.map((event) => {
    if (!isRuntimeDeadLetter(event, maxAttempts)) return event;
    const rearmed: RuntimeSyncEvent = {
      ...event,
      status: 'pending',
      attempt_count: attemptCount,
      updated_at: now,
    };
    delete rearmed.last_error;
    delete rearmed.next_retry_at;
    return rearmed;
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertRuntimeSyncPullResponse(value: unknown): asserts value is RuntimeSyncPullResponse {
  if (!isRecord(value)) throw new Error('Runtime sync pull response must be an object.');
  if (value.schema_version !== 'inkloop.runtime_sync_pull.v1') {
    throw new Error('Runtime sync pull response has an unsupported schema_version.');
  }
  if (!Array.isArray(value.events)) throw new Error('Runtime sync pull response must include an events array.');
  if (typeof value.next_cursor !== 'string') throw new Error('Runtime sync pull response must include next_cursor.');

  const invalid = value.events
    .map((event, index) => ({ index, issues: validateRuntimeSyncEvent(event) }))
    .find((item) => item.issues.length > 0);
  if (invalid) {
    throw new Error(`Runtime sync pull response contains malformed event at ${invalid.index}: ${invalid.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
}

function appendQuery(endpoint: string, params: Record<string, string | number | undefined>): string {
  const [withoutHash, hash] = endpoint.split('#', 2);
  const [base, query] = withoutHash.split('?', 2);
  const search = new URLSearchParams(query ?? '');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const nextQuery = search.toString();
  return `${base}${nextQuery ? `?${nextQuery}` : ''}${hash ? `#${hash}` : ''}`;
}

export class RuntimeSyncRunner {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly deviceId?: string;
  private readonly cursorKey?: string;
  private readonly pullLimit?: number;
  private readonly inbox?: RuntimeInboxPort;
  private readonly now: () => string;

  constructor(
    private readonly outbox: RuntimeOutboxPort,
    private readonly transport: RuntimeSyncTransportPort,
    options: RuntimeSyncRunnerOptions = {},
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 25);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
    this.deviceId = options.deviceId;
    this.cursorKey = options.cursorKey ?? options.deviceId;
    this.pullLimit = options.pullLimit;
    this.inbox = options.inbox;
    this.now = options.now ?? nowIso;
  }

  async syncOnce(): Promise<RuntimeSyncRunOnceResult> {
    const push = await this.runOnce();
    if (!this.inbox || !this.deviceId || !this.transport.pull) return { push };
    return { push, pull: await this.pullOnce() };
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

    if (!eligibleIndexes.length) {
      return {
        scanned: events.length,
        eligible: 0,
        sent: 0,
        failed: 0,
        deduped: 0,
        skipped: events.length,
        attempted_event_ids: [],
      };
    }

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

    const updatedEvents = groups.flatMap((group) => group.map((item) => nextEvents[item.index]));
    const incrementalOutbox = this.outbox as RuntimeOutboxPort & {
      updateOutboxEvents?: (updates: RuntimeSyncEvent[]) => Promise<void>;
    };
    if (incrementalOutbox.updateOutboxEvents) {
      await incrementalOutbox.updateOutboxEvents(updatedEvents);
    } else {
      const latestEvents = await this.outbox.listOutboxEvents();
      await this.outbox.writeOutboxEvents(this.mergeUpdatedEvents(latestEvents, updatedEvents));
    }
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

  async pullOnce(): Promise<RuntimeSyncPullRunResult> {
    if (!this.inbox) throw new Error('Runtime sync inbox is not configured.');
    if (!this.deviceId) throw new Error('Runtime sync deviceId is not configured.');
    if (!this.transport.pull) throw new Error('Runtime sync transport does not support pull.');

    const cursorKey = this.cursorKey ?? this.deviceId;
    const cursor = await this.inbox.getDeviceCursor(cursorKey);
    const response = await this.transport.pull({
      device_id: this.deviceId,
      cursor: cursor?.cursor,
      limit: this.pullLimit,
    });
    assertRuntimeSyncPullResponse(response);

    const applyResult = await this.inbox.applyRemoteEvents(response.events);
    if (applyResult.conflicted > 0) {
      throw new RuntimeSyncPullConflictError(
        `Runtime sync pull produced ${applyResult.conflicted} conflicted event(s); cursor was not advanced.`,
        response,
        applyResult,
      );
    }
    await this.inbox.writeDeviceCursor({
      device_id: cursorKey,
      cursor: response.next_cursor,
      updated_at: this.now(),
    });

    return {
      device_id: this.deviceId,
      previous_cursor: cursor?.cursor,
      next_cursor: response.next_cursor,
      received: response.events.length,
      applied: applyResult.applied,
      skipped: applyResult.skipped,
      conflicted: applyResult.conflicted,
      applied_event_ids: applyResult.applied_event_ids,
      skipped_event_ids: applyResult.skipped_event_ids,
      conflict_event_ids: applyResult.conflict_event_ids,
      applied_doc_ids: applyResult.applied_doc_ids,
      skipped_doc_ids: applyResult.skipped_doc_ids,
      conflict_doc_ids: applyResult.conflict_doc_ids,
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

  private headers(): Record<string, string> {
    return typeof this.config.headers === 'function' ? this.config.headers() : (this.config.headers ?? {});
  }

  async send(events: RuntimeSyncEvent[]): Promise<RuntimeSyncAck[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, this.config.requestTimeoutMs ?? 15_000));
    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers(),
        },
        body: JSON.stringify({
          schema_version: 'inkloop.runtime_sync_batch.v1',
          device_id: this.config.deviceId,
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

  async pull(request: RuntimeSyncPullRequest): Promise<RuntimeSyncPullResponse> {
    if (!this.config.pullEndpoint) throw new Error('Runtime sync pull endpoint is not configured.');

    const endpoint = appendQuery(this.config.pullEndpoint, {
      device_id: request.device_id,
      cursor: request.cursor,
      limit: request.limit,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, this.config.requestTimeoutMs ?? 15_000));
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`Runtime sync pull failed: HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    assertRuntimeSyncPullResponse(payload);
    return payload;
  }
}

export { LocalEventLogTransport } from './local-event-log-transport.js';
export type { LocalEventLogTransportConfig, LocalEventLogTransportStatus } from './local-event-log-transport.js';
