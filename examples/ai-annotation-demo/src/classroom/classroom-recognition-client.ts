import { CLASSROOM_WORLD_GEOMETRY_VERSION, type ClassroomBoardEvent, type ClassroomMaterial, type ClassroomRecognitionRevision, type ClassroomSpatialRegion, type ClassroomSurfaceRef, type ClassroomWorldBBox, type RuntimeNormBBox } from 'ink-surface-sdk/runtime-schema';
import type { ClassroomClient } from './classroom-client';
import { activeBoardEvents, eventBBox, eventPoints, sameSurface, unionBoxes } from '../../shared/classroom/classroom-spatial';

export interface RecognitionStrokeGroup {
  event_ids: string[];
  surface: ClassroomSurfaceRef;
  bbox_norm?: RuntimeNormBBox;
  spatial_region?: ClassroomSpatialRegion;
}

const DEFAULT_TIME_WINDOW_MS = 15_000;
const MAX_GROUP_EVENTS = 24;
export const RECOGNITION_IDLE_DELAY_MS = 1_600;

export function remainingRecognitionIdleDelay(lastStrokeAtMs: number, nowMs: number, idleDelayMs = RECOGNITION_IDLE_DELAY_MS): number {
  return Math.max(0, idleDelayMs - Math.max(0, nowMs - lastStrokeAtMs));
}

function boxGap(a: ClassroomWorldBBox, b: ClassroomWorldBBox): { x: number; y: number } {
  return {
    x: Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2])),
    y: Math.max(0, Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3])),
  };
}

function sameFormulaLine(a: ClassroomWorldBBox, b: ClassroomWorldBBox): boolean {
  const gap = boxGap(a, b);
  return gap.x <= Math.max(80, Math.min(120, Math.max(a[2], b[2], a[3], b[3]) * 2.5))
    && gap.y <= Math.max(28, Math.min(52, Math.max(a[3], b[3]) * 1.5));
}

export function sameClassroomSurface(a: ClassroomSurfaceRef | undefined, b: ClassroomSurfaceRef | undefined): boolean {
  return sameSurface(a, b);
}

function unionBox(boxes: RuntimeNormBBox[], padding = 0.015): RuntimeNormBBox {
  const left = Math.max(0, Math.min(...boxes.map((box) => box[0])) - padding);
  const top = Math.max(0, Math.min(...boxes.map((box) => box[1])) - padding);
  const right = Math.min(1, Math.max(...boxes.map((box) => box[0] + box[2])) + padding);
  const bottom = Math.min(1, Math.max(...boxes.map((box) => box[1] + box[3])) + padding);
  return [left, top, right - left, bottom - top];
}

export function groupRecentFormulaEvents(
  events: readonly ClassroomBoardEvent[],
  options: { surface?: ClassroomSurfaceRef; timeWindowMs?: number; materials?: ClassroomMaterial[]; excludedEventIds?: ReadonlySet<string> } = {},
): RecognitionStrokeGroup | null {
  const onSurface = activeBoardEvents(events).filter((event) => event.event.metadata?.tool === 'pen'
    && (!options.surface || sameClassroomSurface(event.surface, options.surface))
    && !options.excludedEventIds?.has(event.event.event_id));
  const latest = onSurface.at(-1);
  if (!latest) return null;
  const windowMs = options.timeWindowMs ?? DEFAULT_TIME_WINDOW_MS;
  const material = options.materials?.find((item) => latest.surface?.kind === 'textbook_page' && item.material_id === latest.surface.material_id);
  const candidates: ClassroomBoardEvent[] = [latest];
  let nextStart = latest.event.ts_start_ms;
  for (let index = onSurface.length - 2; index >= 0 && candidates.length < MAX_GROUP_EVENTS; index -= 1) {
    const candidate = onSurface[index];
    if (!sameClassroomSurface(candidate.surface, latest.surface)) continue;
    if (nextStart - candidate.event.ts_end_ms > windowMs) break;
    candidates.unshift(candidate); nextStart = candidate.event.ts_start_ms;
  }
  const selectedIds = new Set([latest.event.event_id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (selectedIds.has(candidate.event.event_id)) continue;
      const candidateBox = eventBBox(candidate, material);
      if (!candidates.some((entry) => selectedIds.has(entry.event.event_id) && sameFormulaLine(candidateBox, eventBBox(entry, material)))) continue;
      selectedIds.add(candidate.event.event_id); changed = true;
    }
  }
  const selected = candidates.filter((event) => selectedIds.has(event.event.event_id));
  const bboxWorld = unionBoxes(selected.map((event) => eventBBox(event, material)), 8);
  return {
    event_ids: selected.map((event) => event.event.event_id),
    surface: latest.surface ?? { kind: 'teacher_board' },
    ...(latest.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION ? {} : { bbox_norm: unionBox(selected.map((event) => event.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION ? [0, 0, 1, 1] : event.event.bbox_norm)) }),
    spatial_region: { coordinate_space: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: latest.surface ?? { kind: 'teacher_board' }, bbox_world: bboxWorld },
  };
}

