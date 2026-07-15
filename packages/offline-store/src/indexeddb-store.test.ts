import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { RuntimeDocumentSnapshot, RuntimeSyncEvent } from '../../runtime-schema/src/index';
import { IndexedDbOfflineRuntimeStore, OFFLINE_STORE_SCHEMA_VERSION } from './index';

function snapshot(): RuntimeDocumentSnapshot {
  return {
    doc_id: 'doc_indexeddb',
    doc_dir: 'indexeddb://doc_indexeddb',
    document: {
      doc_id: 'doc_indexeddb',
      title: 'IndexedDB Doc',
      source_type: 'markdown',
      updated_at: '2026-06-28T00:00:00.000Z',
    },
    source: {
      doc_id: 'doc_indexeddb',
      kind: 'browser_runtime_snapshot',
    },
    blocks: [
      {
        schema_version: 'inkloop.surface_object.v1',
        object_id: 'blk_indexeddb',
        doc_id: 'doc_indexeddb',
        text: 'Original text.',
        source_anchor: {
          quote: 'Original text.',
          range: { start_line: 1, start_col: 0, end_line: 1, end_col: 14 },
        },
        projection: {
          block_id: 'blk_indexeddb',
          kind: 'paragraph',
          region: 'editable',
          knowledge_object_ids: [],
        },
        annotations: [],
      },
    ],
    nodes: [],
  };
}

function event(input: Partial<RuntimeSyncEvent> & { event_id: string; operation: RuntimeSyncEvent['operation'] }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'cloud',
    doc_id: input.doc_id ?? 'doc_indexeddb',
    operation: input.operation,
    target: input.target ?? { type: 'document', id: input.doc_id ?? 'doc_indexeddb' },
    payload: input.payload ?? {},
    status: input.status ?? 'sent',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-06-28T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-28T00:00:00.000Z',
  };
}

