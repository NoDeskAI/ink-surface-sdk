import { createHash } from 'node:crypto';
import {
  CLASSROOM_SCHEMA_VERSION,
  type ClassroomEvidenceBundle,
  type ClassroomEvidenceIntent,
  type ClassroomSpatialRegion,
  type InkLoopSourceRef,
  type RuntimeNormBBox,
} from 'ink-surface-sdk/runtime-schema';
import { validateEducationAiJob, type EducationAiJob, type EducationAiJobKind, type EducationAiResultSection } from '../shared/classroom/education-workflows';
import { runEducationStructured, type EducationStructuredGatewayResult } from './infer';
import type { JsonClassroomStore } from './classroom-store';
import { recognitionRevisionFingerprint, recognitionsForEvents } from './classroom-recognition';
import { buildClassroomEvidenceBundle, transcriptRevisionFingerprint } from './classroom-evidence';
import { eventBBox, eventBoxInRegion, eventPointsInRegion, unionBoxes } from '../shared/classroom/classroom-spatial';

export interface EducationGatewayInput {
  kind: EducationAiJobKind;
  intent: ClassroomEvidenceIntent;
  material?: ClassroomEvidenceBundle['material'];
  time_window: { start_ms: number; end_ms: number };
  transcripts: Array<{
    transcript_id: string;
    revision: number;
    status: 'final' | 'corrected';
    start_ms: number;
    end_ms: number;
    text: string;
  }>;
  missing_sources: ClassroomEvidenceBundle['missing_sources'];
  evidence: Array<{
    event_id: string;
    sequence: number;
    ts_start_ms: number;
    ts_end_ms: number;
    bbox_norm: RuntimeNormBBox;
    tool: string;
    points: Array<{ x_norm: number; y_norm: number; t_ms: number }>;
  }>;
  recognitions: Array<{
    recognition_id: string;
    revision: number;
    status: 'confirmed' | 'corrected';
    kind: 'formula' | 'text' | 'mixed';
    text: string;
    latex?: string;
    event_ids: string[];
  }>;
}

export interface CreateEducationJobInput {
  kind: EducationAiJobKind;
  client_request_id: string;
  selection_bbox_norm?: RuntimeNormBBox;
  selection_region?: ClassroomSpatialRegion;
  evidence_intent?: Extract<ClassroomEvidenceIntent, 'current_step' | 'selected_region' | 'missed_segment'>;
  trigger_time_ms?: number;
  time_start_ms?: number;
  time_end_ms?: number;
}

interface StoredEducationJob extends EducationAiJob {
  client_request_id: string;
}

type EducationGateway = (input: EducationGatewayInput, signal: AbortSignal) => Promise<EducationStructuredGatewayResult>;

interface ClassroomAiQueue {
  active: number;
  activeParticipants: Set<string>;
  waiting: Array<{ participantId: string; resolve: () => void; reject: (error: Error) => void }>;
}

const MAX_CLASSROOM_AI_CONCURRENCY = 2;
const MAX_CLASSROOM_AI_QUEUE = 12;
const MAX_PARTICIPANT_WAITING = 2;
const EDUCATION_GATEWAY_TIMEOUT_MS = 45_000;

function safeRequestId(value: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(normalized)) throw new Error('client_request_id_invalid');
  return normalized;
}

function safeKind(value: string): EducationAiJobKind {
  if (!['live_explanation', 'class_summary', 'practice'].includes(value)) throw new Error('education_job_kind_invalid');
  return value as EducationAiJobKind;
}

function safeSelection(value: RuntimeNormBBox | undefined): RuntimeNormBBox | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 1)
    || value[0] + value[2] > 1 || value[1] + value[3] > 1 || value[2] === 0 || value[3] === 0) throw new Error('selection_bbox_invalid');
  return value;
}

