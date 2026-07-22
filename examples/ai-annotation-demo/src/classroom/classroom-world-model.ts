import { CLASSROOM_WORLD_COORDINATE_LIMIT, type ClassroomPageViewport, type ClassroomWorldBBox } from 'ink-surface-sdk/runtime-schema';

export interface ScreenPoint { x: number; y: number }
export interface WorldPoint { x: number; y: number }
export interface ViewportSize { width: number; height: number }
export type WorldModelResult<T> = { ok: true; value: T } | { ok: false; error: 'invalid_viewport' | 'invalid_page' | 'invalid_view' };

export const DEFAULT_WORLD_VIEW: ClassroomPageViewport = { center_x_world: 0, center_y_world: 0, zoom_scale: 1 };

export function clampViewport(view: ClassroomPageViewport): ClassroomPageViewport {
  const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
  return {
    center_x_world: Math.max(-CLASSROOM_WORLD_COORDINATE_LIMIT, Math.min(CLASSROOM_WORLD_COORDINATE_LIMIT, finite(view.center_x_world, 0))),
    center_y_world: Math.max(-CLASSROOM_WORLD_COORDINATE_LIMIT, Math.min(CLASSROOM_WORLD_COORDINATE_LIMIT, finite(view.center_y_world, 0))),
    zoom_scale: Math.max(0.5, Math.min(4, finite(view.zoom_scale, 1))),
  };
}

export function screenToWorld(point: ScreenPoint, size: ViewportSize, view: ClassroomPageViewport): WorldPoint {
  return { x: view.center_x_world + (point.x - size.width / 2) / view.zoom_scale, y: view.center_y_world + (point.y - size.height / 2) / view.zoom_scale };
}

export function safeScreenToWorld(point: ScreenPoint, size: ViewportSize, view: ClassroomPageViewport): WorldModelResult<WorldPoint> {
  if (!(size.width > 0 && size.height > 0) || ![size.width, size.height, point.x, point.y].every(Number.isFinite)) return { ok: false, error: 'invalid_viewport' };
  if (![view.center_x_world, view.center_y_world, view.zoom_scale].every(Number.isFinite) || view.zoom_scale <= 0) return { ok: false, error: 'invalid_view' };
  return { ok: true, value: screenToWorld(point, size, view) };
}

export function worldToScreen(point: WorldPoint, size: ViewportSize, view: ClassroomPageViewport): ScreenPoint {
  return { x: size.width / 2 + (point.x - view.center_x_world) * view.zoom_scale, y: size.height / 2 + (point.y - view.center_y_world) * view.zoom_scale };
}

export function panViewport(view: ClassroomPageViewport, screenDx: number, screenDy: number): ClassroomPageViewport {
  return clampViewport({ ...view, center_x_world: view.center_x_world - screenDx / view.zoom_scale, center_y_world: view.center_y_world - screenDy / view.zoom_scale });
}

export function zoomViewportAt(view: ClassroomPageViewport, size: ViewportSize, anchor: ScreenPoint, nextZoom: number): ClassroomPageViewport {
  const before = screenToWorld(anchor, size, view);
  const zoomed = clampViewport({ ...view, zoom_scale: nextZoom });
  return clampViewport({
    ...zoomed,
    center_x_world: before.x - (anchor.x - size.width / 2) / zoomed.zoom_scale,
    center_y_world: before.y - (anchor.y - size.height / 2) / zoomed.zoom_scale,
  });
}

export function fitPageViewport(pageWidth: number, pageHeight: number, size: ViewportSize, padding = 48): ClassroomPageViewport {
  if (!(pageWidth > 0 && pageHeight > 0 && size.width > 0 && size.height > 0)) return DEFAULT_WORLD_VIEW;
  return clampViewport({ center_x_world: 0, center_y_world: 0, zoom_scale: Math.min((size.width - padding * 2) / pageWidth, (size.height - padding * 2) / pageHeight) });
}

export function fitPageWidthViewport(pageWidth: number, pageHeight: number, size: ViewportSize, padding = 12): ClassroomPageViewport {
  if (!(pageWidth > 0 && pageHeight > 0 && size.width > padding * 2 && size.height > 0)) return DEFAULT_WORLD_VIEW;
  const zoomScale = (size.width - padding * 2) / pageWidth;
  return clampViewport({
    center_x_world: 0,
    center_y_world: -pageHeight / 2 + (size.height / 2 - padding) / zoomScale,
    zoom_scale: zoomScale,
  });
}

export function safeFitPageViewport(pageWidth: number, pageHeight: number, size: ViewportSize, padding = 48): WorldModelResult<ClassroomPageViewport> {
  if (![pageWidth, pageHeight].every(Number.isFinite) || pageWidth <= 0 || pageHeight <= 0) return { ok: false, error: 'invalid_page' };
  if (![size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) return { ok: false, error: 'invalid_viewport' };
  return { ok: true, value: fitPageViewport(pageWidth, pageHeight, size, padding) };
}

export function visibleWorldRect(view: ClassroomPageViewport, size: ViewportSize, overscanScreens = 0): ClassroomWorldBBox {
  const width = size.width / view.zoom_scale; const height = size.height / view.zoom_scale;
  return [view.center_x_world - width * (0.5 + overscanScreens), view.center_y_world - height * (0.5 + overscanScreens), width * (1 + overscanScreens * 2), height * (1 + overscanScreens * 2)];
}

export function gridSpacing(zoom: number): { minor: number; major: number } {
  const target = 28 / Math.max(zoom, 0.001);
  const power = 10 ** Math.floor(Math.log10(target));
  const normalized = target / power;
  const step = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const minor = step * power;
  return { minor, major: minor * 5 };
}

export function pageViewportKey(materialId: string, pageIndex: number): string { return `${materialId}:${pageIndex}`; }

export function fitWorldRegionViewport(region: ClassroomWorldBBox, size: ViewportSize, padding = 72): ClassroomPageViewport {
  if (!(region[2] > 0 && region[3] > 0 && size.width > padding * 2 && size.height > padding * 2)) return DEFAULT_WORLD_VIEW;
  return clampViewport({
    center_x_world: region[0] + region[2] / 2,
    center_y_world: region[1] + region[3] / 2,
    zoom_scale: Math.min((size.width - padding * 2) / region[2], (size.height - padding * 2) / region[3]),
  });
}

export function worldToCssMatrix(view: ClassroomPageViewport, size: ViewportSize): string {
  const x = size.width / 2 - view.center_x_world * view.zoom_scale;
  const y = size.height / 2 - view.center_y_world * view.zoom_scale;
  return `matrix(${view.zoom_scale}, 0, 0, ${view.zoom_scale}, ${x}, ${y})`;
}
