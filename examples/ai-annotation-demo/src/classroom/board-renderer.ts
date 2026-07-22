import type { ClassroomBoardEvent, ClassroomMaterial, ClassroomPreview, ClassroomSurfaceRef, ClassroomWorldPoint, InkLoopStrokePoint } from 'ink-surface-sdk/runtime-schema';
import { activeBoardEvents, boxesIntersect, eventBBox, eventPoints, surfaceKey, unionBoxes } from '../../shared/classroom/classroom-spatial';

export function normalizedPoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): { x_norm: number; y_norm: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x_norm: 0, y_norm: 0 };
  return {
    x_norm: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y_norm: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}

export function strokePath(points: readonly InkLoopStrokePoint[], width: number, height: number): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${Math.round(point.x_norm * width * 100) / 100} ${Math.round(point.y_norm * height * 100) / 100}`).join(' ');
}

export function unionSourceBoxes(boxes: readonly [number, number, number, number][], padding = 8): [number, number, number, number] | undefined {
  return boxes.length ? unionBoxes(boxes, padding) : undefined;
}

export class BoardModel {
  readonly events: ClassroomBoardEvent[] = [];
  readonly previews = new Map<string, Pick<ClassroomPreview, 'client_event_id' | 'revision'> & Partial<ClassroomPreview>>();
  private readonly pendingEvents = new Map<number, ClassroomBoardEvent>();
  sequence = 0;

  applyPreview(preview: Pick<ClassroomPreview, 'client_event_id' | 'revision'> & Partial<ClassroomPreview>): boolean {
    const current = this.previews.get(preview.client_event_id);
    if (current && preview.revision < current.revision) return false;
    this.previews.set(preview.client_event_id, preview);
    return true;
  }

  applyBoardEvent(event: Pick<ClassroomBoardEvent, 'sequence' | 'client_event_id'> & Partial<ClassroomBoardEvent>): 'applied' | 'duplicate' | 'gap' {
    if (event.sequence <= this.sequence) return 'duplicate';
    this.pendingEvents.set(event.sequence, event as ClassroomBoardEvent);
    if (event.sequence !== this.sequence + 1) return 'gap';
    while (this.pendingEvents.has(this.sequence + 1)) {
      const next = this.pendingEvents.get(this.sequence + 1)!;
      this.pendingEvents.delete(next.sequence); this.sequence = next.sequence;
      this.previews.delete(next.client_event_id); this.events.push(next);
    }
    return 'applied';
  }

  replaceSnapshot(events: ClassroomBoardEvent[]): void {
    this.events.splice(0, this.events.length, ...events);
    this.sequence = events.at(-1)?.sequence ?? 0;
    this.pendingEvents.clear();
    this.previews.clear();
  }
}

function worldStrokePath(points: readonly ClassroomWorldPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${Math.round(point.x_world * 100) / 100} ${Math.round(point.y_world * 100) / 100}`).join(' ');
}

function svgPath(points: readonly ClassroomWorldPoint[], color: string, tool: string, surface?: ClassroomSurfaceRef): SVGPathElement {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', worldStrokePath(points));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', tool === 'eraser' ? '#923b35' : color);
  path.setAttribute('stroke-width', tool === 'eraser' ? '24' : tool === 'highlighter' ? '18' : '3');
  path.setAttribute('stroke-opacity', tool === 'eraser' ? '0.25' : tool === 'highlighter' ? '0.35' : '1');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  path.dataset.surface = surfaceKey(surface);
  return path;
}

export class ClassroomBoardRenderer {
  readonly model = new BoardModel();
  private readonly committed: SVGGElement;
  private readonly preview: SVGGElement;
  private readonly sourceAnchors: SVGGElement;
  private readonly previewPaths = new Map<string, SVGPathElement>();
  private readonly committedPaths = new Map<string, SVGPathElement>();
  private readonly previewTimers = new Map<string, number>();
  private activeSurface?: ClassroomSurfaceRef;
  private materials: ClassroomMaterial[] = [];
  private visibleRect?: [number, number, number, number];
  private readonly maxVisiblePaths = 3_000;

