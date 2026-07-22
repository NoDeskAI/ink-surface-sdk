import { describe, expect, it } from 'vitest';
import { earliestPenDownAt, estimatePenDownAt } from './stroke-time';

describe('stroke pen-down time', () => {
  it('estimates a native drain pointerdown from the longest relative point time', () => {
    expect(estimatePenDownAt([{ t: 0 }, { t: 18 }, { t: 43 }], 10_000)).toBe(9_957);
  });

  it('ignores invalid relative times and treats an empty drain stroke as current time', () => {
    expect(estimatePenDownAt([{ t: Number.NaN }, { t: -5 }], 10_000)).toBe(10_000);
    expect(estimatePenDownAt([], 10_000)).toBe(10_000);
  });

  it('uses the earliest real pointerdown for a multi-stroke mark', () => {
    expect(earliestPenDownAt([{ penDownAt: 3_000 }, {}, { penDownAt: 1_000 }])).toBe(1_000);
    expect(earliestPenDownAt([{}, { penDownAt: Number.NaN }])).toBeUndefined();
  });
});
