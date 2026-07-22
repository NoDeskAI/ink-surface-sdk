import { createHash } from 'node:crypto';
import {
  CLASSROOM_SCHEMA_VERSION,
  type ClassroomEvidenceBundle,
  type ClassroomEvidenceCheckpoint,
  type InkLoopSourceRef,
  type LessonGraph,
} from 'ink-surface-sdk/runtime-schema';
import { validateTeacherLessonCandidate, type TeacherLessonCandidate, type TeacherLessonReviewStatus } from '../shared/classroom/education-workflows';
import type { JsonClassroomStore } from './classroom-store';
import { runEducationLessonStructured, type EducationLessonGatewayResult } from './infer';
import { buildClassroomEvidenceBundle } from './classroom-evidence';
import { activeBoardEvents, eventBoxInRegion, eventBBox, eventPointsInRegion, unionBoxes } from '../shared/classroom/classroom-spatial';

export interface ClassroomLessonOutput {
  generation_id: string;
  classroom_id: string;
  candidates: TeacherLessonCandidate[];
  review_complete: boolean;
  execution_mode: 'real' | 'deterministic_fallback';
  fallback_reason?: string;
  reviewed_lesson_graph?: LessonGraph;
  recognition_revision_fingerprint?: string;
  evidence_revision_fingerprint?: string;
  evidence?: ClassroomEvidenceCheckpoint;
  stale?: boolean;
  updated_at: string;
}

const EDUCATION_LESSON_TIMEOUT_MS = 45_000;

function generationId(classroomId: string, bundle: ClassroomEvidenceBundle): string {
  return `lesson_${createHash('sha256').update(`${classroomId}:${bundle.fingerprint}`).digest('hex').slice(0, 24)}`;
}

function lessonGatewayEvidence(bundle: ClassroomEvidenceBundle): unknown[] {
  const recognizedIds = new Set(bundle.recognitions.flatMap((item) => item.event_ids));
  const localRegion = bundle.checkpoint.selection_region?.bbox_world ?? unionBoxes(bundle.events.map((event) => eventBBox(event)), 8);
  return [
    ...(bundle.material ? [{ evidence_type: 'material_page', ...bundle.material }] : []),
    ...bundle.events.map((event) => ({
      evidence_type: 'ink_event', event_id: event.event.event_id, sequence: event.sequence,
      ts_start_ms: event.event.ts_start_ms, ts_end_ms: event.event.ts_end_ms, bbox_norm: eventBoxInRegion(event, localRegion),
      points: recognizedIds.has(event.event.event_id) ? [] : eventPointsInRegion(event, localRegion).slice(0, 512),
    })),
    ...bundle.recognitions.map((item) => ({
      evidence_type: 'trusted_recognition', recognition_id: item.recognition_id, revision: item.revision,
      status: item.status, kind: item.kind, text: item.text, latex: item.latex, event_ids: item.event_ids,
    })),
    ...bundle.transcripts.map((item) => ({
      evidence_type: 'trusted_transcript', transcript_id: item.transcript_id, revision: item.revision,
      status: item.status, start_ms: item.relative_start_ms, end_ms: item.relative_end_ms, text: item.text,
    })),
  ];
}

function lessonFallbackReason(error: unknown): 'gateway_unavailable' | 'invalid_structured_output' {
  const value = error as { name?: string; message?: string };
  const message = String(value?.message || '');
  return value?.name === 'ZodError'
    || message === 'lesson_source_ref_invalid'
    || message.startsWith('education_invalid_')
    || message === 'education_response_too_large'
    ? 'invalid_structured_output'
    : 'gateway_unavailable';
}

function projection(output: ClassroomLessonOutput): LessonGraph | undefined {
  if (!output.candidates.every((candidate) => candidate.review_status !== 'pending')) return undefined;
  const accepted = output.candidates.filter((candidate) => candidate.review_status === 'accepted' || candidate.review_status === 'edited');
  return {
    lesson_id: output.generation_id, session_id: output.classroom_id,
    steps: accepted.map((candidate, index) => ({
      step_id: candidate.candidate_id, order: index + 1, kind: candidate.kind, content: candidate.content,
      ...(candidate.latex ? { latex: candidate.latex } : {}), board_object_refs: [], source_refs: candidate.source_refs, confidence: candidate.confidence,
    })), concepts: [],
  };
}

