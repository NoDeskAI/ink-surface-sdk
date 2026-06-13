import type { AnnotationEvent, EventType, InferenceRequest, InferenceResult, NormBBox, OCRResult, OutputMode, ScreenOverlay } from './contracts';
import { RESULT_TO_OVERLAY, SCHEMA_VERSION } from './contracts';
import { DEVICE_ID, SESSION_ID, shortId } from './ids';
import { bboxOf, classify } from './classify';
import { mark } from './metrics';
import { trace } from './trace';
import { bus, state, type Stroke } from '../app/state';
import { ocrProviders } from '../providers/ocr';
import { inferProviders } from '../providers/inference';
import type { Gesture } from './gesture';

/** 单笔封装为契约 shape。会话内多笔共享一个 trace_id（决策：停笔会话）。 */
export function makeEvent(stroke: Stroke, traceId: string): AnnotationEvent | null {
  if (!state.documentId || !state.pageId) return null;
  const bb = bboxOf(stroke.points);
  return {
    event_id: shortId('evt'),
    trace_id: traceId,
    document_id: state.documentId,
    page_id: state.pageId,
    event_type: stroke.tool === 'highlighter' ? 'highlight' : classify(stroke.points, bb),
    geometry: { bbox: bb },
    stroke_points: stroke.points, // 无损（决策 D3）
    text_note: null,
    created_at: new Date().toISOString(),
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    pointer_type: 'unknown',
    version: SCHEMA_VERSION,
  };
}

/** 抬笔即记录：每笔独立 event 进 trace（B 组原料不丢），并打 pen-up→event 延迟。 */
export function recordEvent(stroke: Stroke, traceId: string, pointerType: string, penUpAt: number): AnnotationEvent | null {
  const evt = makeEvent(stroke, traceId);
  if (!evt) return null;
  evt.pointer_type = pointerType;
  trace('AnnotationEvent', evt as unknown as Record<string, unknown>);
  mark('pen_event', performance.now() - penUpAt);
  return evt;
}

