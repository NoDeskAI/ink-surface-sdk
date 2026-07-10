import { describe, expect, it } from 'vitest';
import { shouldJoinContentPenStroke } from './mark-assembly';

describe('content pen mark assembly', () => {
  it('joins adjacent line-like strokes across neighboring text lines', () => {
    expect(shouldJoinContentPenStroke({
      region: [0.12, 0.20, 0.34, 0.012],
      bbox: [0.13, 0.275, 0.30, 0.011],
      pad: 0.06,
      gapMs: 420,
      quickMs: 2500,
      currentHasLineLike: true,
      nextIsLineLike: true,
    })).toBe(true);
  });

  it('does not use the line-merge fallback for slow independent strokes', () => {
    expect(shouldJoinContentPenStroke({
      region: [0.12, 0.20, 0.34, 0.012],
      bbox: [0.13, 0.275, 0.30, 0.011],
      pad: 0.06,
      gapMs: 3600,
      quickMs: 2500,
      currentHasLineLike: true,
      nextIsLineLike: true,
    })).toBe(false);
  });

  it('supports a wider line-mark window for adjacent physical pen underlines', () => {
    expect(shouldJoinContentPenStroke({
      region: [0.12, 0.20, 0.34, 0.012],
      bbox: [0.13, 0.275, 0.30, 0.011],
      pad: 0.06,
      gapMs: 3900,
      quickMs: 4500,
      currentHasLineLike: true,
      nextIsLineLike: true,
    })).toBe(true);
  });

  it('keeps freeform handwriting on the stricter center-based rule', () => {
    expect(shouldJoinContentPenStroke({
      region: [0.12, 0.20, 0.34, 0.012],
      bbox: [0.13, 0.275, 0.30, 0.011],
      pad: 0.06,
      gapMs: 420,
      quickMs: 2500,
      currentHasLineLike: false,
      nextIsLineLike: false,
    })).toBe(false);
  });
});
