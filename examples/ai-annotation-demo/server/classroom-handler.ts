import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomBoardEventInput, type ClassroomConfirmedFocus, type ClassroomPreview, type ClassroomTeacherView } from 'ink-surface-sdk/runtime-schema';
import type { ClassroomService, ClassroomStreamMessage } from './classroom-service';
import type { ClassroomAuthContext, JsonClassroomStore } from './classroom-store';
import type { ClassroomAiService } from './classroom-ai';
import type { ClassroomLessonService } from './classroom-lesson';
import type { ClassroomRecognitionService } from './classroom-recognition';
import type { ClassroomAudioAuth, ClassroomAudioService } from './classroom-audio';
import type { ClassroomTranscriptionService } from './classroom-transcription';
import { CLASSROOM_MAX_PDF_BYTES, type ClassroomMaterialService } from './classroom-materials';

interface ClassroomHandlerOptions {
  store: JsonClassroomStore;
  service: ClassroomService;
  ai?: ClassroomAiService;
  lesson?: ClassroomLessonService;
  materials?: ClassroomMaterialService;
  recognition?: ClassroomRecognitionService;
  audio?: ClassroomAudioService;
  transcription?: ClassroomTranscriptionService;
  allowOrigins?: string[];
  allowInsecureAudio?: boolean;
  requireSecureTransport?: boolean;
}

const MAX_BODY_BYTES = 512 * 1024;
const JOIN_WINDOW_MS = 60_000;
const JOIN_ATTEMPTS_PER_WINDOW = 12;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new Error('json_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new Error('json_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('json_object_required');
  return parsed as Record<string, unknown>;
}

