import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbOfflineRuntimeStore } from 'ink-surface-sdk/offline-store';
import { LocalEventLogTransport, RuntimeSyncPullConflictError, RuntimeSyncRunner } from 'ink-surface-sdk/sync-client';
import type { RuntimeDocumentSnapshot, RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { RuntimeStoreInbox } from './runtime-inbox';

function snapshot(docId: string): RuntimeDocumentSnapshot {
  return {
    doc_id: docId,
    doc_dir: `indexeddb://${docId}`,
    document: { doc_id: docId, title: 'Inbox Doc', source_type: 'markdown' },
    source: { doc_id: docId, kind: 'native_markdown' },
    blocks: [{
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_inbox',
      doc_id: docId,
      text: 'Inbox text',
      projection: { block_id: 'blk_inbox', kind: 'paragraph', region: 'editable', knowledge_object_ids: [] },
      annotations: [],
    }],
    nodes: [],
  };
}

function event(input: Partial<RuntimeSyncEvent> & { event_id: string; doc_id: string; deviceId: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'inkloop_device',
    doc_id: input.doc_id,
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: 'ko_inbox', block_id: 'blk_inbox' },
    payload: input.payload ?? {
      block_id: 'blk_inbox',
      annotation: { ko_id: 'ko_inbox', title: 'Inbox mark', render_mode: 'stroke_only', visual_strokes: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] },
    },
    origin: { device_id: input.deviceId },
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-06-28T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-28T00:00:00.000Z',
  };
}