describe('IndexedDbOfflineRuntimeStore', () => {
  it('stores runtime snapshots, mutations, cache records, and pending sync events in IndexedDB', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-06-28T00:10:00.000Z',
    });

    await store.writeDocumentSnapshot(snapshot());
    await store.updateBlockContent({
      doc_id: 'doc_indexeddb',
      block_id: 'blk_indexeddb',
      content: 'Edited text.\nSecond line.',
      source: 'web_lab',
    });
    const annotationResult = await store.addAnnotation({
      doc_id: 'doc_indexeddb',
      block_id: 'blk_indexeddb',
      source: 'obsidian_plugin',
      title: 'Ink mark',
      render_mode: 'stroke_only',
      visual_strokes: [{ tool: 'pen', color: '#ff6680', points: [{ x: 0.1, y: 0.2, pressure: 0.5 }] }],
    });
    await store.writeCacheRecord({
      schema_version: OFFLINE_STORE_SCHEMA_VERSION,
      doc_id: 'doc_indexeddb',
      runtime_schema_version: 'inkloop.runtime.v1',
      metadata_cached: true,
      surface_cached: true,
      pending_event_count: 2,
      pinned: true,
    });

    const runtime = await store.loadDocument('doc_indexeddb');
    expect(runtime?.document.updated_at).toBe('2026-06-28T00:10:00.000Z');
    expect(runtime?.blocks[0].text).toBe('Edited text. Second line.');
    expect(runtime?.blocks[0].annotations?.[0]).toMatchObject({
      ko_id: annotationResult.ko_id,
      title: 'Ink mark',
      render_mode: 'stroke_only',
    });
    expect(await store.getCacheRecord('doc_indexeddb')).toMatchObject({ doc_id: 'doc_indexeddb', pinned: true });
    expect((await store.listPendingEvents('doc_indexeddb')).map((event) => event.operation)).toEqual(['block.update', 'annotation.add']);

    await store.close();
  });

  it('keeps source-file patches on the file-sidecar store boundary', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
    });
    await store.writeDocumentSnapshot(snapshot());

    await expect(store.updateBlockContent({
      doc_id: 'doc_indexeddb',
      block_id: 'blk_indexeddb',
      content: 'Source patch',
      source: 'web_lab',
      commit_target: { type: 'markdown_source_patch' },
    })).rejects.toThrow(/file-sidecar store/);

    await store.close();
  });

  it('applies bootstrap and remote events through the IndexedDB inbox without creating local outbox entries', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-06-28T00:10:00.000Z',
    });
    const snap = snapshot();

    expect((await store.applyRemoteEvent(event({
      event_id: 'evt_bootstrap_idb',
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: 'doc_indexeddb' },
      payload: { snapshot: snap },
    }))).status).toBe('applied');

    const remote = event({
      event_id: 'evt_remote_idb',
      operation: 'annotation.add',
      target: { type: 'annotation', id: 'ko_remote', block_id: 'blk_indexeddb' },
      payload: {
        block_id: 'blk_indexeddb',
        mark_id: 'mark_remote',
        marked_text: 'Remote marked text',
        page_id: 'pg_indexeddb_0',
        page_index: 0,
        bbox: [0.1, 0.2, 0.3, 0.04],
        annotation: { ko_id: 'ko_remote', title: 'Remote', render_mode: 'stroke_only', visual_bbox: [-4, -1, 9, 1.2], visual_strokes: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] },
      },
    });
    expect((await store.applyRemoteEvent(remote)).status).toBe('applied');
    expect((await store.applyRemoteEvent(remote)).status).toBe('skipped');

    const remoteAnnotation = (await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations?.find((annotation) => annotation.ko_id === 'ko_remote');
    expect(remoteAnnotation).toMatchObject({
      ko_id: 'ko_remote',
      visual_bbox: [0.1, 0.2, 0.3, 0.04],
      inkloop_mark: {
        mark_id: 'mark_remote',
        marked_text: 'Remote marked text',
        page_id: 'pg_indexeddb_0',
        page_index: 0,
        bbox: [0.1, 0.2, 0.3, 0.04],
      },
    });
    expect(await store.listAppliedEventIds('doc_indexeddb')).toEqual(['evt_bootstrap_idb', 'evt_remote_idb']);
    expect(await store.listOutboxEvents()).toEqual([]);

    await store.close();
  });

  it('drops stale embedded annotations when a remote bootstrap snapshot has no marks', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-06-28T00:10:00.000Z',
    });
    const existing = snapshot();
    const existingBlock = existing.blocks[0];
    if (!existingBlock?.projection) throw new Error('test setup missing projection');
    existingBlock.annotations = [{ ko_id: 'ko_existing', title: 'Existing mark', status: 'edited' }];
    existingBlock.projection.knowledge_object_ids = ['ko_existing'];
    await store.writeDocumentSnapshot(existing);

    const emptyBootstrap = snapshot();
    const emptyBlock = emptyBootstrap.blocks[0];
    if (!emptyBlock?.projection) throw new Error('test setup missing projection');
    emptyBlock.annotations = [];
    emptyBlock.projection.knowledge_object_ids = [];
    expect((await store.applyRemoteEvent(event({
      event_id: 'evt_empty_bootstrap_idb',
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: 'doc_indexeddb' },
      payload: { snapshot: emptyBootstrap },
    }))).status).toBe('applied');

    expect((await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations).toEqual([]);
    expect((await store.loadDocument('doc_indexeddb'))?.blocks[0]?.projection?.knowledge_object_ids).toEqual([]);

    const replacingBootstrap = snapshot();
    const replacingBlock = replacingBootstrap.blocks[0];
    if (!replacingBlock?.projection) throw new Error('test setup missing projection');
    replacingBlock.annotations = [{ ko_id: 'ko_existing', title: 'Remote replacement', status: 'accepted' }];
    replacingBlock.projection.knowledge_object_ids = ['ko_existing'];
    expect((await store.applyRemoteEvent(event({
      event_id: 'evt_replace_bootstrap_idb',
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: 'doc_indexeddb' },
      payload: { snapshot: replacingBootstrap },
    }))).status).toBe('applied');

    expect((await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations).toEqual([
      expect.objectContaining({ ko_id: 'ko_existing', title: 'Remote replacement', status: 'accepted' }),
    ]);

    await store.close();
  });

  it('retains a deleted annotation stub when delete follows an annotation-stripping bootstrap', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-07-15T00:00:03.000Z',
    });
    const existing = snapshot();
    existing.blocks[0].annotations = [{
      ko_id: 'ko_deleted_after_bootstrap',
      status: 'edited',
      inkloop_mark: { mark_id: 'mark_deleted_after_bootstrap' },
    }];
    await store.writeDocumentSnapshot(existing);

    const bootstrap = snapshot();
    bootstrap.blocks[0].annotations = [];
    expect((await store.applyRemoteEvent(event({
      event_id: 'evt_delete_chain_bootstrap_idb',
      operation: 'runtime.bootstrap',
      payload: { snapshot: bootstrap },
    }))).status).toBe('applied');
    expect((await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations).toEqual([]);

    const deletion = event({
      event_id: 'evt_delete_chain_idb',
      operation: 'annotation.delete',
      target: { type: 'annotation', id: 'ko_deleted_after_bootstrap', block_id: 'blk_indexeddb' },
      payload: {
        ko_id: 'ko_deleted_after_bootstrap',
        mark_id: 'mark_deleted_after_bootstrap',
        block_id: 'blk_indexeddb',
        deleted_at: '2026-07-15T00:00:02.000Z',
      },
    });
    expect((await store.applyRemoteEvent(deletion)).status).toBe('applied');
    expect((await store.applyRemoteEvent(deletion)).status).toBe('skipped');
    expect((await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations).toEqual([
      {
        ko_id: 'ko_deleted_after_bootstrap',
        status: 'deleted',
        deleted_at: '2026-07-15T00:00:02.000Z',
        inkloop_mark: { mark_id: 'mark_deleted_after_bootstrap' },
      },
    ]);
    expect(await store.listOutboxEvents()).toEqual([]);

    await store.close();
  });

  it('falls back to page_index when a remote annotation add has no block id', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-06-28T00:10:00.000Z',
    });
    await store.writeDocumentSnapshot(snapshot());

    const result = await store.applyRemoteEvent(event({
      event_id: 'evt_remote_without_block_id',
      operation: 'annotation.add',
      target: { type: 'annotation', id: 'ko_remote_no_block' },
      payload: {
        mark_id: 'mark_remote_no_block',
        marked_text: 'Fallback page mark',
        page_id: 'pg_indexeddb_0',
        page_index: 0,
        bbox: [0.2, 0.3, 0.4, 0.05],
        annotation: { ko_id: 'ko_remote_no_block', title: 'No block id', render_mode: 'stroke_only' },
      },
    }));

    const annotation = (await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations?.find((item) => item.ko_id === 'ko_remote_no_block');
    expect(result.status).toBe('applied');
    expect(annotation).toMatchObject({
      visual_bbox: [0.2, 0.3, 0.4, 0.05],
      inkloop_mark: {
        mark_id: 'mark_remote_no_block',
        page_index: 0,
        bbox: [0.2, 0.3, 0.4, 0.05],
      },
    });

    await store.close();
  });

  it('dedupes remote annotation adds by mark_id before falling back to ko_id', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-06-28T00:10:00.000Z',
    });
    await store.writeDocumentSnapshot(snapshot());

    for (const item of [
      { event_id: 'evt_remote_same_ko_a', mark_id: 'mark_a', bbox: [0.1, 0.2, 0.3, 0.04] },
      { event_id: 'evt_remote_same_ko_b', mark_id: 'mark_b', bbox: [0.2, 0.3, 0.3, 0.04] },
    ] as const) {
      expect((await store.applyRemoteEvent(event({
        event_id: item.event_id,
        operation: 'annotation.add',
        target: { type: 'annotation', id: 'ko_shared', block_id: 'blk_indexeddb' },
        payload: {
          block_id: 'blk_indexeddb',
          mark_id: item.mark_id,
          page_id: 'pg_indexeddb_0',
          page_index: 0,
          bbox: item.bbox,
          annotation: { ko_id: 'ko_shared', title: item.mark_id, render_mode: 'stroke_only' },
        },
      }))).status).toBe('applied');
    }

    const annotations = (await store.loadDocument('doc_indexeddb'))?.blocks[0].annotations ?? [];
    expect(annotations.map((annotation) => (annotation.inkloop_mark as { mark_id?: string } | undefined)?.mark_id).sort()).toEqual(['mark_a', 'mark_b']);
    expect(annotations).toHaveLength(2);

    await store.close();
  });

  it('records conflicts and device cursors in IndexedDB', async () => {
    const store = new IndexedDbOfflineRuntimeStore({
      dbName: `inksurface-test-${Date.now()}-${Math.random()}`,
      factory: indexedDB,
      now: () => '2026-06-28T00:10:00.000Z',
    });
    await store.writeDocumentSnapshot(snapshot());

    const result = await store.applyRemoteEvent(event({
      event_id: 'evt_conflict_idb',
      operation: 'annotation.update',
      target: { type: 'annotation', id: 'ko_missing' },
      payload: { ko_id: 'ko_missing', patch: { title: 'Missing' } },
    }));
    await store.writeDeviceCursor({ device_id: 'web_device', cursor: 'cursor_1', updated_at: '2026-06-28T00:11:00.000Z' });

    expect(result.status).toBe('conflicted');
    expect(await store.getDeviceCursor('web_device')).toMatchObject({ cursor: 'cursor_1' });
    expect((await store.listConflicts('doc_indexeddb'))[0]).toMatchObject({ event_id: 'evt_conflict_idb' });

    await store.close();
  });
});
