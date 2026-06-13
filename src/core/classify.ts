import type { EventType, NormBBox, StrokePoint } from './contracts';
import { pageCss } from './transform';

export function bboxOf(points: StrokePoint[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 几何启发式分类：tap_region / circle / underline / stroke */
export function classify(points: StrokePoint[], bb: NormBBox): EventType {
  const wPx = bb[2] * pageCss.w;
  const hPx = bb[3] * pageCss.h;
  const diagPx = Math.hypot(wPx, hPx);
  if (points.length <= 3 || diagPx < 8) return 'tap_region';

  const first = points[0];
  const last = points[points.length - 1];
  const closure = Math.hypot((last.x - first.x) * pageCss.w, (last.y - first.y) * pageCss.h);
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(
      (points[i].x - points[i - 1].x) * pageCss.w,
      (points[i].y - points[i - 1].y) * pageCss.h,
    );
  }
  if (closure < 0.25 * diagPx && len > 1.5 * diagPx) return 'circle';
  if (hPx < 14 && wPx > 4 * hPx) return 'underline';
  return 'stroke';
}

/**
 * 符号对话的「求解意图」启发式占位 —— 一次停笔会话里若有一个圈/点选 + 至少一个附加记号
 * （形如「圈住某处再写个问号」），就当作用户在发问。
 *
 * ⚠️ 这是占位级近似。真正「这个符号在问什么、圈住的到底是什么」属于语义识别，
 * 是本项目要突破的差异化，最终由 LLM 承载（providers/inference.ts 的 cloud 接缝）。
 * 前端只负责把候选意图标出来，不替 LLM 下结论。
 */
export function detectQueryIntent(types: EventType[]): boolean {
  if (types.length < 2) return false;
  const hasEnclose = types.some((t) => t === 'circle' || t === 'tap_region');
  const hasMark = types.some((t) => t === 'tap_region' || t === 'stroke' || t === 'underline');
  return hasEnclose && hasMark;
}
