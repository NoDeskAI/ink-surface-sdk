import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbOfflineRuntimeStore, type OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import type { RuntimeDocumentSnapshot, RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { PersistedMark } from '../../core/store-format';
import { bridgeRuntimeLedgerToStore, createMemoryRuntimeBridgeWatermarks, localStorageRuntimeBridgeWatermarks } from './runtime-sync-bridge';

function snapshot(): RuntimeDocumentSnapshot {
  return {
    doc_id: 'doc_bridge',
    doc_dir: 'indexeddb://doc_bridge',
    document: { doc_id: 'doc_bridge', title: 'Bridge Doc', source_type: 'markdown' },
    source: { doc_id: 'doc_bridge', kind: 'native_markdown' },
    source_revision: { content_hash: 'sha256:bridge_snapshot' },
    blocks: [{
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_bridge',
      doc_id: 'doc_bridge',
      text: 'Bridge text',
      projection: { block_id: 'blk_bridge', kind: 'paragraph', region: 'editable', knowledge_object_ids: ['ko_mark_1'] },
      annotations: [{ ko_id: 'ko_mark_1', title: 'Bridge ink', render_mode: 'stroke_only', created_at: '2026-06-28T00:00:00.000Z' }],
    }],
    nodes: [],
  };
}

function mark(input: Partial<PersistedMark> & { mark_id: string; seq: number }): PersistedMark {
  return {
    schema_version: input.schema_version ?? '6',
    entry_id: `ent_${input.mark_id}`,
    document_id: 'doc_bridge',
    page_id: 'pg_bridge_0',
    page_index: 0,
    seq: input.seq,
    created_at: input.created_at ?? '2026-06-28T00:00:00.000Z',
    mark_id: input.mark_id,
    strokes: input.strokes ?? [{ tool: 'pen', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.2, y: 0.3, t: 1, pressure: 0.5 }] }],
    bbox: input.bbox ?? [0.1, 0.2, 0.1, 0.1],
    tool: input.tool ?? 'pen',
    color: input.color ?? '#111111',
    pointer_type: input.pointer_type ?? 'pen',
    device_id: input.device_id ?? 'device_bridge',
    abs_timestamp: 0,
    pen_down_at: input.pen_down_at,
    ocr_at: input.ocr_at,
    ocr_fingerprint: input.ocr_fingerprint,
    ocr_empty: input.ocr_empty,
    feature_type: input.feature_type ?? 'drawing',
    feature_confidence: 1,
    kind: input.kind,
    kind_source: input.kind_source,
    scored_type: input.scored_type ?? 'stroke',
    scored_score: 1,
    hmp: null,
    marked_text: input.marked_text ?? '',
    ai_eligible: input.ai_eligible,
    origin: input.origin,
    is_tombstone: input.is_tombstone ?? false,
  };
}