function gatewayEvidence(bundle: ClassroomEvidenceBundle): EducationGatewayInput['evidence'] {
  const recognizedIds = new Set(bundle.recognitions.flatMap((item) => item.event_ids));
  const localRegion = bundle.checkpoint.selection_region?.bbox_world ?? unionBoxes(bundle.events.map((event) => eventBBox(event)), 8);
  return bundle.events.map((event) => ({
    event_id: event.event.event_id, sequence: event.sequence, ts_start_ms: event.event.ts_start_ms, ts_end_ms: event.event.ts_end_ms,
    bbox_norm: eventBoxInRegion(event, localRegion), tool: event.event.metadata?.tool || 'pen',
    points: recognizedIds.has(event.event.event_id) ? [] : eventPointsInRegion(event, localRegion).slice(0, 512),
  }));
}

function gatewayRecognitions(bundle: ClassroomEvidenceBundle): EducationGatewayInput['recognitions'] {
  return bundle.recognitions.map((item) => ({
    recognition_id: item.recognition_id, revision: item.revision, status: item.status as 'confirmed' | 'corrected',
    kind: item.kind, text: item.text, ...(item.latex ? { latex: item.latex } : {}), event_ids: item.event_ids,
  }));
}

function gatewayInput(kind: EducationAiJobKind, bundle: ClassroomEvidenceBundle): EducationGatewayInput {
  return {
    kind, intent: bundle.intent, ...(bundle.material ? { material: bundle.material } : {}),
    time_window: { start_ms: bundle.checkpoint.time_start_ms, end_ms: bundle.checkpoint.time_end_ms },
    evidence: gatewayEvidence(bundle), recognitions: gatewayRecognitions(bundle), missing_sources: bundle.missing_sources,
    transcripts: bundle.transcripts.map((item) => ({
      transcript_id: item.transcript_id, revision: item.revision, status: item.status as 'final' | 'corrected',
      start_ms: item.relative_start_ms, end_ms: item.relative_end_ms, text: item.text,
    })),
  };
}

function uncertainty(refs: InkLoopSourceRef[]): { title: string; sections: EducationAiResultSection[] } {
  return {
    title: '公式尚待老师确认',
    sections: [{ section_id: 'section_1', content: '所选板书包含尚未确认的公式识别结果。为避免把错误公式讲成确定结论，请先等待老师确认或更正。', source_refs: refs }],
  };
}

function fallback(kind: EducationAiJobKind, refs: InkLoopSourceRef[]): { title: string; sections: EducationAiResultSection[] } {
  const titles = { live_explanation: '当前板书说明', class_summary: '课堂板书总结', practice: '课后练习' } as const;
  const contents = kind === 'practice'
    ? ['题目：请按老师板书的顺序复述并完成相同类型的一步推导。', '提示：先定位每一笔对应的前后关系。', '答案：以课堂板书的有序步骤作为核对依据。']
    : kind === 'class_summary'
      ? ['课堂证据已按时间顺序整理。', '请结合板书来源逐步复盘概念、推导和结论。']
      : ['这是老师最近完成的一段板书。', '请沿着笔画的时间顺序理解当前步骤；仅凭笔画无法可靠识别的公式需要人工确认。'];
  return { title: titles[kind], sections: contents.map((content, index) => ({ section_id: `section_${index + 1}`, content, source_refs: refs })) };
}

function mapGatewayResult(result: EducationStructuredGatewayResult, bundle: ClassroomEvidenceBundle): EducationAiResultSection[] {
  const eventMap = new Map(bundle.source_refs.filter((ref): ref is Extract<InkLoopSourceRef, { type: 'ink_event' }> => ref.type === 'ink_event').map((ref) => [ref.event_id, ref]));
  const contextRefs = bundle.source_refs.filter((ref) => ref.type === 'material_page' || ref.type === 'audio_segment');
  return result.sections.map((section, index) => {
    const refs = [...new Set(section.event_ids)].map((id) => eventMap.get(id)).filter((ref): ref is Extract<InkLoopSourceRef, { type: 'ink_event' }> => ref !== undefined);
    if (refs.length !== section.event_ids.length || refs.length === 0) throw new Error('education_source_ref_invalid');
    return { section_id: `section_${index + 1}`, content: section.content, source_refs: [...contextRefs, ...refs] };
  });
}

