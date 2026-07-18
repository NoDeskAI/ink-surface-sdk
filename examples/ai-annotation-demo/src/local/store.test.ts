import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PersistedDoc, PersistedMark, PersistedMeeting } from '../core/store-format';
import { STORE_VERSION } from '../core/store-format';
import { LOCAL_REFLOW_ENGINE, type ReflowBlock } from '../surface/reflow';

// node 环境：window 用空壳（store 的去抖只调 set/clearTimeout，不真等定时器）；
// indexedDB 缺失 → store 内 try/catch 自动退化为「仅内存」，正好测同步的活跃文档重指向逻辑。
function mkDoc(id: string): PersistedDoc {
  return { document_id: id, file_hash: id, filename: id, page_count: 10, saved_at: '', version: STORE_VERSION, pages: {} };
}

function markRecord(input: Partial<PersistedMark> & Pick<PersistedMark, 'mark_id' | 'document_id' | 'is_tombstone' | 'seq'>): PersistedMark {
  return {
    entry_id: `ent_${input.seq}`,
    created_at: new Date(input.seq).toISOString(),
    page_id: 'pg_test_0',
    page_index: 0,
    strokes: [],
    bbox: [0, 0, 0, 0],
    tool: 'pen',
    color: '#111',
    pointer_type: 'pen',
    device_id: 'dev_test',
    abs_timestamp: Date.now(),
    feature_type: 'drawing',
    feature_confidence: 1,
    scored_type: 'draw',
    scored_score: 1,
    hmp: null,
    marked_text: '',
    context_id: '__test__',
    ...input,
  };
}

const reflowBlocks: ReflowBlock[] = [{
  id: 'rfl_test',
  type: 'para',
  level: 0,
  text: '规则重排必须保留原文。',
  source: [0.1, 0.1, 0.8, 0.04],
  sourceRunIds: ['run-1'],
}];

describe('store 活跃文档重指向（R6：根除模块级 current 双真相 P0-4）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });

  it('切档后写操作只落当前活跃文档，切回不被污染', async () => {
    const store = await import('./store');
    const A = mkDoc('A');
    const B = mkDoc('B');

    store.setActiveDoc(A);
    store.setLastReadPage(3);
    expect(store.lastReadPage()).toBe(3);
    expect(A.last_read_page).toBe(3);

    store.setActiveDoc(B); // 进会议、打开材料 B
    expect(store.lastReadPage()).toBe(0); // B 没读过
    store.setLastReadPage(7);
    expect(B.last_read_page).toBe(7);
    expect(A.last_read_page).toBe(3); // ← 核心：A 不被 B 期的翻页污染

    store.setActiveDoc(A); // 退会议切回阅读 A
    expect(store.lastReadPage()).toBe(3); // A 的阅读位置完好
    expect(B.last_read_page).toBe(7);
  });

  it('综合水位线也只写当前文档，不串档', async () => {
    const store = await import('./store');
    const A = mkDoc('A');
    const B = mkDoc('B');

    store.setActiveDoc(A);
    store.setSynthesisWatermark();
    const wmA = A.synthesis_watermark_seq;
    expect(typeof wmA).toBe('number');

    store.setActiveDoc(B);
    store.setSynthesisWatermark();
    expect(B.synthesis_watermark_seq).toBeGreaterThanOrEqual(wmA as number);
    expect(A.synthesis_watermark_seq).toBe(wmA); // A 的水位线不被 B 覆盖
  });

  it('setActiveDoc(null)（白板）后写操作 no-op，不污染上一个文档', async () => {
    const store = await import('./store');
    const A = mkDoc('A');

    store.setActiveDoc(A);
    store.setLastReadPage(5);
    expect(A.last_read_page).toBe(5);

    store.setActiveDoc(null); // 白板：无持久化文档
    store.setLastReadPage(9); // 应 no-op
    expect(store.lastReadPage()).toBe(0);
    expect(A.last_read_page).toBe(5); // 上一个文档完好
  });

  it('阅读总进度记录在当前文档，包含重排页内位置', async () => {
    const store = await import('./store');
    const A = mkDoc('A');

    store.setActiveDoc(A);
    store.setReadingProgress({
      pageIndex: 4,
      pageCount: 10,
      readerPageIndex: 1,
      readerPageCount: 3,
      percent: 0.47,
      viewMode: 'reader',
    });

    expect(A.last_read_page).toBe(4);
    expect(A.last_read_progress).toMatchObject({
      page_index: 4,
      page_count: 10,
      reader_page_index: 1,
      reader_page_count: 3,
      percent: 0.47,
      view_mode: 'reader',
    });

    store.setActiveDoc(null);
    store.setReadingProgress({ pageIndex: 9, pageCount: 10, percent: 1, viewMode: 'page' });
    expect(A.last_read_page).toBe(4);
    expect(A.last_read_progress?.percent).toBe(0.47);
  });
});

