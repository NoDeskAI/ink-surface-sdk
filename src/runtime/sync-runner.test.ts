import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidecarRuntimeStore } from './sidecar-store';
import { HttpRuntimeSyncTransport, RuntimeSyncRunner, type RuntimeSyncTransportPort } from './sync-runner';
import type { RuntimeSyncEvent } from './types';

const tempRoots: string[] = [];

function event(input: Partial<RuntimeSyncEvent> & { event_id: string; dedupe_key?: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'test',
    doc_id: input.doc_id ?? 'doc_sync_runner',
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: 'ko_runner' },
    payload: input.payload ?? {},
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-06-27T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-27T00:00:00.000Z',
    attempt_count: input.attempt_count,
    next_retry_at: input.next_retry_at,
  };
}

async function makeStore(): Promise<SidecarRuntimeStore> {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'inkloop-runner-'));
  tempRoots.push(vaultRoot);
  return new SidecarRuntimeStore({ vaultRoot });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RuntimeSyncRunner', () => {
  it('sends one representative per dedupe key and marks duplicates as sent', async () => {
    const store = await makeStore();
    await store.writeOutboxEvents([
      event({ event_id: 'evt_1', dedupe_key: 'same-change' }),
      event({ event_id: 'evt_2', dedupe_key: 'same-change' }),
      event({ event_id: 'evt_3', dedupe_key: 'other-change', target: { type: 'block', id: 'blk_1' }, operation: 'block.update' }),
    ]);
    const sentBatches: RuntimeSyncEvent[][] = [];
    const transport: RuntimeSyncTransportPort = {
      async send(events) {
        sentBatches.push(events);
        return events.map((item) => ({ event_id: item.event_id, ok: true, ack_id: `ack_${item.event_id}` }));
      },
    };

    const runner = new RuntimeSyncRunner(store, transport, { now: () => '2026-06-27T00:01:00.000Z' });
    const result = await runner.runOnce();

    expect(result).toMatchObject({ scanned: 3, eligible: 3, sent: 3, failed: 0, deduped: 1 });
    expect(sentBatches.flat().map((item) => item.event_id)).toEqual(['evt_1', 'evt_3']);
    const outbox = await store.listOutboxEvents();
    expect(outbox.map((item) => item.status)).toEqual(['sent', 'sent', 'sent']);
    expect(outbox[1].deduped_by_event_id).toBe('evt_1');
  });

  it('records failed attempts and retries eligible failures later', async () => {
    const store = await makeStore();
    await store.writeOutboxEvents([event({ event_id: 'evt_retry' })]);
    let shouldFail = true;
    const transport: RuntimeSyncTransportPort = {
      async send(events) {
        return events.map((item) => (
          shouldFail
            ? { event_id: item.event_id, ok: false, error: 'cloud unavailable' }
            : { event_id: item.event_id, ok: true, ack_id: 'ack_retry' }
        ));
      },
    };
    const runner = new RuntimeSyncRunner(store, transport, {
      retryDelayMs: 0,
      now: () => '2026-06-27T00:02:00.000Z',
    });

    expect(await runner.runOnce()).toMatchObject({ sent: 0, failed: 1 });
    let outbox = await store.listOutboxEvents();
    expect(outbox[0]).toMatchObject({ status: 'failed', attempt_count: 1, last_error: 'cloud unavailable' });

    shouldFail = false;
    expect(await runner.runOnce()).toMatchObject({ sent: 1, failed: 0 });
    outbox = await store.listOutboxEvents();
    expect(outbox[0]).toMatchObject({ status: 'sent', attempt_count: 2, ack_id: 'ack_retry' });
  });

  it('preserves events appended while a sync batch is in flight', async () => {
    const store = await makeStore();
    await store.writeOutboxEvents([event({ event_id: 'evt_existing' })]);
    const transport: RuntimeSyncTransportPort = {
      async send(events) {
        await store.appendSyncEvent(event({ event_id: 'evt_appended_during_send', dedupe_key: 'new-change' }));
        return events.map((item) => ({ event_id: item.event_id, ok: true, ack_id: `ack_${item.event_id}` }));
      },
    };

    const runner = new RuntimeSyncRunner(store, transport, { now: () => '2026-06-27T00:03:00.000Z' });
    await runner.runOnce();

    const outbox = await store.listOutboxEvents();
    expect(outbox.map((item) => item.event_id)).toEqual(['evt_existing', 'evt_appended_during_send']);
    expect(outbox.map((item) => item.status)).toEqual(['sent', 'pending']);
  });

  it('rejects HTTP sync responses without explicit acks', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ batch_id: 'batch_without_acks' }), { status: 200 }));
    const transport = new HttpRuntimeSyncTransport({ endpoint: 'https://example.test/runtime-sync' });

    await expect(transport.send([event({ event_id: 'evt_http' })])).rejects.toThrow(/acks array/);
  });

  it('aborts hung HTTP sync requests so the runner can retry later', async () => {
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by test timeout')));
    }));
    const transport = new HttpRuntimeSyncTransport({ endpoint: 'https://example.test/runtime-sync', requestTimeoutMs: 1 });

    await expect(transport.send([event({ event_id: 'evt_hung' })])).rejects.toThrow(/aborted/);
  });
});
