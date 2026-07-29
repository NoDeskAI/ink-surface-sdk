import type {
  RuntimeAnnotation,
  RuntimeSyncEvent,
  RuntimeVisualStroke,
} from 'ink-surface-sdk/runtime-schema';

export type LiveBoardInkStroke = {
  id: string;
  path: string;
  color: string;
  opacity: number;
  width: number;
  pageIndex: number;
};

type AnnotationRecord = RuntimeAnnotation & Record<string, unknown>;

const MEETING_DOCUMENT_PREFIX = 'mtgdoc_';
const MEETING_BOARD_PREFIX = 'mtgboard_';
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{1,24})$/i;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pageIndexOf(event: RuntimeSyncEvent, annotation: AnnotationRecord): number {
  const meta = recordOf(annotation.inkloop_mark);
  const value = finite(event.payload.page_index)
    ?? finite(meta?.page_index)
    ?? 0;
  return Math.max(0, Math.floor(value));
}

function annotationId(event: RuntimeSyncEvent, annotation?: AnnotationRecord | null): string | null {
  const meta = annotation ? recordOf(annotation.inkloop_mark) : null;
  const values = [
    event.payload.ko_id,
    annotation?.ko_id,
    event.target.id,
    event.payload.mark_id,
    meta?.mark_id,
  ];
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())?.trim() ?? null;
}

function annotationOf(event: RuntimeSyncEvent): AnnotationRecord | null {
  const key = event.operation === 'annotation.add'
    ? 'annotation'
    : event.operation === 'annotation.update'
      ? 'patch'
      : null;
  if (!key) return null;
  return recordOf(event.payload[key]) as AnnotationRecord | null;
}

function bboxOf(annotation: AnnotationRecord): [number, number, number, number] | null {
  const meta = recordOf(annotation.inkloop_mark);
  const raw = Array.isArray(annotation.visual_bbox)
    ? annotation.visual_bbox
    : Array.isArray(meta?.bbox)
      ? meta.bbox
      : null;
  if (!raw || raw.length !== 4) return null;
  const values = raw.map(finite);
  if (values.some((value) => value === null)) return null;
  return values as [number, number, number, number];
}

function normalizedPoint(
  point: unknown,
  coordSpace: string,
  bbox: [number, number, number, number] | null,
): { x: number; y: number } | null {
  const value = recordOf(point);
  if (!value) return null;
  const rawX = finite(value.x);
  const rawY = finite(value.y);
  if (rawX === null || rawY === null) return null;
  if (coordSpace === 'block_norm') {
    if (!bbox) return null;
    return {
      x: clamp(bbox[0] + rawX * bbox[2]),
      y: clamp(bbox[1] + rawY * bbox[3]),
    };
  }
  if (coordSpace !== 'page_norm' && coordSpace !== 'page' && coordSpace !== 'surface_norm') {
    return null;
  }
  return { x: clamp(rawX), y: clamp(rawY) };
}

