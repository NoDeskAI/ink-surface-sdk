import { describe, expect, it, vi } from 'vitest';
import type { OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import type { RuntimeAnnotation, RuntimeDocumentSnapshot, RuntimeSurfaceBlock, RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { PersistedMark } from '../../core/store-format';
import { state } from '../../app/state';
import { installWebRuntimeSyncHost, outboundRuntimeMarksForCloudPush, runtimeAnnotationToMark, runtimeMarksToTombstoneForCanonicalRemote, runtimeSourceContentHash, shouldAdoptRemoteMarkRevision, staleRuntimeManagedMarksForCanonicalRemote, visibleRuntimeMarksForCloudAlignment } from './runtime-sync-host';

function mark(input: Partial<PersistedMark> & { mark_id: string; seq: number }): PersistedMark {
  return {
    schema_version: '5',
    entry_id: `ent_${input.mark_id}`,
    document_id: input.document_id ?? 'doc_test',
    page_id: input.page_id ?? 'pg_test_0',
    page_index: input.page_index ?? 0,
    seq: input.seq,
    created_at: input.created_at ?? '2026-07-08T00:00:00.000Z',
    mark_id: input.mark_id,
    strokes: input.strokes ?? [{ tool: 'pen', coord_space: 'page_norm', capture_surface: 'page', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }] }],
    bbox: input.bbox ?? [0.1, 0.2, 0.1, 0.02],
    coord_space: input.coord_space,
    capture_surface: input.capture_surface,
    tool: input.tool ?? 'pen',
    color: input.color ?? '#111111',
    pointer_type: input.pointer_type ?? 'pen',
    device_id: input.device_id ?? 'device_test',
    abs_timestamp: 0,
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

function syncEvent(eventId: string): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: eventId,
    source: 'inkloop_device',
    doc_id: 'doc_historical',
    operation: 'annotation.add',
    target: { type: 'annotation', id: `ko_${eventId}` },
    payload: { mark_id: `mark_${eventId}` },
    status: 'pending',
    dedupe_key: eventId,
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    attempt_count: 0,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe('installWebRuntimeSyncHost outbox lifecycle', () => {
  it('drains historical pending events at boot without an active document and keeps polling single-flight', async () => {
    vi.useFakeTimers();
    const previousDocumentId = state.documentId;
    state.documentId = '';
    const storage = memoryStorage();
    const windowTarget = new EventTarget();
    const testLocation = new URL('http://localhost:5173/');
    Object.assign(windowTarget, {
      localStorage: storage,
      location: testLocation,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('location', testLocation);

    let events = [syncEvent('evt_boot_pending')];
    let cursor: { device_id: string; cursor: string; updated_at: string } | null = null;
    const store = {
      async listOutboxEvents() { return events.map((item) => ({ ...item })); },
      async writeOutboxEvents(next: RuntimeSyncEvent[]) { events = next.map((item) => ({ ...item })); },
      async updateOutboxEvents(updates: RuntimeSyncEvent[]) {
        const byId = new Map(updates.map((item) => [item.event_id, item]));
        events = events.map((item) => ({ ...(byId.get(item.event_id) ?? item) }));
      },
      async appendSyncEvent(next: RuntimeSyncEvent) { events.push({ ...next }); },
      async listPendingEvents(docId?: string) {
        return events.filter((item) => item.status !== 'sent' && (!docId || item.doc_id === docId));
      },
      async getDeviceCursor() { return cursor; },
      async writeDeviceCursor(next: { device_id: string; cursor: string; updated_at: string }) { cursor = next; },
    } as unknown as OfflineRuntimeStorePort;

    let pullCalls = 0;
    let releasePull!: () => void;
    const pullCanFinish = new Promise<void>((resolve) => { releasePull = resolve; });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { events: RuntimeSyncEvent[] };
        return new Response(JSON.stringify({
          acks: body.events.map((item) => ({ event_id: item.event_id, ok: true, ack_id: `ack_${item.event_id}` })),
        }), { status: 200 });
      }
      pullCalls += 1;
      await pullCanFinish;
      return new Response(JSON.stringify({
        schema_version: 'inkloop.runtime_sync_pull.v1',
        events: [],
        next_cursor: 'cursor_host_test',
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const host = installWebRuntimeSyncHost({
      deviceId: 'device_host_test',
      runtimeStore: store,
      pollMs: 500,
      reconcileMs: 0,
      outboxDrainMs: 0,
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(events[0], JSON.stringify(events[0])).toMatchObject({ status: 'sent', ack_id: 'ack_evt_boot_pending' });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(pullCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(pullCalls).toBe(1);
      releasePull();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      host.dispose();
      state.documentId = previousDocumentId;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('runtimeSourceContentHash', () => {
  it('uses the projection body hash instead of the generated envelope hash', () => {
    const first = runtimeSourceContentHash({
      body_hash: 'sha256:stable-body',
      content_hash: 'sha256:generated-at-a',
    });
    const second = runtimeSourceContentHash({
      body_hash: 'sha256:stable-body',
      content_hash: 'sha256:generated-at-b',
    });

    expect(first).toBe('sha256:stable-body');
    expect(second).toBe(first);
  });

  it('falls back to content_hash for older projections without body_hash', () => {
    expect(runtimeSourceContentHash({ content_hash: 'sha256:legacy-content' })).toBe('sha256:legacy-content');
  });
});

describe('runtimeAnnotationToMark', () => {
  const block: RuntimeSurfaceBlock = {
    block_id: 'block_title',
    object_id: 'obj_title',
    role: 'paragraph',
    text: '电子还是电子纸',
    projection: { page_index: 0 },
    annotations: [],
  };

  it('does not draw block-local visual strokes as page-normalized AI pen strokes', () => {
    const annotation: RuntimeAnnotation = {
      ko_id: 'ko_mark_ai_title',
      kind: 'reading_note',
      title: 'AI 笔',
      body_md: '标题下方的 AI 旁注',
      created_at: '2026-07-08T09:07:50.000Z',
      inkloop_mark: {
        mark_id: 'mark_ai_title',
        page_index: 0,
        page_id: 'pg_test_0',
        tool: 'aipen',
        origin: 'ai_pen',
        bbox: [0.2, 0.1, 0.3, 0.02],
        marked_text: '电子还是电子纸',
      },
      visual_bbox: [-4.4, -0.9, 9.9, 1.02],
      visual_strokes: [
        {
          tool: 'aipen',
          coord_space: 'block_norm',
          points: [
            { x: -4.4, y: -0.9 },
            { x: 5.5, y: 0.1 },
          ],
        },
      ],
    };

    const mark = runtimeAnnotationToMark('doc_test', block, annotation);

    expect(mark?.origin).toBe('ai_pen');
    expect(mark?.strokes).toHaveLength(1);
    expect(mark?.strokes[0]?.tool).toBe('aipen');
    expect(mark?.strokes[0]?.coord_space).toBe('page_norm');
    expect(mark?.strokes[0]?.points.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)).toBe(true);
    expect(mark?.strokes[0]?.points[0]?.x).toBeGreaterThanOrEqual(0.19);
    expect(mark?.strokes[0]?.points[2]?.x).toBeLessThanOrEqual(0.51);
  });

  it('preserves valid page-normalized visual strokes', () => {
    const annotation: RuntimeAnnotation = {
      ko_id: 'ko_mark_pen',
      kind: 'handwriting',
      title: '物理笔',
      body_md: '有效页面坐标笔迹',
      created_at: '2026-07-08T09:07:50.000Z',
      inkloop_mark: {
        mark_id: 'mark_pen',
        page_index: 0,
        page_id: 'pg_test_0',
        tool: 'pen',
        origin: 'pen',
        bbox: [0.3, 0.2, 0.2, 0.01],
      },
      visual_strokes: [
        {
          tool: 'pen',
          coord_space: 'page_norm',
          points: [
            { x: 0.3, y: 0.2 },
            { x: 0.5, y: 0.21 },
          ],
        },
      ],
    };

    const mark = runtimeAnnotationToMark('doc_test', block, annotation);

    expect(mark?.strokes).toHaveLength(1);
    expect(mark?.strokes[0]?.tool).toBe('pen');
    expect(mark?.strokes[0]?.points).toEqual([
      { x: 0.3, y: 0.2, t: 0, pressure: 0.5 },
      { x: 0.5, y: 0.21, t: 1, pressure: 0.5 },
    ]);
  });
});

describe('shouldAdoptRemoteMarkRevision', () => {
  it('adopts a remote revision when the synced mark has corrected geometry or AI origin', () => {
    const local = mark({
      mark_id: 'mark_same',
      seq: 1,
      marked_text: '旧锚点',
      origin: 'pen',
      strokes: [{ tool: 'pen', coord_space: 'page_norm', capture_surface: 'page', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.2, y: 0.2, t: 1, pressure: 0.5 }] }],
      bbox: [0.1, 0.2, 0.1, 0.02],
    });
    const remote = mark({
      mark_id: 'mark_same',
      seq: 2,
      pointer_type: 'remote',
      kind_source: 'runtime-sync',
      marked_text: '修正后的锚点',
      origin: 'ai_pen',
      strokes: [{ tool: 'aipen', coord_space: 'page_norm', capture_surface: 'page', points: [{ x: 0.3, y: 0.4, t: 0, pressure: 0.5 }, { x: 0.5, y: 0.4, t: 1, pressure: 0.5 }] }],
      bbox: [0.3, 0.4, 0.2, 0.02],
    });

    expect(shouldAdoptRemoteMarkRevision(local, remote)).toBe(true);
    expect(shouldAdoptRemoteMarkRevision(remote, remote)).toBe(false);
  });
});

describe('staleRuntimeManagedMarksForCanonicalRemote', () => {
  it('only selects runtime-managed local marks that are absent from the canonical remote set', () => {
    const staleRemote = mark({
      mark_id: 'mark_remote_stale',
      seq: 1,
      pointer_type: 'remote',
      kind_source: 'runtime-sync',
      device_id: 'runtime-sync',
    });
    const keptRemote = mark({
      mark_id: 'mark_remote_keep',
      seq: 2,
      pointer_type: 'remote',
      kind_source: 'runtime-sync',
      device_id: 'runtime-sync',
    });
    const unsyncedLocal = mark({
      mark_id: 'mark_local_unsynced',
      seq: 3,
      pointer_type: 'pen',
      kind_source: 'local_board',
      device_id: 'device_test',
    });

    expect(staleRuntimeManagedMarksForCanonicalRemote(
      [staleRemote, keptRemote, unsyncedLocal],
      new Set(['mark_remote_keep']),
    )).toEqual([staleRemote]);
  });

  it('does not tombstone anything while the remote snapshot has no canonical marks', () => {
    const staleRemote = mark({
      mark_id: 'mark_remote_stale',
      seq: 1,
      pointer_type: 'remote',
      kind_source: 'runtime-sync',
      device_id: 'runtime-sync',
    });

    expect(staleRuntimeManagedMarksForCanonicalRemote([staleRemote], new Set())).toEqual([]);
  });
});

describe('runtimeMarksToTombstoneForCanonicalRemote', () => {
  it('selects a local mark from the minimal deleted annotation stub even when no active canonical marks remain', () => {
    const deleted = mark({ mark_id: 'mark_deleted_after_bootstrap', seq: 1 });
    const runtime: RuntimeDocumentSnapshot = {
      doc_id: 'doc_test',
      doc_dir: 'indexeddb://doc_test',
      document: { doc_id: 'doc_test', title: 'Deleted mark test' },
      source: { doc_id: 'doc_test', kind: 'browser_runtime_snapshot' },
      blocks: [{
        object_id: 'blk_deleted',
        annotations: [{
          ko_id: 'ko_deleted_after_bootstrap',
          status: 'deleted',
          deleted_at: '2026-07-15T00:00:02.000Z',
          inkloop_mark: { mark_id: 'mark_deleted_after_bootstrap' },
        }],
      }],
      nodes: [],
    };

    expect(runtimeMarksToTombstoneForCanonicalRemote([deleted], runtime)).toEqual([deleted]);
  });
});

describe('outboundRuntimeMarksForCloudPush', () => {
  it('keeps local-origin revisions outbound even when canonical already knows the mark, while never echoing remote marks', () => {
    const remote = mark({
      mark_id: 'mark_remote',
      seq: 1,
      pointer_type: 'remote',
      kind_source: 'runtime-sync',
      device_id: 'runtime-sync',
    });
    const localDuplicate = mark({
      mark_id: 'mark_already_canonical',
      seq: 2,
      pointer_type: 'pen',
      kind_source: 'local_board',
      device_id: 'web_old',
    });
    const newLocal = mark({
      mark_id: 'mark_new_local',
      seq: 3,
      pointer_type: 'pen',
      kind_source: 'local_board',
      device_id: 'web_current',
    });

    // canonical 已含 mark_already_canonical，但本地 origin 的 revision（如精确擦/移动/撤销复活）仍必须出站；
    // canonical 集合只用于 bridge 侧 add/update 判定，不再作出站排除（否则几何修改/tombstone 永远漏同步）。
    expect(outboundRuntimeMarksForCloudPush(
      [remote, localDuplicate, newLocal],
      new Set(['mark_already_canonical']),
    )).toEqual([localDuplicate, newLocal]);
  });
});

describe('visibleRuntimeMarksForCloudAlignment', () => {
  it('uses every local visible mark as reconciliation evidence, including runtime-managed cache marks', () => {
    const remoteCacheOnly = mark({
      mark_id: 'mark_remote_cache_only',
      seq: 1,
      pointer_type: 'remote',
      kind_source: 'runtime-sync',
      device_id: 'runtime-sync',
    });
    const local = mark({
      mark_id: 'mark_local_visible',
      seq: 2,
      pointer_type: 'pen',
      kind_source: 'local_board',
      device_id: 'web_current',
    });
    const deleted = mark({
      mark_id: 'mark_deleted',
      seq: 3,
      is_tombstone: true,
    });

    expect(visibleRuntimeMarksForCloudAlignment([remoteCacheOnly, local, deleted])).toEqual([remoteCacheOnly, local]);
  });
});
