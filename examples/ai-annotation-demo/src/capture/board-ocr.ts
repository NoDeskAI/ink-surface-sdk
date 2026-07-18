import { bus, state, settings } from '../app/state';
import type { NormBBox } from '../core/contracts';
import { postJson } from '../core/api';
import { devEmit } from '../core/dev-telemetry';
import type { PersistedMark } from '../core/store-format';
import { appendMarkRevisionIfCurrent, getFoldedMarks } from '../local/store';
import { normalizeBoardOcrBbox, rasterizeNormalizedPageJpeg, type RasterStroke } from './rasterize';

const PLACEHOLDER = /^手写\s+\d+\s*笔$/;
const DEFAULT_PAGE_WIDTH = 1000;
const DEFAULT_PAGE_HEIGHT = 1320;
export const BOARD_OCR_TRIGGER_COOLDOWN_MS = 30_000;

export interface BoardOcrPage {
  page_id: string;
  page_index: number;
  width: number;
  height: number;
}

export interface BoardOcrInput {
  documentId: string;
  marks: PersistedMark[];
  pages: BoardOcrPage[];
  langHint?: string;
  model?: string;
}

export interface BoardOcrRunResult {
  document_id: string;
  marks: number;
  ok: number;
  empty: number;
  ms: number;
  failed?: boolean;
}

interface BoardOcrRequest {
  image: string;
  regions: Array<{ mark_id: string; bbox: NormBBox }>;
  lang_hint?: string;
  model?: string;
}

export interface BoardOcrEngineDeps {
  rasterize(page: BoardOcrPage, marks: PersistedMark[]): string | undefined;
  request(payload: BoardOcrRequest): Promise<{ texts: Record<string, string> }>;
  writeRevision(mark: PersistedMark, patch: Partial<PersistedMark>, expectedFingerprint: string): Promise<boolean>;
  now(): number;
  emit(result: BoardOcrRunResult): void;
}

