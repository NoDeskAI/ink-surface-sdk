import { describe, expect, it, vi } from 'vitest';
import type { RuntimeOutboxPort, RuntimeSyncEvent } from '../../runtime-schema/src/index';
import {
  HttpRuntimeSyncTransport,
  isRuntimeDeadLetter,
  rearmDeadLettersOnce,
  RuntimeSyncRunner,
  type RuntimeDeviceCursor,
  type RuntimeInboxApplyResult,
  type RuntimeInboxPort,
  type RuntimeSyncTransportPort,
} from './index';

class MemoryOutbox implements RuntimeOutboxPort {
  constructor(private events: RuntimeSyncEvent[] = []) {}

  async listOutboxEvents(): Promise<RuntimeSyncEvent[]> {
    return this.events.map((event) => ({ ...event }));
  }

  async writeOutboxEvents(events: RuntimeSyncEvent[]): Promise<void> {
    this.events = events.map((event) => ({ ...event }));
  }

  async updateOutboxEvents(updates: RuntimeSyncEvent[]): Promise<void> {
    const updatesById = new Map(updates.map((event) => [event.event_id, event]));
    this.events = this.events.map((event) => ({ ...(updatesById.get(event.event_id) ?? event) }));
  }

  async appendSyncEvent(event: RuntimeSyncEvent): Promise<void> {
    this.events.push({ ...event });
  }
}

class MemoryInbox implements RuntimeInboxPort {
  public events: RuntimeSyncEvent[] = [];
  public cursors = new Map<string, RuntimeDeviceCursor>();

  async getDeviceCursor(deviceId: string): Promise<RuntimeDeviceCursor | null> {
    return this.cursors.get(deviceId) ?? null;
  }

  async writeDeviceCursor(cursor: RuntimeDeviceCursor): Promise<void> {
    this.cursors.set(cursor.device_id, cursor);
  }

  async applyRemoteEvents(events: RuntimeSyncEvent[]): Promise<RuntimeInboxApplyResult> {
    const seen = new Set(this.events.map((item) => item.event_id));
    const applied = events.filter((item) => !seen.has(item.event_id));
    this.events.push(...applied.map((item) => ({ ...item })));
    return {
      applied: applied.length,
      skipped: events.length - applied.length,
      conflicted: 0,
      applied_event_ids: applied.map((item) => item.event_id),
      skipped_event_ids: events.filter((item) => seen.has(item.event_id)).map((item) => item.event_id),
      conflict_event_ids: [],
      applied_doc_ids: [...new Set(applied.map((item) => item.doc_id))],
      skipped_doc_ids: [...new Set(events.filter((item) => seen.has(item.event_id)).map((item) => item.doc_id))],
      conflict_doc_ids: [],
    };
  }
}

class ConflictInbox extends MemoryInbox {
  async applyRemoteEvents(events: RuntimeSyncEvent[]): Promise<RuntimeInboxApplyResult> {
    return {
      applied: 0,
      skipped: 0,
      conflicted: events.length,
      applied_event_ids: [],
      skipped_event_ids: [],
      conflict_event_ids: events.map((item) => item.event_id),
      applied_doc_ids: [],
      skipped_doc_ids: [],
      conflict_doc_ids: [...new Set(events.map((item) => item.doc_id))],
    };
  }
}

function event(input: Partial<RuntimeSyncEvent> & { event_id: string; dedupe_key?: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'test',
    doc_id: input.doc_id ?? 'doc_sync_client',
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: 'ko_sync_client' },
    payload: input.payload ?? {},
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-06-28T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-28T00:00:00.000Z',
    attempt_count: input.attempt_count,
    next_retry_at: input.next_retry_at,
  };
}

