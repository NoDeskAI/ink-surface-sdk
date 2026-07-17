import type { NormBBox, StrokePoint } from '../core/contracts';
import type { Tool } from '../app/state';
import { styleFor } from './stroke-style';

export interface RasterStroke {
  tool: Tool;
  points: StrokePoint[];
}

export interface NormalizedPageRasterPlan {
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  scale: number;
}

export function normalizedPageRasterPlan(width: number, height: number, maxLongEdge = 1600): NormalizedPageRasterPlan {
  const sourceWidth = Number.isFinite(width) && width > 0 ? width : 1000;
  const sourceHeight = Number.isFinite(height) && height > 0 ? height : 1320;
  const scale = maxLongEdge / Math.max(sourceWidth, sourceHeight);
  return {
    sourceWidth,
    sourceHeight,
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    scale,
  };
}

/** 给 VLM 的簇区域夹回页内，并给单线/单点退化 bbox 一个可见的最小面积。 */
export function normalizeBoardOcrBbox(bbox: NormBBox, pad = 0.003): NormBBox {
  const rawX0 = Number.isFinite(bbox[0]) ? bbox[0] : 0;
  const rawY0 = Number.isFinite(bbox[1]) ? bbox[1] : 0;
  const rawX1 = rawX0 + (Number.isFinite(bbox[2]) ? Math.max(0, bbox[2]) : 0);
  const rawY1 = rawY0 + (Number.isFinite(bbox[3]) ? Math.max(0, bbox[3]) : 0);
  let x0 = Math.max(0, Math.min(1, rawX0 - pad));
  let y0 = Math.max(0, Math.min(1, rawY0 - pad));
  let x1 = Math.max(0, Math.min(1, rawX1 + pad));
  let y1 = Math.max(0, Math.min(1, rawY1 + pad));
  if (x1 - x0 < 0.001) { const center = (x0 + x1) / 2; x0 = Math.max(0, Math.min(0.999, center - 0.0005)); x1 = x0 + 0.001; }
  if (y1 - y0 < 0.001) { const center = (y0 + y1) / 2; y0 = Math.max(0, Math.min(0.999, center - 0.0005)); y1 = y0 + 0.001; }
  return [x0, y0, x1 - x0, y1 - y0];
}

function applyStyle(ctx: CanvasRenderingContext2D, tool: Tool, pressure: number): ReturnType<typeof styleFor> {
  const s = styleFor(tool, pressure);
  ctx.globalCompositeOperation = s.composite;
  ctx.strokeStyle = s.stroke;
  ctx.fillStyle = s.stroke;
  ctx.lineCap = s.cap;
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.width;
  return s;
}

function drawDot(ctx: CanvasRenderingContext2D, p: StrokePoint, tool: Tool): void {
  const s = applyStyle(ctx, tool, p.pressure);
  const r = Math.max(1, s.width / 2);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

function drawStroke(ctx: CanvasRenderingContext2D, st: RasterStroke): void {
  if (!st.points.length) return;
  if (st.points.length === 1) { drawDot(ctx, st.points[0], st.tool); return; }
  for (let i = 1; i < st.points.length; i++) {
    const a = st.points[i - 1], b = st.points[i];
    applyStyle(ctx, st.tool, b.pressure);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * 白底栅格化一组笔迹。坐标单位由调用方决定；重排页传 #reader 内容 px，
 * 避免先映回 PDF 坐标再从隐藏 #ink-layer 裁图导致的越界/形变。
 */
export function rasterizeStrokes(strokes: RasterStroke[], pad = 18, max = 900): string | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of strokes) for (const p of st.points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return undefined;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const sw = Math.max(1, x1 - x0), sh = Math.max(1, y1 - y0);
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  try {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    for (const st of strokes) drawStroke(ctx, st);
    return cv.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/** 将 page_norm 笔迹栅格化成完整白板页 JPEG。 */
export function rasterizeNormalizedPageJpeg(
  strokes: RasterStroke[],
  pageWidth: number,
  pageHeight: number,
  maxLongEdge = 1600,
  quality = 0.8,
): string | undefined {
  const plan = normalizedPageRasterPlan(pageWidth, pageHeight, maxLongEdge);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, plan.width, plan.height);
    ctx.setTransform(plan.scale, 0, 0, plan.scale, 0, 0);
    for (const stroke of strokes) {
      drawStroke(ctx, {
        tool: stroke.tool,
        points: stroke.points.map((point) => ({ ...point, x: point.x * plan.sourceWidth, y: point.y * plan.sourceHeight })),
      });
    }
    const image = canvas.toDataURL('image/jpeg', quality);
    const rawLength = image.slice(image.indexOf(',') + 1).length;
    const estimatedBytes = Math.floor(rawLength * 3 / 4);
    return estimatedBytes <= 1_450_000 ? image : undefined;
  } catch {
    return undefined;
  }
}