function pathOf(
  stroke: RuntimeVisualStroke,
  bbox: [number, number, number, number] | null,
): string | null {
  const coordSpace = String(stroke.coord_space || 'page_norm');
  const points = Array.isArray(stroke.points)
    ? stroke.points
      .map((point) => normalizedPoint(point, coordSpace, bbox))
      .filter((point): point is { x: number; y: number } => !!point)
    : [];
  if (points.length === 0) return null;
  return points
    .map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(4)} ${point.y.toFixed(4)}`)
    .join(' ');
}

function strokeColor(stroke: RuntimeVisualStroke): string {
  const color = String(stroke.color || '').trim();
  return SAFE_COLOR.test(color) ? color : '#172522';
}

function projectedStrokes(
  event: RuntimeSyncEvent,
  annotation: AnnotationRecord,
  id: string,
): LiveBoardInkStroke[] | null {
  const hasVisualStrokes = Array.isArray(annotation.visual_strokes);
  const hasSurfaceStrokes = Array.isArray(annotation.surface_strokes);
  if (!hasVisualStrokes && !hasSurfaceStrokes) return null;
  const strokes = hasVisualStrokes && annotation.visual_strokes?.length
    ? annotation.visual_strokes
    : annotation.surface_strokes ?? [];
  const bbox = bboxOf(annotation);
  const pageIndex = pageIndexOf(event, annotation);
  return strokes.flatMap((stroke, index) => {
    const path = pathOf(stroke, bbox);
    if (!path) return [];
    const opacity = finite(stroke.opacity);
    return [{
      id: `${id}:${index}`,
      path,
      color: strokeColor(stroke),
      opacity: opacity === null ? (stroke.tool === 'highlighter' ? 0.45 : 1) : clamp(opacity),
      width: stroke.tool === 'highlighter' ? 0.012 : 0.0045,
      pageIndex,
    }];
  });
}

export function liveBoardMeetingDocumentId(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const scope = raw.startsWith(MEETING_DOCUMENT_PREFIX)
    ? raw.slice(MEETING_DOCUMENT_PREFIX.length)
    : raw.startsWith(MEETING_BOARD_PREFIX)
      ? raw.slice(MEETING_BOARD_PREFIX.length)
      : raw;
  return SAFE_SCOPE.test(scope) ? `${MEETING_DOCUMENT_PREFIX}${scope}` : null;
}

export class MeetingLiveBoardInkProjection {
  private selectedMeetingDocumentId: string | null;
  private readonly annotations = new Map<string, LiveBoardInkStroke[]>();
  private readonly appliedEventIDs = new Set<string>();
  private selectedPageIndex = 0;

  constructor(meetingDocumentId?: string | null) {
    this.selectedMeetingDocumentId = liveBoardMeetingDocumentId(meetingDocumentId);
  }

  get meetingDocumentId(): string | null {
    return this.selectedMeetingDocumentId;
  }

  get activePageIndex(): number {
    return this.selectedPageIndex;
  }

  selectMeeting(meetingDocumentId: string | null | undefined): boolean {
    const selected = liveBoardMeetingDocumentId(meetingDocumentId);
    if (selected === this.selectedMeetingDocumentId) return false;
    this.selectedMeetingDocumentId = selected;
    this.annotations.clear();
    this.appliedEventIDs.clear();
    this.selectedPageIndex = 0;
    return true;
  }

  apply(events: readonly RuntimeSyncEvent[]): boolean {
    let changed = false;
    for (const event of events) {
      if (this.appliedEventIDs.has(event.event_id)) continue;
      if (!this.selectedMeetingDocumentId) {
        if (!event.doc_id.startsWith(MEETING_DOCUMENT_PREFIX)
          || !event.operation.startsWith('annotation.')) continue;
        this.selectedMeetingDocumentId = event.doc_id;
      }
      if (event.doc_id !== this.selectedMeetingDocumentId) continue;
      this.appliedEventIDs.add(event.event_id);

      if (event.operation === 'annotation.delete') {
        const id = annotationId(event);
        if (id && this.annotations.delete(id)) changed = true;
        continue;
      }
      if (event.operation !== 'annotation.add' && event.operation !== 'annotation.update') continue;
      const annotation = annotationOf(event);
      const id = annotationId(event, annotation);
      if (!annotation || !id) continue;
      const strokes = projectedStrokes(event, annotation, id);
      // An update may only change OCR/title metadata. Preserve prior geometry
      // unless the event explicitly carries a stroke collection.
      if (strokes === null) continue;
      this.annotations.set(id, strokes);
      if (strokes.length > 0) this.selectedPageIndex = strokes[0].pageIndex;
      changed = true;
    }
    return changed;
  }

  annotationIds(): string[] {
    return [...this.annotations.keys()];
  }

  removeAnnotations(annotationIds: Iterable<string>): boolean {
    let changed = false;
    for (const annotationId of annotationIds) {
      changed = this.annotations.delete(annotationId) || changed;
    }
    return changed;
  }

  clear(): string[] {
    const annotationIds = this.annotationIds();
    this.removeAnnotations(annotationIds);
    return annotationIds;
  }

  strokes(): LiveBoardInkStroke[] {
    return [...this.annotations.values()]
      .flat()
      .filter((stroke) => stroke.pageIndex === this.selectedPageIndex);
  }
}