export interface BoardOcrTrigger {
  (documentId: string): Promise<BoardOcrRunResult>;
  isInFlight(documentId: string): boolean;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function quantized(value: number): string {
  return Number.isFinite(value) ? Math.round(value * 10_000).toString(36) : 'x';
}

/** 笔画数+各笔点数+bbox 是快速骨架；再带量化点序，避免同框同点数改字不触发重识别。 */
export function boardOcrFingerprint(mark: PersistedMark): string {
  const pointCounts = mark.strokes.map((stroke) => stroke.points.length).join(',');
  const points = mark.strokes
    .map((stroke) => stroke.points.map((point) => `${quantized(point.x)}.${quantized(point.y)}`).join(',')).join('|');
  const bbox = mark.bbox.map(quantized).join('.');
  return `bo1_${fnv1a(`${mark.strokes.length}:${pointCounts}:${bbox}:${points}`)}`;
}

export function boardOcrTextPending(text: string): boolean {
  const value = (text || '').trim();
  return !value || PLACEHOLDER.test(value);
}

export function shouldRecognizeBoardMark(mark: PersistedMark): boolean {
  if (mark.is_tombstone || mark.ai_eligible !== false) return false;
  if (mark.feature_type !== 'handwriting' && mark.feature_type !== 'drawing') return false;
  if (!boardOcrTextPending(mark.marked_text)) return false;
  const fingerprint = boardOcrFingerprint(mark);
  if (mark.ocr_empty && !mark.ocr_fingerprint) return false; // 早期/异常空标记无法判变，优先防重试风暴。
  return mark.ocr_fingerprint !== fingerprint;
}

export function selectBoardOcrMarks(marks: PersistedMark[]): PersistedMark[] {
  return marks.filter(shouldRecognizeBoardMark);
}

function pageForMark(mark: PersistedMark, pages: BoardOcrPage[]): BoardOcrPage {
  return pages.find((page) => page.page_id === mark.page_id)
    ?? pages.find((page) => page.page_index === mark.page_index)
    ?? { page_id: mark.page_id, page_index: mark.page_index, width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
}

function drawablePageMark(mark: PersistedMark): boolean {
  return !mark.is_tombstone
    && mark.coord_space !== 'reader_px'
    && mark.strokes.some((stroke) => stroke.points.length > 0 && stroke.coord_space !== 'reader_px');
}

function defaultRasterize(page: BoardOcrPage, marks: PersistedMark[]): string | undefined {
  const strokes: RasterStroke[] = marks.flatMap((mark) => mark.strokes
    .filter((stroke) => stroke.points.length > 0 && stroke.coord_space !== 'reader_px' && stroke.tool !== 'eraser' && stroke.tool !== 'hand')
    .map((stroke) => ({ tool: stroke.tool, points: stroke.points })));
  return rasterizeNormalizedPageJpeg(strokes, page.width, page.height)?.replace(/^data:image\/jpeg;base64,/, '');
}

export async function recognizeBoardMarks(input: BoardOcrInput, deps: BoardOcrEngineDeps): Promise<BoardOcrRunResult> {
  const startedAt = deps.now();
  const pending = selectBoardOcrMarks(input.marks);
  let ok = 0;
  let empty = 0;
  let failed = false;
  const byPage = new Map<string, PersistedMark[]>();
  for (const mark of pending) {
    const page = pageForMark(mark, input.pages);
    const key = `${page.page_index}:${page.page_id}`;
    const group = byPage.get(key) ?? [];
    group.push(mark);
    byPage.set(key, group);
  }

  for (const pagePending of byPage.values()) {
    const page = pageForMark(pagePending[0], input.pages);
    const pageMarks = input.marks.filter((mark) => mark.page_id === page.page_id && drawablePageMark(mark));
    const image = deps.rasterize(page, pageMarks);
    if (!image) { failed = true; break; }
    let response: { texts: Record<string, string> };
    try {
      response = await deps.request({
        image,
        regions: pagePending.map((mark) => ({ mark_id: mark.mark_id, bbox: normalizeBoardOcrBbox(mark.bbox) })),
        ...(input.langHint ? { lang_hint: input.langHint } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
    } catch {
      failed = true;
      break; // 网络/5xx 静默放弃本轮；未写指纹的页下次触发重试。
    }
    for (const mark of pagePending) {
      if (!Object.prototype.hasOwnProperty.call(response.texts ?? {}, mark.mark_id)) continue;
      if (typeof response.texts[mark.mark_id] !== 'string') continue;
      const fingerprint = boardOcrFingerprint(mark);
      const text = response.texts[mark.mark_id].trim();
      const wrote = await deps.writeRevision(mark, {
        marked_text: text || mark.marked_text,
        ai_eligible: false,
        ocr_at: deps.now(),
        ocr_fingerprint: fingerprint,
        ocr_empty: !text,
        ...(text ? { kind_source: 'cloud_board_ocr' } : {}),
      }, fingerprint);
      if (!wrote) continue;
      if (text) ok += 1;
      else empty += 1;
    }
  }

  const result: BoardOcrRunResult = {
    document_id: input.documentId,
    marks: pending.length,
    ok,
    empty,
    ms: Math.max(0, Math.round(deps.now() - startedAt)),
    ...(failed ? { failed: true } : {}),
  };
  deps.emit(result);
  return result;
}

function defaultPages(documentId: string, marks: PersistedMark[]): BoardOcrPage[] {
  const fallbackSize = documentId.startsWith('mtgboard_')
    ? { width: 805, height: 1000 }
    : { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
  const activeSize = state.documentId === documentId && state.pageRecord
    ? { width: state.pageRecord.width, height: state.pageRecord.height }
    : fallbackSize;
  const pages = new Map<string, BoardOcrPage>();
  for (const mark of marks) {
    if (!pages.has(mark.page_id)) pages.set(mark.page_id, { page_id: mark.page_id, page_index: mark.page_index, ...activeSize });
  }
  return [...pages.values()].sort((a, b) => a.page_index - b.page_index);
}

export async function recognizeBoardDocument(documentId: string): Promise<BoardOcrRunResult> {
  const marks = await getFoldedMarks(documentId);
  return recognizeBoardMarks({ documentId, marks, pages: defaultPages(documentId, marks), model: settings.inferModel }, {
    rasterize: defaultRasterize,
    request: (payload) => postJson('/api/ink/board-ocr', payload, { auth: true }),
    writeRevision: async (mark, patch, expectedFingerprint) => {
      if (boardOcrFingerprint(mark) !== expectedFingerprint) return false;
      const revision = await appendMarkRevisionIfCurrent(documentId, mark.mark_id, { seq: mark.seq }, patch);
      if (!revision) return false;
      bus.emit('mark:recorded', revision);
      return true;
    },
    now: () => Date.now(),
    emit: (result) => devEmit('board_ocr', () => ({
      document_id: result.document_id,
      marks: result.marks,
      ok: result.ok,
      empty: result.empty,
      ms: result.ms,
    })),
  });
}

export function createBoardOcrTrigger(
  run: (documentId: string) => Promise<BoardOcrRunResult>,
  _now: () => number = () => Date.now(),
  _cooldownMs = BOARD_OCR_TRIGGER_COOLDOWN_MS,
): BoardOcrTrigger {
  const pending = new Map<string, Promise<BoardOcrRunResult>>();
  const trigger = ((documentId: string) => {
    const prior = pending.get(documentId);
    if (prior) return prior;
    let promise: Promise<BoardOcrRunResult>;
    promise = run(documentId)
      .catch(() => ({ document_id: documentId, marks: 0, ok: 0, empty: 0, ms: 0, failed: true }))
      .finally(() => { if (pending.get(documentId) === promise) pending.delete(documentId); });
    pending.set(documentId, promise);
    return promise;
  }) as BoardOcrTrigger;
  trigger.isInFlight = (documentId: string): boolean => pending.has(documentId);
  return trigger;
}

export const triggerBoardOcr = createBoardOcrTrigger(recognizeBoardDocument);

export function isBoardOcrInFlight(documentId: string): boolean {
  return triggerBoardOcr.isInFlight(documentId);
}