function intentFor(kind: EducationAiJobKind, input: CreateEducationJobInput): ClassroomEvidenceIntent {
  if (kind === 'class_summary') return 'class_summary';
  if (kind === 'practice') return 'practice';
  if (input.evidence_intent) return input.evidence_intent;
  return input.selection_bbox_norm || input.selection_region ? 'selected_region' : 'current_step';
}

function checkpointIsStale(job: EducationAiJob, snapshot: Awaited<ReturnType<JsonClassroomStore['getSnapshot']>>): boolean {
  const ids = new Set(job.evidence.source_refs.filter((ref) => ref.type === 'ink_event').map((ref) => ref.event_id));
  const recognition = recognitionRevisionFingerprint(recognitionsForEvents(snapshot.recognitions ?? [], ids));
  const transcripts = (snapshot.transcripts ?? []).filter((item) => item.relative_start_ms <= job.evidence.time_end_ms && item.relative_end_ms >= job.evidence.time_start_ms);
  const transcript = transcriptRevisionFingerprint(transcripts);
  return (!!job.evidence.recognition_revision_fingerprint && job.evidence.recognition_revision_fingerprint !== recognition)
    || (!!job.evidence.transcript_revision_fingerprint && job.evidence.transcript_revision_fingerprint !== transcript);
}

function fallbackReason(error: unknown): 'gateway_unavailable' | 'invalid_structured_output' {
  const value = error as { name?: string; message?: string };
  const message = String(value?.message || '');
  return value?.name === 'ZodError'
    || message === 'education_source_ref_invalid'
    || message.startsWith('education_invalid_')
    || message === 'education_response_too_large'
    ? 'invalid_structured_output'
    : 'gateway_unavailable';
}

function isClassroomDeletion(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === 'classroom_deleted';
}

export class ClassroomAiService {
  private readonly gateway: EducationGateway;
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly queues = new Map<string, ClassroomAiQueue>();

  constructor(private readonly store: JsonClassroomStore, options: { gateway?: EducationGateway } = {}) {
    this.gateway = options.gateway ?? (process.env.INKLOOP_CLASSROOM_EXTERNAL_AI_ENABLED === '1'
      ? (input, signal) => runEducationStructured({ ...input, signal })
      : async () => { throw new Error('external_ai_disabled'); });
  }

