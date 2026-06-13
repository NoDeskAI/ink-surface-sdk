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
import { detectQueryIntent } from './classify';

export type GestureKind = 'explain' | 'emphasize' | 'ask' | 'note';

export interface Gesture {
  kind: GestureKind;
  label: string;          // 调试/trace 用
  eventType: EventType;   // 写进 representative event；服务端按它框定语气
  output_modes: OutputMode[];
}

export const GESTURES: Record<GestureKind, Gesture> = {
  explain:   { kind: 'explain',   label: '圈·解释',      eventType: 'circle',      output_modes: ['inspiration'] },
  emphasize: { kind: 'emphasize', label: '划线·重点',    eventType: 'underline',   output_modes: ['inspiration'] },
  ask:       { kind: 'ask',       label: '圈+问号·提问', eventType: 'circle',      output_modes: ['question'] },
  note:      { kind: 'note',      label: '写字·批注',    eventType: 'margin_note', output_modes: ['inspiration'] },
};

/** 把一次停笔会话解析成手势意图（纯几何）。 */
export function resolveGesture(events: AnnotationEvent[]): Gesture {
  const types = events.map((e) => e.event_type);
  // 圈/点 + 额外记号 → 提问
  if (detectQueryIntent(types)) return GESTURES.ask;
  // 多笔自由书写（既非单圈也非划线）→ 批注
  const freeform = types.filter((t) => t === 'stroke').length;
  if (events.length >= 2 && freeform >= 2 && !types.includes('circle')) return GESTURES.note;
  if (types.includes('underline')) return GESTURES.emphasize;
  if (types.includes('circle') || types.includes('tap_region')) return GESTURES.explain;
  // 单笔自由 → 当批注
  return GESTURES.note;
}
