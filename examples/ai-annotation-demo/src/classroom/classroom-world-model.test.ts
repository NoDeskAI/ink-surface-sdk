import { describe, expect, it } from 'vitest';
import { fitPageViewport, fitPageWidthViewport, fitWorldRegionViewport, gridSpacing, pageViewportKey, panViewport, safeFitPageViewport, safeScreenToWorld, screenToWorld, visibleWorldRect, worldToCssMatrix, worldToScreen, zoomViewportAt } from './classroom-world-model';

describe('classroom world model', () => {
  it('round trips screen and world points independently of device pixel ratio', () => {
    const size = { width: 1200, height: 800 }; const view = { center_x_world: 40, center_y_world: -20, zoom_scale: 1.5 };
    const screen = { x: 835, y: 122 }; const world = screenToWorld(screen, size, view);
    expect(worldToScreen(world, size, view)).toEqual(screen);
  });

  it('pans in world units and zooms without moving the anchor', () => {
    const size = { width: 1000, height: 600 }; const view = { center_x_world: 0, center_y_world: 0, zoom_scale: 1 };
    expect(panViewport(view, 100, -50)).toMatchObject({ center_x_world: -100, center_y_world: 50 });
    const anchor = { x: 800, y: 200 }; const before = screenToWorld(anchor, size, view);
    const zoomed = zoomViewportAt(view, size, anchor, 4);
    expect(screenToWorld(anchor, size, zoomed)).toEqual(before);
    expect(zoomViewportAt(view, size, anchor, 9).zoom_scale).toBe(4);
    expect(zoomViewportAt(view, size, anchor, 0.01).zoom_scale).toBe(0.5);
    expect(panViewport({ ...view, zoom_scale: 0.5 }, 100, 0).center_x_world).toBe(-200);
    expect(panViewport({ ...view, zoom_scale: 2 }, 100, 0).center_x_world).toBe(-50);
  });

  it('fits a page, exposes an overscan rect, and selects stable grid levels', () => {
    expect(fitPageViewport(600, 800, { width: 1200, height: 900 }, 50).zoom_scale).toBe(1);
    expect(visibleWorldRect({ center_x_world: 0, center_y_world: 0, zoom_scale: 2 }, { width: 1000, height: 600 }, 1)).toEqual([-750, -450, 1500, 900]);
    expect(gridSpacing(1)).toEqual({ minor: 50, major: 250 });
    expect(gridSpacing(4).minor).toBe(10);
    expect(pageViewportKey('material_1', 2)).toBe('material_1:2');
  });

  it('fits a page to width and anchors its top-left corner to the viewport padding', () => {
    const size = { width: 900, height: 700 };
    const view = fitPageWidthViewport(600, 900, size, 12);
    expect(view.zoom_scale).toBeCloseTo(1.46);
    expect(worldToScreen({ x: -300, y: -450 }, size, view).x).toBeCloseTo(12);
    expect(worldToScreen({ x: -300, y: -450 }, size, view).y).toBeCloseTo(12);
  });

  it('keeps center and zoom stable across resize and gives each page an independent key', () => {
    const view = { center_x_world: 84, center_y_world: -31, zoom_scale: 1.75 };
    expect(screenToWorld({ x: 600, y: 400 }, { width: 1200, height: 800 }, view)).toEqual({ x: 84, y: -31 });
    expect(screenToWorld({ x: 410, y: 560 }, { width: 820, height: 1120 }, view)).toEqual({ x: 84, y: -31 });
    const pages = new Map([[pageViewportKey('book', 0), view], [pageViewportKey('book', 1), { ...view, center_x_world: 900 }]]);
    expect(pages.get('book:0')?.center_x_world).toBe(84);
    expect(pages.get('book:1')?.center_x_world).toBe(900);
    expect(worldToCssMatrix(view, { width: 1200, height: 800 })).toBe('matrix(1.75, 0, 0, 1.75, 453, 454.25)');
  });

  it('returns explicit non-renderable results for invalid dimensions and finite inputs', () => {
    expect(safeFitPageViewport(0, 800, { width: 1200, height: 800 })).toEqual({ ok: false, error: 'invalid_page' });
    expect(safeFitPageViewport(600, 800, { width: 0, height: 800 })).toEqual({ ok: false, error: 'invalid_viewport' });
    expect(safeScreenToWorld({ x: Number.NaN, y: 2 }, { width: 100, height: 100 }, { center_x_world: 0, center_y_world: 0, zoom_scale: 1 })).toEqual({ ok: false, error: 'invalid_viewport' });
    expect(safeScreenToWorld({ x: 2, y: 2 }, { width: 100, height: 100 }, { center_x_world: 0, center_y_world: 0, zoom_scale: Number.NaN })).toEqual({ ok: false, error: 'invalid_view' });
  });

  it('fits a source region with padding and preserves its world center', () => {
    expect(fitWorldRegionViewport([800, -200, 200, 100], { width: 1000, height: 600 }, 100)).toEqual({ center_x_world: 900, center_y_world: -150, zoom_scale: 4 });
  });
});
