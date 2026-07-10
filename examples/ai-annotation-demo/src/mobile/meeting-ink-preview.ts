import type { StrokePoint } from '../core/contracts';
import type { PersistedMark, PersistedStroke } from '../core/store-format';

export interface MeetingInkStats {
  strokeCount: number;
  pointCount: number;
}

export interface MeetingInkPage {
  documentId: string;
  pageIndex: number;
  marks: PersistedMark[];
}

interface InkStrokeView {
  tool: PersistedStroke['tool'];
  points: Array<{ x: number; y: number }>;
}

const VIEW_W = 180;
const VIEW_H = 74;
const PAD = 7;
const PAGE_W = 1000;
const PAGE_H = 1242;

function finitePoint(point: StrokePoint): { x: number; y: number } | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: point.x, y: point.y };
}

function strokePoints(stroke: PersistedStroke): Array<{ x: number; y: number }> {
  const raw = stroke.surface_points?.length ? stroke.surface_points : stroke.points;
  return raw.map(finitePoint).filter((point): point is { x: number; y: number } => !!point);
}

function collectInkStrokes(mark: PersistedMark): InkStrokeView[] {
  return (mark.strokes || [])
    .map((stroke) => ({ tool: stroke.tool, points: strokePoints(stroke) }))
    .filter((stroke) => stroke.points.length > 0);
}

export function hasMeetingInk(mark: PersistedMark): boolean {
  return collectInkStrokes(mark).length > 0;
}

export function meetingInkStats(mark: PersistedMark): MeetingInkStats {
  const strokes = collectInkStrokes(mark);
  return {
    strokeCount: strokes.length,
    pointCount: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
  };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0';
}

function pathFor(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${fmt(point.x)},${fmt(point.y)}`).join(' ');
}

function strokeClass(tool: PersistedStroke['tool']): string {
  if (tool === 'highlighter') return ' is-highlighter';
  if (tool === 'underline') return ' is-underline';
  if (tool === 'aipen') return ' is-aipen';
  return '';
}

export function renderMeetingInkPreviewSvg(mark: PersistedMark): string {
  const strokes = collectInkStrokes(mark);
  if (!strokes.length) return '<div class="tl-ink-empty">没有可预览的原始笔迹</div>';

  const points = strokes.flatMap((stroke) => stroke.points);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const rawW = Math.max(maxX - minX, 1e-6);
  const rawH = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((VIEW_W - PAD * 2) / rawW, (VIEW_H - PAD * 2) / rawH);
  const usedW = rawW * scale;
  const usedH = rawH * scale;
  const ox = PAD + (VIEW_W - PAD * 2 - usedW) / 2 - minX * scale;
  const oy = PAD + (VIEW_H - PAD * 2 - usedH) / 2 - minY * scale;

  const body = strokes.map((stroke) => {
    const mapped = stroke.points.map((point) => ({ x: point.x * scale + ox, y: point.y * scale + oy }));
    const cls = strokeClass(stroke.tool);
    if (mapped.length === 1) {
      const p = mapped[0];
      return `<circle class="tl-ink-path${cls}" cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="2.2"/>`;
    }
    return `<path class="tl-ink-path${cls}" d="${pathFor(mapped)}"/>`;
  }).join('');

  return `<svg class="tl-ink-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="原始手写笔迹预览">${body}</svg>`;
}

function pointLooksNormalized(point: { x: number; y: number }): boolean {
  return point.x >= -0.05 && point.x <= 1.05 && point.y >= -0.05 && point.y <= 1.05;
}

function mapPagePoint(point: { x: number; y: number }, scaleX: number, scaleY: number): { x: number; y: number } {
  return { x: point.x * scaleX, y: point.y * scaleY };
}

function renderPageStroke(stroke: InkStrokeView): string {
  const normalized = stroke.points.every(pointLooksNormalized);
  const mapped = stroke.points.map((point) => normalized ? mapPagePoint(point, PAGE_W, PAGE_H) : point);
  const cls = strokeClass(stroke.tool);
  if (mapped.length === 1) {
    const p = mapped[0];
    return `<circle class="tl-note-path${cls}" cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="2.4"/>`;
  }
  return `<path class="tl-note-path${cls}" d="${pathFor(mapped)}"/>`;
}

export function renderMeetingInkPageSvg(page: MeetingInkPage): string {
  const body = page.marks.flatMap(collectInkStrokes).map(renderPageStroke).join('');
  if (!body) return '<div class="tl-note-empty">这页没有可复现的原始笔迹</div>';
  return `<svg class="tl-note-page-svg" viewBox="0 0 ${PAGE_W} ${PAGE_H}" role="img" aria-label="会议原始手记整页">${body}</svg>`;
}
