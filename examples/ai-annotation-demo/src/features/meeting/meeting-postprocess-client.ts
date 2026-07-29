import { authFetch, getJson, postJson } from '../../core/api';
import { sha256Hex as sha256BufferHex } from '../../core/ids';
import type { PersistedMeeting } from '../../core/store-format';
import type { TranscriptCue } from '../../integration/panel-feishu/align';
import {
  actionItemSchema,
  decisionSchema,
  highlightSchema,
  keyPointSchema,
  meetingSummaryCardsV2Schema,
  openQuestionSchema,
  personalNoteSchema,
  riskSchema,
} from '../../../server/meeting-postprocess/contracts';

interface Artifact { artifact_id: string; meeting_id?: string; occurrence_id?: string; snapshot_id?: string; kind: 'meeting.summary_cards' | 'meeting.summary' | 'meeting.interview_archive_html' | 'meeting.mind_map' | 'meeting.full_report'; revision: number; finality: 'provisional' | 'final'; status: 'ready' | 'failed' | 'superseded'; snapshot_fingerprint?: string; content: unknown }
interface PostprocessRun { run_id: string; artifact_kind: 'meeting.summary_cards' | 'meeting.interview_archive_html'; status: 'queued' | 'collecting_evidence' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded'; created_at: string }
interface MeetingPostprocessTemplateResponseBase {
  reused_artifacts: number;
  template_id: MeetingPostprocessTemplateId;
  template_version: string;
}
export type MeetingPostprocessTemplateResponse =
  | (MeetingPostprocessTemplateResponseBase & {
    status: 'queued';
    run_id: string;
    run_status: PostprocessRun['status'];
  })
  | (MeetingPostprocessTemplateResponseBase & {
    status: 'awaiting_transcript';
    run_id?: never;
    run_status?: never;
  });
export type MeetingPostprocessTemplateId = NonNullable<PersistedMeeting['postprocess_template_id']>;
export interface MeetingPostprocessUserGuidance { conclusions: string[]; deepest_impressions: string[]; pain_points: string[] }
export interface MeetingPostprocessConfiguration { template_id: MeetingPostprocessTemplateId; template_version: string; user_guidance: MeetingPostprocessUserGuidance }
export type MeetingPostprocessConfigurationState = 'awaiting_configuration' | 'awaiting_transcript' | 'configured';

export const MEETING_POSTPROCESS_TEMPLATE_OPTIONS: Array<{ id: MeetingPostprocessTemplateId; label: string; description: string }> = [
  { id: 'meeting_expert', label: '会议全面总结专家', description: '按核心信息、关键脉络与深度洞察三层金字塔输出。' },
  { id: 'university_notes', label: '大学课堂笔记', description: '按课程主题、核心概念、例子和复习线索整理。' },
  { id: 'interactive_classroom', label: '互动课堂', description: '突出课堂提问、学生回应、教师反馈和课后任务。' },
  { id: 'reasoning_summary', label: '推理总结', description: '呈现已知事实、推理步骤、结论与不确定性。' },
  { id: 'interview_memo', label: '访谈备忘录', description: '突出受访者观点、动机、矛盾信号和后续追问。' },
  { id: 'interview_archive', label: '用户访谈归档纪要（完整版）', description: '结合研究者见解和完整转写，生成可归档的 HTML 研究报告。' },
];

export function meetingPostprocessTemplateLabel(templateId?: MeetingPostprocessTemplateId): string {
  return MEETING_POSTPROCESS_TEMPLATE_OPTIONS.find((item) => item.id === (templateId || 'meeting_expert'))?.label || '会议全面总结专家';
}

function safeOccurrencePart(value: string, fallback: string): string { return value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '').slice(0, 160) || fallback; }
async function sha256Hex(value: string): Promise<string> {
  return await sha256BufferHex(new TextEncoder().encode(value).buffer);
}

function providerOccurrenceReference(meeting: PersistedMeeting): string | undefined {
  const instance = meeting.provider_calendar_event_id
    || meeting.feishu_calendar_event_id
    || meeting.provider_meeting_id
    || meeting.feishu_meeting_id;
  if (instance) return instance;
  const logical = meeting.provider_space_name || meeting.calendar_meeting_no;
  return logical && meeting.scheduled_at ? `${logical}:${meeting.scheduled_at}` : logical;
}

