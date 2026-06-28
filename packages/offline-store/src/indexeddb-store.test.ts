import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { RuntimeDocumentSnapshot } from '../../runtime-schema/src/index';
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
});
