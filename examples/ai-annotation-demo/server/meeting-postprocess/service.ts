import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { buildEvidenceSnapshot } from './evidence-snapshot';
import { normalizeMeetingEnded } from './ended-adapters';
import type { EvidenceSnapshot, HandwritingEvidence, MeetingUserGuidance, MeetingUtterance, PostprocessConfiguration, PostprocessRun } from './contracts';
import { meetingUserGuidanceSchema, POSTPROCESS_SCHEMA_VERSION, postprocessConfigurationSchema } from './contracts';
import type { JsonGenerator } from './brief-v2';
import { MeetingPostprocessScheduler } from './scheduler';
import { MeetingPostprocessStore, readPostprocessStoreIdentity } from './store';
import { streamPostprocessEvents } from './event-stream';
import { deleteProviderMeetingRegistration, registerProviderMeetings } from './provider-registry';
import { MEETING_TEMPLATE_IDS, type MeetingTemplateId } from './templates';
import { meetingTemplate } from './templates';
import { sha256 } from './identity';

export interface MeetingPostprocessIdentity { tenant_id: string; user_id: string }
export interface MeetingPostprocessServiceOptions { root: string; generate: JsonGenerator; execution_timeout_ms?: number; readBody(req: IncomingMessage, maxBytes?: number): Promise<string>; resolveIdentity(req: IncomingMessage, res: ServerResponse): Promise<MeetingPostprocessIdentity | null>; deleteMeetingMedia?(identity: MeetingPostprocessIdentity, meetingId: string): Promise<{ command_id: string; cloud_sessions_deleted: number; pending_companion: boolean }>; deleteMeetingRuntime?(identity: MeetingPostprocessIdentity, meetingId: string): Promise<{ runtime_events: number; knowledge_records: number }> }
const runtimes = new Map<string, { store: MeetingPostprocessStore; scheduler: MeetingPostprocessScheduler }>();
const streamCounts = new Map<string, number>();
const meetingDeletionLocks = new Map<string, Promise<void>>();
const MAX_ACTIVE_RUNS = 100;
const MAX_STREAMS_PER_IDENTITY = 4;
const MAX_EVENT_REPLAY = 1_000;
function runtime(options: Pick<MeetingPostprocessServiceOptions, 'root' | 'generate' | 'execution_timeout_ms'>, identity: MeetingPostprocessIdentity): { store: MeetingPostprocessStore; scheduler: MeetingPostprocessScheduler } {
  const key = `${resolve(options.root)}\u0000${identity.tenant_id}\u0000${identity.user_id}`;
  const prior = runtimes.get(key); if (prior) return prior;
  const store = new MeetingPostprocessStore(resolve(options.root), identity);
  const created = {
    store,
    scheduler: new MeetingPostprocessScheduler(
      store,
      options.generate,
      () => new Date(),
      undefined,
      options.execution_timeout_ms,
    ),
  };
  runtimes.set(key, created); return created;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); }
function clean(value: unknown, max = 256): string { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
async function withMeetingDeletionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = meetingDeletionLocks.get(key) || Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = prior.then(() => gate);
  meetingDeletionLocks.set(key, tail);
  await prior;
  try { return await work(); }
  finally {
    release();
    if (meetingDeletionLocks.get(key) === tail) meetingDeletionLocks.delete(key);
  }
}
function guidanceList(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => clean(item, 1_000)).filter(Boolean).slice(0, 20) : typeof value === 'string' ? value.split(/\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 20) : []; }
function parseUserGuidance(value: unknown): MeetingUserGuidance {
  const guidance = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return meetingUserGuidanceSchema.parse({ source: 'user_supplied', conclusions: guidanceList(guidance.conclusions), deepest_impressions: guidanceList(guidance.deepest_impressions), pain_points: guidanceList(guidance.pain_points) });
}