/** Mirrors the Hub occurrence contract so recap can recover the same gate after reload, including provider-less local meetings. */
export async function resolveMeetingPostprocessOccurrenceId(meeting: PersistedMeeting): Promise<string> {
  if (meeting.postprocess_occurrence_id) return meeting.postprocess_occurrence_id;
  const platform = meeting.platform || (Object.keys(meeting).some((key) => key.startsWith('feishu_')) ? 'lark' : 'manual');
  const providerId = providerOccurrenceReference(meeting);
  if (providerId) return `${safeOccurrencePart(platform, 'meeting')}:${safeOccurrencePart(providerId, 'occurrence')}`;
  const startedAt = Date.parse(meeting.started_at || meeting.scheduled_at);
  const stable = `{"meeting_id":${JSON.stringify(meeting.meeting_id)},"started_at_ms":${Number.isFinite(startedAt) ? startedAt : 0}}`;
  return `local:${(await sha256Hex(stable)).slice(0, 32)}`;
}

export function postprocessProjection(meeting: PersistedMeeting, artifacts: Artifact[], occurrenceId = meeting.postprocess_occurrence_id): Partial<PersistedMeeting> | null {
  const ready = artifacts.filter((x) => x.status === 'ready' && (!occurrenceId || !x.occurrence_id || x.occurrence_id === occurrenceId));
  const rawCards = ready.filter((x) => x.kind === 'meeting.summary_cards').at(-1);
  const parsedCards = rawCards
    ? meetingSummaryCardsV2Schema.safeParse(rawCards.content)
    : null;
  const cards = parsedCards?.success ? rawCards : undefined;
  const belongsToCurrentCards = (artifact: Artifact): boolean => !cards?.snapshot_fingerprint || artifact.snapshot_fingerprint === cards.snapshot_fingerprint;
  const summary = ready.filter((x) => x.kind === 'meeting.summary' && belongsToCurrentCards(x)).at(-1);
  const rawArchive = ready.filter((x) => x.kind === 'meeting.interview_archive_html').at(-1);
  const parsedArchive = archiveContent(rawArchive?.content);
  const archive = parsedArchive ? rawArchive : undefined;
  if (!summary && !cards && !archive) return null;
  const patch: Partial<PersistedMeeting> = {};
  const identityArtifact = cards || summary || archive;
  if (identityArtifact?.occurrence_id && identityArtifact.snapshot_id) Object.assign(patch, { postprocess_occurrence_id: identityArtifact.occurrence_id, postprocess_snapshot_id: identityArtifact.snapshot_id });
  if (summary && !meeting.summary_user_edited_at && meeting.summary_origin !== 'user' && typeof summary.content === 'string') Object.assign(patch, { summary: summary.content, summary_origin: 'postprocess_v2', summary_artifact_id: summary.artifact_id, summary_artifact_revision: summary.revision, summary_finality: summary.finality });
  else if (cards?.snapshot_fingerprint && meeting.summary_origin === 'postprocess_v2' && !meeting.summary_user_edited_at) Object.assign(patch, { summary: undefined, summary_origin: undefined, summary_artifact_id: undefined, summary_artifact_revision: undefined, summary_finality: undefined });
  if (parsedCards?.success) {
    patch.summary_cards_v2 = parsedCards.data as PersistedMeeting['summary_cards_v2'];
  }
  if (archive && parsedArchive) {
    patch.interview_archive_html = { ...parsedArchive, artifact_id: archive.artifact_id, finality: archive.finality };
    patch.summary_cards_v2 = undefined;
    if (!meeting.summary_user_edited_at && meeting.summary_origin === 'postprocess_v2') Object.assign(patch, { summary: undefined, summary_origin: undefined, summary_artifact_id: undefined, summary_artifact_revision: undefined, summary_finality: undefined });
  }
  // 旧版曾把结构化文本树称为“脑图”。新链路不再生成或展示它；读取到新 Cards 时清理旧投影。
  if (cards?.snapshot_fingerprint && meeting.mind_map_v1) patch.mind_map_v1 = undefined;
  // Full Report 已下线。历史字段只保留存储读取兼容；新 Cards 到达时清掉旧本地投影。
  if (cards?.snapshot_fingerprint && meeting.full_report_v2) patch.full_report_v2 = undefined;
  return Object.keys(patch).length ? patch : null;
}