function unionBBox(events: AnnotationEvent[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const e of events) {
    const [x, y, w, h] = e.geometry.bbox;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 会话内多笔合并成一个代表 event 用于推理（trace 里每笔仍独立留存）。 */
function representative(events: AnnotationEvent[]): AnnotationEvent {
  const bbox = unionBBox(events);
  const points = events.flatMap((e) => e.stroke_points);
  const last = events[events.length - 1];
  return { ...last, geometry: { bbox }, stroke_points: points, event_type: classify(points, bbox) };
}

function buildRequest(
  evt: AnnotationEvent,
  ocr: Pick<OCRResult, 'text_blocks' | 'nearby_text'>,
  output_modes: OutputMode[] = ['inspiration', 'question', 'connection'],
): InferenceRequest {
  return {
    request_id: shortId('req'),
    trace_id: evt.trace_id,
    event_id: evt.event_id,
    document_context: { document_id: evt.document_id },
    page_context: { page_id: evt.page_id, page_index: state.pageIndex },
    annotation_event: { event_type: evt.event_type, page_id: evt.page_id, geometry: evt.geometry },
    ocr_blocks: ocr.text_blocks,
    nearby_text: ocr.nearby_text,
    user_profile_stub: null,
    output_modes,
    version: SCHEMA_VERSION,
  };
}

function errorResult(evt: AnnotationEvent, err: unknown): InferenceResult {
  return {
    result_id: shortId('res'),
    trace_id: evt.trace_id,
    request_id: 'n/a',
    result_type: 'error',
    content: '此刻没能想清楚，稍后再为你低语。',
    source_refs: [{ page_id: evt.page_id, bbox: evt.geometry.bbox, ocr_block_ids: [], event_id: evt.event_id }],
    confidence: 0,
    created_at: new Date().toISOString(),
    model_name: 'n/a',
    model_version: SCHEMA_VERSION,
  };
}

function buildOverlay(result: InferenceResult, evt: AnnotationEvent): ScreenOverlay {
  return {
    overlay_id: shortId('ovl'),
    trace_id: evt.trace_id,
    page_id: evt.page_id,
    result_id: result.result_id,
    overlay_type: RESULT_TO_OVERLAY[result.result_type],
    geometry: { anchor_bbox: result.source_refs[0]?.bbox || evt.geometry.bbox },
    display_text: result.content,
    dismissible: true,
    created_at: new Date().toISOString(),
    state: 'shown',
    result_type: result.result_type,
  };
}

/**
 * 停笔会话提交：合并几何 → OCR → 推理 → 旁注低语。云端失败降级不崩（A11）。
 * 行为「逐笔即时旁注」用默认 modes；「符号对话」经 commitDialogue 传 ['question']。
 */
export async function commitSession(
  events: AnnotationEvent[],
  penUpAt: number,
  modes: OutputMode[] = ['inspiration', 'question', 'connection'],
  eventType?: EventType,
): Promise<void> {
  if (!events.length) return;
  const evt = representative(events);
  if (eventType) evt.event_type = eventType; // 手势 canonical 类型，服务端据此框定语气

  const tEvent = performance.now();
  let result: InferenceResult;
  try {
    const ocr = await ocrProviders[state.ocrProvider](evt);
    trace('OCRResult', ocr as unknown as Record<string, unknown>);
    mark('event_ocr', performance.now() - tEvent);

    const tOcr = performance.now();
    const req = buildRequest(evt, ocr, modes);
    trace('InferenceRequest', req as unknown as Record<string, unknown>);
    result = await inferProviders[state.inferProvider](req);
    trace('InferenceResult', result as unknown as Record<string, unknown>);
    mark('ocr_result', performance.now() - tOcr);
  } catch (err) {
    result = errorResult(evt, err);
    trace('InferenceResult(error)', result as unknown as Record<string, unknown>);
  }

  const tResult = performance.now();
  const overlay = buildOverlay(result, evt);
  trace('ScreenOverlay', overlay as unknown as Record<string, unknown>);
  state.overlays.push(overlay);
  bus.emit('overlay:add', overlay);
  mark('result_screen', performance.now() - tResult);
  mark('total', performance.now() - penUpAt);
}

/**
 * 手势提交：一次停笔会话按解析出的手势意图作答（圈=解释/划线=重点/圈+问号=提问/写字=批注）。
 * 同一条管线，手势只改 output_modes + canonical eventType；服务端据此框定语气。
 * 真值「这符号在问什么、圈住的到底是什么」由 LLM 细化（B 组），前端只给几何意图。
 */
export async function commitGesture(events: AnnotationEvent[], penUpAt: number, g: Gesture): Promise<void> {
  await commitSession(events, penUpAt, g.output_modes, g.eventType);
}

/** 符号类型 → 中文标签（喂给推理的结构化上下文，也方便人读 trace）。 */
const SYM_LABEL: Record<EventType, string> = {
  circle: '圈选', underline: '划线', highlight: '高亮', arrow: '箭头',
  margin_note: '批注', tap_region: '点选', stroke: '标记', eraser: '擦除', unknown: '标记',
};

/**
 * 停顿综合：把本页累积的所有标注合成一条 AI 回答，落在右侧留白。
 * 每个标注各取「符号类型 + 圈住的上下文」，结构化进 nearby_text 一并喂推理
 * （守住冻结契约 D4：不改 InferenceRequest 形状，只用既有 nearby_text/output_modes 字段）。
 * 每轮综合替换上一条综述（按页 upsert），始终只留最新一条。
 */
export async function commitDigest(events: AnnotationEvent[], penUpAt: number): Promise<void> {
  if (!events.length) return;
  const evt = representative(events);
  evt.trace_id = shortId('dgst');

  // 逐标注取圈住的上下文（OCR 失败的单条跳过，不连累整体）
  const ocrs = await Promise.all(
    events.map((e) => ocrProviders[state.ocrProvider](e).catch(() => null)),
  );
  const parts = events.map((e, i) => {
    const blocks = ocrs[i]?.text_blocks ?? [];
    const text = (blocks.map((b) => b.text).join('') || ocrs[i]?.nearby_text || '').trim();
    return { type: e.event_type, text };
  });
  const structured = parts
    .map((p) => `〔${SYM_LABEL[p.type]}〕"${(p.text || '此处').slice(0, 40)}"`)
    .join('  ');
  const allBlocks = ocrs.flatMap((o) => o?.text_blocks ?? []);

  let result: InferenceResult;
  try {
    const req = buildRequest(evt, { text_blocks: allBlocks, nearby_text: structured || null }, ['summary']);
    trace('InferenceRequest(digest)', req as unknown as Record<string, unknown>);
    result = await inferProviders[state.inferProvider](req);
    trace('InferenceResult(digest)', result as unknown as Record<string, unknown>);
  } catch (err) {
    result = errorResult(evt, err);
    trace('InferenceResult(error)', result as unknown as Record<string, unknown>);
  }

  // upsert：移除本页上一条综述，换成最新一条
  const prev = state.overlays.find((o) => o.result_type === 'summary' && o.page_id === evt.page_id);
  if (prev) {
    state.overlays = state.overlays.filter((o) => o !== prev);
    bus.emit('overlay:remove', prev.overlay_id);
  }
  const overlay = buildOverlay(result, evt);
  overlay.geometry = { anchor_bbox: evt.geometry.bbox }; // 锚到标注簇，留白里按其 y 对齐
  trace('ScreenOverlay(digest)', overlay as unknown as Record<string, unknown>);
  state.overlays.push(overlay);
  bus.emit('overlay:add', overlay);
  mark('total', performance.now() - penUpAt);
}