describe('runtime sync bridge', () => {
  it('keeps local bridge watermarks separate by runtime namespace', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const userA = localStorageRuntimeBridgeWatermarks(storage, 'tenant_a/user_a');
    const userB = localStorageRuntimeBridgeWatermarks(storage, 'tenant_a/user_b');

    await userA.write({ doc_id: 'doc_bridge', last_mark_seq: 7, updated_at: '2026-07-04T00:00:00.000Z' });

    expect(await userA.read('doc_bridge')).toMatchObject({ last_mark_seq: 7 });
    expect(await userB.read('doc_bridge')).toBeNull();
    expect([...values.keys()].sort()).toEqual(['inkloop.runtime-bridge.watermark.tenant_a.user_a.doc_bridge']);
  });

  it('bridges mark ledger entries to IndexedDB runtime snapshot and outbox exactly once', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const watermarks = createMemoryRuntimeBridgeWatermarks();
    const marks = [mark({
      mark_id: 'mark_1',
      seq: 1,
      pen_down_at: 1_751_500_000_123,
      ocr_at: 1_751_500_100_000,
      ocr_fingerprint: 'bo1_sync',
      ocr_empty: false,
    })];

    const first = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => marks,
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:01:00.000Z',
    });
    const second = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => marks,
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:02:00.000Z',
    });

    expect(first).toMatchObject({ bridged: 1, last_mark_seq: 1 });
    expect(second).toMatchObject({ bridged: 0, skipped: 0, last_mark_seq: 1 });
    // push 侧本地 materialization：本机 canonical cache 应即时反映自己的 annotation.add
    //（否则删除/移动别机 mark 后，自己 pull 因同 device echo 被跳过，hydrate 会恢复旧版本）。
    const bridgedAnnotations = (await store.loadDocument('doc_bridge'))?.blocks[0].annotations;
    expect(bridgedAnnotations).toHaveLength(1);
    expect(bridgedAnnotations?.[0]).toMatchObject({ ko_id: 'ko_mark_1' });
    expect((await store.listPendingEvents('doc_bridge')).map((event) => event.operation)).toEqual(['runtime.bootstrap', 'annotation.add']);
    const add = (await store.listPendingEvents('doc_bridge')).find((event) => event.operation === 'annotation.add');
    expect((add?.payload.annotation as { inkloop_mark?: Record<string, unknown> })?.inkloop_mark).toMatchObject({
      pen_down_at: 1_751_500_000_123,
      ocr_at: 1_751_500_100_000,
      ocr_fingerprint: 'bo1_sync',
      ocr_empty: false,
    });
    expect(add?.payload).toMatchObject({
      ocr_at: 1_751_500_100_000,
      ocr_fingerprint: 'bo1_sync',
      ocr_empty: false,
    });
    await store.close();
  });

  it('prefers the text-bearing runtime annotation when a mark has stroke-only and margin-note annotations', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-annotation-merge-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const twoLayerSnapshot = snapshot();
    twoLayerSnapshot.blocks[0].annotations = [
      {
        ko_id: 'ko_mark_text',
        kind: 'annotation',
        title: 'Bridge Doc · p1',
        render_mode: 'stroke_only',
        visual_bbox: [0.1, 0.2, 0.1, 0.1],
        visual_strokes: [{ tool: 'pen', color: '#111111', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.2, y: 0.3, t: 1, pressure: 0.5 }] }],
        created_at: '2026-06-28T00:00:00.000Z',
      },
      {
        ko_id: 'ko_mark_text',
        kind: 'annotation',
        title: 'Bridge Doc · p1',
        body_md: '手写边注',
        render_mode: 'margin_note',
        created_at: '2026-06-28T00:00:00.000Z',
      },
    ];

    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [mark({ mark_id: 'mark_text', seq: 1, marked_text: '手写边注' })],
      buildSnapshot: async () => twoLayerSnapshot,
    });

    const event = (await store.listPendingEvents('doc_bridge')).find((item) => item.operation === 'annotation.add');
    expect(event?.payload.marked_text).toBe('手写边注');
    expect(event?.payload.annotation).toMatchObject({
      ko_id: 'ko_mark_text',
      body_md: '手写边注',
      visual_bbox: [0.1, 0.2, 0.1, 0.1],
    });
    expect((event?.payload.annotation as { visual_strokes?: unknown[] })?.visual_strokes).toHaveLength(1);
    await store.close();
  });

  it('matches same-timestamp annotations by their own bbox before falling back to created_at', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-annotation-bbox-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const sameTimestampSnapshot = snapshot();
    sameTimestampSnapshot.blocks[0].annotations = [
      {
        ko_id: 'ko_ai_title',
        kind: 'ai_note',
        title: 'Bridge Doc · p1',
        render_mode: 'stroke_only',
        visual_bbox: [0.2, 0.1, 0.48, 0.02],
        created_at: '2026-06-28T00:00:00.000Z',
      },
      {
        ko_id: 'ko_ai_abstract',
        kind: 'ai_note',
        title: 'Bridge Doc · p1',
        render_mode: 'stroke_only',
        visual_bbox: [0.12, 0.27, 0.5, 0.02],
        created_at: '2026-06-28T00:00:00.000Z',
      },
    ];

    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [
        mark({ mark_id: 'mark_ai_title', seq: 1, bbox: [0.2, 0.1, 0.48, 0.02], created_at: '2026-06-28T00:00:00.000Z', origin: 'ai_pen' }),
        mark({ mark_id: 'mark_ai_abstract', seq: 2, bbox: [0.12, 0.27, 0.5, 0.02], created_at: '2026-06-28T00:00:00.000Z', origin: 'ai_pen' }),
      ],
      buildSnapshot: async () => sameTimestampSnapshot,
    });

    const events = (await store.listPendingEvents('doc_bridge')).filter((event) => event.operation === 'annotation.add');
    const byMark = new Map(events.map((event) => [String(event.payload.mark_id), event]));
    expect(byMark.get('mark_ai_title')?.payload.annotation).toMatchObject({ ko_id: 'ko_ai_title' });
    expect(byMark.get('mark_ai_abstract')?.payload.annotation).toMatchObject({ ko_id: 'ko_ai_abstract' });
    await store.close();
  });

  it('bridges a document bootstrap even when the imported document has no marks yet', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-bootstrap-${Date.now()}-${Math.random()}`, factory: indexedDB });

    const result = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:01:00.000Z',
    });

    const pending = await store.listPendingEvents('doc_bridge');
    expect(result).toMatchObject({ scanned: 0, bridged: 0, last_mark_seq: -1 });
    expect(result.event_ids).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: 'doc_bridge' },
      payload: { snapshot: { doc_id: 'doc_bridge' } },
    });
    await store.close();
  });

  it('does not use bootstrap events as an annotation transport when annotations change', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-bootstrap-annotations-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const firstSnapshot = snapshot();
    const firstBlock = firstSnapshot.blocks[0];
    if (!firstBlock?.projection) throw new Error('test setup missing projection');
    firstBlock.annotations = [];
    firstBlock.projection.knowledge_object_ids = [];
    const secondSnapshot = snapshot();
    const secondBlock = secondSnapshot.blocks[0];
    if (!secondBlock?.projection) throw new Error('test setup missing projection');
    secondBlock.annotations = [
      { ko_id: 'ko_ai_note', kind: 'ai_note', title: 'AI 旁注', body_md: '本地新增的 AI 旁注', render_mode: 'margin_note', updated_at: '2026-06-28T00:02:00.000Z' },
    ];
    secondBlock.projection.knowledge_object_ids = ['ko_ai_note'];

    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [],
      buildSnapshot: async () => firstSnapshot,
      now: () => '2026-06-28T00:01:00.000Z',
    });
    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [],
      buildSnapshot: async () => secondSnapshot,
      now: () => '2026-06-28T00:02:00.000Z',
    });

    const bootstraps = (await store.listPendingEvents('doc_bridge')).filter((event) => event.operation === 'runtime.bootstrap');
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.payload.snapshot).toMatchObject({ doc_id: 'doc_bridge' });
    expect((bootstraps[0]?.payload.snapshot as RuntimeDocumentSnapshot).blocks[0].annotations).toBeUndefined();
    await store.close();
  });

  it('preserves valid remote runtime annotations when refreshing the local bootstrap snapshot', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-preserve-remote-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const existing = snapshot();
    existing.blocks[0].annotations = [{
      ko_id: 'ko_remote',
      kind: 'markup',
      title: 'Remote mark',
      render_mode: 'stroke_only',
      visual_bbox: [0.2, 0.3, 0.4, 0.05],
      inkloop_mark: { mark_id: 'mark_remote', bbox: [0.2, 0.3, 0.4, 0.05] },
    }];
    await store.writeDocumentSnapshot(existing);

    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:01:00.000Z',
    });

    expect((await store.loadDocument('doc_bridge'))?.blocks[0].annotations).toEqual([
      expect.objectContaining({ ko_id: 'ko_remote', visual_bbox: [0.2, 0.3, 0.4, 0.05] }),
    ]);
    const bootstrap = (await store.listPendingEvents('doc_bridge')).find((event) => event.operation === 'runtime.bootstrap');
    expect((bootstrap?.payload.snapshot as RuntimeDocumentSnapshot).blocks[0].annotations).toBeUndefined();
    await store.close();
  });

  it('does not emit a new bootstrap when only annotation timestamps change', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-bootstrap-stable-time-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const firstSnapshot = snapshot();
    firstSnapshot.blocks[0].annotations = [
      { ko_id: 'ko_mark_1', kind: 'markup', title: 'Same mark', render_mode: 'stroke_only', updated_at: '2026-06-28T00:01:00.000Z' },
    ];
    const secondSnapshot = snapshot();
    secondSnapshot.blocks[0].annotations = [
      { ko_id: 'ko_mark_1', kind: 'markup', title: 'Same mark', render_mode: 'stroke_only', updated_at: '2026-06-28T00:02:00.000Z' },
    ];

    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [],
      buildSnapshot: async () => firstSnapshot,
      now: () => '2026-06-28T00:01:00.000Z',
    });
    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [],
      buildSnapshot: async () => secondSnapshot,
      now: () => '2026-06-28T00:02:00.000Z',
    });

    const bootstraps = (await store.listPendingEvents('doc_bridge')).filter((event) => event.operation === 'runtime.bootstrap');
    expect(bootstraps).toHaveLength(1);
    await store.close();
  });

  it('backfills a non-silent mark when a previous sync advanced the watermark but the event is missing from outbox', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-backfill-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const watermarks = createMemoryRuntimeBridgeWatermarks();
    await watermarks.write({ doc_id: 'doc_bridge', last_mark_seq: 4, updated_at: '2026-06-28T00:01:00.000Z' });

    const result = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => [
        mark({ mark_id: 'mark_underline', seq: 1, feature_type: 'markup' }),
        mark({ mark_id: 'mark_handwriting', seq: 3, feature_type: 'handwriting', scored_type: 'margin_note', marked_text: 'missing handwriting note' }),
        mark({ mark_id: 'mark_review_later', seq: 4, strokes: [], feature_type: 'drawing', scored_type: 'review_later', kind: 'review_later', marked_text: '稍后处理', ai_eligible: false }),
      ],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:02:00.000Z',
    });

    const pending = await store.listPendingEvents('doc_bridge');
    expect(result).toMatchObject({ bridged: 2, last_mark_seq: 4 });
    expect(pending.map((event) => event.payload.mark_id).filter(Boolean).sort()).toEqual(['mark_handwriting', 'mark_underline']);
    expect(pending.some((event) => event.payload.mark_id === 'mark_review_later')).toBe(false);
    await store.close();
  });

  it('does not bridge remote runtime marks or let them advance the local watermark', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-remote-mark-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const watermarks = createMemoryRuntimeBridgeWatermarks();

    const remoteOnly = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => [mark({ mark_id: 'mark_remote', seq: 100, pointer_type: 'remote', kind_source: 'runtime-sync' })],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:01:00.000Z',
    });
    const withLocal = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => [
        mark({ mark_id: 'mark_local', seq: 1 }),
        mark({ mark_id: 'mark_remote', seq: 100, pointer_type: 'remote', kind_source: 'runtime-sync' }),
      ],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:02:00.000Z',
    });

    const pending = await store.listPendingEvents('doc_bridge');
    expect(remoteOnly).toMatchObject({ bridged: 0, last_mark_seq: -1 });
    expect(withLocal).toMatchObject({ bridged: 1, last_mark_seq: 1 });
    expect(pending.map((event) => event.payload.mark_id).filter(Boolean)).toEqual(['mark_local']);
    await store.close();
  });

  it('does not bridge impossible page-normalized bbox marks but marks them scanned', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-invalid-bbox-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const watermarks = createMemoryRuntimeBridgeWatermarks();

    const first = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => [
        mark({ mark_id: 'mark_valid', seq: 1, bbox: [0.1, 0.2, 0.3, 0.04] }),
        mark({ mark_id: 'mark_invalid', seq: 10, bbox: [-0.403, -5.222, 1.819, 61.111] }),
      ],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:01:00.000Z',
    });
    const second = await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      loadMarks: async () => [
        mark({ mark_id: 'mark_valid', seq: 1, bbox: [0.1, 0.2, 0.3, 0.04] }),
        mark({ mark_id: 'mark_invalid', seq: 10, bbox: [-0.403, -5.222, 1.819, 61.111] }),
      ],
      buildSnapshot: async () => snapshot(),
      now: () => '2026-06-28T00:02:00.000Z',
    });

    const pending = (await store.listPendingEvents('doc_bridge')).filter((event) => event.operation === 'annotation.add');
    expect(first).toMatchObject({ bridged: 1, skipped: 1, last_mark_seq: 10 });
    expect(second).toMatchObject({ bridged: 0, skipped: 0, last_mark_seq: 10 });
    expect(pending.map((event) => event.payload.mark_id)).toEqual(['mark_valid']);
    await store.close();
  });

  it('uses the runtime host device id for sync origin while preserving the capture device id', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-origin-${Date.now()}-${Math.random()}`, factory: indexedDB });
    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      originDeviceId: 'web_runtime_device',
      loadMarks: async () => [mark({ mark_id: 'mark_origin', seq: 1, device_id: 'capture_pen_device' })],
      buildSnapshot: async () => snapshot(),
    });

    expect((await store.listPendingEvents('doc_bridge')).find((event) => event.operation === 'annotation.add')?.origin).toMatchObject({
      device_id: 'web_runtime_device',
      capture_device_id: 'capture_pen_device',
    });
    await store.close();
  });

  it('preserves reading mark tool contract in runtime events', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-tool-contract-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const toolSnapshot = snapshot();
    toolSnapshot.blocks[0].annotations = [];

    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [
        mark({
          mark_id: 'mark_highlight',
          seq: 1,
          strokes: [{ tool: 'highlighter', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.5, y: 0.2, t: 1, pressure: 0.5 }] }],
          tool: 'highlighter',
          feature_type: 'markup',
          kind: 'highlight',
          scored_type: 'highlight',
          marked_text: 'highlighted source text',
          ai_eligible: false,
        }),
        mark({
          mark_id: 'mark_underline',
          seq: 2,
          strokes: [{ tool: 'underline', points: [{ x: 0.1, y: 0.3, t: 0, pressure: 0.5 }, { x: 0.5, y: 0.3, t: 1, pressure: 0.5 }] }],
          tool: 'underline',
          feature_type: 'markup',
          kind: 'underline',
          scored_type: 'underline',
          marked_text: 'underlined source text',
          ai_eligible: false,
          origin: 'underline',
        }),
        mark({
          mark_id: 'mark_ai_pen',
          seq: 3,
          strokes: [{ tool: 'aipen', points: [{ x: 0.2, y: 0.4, t: 0, pressure: 0.5 }, { x: 0.4, y: 0.5, t: 1, pressure: 0.5 }] }],
          tool: 'pen',
          feature_type: 'handwriting',
          kind: 'ai_pen',
          scored_type: 'margin_note',
          marked_text: 'AI pen note',
          ai_eligible: true,
          origin: 'ai_pen',
        }),
      ],
      buildSnapshot: async () => toolSnapshot,
    });

    const events = (await store.listPendingEvents('doc_bridge')).filter((event) => event.operation === 'annotation.add');
    const byMark = new Map(events.map((event) => [String(event.payload.mark_id), event]));
    expect((byMark.get('mark_highlight')?.payload.annotation as { visual_strokes?: Array<{ tool?: string }> })?.visual_strokes?.[0]?.tool).toBe('highlighter');
    expect((byMark.get('mark_underline')?.payload.annotation as { visual_strokes?: Array<{ tool?: string }> })?.visual_strokes?.[0]?.tool).toBe('underline');
    expect((byMark.get('mark_ai_pen')?.payload.annotation as { visual_strokes?: Array<{ tool?: string }> })?.visual_strokes?.[0]?.tool).toBe('aipen');
    expect(byMark.get('mark_highlight')?.payload).toMatchObject({ ai_eligible: false });
    expect(byMark.get('mark_underline')?.payload).toMatchObject({ ai_eligible: false });
    expect(byMark.get('mark_ai_pen')?.payload).toMatchObject({ ai_eligible: true });
    expect(byMark.get('mark_ai_pen')?.payload).toMatchObject({ tool: 'pen', origin: 'ai_pen', scored_type: 'margin_note' });
    await store.close();
  });

  it('turns tombstone marks into annotation delete events', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-${Date.now()}-${Math.random()}`, factory: indexedDB });
    await bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      loadMarks: async () => [mark({ mark_id: 'mark_1', seq: 1, is_tombstone: true })],
      buildSnapshot: async () => snapshot(),
    });

    expect((await store.listPendingEvents('doc_bridge')).find((event) => event.operation === 'annotation.delete')).toMatchObject({
      operation: 'annotation.delete',
      payload: { ko_id: 'ko_mark_1', tombstone: true },
    });
    await store.close();
  });

  it('does not advance the bridge watermark when appending runtime events fails', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const watermarks = createMemoryRuntimeBridgeWatermarks();
    const failingStore: OfflineRuntimeStorePort = {
      ...store,
      writeDocumentSnapshot: store.writeDocumentSnapshot.bind(store),
      listOutboxEvents: store.listOutboxEvents.bind(store),
      appendSyncEvent: async (_event: RuntimeSyncEvent) => {
        throw new Error('append failed');
      },
      writeCacheRecord: store.writeCacheRecord.bind(store),
      listPendingEvents: store.listPendingEvents.bind(store),
    } as unknown as OfflineRuntimeStorePort;

    await expect(bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: failingStore,
      watermarkStore: watermarks,
      loadMarks: async () => [mark({ mark_id: 'mark_1', seq: 1 })],
      buildSnapshot: async () => snapshot(),
    })).rejects.toThrow(/append failed/);

    expect(await watermarks.read('doc_bridge')).toBeNull();
    await store.close();
  });
});

describe('runtime sync bridge · revision 级事件身份（P0 前置修复）', () => {
  it('bridges add → delete → resurrection update for the same mark as three distinct events', async () => {
    const store = new IndexedDbOfflineRuntimeStore({ dbName: `bridge-revision-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const watermarks = createMemoryRuntimeBridgeWatermarks();
    const base = { mark_id: 'mark_rev', pointer_type: 'pen' as const, kind_source: 'local_board' };

    const run = (marks: PersistedMark[], at: string, knownMarkIds?: ReadonlySet<string>) => bridgeRuntimeLedgerToStore({
      documentId: 'doc_bridge',
      documentTitle: 'Bridge Doc',
      runtimeStore: store,
      watermarkStore: watermarks,
      knownMarkIds,
      loadMarks: async () => marks,
      buildSnapshot: async () => snapshot(),
      now: () => at,
    });

    // seq=1 首见 → annotation.add
    const first = await run([mark({ ...base, seq: 1 })], '2026-07-13T00:00:01.000Z');
    expect(first.bridged).toBe(1);

    // seq=2 tombstone（bbox 零面积不许拦） → annotation.delete
    const second = await run(
      [mark({ ...base, seq: 2, is_tombstone: true, bbox: [0, 0, 0, 0], strokes: [] })],
      '2026-07-13T00:00:02.000Z',
    );
    expect(second.bridged).toBe(1);

    // seq=3 复活（同 id 非 tombstone·canonical 已知） → annotation.update
    const third = await run(
      [mark({ ...base, seq: 3 })],
      '2026-07-13T00:00:03.000Z',
      new Set(['mark_rev']),
    );
    expect(third.bridged).toBe(1);

    const events = (await store.listOutboxEvents()).filter((event) => event.payload.mark_id === 'mark_rev');
    expect(events.map((event) => event.operation)).toEqual(['annotation.add', 'annotation.delete', 'annotation.update']);
    // 三个 revision 三个独立 event_id：outbox 主键不互相覆盖，云端不误去重
    expect(new Set(events.map((event) => event.event_id)).size).toBe(3);
    expect(events.map((event) => event.payload.mark_seq)).toEqual([1, 2, 3]);
    await store.close();
  });
});