type MeetingSummaryCards = NonNullable<PersistedMeeting['summary_cards_v2']>;
export type ProgressiveMeetingCardSection =
  | 'key_points'
  | 'decisions'
  | 'action_items'
  | 'highlights'
  | 'risks'
  | 'open_questions'
  | 'personal_notes';

/** Validate an untrusted SSE card before it can enter persisted recap state. */
export function appendProgressiveMeetingCard(
  current: MeetingSummaryCards,
  section: unknown,
  value: unknown,
): MeetingSummaryCards | null {
  const replace = <T extends { id: string }>(items: T[], item: T): T[] => [
    ...items.filter((existing) => existing.id !== item.id),
    item,
  ];
  switch (section) {
  case 'key_points': {
    const parsed = keyPointSchema.safeParse(value);
    return parsed.success ? { ...current, key_points: replace(current.key_points, parsed.data) } : null;
  }
  case 'decisions': {
    const parsed = decisionSchema.safeParse(value);
    return parsed.success ? { ...current, decisions: replace(current.decisions, parsed.data) } : null;
  }
  case 'action_items': {
    const parsed = actionItemSchema.safeParse(value);
    return parsed.success ? { ...current, action_items: replace(current.action_items, parsed.data) } : null;
  }
  case 'highlights': {
    const parsed = highlightSchema.safeParse(value);
    return parsed.success ? { ...current, highlights: replace(current.highlights, parsed.data) } : null;
  }
  case 'risks': {
    const parsed = riskSchema.safeParse(value);
    return parsed.success ? { ...current, risks: replace(current.risks, parsed.data) } : null;
  }
  case 'open_questions': {
    const parsed = openQuestionSchema.safeParse(value);
    return parsed.success ? { ...current, open_questions: replace(current.open_questions, parsed.data) } : null;
  }
  case 'personal_notes': {
    const parsed = personalNoteSchema.safeParse(value);
    return parsed.success ? { ...current, personal_notes: replace(current.personal_notes, parsed.data) } : null;
  }
  default:
    return null;
  }
}

function archiveContent(value: unknown): {
  filename: string;
  html: string;
  generated_at: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.filename !== 'string'
    || typeof candidate.html !== 'string'
    || typeof candidate.generated_at !== 'string'
    || !candidate.filename.trim()
    || candidate.filename.length > 180
    || /[/\\\0]/.test(candidate.filename)
    || !candidate.html.trim()
    || candidate.html.length > 8 * 1024 * 1024
    || !Number.isFinite(Date.parse(candidate.generated_at))) return null;
  return {
    filename: candidate.filename,
    html: candidate.html,
    generated_at: candidate.generated_at,
  };
}

export async function fetchMeetingPostprocessArtifacts(meetingId: string, occurrenceId: string): Promise<Artifact[]> {
  const response = await getJson<{ artifacts?: Artifact[] }>(`/api/meeting-postprocess/artifacts?meeting_id=${encodeURIComponent(meetingId)}&occurrence_id=${encodeURIComponent(occurrenceId)}`, { auth: true, timeoutMs: 15_000 });
  return response.artifacts || [];
}

export async function requestMeetingPostprocessTemplate(
  meetingId: string,
  occurrenceId: string,
  templateId: MeetingPostprocessTemplateId,
): Promise<MeetingPostprocessTemplateResponse> {
  const response = await postJson<{
    status: 'queued' | 'awaiting_transcript';
    run?: PostprocessRun;
    reused_artifacts?: number;
    snapshot: {
      template_id: MeetingPostprocessTemplateId;
      template_version: string;
    };
  }>('/api/meeting-postprocess/template', {
    meeting_id: meetingId,
    occurrence_id: occurrenceId,
    template_id: templateId,
  }, { auth: true, timeoutMs: 30_000 });
  const common = {
    reused_artifacts: response.reused_artifacts || 0,
    template_id: response.snapshot.template_id,
    template_version: response.snapshot.template_version,
  };
  if (response.status === 'awaiting_transcript') {
    return { ...common, status: 'awaiting_transcript' };
  }
  if (!response.run) throw new Error('meeting_postprocess_template_run_missing');
  return {
    ...common,
    status: 'queued',
    run_id: response.run.run_id,
    run_status: response.run.status,
  };
}

