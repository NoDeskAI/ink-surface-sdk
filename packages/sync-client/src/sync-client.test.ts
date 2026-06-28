import { describe, expect, it, vi } from 'vitest';
import type { RuntimeOutboxPort, RuntimeSyncEvent } from '../../runtime-schema/src/index';
import {
  HttpRuntimeSyncTransport,
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

  it('does not mark events sent when the transport response is malformed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ batch_id: 'missing_acks' }), { status: 200 }));
    const transport = new HttpRuntimeSyncTransport({ endpoint: 'https://example.test/runtime-sync', deviceId: 'device_http' });

    await expect(transport.send([event({ event_id: 'evt_http' })])).rejects.toThrow(/acks array/);
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
    });
    expect(inbox.events.map((item) => item.event_id)).toEqual(['evt_remote']);
    expect(inbox.cursors.get('device_a')).toEqual({
      device_id: 'device_a',
      cursor: 'cursor_2',
      updated_at: '2026-06-28T00:02:00.000Z',
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
