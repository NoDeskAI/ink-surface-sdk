import { describe, expect, it } from 'vitest';
import { markTime } from './mark-time';

describe('markTime', () => {
  it('prefers pen_down_at and falls back to abs_timestamp for old marks', () => {
    expect(markTime({ pen_down_at: 1_000, abs_timestamp: 9_000 })).toBe(1_000);
    expect(markTime({ abs_timestamp: 9_000 })).toBe(9_000);
  });
});