function buildConfiguration(input: MeetingPostprocessIdentity & { meeting_id: string; occurrence_id: string; template_id: MeetingTemplateId; user_guidance: MeetingUserGuidance; revision: number; now?: Date }): PostprocessConfiguration {
  const template = meetingTemplate(input.template_id);
  const fingerprint = sha256({ template_id: template.id, template_version: template.version, user_guidance: input.user_guidance });
  return postprocessConfigurationSchema.parse({ ...input, schema_version: POSTPROCESS_SCHEMA_VERSION, configuration_id: `configuration_${sha256({ tenant_id: input.tenant_id, user_id: input.user_id, meeting_id: input.meeting_id, occurrence_id: input.occurrence_id, revision: input.revision, fingerprint }).slice(0, 24)}`, fingerprint, template_id: template.id, template_version: template.version, submitted_at: (input.now || new Date()).toISOString() });
}

function latestSnapshot(store: MeetingPostprocessStore, meeting_id: string, occurrence_id: string): EvidenceSnapshot | undefined {
  return store.listSnapshots({ meeting_id, occurrence_id }).sort((a, b) => a.revision - b.revision || a.created_at.localeCompare(b.created_at)).at(-1);
}

function rebuildSnapshot(previous: EvidenceSnapshot, configuration: PostprocessConfiguration, revision: number): EvidenceSnapshot {
  const transcriptFinal = !previous.missing_reasons.some((reason) => reason === 'transcript_pending' || reason === 'transcript_partial');
  const ocrStatus = previous.missing_reasons.includes('ocr_failed') ? 'failed' : previous.missing_reasons.includes('ocr_pending') ? 'pending' : previous.handwriting.length ? 'ready' : 'not_applicable';
  return buildEvidenceSnapshot({ ...previous, revision, transcript_final: transcriptFinal, transcript_converged: previous.transcript_converged, transcript_missing_chunk_ids: previous.missing_chunk_ids, template_id: configuration.template_id, user_guidance: configuration.user_guidance, ocr_status: ocrStatus, started_at_ms: previous.started_at_ms ?? undefined, ended_at_ms: previous.ended_at_ms ?? undefined, utterances: previous.utterances, handwriting: previous.handwriting });
}

type PostprocessGateResult = { status: 'awaiting_configuration' | 'awaiting_transcript' | 'queued'; snapshot: EvidenceSnapshot; run?: PostprocessRun; reused_artifacts: number };
async function passPostprocessGate(input: { store: MeetingPostprocessStore; scheduler: MeetingPostprocessScheduler; snapshot: EvidenceSnapshot; configuration?: PostprocessConfiguration }): Promise<PostprocessGateResult> {
  const configuration = input.configuration || input.store.getCurrentConfiguration(input.snapshot);
  if (!configuration) return { status: 'awaiting_configuration', snapshot: input.snapshot, reused_artifacts: 0 };
  const desired = rebuildSnapshot(input.snapshot, configuration, Math.max(input.snapshot.revision + 1, ...input.store.listSnapshots(input.snapshot).map((item) => item.revision + 1)));
  const snapshot = await input.store.saveSnapshot(desired);
  if (!snapshot.transcript_converged) return { status: 'awaiting_transcript', snapshot, reused_artifacts: 0 };
  if (!snapshot.utterances.length && !snapshot.handwriting.length) return { status: 'awaiting_transcript', snapshot, reused_artifacts: 0 };
  const artifactKind = snapshot.template_id === 'interview_archive' ? 'meeting.interview_archive_html' : 'meeting.summary_cards';
  const duplicate = input.store.listRuns(snapshot).some((run) => run.artifact_kind === artifactKind && input.store.getSnapshot(run.snapshot_id)?.fingerprint === snapshot.fingerprint);
  const activeRuns = input.store.listRuns().filter((run) => run.status === 'queued' || run.status === 'running').length;
  if (!duplicate && activeRuns >= MAX_ACTIVE_RUNS) throw Object.assign(new Error('postprocess_queue_capacity_exceeded'), { status: 429 });
  const reused_artifacts = await input.store.selectCurrentSnapshot(snapshot, snapshot.snapshot_id);
  const run = await input.scheduler.enqueue(snapshot, artifactKind, { title: snapshot.meeting_title, select_current: false });
  queueMicrotask(() => input.scheduler.drain().catch((error) => console.warn('[meeting-postprocess] drain failed', String(error))));
  return { status: 'queued', snapshot, run, reused_artifacts };
}

