import {
  CLASSROOM_WORLD_GEOMETRY_VERSION,
  type ClassroomBoardEvent,
  type ClassroomMaterial,
  type ClassroomPageGeometry,
  type ClassroomSpatialRegion,
  type ClassroomSurfaceRef,
  type ClassroomWorldBBox,
  type ClassroomWorldPoint,
  type RuntimeNormBBox,
} from 'ink-surface-sdk/runtime-schema';

export function surfaceKey(surface?: ClassroomSurfaceRef): string {
  if (!surface || surface.kind === 'teacher_board') return 'teacher_board';
  if (surface.kind === 'textbook_page') return `textbook_page:${surface.material_id}:${surface.page_index}`;
  return `scratch:${surface.scratch_id}`;
}

export function sameSurface(a?: ClassroomSurfaceRef, b?: ClassroomSurfaceRef): boolean {
  return surfaceKey(a) === surfaceKey(b);
}

export function pageGeometry(material: ClassroomMaterial | undefined, pageIndex: number): ClassroomPageGeometry | undefined {
  return material?.page_geometries?.find((item) => item.page_index === pageIndex);
}

export function pageWorldBox(geometry: Pick<ClassroomPageGeometry, 'width_world' | 'height_world'>): ClassroomWorldBBox {
  return [-geometry.width_world / 2, -geometry.height_world / 2, geometry.width_world, geometry.height_world];
}

export function normPointToWorld(point: { x_norm: number; y_norm: number; t_ms: number; pressure?: number }, geometry: Pick<ClassroomPageGeometry, 'width_world' | 'height_world'>): ClassroomWorldPoint {
  return {
    x_world: (point.x_norm - 0.5) * geometry.width_world,
    y_world: (point.y_norm - 0.5) * geometry.height_world,
    t_ms: point.t_ms,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  };
}

export function normBoxToWorld(box: RuntimeNormBBox, geometry: Pick<ClassroomPageGeometry, 'width_world' | 'height_world'>): ClassroomWorldBBox {
  return [(box[0] - 0.5) * geometry.width_world, (box[1] - 0.5) * geometry.height_world, box[2] * geometry.width_world, box[3] * geometry.height_world];
}

export function worldBoxToNorm(box: ClassroomWorldBBox, geometry: Pick<ClassroomPageGeometry, 'width_world' | 'height_world'>): RuntimeNormBBox | undefined {
  const page = pageWorldBox(geometry);
  const hit = intersectBoxes(box, page);
  if (!hit) return undefined;
  return [
    (hit[0] - page[0]) / page[2],
    (hit[1] - page[1]) / page[3],
    hit[2] / page[2],
    hit[3] / page[3],
  ];
}

export function eventBBox(event: ClassroomBoardEvent, material?: ClassroomMaterial): ClassroomWorldBBox {
  if (event.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION) return event.stroke.bbox_world;
  const surface = event.surface;
  if (surface?.kind === 'textbook_page') {
    const geometry = pageGeometry(material, surface.page_index);
    if (geometry) return normBoxToWorld(event.stroke.bbox_norm, geometry);
  }
  if (surface?.kind === 'scratch') {
    const geometry = surface.linked_page_index === undefined ? undefined : pageGeometry(material, surface.linked_page_index);
    if (geometry) {
      const legacyWidth = geometry.width_world;
      const legacyHeight = geometry.height_world;
      return [geometry.width_world / 2 + 80 + event.stroke.bbox_norm[0] * legacyWidth, -geometry.height_world / 2 + event.stroke.bbox_norm[1] * legacyHeight, event.stroke.bbox_norm[2] * legacyWidth, event.stroke.bbox_norm[3] * legacyHeight];
    }
  }
  return [(event.stroke.bbox_norm[0] - 0.5) * 1000, (event.stroke.bbox_norm[1] - 0.5) * 625, event.stroke.bbox_norm[2] * 1000, event.stroke.bbox_norm[3] * 625];
}

