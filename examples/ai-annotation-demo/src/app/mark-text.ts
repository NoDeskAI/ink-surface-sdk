import type { NormBBox, OcrTextBlock } from '../core/contracts';

function overlapArea(a: NormBBox, b: NormBBox): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return x * y;
}

function horizontalOverlap(a0: number, a1: number, b: NormBBox): number {
  return Math.max(0, Math.min(a1, b[0] + b[2]) - Math.max(a0, b[0]));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function sliceBlockTextByX(text: string, block: NormBBox, x0: number, x1: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || block[2] <= 0) return clean;
  const left = clamp01((x0 - block[0]) / block[2]);
  const right = clamp01((x1 - block[0]) / block[2]);
  if (right - left > 0.88) return clean;
  const chars = [...clean];
  const start = Math.max(0, Math.min(chars.length - 1, Math.floor(left * chars.length)));
  const end = Math.max(start + 1, Math.min(chars.length, Math.ceil(right * chars.length)));
  return chars.slice(start, end).join('').trim();
}

function joinedText(texts: string[]): string {
  const joined = texts.join(/[\u4e00-\u9fff]/.test(texts.join('')) ? '' : ' ');
  return joined.replace(/\s+/g, ' ').trim();
}

export function isLineLikePenMarkupBbox(bbox: NormBBox): boolean {
  return bbox[2] >= 0.035 && bbox[3] <= 0.035 && bbox[2] >= bbox[3] * 3.5;
}

export interface PhysicalPenLineMarkLike {
  tool?: string;
  origin?: string;
  feature_type?: string;
  scored_type?: string;
  bbox?: NormBBox;
}

export function correctedMarkedTextForPhysicalPenLine(mark: PhysicalPenLineMarkLike, blocks: OcrTextBlock[]): string {
  const tool = String(mark.tool || '').toLowerCase();
  const origin = String(mark.origin || '').toLowerCase();
  const physicalPen = tool === 'pen' || origin === 'pen';
  const aiPen = tool === 'aipen' || tool === 'ai_pen' || origin === 'aipen' || origin === 'ai_pen';
  const markupLike = mark.feature_type === 'markup' || mark.scored_type === 'underline' || mark.scored_type === 'circle';
  if (!physicalPen || aiPen || !markupLike || !mark.bbox || !isLineLikePenMarkupBbox(mark.bbox)) return '';
  return markedTextForPenLineBbox(blocks, mark.bbox);
}

function markedTextForPenLineBbox(blocks: OcrTextBlock[], bbox: NormBBox): string {
  const x0 = Math.max(0, bbox[0] - 0.01);
  const x1 = Math.min(1, bbox[0] + bbox[2] + 0.01);
  const strokeMidY = bbox[1] + bbox[3] / 2;
  const candidates = blocks
    .map((block, index) => {
      const lineH = Math.max(0.004, block.bbox[3]);
      const centerY = block.bbox[1] + block.bbox[3] / 2;
      const top = block.bbox[1];
      const bottom = block.bbox[1] + block.bbox[3];
      const aboveAllowance = lineH * 0.25;
      const belowAllowance = Math.max(0.008, lineH * 1.15);
      const hOverlap = horizontalOverlap(x0, x1, block.bbox);
      const vDistance = strokeMidY < top
        ? top - strokeMidY
        : strokeMidY > bottom
          ? strokeMidY - bottom
          : 0;
      const inLineBand = strokeMidY >= top - aboveAllowance && strokeMidY <= bottom + belowAllowance;
      return { block, index, centerY, lineH, vDistance, inLineBand, hOverlap };
    })
    .filter((item) => item.inLineBand && item.hOverlap > Math.max(0.002, item.block.bbox[2] * 0.02));
  if (!candidates.length) return '';
  const bestDistance = Math.min(...candidates.map((item) => item.vDistance));
  const bestCenterY = candidates
    .filter((item) => item.vDistance <= bestDistance + 0.0025)
    .sort((a, b) => Math.abs(a.centerY - strokeMidY) - Math.abs(b.centerY - strokeMidY))[0]?.centerY ?? strokeMidY;
  const sameLine = candidates
    .filter((item) =>
      item.vDistance <= bestDistance + 0.003
      && Math.abs(item.centerY - bestCenterY) <= Math.max(0.004, item.lineH * 0.7)
    )
    .sort((a, b) => (a.block.bbox[0] - b.block.bbox[0]) || (a.index - b.index));
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const item of sameLine) {
    const text = sliceBlockTextByX(item.block.text, item.block.bbox, x0, x1);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return joinedText(texts);
}

export function markedTextForPenMarkupBboxFromBlocks(blocks: OcrTextBlock[], bbox: NormBBox): string {
  if (isLineLikePenMarkupBbox(bbox)) {
    const lineText = markedTextForPenLineBbox(blocks, bbox);
    if (lineText) return lineText;
  }

  const x0 = Math.max(0, bbox[0] - 0.01);
  const x1 = Math.min(1, bbox[0] + bbox[2] + 0.01);
  const y0 = Math.max(0, bbox[1] - 0.014);
  const y1 = Math.min(1, bbox[1] + bbox[3] + 0.018);
  const expanded: NormBBox = [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
  const hits = blocks
    .map((block, index) => {
      const area = overlapArea(expanded, block.bbox);
      const hOverlap = horizontalOverlap(x0, x1, block.bbox);
      const centerY = block.bbox[1] + block.bbox[3] / 2;
      const centerHit = centerY >= y0 && centerY <= y1;
      return { block, index, area, hOverlap, centerHit };
    })
    .filter((item) =>
      item.hOverlap > Math.max(0.002, item.block.bbox[2] * 0.02)
      && (item.area > 0 || item.centerHit)
    )
    .sort((a, b) => (a.block.bbox[1] - b.block.bbox[1]) || (a.block.bbox[0] - b.block.bbox[0]) || (a.index - b.index));
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const item of hits.slice(0, 8)) {
    const text = sliceBlockTextByX(item.block.text, item.block.bbox, x0, x1);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return joinedText(texts);
}