export class ClassroomLessonService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly generations = new Map<string, Promise<ClassroomLessonOutput>>();

  constructor(private readonly store: JsonClassroomStore, private readonly gateway: (evidence: unknown[], signal?: AbortSignal) => Promise<EducationLessonGatewayResult> = process.env.INKLOOP_CLASSROOM_EXTERNAL_AI_ENABLED === '1'
    ? (evidence, signal) => runEducationLessonStructured({ evidence, signal })
    : async () => { throw new Error('external_ai_disabled'); }) {}

  async generate(classroomId: string): Promise<ClassroomLessonOutput> {
    const existing = await this.get(classroomId);
    if (existing && !existing.stale) return existing;
    const inFlight = this.generations.get(classroomId);
    if (inFlight) return inFlight;
    const generation = this.generateOnce(classroomId);
    this.generations.set(classroomId, generation);
    try { return await generation; } finally {
      if (this.generations.get(classroomId) === generation) this.generations.delete(classroomId);
    }
  }

  private async generateOnce(classroomId: string): Promise<ClassroomLessonOutput> {
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    if (classroom.status !== 'ended') throw new Error('classroom_not_ended');
    const snapshot = await this.store.getSnapshot(classroomId);
    if (activeBoardEvents(snapshot.board_events).length < 3) throw new Error('insufficient_evidence');
    const bundle = buildClassroomEvidenceBundle({ snapshot, intent: 'lesson_graph' });
    if (bundle.trust_status === 'needs_confirmation') throw new Error('untrusted_formula_evidence');
    const generation = generationId(classroomId, bundle);
    let mode: ClassroomLessonOutput['execution_mode'] = 'real';
    let reason: string | undefined;
    let candidates: TeacherLessonCandidate[];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('gateway_timeout'), EDUCATION_LESSON_TIMEOUT_MS);
    this.controllers.set(classroomId, controller);
    try {
      const result = await this.gateway(lessonGatewayEvidence(bundle), controller.signal);
      if ((controller.signal.aborted && controller.signal.reason === 'classroom_deleted') || !await this.store.getClassroom(classroomId)) throw new Error('classroom_deleted');
      if (controller.signal.aborted) throw new Error('education_gateway_timeout');
      const eventMap = new Map(bundle.source_refs.filter((ref): ref is Extract<InkLoopSourceRef, { type: 'ink_event' }> => ref.type === 'ink_event').map((ref) => [ref.event_id, ref]));
      const contextRefs = bundle.source_refs.filter((ref) => ref.type === 'material_page' || ref.type === 'audio_segment');
      candidates = result.candidates.map((item, index) => {
        const refs = [...new Set(item.event_ids)].map((id) => eventMap.get(id)).filter((ref): ref is Extract<InkLoopSourceRef, { type: 'ink_event' }> => ref !== undefined);
        if (refs.length !== item.event_ids.length || refs.length === 0) throw new Error('lesson_source_ref_invalid');
        return {
          schema_version: CLASSROOM_SCHEMA_VERSION, candidate_id: `candidate_${createHash('sha256').update(`${generation}:${item.kind}:${item.content}:${item.event_ids.join(':')}`).digest('hex').slice(0, 24)}`,
          classroom_id: classroomId, generation_id: generation, kind: item.kind, order: index + 1, content: item.content,
          ...(item.latex ? { latex: item.latex } : {}), confidence: item.confidence, source_refs: [...contextRefs, ...refs], review_status: 'pending',
        };
      });
    } catch (error) {
      if ((controller.signal.aborted && controller.signal.reason === 'classroom_deleted') || !await this.store.getClassroom(classroomId)) throw new Error('classroom_not_found');
      mode = 'deterministic_fallback'; reason = lessonFallbackReason(error);
      const contextRefs = bundle.source_refs.filter((ref) => ref.type === 'material_page' || ref.type === 'audio_segment');
      candidates = bundle.events.map((event, index) => ({
      schema_version: CLASSROOM_SCHEMA_VERSION, candidate_id: `candidate_${createHash('sha256').update(`${generation}:${event.event.event_id}`).digest('hex').slice(0, 24)}`,
      classroom_id: classroomId, generation_id: generation, kind: index === snapshot.board_events.length - 1 ? 'conclusion' : 'derivation', order: index + 1,
      content: `课堂步骤 ${index + 1}`, confidence: event.event.source.confidence,
      source_refs: [...contextRefs, bundle.source_refs.find((ref) => ref.type === 'ink_event' && ref.event_id === event.event.event_id)!], review_status: 'pending',
      }));
    } finally {
      clearTimeout(timeout);
      if (this.controllers.get(classroomId) === controller) this.controllers.delete(classroomId);
    }
    for (const candidate of candidates) {
      const issues = validateTeacherLessonCandidate(candidate);
      if (issues.length) throw new Error(`lesson_candidate_invalid:${issues.map((issue) => issue.path).join(',')}`);
    }
    const output: ClassroomLessonOutput = {
      generation_id: generation, classroom_id: classroomId, candidates, review_complete: false, execution_mode: mode,
      recognition_revision_fingerprint: bundle.checkpoint.recognition_revision_fingerprint,
      evidence_revision_fingerprint: bundle.fingerprint, evidence: bundle.checkpoint,
      ...(reason ? { fallback_reason: reason } : {}), updated_at: new Date().toISOString(),
    };
    await this.store.putTeacherRecord(classroomId, 'lesson_generation', output);
    return output;
  }

  abortClassroom(classroomId: string): void {
    this.controllers.get(classroomId)?.abort('classroom_deleted');
    this.controllers.delete(classroomId);
  }

  async get(classroomId: string): Promise<ClassroomLessonOutput | null> {
    const value = await this.store.getTeacherRecord(classroomId, 'lesson_generation');
    if (!value || typeof value !== 'object' || !Array.isArray((value as ClassroomLessonOutput).candidates)) return null;
    const output = value as ClassroomLessonOutput;
    if (!output.evidence_revision_fingerprint && !output.recognition_revision_fingerprint) return output;
    const snapshot = await this.store.getSnapshot(classroomId);
    const current = buildClassroomEvidenceBundle({ snapshot, intent: 'lesson_graph' });
    const expected = output.evidence_revision_fingerprint ?? output.recognition_revision_fingerprint;
    const actual = output.evidence_revision_fingerprint ? current.fingerprint : current.checkpoint.recognition_revision_fingerprint;
    return { ...output, stale: expected !== actual };
  }

  async review(classroomId: string, candidateId: string, input: { status: Exclude<TeacherLessonReviewStatus, 'pending'>; content?: string }): Promise<ClassroomLessonOutput> {
    const output = await this.get(classroomId);
    if (!output) throw new Error('lesson_generation_not_found');
    const index = output.candidates.findIndex((candidate) => candidate.candidate_id === candidateId);
    if (index < 0) throw new Error('lesson_candidate_not_found');
    if (!['accepted', 'edited', 'dismissed'].includes(input.status)) throw new Error('lesson_review_status_invalid');
    const current = output.candidates[index];
    if (input.status === 'edited' && !String(input.content || '').trim()) throw new Error('lesson_content_required');
    const next: TeacherLessonCandidate = {
      ...current, review_status: input.status, reviewed_at: new Date().toISOString(),
      ...(input.status === 'edited' ? { original_content: current.original_content || current.content, content: String(input.content).trim().slice(0, 4_000) } : {}),
    };
    const issues = validateTeacherLessonCandidate(next);
    if (issues.length) throw new Error(`lesson_candidate_invalid:${issues.map((issue) => issue.path).join(',')}`);
    const candidates = output.candidates.slice(); candidates[index] = next;
    const updated: ClassroomLessonOutput = { ...output, candidates, review_complete: candidates.every((candidate) => candidate.review_status !== 'pending'), updated_at: new Date().toISOString() };
    updated.reviewed_lesson_graph = projection(updated);
    await this.store.putTeacherRecord(classroomId, 'lesson_generation', updated);
    return updated;
  }
}