export function createMeetingPostprocessService(options: MeetingPostprocessServiceOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://inkloop.local');
    if (!url.pathname.startsWith('/api/meeting-postprocess/')) return false;
    const identity = await options.resolveIdentity(req, res); if (!identity) return true;
    const { store, scheduler } = runtime(options, identity);
    try {
      if (url.pathname === '/api/meeting-postprocess/runs' && req.method === 'POST') {
        const body = JSON.parse(await options.readBody(req, 4 * 1024 * 1024)) as Record<string, unknown>;
        const meeting_id = clean(body.meeting_id); if (!meeting_id) throw Object.assign(new Error('meeting_id_required'), { status: 400 });
        if (store.isMeetingDeleted(meeting_id)) throw Object.assign(new Error('meeting_deleted'), { status: 410 });
        const ended = normalizeMeetingEnded({ ...identity, meeting_id, platform: clean(body.platform, 64), provider_meeting_id: clean(body.provider_meeting_id), started_at_ms: Number(body.started_at_ms) || undefined, ended_at_ms: Number(body.ended_at_ms) || undefined, source: (['mtl', 'lark', 'google', 'zoom', 'local'].includes(String(body.source)) ? body.source : 'local') as 'mtl' | 'lark' | 'google' | 'zoom' | 'local' });
        const previousRevision = Math.max(0, ...store.listSnapshots({ meeting_id, occurrence_id: ended.occurrence_id }).map((snapshot) => snapshot.revision));
        const title = clean(body.title, 300) || '(未命名会议)';
        const configuration = store.getCurrentConfiguration({ ...identity, meeting_id, occurrence_id: ended.occurrence_id });
        const previous = latestSnapshot(store, meeting_id, ended.occurrence_id);
        // This route is a device evidence ingress. A device may upload useful live cues, but it
        // cannot attest that the transcript is complete: only the InkLoop Meeting Media formalizer
        // may cross the convergence gate through enqueueEndedMeeting(). Platform workers never can. Keep the
        // legacy final/converged fields backward-compatible by ignoring them instead of rejecting
        // an otherwise useful evidence upload.
        // A late device upload must not downgrade or replace a transcript that a trusted server
        // source already converged. It may still add a newer handwriting/OCR revision.
        const trustedTranscript = previous?.transcript_converged === true ? previous : undefined;
        const trustedTranscriptFinal = !!trustedTranscript && !trustedTranscript.missing_reasons.some((reason) => reason === 'transcript_pending' || reason === 'transcript_partial');
        const snapshot = buildEvidenceSnapshot({ ...identity, meeting_id, occurrence_id: ended.occurrence_id, meeting_title: title, revision: Number(body.revision) || previousRevision + 1, transcript_final: trustedTranscriptFinal, transcript_converged: !!trustedTranscript, transcript_missing_chunk_ids: trustedTranscript?.missing_chunk_ids || (Array.isArray(body.transcript_missing_chunk_ids) ? body.transcript_missing_chunk_ids.map((item) => clean(item)).filter(Boolean) : []), template_id: configuration?.template_id, user_guidance: configuration?.user_guidance, ocr_status: (['ready', 'pending', 'failed', 'not_applicable'].includes(String(body.ocr_status)) ? body.ocr_status : 'pending') as 'ready' | 'pending' | 'failed' | 'not_applicable', started_at_ms: ended.started_at_ms, ended_at_ms: ended.ended_at_ms, utterances: trustedTranscript?.utterances || (Array.isArray(body.utterances) ? body.utterances as MeetingUtterance[] : transcriptUtterances(clean(body.transcript, 2_000_000))), handwriting: Array.isArray(body.handwriting) ? body.handwriting as HandwritingEvidence[] : previous?.handwriting || [] });
        const saved = await store.saveSnapshot(snapshot);
        const gated = await passPostprocessGate({ store, scheduler, snapshot: saved, configuration });
        sendJson(res, 202, { status: gated.status, run: gated.run, occurrence_id: ended.occurrence_id, snapshot: { snapshot_id: gated.snapshot.snapshot_id, finality: gated.snapshot.finality, missing_reasons: gated.snapshot.missing_reasons, transcript_converged: gated.snapshot.transcript_converged } }); return true;
      }
      if (url.pathname === '/api/meeting-postprocess/provider-registrations' && req.method === 'POST') {
        const body = JSON.parse(await options.readBody(req, 1024 * 1024)) as { meetings?: Array<Record<string, unknown>> };
        const meetings = (Array.isArray(body.meetings) ? body.meetings : []).slice(0, 500).map((item) => ({
          meeting_id: clean(item.meeting_id), provider: clean(item.provider) as 'lark' | 'google' | 'zoom', title: clean(item.title, 300) || '(未命名会议)',
          provider_meeting_id: clean(item.provider_meeting_id) || undefined, provider_calendar_event_id: clean(item.provider_calendar_event_id) || undefined, provider_space_name: clean(item.provider_space_name) || undefined, meeting_code: clean(item.meeting_code, 128) || undefined,
          scheduled_at: clean(item.scheduled_at), scheduled_end_at: clean(item.scheduled_end_at) || undefined, started_at: clean(item.started_at) || undefined, ended_at: clean(item.ended_at) || undefined, status: clean(item.status) as 'upcoming' | 'live' | 'ended',
        }));
        if (meetings.some((item) => !item.meeting_id || !['lark', 'google', 'zoom'].includes(item.provider))) throw Object.assign(new Error('provider_registration_invalid'), { status: 400 });
        if (meetings.some((item) => store.isMeetingDeleted(item.meeting_id))) throw Object.assign(new Error('meeting_deleted'), { status: 410 });
        sendJson(res, 200, { registrations: await registerProviderMeetings(options.root, identity, meetings) }); return true;
      }
      if (url.pathname === '/api/meeting-postprocess/full-report' && req.method === 'POST') {
        sendJson(res, 410, { error: { code: 'full_report_retired' } }); return true;
      }
      if ((url.pathname === '/api/meeting-postprocess/configuration' || url.pathname === '/api/meeting-postprocess/template') && req.method === 'POST') {
        const body = JSON.parse(await options.readBody(req, 1024 * 1024)) as Record<string, unknown>;
        const meeting_id = clean(body.meeting_id); if (!meeting_id) throw Object.assign(new Error('meeting_id_required'), { status: 400 });
        if (store.isMeetingDeleted(meeting_id)) throw Object.assign(new Error('meeting_deleted'), { status: 410 });
        const template_id = String(body.template_id) as MeetingTemplateId;
        if (!MEETING_TEMPLATE_IDS.includes(template_id)) throw Object.assign(new Error('meeting_template_invalid'), { status: 400 });
        const occurrence_id = clean(body.occurrence_id);
        if (!occurrence_id) throw Object.assign(new Error('occurrence_id_required'), { status: 400 });
        const previous = latestSnapshot(store, meeting_id, occurrence_id);
        if (!previous && url.pathname.endsWith('/template')) throw Object.assign(new Error('meeting_evidence_snapshot_required'), { status: 409 });
        const previousConfiguration = store.getCurrentConfiguration({ ...identity, meeting_id, occurrence_id });
        const user_guidance = url.pathname.endsWith('/template') ? previousConfiguration?.user_guidance || parseUserGuidance(undefined) : parseUserGuidance(body.user_guidance);
        const nextRevision = Math.max(0, ...store.listConfigurations({ ...identity, meeting_id, occurrence_id }).map((item) => item.revision)) + 1;
        const candidate = buildConfiguration({ ...identity, meeting_id, occurrence_id, template_id, user_guidance, revision: nextRevision });
        const savedConfiguration = previousConfiguration?.fingerprint === candidate.fingerprint ? previousConfiguration : await store.saveConfiguration(candidate);
        if (!previous) {
          sendJson(res, 202, { status: 'awaiting_transcript', configuration: savedConfiguration, occurrence_id }); return true;
        }
        const gated = await passPostprocessGate({ store, scheduler, snapshot: previous, configuration: savedConfiguration });
        sendJson(res, 202, { status: gated.status, configuration: savedConfiguration, run: gated.run, reused_artifacts: gated.reused_artifacts, snapshot: { snapshot_id: gated.snapshot.snapshot_id, template_id: gated.snapshot.template_id, template_version: gated.snapshot.template_version, finality: gated.snapshot.finality } }); return true;
      }
      if (url.pathname === '/api/meeting-postprocess/drain' && req.method === 'POST') { sendJson(res, 200, { completed: await scheduler.drain() }); return true; }
      const meeting_id = clean(url.searchParams.get('meeting_id')); if (!meeting_id) throw Object.assign(new Error('meeting_id_required'), { status: 400 });
      const scope = { ...identity, meeting_id, occurrence_id: clean(url.searchParams.get('occurrence_id')) || undefined };
      if (store.isMeetingDeleted(meeting_id) && req.method !== 'DELETE') throw Object.assign(new Error('meeting_deleted'), { status: 410 });
      if (url.pathname === '/api/meeting-postprocess/configuration' && req.method === 'GET') {
        if (!scope.occurrence_id) throw Object.assign(new Error('occurrence_id_required'), { status: 400 });
        const configuration = store.getCurrentConfiguration({ ...scope, occurrence_id: scope.occurrence_id });
        const snapshot = latestSnapshot(store, meeting_id, scope.occurrence_id);
        sendJson(res, 200, { status: !configuration ? 'awaiting_configuration' : !snapshot?.transcript_converged ? 'awaiting_transcript' : 'configured', configuration }); return true;
      }
      if ((url.pathname === '/api/meeting-postprocess/artifacts' || url.pathname === '/api/meeting-postprocess/runs' || url.pathname === '/api/meeting-postprocess/events') && req.method === 'GET' && !scope.occurrence_id) throw Object.assign(new Error('occurrence_id_required'), { status: 400 });
      if (url.pathname === '/api/meeting-postprocess/artifacts' && req.method === 'GET') { sendJson(res, 200, { artifacts: store.listArtifacts(scope).filter((x) => x.status === 'ready') }); return true; }
      if (url.pathname === '/api/meeting-postprocess/runs' && req.method === 'GET') { sendJson(res, 200, { runs: store.listRuns(scope) }); return true; }
      if (url.pathname === '/api/meeting-postprocess/artifacts' && req.method === 'DELETE') {
        const registrations = await deleteProviderMeetingRegistration(options.root, identity, meeting_id);
        const deleted = await store.deleteMeeting(meeting_id);
        sendJson(res, 200, { deleted: { ...deleted, registrations } }); return true;
      }
      if (url.pathname === '/api/meeting-postprocess/meeting' && req.method === 'DELETE') {
        const deletionKey = `${resolve(options.root)}\u0000${identity.tenant_id}\u0000${identity.user_id}\u0000${meeting_id}`;
        const result = await withMeetingDeletionLock(deletionKey, async () => {
          const prior = store.getMeetingDeletion(meeting_id);
          if (prior?.status === 'completed' && prior.counts) {
            const media = options.deleteMeetingMedia
              ? await options.deleteMeetingMedia(identity, meeting_id)
              : { command_id: prior.command_id, cloud_sessions_deleted: 0, pending_companion: false };
            return { deleted: prior.counts, command_id: prior.command_id, cloud_sessions_deleted: media.cloud_sessions_deleted, pending_companion: media.pending_companion, replay: true };
          }
          await store.requestMeetingDeletion(
            meeting_id,
            prior?.command_id
              || `postprocess_delete_${sha256({ ...identity, meeting_id }).slice(0, 24)}`,
          );
          const media = options.deleteMeetingMedia
            ? await options.deleteMeetingMedia(identity, meeting_id)
            : { command_id: `postprocess_delete_${sha256({ ...identity, meeting_id }).slice(0, 24)}`, cloud_sessions_deleted: 0, pending_companion: false };
          const runtimeDeleted = await options.deleteMeetingRuntime?.(identity, meeting_id) || { runtime_events: 0, knowledge_records: 0 };
          const registrations = await deleteProviderMeetingRegistration(options.root, identity, meeting_id);
          const deleted = await store.deleteMeeting(meeting_id, { command_id: media.command_id, registrations });
          return { deleted, command_id: media.command_id, cloud_sessions_deleted: media.cloud_sessions_deleted, pending_companion: media.pending_companion, runtime_deleted: runtimeDeleted, replay: false };
        });
        sendJson(res, 200, result); return true;
      }
      if (url.pathname === '/api/meeting-postprocess/events' && req.method === 'GET') {
        if (String(req.headers.accept || '').includes('text/event-stream')) {
          const streamKey = `${resolve(options.root)}\u0000${identity.tenant_id}\u0000${identity.user_id}`;
          const count = streamCounts.get(streamKey) || 0;
          if (count >= MAX_STREAMS_PER_IDENTITY) throw Object.assign(new Error('postprocess_stream_capacity_exceeded'), { status: 429 });
          streamCounts.set(streamKey, count + 1);
          const release = () => { const next = (streamCounts.get(streamKey) || 1) - 1; if (next > 0) streamCounts.set(streamKey, next); else streamCounts.delete(streamKey); };
          try { streamPostprocessEvents({ req, res, store, scope: { ...scope, occurrence_id: scope.occurrence_id || '' }, on_close: release }); }
          catch (error) { release(); throw error; }
        } else {
          const events = store.listEvents({ ...scope, occurrence_id: scope.occurrence_id || '' }, Number(url.searchParams.get('after')) || 0);
          sendJson(res, 200, { events: events.slice(-MAX_EVENT_REPLAY), truncated: events.length > MAX_EVENT_REPLAY });
        }
        return true;
      }
      sendJson(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: { code: req.method === 'GET' || req.method === 'POST' ? 'postprocess_route_not_found' : 'method_not_allowed' } }); return true;
    } catch (error) { sendJson(res, Number((error as { status?: number }).status) || 500, { error: { code: String((error as Error).message || error) } }); return true; }
  };
}