describe('sync client', () => {
  it('uploads one representative per dedupe key and marks duplicates as sent', async () => {
    const outbox = new MemoryOutbox([
      event({ event_id: 'evt_1', dedupe_key: 'same-change' }),
      event({ event_id: 'evt_2', dedupe_key: 'same-change' }),
      event({ event_id: 'evt_3', dedupe_key: 'other-change' }),
    ]);
    const transport: RuntimeSyncTransportPort = {
      async send(events) {
        return events.map((item) => ({ event_id: item.event_id, ok: true, ack_id: `ack_${item.event_id}` }));
      },
    };

    const result = await new RuntimeSyncRunner(outbox, transport, { now: () => '2026-06-28T00:01:00.000Z' }).runOnce();

    expect(result).toMatchObject({ scanned: 3, eligible: 3, sent: 3, failed: 0, deduped: 1 });
    const events = await outbox.listOutboxEvents();
    expect(events.map((item) => item.status)).toEqual(['sent', 'sent', 'sent']);
    expect(events[1].deduped_by_event_id).toBe('evt_1');
  });

  it('only sends the retryable pending event when terminal events share its dedupe key', async () => {
    const outbox = new MemoryOutbox([
      event({ event_id: 'evt_sent', dedupe_key: 'same-change', status: 'sent', attempt_count: 1 }),
      event({ event_id: 'evt_dead', dedupe_key: 'same-change', status: 'failed', attempt_count: 25 }),
      event({ event_id: 'evt_pending', dedupe_key: 'same-change', status: 'pending', attempt_count: 0 }),
    ]);
    const send = vi.fn(async (events: RuntimeSyncEvent[]) => events.map((item) => ({ event_id: item.event_id, ok: true })));

    const result = await new RuntimeSyncRunner(outbox, { send }, { maxAttempts: 25 }).runOnce();

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].map((item) => item.event_id)).toEqual(['evt_pending']);
    expect(result).toMatchObject({ scanned: 3, eligible: 1, sent: 1, deduped: 0, skipped: 2 });
    expect((await outbox.listOutboxEvents()).map((item) => item.status)).toEqual(['sent', 'failed', 'sent']);
  });

  it('rearms each dead letter for exactly one attempt before it becomes sent or dead again', async () => {
    const maxAttempts = 25;
    const dead = event({
      event_id: 'evt_dead_once',
      status: 'failed',
      attempt_count: maxAttempts,
      next_retry_at: '2099-01-01T00:00:00.000Z',
    });
    const rearmed = rearmDeadLettersOnce([dead], maxAttempts, '2026-07-15T00:00:00.000Z');
    expect(rearmed[0]).toMatchObject({ status: 'pending', attempt_count: 24 });
    expect(rearmed[0].next_retry_at).toBeUndefined();

    const failedOutbox = new MemoryOutbox(rearmed);
    const failedSend = vi.fn(async (events: RuntimeSyncEvent[]) => events.map((item) => ({ event_id: item.event_id, ok: false, error: 'still offline' })));
    const failedRunner = new RuntimeSyncRunner(failedOutbox, { send: failedSend }, {
      maxAttempts,
      retryDelayMs: 0,
      now: () => '2026-07-15T00:00:01.000Z',
    });

    await failedRunner.runOnce();
    await failedRunner.runOnce();
    const failedAgain = (await failedOutbox.listOutboxEvents())[0];
    expect(failedSend).toHaveBeenCalledOnce();
    expect(failedAgain).toMatchObject({ status: 'failed', attempt_count: maxAttempts, last_error: 'still offline' });
    expect(isRuntimeDeadLetter(failedAgain, maxAttempts)).toBe(true);

    const successOutbox = new MemoryOutbox(rearmDeadLettersOnce([dead], maxAttempts, '2026-07-15T00:00:02.000Z'));
    await new RuntimeSyncRunner(successOutbox, {
      async send(events) {
        return events.map((item) => ({ event_id: item.event_id, ok: true, ack_id: 'ack_manual_retry' }));
      },
    }, { maxAttempts, now: () => '2026-07-15T00:00:03.000Z' }).runOnce();
    expect((await successOutbox.listOutboxEvents())[0]).toMatchObject({
      status: 'sent',
      attempt_count: maxAttempts,
      ack_id: 'ack_manual_retry',
    });
  });

  it('does not rewrite the outbox when no event is eligible', async () => {
    const outbox = new MemoryOutbox([
      event({ event_id: 'evt_already_sent', status: 'sent' }),
      event({ event_id: 'evt_exhausted', status: 'failed', attempt_count: 25 }),
    ]);
    const write = vi.spyOn(outbox, 'writeOutboxEvents');
    const update = vi.spyOn(outbox, 'updateOutboxEvents');
    const send = vi.fn(async () => []);

    const result = await new RuntimeSyncRunner(outbox, { send }, { maxAttempts: 25 }).runOnce();

    expect(result).toMatchObject({ scanned: 2, eligible: 0, skipped: 2 });
    expect(send).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not mark events sent when the transport response is malformed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ batch_id: 'missing_acks' }), { status: 200 }));
    const transport = new HttpRuntimeSyncTransport({ endpoint: 'https://example.test/runtime-sync', deviceId: 'device_http' });

    await expect(transport.send([event({ event_id: 'evt_http' })])).rejects.toThrow(/acks array/);
  });

  it('preserves the send timeout error when headers arrive but the response body never ends', async () => {
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }) as Response);
    const transport = new HttpRuntimeSyncTransport({
      endpoint: 'https://example.test/runtime-sync',
      deviceId: 'device_send_body_timeout',
      sendTimeoutMs: 10,
    });

    await expect(transport.send([event({ event_id: 'evt_send_body_timeout' })]))
      .rejects.toThrow('runtime sync request timed out after 10ms');
  });

  it('sends the device id required by the runtime sync push contract', async () => {
    let requestBody: unknown;
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ acks: [{ event_id: 'evt_http_device', ok: true }] }), { status: 200 });
    });
    const transport = new HttpRuntimeSyncTransport({ endpoint: 'https://example.test/runtime-sync', deviceId: 'device_http' });

    await transport.send([event({ event_id: 'evt_http_device' })]);

    expect(requestBody).toMatchObject({
      schema_version: 'inkloop.runtime_sync_batch.v1',
      device_id: 'device_http',
      events: [{ event_id: 'evt_http_device' }],
    });
  });

  it('resolves HTTP headers for each runtime sync request', async () => {
    const seenAuth: string[] = [];
    let token = 'token_1';
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      seenAuth.push(String((init?.headers as Record<string, string>)?.authorization || ''));
      return new Response(JSON.stringify({ acks: [{ event_id: 'evt_dynamic_headers', ok: true }] }), { status: 200 });
    });
    const transport = new HttpRuntimeSyncTransport({
      endpoint: 'https://example.test/runtime-sync',
      deviceId: 'device_http',
      headers: () => ({ authorization: `Bearer ${token}` }),
    });

    await transport.send([event({ event_id: 'evt_dynamic_headers' })]);
    token = 'token_2';
    await transport.send([event({ event_id: 'evt_dynamic_headers' })]);

    expect(seenAuth).toEqual(['Bearer token_1', 'Bearer token_2']);
  });

  it('pulls remote events after the device cursor and stores the next cursor', async () => {
    const inbox = new MemoryInbox();
    await inbox.writeDeviceCursor({ device_id: 'device_a', cursor: 'cursor_1', updated_at: '2026-06-28T00:00:00.000Z' });
    const transport: RuntimeSyncTransportPort = {
      async send() {
        return [];
      },
      async pull(request) {
        expect(request).toEqual({ device_id: 'device_a', cursor: 'cursor_1', limit: 50 });
        return {
          schema_version: 'inkloop.runtime_sync_pull.v1',
          events: [event({ event_id: 'evt_remote', source: 'cloud', status: 'sent' })],
          next_cursor: 'cursor_2',
        };
      },
    };

    const result = await new RuntimeSyncRunner(new MemoryOutbox(), transport, {
      deviceId: 'device_a',
      inbox,
      pullLimit: 50,
      now: () => '2026-06-28T00:02:00.000Z',
    }).pullOnce();

    expect(result).toMatchObject({
      device_id: 'device_a',
      previous_cursor: 'cursor_1',
      next_cursor: 'cursor_2',
      received: 1,
      applied: 1,
      skipped: 0,
      applied_doc_ids: ['doc_sync_client'],
    });
    expect(inbox.events.map((item) => item.event_id)).toEqual(['evt_remote']);
    expect(inbox.cursors.get('device_a')).toEqual({
      device_id: 'device_a',
      cursor: 'cursor_2',
      updated_at: '2026-06-28T00:02:00.000Z',
    });
  });

  it('can store pull cursors under a namespace-aware cursor key while sending the stable device id', async () => {
    const inbox = new MemoryInbox();
    await inbox.writeDeviceCursor({ device_id: 'tenant_a/user_a/device_a', cursor: 'cursor_namespace_a', updated_at: '2026-06-28T00:00:00.000Z' });
    await inbox.writeDeviceCursor({ device_id: 'tenant_b/user_b/device_a', cursor: 'cursor_namespace_b', updated_at: '2026-06-28T00:00:00.000Z' });
    const transport: RuntimeSyncTransportPort = {
      async send() {
        return [];
      },
      async pull(request) {
        expect(request).toEqual({ device_id: 'device_a', cursor: 'cursor_namespace_b', limit: 100 });
        return {
          schema_version: 'inkloop.runtime_sync_pull.v1',
          events: [],
          next_cursor: 'cursor_namespace_b_next',
        };
      },
    };

    await new RuntimeSyncRunner(new MemoryOutbox(), transport, {
      deviceId: 'device_a',
      cursorKey: 'tenant_b/user_b/device_a',
      inbox,
      pullLimit: 100,
    }).pullOnce();

    expect(inbox.cursors.get('tenant_a/user_a/device_a')?.cursor).toBe('cursor_namespace_a');
    expect(inbox.cursors.get('tenant_b/user_b/device_a')).toMatchObject({
      device_id: 'tenant_b/user_b/device_a',
      cursor: 'cursor_namespace_b_next',
    });
  });

  it('does not advance the device cursor when pulled events conflict', async () => {
    const inbox = new ConflictInbox();
    await inbox.writeDeviceCursor({ device_id: 'device_conflict', cursor: 'cursor_before', updated_at: '2026-06-28T00:00:00.000Z' });
    const transport: RuntimeSyncTransportPort = {
      async send() {
        return [];
      },
      async pull() {
        return {
          schema_version: 'inkloop.runtime_sync_pull.v1',
          events: [event({ event_id: 'evt_remote_conflict', source: 'cloud', status: 'sent' })],
          next_cursor: 'cursor_after',
        };
      },
    };

    await expect(new RuntimeSyncRunner(new MemoryOutbox(), transport, {
      deviceId: 'device_conflict',
      inbox,
      now: () => '2026-06-28T00:02:00.000Z',
    }).pullOnce()).rejects.toThrow(/cursor was not advanced/);

    expect(inbox.cursors.get('device_conflict')).toEqual({
      device_id: 'device_conflict',
      cursor: 'cursor_before',
      updated_at: '2026-06-28T00:00:00.000Z',
    });
  });

  it('runs push then pull when an inbox and pull transport are configured', async () => {
    const outbox = new MemoryOutbox([event({ event_id: 'evt_local' })]);
    const inbox = new MemoryInbox();
    const transport: RuntimeSyncTransportPort = {
      async send(events) {
        return events.map((item) => ({ event_id: item.event_id, ok: true }));
      },
      async pull() {
        return {
          schema_version: 'inkloop.runtime_sync_pull.v1',
          events: [event({ event_id: 'evt_remote_sync_once', source: 'cloud', status: 'sent' })],
          next_cursor: 'cursor_sync_once',
        };
      },
    };

    const result = await new RuntimeSyncRunner(outbox, transport, {
      deviceId: 'device_sync_once',
      inbox,
      now: () => '2026-06-28T00:03:00.000Z',
    }).syncOnce();

    expect(result.push.sent).toBe(1);
    expect(result.pull?.applied_event_ids).toEqual(['evt_remote_sync_once']);
    expect((await outbox.listOutboxEvents())[0].status).toBe('sent');
  });

  it('rejects malformed HTTP pull responses before inbox apply', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schema_version: 'wrong', events: [] }), { status: 200 }));
    const transport = new HttpRuntimeSyncTransport({
      endpoint: 'https://example.test/runtime-sync',
      deviceId: 'device_http',
      pullEndpoint: 'https://example.test/runtime-sync/pull',
    });

    await expect(transport.pull({ device_id: 'device_http' })).rejects.toThrow(/schema_version/);
  });

  it('preserves the pull timeout error when headers arrive but the response body never ends', async () => {
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }) as Response);
    const transport = new HttpRuntimeSyncTransport({
      endpoint: 'https://example.test/runtime-sync',
      deviceId: 'device_pull_body_timeout',
      pullEndpoint: 'https://example.test/runtime-sync/pull',
      requestTimeoutMs: 10,
    });

    await expect(transport.pull({ device_id: 'device_pull_body_timeout' }))
      .rejects.toThrow('runtime sync request timed out after 10ms');
  });

  it('supports relative pull endpoints used by browser and WebView hosts', async () => {
    let requestedUrl = '';
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        schema_version: 'inkloop.runtime_sync_pull.v1',
        events: [],
        next_cursor: 'cursor_relative',
      }), { status: 200 });
    });
    const transport = new HttpRuntimeSyncTransport({
      endpoint: '/v1/runtime/events:push',
      deviceId: 'device_http',
      pullEndpoint: '/v1/runtime/events:pull?existing=1',
    });

    await transport.pull({ device_id: 'device_http', cursor: 'cursor_before', limit: 25 });

    expect(requestedUrl).toBe('/v1/runtime/events:pull?existing=1&device_id=device_http&cursor=cursor_before&limit=25');
  });
});