describe('store reflow artifact compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });

  it('reads old local reflow caches through the current engine key as legacy approximate artifacts', async () => {
    const store = await import('./store');
    const doc = mkDoc('doc_legacy');
    doc.pages[0] = {
      page_index: 0,
      reflow: reflowBlocks,
      reflow_engine: 'local',
      images: [],
      status: 'reflowed',
    };
    store.setActiveDoc(doc);

    expect(store.getReflow(0, LOCAL_REFLOW_ENGINE)).toBe(reflowBlocks);
    expect(store.getReflow(0, 'local')).toBe(reflowBlocks);
    expect(store.getReflowArtifact(0, LOCAL_REFLOW_ENGINE)).toMatchObject({
      status: 'legacy_approximate',
      engine: LOCAL_REFLOW_ENGINE,
      legacy_engine: 'local',
      source_revision: 'doc_legacy',
    });
  });

  it('normalizes new reflow writes to artifact metadata while preserving legacy block reads', async () => {
    const store = await import('./store');
    const doc = mkDoc('doc_current');
    store.setActiveDoc(doc);

    store.putReflow(0, 'local', reflowBlocks);

    expect(store.getReflow(0, LOCAL_REFLOW_ENGINE)).toBe(reflowBlocks);
    expect(store.getReflow(0, 'local')).toBe(reflowBlocks);
    expect(doc.pages[0].reflow_engine).toBe(LOCAL_REFLOW_ENGINE);
    expect(doc.pages[0].reflow_artifact).toMatchObject({
      document_id: 'doc_current',
      page_index: 0,
      source_revision: 'doc_current',
      engine: LOCAL_REFLOW_ENGINE,
      status: 'text_ready',
      text_readiness: 'ready',
      layout_readiness: 'pending',
      page_map: { status: 'pending' },
    });
  });

  it('downgrades unknown artifact schemas to legacy block fallback when old reflow blocks exist', async () => {
    const store = await import('./store');
    const doc = mkDoc('doc_bad_schema');
    doc.pages[0] = {
      page_index: 0,
      reflow: reflowBlocks,
      reflow_engine: 'local',
      reflow_artifact: {
        schema: 'inkloop.reflow_artifact.v999',
        engine: LOCAL_REFLOW_ENGINE,
        blocks: [],
      } as never,
      images: [],
      status: 'reflowed',
    };
    store.setActiveDoc(doc);

    expect(store.getReflow(0, LOCAL_REFLOW_ENGINE)).toBe(reflowBlocks);
    expect(store.getReflowArtifact(0, LOCAL_REFLOW_ENGINE)).toMatchObject({
      status: 'legacy_approximate',
      fallback_reason: 'legacy_reflow_cache',
    });
  });

  it('persists quality-gated fallback artifacts without exposing them as renderable reflow', async () => {
    const store = await import('./store');
    const doc = mkDoc('doc_no_text');
    store.setActiveDoc(doc);

    const artifact = store.putReflowCandidate(0, LOCAL_REFLOW_ENGINE, [], []);

    expect(artifact).toMatchObject({
      status: 'no_text',
      text_readiness: 'blocked',
      page_map: { status: 'blocked' },
    });
    expect(store.getReflowArtifact(0, LOCAL_REFLOW_ENGINE)?.status).toBe('no_text');
    expect(store.getReflow(0, LOCAL_REFLOW_ENGINE)).toBeNull();
    await expect(store.hasDocumentReflow('doc_no_text', 0, LOCAL_REFLOW_ENGINE)).resolves.toBe(true);
  });
});