export function latestRecognitionProjection(revisions: readonly ClassroomRecognitionRevision[]): ClassroomRecognitionRevision[] {
  const latest = new Map<string, ClassroomRecognitionRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.recognition_id);
    if (!current || revision.revision > current.revision) latest.set(revision.recognition_id, revision);
  }
  return [...latest.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function recognitionTrustLabel(recognition: ClassroomRecognitionRevision): string {
  if (recognition.status === 'pending') return `待老师确认 · ${Math.round(recognition.confidence * 100)}%`;
  if (recognition.status === 'confirmed') return '老师已确认';
  if (recognition.status === 'corrected') return '老师已更正并确认';
  if (recognition.status === 'dismissed') return '老师已驳回';
  return '识别失败 · 可重试';
}

function comparableRecognitionText(value: string): string {
  return value.toLowerCase().replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[＋]/g, '+').replace(/[－−]/g, '-').replace(/[＝]/g, '=').replace(/\s+/g, '');
}

export function shouldShowRecognitionLatex(text: string, latex?: string): boolean {
  return !!latex?.trim() && comparableRecognitionText(text) !== comparableRecognitionText(latex);
}

export function renderRecognitionCrop(events: readonly ClassroomBoardEvent[], group: RecognitionStrokeGroup, documentApi: Document = document, materials: readonly ClassroomMaterial[] = []): string {
  const selected = new Set(group.event_ids);
  const strokes = events.filter((event) => selected.has(event.event.event_id));
  if (strokes.length !== selected.size) throw new Error('recognition_crop_source_missing');
  const canvas = documentApi.createElement('canvas'); canvas.width = 960; canvas.height = 240;
  const context = canvas.getContext('2d'); if (!context) throw new Error('recognition_crop_unavailable');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#111111'; context.lineWidth = 7; context.lineCap = 'round'; context.lineJoin = 'round';
  const [left, top, width, height]: ClassroomWorldBBox = group.spatial_region?.bbox_world ?? [0, 0, 1000, 625];
  const scaleX = (canvas.width - 48) / Math.max(width, 0.001); const scaleY = (canvas.height - 48) / Math.max(height, 0.001);
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (canvas.width - width * scale) / 2; const offsetY = (canvas.height - height * scale) / 2;
  for (const event of strokes) {
    context.beginPath();
    const material = materials.find((item) => event.surface?.kind === 'textbook_page' && item.material_id === event.surface.material_id);
    eventPoints(event, material).forEach((point, index) => {
      const x = offsetX + (point.x_world - left) * scale; const y = offsetY + (point.y_world - top) * scale;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  }
  return canvas.toDataURL('image/png');
}

export class ClassroomRecognitionClient {
  constructor(private readonly client: ClassroomClient, private readonly classroomId: string) {}

  list(): Promise<{ recognitions: ClassroomRecognitionRevision[] }> {
    return this.client.get(`/v1/classrooms/${this.classroomId}/recognitions`);
  }

  recognize(group: RecognitionStrokeGroup, processingMode: 'local' | 'external', imageDataUrl?: string): Promise<{ recognition: ClassroomRecognitionRevision }> {
    return this.client.post(`/v1/classrooms/${this.classroomId}/recognitions`, {
      client_request_id: `recognize_${crypto.randomUUID()}`, event_ids: group.event_ids, surface: group.surface,
      ...(group.bbox_norm ? { bbox_norm: group.bbox_norm } : {}), ...(group.spatial_region ? { spatial_region: group.spatial_region } : {}), processing_mode: processingMode, ...(imageDataUrl ? { image_data_url: imageDataUrl } : {}),
    });
  }

  review(recognitionId: string, input: { status: 'confirmed' | 'corrected' | 'dismissed'; text?: string; latex?: string }): Promise<{ recognition: ClassroomRecognitionRevision }> {
    return this.client.post(`/v1/classrooms/${this.classroomId}/recognitions/${recognitionId}/review`, input);
  }
}