  constructor(readonly svg: SVGSVGElement) {
    svg.removeAttribute('viewBox');
    svg.setAttribute('overflow', 'visible');
    this.committed = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.preview = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.preview.setAttribute('opacity', '0.7');
    this.sourceAnchors = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.sourceAnchors.classList.add('source-anchors');
    svg.append(this.committed, this.preview, this.sourceAnchors);
  }

  renderSnapshot(events: ClassroomBoardEvent[]): void {
    this.model.replaceSnapshot(events);
    this.committedPaths.clear();
    for (const entry of activeBoardEvents(events)) this.committedPaths.set(entry.event.event_id, svgPath(this.pointsFor(entry), entry.event.metadata?.color || '#1a1a1a', entry.event.metadata?.tool || 'pen', entry.surface));
    this.committed.replaceChildren();
    this.preview.replaceChildren();
    this.previewPaths.clear();
    for (const timer of this.previewTimers.values()) window.clearTimeout(timer);
    this.previewTimers.clear();
    this.updateSurfaceVisibility();
  }

  renderEvent(event: ClassroomBoardEvent): 'applied' | 'duplicate' | 'gap' {
    const status = this.model.applyBoardEvent(event);
    if (status === 'applied') {
      const committedClientIds = new Set(this.model.events.map((entry) => entry.client_event_id));
      for (const clientEventId of committedClientIds) {
        this.previewPaths.get(clientEventId)?.remove(); this.previewPaths.delete(clientEventId);
        const timer = this.previewTimers.get(clientEventId); if (timer !== undefined) window.clearTimeout(timer);
        this.previewTimers.delete(clientEventId);
      }
      this.committedPaths.clear();
      for (const entry of activeBoardEvents(this.model.events)) this.committedPaths.set(entry.event.event_id, svgPath(this.pointsFor(entry), entry.event.metadata?.color || '#1a1a1a', entry.event.metadata?.tool || 'pen', entry.surface));
      this.updateSurfaceVisibility();
      this.svg.dispatchEvent(new CustomEvent('inkloop:classroom-render', { detail: {
        sequence: event.sequence, event_id: event.event.event_id,
        teacher_sample_timestamp_ms: event.event.ts_start_ms,
        render_commit_timestamp_ms: Date.now(),
      } }));
    }
    return status;
  }

  renderPreview(entry: ClassroomPreview): void {
    if (!this.model.applyPreview(entry)) return;
    this.previewPaths.get(entry.client_event_id)?.remove();
    const previousTimer = this.previewTimers.get(entry.client_event_id);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const points = entry.geometry_version === 'classroom_page_world_v1'
      ? entry.points_world
      : entry.points.map((point) => ({ x_world: (point.x_norm - 0.5) * 1000, y_world: (point.y_norm - 0.5) * 625, t_ms: point.t_ms, ...(point.pressure === undefined ? {} : { pressure: point.pressure }) }));
    const path = svgPath(points, entry.color || '#1a1a1a', entry.tool, entry.surface);
    path.dataset.previewId = entry.client_event_id;
    this.preview.append(path);
    this.previewPaths.set(entry.client_event_id, path);
    const revision = entry.revision;
    this.previewTimers.set(entry.client_event_id, window.setTimeout(() => {
      if (this.model.previews.get(entry.client_event_id)?.revision !== revision) return;
      this.clearPreview(entry.client_event_id);
    }, Math.max(0, entry.expires_at_ms - Date.now())));
    this.updateSurfaceVisibility();
  }

  setSurface(surface?: ClassroomSurfaceRef): void {
    this.activeSurface = surface;
    this.updateSurfaceVisibility();
  }

  setMaterials(materials: readonly ClassroomMaterial[]): void { this.materials = [...materials]; this.updateSurfaceVisibility(); }

  setVisibleWorldRect(rect?: [number, number, number, number]): void { this.visibleRect = rect; this.updateSurfaceVisibility(); }