export async function enqueueEndedMeeting(input: { options: Pick<MeetingPostprocessServiceOptions, 'root' | 'generate'>; identity: MeetingPostprocessIdentity; meeting_id: string; title: string; platform?: string; provider_meeting_id?: string; started_at_ms?: number; ended_at_ms?: number; source: 'mtl' | 'lark' | 'google' | 'zoom' | 'local'; transcript_origin?: 'inkloop_media' | 'platform'; transcript_final?: boolean; transcript_converged?: boolean; transcript_missing_chunk_ids?: string[]; ocr_status?: 'ready' | 'pending' | 'failed' | 'not_applicable'; utterances?: SnapshotUtterance[]; handwriting?: HandwritingEvidence[] }): Promise<{ status: PostprocessGateResult['status']; occurrence_id: string; run_id?: string; snapshot_id: string }> {
  if (runtime(input.options, input.identity).store.isMeetingDeleted(input.meeting_id)) throw Object.assign(new Error('meeting_deleted'), { status: 410 });
  const ended = normalizeMeetingEnded({ ...input.identity, meeting_id: input.meeting_id, platform: input.platform, provider_meeting_id: input.provider_meeting_id, started_at_ms: input.started_at_ms, ended_at_ms: input.ended_at_ms, source: input.source });
  const { store, scheduler } = runtime(input.options, input.identity);
  const previousRevision = Math.max(0, ...store.listSnapshots({ meeting_id: input.meeting_id, occurrence_id: ended.occurrence_id }).map((snapshot) => snapshot.revision));
  const previous = latestSnapshot(store, input.meeting_id, ended.occurrence_id);
  const configuration = store.getCurrentConfiguration({ ...input.identity, meeting_id: input.meeting_id, occurrence_id: ended.occurrence_id });
  const previousOcrStatus = previous?.missing_reasons.includes('ocr_failed') ? 'failed' : previous?.missing_reasons.includes('ocr_pending') ? 'pending' : previous ? 'ready' : 'pending';
  // Platform workers may identify an occurrence/end time, but their transcript is never evidence.
  // Only the InkLoop Meeting Media formalizer (`source=local`) may replace/converge utterances.
  const ownedFormal = input.transcript_origin === 'inkloop_media' || input.source === 'local';
  const snapshot = buildEvidenceSnapshot({ ...input.identity, meeting_id: input.meeting_id, occurrence_id: ended.occurrence_id, meeting_title: input.title, revision: previousRevision + 1, transcript_final: ownedFormal ? input.transcript_final === true : previous ? !previous.missing_reasons.some((reason) => reason === 'transcript_pending' || reason === 'transcript_partial') : false, transcript_converged: ownedFormal ? input.transcript_converged === true || input.transcript_final === true : previous?.transcript_converged === true, transcript_missing_chunk_ids: ownedFormal ? input.transcript_missing_chunk_ids : previous?.missing_chunk_ids, template_id: configuration?.template_id, user_guidance: configuration?.user_guidance, ocr_status: input.ocr_status || previousOcrStatus, started_at_ms: ended.started_at_ms, ended_at_ms: ended.ended_at_ms, utterances: ownedFormal && input.utterances !== undefined ? input.utterances : previous?.utterances || [], handwriting: input.handwriting !== undefined ? input.handwriting : previous?.handwriting || [] });
  const saved = await store.saveSnapshot(snapshot);
  const gated = await passPostprocessGate({ store, scheduler, snapshot: saved, configuration });
  return { status: gated.status, occurrence_id: ended.occurrence_id, run_id: gated.run?.run_id, snapshot_id: gated.snapshot.snapshot_id };
}

