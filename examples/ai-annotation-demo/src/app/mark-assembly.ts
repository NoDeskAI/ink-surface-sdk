import type { NormBBox } from '../core/contracts';

function intervalGap(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 < b0) return b0 - a1;
  if (b1 < a0) return a0 - b1;
  return 0;
}

export function bboxCenterInExpandedRegion(region: NormBBox, bbox: NormBBox, pad: number): boolean {
  const cx = bbox[0] + bbox[2] / 2;
  const cy = bbox[1] + bbox[3] / 2;
  return cx >= region[0] - pad && cx <= region[0] + region[2] + pad
    && cy >= region[1] - pad && cy <= region[1] + region[3] + pad;
}

function bboxEdgeGapNear(region: NormBBox, bbox: NormBBox, pad: number): boolean {
  const xGap = intervalGap(region[0], region[0] + region[2], bbox[0], bbox[0] + bbox[2]);
  const yGap = intervalGap(region[1], region[1] + region[3], bbox[1], bbox[1] + bbox[3]);
  return xGap <= pad && yGap <= pad;
}

export function shouldJoinContentPenStroke(input: {
  region: NormBBox;
  bbox: NormBBox;
  pad: number;
  gapMs: number;
  quickMs: number;
  currentHasLineLike: boolean;
  nextIsLineLike: boolean;
}): boolean {
  if (bboxCenterInExpandedRegion(input.region, input.bbox, input.pad)) return true;
  if (!input.currentHasLineLike || !input.nextIsLineLike || input.gapMs > input.quickMs) return false;
  return bboxEdgeGapNear(input.region, input.bbox, Math.max(input.pad, 0.09));
}
