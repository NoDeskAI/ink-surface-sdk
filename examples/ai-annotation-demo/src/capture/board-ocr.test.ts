import { describe, expect, it, vi } from 'vitest';
import type { PersistedMark } from '../core/store-format';
import { normalizeBoardOcrBbox, normalizedPageRasterPlan } from './rasterize';
import {
  boardOcrFingerprint,
  createBoardOcrTrigger,
  recognizeBoardMarks,
  selectBoardOcrMarks,
  shouldRecognizeBoardMark,
  type BoardOcrEngineDeps,
} from './board-ocr';

function mark(overrides: Partial<PersistedMark> = {}): PersistedMark {
  return {
    entry_id: 'ent_1', document_id: 'diary_1', page_id: 'pg_diary_1_0', page_index: 0,
    seq: 1, created_at: '2026-07-17T00:00:00.000Z', mark_id: 'mark_1',
    strokes: [{ tool: 'pen', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.2, y: 0.3, t: 10, pressure: 0.5 }] }],
    bbox: [0.1, 0.2, 0.1, 0.1], tool: 'pen', color: '#111', pointer_type: 'pen', device_id: 'test',
    abs_timestamp: 1, feature_type: 'handwriting', feature_confidence: 0.8,
    scored_type: 'stroke_group', scored_score: 0.8, hmp: null, marked_text: '手写 2 笔',
    ai_eligible: false, origin: 'pen', is_tombstone: false,
    ...overrides,
  };
}

describe('board OCR mark selection', () => {
  it('selects empty/placeholders and skips real text, unchanged fingerprints and ocr_empty retries', () => {
    const placeholder = mark({ mark_id: 'placeholder' });
    const empty = mark({ mark_id: 'empty', marked_text: '', feature_type: 'drawing' });
    const real = mark({ mark_id: 'real', marked_text: '真实文字' });
    const unchangedBase = mark({ mark_id: 'unchanged' });
    const unchanged = mark({ ...unchangedBase, ocr_fingerprint: boardOcrFingerprint(unchangedBase) });
    const legacyEmpty = mark({ mark_id: 'legacy-empty', marked_text: '', ocr_empty: true });
    expect(selectBoardOcrMarks([placeholder, empty, real, unchanged, legacyEmpty]).map((item) => item.mark_id)).toEqual(['placeholder', 'empty']);
  });

  it('retries only when content fingerprint changes', () => {
    const base = mark();
    const changed = mark({ ocr_fingerprint: boardOcrFingerprint(base), ocr_empty: true, bbox: [0.1, 0.2, 0.2, 0.1] });
    expect(shouldRecognizeBoardMark(changed)).toBe(true);
  });
});

describe('board OCR raster plan', () => {
  it('keeps page aspect ratio under 1600px and normalizes padded regions', () => {
    expect(normalizedPageRasterPlan(1000, 1320)).toMatchObject({ width: 1212, height: 1600 });
    const bbox = normalizeBoardOcrBbox([0, 0.2, 0, 0.1]);
    expect(bbox[0]).toBe(0);
    expect(bbox[2]).toBeGreaterThan(0);
    expect(bbox[1]).toBeCloseTo(0.197);
    expect(bbox[3]).toBeCloseTo(0.106);
  });
});

describe('board OCR writeback', () => {
  it('writes text and empty markers as revisions while keeping ai_eligible false', async () => {
    const revisions: Array<{ mark: PersistedMark; patch: Partial<PersistedMark> }> = [];
    let now = 100;
    const deps: BoardOcrEngineDeps = {
      rasterize: vi.fn(() => 'jpeg-base64'),
      request: vi.fn(async () => ({ texts: { mark_text: '会议结论', mark_empty: '' } })),
      writeRevision: vi.fn(async (input, patch) => { revisions.push({ mark: input, patch }); return true; }),
      now: () => now++,
      emit: vi.fn(),
    };
    const marks = [mark({ mark_id: 'mark_text' }), mark({ mark_id: 'mark_empty' })];
    const result = await recognizeBoardMarks({
      documentId: 'diary_1', marks,
      pages: [{ page_id: 'pg_diary_1_0', page_index: 0, width: 1000, height: 1320 }],
    }, deps);
    expect(result).toMatchObject({ marks: 2, ok: 1, empty: 1 });
    expect(deps.request).toHaveBeenCalledOnce(); // 同页两簇，整页仅一次请求。
    expect(revisions[0].patch).toMatchObject({ marked_text: '会议结论', ai_eligible: false, ocr_empty: false });
    expect(revisions[1].patch).toMatchObject({ marked_text: '手写 2 笔', ai_eligible: false, ocr_empty: true });
    expect(revisions.every(({ patch }) => typeof patch.ocr_fingerprint === 'string')).toBe(true);
  });

  it('processes virtual-pager pages separately while keeping one request per page', async () => {
    const request = vi.fn(async (payload: { regions: Array<{ mark_id: string }> }) => ({
      texts: Object.fromEntries(payload.regions.map((region) => [region.mark_id, region.mark_id])),
    }));
    const first = mark({ mark_id: 'page_0' });
    const second = mark({ mark_id: 'page_1', page_id: 'pg_diary_1_1', page_index: 1 });
    await recognizeBoardMarks({
      documentId: 'diary_1', marks: [first, second],
      pages: [
        { page_id: first.page_id, page_index: 0, width: 1000, height: 1320 },
        { page_id: second.page_id, page_index: 1, width: 1000, height: 1320 },
      ],
    }, {
      rasterize: () => 'jpeg-base64', request,
      writeRevision: async () => true, now: () => 1, emit: () => {},
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([payload]) => payload.regions.map((region) => region.mark_id))).toEqual([['page_0'], ['page_1']]);
  });
});

describe('board OCR trigger idempotency', () => {
  it('deduplicates the same document for 30 seconds', async () => {
    let now = 1_000;
    const run = vi.fn(async (documentId: string) => ({ document_id: documentId, marks: 1, ok: 1, empty: 0, ms: 10 }));
    const trigger = createBoardOcrTrigger(run, () => now);
    await Promise.all([trigger('doc_1'), trigger('doc_1')]);
    now += 29_999;
    await trigger('doc_1');
    expect(run).toHaveBeenCalledTimes(1);
    now += 2;
    await trigger('doc_1');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