type SnapshotUtterance = Partial<MeetingUtterance> & Pick<MeetingUtterance, 'start_ms' | 'end_ms' | 'text'> & { speaker?: string };

/** 进程启动时恢复已知 namespace；无需等待设备或 recap 请求才重领过期任务。 */
export function bootstrapMeetingPostprocess(options: Pick<MeetingPostprocessServiceOptions, 'root' | 'generate'>): number {
  let count = 0;
  try {
    for (const tenant of readdirSync(resolve(options.root), { withFileTypes: true }).filter((x) => x.isDirectory())) {
      for (const user of readdirSync(resolve(options.root, tenant.name), { withFileTypes: true }).filter((x) => x.isDirectory())) {
        const identity = readPostprocessStoreIdentity(resolve(options.root, tenant.name, user.name, 'meeting-postprocess-v2.json'));
        if (!identity) continue;
        const active = runtime(options, identity);
        if (!active.store.listRuns().some((x) => x.status === 'queued' || x.status === 'running')) continue;
        count += 1; queueMicrotask(() => active.scheduler.drain().catch((error) => console.warn('[meeting-postprocess] bootstrap drain failed', String(error))));
      }
    }
  } catch { /* 根目录尚不存在是正常首次启动。 */ }
  return count;
}

/** 进程启动后恢复“配置和转写都已 ready、但 enqueue 前崩溃”的持久化 Gate。 */
export function bootstrapMeetingPostprocessConfigurationGates(options: Pick<MeetingPostprocessServiceOptions, 'root' | 'generate'>): number {
  let count = 0;
  try {
    for (const tenant of readdirSync(resolve(options.root), { withFileTypes: true }).filter((x) => x.isDirectory())) {
      for (const user of readdirSync(resolve(options.root, tenant.name), { withFileTypes: true }).filter((x) => x.isDirectory())) {
        const identity = readPostprocessStoreIdentity(resolve(options.root, tenant.name, user.name, 'meeting-postprocess-v2.json'));
        if (!identity) continue;
        const active = runtime(options, identity);
        for (const configuration of active.store.listCurrentConfigurations()) {
          const snapshot = latestSnapshot(active.store, configuration.meeting_id, configuration.occurrence_id);
          if (!snapshot?.transcript_converged) continue;
          const desired = rebuildSnapshot(snapshot, configuration, Math.max(snapshot.revision + 1, ...active.store.listSnapshots(configuration).map((item) => item.revision + 1)));
          const alreadyQueued = active.store.listRuns(configuration).some((run) => run.artifact_kind === 'meeting.summary_cards' && active.store.getSnapshot(run.snapshot_id)?.fingerprint === desired.fingerprint);
          if (alreadyQueued) continue;
          count += 1;
          queueMicrotask(() => passPostprocessGate({ store: active.store, scheduler: active.scheduler, snapshot, configuration }).catch((error) => console.warn('[meeting-postprocess] gate bootstrap failed', String(error))));
        }
      }
    }
  } catch { /* 根目录尚不存在是正常首次启动。 */ }
  return count;
}

function transcriptUtterances(transcript: string): SnapshotUtterance[] { return transcript.split(/\n+/).map((line, index) => ({ speaker_name: null, start_ms: index * 1000, end_ms: index * 1000 + 999, text: line.trim() })).filter((x) => x.text); }
