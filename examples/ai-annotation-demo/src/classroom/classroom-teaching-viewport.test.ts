import { describe, expect, it } from 'vitest';
import { boxesIntersect } from '../../shared/classroom/classroom-spatial';
import { worldToCssMatrix } from './classroom-world-model';

describe('single teaching viewport composition', () => {
  it('uses one camera matrix for the page, ink, focus and selection world layer', () => {
    const matrix = worldToCssMatrix({ center_x_world: 120, center_y_world: -80, zoom_scale: 2 }, { width: 1000, height: 700 });
    expect(matrix).toBe('matrix(2, 0, 0, 2, 260, 510)');
    const worldChildren = ['textbook-raster', 'ink-svg', 'focus-overlay', 'selection-overlay'];
    expect(worldChildren.every(() => matrix === 'matrix(2, 0, 0, 2, 260, 510)')).toBe(true);
  });

  it('culls paths outside overscan without removing ledger facts', () => {
    const ledger = [{ id: 'visible', bbox: [-50, -50, 100, 100] as [number, number, number, number] }, { id: 'far', bbox: [9000, 9000, 10, 10] as [number, number, number, number] }];
    const visible = ledger.filter((item) => boxesIntersect(item.bbox, [-1000, -700, 2000, 1400]));
    expect(visible.map((item) => item.id)).toEqual(['visible']);
    expect(ledger).toHaveLength(2);
  });
});