  private reserve(classroomId: string, participantId: string): { ready: Promise<void>; release: () => void } {
    const queue = this.queues.get(classroomId) ?? { active: 0, activeParticipants: new Set<string>(), waiting: [] };
    this.queues.set(classroomId, queue);
    let acquired = false;
    let settled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => undefined);
    const acquire = (): void => {
      acquired = true; settled = true; queue.active += 1; queue.activeParticipants.add(participantId); resolveReady();
    };
    if (queue.active < MAX_CLASSROOM_AI_CONCURRENCY && !queue.activeParticipants.has(participantId)) {
      acquire();
    } else {
      if (queue.waiting.length >= MAX_CLASSROOM_AI_QUEUE) throw new Error('education_queue_full');
      if (queue.waiting.filter((entry) => entry.participantId === participantId).length >= MAX_PARTICIPANT_WAITING) throw new Error('education_rate_limited');
      queue.waiting.push({ participantId, resolve: acquire, reject: rejectReady });
    }
    const drain = (): void => {
      while (queue.active < MAX_CLASSROOM_AI_CONCURRENCY) {
        const index = queue.waiting.findIndex((entry) => !queue.activeParticipants.has(entry.participantId));
        if (index < 0) break;
        queue.waiting.splice(index, 1)[0].resolve();
      }
      if (queue.active === 0 && queue.waiting.length === 0) this.queues.delete(classroomId);
    };
    return {
      ready,
      release: () => {
        if (!settled) {
          const index = queue.waiting.findIndex((entry) => entry.resolve === acquire);
          if (index >= 0) queue.waiting.splice(index, 1);
          settled = true; rejectReady(new Error('education_request_cancelled'));
        } else if (acquired) {
          acquired = false; queue.active -= 1; queue.activeParticipants.delete(participantId);
        }
        drain();
      },
    };
  }

  async createAndRun(classroomId: string, participantId: string, input: CreateEducationJobInput): Promise<EducationAiJob> {
    const requestId = safeRequestId(input.client_request_id);
    const kind = safeKind(input.kind);
    const selection = safeSelection(input.selection_bbox_norm);
    const recordId = `job_${createHash('sha256').update(`${kind}:${requestId}`).digest('hex').slice(0, 24)}`;
    const existing = await this.store.getPrivateRecord(classroomId, participantId, recordId) as StoredEducationJob | null;
    if (existing) return existing;
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    if (kind === 'live_explanation' && classroom.status !== 'live') throw new Error('classroom_not_live');
    if (kind !== 'live_explanation' && classroom.status !== 'ended') throw new Error('classroom_not_ended');
    const snapshot = await this.store.getSnapshot(classroomId);
    const bundle = buildClassroomEvidenceBundle({
      snapshot, timeline: await this.store.getTimeline(classroomId), intent: intentFor(kind, input),
      ...(selection ? { selection_bbox_norm: selection } : {}),
      ...(input.selection_region ? { selection_region: input.selection_region } : {}),
      ...(input.trigger_time_ms !== undefined ? { trigger_time_ms: input.trigger_time_ms } : {}),
      ...(input.time_start_ms !== undefined ? { time_start_ms: input.time_start_ms } : {}),
      ...(input.time_end_ms !== undefined ? { time_end_ms: input.time_end_ms } : {}),
    });
    const evidence = bundle.checkpoint;
    if (bundle.intent === 'missed_segment' && bundle.missing_sources.includes('trusted_formula')) throw new Error('insufficient_evidence');
    if (bundle.trust_status === 'needs_confirmation' && kind !== 'live_explanation') throw new Error('untrusted_formula_evidence');
    if (bundle.trust_status === 'needs_confirmation') {
      const now = new Date().toISOString();
      const generated = uncertainty(bundle.source_refs);
      const job: StoredEducationJob = {
        schema_version: CLASSROOM_SCHEMA_VERSION, job_id: recordId, classroom_id: classroomId, kind, status: 'completed', evidence,
        client_request_id: requestId, attempt_count: 1, created_at: now, updated_at: now, completed_at: now,
        result: { execution_mode: 'deterministic_fallback', fallback_reason: 'untrusted_formula_evidence', ...generated, review_status: 'kept' },
      };
      const raced = await this.store.putPrivateRecordIfAbsent(classroomId, participantId, recordId, job) as StoredEducationJob | null;
      return raced ?? job;
    }
    const reservation = this.reserve(classroomId, participantId);
    const now = new Date().toISOString();
    let job: StoredEducationJob = {
      schema_version: CLASSROOM_SCHEMA_VERSION, job_id: recordId, classroom_id: classroomId, kind,
      status: 'queued', evidence, client_request_id: requestId, attempt_count: 1, created_at: now, updated_at: now,
    };
    try {
      const raced = await this.store.putPrivateRecordIfAbsent(classroomId, participantId, recordId, job) as StoredEducationJob | null;
      if (raced) { reservation.release(); return raced; }
      await reservation.ready;
      job = { ...job, status: 'running', last_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      await this.store.putPrivateRecord(classroomId, participantId, recordId, job);
    } catch (error) {
      reservation.release();
      throw error;
    }
    const refs = bundle.source_refs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('gateway_timeout'), EDUCATION_GATEWAY_TIMEOUT_MS);
    const active = this.controllers.get(classroomId) ?? new Set<AbortController>();
    this.controllers.set(classroomId, active); active.add(controller);
    try {
      const result = await this.gateway(gatewayInput(kind, bundle), controller.signal);
      if (isClassroomDeletion(controller.signal) || !await this.store.getClassroom(classroomId)) throw new Error('classroom_deleted');
      if (controller.signal.aborted) throw new Error('education_gateway_timeout');
      job = {
        ...job, status: 'completed', updated_at: new Date().toISOString(), completed_at: new Date().toISOString(),
        result: { execution_mode: 'real', title: result.title, sections: mapGatewayResult(result, bundle), review_status: 'kept' },
      };
    } catch (error) {
      if (isClassroomDeletion(controller.signal) || !await this.store.getClassroom(classroomId)) throw new Error('classroom_not_found');
      const generated = fallback(kind, refs);
      const reason = fallbackReason(error);
      job = {
        ...job, status: 'completed', updated_at: new Date().toISOString(), completed_at: new Date().toISOString(),
        result: { execution_mode: 'deterministic_fallback', fallback_reason: reason, ...generated, review_status: 'kept' },
      };
    } finally {
      clearTimeout(timeout);
      active.delete(controller);
      if (active.size === 0) this.controllers.delete(classroomId);
      reservation.release();
    }
    const issues = validateEducationAiJob(job);
    if (issues.length) throw new Error(`education_job_invalid:${issues.map((issue) => issue.path).join(',')}`);
    await this.store.putPrivateRecord(classroomId, participantId, recordId, job);
    return job;
  }

  async list(classroomId: string, participantId: string, includeDismissed = false): Promise<EducationAiJob[]> {
    const records = await this.store.listPrivateRecords(classroomId, participantId);
    const snapshot = await this.store.getSnapshot(classroomId);
    return records.filter((record): record is EducationAiJob => validateEducationAiJob(record).length === 0)
      .filter((record) => includeDismissed || record.result?.review_status !== 'dismissed')
      .map((record) => {
        return { ...record, stale: checkpointIsStale(record, snapshot) };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(classroomId: string, participantId: string, jobId: string): Promise<EducationAiJob | null> {
    const record = await this.store.getPrivateRecord(classroomId, participantId, jobId);
    if (validateEducationAiJob(record).length !== 0) return null;
    const job = record as EducationAiJob;
    return { ...job, stale: checkpointIsStale(job, await this.store.getSnapshot(classroomId)) };
  }

  async review(classroomId: string, participantId: string, jobId: string, input: { status: 'kept' | 'edited' | 'dismissed'; user_edit?: string }): Promise<EducationAiJob> {
    const current = await this.get(classroomId, participantId, jobId);
    if (!current?.result || current.status !== 'completed') throw new Error('education_job_not_found');
    if (input.status === 'edited' && !String(input.user_edit || '').trim()) throw new Error('user_edit_required');
    const original = current.result.original_result ?? { title: current.result.title, sections: current.result.sections };
    const next: EducationAiJob = {
      ...current, updated_at: new Date().toISOString(), result: {
        ...current.result, review_status: input.status,
        ...(input.status === 'edited' ? { user_edit: String(input.user_edit).trim().slice(0, 8_000), original_result: original } : {}),
      },
    };
    const issues = validateEducationAiJob(next);
    if (issues.length) throw new Error(`education_job_invalid:${issues.map((issue) => issue.path).join(',')}`);
    await this.store.putPrivateRecord(classroomId, participantId, jobId, next);
    return next;
  }

  async retry(classroomId: string, participantId: string, jobId: string): Promise<EducationAiJob> {
    const current = await this.get(classroomId, participantId, jobId);
    if (!current) throw new Error('education_job_not_found');
    if (current.status === 'completed' && current.result?.execution_mode === 'real' && !current.stale) return current;
    const snapshot = await this.store.getSnapshot(classroomId);
    const ids = new Set(current.evidence.source_refs.filter((ref) => ref.type === 'ink_event').map((ref) => ref.event_id));
    const events = snapshot.board_events.filter((event) => ids.has(event.event.event_id));
    if (events.length !== ids.size || events.length === 0) throw new Error('insufficient_evidence');
    const reservation = this.reserve(classroomId, participantId);
    await reservation.ready;
    const latest = await this.get(classroomId, participantId, jobId);
    if (!latest) { reservation.release(); throw new Error('education_job_not_found'); }
    if (latest.status === 'completed' && latest.result?.execution_mode === 'real' && !latest.stale) { reservation.release(); return latest; }
    if ((latest.attempt_count ?? 1) !== (current.attempt_count ?? 1)) { reservation.release(); return latest; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('gateway_timeout'), EDUCATION_GATEWAY_TIMEOUT_MS);
    const active = this.controllers.get(classroomId) ?? new Set<AbortController>();
    this.controllers.set(classroomId, active); active.add(controller);
    try {
      const bundle = buildClassroomEvidenceBundle({
        snapshot: { ...snapshot, board_events: events, snapshot_sequence: events.length },
        intent: current.kind === 'class_summary' ? 'class_summary' : current.kind === 'practice' ? 'practice' : current.evidence.selection_bbox_norm || current.evidence.selection_region ? 'selected_region' : 'current_step',
        ...(current.evidence.selection_bbox_norm ? { selection_bbox_norm: current.evidence.selection_bbox_norm } : {}),
        ...(current.evidence.selection_region ? { selection_region: current.evidence.selection_region } : {}),
        ...(current.evidence.time_start_ms !== undefined ? { time_start_ms: current.evidence.time_start_ms } : {}),
        ...(current.evidence.time_end_ms !== undefined ? { time_end_ms: current.evidence.time_end_ms } : {}),
      });
      if (bundle.trust_status === 'needs_confirmation') throw new Error('untrusted_formula_evidence');
      const refreshedEvidence = bundle.checkpoint;
      const running: EducationAiJob = {
        ...latest, status: 'running', result: undefined, error_code: undefined, stale: false, evidence: refreshedEvidence,
        attempt_count: (latest.attempt_count ?? 1) + 1, last_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      await this.store.putPrivateRecord(classroomId, participantId, jobId, running);
      const result = await this.gateway(gatewayInput(current.kind, bundle), controller.signal);
      if (isClassroomDeletion(controller.signal) || !await this.store.getClassroom(classroomId)) throw new Error('classroom_not_found');
      if (controller.signal.aborted) throw new Error('education_gateway_timeout');
      const next: EducationAiJob = {
        ...running, status: 'completed', updated_at: new Date().toISOString(), completed_at: new Date().toISOString(), error_code: undefined,
        result: { execution_mode: 'real', title: result.title, sections: mapGatewayResult(result, bundle), review_status: 'kept' },
      };
      await this.store.putPrivateRecord(classroomId, participantId, jobId, next);
      return next;
    } catch (error) {
      if (isClassroomDeletion(controller.signal) || !await this.store.getClassroom(classroomId)) throw new Error('classroom_not_found');
      const failedRetry: EducationAiJob = {
        ...latest,
        attempt_count: (latest.attempt_count ?? 1) + 1,
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error_code: fallbackReason(error) === 'invalid_structured_output' ? 'retry_invalid_structured_output' : 'retry_gateway_unavailable',
      };
      await this.store.putPrivateRecord(classroomId, participantId, jobId, failedRetry);
      return failedRetry;
    } finally {
      clearTimeout(timeout);
      active.delete(controller);
      if (active.size === 0) this.controllers.delete(classroomId);
      reservation.release();
    }
  }

  abortClassroom(classroomId: string): void {
    for (const controller of this.controllers.get(classroomId) ?? []) controller.abort('classroom_deleted');
    this.controllers.delete(classroomId);
    const queue = this.queues.get(classroomId);
    for (const entry of queue?.waiting ?? []) entry.reject(new Error('classroom_not_found'));
    if (queue) queue.waiting.length = 0;
    this.queues.delete(classroomId);
  }
}