export function eventPoints(event: ClassroomBoardEvent, material?: ClassroomMaterial): ClassroomWorldPoint[] {
  if (event.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION) return event.stroke.points_world;
  const surface = event.surface;
  if (surface?.kind === 'textbook_page') {
    const geometry = pageGeometry(material, surface.page_index);
    if (geometry) return event.stroke.points.map((point) => normPointToWorld(point, geometry));
  }
  const bbox = eventBBox(event, material);
  const norm = event.stroke.bbox_norm;
  return event.stroke.points.map((point) => ({
    x_world: bbox[0] + ((point.x_norm - norm[0]) / Math.max(norm[2], 0.000001)) * bbox[2],
    y_world: bbox[1] + ((point.y_norm - norm[1]) / Math.max(norm[3], 0.000001)) * bbox[3],
    t_ms: point.t_ms,
    ...(point.pressure === undefined ? {} : { pressure: point.pressure }),
  }));
}

export function eventRegion(event: ClassroomBoardEvent, material?: ClassroomMaterial): ClassroomSpatialRegion {
  return { coordinate_space: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: event.surface ?? { kind: 'teacher_board' }, bbox_world: eventBBox(event, material) };
}

export function intersectBoxes(a: ClassroomWorldBBox, b: ClassroomWorldBBox): ClassroomWorldBBox | undefined {
  const left = Math.max(a[0], b[0]); const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]); const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return right < left || bottom < top ? undefined : [left, top, right - left, bottom - top];
}

export function boxesIntersect(a: ClassroomWorldBBox, b: ClassroomWorldBBox): boolean {
  return intersectBoxes(a, b) !== undefined;
}

export function activeBoardEvents(events: readonly ClassroomBoardEvent[]): ClassroomBoardEvent[] {
  const erased = new Set<string>();
  for (const event of events) {
    if (event.event.event_type !== 'erase') continue;
    for (const id of event.event.metadata?.erased_event_ids ?? []) erased.add(id);
  }
  return events.filter((event) => event.event.event_type === 'stroke' && !erased.has(event.event.event_id));
}

export function unionBoxes(boxes: readonly ClassroomWorldBBox[], padding = 0): ClassroomWorldBBox {
  const left = Math.min(...boxes.map((box) => box[0])) - padding;
  const top = Math.min(...boxes.map((box) => box[1])) - padding;
  const right = Math.max(...boxes.map((box) => box[0] + box[2])) + padding;
  const bottom = Math.max(...boxes.map((box) => box[1] + box[3])) + padding;
  return [left, top, right - left, bottom - top];
}

export function canonicalRegion(region: ClassroomSpatialRegion): string {
  return `${surfaceKey(region.surface)}:${region.bbox_world.map((value) => Math.round(value * 1000) / 1000).join(',')}`;
}

/**
 * Projects a world/legacy event into a request-local 0–1 box. This is only for
 * bounded recognition/AI provider payloads; it never becomes persisted event
 * geometry.
 */
export function eventBoxInRegion(event: ClassroomBoardEvent, region: ClassroomWorldBBox, material?: ClassroomMaterial): RuntimeNormBBox {
  const box = eventBBox(event, material);
  return [
    (box[0] - region[0]) / Math.max(region[2], 0.000001),
    (box[1] - region[1]) / Math.max(region[3], 0.000001),
    box[2] / Math.max(region[2], 0.000001),
    box[3] / Math.max(region[3], 0.000001),
  ];
}

export function eventPointsInRegion(event: ClassroomBoardEvent, region: ClassroomWorldBBox, material?: ClassroomMaterial): Array<{ x_norm: number; y_norm: number; t_ms: number }> {
  return eventPoints(event, material).map((point) => ({
    x_norm: (point.x_world - region[0]) / Math.max(region[2], 0.000001),
    y_norm: (point.y_world - region[1]) / Math.max(region[3], 0.000001),
    t_ms: point.t_ms,
  }));
}