export async function fetchMeetingPostprocessConfiguration(meetingId: string, occurrenceId: string): Promise<{ status: MeetingPostprocessConfigurationState; configuration?: MeetingPostprocessConfiguration }> {
  return await getJson(`/api/meeting-postprocess/configuration?meeting_id=${encodeURIComponent(meetingId)}&occurrence_id=${encodeURIComponent(occurrenceId)}`, { auth: true, timeoutMs: 15_000 });
}

export async function submitMeetingPostprocessConfiguration(input: { meeting_id: string; occurrence_id: string; template_id: MeetingPostprocessTemplateId; user_guidance: MeetingPostprocessUserGuidance }): Promise<{ status: MeetingPostprocessConfigurationState | 'queued'; configuration: MeetingPostprocessConfiguration; run?: PostprocessRun; snapshot?: { snapshot_id: string } }> {
  return await postJson('/api/meeting-postprocess/configuration', input, { auth: true, timeoutMs: 30_000 });
}

export async function registerMeetingPostprocessProviders(meetings: PersistedMeeting[]): Promise<void> {
  const registrations = meetings.flatMap((meeting) => {
    const provider = meeting.platform === 'google_meet' ? 'google' : meeting.platform === 'zoom' ? 'zoom' : meeting.platform === 'lark' || meeting.feishu_meeting_id || meeting.feishu_calendar_event_id ? 'lark' : null;
    if (!provider || !meeting.scheduled_at) return [];
    const scheduledEnd = meeting.ended_at || (Number.isFinite(meeting.duration) && Number(meeting.duration) > 0 ? new Date(Date.parse(meeting.scheduled_at) + Number(meeting.duration) * 60_000).toISOString() : undefined);
    return [{ meeting_id: meeting.meeting_id, provider, title: meeting.title, provider_meeting_id: meeting.provider_meeting_id || meeting.feishu_meeting_id, provider_calendar_event_id: meeting.provider_calendar_event_id || meeting.feishu_calendar_event_id, provider_space_name: meeting.provider_space_name, meeting_code: meeting.calendar_meeting_no || meeting.feishu_meeting_no, scheduled_at: meeting.scheduled_at, scheduled_end_at: scheduledEnd, started_at: meeting.started_at, ended_at: meeting.ended_at, status: meeting.status }];
  });
  if (!registrations.length) return;
  await postJson('/api/meeting-postprocess/provider-registrations', { meetings: registrations }, { auth: true, timeoutMs: 30_000 });
}

export interface MeetingDeletionResult {
  command_id: string;
  replay: boolean;
  pending_companion: boolean;
  cloud_sessions_deleted: number;
  deleted: {
    runs: number;
    snapshots: number;
    configurations: number;
    artifacts: number;
    events: number;
    chunk_cache: number;
    registrations: number;
  };
}

