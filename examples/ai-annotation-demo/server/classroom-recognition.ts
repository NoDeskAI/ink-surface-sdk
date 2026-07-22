import { createHash } from 'node:crypto';
import {
  CLASSROOM_SCHEMA_VERSION,
  validateClassroomRecognitionRevision,
  type ClassroomBoardEvent,
  type ClassroomRecognitionRevision,
  type ClassroomSpatialRegion,
  type ClassroomSurfaceRef,
  type RuntimeNormBBox,
} from 'ink-surface-sdk/runtime-schema';
import type { JsonClassroomStore } from './classroom-store';
import { runEducationRecognitionStructured } from './infer';
import { boxesIntersect, eventBBox, eventPointsInRegion, pageGeometry } from '../shared/classroom/classroom-spatial';

export interface ClassroomRecognitionInput {
  client_request_id: string;
  event_ids: string[];
  surface: ClassroomSurfaceRef;
  bbox_norm?: RuntimeNormBBox;
  spatial_region?: ClassroomSpatialRegion;
  processing_mode: 'local' | 'external';
  image_data_url?: string;
}

export interface RecognitionAdapterResult {
  kind: 'formula' | 'text' | 'mixed';
  text: string;
  latex?: string;
  confidence: number;
  provider: string;
}

export interface RecognitionAdapterInput {
  classroom_id: string;
  event_ids: string[];
  surface: ClassroomSurfaceRef;
  bbox_norm: RuntimeNormBBox;
  strokes: Array<{ event_id: string; points: Array<{ x_norm: number; y_norm: number; t_ms: number }> }>;
  processing_mode: 'local' | 'external';
  image_base64?: string;
}

type RecognitionAdapter = (input: RecognitionAdapterInput, signal: AbortSignal) => Promise<RecognitionAdapterResult>;
const RECOGNITION_TIMEOUT_MS = 20_000;
const MAX_RECOGNITION_IMAGE_BASE64 = 384 * 1024;
export const DEFAULT_CLASSROOM_RECOGNITION_MODEL = 'gemini-3.1-flash-lite';

export function classroomRecognitionModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.INKLOOP_CLASSROOM_RECOGNITION_MODEL || DEFAULT_CLASSROOM_RECOGNITION_MODEL;
}

function recognitionImage(value: string | undefined, required: boolean): string | undefined {
  if (!value) {
    if (required) throw new Error('recognition_image_required');
    return undefined;
  }
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match || match[1].length > MAX_RECOGNITION_IMAGE_BASE64) throw new Error('recognition_image_invalid');
  return match[1];
}

function safeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) throw new Error(`${label}_invalid`);
  return normalized;
}

function sameSurface(a: ClassroomSurfaceRef | undefined, b: ClassroomSurfaceRef): boolean {
  const left = a ?? { kind: 'teacher_board' as const };
  if (left.kind !== b.kind) return false;
  if (left.kind === 'teacher_board') return true;
  if (left.kind === 'textbook_page' && b.kind === 'textbook_page') return left.material_id === b.material_id && left.page_index === b.page_index;
  return left.kind === 'scratch' && b.kind === 'scratch' && left.scratch_id === b.scratch_id;
}

function intersects(a: RuntimeNormBBox, b: RuntimeNormBBox): boolean {
  return a[0] <= b[0] + b[2] && a[0] + a[2] >= b[0] && a[1] <= b[1] + b[3] && a[1] + a[3] >= b[1];
}

