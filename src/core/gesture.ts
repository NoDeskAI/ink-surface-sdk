/**
 * v1 手势集 —— 给「低成本语义序列」的几何 token 赋含义（符号 = 意图）。
 *
 * 纯几何、0 OCR：手势的「种类」只看笔迹轨迹（classify），不看像素。
 * 「圈住了什么字」由文本层给（数字版 PDF 免 OCR）；只有「读手写内容」才要 OCR（B 组）。
 *
 * 一次停笔会话 → 一个手势意图。canonical eventType 写进 representative event，
 * 服务端据此框定回应语气（output_modes 约束 result_type）。
 */
import type { AnnotationEvent, EventType, OutputMode } from './contracts';
import { classifyScored, detectQueryIntent } from './classify';
import { pageCss } from './transform';
import { state } from '../app/state';

/** 形状门槛：低于此分的单笔自由涂抹不算手势（不触发 AI），笔迹仍无损留着。 */
export const GESTURE_MIN_SCORE = 0.3;

/**
 * 这次停笔到底算不算"刻意的手势"——决定生成与否（"不抢笔"原则：宁漏不滥）。
 * 刻意 = 有一笔画得够像范例（圈/划/箭头分数 ≥ 门槛）。
 *
 * tap_region 不算手势 —— v1 词表里没有"点选触发"；它是 contract 里的合法 event，
 * 但只进 trace、不进推理路径（未来若做"轻触卡片/段落"再走单独通道）。
 * 单笔/多笔潦草 stroke 也不算 —— 改由 VLM 视觉路径（settings.gesture.routing='vlm'）兜底，
 * 不再用"≥2 笔自由"这种粗暴规则把任何涂鸦都当批注。
 */
export function isDeliberate(events: AnnotationEvent[]): boolean {
  if (!events.length) return false;
  return events.some((e) => {
    if (e.event_type === 'tap_region') return false; // tap 永远不算手势
    return classifyScored(e.stroke_points, e.geometry.bbox).score >= GESTURE_MIN_SCORE;
  });
}

export type GestureKind = 'explain' | 'emphasize' | 'ask' | 'note' | 'relate';

/** 用户意图（「为什么写」）—— 决定下游推理怎么响应。 */
export type Intent = 'what_is_this' | 'key_point' | 'question' | 'relation' | 'free_note' | 'command';

export interface Gesture {
  kind: GestureKind;
  label: string;          // 调试/trace 用
  eventType: EventType;   // 写进 representative event；服务端按它框定语气
  intent: Intent;         // 用户意图（为什么写）
  output_modes: OutputMode[];
}

export const GESTURES: Record<GestureKind, Gesture> = {
  explain:   { kind: 'explain',   label: '圈·解释',      eventType: 'circle',      intent: 'what_is_this', output_modes: ['inspiration'] },
  emphasize: { kind: 'emphasize', label: '划线·重点',    eventType: 'underline',   intent: 'key_point',    output_modes: ['inspiration'] },
  ask:       { kind: 'ask',       label: '圈+问号·提问', eventType: 'circle',      intent: 'question',     output_modes: ['question'] },
  relate:    { kind: 'relate',    label: '箭头·关联',    eventType: 'arrow',       intent: 'relation',     output_modes: ['connection'] },
  note:      { kind: 'note',      label: '写字·批注',    eventType: 'margin_note', intent: 'free_note',    output_modes: ['inspiration'] },
};

/** intent → output_modes（VLM 解读手写意图后用它改写推理语气）。 */
export const INTENT_MODES: Record<Intent, OutputMode[]> = {
  what_is_this: ['inspiration'],
  key_point: ['inspiration'],
  question: ['question'],
  relation: ['connection'],
  free_note: ['inspiration'],
  command: ['action'],
};