describe('RuntimeStoreInbox', () => {
  it('syncs one event from Web store to Obsidian-shaped store and skips redelivery', async () => {
    const web = new IndexedDbOfflineRuntimeStore({ dbName: `web-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const obsidian = new IndexedDbOfflineRuntimeStore({ dbName: `obs-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport();
    await web.writeDocumentSnapshot(snapshot('doc_inbox'));
    await obsidian.writeDocumentSnapshot(snapshot('doc_inbox'));
    await web.appendSyncEvent(event({ event_id: 'evt_web_to_obs', doc_id: 'doc_inbox', deviceId: 'web_device' }));

    await new RuntimeSyncRunner(web, transport, { deviceId: 'web_device' }).runOnce();
    const runner = new RuntimeSyncRunner(obsidian, transport, {
      deviceId: 'obsidian_device',
      inbox: new RuntimeStoreInbox(obsidian, { deviceId: 'obsidian_device' }),
      now: () => '2026-06-28T00:01:00.000Z',
    });
    const first = await runner.pullOnce();
    const second = await runner.pullOnce();

    expect(first).toMatchObject({ received: 1, applied: 1, skipped: 0, next_cursor: '1', applied_doc_ids: ['doc_inbox'] });
    expect(second).toMatchObject({ received: 0, applied: 0, next_cursor: '1' });
    expect((await obsidian.loadDocument('doc_inbox'))?.blocks[0].annotations?.[0].ko_id).toBe('ko_inbox');
    await web.close();
    await obsidian.close();
  });

  it('preserves InkLoop mark metadata on pulled annotation events', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `mark-meta-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport();
    await store.writeDocumentSnapshot(snapshot('doc_mark_meta'));
    await transport.send([event({
      event_id: 'evt_mark_meta',
      doc_id: 'doc_mark_meta',
      deviceId: 'paper_device',
      payload: {
        block_id: 'blk_inbox',
        mark_id: 'mark_remote_pen',
        marked_text: 'Remote marked text',
        feature_type: 'handwriting',
        tool: 'pen',
        page_id: 'pg_doc_mark_meta_2',
        page_index: 2,
        bbox: [0.1, 0.2, 0.3, 0.4],
        annotation: {
          ko_id: 'ko_remote_pen',
          title: 'Remote marked text',
          render_mode: 'stroke_only',
          visual_strokes: [{ tool: 'pen', points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.4 }] }],
        },
      },
    })]);

    await new RuntimeSyncRunner(store, transport, {
      deviceId: 'web_device',
      inbox: new RuntimeStoreInbox(store, { deviceId: 'web_device' }),
      now: () => '2026-06-28T00:04:00.000Z',
    }).pullOnce();

    const annotation = (await store.loadDocument('doc_mark_meta'))?.blocks[0].annotations?.[0] as { inkloop_mark?: Record<string, unknown> } | undefined;
    expect(annotation?.inkloop_mark).toMatchObject({
      mark_id: 'mark_remote_pen',
      marked_text: 'Remote marked text',
      feature_type: 'handwriting',
      tool: 'pen',
      page_id: 'pg_doc_mark_meta_2',
      page_index: 2,
      bbox: [0.1, 0.2, 0.3, 0.4],
      source_device_id: 'paper_device',
    });
    await store.close();
  });

  it('skips echo events from the same device and still advances the cursor', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `echo-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport();
    await store.writeDocumentSnapshot(snapshot('doc_echo'));
    await transport.send([event({ event_id: 'evt_echo', doc_id: 'doc_echo', deviceId: 'same_device' })]);

    const result = await new RuntimeSyncRunner(store, transport, {
      deviceId: 'same_device',
      inbox: new RuntimeStoreInbox(store, { deviceId: 'same_device' }),
      now: () => '2026-06-28T00:02:00.000Z',
    }).pullOnce();

    expect(result).toMatchObject({ received: 1, applied: 0, skipped: 1, next_cursor: '1', skipped_doc_ids: ['doc_echo'] });
    expect(await store.listAppliedEventIds('doc_echo')).toEqual([]);
    await store.close();
  });

  it('leaves cursor unchanged when remote apply conflicts', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `conflict-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport();
    await store.writeDocumentSnapshot(snapshot('doc_conflict'));
    await store.writeDeviceCursor({ device_id: 'obsidian_device', cursor: '0', updated_at: '2026-06-28T00:00:00.000Z' });
    await transport.send([event({
      event_id: 'evt_conflict',
      doc_id: 'doc_conflict',
      deviceId: 'web_device',
      operation: 'annotation.update',
      target: { type: 'annotation', id: 'ko_missing' },
      payload: { ko_id: 'ko_missing', patch: { title: 'Missing' } },
    })]);

    await expect(new RuntimeSyncRunner(store, transport, {
      deviceId: 'obsidian_device',
      inbox: new RuntimeStoreInbox(store, { deviceId: 'obsidian_device' }),
    }).pullOnce()).rejects.toBeInstanceOf(RuntimeSyncPullConflictError);

    expect(await store.getDeviceCursor('obsidian_device')).toMatchObject({ cursor: '0' });
    expect((await store.listConflicts('doc_conflict'))[0]).toMatchObject({ event_id: 'evt_conflict' });
    await store.close();
  });

  it('can skip recoverable historical conflicts and advance the cursor', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `recoverable-conflict-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport();
    await store.writeDocumentSnapshot(snapshot('doc_conflict'));
    await store.writeDeviceCursor({ device_id: 'obsidian_device', cursor: '0', updated_at: '2026-06-28T00:00:00.000Z' });
    await transport.send([event({
      event_id: 'evt_recoverable_conflict',
      doc_id: 'doc_conflict',
      deviceId: 'web_device',
      operation: 'annotation.update',
      target: { type: 'annotation', id: 'ko_missing' },
      payload: { ko_id: 'ko_missing', patch: { title: 'Missing' } },
    })]);

    const result = await new RuntimeSyncRunner(store, transport, {
      deviceId: 'obsidian_device',
      inbox: new RuntimeStoreInbox(store, { deviceId: 'obsidian_device', advanceCursorOnRecoverableConflicts: true }),
      now: () => '2026-06-28T00:03:00.000Z',
    }).pullOnce();

    expect(result).toMatchObject({
      received: 1,
      applied: 0,
      skipped: 1,
      conflicted: 0,
      next_cursor: '1',
      skipped_doc_ids: ['doc_conflict'],
    });
    expect(await store.getDeviceCursor('obsidian_device')).toMatchObject({ cursor: '1' });
    expect((await store.listConflicts('doc_conflict'))[0]).toMatchObject({ event_id: 'evt_recoverable_conflict' });
    await store.close();
  });

  it('skips orphan mutation events for missing runtime documents and advances the cursor', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `orphan-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport();
    await transport.send([event({ event_id: 'evt_orphan_annotation', doc_id: 'doc_missing', deviceId: 'web_device' })]);

    const result = await new RuntimeSyncRunner(store, transport, {
      deviceId: 'obsidian_device',
      inbox: new RuntimeStoreInbox(store, { deviceId: 'obsidian_device' }),
      now: () => '2026-06-28T00:03:00.000Z',
    }).pullOnce();

    expect(result).toMatchObject({
      received: 1,
      applied: 0,
      skipped: 1,
      conflicted: 0,
      next_cursor: '1',
      skipped_doc_ids: ['doc_missing'],
    });
    expect(await store.getDeviceCursor('obsidian_device')).toMatchObject({ cursor: '1' });
    expect((await store.listConflicts('doc_missing'))[0]).toMatchObject({ event_id: 'evt_orphan_annotation' });
    await store.close();
  });
});