export async function deleteMeetingPostprocess(meetingId: string): Promise<void> {
  const response = await authFetch(`/api/meeting-postprocess/artifacts?meeting_id=${encodeURIComponent(meetingId)}`, { method: 'DELETE' }, { timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`meeting_postprocess_delete_${response.status}`);
}

/** Delete the canonical cloud lifecycle for a meeting. The Hub first creates
 * a media deletion tombstone, then removes raw/derived media and postprocess
 * state so an offline Companion cannot resurrect the meeting on reconnect. */
export async function deleteWholeMeeting(meetingId: string): Promise<MeetingDeletionResult> {
  const response = await authFetch(`/api/meeting-postprocess/meeting?meeting_id=${encodeURIComponent(meetingId)}`, { method: 'DELETE' }, { timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`meeting_delete_${response.status}`);
  return await response.json() as MeetingDeletionResult;
}

/** Delete only the server-side temporary Mic/Remote media for this meeting.
 * The authoritative Mac copy and every derived artifact remain available. */
export async function deleteMeetingRawMedia(
  meetingId: string,
): Promise<{ deleted: boolean; session_id: string }> {
  const meetingDocumentId = meetingId.startsWith('mtgdoc_') ? meetingId : `mtgdoc_${meetingId}`;
  const scope = await getJson<{ session_id: string }>(
    `/api/meeting-media/session-scope?meeting_doc_id=${encodeURIComponent(meetingDocumentId)}`,
    { auth: true, timeoutMs: 15_000 },
  );
  const response = await authFetch(
    `/api/meeting-media/raw-media?session_id=${encodeURIComponent(scope.session_id)}`,
    { method: 'DELETE' },
    { timeoutMs: 30_000 },
  );
  if (!response.ok) throw new Error(`meeting_raw_media_delete_${response.status}`);
  const body = await response.json() as { deleted?: boolean };
  return { deleted: body.deleted === true, session_id: scope.session_id };
}

export interface MeetingRawMediaLifecycle {
  status: 'deleting' | 'deleted' | 'delete_failed';
  reason: 'formal_transcript_terminal' | 'user_requested';
  updated_at_ms: number;
  abandoned_chunk_ids?: string[];
  error?: string;
}

export async function fetchMeetingRawMediaLifecycle(
  meetingId: string,
): Promise<{ session_id: string; lifecycle: MeetingRawMediaLifecycle | null }> {
  const meetingDocumentId = meetingId.startsWith('mtgdoc_') ? meetingId : `mtgdoc_${meetingId}`;
  const scope = await getJson<{ session_id: string }>(
    `/api/meeting-media/session-scope?meeting_doc_id=${encodeURIComponent(meetingDocumentId)}`,
    { auth: true, timeoutMs: 15_000 },
  );
  const body = await getJson<{ lifecycle?: MeetingRawMediaLifecycle | null }>(
    `/api/meeting-media/raw-media?session_id=${encodeURIComponent(scope.session_id)}`,
    { auth: true, timeoutMs: 15_000 },
  );
  return { session_id: scope.session_id, lifecycle: body.lifecycle || null };
}

export async function enqueueMeetingPostprocess(meeting: PersistedMeeting, cues: TranscriptCue[], handwriting: Array<{ id: string; text: string; revision: number; mark_ids?: string[] }> = [], ocrStatus: 'ready' | 'pending' | 'failed' | 'not_applicable' = handwriting.length ? 'ready' : 'not_applicable'): Promise<{ status?: MeetingPostprocessConfigurationState | 'queued'; occurrence_id?: string }> {
  return await postJson('/api/meeting-postprocess/runs', {
    meeting_id: meeting.meeting_id,
    title: meeting.title,
    platform: meeting.platform,
    // occurrence identity 必须优先稳定的日历实例；Provider 后续补上的 record/UUID 不能把同一场会切成新 occurrence。
    provider_meeting_id: providerOccurrenceReference(meeting),
    source: meeting.platform === 'zoom' ? 'zoom' : meeting.platform === 'google_meet' ? 'google' : meeting.platform === 'lark' ? 'lark' : 'local',
    started_at_ms: Date.parse(meeting.started_at || meeting.scheduled_at),
    ended_at_ms: Date.parse(meeting.ended_at || '') || undefined,
    // 设备只提交实时证据，不能宣告 formal 收敛；服务端 Media formalizer / Provider worker
    // 会在可信来源 ready 后并行跨过转写 Gate。
    ocr_status: ocrStatus,
    utterances: cues.map((cue, index) => ({ id: `cue_${index}_${cue.startMs}`, speaker: cue.speaker || '', start_ms: cue.startMs, end_ms: cue.endMs, text: cue.text })),
    handwriting: handwriting.map((item) => ({ ...item, mark_ids: item.mark_ids || [], confidence: null, corrected_by_user: false })),
  }, { auth: true, timeoutMs: 30_000 });
}

export async function subscribeMeetingPostprocess(input: { meetingId: string; occurrenceId: string; after?: number; signal: AbortSignal; onEvent(event: { event_id: number; type: string; run_id?: string; data: Record<string, unknown> }): void }): Promise<void> {
  let cursor = input.after || 0;
  while (!input.signal.aborted) {
    try {
      const response = await authFetch(`/api/meeting-postprocess/events?meeting_id=${encodeURIComponent(input.meetingId)}&occurrence_id=${encodeURIComponent(input.occurrenceId)}`, { headers: { accept: 'text/event-stream', 'last-event-id': String(cursor) } }, { signal: input.signal, timeoutMs: 60_000 });
      if (!response.ok || !response.body) throw new Error(`meeting_postprocess_stream_${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (!input.signal.aborted) {
        const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n'); buffer = frames.pop() || '';
        for (const frame of frames) {
          const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6); if (!data) continue;
          const event = JSON.parse(data) as { event_id: number; type: string; run_id?: string; data: Record<string, unknown> };
          if (event.event_id <= cursor) continue; cursor = event.event_id; input.onEvent(event);
        }
      }
    } catch {
      if (input.signal.aborted) return;
      await abortableDelay(1_000, input.signal);
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(done, ms); function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); });
}