function validBox(value: RuntimeNormBBox): boolean {
  return Array.isArray(value) && value.length === 4 && value.every((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 1)
    && value[2] > 0 && value[3] > 0 && value[0] + value[2] <= 1 && value[1] + value[3] <= 1;
}

export function latestRecognitionRevisions(revisions: ClassroomRecognitionRevision[]): ClassroomRecognitionRevision[] {
  const latest = new Map<string, ClassroomRecognitionRevision>();
  for (const item of revisions) if (!latest.has(item.recognition_id) || latest.get(item.recognition_id)!.revision < item.revision) latest.set(item.recognition_id, item);
  return [...latest.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function trustedRecognitionEvidence(revisions: ClassroomRecognitionRevision[]): ClassroomRecognitionRevision[] {
  return latestRecognitionRevisions(revisions).filter((item) => item.status === 'confirmed' || item.status === 'corrected');
}

export function recognitionsForEvents(revisions: ClassroomRecognitionRevision[], eventIds: ReadonlySet<string>): ClassroomRecognitionRevision[] {
  return latestRecognitionRevisions(revisions).filter((item) => item.event_ids.some((id) => eventIds.has(id)));
}

export function recognitionRevisionFingerprint(revisions: ClassroomRecognitionRevision[]): string {
  const projection = latestRecognitionRevisions(revisions)
    .map((item) => `${item.recognition_id}:${item.revision}:${item.status}`)
    .sort().join('|');
  return `recognition_${createHash('sha256').update(projection).digest('hex').slice(0, 24)}`;
}

export class ClassroomRecognitionService {
  constructor(private readonly store: JsonClassroomStore, private readonly adapter: RecognitionAdapter = async (input, signal) => {
    if (input.processing_mode !== 'external') throw new Error('local_recognition_unavailable');
    const result = await runEducationRecognitionStructured({ evidence: { surface: input.surface, bbox_norm: input.bbox_norm, strokes: input.strokes }, eventIds: input.event_ids, imageBase64: input.image_base64, model: classroomRecognitionModel(), signal });
    return { ...result, provider: 'education_gateway' };
  }) {}

  async recognize(classroomId: string, input: ClassroomRecognitionInput): Promise<ClassroomRecognitionRevision> {
    const requestId = safeId(input.client_request_id, 'client_request_id');
    if (!Array.isArray(input.event_ids) || input.event_ids.length === 0 || input.event_ids.length > 24) throw new Error('recognition_event_ids_invalid');
    const eventIds = [...new Set(input.event_ids.map((item) => safeId(item, 'event_id')))];
    if (input.bbox_norm === undefined && input.spatial_region === undefined) throw new Error('recognition_bbox_invalid');
    if (input.bbox_norm !== undefined && !validBox(input.bbox_norm)) throw new Error('recognition_bbox_invalid');
    if (!['local', 'external'].includes(input.processing_mode)) throw new Error('recognition_processing_mode_invalid');
    const imageBase64 = recognitionImage(input.image_data_url, input.processing_mode === 'external');
    const snapshot = await this.store.getSnapshot(classroomId);
    const eventMap = new Map(snapshot.board_events.map((event) => [event.event.event_id, event]));
    const events = eventIds.map((id) => eventMap.get(id)).filter((item): item is ClassroomBoardEvent => !!item);
    if (events.length !== eventIds.length) throw new Error('recognition_source_invalid');
    if (!events.every((event) => sameSurface(event.surface, input.surface))) throw new Error('recognition_surface_mismatch');
    const materialId = input.surface.kind === 'textbook_page' ? input.surface.material_id : undefined;
    const material = materialId ? snapshot.materials?.find((item) => item.material_id === materialId) : undefined;
    const requestWorldBox = input.spatial_region?.bbox_world;
    if (requestWorldBox && !events.every((event) => boxesIntersect(eventBBox(event, material), requestWorldBox))) throw new Error('recognition_bbox_mismatch');
    if (!requestWorldBox && input.bbox_norm && !events.every((event) => event.geometry_version !== 'classroom_page_world_v1' && intersects(event.event.bbox_norm, input.bbox_norm!))) throw new Error('recognition_bbox_mismatch');
    const providerRegion = requestWorldBox ?? (() => {
      const geometry = input.surface.kind === 'textbook_page' ? pageGeometry(material, input.surface.page_index) : undefined;
      return geometry && input.bbox_norm ? [
        (input.bbox_norm[0] - 0.5) * geometry.width_world,
        (input.bbox_norm[1] - 0.5) * geometry.height_world,
        input.bbox_norm[2] * geometry.width_world,
        input.bbox_norm[3] * geometry.height_world,
      ] as const : [-500, -312.5, 1000, 625] as const;
    })();
    const providerBox = input.bbox_norm ?? [0, 0, 1, 1] as RuntimeNormBBox;
    const recognitionId = `recognition_${createHash('sha256').update(`${classroomId}:${requestId}`).digest('hex').slice(0, 24)}`;
    const existing = await this.history(classroomId, recognitionId);
    if (existing[0]) return existing.at(-1)!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('recognition_timeout'), RECOGNITION_TIMEOUT_MS);
    const now = new Date().toISOString();
    let revision: ClassroomRecognitionRevision;
    try {
      const result = await this.adapter({
        classroom_id: classroomId, event_ids: eventIds, surface: input.surface, bbox_norm: providerBox,
        strokes: events.map((event) => ({ event_id: event.event.event_id, points: eventPointsInRegion(event, providerRegion, material).slice(0, 1024) })),
        processing_mode: input.processing_mode, ...(imageBase64 ? { image_base64: imageBase64 } : {}),
      }, controller.signal);
      if (controller.signal.aborted) throw new Error('recognition_timeout');
      const text = String(result.text || '').trim().slice(0, 2_000);
      const confidence = Number(result.confidence);
      if (!text || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !['formula', 'text', 'mixed'].includes(result.kind)) throw new Error('recognition_invalid_output');
      revision = {
        schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, recognition_id: recognitionId, revision: 1,
        status: 'pending', kind: result.kind, text, ...(result.latex ? { latex: String(result.latex).slice(0, 1_000) } : {}), confidence,
        provider: safeId(result.provider, 'recognition_provider'), processing_mode: input.processing_mode, event_ids: eventIds,
        surface: input.surface, ...(input.bbox_norm ? { bbox_norm: input.bbox_norm } : {}), ...(input.spatial_region ? { spatial_region: input.spatial_region } : {}), created_at: now,
      };
    } catch {
      revision = {
        schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, recognition_id: recognitionId, revision: 1,
        status: 'failed', kind: 'formula', text: '', confidence: 0, provider: 'unavailable', processing_mode: input.processing_mode,
        event_ids: eventIds, surface: input.surface, ...(input.bbox_norm ? { bbox_norm: input.bbox_norm } : {}), ...(input.spatial_region ? { spatial_region: input.spatial_region } : {}), error_code: 'recognition_provider_failed', created_at: now,
      };
    } finally { clearTimeout(timeout); }
    const issues = validateClassroomRecognitionRevision(revision);
    if (issues.length) throw new Error(`recognition_revision_invalid:${issues.map((issue) => issue.path).join(',')}`);
    return this.store.appendRecognitionRevision(classroomId, revision);
  }

  async review(classroomId: string, recognitionId: string, input: { status: 'confirmed' | 'corrected' | 'dismissed'; text?: string; latex?: string }): Promise<ClassroomRecognitionRevision> {
    safeId(recognitionId, 'recognition_id');
    if (!['confirmed', 'corrected', 'dismissed'].includes(input.status)) throw new Error('recognition_review_status_invalid');
    const history = await this.history(classroomId, recognitionId);
    const current = history.at(-1);
    if (!current) throw new Error('recognition_not_found');
    if (current.status === 'failed' && input.status !== 'dismissed') throw new Error('recognition_failed_review_invalid');
    const original = history[0];
    const text = input.status === 'corrected' ? String(input.text || '').trim().slice(0, 2_000) : current.text;
    if (input.status === 'corrected' && !text) throw new Error('recognition_text_required');
    const next: ClassroomRecognitionRevision = {
      ...current, revision: current.revision + 1, status: input.status, text,
      ...(input.status === 'corrected' ? { latex: input.latex === undefined ? current.latex : String(input.latex).slice(0, 1_000), confidence: 1 } : {}),
      original_revision: original.revision, created_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), error_code: undefined,
    };
    const issues = validateClassroomRecognitionRevision(next);
    if (issues.length) throw new Error(`recognition_revision_invalid:${issues.map((issue) => issue.path).join(',')}`);
    return this.store.appendRecognitionRevision(classroomId, next);
  }

  async history(classroomId: string, recognitionId: string): Promise<ClassroomRecognitionRevision[]> {
    return (await this.store.listRecognitionRevisions(classroomId)).filter((item) => item.recognition_id === recognitionId).sort((a, b) => a.revision - b.revision);
  }

  async list(classroomId: string): Promise<ClassroomRecognitionRevision[]> {
    return latestRecognitionRevisions(await this.store.listRecognitionRevisions(classroomId));
  }
}