/** 把一次停笔会话解析成手势意图（纯几何）。tap_region 已被 isDeliberate 过滤，不会到这。 */
export function resolveGesture(events: AnnotationEvent[]): Gesture {
  const types = events.map((e) => e.event_type);
  // 圈 + 额外记号（停笔会话内多了一笔小记号，像问号）→ 提问
  if (detectQueryIntent(types)) return GESTURES.ask;
  if (types.includes('arrow')) return GESTURES.relate; // 箭头 → 关联
  if (types.includes('underline')) return GESTURES.emphasize;
  if (types.includes('circle')) return GESTURES.explain;
  // 全是 stroke（潦草笔但有一笔过门槛）：由 VLM 视觉路径承担"是写字还是抽象符号"的判定；
  // 几何路径下，保守地当批注。如果想要更精准识别，切 routing='vlm'。
  return GESTURES.note;
}

// ───────────────────────── 三档 auto 路由 ─────────────────────────

export interface RouteDecision {
  route: 'mark' | 'write' | 'vlm';
  n: number;
  medSize: number; // 中位笔画对角线 ÷ 本地行高（px）；行高未知记 -1
  primMax: number; // 最像某原语（圈/划/箭头）的分
  reason: string;  // 人读：为什么这么路由（进 trace）
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 笔迹 y 带附近的中位字高（px）。无文本层命中 → null（量不出 → 交 VLM）。 */
function localLineHeightPx(yTop: number, yBot: number): number | null {
  const hs = state.textBlocks
    .filter((tb) => tb.text.trim() && tb.bbox[1] < yBot && tb.bbox[1] + tb.bbox[3] > yTop)
    .map((tb) => tb.bbox[3] * pageCss.h);
  if (!hs.length) return null;
  return median(hs);
}

/**
 * 把一次组装窗（已滤掉 tap 的真实笔画）判成三档之一。只用三个特征：
 *   n        笔画数
 *   medSize  中位笔画对角线 ÷ 本地行高 —— 记号比它指的字大；手写跟字一样大
 *   primMax  最像某原语的分 —— 干净圈/划/箭头高，潦草手写低
 * 判定偏向"宁可升级 VLM，别把手写误吞成记号"：只有够大够像的单原语才本地判记号，
 * 只有多笔·字号·不像原语才本地判手写，其余（含量不出行高）一律交 VLM 裁决。
 * 阈值先写死，真机再调；trace 里会显示 n/medSize/primMax 便于调。
 */
export function routeAssembly(events: AnnotationEvent[]): RouteDecision {
  const n = events.length;
  const scored = events.map((e) => classifyScored(e.stroke_points, e.geometry.bbox));
  const primMax = Math.max(0, ...scored.map((s) => {
    const r = s.raw;
    return r ? Math.max(r.circle, r.underline, r.arrow) : 0;
  }));

  let yTop = 1, yBot = 0;
  for (const e of events) {
    yTop = Math.min(yTop, e.geometry.bbox[1]);
    yBot = Math.max(yBot, e.geometry.bbox[1] + e.geometry.bbox[3]);
  }
  const lineHpx = localLineHeightPx(yTop, yBot);
  if (lineHpx == null) {
    return { route: 'vlm', n, medSize: -1, primMax, reason: '无文本层·量不出行高 → VLM' };
  }

  const diagPxs = events.map((e) => Math.hypot(e.geometry.bbox[2] * pageCss.w, e.geometry.bbox[3] * pageCss.h));
  const medSize = median(diagPxs) / lineHpx;

  if (n <= 2 && primMax >= 0.5 && medSize >= 1.6) {
    return { route: 'mark', n, medSize, primMax, reason: '单原语·够大够像 → 记号（几何·0 token）' };
  }
  if (n >= 3 && medSize <= 1.0 && primMax < 0.35) {
    return { route: 'write', n, medSize, primMax, reason: '多笔·字号·不像原语 → 手写（读字+最近N行）' };
  }
  return { route: 'vlm', n, medSize, primMax, reason: '信号不确定 → VLM 裁决（可回 nothing 不打扰）' };
}
