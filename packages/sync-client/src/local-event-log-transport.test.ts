import { describe, expect, it } from 'vitest';
import type { RuntimeSyncEvent } from '../../runtime-schema/src/index';
import { LocalEventLogTransport, type LocalEventLogTransportStatus } from './local-event-log-transport';

function event(input: Partial<RuntimeSyncEvent> & { event_id: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'test',
    doc_id: input.doc_id ?? 'doc_local_log',
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: 'ko_local_log', block_id: 'blk_local_log' },
    payload: input.payload ?? { annotation: { ko_id: 'ko_local_log', body_md: 'private body', visual_strokes: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] } },
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-06-28T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-28T00:00:00.000Z',
    origin: input.origin,
  };
}

describe('LocalEventLogTransport', () => {
  it('stores push events idempotently and pulls by device cursor', async () => {
    const transport = new LocalEventLogTransport({ now: () => '2026-06-28T00:00:00.000Z' });
    const first = event({ event_id: 'evt_1' });
    const second = event({ event_id: 'evt_2' });

    expect(await transport.send([first, first, second])).toEqual([
      { event_id: 'evt_1', ok: true, ack_id: 'local_ack_1' },
      { event_id: 'evt_1', ok: true, ack_id: 'local_ack_1' },
      { event_id: 'evt_2', ok: true, ack_id: 'local_ack_2' },
    ]);

    const firstPull = await transport.pull({ device_id: 'device_a', cursor: '0', limit: 1 });
    expect(firstPull.events.map((item) => item.event_id)).toEqual(['evt_1']);
    expect(firstPull.next_cursor).toBe('1');
    expect(firstPull.has_more).toBe(true);

    const secondPull = await transport.pull({ device_id: 'device_a', cursor: firstPull.next_cursor });
    expect(secondPull.events.map((item) => item.event_id)).toEqual(['evt_2']);
    expect(secondPull.next_cursor).toBe('2');
  });

  it('rejects unauthorized local/dev access before reading or writing events', async () => {
    const transport = new LocalEventLogTransport({
      expectedToken: 'secret',
      token: 'wrong',
      requestOrigin: 'http://192.168.1.20:8765',
    });

    await expect(transport.send([event({ event_id: 'evt_private' })])).rejects.toThrow(/unauthorized token/);
    await expect(transport.pull({ device_id: 'device_a' })).rejects.toThrow(/unauthorized token/);
    expect(transport.snapshot()).toEqual([]);
  });

  it('does not log full document, stroke, or AI note payloads by default', async () => {
    const logs: LocalEventLogTransportStatus[] = [];
    const transport = new LocalEventLogTransport({ logger: (status) => logs.push(status) });

    await transport.send([event({ event_id: 'evt_private_payload' })]);

    expect(JSON.stringify(logs)).toContain('evt_private_payload');
    expect(JSON.stringify(logs)).not.toContain('private body');
    expect(JSON.stringify(logs)).not.toContain('visual_strokes');
    expect(JSON.stringify(logs)).not.toContain('"x":0');
  });
});