describe('mark ledger folding', () => {
  it('removes a mark when its latest entry is a tombstone', async () => {
    const store = await import('./store');
    const base = { mark_id: 'evt_deleted', document_id: 'doc_marks' };

    expect(store.foldMarks([
      markRecord({ ...base, seq: 1, is_tombstone: false, marked_text: 'old stroke' }),
      markRecord({ ...base, seq: 2, is_tombstone: true }),
    ])).toEqual([]);
  });

  it('keeps a mark when a newer non-tombstone revision follows a tombstone', async () => {
    const store = await import('./store');
    const base = { mark_id: 'evt_revised', document_id: 'doc_marks' };

    expect(store.foldMarks([
      markRecord({ ...base, seq: 1, is_tombstone: false, marked_text: 'v1' }),
      markRecord({ ...base, seq: 2, is_tombstone: true }),
      markRecord({ ...base, seq: 3, is_tombstone: false, marked_text: 'v2' }),
    ])).toMatchObject([
      { mark_id: 'evt_revised', marked_text: 'v2', is_tombstone: false },
    ]);
  });

  it('foldMarkRevisions keeps the latest tombstone visible for the sync chain', async () => {
    const store = await import('./store');
    const base = { mark_id: 'evt_synced_delete', document_id: 'doc_marks' };
    const entries = [
      markRecord({ ...base, seq: 1, is_tombstone: false, marked_text: 'stroke' }),
      markRecord({ ...base, seq: 2, is_tombstone: true }),
    ];

    // UI 视图不见 tombstone；同步视图必须见到，否则 delete 事件永远发不出去。
    expect(store.foldMarks(entries)).toEqual([]);
    expect(store.foldMarkRevisions(entries)).toMatchObject([
      { mark_id: 'evt_synced_delete', seq: 2, is_tombstone: true },
    ]);
  });
});

describe('mark ledger runtime hook', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });

  it('can append remote-synced marks without pushing them back to runtime sync', async () => {
    const store = await import('./store');
    const hook = vi.fn();
    store.setRuntimeLedgerAppendHook(hook);
    const { entry_id: _entryId, seq: _seq, created_at: _createdAt, ...remoteDraft } = markRecord({
      mark_id: 'evt_remote',
      document_id: 'doc_marks',
      seq: 1,
      is_tombstone: false,
      marked_text: 'remote synced mark',
      kind_source: 'runtime-sync',
    });
    const { entry_id: _entryId2, seq: _seq2, created_at: _createdAt2, ...localDraft } = markRecord({
      mark_id: 'evt_local',
      document_id: 'doc_marks',
      seq: 2,
      is_tombstone: false,
      marked_text: 'local mark',
      pen_down_at: 1_725_000_000_123,
    });

    await store.appendMarkEntry(remoteDraft, { notifyRuntime: false });
    expect(hook).not.toHaveBeenCalled();

    await store.appendMarkEntry(localDraft);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][0]).toMatchObject({
      mark_id: 'evt_local',
      schema_version: '6',
      pen_down_at: 1_725_000_000_123,
    });
  });

  it('rejects an OCR revision when the captured mark was erased before recognition returned', async () => {
    const store = await import('./store');
    const base = markRecord({
      mark_id: 'evt_ocr_erased',
      document_id: 'doc_ocr_erased',
      seq: 1,
      is_tombstone: false,
      marked_text: '手写 2 笔',
      ai_eligible: false,
    });
    const { entry_id: _entryId, seq: _seq, created_at: _createdAt, ...baseDraft } = base;
    await store.appendMarkEntry(baseDraft);
    const captured = (await store.getLatestMarkRevisions(base.document_id))[0];
    const { entry_id: _capturedEntry, seq: _capturedSeq, created_at: _capturedAt, ...tombstoneDraft } = captured;
    await store.appendMarkEntry({ ...tombstoneDraft, is_tombstone: true });

    const revision = await store.appendMarkRevisionIfCurrent(
      base.document_id,
      base.mark_id,
      { seq: captured.seq },
      { marked_text: '不应复活', ocr_fingerprint: 'bo1_old', ocr_empty: false },
    );

    expect(revision).toBeNull();
    expect(await store.getFoldedMarks(base.document_id)).toEqual([]);
  });
});