  private pointsFor(event: ClassroomBoardEvent): ClassroomWorldPoint[] {
    const materialId = event.surface?.kind === 'textbook_page' ? event.surface.material_id : event.surface?.kind === 'scratch' ? event.surface.linked_material_id : undefined;
    return eventPoints(event, this.materials.find((item) => item.material_id === materialId));
  }

  private updateSurfaceVisibility(): void {
    const active = surfaceKey(this.activeSurface);
    const visiblePaths: SVGPathElement[] = [];
    for (const event of this.model.events) {
      if (surfaceKey(event.surface) !== active) continue;
      const materialId = event?.surface?.kind === 'textbook_page' ? event.surface.material_id : event?.surface?.kind === 'scratch' ? event.surface.linked_material_id : undefined;
      const material = this.materials.find((item) => item.material_id === materialId);
      if (this.visibleRect && !boxesIntersect(eventBBox(event, material), this.visibleRect)) continue;
      const path = this.committedPaths.get(event.event.event_id); if (path) visiblePaths.push(path);
      if (visiblePaths.length >= this.maxVisiblePaths) break;
    }
    this.committed.replaceChildren(...visiblePaths);
    this.svg.dataset.ledgerPaths = String(this.committedPaths.size);
    this.svg.dataset.ledgerDigest = this.model.events.map((event) => `${event.sequence}:${event.event.event_id}`).join('|');
    this.svg.dataset.visiblePaths = String(visiblePaths.length);
    this.svg.dataset.visiblePathLimitReached = String(visiblePaths.length >= this.maxVisiblePaths);
    for (const child of this.preview.children) {
      const path = child as SVGPathElement;
      path.style.display = path.dataset.surface === active ? '' : 'none';
    }
  }

  clearPreview(clientEventId: string): void {
    this.model.previews.delete(clientEventId);
    this.previewPaths.get(clientEventId)?.remove();
    this.previewPaths.delete(clientEventId);
    const timer = this.previewTimers.get(clientEventId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.previewTimers.delete(clientEventId);
  }

  focusSource(eventId: string): boolean {
    const path = this.committedPaths.get(eventId);
    if (!path) return false;
    path.classList.remove('source-focus');
    requestAnimationFrame(() => path.classList.add('source-focus'));
    window.setTimeout(() => path.classList.remove('source-focus'), 2_000);
    return true;
  }

  focusSources(eventIds: readonly string[]): number {
    let focused = 0;
    for (const eventId of eventIds) if (this.focusSource(eventId)) focused += 1;
    return focused;
  }

  showSourceAnchor(eventIds: readonly string[], durationMs = 2_400): boolean {
    const bbox = this.sourceWorldBBoxForEvents(eventIds);
    if (!bbox) return false;
    const [x, y, width, height] = bbox;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.classList.add('source-anchor');
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(width)); rect.setAttribute('height', String(height));
    rect.setAttribute('rx', '3'); rect.setAttribute('ry', '3');
    this.sourceAnchors.replaceChildren(rect);
    window.setTimeout(() => { if (rect.isConnected) rect.remove(); }, durationMs);
    return true;
  }

  sourceEvent(eventId: string): ClassroomBoardEvent | undefined { return this.model.events.find((entry) => entry.event.event_id === eventId); }

  sourceWorldBBox(eventId: string): [number, number, number, number] | undefined {
    const event = this.sourceEvent(eventId); if (!event) return undefined;
    const materialId = event.surface?.kind === 'textbook_page' ? event.surface.material_id : event.surface?.kind === 'scratch' ? event.surface.linked_material_id : undefined;
    return eventBBox(event, this.materials.find((item) => item.material_id === materialId));
  }

  sourceWorldBBoxForEvents(eventIds: readonly string[], padding = 8): [number, number, number, number] | undefined {
    const boxes = eventIds.map((eventId) => this.sourceWorldBBox(eventId)).filter((box): box is [number, number, number, number] => !!box);
    return unionSourceBoxes(boxes, padding);
  }

  activeEvents(): ClassroomBoardEvent[] { return activeBoardEvents(this.model.events); }
}
