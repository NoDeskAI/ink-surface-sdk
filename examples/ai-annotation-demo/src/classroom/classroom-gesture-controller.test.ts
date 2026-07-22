import { describe, expect, it } from 'vitest';
import { normalizedWheelDelta, pinchDelta } from './classroom-gesture-controller';

describe('classroom gesture arbitration math', () => {
  it('normalizes wheel delta modes without user-agent branches', () => {
    expect(normalizedWheelDelta({ deltaY: 2, deltaMode: 0 })).toBe(2);
    expect(normalizedWheelDelta({ deltaY: 2, deltaMode: 1 })).toBe(32);
    expect(normalizedWheelDelta({ deltaY: 2, deltaMode: 2 }, 600)).toBe(1200);
  });

  it('derives simultaneous midpoint pan and anchored pinch zoom', () => {
    expect(pinchDelta(
      [{ x: 100, y: 100, type: 'touch' }, { x: 200, y: 100, type: 'touch' }],
      [{ x: 90, y: 120, type: 'touch' }, { x: 230, y: 120, type: 'touch' }],
    )).toEqual({ dx: 10, dy: 20, factor: 1.4, anchor_x: 160, anchor_y: 120 });
  });
});