async function readPdf(req: IncomingMessage): Promise<Uint8Array> {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/pdf')) throw new Error('pdf_required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > CLASSROOM_MAX_PDF_BYTES) throw new Error('pdf_too_large');
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function bearer(req: IncomingMessage): string {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function errorStatus(error: unknown): number {
  const code = String((error as Error)?.message || error).split(':')[0];
  if (code === 'classroom_not_found' || code === 'participant_not_found' || code === 'material_not_found' || code === 'recognition_not_found' || code === 'recording_not_found' || code === 'transcript_not_found' || code === 'transcription_job_not_found' || code === 'education_job_not_found' || code === 'lesson_generation_not_found' || code === 'lesson_candidate_not_found') return 404;
  if (code === 'insufficient_evidence' || code === 'untrusted_formula_evidence') return 422;
  if (code === 'classroom_not_live' || code === 'classroom_not_ended' || code === 'invalid_classroom_transition' || code === 'idempotency_conflict' || code === 'recording_not_active' || code.endsWith('_stale') || code.endsWith('_conflict') || code.endsWith('_drift')) return 409;
  if (code === 'education_queue_full' || code === 'education_rate_limited' || code === 'join_rate_limited' || code === 'audio_signal_rate_limited' || code === 'stroke_rate_limited' || code === 'preview_rate_limited' || code === 'classroom_limit_reached' || code === 'participant_limit_reached' || code === 'stream_limit_reached') return 429;
  if (code === 'page_quota_reached' || code === 'classroom_quota_reached' || code === 'material_quota_reached' || code === 'audio_quota_reached') return 413;
  if (code.startsWith('invalid_') || code.startsWith('pdf_') || code.endsWith('_required') || code.endsWith('_invalid') || code.endsWith('_too_long') || code === 'stroke_too_large' || code === 'body_too_large' || code === 'json_object_required' || code === 'json_required') return 400;
  return 500;
}

function sendSse(res: ServerResponse, event: string, value: unknown, id?: number): boolean {
  const frame = `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  return res.write(frame);
}

function publicStreamPayload(message: ClassroomStreamMessage): Record<string, unknown> {
  if (message.type === 'board_event') return { ...message.board_event, type: message.type };
  if (message.type === 'preview') return { type: message.type, preview: message.preview };
  if (message.type === 'class_state') return { type: message.type, status: message.status };
  if (message.type === 'resync_required') return { type: message.type, reason: message.reason };
  if (message.type === 'teacher_view') return { type: message.type, teacher_view: message.teacher_view };
  if (message.type === 'teacher_view_transient') return { type: message.type, teacher_view: message.teacher_view, interaction_id: message.interaction_id, transient_sequence: message.transient_sequence, base_revision: message.base_revision };
  if (message.type === 'confirmed_focus') return { type: message.type, confirmed_focus: message.confirmed_focus };
  if (message.type === 'material_published') return { type: message.type, material: message.material };
  if (message.type === 'recognition_revision') return { type: message.type, recognition: message.recognition };
  if (message.type === 'recording_state') return { type: message.type, recording: message.recording };
  if (message.type === 'transcript_revision') return { type: message.type, transcript: message.transcript };
  if (message.type === 'transcription_state') return { type: message.type, transcription: message.transcription };
  if (message.type === 'transcripts_cleared') return { type: message.type, cleared_at: message.cleared_at };
  return { type: message.type };
}

export function createClassroomHandler(options: ClassroomHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const origins = new Set(options.allowOrigins ?? []);
  const joinAttempts = new Map<string, { startedAt: number; count: number }>();

  function consumeJoinAttempt(req: IncomingMessage): void {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const current = joinAttempts.get(key);
    if (!current || now - current.startedAt >= JOIN_WINDOW_MS) {
      joinAttempts.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > JOIN_ATTEMPTS_PER_WINDOW) throw new Error('join_rate_limited');
  }

  async function authorize(req: IncomingMessage, classroomId: string, role?: 'teacher' | 'participant'): Promise<ClassroomAuthContext | null> {
    const auth = await options.store.authenticate(bearer(req));
    if (!auth || auth.classroom_id !== classroomId || (role && auth.role !== role)) return null;
    return auth;
  }

  return async function handleClassroom(req, res): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/v1/classrooms')) return false;
    const secureTransport = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    if (options.requireSecureTransport && !secureTransport) {
      sendJson(res, 426, { error: 'https_required' });
      return true;
    }
    const origin = String(req.headers.origin || '');
    const sameOrigin = (() => {
      if (!origin) return true;
      try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
    })();
    if (origin && !sameOrigin && !origins.has(origin)) {
      sendJson(res, 403, { error: 'origin_forbidden' });
      return true;
    }
    if (origin && (sameOrigin || origins.has(origin))) res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization,content-type,idempotency-key,x-material-title');
      res.end();
      return true;
    }

    try {
      if (req.method === 'POST' && url.pathname === '/v1/classrooms') {
        const body = await readJson(req);
        sendJson(res, 201, await options.store.createClassroom(String(body.title || '')));
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/v1/classrooms/join') {
        consumeJoinAttempt(req);
        const body = await readJson(req);
        const joined = await options.store.joinClassroom(String(body.class_code || ''), String(body.nickname || ''));
        sendJson(res, 201, { classroom: joined.classroom, participant_id: joined.participant_id, participant_credential: joined.credential });
        return true;
      }

      const jobMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/education-jobs(?:\/([A-Za-z0-9_-]+)(?:\/(review|retry))?)?$/);
      if (jobMatch) {
        const [, classroomId, jobId, jobAction] = jobMatch;
        const auth = await authorize(req, classroomId, 'participant');
        if (!auth?.participant_id) { sendJson(res, 404, { error: 'education_job_not_found' }); return true; }
        if (!options.ai) { sendJson(res, 503, { error: 'education_ai_unavailable' }); return true; }
        if (!jobId && req.method === 'POST') {
          const body = await readJson(req);
          sendJson(res, 201, { job: await options.ai.createAndRun(classroomId, auth.participant_id, {
            kind: String(body.kind || '') as 'live_explanation' | 'class_summary' | 'practice',
            client_request_id: String(body.client_request_id || ''),
            ...(Array.isArray(body.selection_bbox_norm) ? { selection_bbox_norm: body.selection_bbox_norm as [number, number, number, number] } : {}),
            ...(body.selection_region && typeof body.selection_region === 'object' ? { selection_region: body.selection_region as Parameters<ClassroomAiService['createAndRun']>[2]['selection_region'] } : {}),
            ...(typeof body.evidence_intent === 'string' ? { evidence_intent: body.evidence_intent as 'current_step' | 'selected_region' | 'missed_segment' } : {}),
            ...(Number.isFinite(body.trigger_time_ms) ? { trigger_time_ms: Number(body.trigger_time_ms) } : {}),
            ...(Number.isFinite(body.time_start_ms) ? { time_start_ms: Number(body.time_start_ms) } : {}),
            ...(Number.isFinite(body.time_end_ms) ? { time_end_ms: Number(body.time_end_ms) } : {}),
          }) });
          return true;
        }
        if (!jobId && req.method === 'GET') {
          sendJson(res, 200, { jobs: await options.ai.list(classroomId, auth.participant_id, url.searchParams.get('include_dismissed') === '1') });
          return true;
        }
        if (jobId && !jobAction && req.method === 'GET') {
          const job = await options.ai.get(classroomId, auth.participant_id, jobId);
          if (!job) { sendJson(res, 404, { error: 'education_job_not_found' }); return true; }
          sendJson(res, 200, { job }); return true;
        }
        if (jobId && jobAction === 'review' && req.method === 'POST') {
          const body = await readJson(req);
          sendJson(res, 200, { job: await options.ai.review(classroomId, auth.participant_id, jobId, {
            status: String(body.status || '') as 'kept' | 'edited' | 'dismissed', user_edit: body.user_edit === undefined ? undefined : String(body.user_edit),
          }) });
          return true;
        }
        if (jobId && jobAction === 'retry' && req.method === 'POST') {
          sendJson(res, 200, { job: await options.ai.retry(classroomId, auth.participant_id, jobId) }); return true;
        }
        sendJson(res, 405, { error: 'method_not_allowed' }); return true;
      }

      const lessonMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/lesson(?:\/candidates\/([A-Za-z0-9_-]+)\/review)?$/);
      if (lessonMatch) {
        const [, classroomId, candidateId] = lessonMatch;
        if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
        if (!options.lesson) { sendJson(res, 503, { error: 'lesson_ai_unavailable' }); return true; }
        if (!candidateId && req.method === 'GET') { sendJson(res, 200, { lesson: await options.lesson.get(classroomId) }); return true; }
        if (!candidateId && req.method === 'POST') { sendJson(res, 201, { lesson: await options.lesson.generate(classroomId) }); return true; }
        if (candidateId && req.method === 'POST') {
          const body = await readJson(req);
          sendJson(res, 200, { lesson: await options.lesson.review(classroomId, candidateId, {
            status: String(body.status || '') as 'accepted' | 'edited' | 'dismissed', content: body.content === undefined ? undefined : String(body.content),
          }) });
          return true;
        }
        sendJson(res, 405, { error: 'method_not_allowed' }); return true;
      }

      const materialMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/materials(?:\/([A-Za-z0-9_-]+))?$/);
      if (materialMatch) {
        const [, classroomId, materialId] = materialMatch;
        if (!options.materials) { sendJson(res, 503, { error: 'classroom_materials_unavailable' }); return true; }
        if (materialId === 'builtin' && req.method === 'POST') {
          if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const result = await options.materials.publishBuiltin(classroomId);
          sendJson(res, result.inserted ? 201 : 200, result);
          return true;
        }
        if (!materialId && req.method === 'POST') {
          if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const key = String(req.headers['idempotency-key'] || '');
          const result = await options.materials.publish(classroomId, {
            bytes: await readPdf(req),
            title: decodeURIComponent(String(req.headers['x-material-title'] || '课堂讲义')),
            idempotencyKey: key,
          });
          sendJson(res, result.inserted ? 201 : 200, result);
          return true;
        }
        if (!materialId && req.method === 'GET') {
          if (!await authorize(req, classroomId)) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
          sendJson(res, 200, { materials: (await options.store.getSharedState(classroomId)).materials });
          return true;
        }
        if (materialId && req.method === 'GET') {
          if (!await authorize(req, classroomId)) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
          const material = await options.store.getMaterial(classroomId, materialId);
          const bytes = material ? await options.store.getMaterialBytes(classroomId, materialId) : null;
          if (!material || !bytes) { sendJson(res, 404, { error: 'material_not_found' }); return true; }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/pdf');
          res.setHeader('content-length', String(bytes.byteLength));
          res.setHeader('cache-control', 'private, no-store');
          res.end(bytes);
          return true;
        }
        sendJson(res, 405, { error: 'method_not_allowed' }); return true;
      }

      const projectionMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/(teacher-view|teacher-view-transient|confirmed-focus)$/);
      if (projectionMatch) {
        const [, classroomId, projection] = projectionMatch;
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
        if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
        const body = await readJson(req);
        if (projection === 'teacher-view-transient') {
          const value = await options.service.updateTransientTeacherView(classroomId, {
            teacher_view: { ...(body.teacher_view as object), schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId } as ClassroomTeacherView,
            interaction_id: String(body.interaction_id || ''), transient_sequence: Number(body.transient_sequence), base_revision: Number(body.base_revision), final: body.final === true,
          });
          sendJson(res, 200, value); return true;
        }
        if (projection === 'teacher-view') {
          const teacherView = await options.service.updateTeacherView(classroomId, { ...body, schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId } as unknown as ClassroomTeacherView);
          sendJson(res, 200, { teacher_view: teacherView });
        } else {
          const confirmedFocus = await options.service.confirmFocus(classroomId, { ...body, schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId } as unknown as ClassroomConfirmedFocus);
          sendJson(res, 200, { confirmed_focus: confirmedFocus });
        }
        return true;
      }

      const recognitionMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/recognitions(?:\/([A-Za-z0-9_-]+)\/review)?$/);
      if (recognitionMatch) {
        const [, classroomId, recognitionId] = recognitionMatch;
        if (!options.recognition) { sendJson(res, 503, { error: 'classroom_recognition_unavailable' }); return true; }
        if (!recognitionId && req.method === 'GET') {
          if (!await authorize(req, classroomId)) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
          sendJson(res, 200, { recognitions: await options.recognition.list(classroomId) }); return true;
        }
        if (!recognitionId && req.method === 'POST') {
          if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const body = await readJson(req);
          const recognition = await options.recognition.recognize(classroomId, body as unknown as Parameters<ClassroomRecognitionService['recognize']>[1]);
          options.service.publishRecognition(classroomId, recognition); sendJson(res, 201, { recognition }); return true;
        }
        if (recognitionId && req.method === 'POST') {
          if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const body = await readJson(req);
          const recognition = await options.recognition.review(classroomId, recognitionId, body as unknown as Parameters<ClassroomRecognitionService['review']>[2]);
          options.service.publishRecognition(classroomId, recognition); sendJson(res, 200, { recognition }); return true;
        }
        sendJson(res, 405, { error: 'method_not_allowed' }); return true;
      }

      const transcriptMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/transcripts(?:\/([A-Za-z0-9_-]+)\/(correct|retry))?$/);
      if (transcriptMatch) {
        const [, classroomId, transcriptId, action] = transcriptMatch;
        const auth = await authorize(req, classroomId);
        if (!auth) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
        if (!options.transcription) { sendJson(res, 503, { error: 'classroom_transcription_unavailable' }); return true; }
        if (!transcriptId && req.method === 'GET') {
          sendJson(res, 200, { transcripts: await options.store.listTranscriptRevisions(classroomId), transcription: await options.store.getTranscriptionState(classroomId), processing_mode: options.transcription.processingMode }); return true;
        }
        if (!transcriptId && req.method === 'DELETE') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const marker = await options.transcription.clear(classroomId);
          sendJson(res, 200, { cleared_at: marker.cleared_at }); return true;
        }
        if (action === 'correct' && req.method === 'POST') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const body = await readJson(req); sendJson(res, 200, { transcript: await options.transcription.correct(classroomId, transcriptId, String(body.text || '')) }); return true;
        }
        if (action === 'retry' && req.method === 'POST') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          sendJson(res, 200, { transcripts: await options.transcription.retryChunk(classroomId, transcriptId) }); return true;
        }
        sendJson(res, 405, { error: 'method_not_allowed' }); return true;
      }

      const audioMatch = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)\/audio\/(signals|recording)(?:\/([A-Za-z0-9_-]+))?(?:\/(chunks|stop))?$/);
      if (audioMatch) {
        const [, classroomId, resource, recordingId, recordingAction] = audioMatch;
        if (!options.audio) { sendJson(res, 503, { error: 'classroom_audio_unavailable' }); return true; }
        if (!secureTransport && !options.allowInsecureAudio) { sendJson(res, 426, { error: 'https_required' }); return true; }
        const auth = await authorize(req, classroomId);
        if (!auth) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
        const audioAuth: ClassroomAudioAuth = auth.role === 'teacher' ? { role: 'teacher' } : { role: 'participant', participant_id: auth.participant_id! };
        if (resource === 'signals' && req.method === 'GET') {
          const cursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
          sendJson(res, 200, await options.audio.signals(classroomId, audioAuth, cursor)); return true;
        }
        if (resource === 'signals' && req.method === 'POST') {
          const body = await readJson(req);
          sendJson(res, 201, { signal: await options.audio.signal(classroomId, audioAuth, body as unknown as Parameters<ClassroomAudioService['signal']>[2]) }); return true;
        }
        if (resource === 'recording' && !recordingId && req.method === 'GET') {
          sendJson(res, 200, { recording: await options.audio.current(classroomId) }); return true;
        }
        if (resource === 'recording' && !recordingId && req.method === 'DELETE') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const transcription = await options.store.deleteAudio(classroomId);
          if (transcription) options.service.publishTranscription(classroomId, transcription);
          sendJson(res, 200, { deleted: true, transcription }); return true;
        }
        if (resource === 'recording' && recordingId === 'start' && req.method === 'POST') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const recording = await options.audio.start(classroomId); options.service.publishRecording(classroomId, recording); sendJson(res, 201, { recording }); return true;
        }
        if (resource === 'recording' && recordingId && recordingAction === 'chunks' && req.method === 'POST') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const body = await readJson(req);
          const result = await options.audio.appendChunk(classroomId, { ...body, recording_id: recordingId } as unknown as Parameters<ClassroomAudioService['appendChunk']>[1]); options.service.publishRecording(classroomId, result.recording); sendJson(res, 200, result); return true;
        }
        if (resource === 'recording' && recordingId && recordingAction === 'stop' && req.method === 'POST') {
          if (auth.role !== 'teacher') { sendJson(res, 403, { error: 'forbidden' }); return true; }
          const body = await readJson(req);
          const recording = await options.audio.stop(classroomId, recordingId, Number(body.recording_generation), body.health === 'incomplete' ? 'incomplete' : undefined); options.service.publishRecording(classroomId, recording); sendJson(res, 200, { recording }); return true;
        }
        sendJson(res, 405, { error: 'method_not_allowed' }); return true;
      }

      const match = url.pathname.match(/^\/v1\/classrooms\/([A-Za-z0-9_-]+)(?:\/(start|end|events|preview|snapshot|stream))?$/);
      if (!match) return false;
      const [, classroomId, action] = match;
      if ((action === 'start' || action === 'end') && req.method === 'POST') {
        if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
        if (action === 'end') {
          const recording = await options.audio?.stopCurrent(classroomId);
          if (recording) options.service.publishRecording(classroomId, recording);
        }
        sendJson(res, 200, { classroom: await options.service.transition(classroomId, action === 'start' ? 'live' : 'ended') });
        return true;
      }
      if (action === 'events' && req.method === 'POST') {
        if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
        const body = await readJson(req) as unknown as ClassroomBoardEventInput;
        const accepted = await options.service.appendBoardEvent(classroomId, { ...body, schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId });
        sendJson(res, 200, { board_event: accepted.event, inserted: accepted.inserted });
        return true;
      }
      if (action === 'preview' && req.method === 'POST') {
        if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
        const body = await readJson(req) as unknown as ClassroomPreview;
        await options.service.publishPreview(classroomId, { ...body, schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId });
        sendJson(res, 202, { ok: true });
        return true;
      }
      if (action === 'snapshot' && req.method === 'GET') {
        if (!await authorize(req, classroomId)) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
        sendJson(res, 200, await options.store.getSnapshot(classroomId));
        return true;
      }
      if (action === 'stream' && req.method === 'GET') {
        if (!await authorize(req, classroomId)) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
        const cursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
        if (!Number.isInteger(cursor) || cursor < 0) { sendJson(res, 400, { error: 'invalid_cursor' }); return true; }
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let responseStarted = false;
        const subscription = await options.service.subscribe(classroomId, cursor, (message) => {
          if (!responseStarted) {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
            responseStarted = true;
          }
          return sendSse(res, message.type, publicStreamPayload(message), message.type === 'board_event' ? message.sequence : undefined);
        }, () => {
          if (heartbeat) clearInterval(heartbeat);
          if (!res.writableEnded) res.end();
        });
        if (!responseStarted) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
          responseStarted = true;
        }
        sendSse(res, 'ready', { classroom_id: classroomId, cursor });
        heartbeat = setInterval(() => sendSse(res, 'ping', { t: Date.now() }), 25_000);
        req.on('close', () => subscription.close());
        return true;
      }
      if (!action && req.method === 'DELETE') {
        if (!await authorize(req, classroomId, 'teacher')) { sendJson(res, 403, { error: 'forbidden' }); return true; }
        options.ai?.abortClassroom(classroomId);
        options.lesson?.abortClassroom(classroomId);
        options.audio?.clearClassroom(classroomId);
        options.transcription?.abortClassroom(classroomId);
        await options.service.deleteClassroom(classroomId);
        sendJson(res, 200, { ok: true, deleted: true });
        return true;
      }
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    } catch (error) {
      sendJson(res, errorStatus(error), { error: String((error as Error)?.message || error).split(':')[0] });
      return true;
    }
  };
}