describe('meeting transactional mutation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });

  it('passes the latest meeting value to the mutator in the same readwrite transaction', async () => {
    const store = await import('./store');
    const meeting = await store.createMeeting('ws_tx', { title: 'Txn', scheduled_at: '2026-07-18T01:00:00.000Z' });
    await store.updateMeeting(meeting.meeting_id, { t0_source: 'provider_event', ended_at: '2026-07-18T02:00:00.000Z' });
    const seen: Array<PersistedMeeting['t0_source']> = [];

    const saved = await store.mutateMeeting(meeting.meeting_id, (current) => {
      seen.push(current.t0_source);
      return current.t0_source === 'provider_event' ? { status: 'ended' } : { ended_at: 'wrong' };
    });

    expect(seen).toEqual(['provider_event']);
    expect(saved).toMatchObject({ status: 'ended', ended_at: '2026-07-18T02:00:00.000Z' });
  });
});

describe('library manifest pruning', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });

  it('keeps local-first files when a stale Cloud Hub manifest is missing them', async () => {
    const store = await import('./store');
    await store.storePdfBlob('doc_local_first', new Blob(['local bytes'], { type: 'application/pdf' }));
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_local_first',
      file_hash: 'hash_local_first',
      filename: 'local-first.pdf',
      mime_type: 'application/pdf',
      size_bytes: 11,
      page_count: 1,
      source: 'paper_wifi',
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_local_first/blob',
    });

    const result = await store.pruneLibraryItems([]);

    expect(result.removed).toEqual([]);
    expect(await store.loadPdfBlob('doc_local_first')).not.toBeNull();
    expect(await store.getLibrarySyncRecord('doc_local_first')).toMatchObject({
      document_id: 'doc_local_first',
      local_available: true,
      sync_status: 'synced',
    });
  });

  it('removes stale remote-only failures when Cloud Hub no longer lists them', async () => {
    const store = await import('./store');
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_stale_remote',
      file_hash: 'hash_stale_remote',
      filename: 'stale.epub',
      mime_type: 'application/epub+zip',
      size_bytes: 123,
      page_count: 1,
      source: 'web',
      sync_status: 'failed',
      local_available: false,
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_stale_remote/blob',
      error: 'download_source_404',
    });

    const result = await store.pruneLibraryItems([]);

    expect(result.removed).toEqual(['doc_stale_remote']);
    expect(await store.getLibrarySyncRecord('doc_stale_remote')).toBeNull();
  });

  it('removes retired demo books even if the old browser has a local copy', async () => {
    const store = await import('./store');
    await store.storePdfBlob('doc_db5b9b212c76', new Blob(['old demo bytes'], { type: 'application/pdf' }));
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_db5b9b212c76',
      file_hash: 'db5b9b212c7696f60f8dfcc3e1ee01855bfac8755a37887d77094e161fa284a2',
      filename: 'mock-material-chaohua.pdf',
      mime_type: 'application/pdf',
      size_bytes: 14,
      page_count: 1,
      source: 'web',
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_db5b9b212c76/blob',
    });

    const result = await store.pruneLibraryItems([]);

    expect(result.removed).toEqual(['doc_db5b9b212c76']);
    expect(await store.loadPdfBlob('doc_db5b9b212c76')).toBeNull();
    expect(await store.getLibrarySyncRecord('doc_db5b9b212c76')).toBeNull();
  });

  it('hides retired demo books from the shelf before the next manifest prune finishes', async () => {
    const store = await import('./store');
    await store.storePdfBlob('doc_db5b9b212c76', new Blob(['old demo bytes'], { type: 'application/pdf' }));
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_db5b9b212c76',
      file_hash: 'db5b9b212c7696f60f8dfcc3e1ee01855bfac8755a37887d77094e161fa284a2',
      filename: 'mock-material-chaohua.pdf',
      mime_type: 'application/pdf',
      size_bytes: 14,
      page_count: 1,
      source: 'web',
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_db5b9b212c76/blob',
    });

    expect((await store.listLibraryItems()).map((item) => item.document_id)).not.toContain('doc_db5b9b212c76');
  });

  it('deletes a library item with its local source and sync record', async () => {
    const store = await import('./store');
    await store.storePdfBlob('doc_delete_me', new Blob(['local bytes'], { type: 'application/pdf' }));
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_delete_me',
      file_hash: 'hash_delete_me',
      filename: 'delete-me.pdf',
      mime_type: 'application/pdf',
      size_bytes: 11,
      page_count: 1,
      source: 'web',
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
    });

    await store.deleteLibraryItem('doc_delete_me');

    expect(await store.loadPdfBlob('doc_delete_me')).toBeNull();
    expect(await store.getLibrarySyncRecord('doc_delete_me')).toBeNull();
    expect((await store.listLibraryItems()).some((item) => item.document_id === 'doc_delete_me')).toBe(false);
  });

  it('deletes only the local copy when a Cloud Hub source exists', async () => {
    const store = await import('./store');
    await store.storePdfBlob('doc_delete_local_copy', new Blob(['local bytes'], { type: 'application/pdf' }));
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_delete_local_copy',
      file_hash: 'hash_delete_local_copy',
      filename: 'delete-local-copy.pdf',
      mime_type: 'application/pdf',
      size_bytes: 11,
      page_count: 1,
      source: 'web',
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_delete_local_copy/blob',
    });

    await store.deleteLocalLibraryItem('doc_delete_local_copy');

    const sync = await store.getLibrarySyncRecord('doc_delete_local_copy');
    expect(await store.loadPdfBlob('doc_delete_local_copy')).toBeNull();
    expect(sync).toMatchObject({
      document_id: 'doc_delete_local_copy',
      sync_status: 'cloud_only',
      local_available: false,
      cloud_available: true,
    });
    expect((await store.listLibraryItems()).find((item) => item.document_id === 'doc_delete_local_copy')).toMatchObject({
      sync_status: 'cloud_only',
      local_available: false,
      cloud_available: true,
      doc: null,
    });
  });

  it('keeps shelf order stable when sync metadata changes', async () => {
    const store = await import('./store');
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_b',
      file_hash: 'hash_b',
      filename: '纳瓦尔宝典.epub',
      mime_type: 'application/epub+zip',
      size_bytes: 1,
      page_count: 1,
      source: 'web',
      sync_status: 'cloud_only',
      local_available: false,
      cloud_available: true,
      updated_at: '2026-07-06T01:00:00.000Z',
    });
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_a',
      file_hash: 'hash_a',
      filename: 'AI时代的UX范式.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1,
      page_count: 1,
      source: 'web',
      sync_status: 'cloud_only',
      local_available: false,
      cloud_available: true,
      updated_at: '2026-07-06T00:00:00.000Z',
    });

    const before = (await store.listLibraryItems()).map((item) => item.document_id);
    await store.upsertLibrarySyncRecord({
      document_id: 'doc_b',
      file_hash: 'hash_b',
      filename: '纳瓦尔宝典.epub',
      mime_type: 'application/epub+zip',
      size_bytes: 1,
      page_count: 1,
      source: 'web',
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
      updated_at: '2026-07-06T03:00:00.000Z',
    });

    expect((await store.listLibraryItems()).map((item) => item.document_id)).toEqual(before);
  });
});
