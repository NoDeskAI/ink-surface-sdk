import { describe, expect, it } from 'vitest';
import { isEpochMs, markTime } from './mark-time';

describe('markTime', () => {
  it('prefers pen_down_at and falls back to abs_timestamp for old marks', () => {
    const penDown = 1_751_500_000_123;
    const fallback = 1_751_500_009_000;
    expect(markTime({ pen_down_at: penDown, abs_timestamp: fallback })).toBe(penDown);
    expect(markTime({ abs_timestamp: fallback })).toBe(fallback);
  });

  it('rejects NaN, zero, seconds and implausible future values', () => {
    const valid = Date.now() - 1_000;
    expect(isEpochMs(valid)).toBe(true);
    expect(markTime({ pen_down_at: Number.NaN, abs_timestamp: valid })).toBe(valid);
    expect(markTime({ pen_down_at: 1_751_500_000, abs_timestamp: 0 })).toBe(0);
    expect(isEpochMs(Date.now() + 24 * 60 * 60_000 + 1)).toBe(false);
  });
});
