/**
 * Zoom 会后记录聚合：按数字 meeting id 发现全部实际 UUID，结合排期/MTL 窗口与转写可用性选场，
 * 拉取参会区间和经典云录制 VTT，并以实际会议开始时间为 t0 产出 SRT。终态会定期重查，允许晚到
 * UUID/TRANSCRIPT 翻转；Meeting transcript 新路线只做可关闭的对比探测，不替代经典产物。
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicSaveProviderArtifactState,
  loadProviderArtifactState,
  mergeSaveProviderArtifactJob,
  providerArtifactNextPoll,
  providerArtifactTerminalRecheckDue,
  ProviderArtifactSingleFlight,
} from './provider-artifact-poller';
import {
  readZoomMeetingSources,
  zoomMeetingSyncPath,
  type ZoomMeetingSource,
  type ZoomMeetingSyncEnv,
  type ZoomMeetingSyncRef,
} from './zoom-meeting-sync';
import { zoomDownloadTokenFetch, zoomOAuthErrorPayload, zoomS2SFetch } from './zoom-oauth-state';
import { zoomUuidPathSegment } from './zoom-uuid';

const ZOOM_API_BASE = 'https://api.zoom.us/v2';
const DEFAULT_ZOOM_RECORDS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../.inkloop/zoom-records/state.json');
const MAX_ATTEMPTS = 3;
const TERMINAL_RECHECK_MS = 10 * 60_000;
const DEFAULT_TERMINAL_RECHECK_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_RECORDS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_SCHEDULED_DURATION_MS = 60 * 60_000;
const CANDIDATE_WINDOW_TOLERANCE_MS = 4 * 60 * 60_000;
const TIMESTAMP_MISMATCH_MIN_MS = 30_000;
const TIMESTAMP_MISMATCH_RATIO = 0.2;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_PAGES = 100;

export const ZOOM_MEETING_POLL_MINUTES = [1, 2, 5, 10, 20, 30, 60, 120] as const;

export interface ZoomMeetingRecordsEnv extends ZoomMeetingSyncEnv {
  ZOOM_RECORDS_STATE_PATH?: string;
  ZOOM_MEETING_TRANSCRIPT_PROBE?: string;
  ZOOM_TERMINAL_RECHECK_WINDOW_MS?: string;
  ZOOM_RECORDS_RETENTION_MS?: string;
}

export interface ZoomMeetingRecordsRef {
  path: string;
}

export interface ZoomMeetingAttendanceWindow {
  startMs: number;
  endMs: number;
}

export interface ZoomRecordingFile {
  id: string;
  file_type: string;
  recording_type?: string;
  recording_start?: string;
  recording_end?: string;
  download_url?: string;
  status?: string;
}

export interface ZoomMeetingInstanceCandidate {
  uuid: string;
  start_time?: string;
  end_time?: string;
  duration_minutes?: number;
  recordings: ZoomRecordingFile[];
}

export type ZoomIdentityQuality = 'signed_in' | 'external_email' | 'anonymous';

export interface ZoomParticipantInterval {
  join_time?: string;
  leave_time?: string;
  display_name: string;
  identity_quality: ZoomIdentityQuality;
}

export interface ZoomTranscriptSpeaker {
  display_name?: string;
  stable_id: null;
  attribution_quality: 'display_label';
}

export interface ZoomTranscriptLine {
  start_time: string;
  end_time: string;
  speaker: ZoomTranscriptSpeaker;
  text: string;
  recording_file_id: string;
}

export type ZoomTimestampQuality = 'derived_no_pause' | 'approximate_pause_unknown';

export interface ZoomMeetingTranscriptProbeState {
  status: 'not_ready' | 'ready' | 'error';
  checked_at: string;
  cue_count?: number;
  first_delta_ms?: number;
  last_delta_ms?: number;
  timestamp_quality?: 'anchor_undocumented';
}

export interface ZoomMeetingJobState {
  meeting_id: string;
  scheduled_at: string;
  scheduled_end_at?: string;
  selection_input_hash: string;
  candidates: ZoomMeetingInstanceCandidate[];
  chosen_instance_uuid?: string;
  participants?: ZoomParticipantInterval[];
  transcript_file_ids?: string[];
  transcript_lines?: ZoomTranscriptLine[];
  timestamp_quality?: ZoomTimestampQuality;
  probe?: ZoomMeetingTranscriptProbeState;
  status: 'pending' | 'ready' | 'not_generated' | 'no_record';
  next_check_at?: string;
  attempt: number;
  terminal: boolean;
  fetched_at?: string;
  updated_at: string;
}

interface ZoomMeetingRecordsFile {
  schema_version: 'inkloop.zoom_meeting_records.v1';
  meetings: Record<string, ZoomMeetingJobState>;
}

export interface ZoomMeetingRecordsOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: number;
  signal?: AbortSignal;
  logger?: (event: string, details: Record<string, unknown>) => void;
}

export interface ZoomMeetingTranscriptResult {
  status: 'pending' | 'ready' | 'not_generated' | 'no_record';
  reason?: 'instance_not_found' | 'recording_missing' | 'transcript_not_generated';
  record?: { name: string; start_time?: string; end_time?: string };
  transcript?: {
    name: string;
    lines: ZoomTranscriptLine[];
    srt: string;
    timestamp_quality: ZoomTimestampQuality;
  };
  participants?: ZoomParticipantInterval[];
  instance_uuid?: string;
  t0?: string;
  started_at?: string;
  ended_at?: string;
  srt?: string;
  timestamp_quality?: ZoomTimestampQuality;
  next_check_at?: string;
}

export interface ZoomMeetingTranscriptBackfillResult {
  scanned: number;
  advanced: number;
  completed: number;
  errors: string[];
}

interface RequestOptions {
  fetchImpl: typeof fetch;
  sleepImpl: (delayMs: number) => Promise<void>;
  nowMs: number;
  signal?: AbortSignal;
  logger: (event: string, details: Record<string, unknown>) => void;
}

interface DiscoveredCandidate {
  stored: ZoomMeetingInstanceCandidate;
  downloadAccessToken?: string;
}

interface ParsedVttCue {
  startOffsetMs: number;
  endOffsetMs: number;
  speaker: ZoomTranscriptSpeaker;
  text: string;
}

interface ParsedTranscriptFile {
  file: ZoomRecordingFile;
  cues: ParsedVttCue[];
  lines: ZoomTranscriptLine[];
  used_instance_start: boolean;
}

interface ProbeOutcome {
  state: ZoomMeetingTranscriptProbeState;
  cues: ParsedVttCue[];
}

export class ZoomMeetingRecordsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'ZoomMeetingRecordsError';
    this.status = status;
    this.code = code;
  }
}

const jobsInFlight = new ProviderArtifactSingleFlight<ZoomMeetingTranscriptResult>();

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanId(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function nonNegativeDuration(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function validIso(value: unknown): string | undefined {
  const raw = clean(value);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function requiredIso(value: unknown, field: string): string {
  const normalized = validIso(value);
  if (!normalized) throw new ZoomMeetingRecordsError('zoom_meeting_time_invalid', 400, `${field} is invalid`);
  return normalized;
}

function emptyState(): ZoomMeetingRecordsFile {
  return { schema_version: 'inkloop.zoom_meeting_records.v1', meetings: {} };
}

function loadState(path: string): ZoomMeetingRecordsFile {
  return loadProviderArtifactState(path, emptyState, (value) => {
    const parsed = value && typeof value === 'object' ? value as Partial<ZoomMeetingRecordsFile> : {};
    return {
      schema_version: 'inkloop.zoom_meeting_records.v1',
      meetings: parsed.meetings && typeof parsed.meetings === 'object' ? parsed.meetings : {},
    };
  });
}

function persistJob(path: string, key: string, job: ZoomMeetingJobState): void {
  mergeSaveProviderArtifactJob({ path, key, job, load: loadState, meetings: (state) => state.meetings });
}

function meetingKey(meetingId: string, scheduledAt: string): string {
  return `${meetingId}|${scheduledAt}`;
}

function jobScheduledEndMs(job: Pick<ZoomMeetingJobState, 'scheduled_at' | 'scheduled_end_at'>): number {
  const explicit = Date.parse(job.scheduled_end_at || '');
  if (Number.isFinite(explicit)) return explicit;
  return Date.parse(job.scheduled_at) + DEFAULT_SCHEDULED_DURATION_MS;
}

function terminalRecheckAllowed(
  job: Pick<ZoomMeetingJobState, 'scheduled_at' | 'scheduled_end_at'> | undefined,
  nowMs: number,
  env: ZoomMeetingRecordsEnv,
): boolean {
  if (!job) return false;
  const windowMs = nonNegativeDuration(env.ZOOM_TERMINAL_RECHECK_WINDOW_MS, DEFAULT_TERMINAL_RECHECK_WINDOW_MS);
  return nowMs <= jobScheduledEndMs(job) + windowMs;
}

function zoomUrl(resource: string, query: Record<string, string> = {}): string {
  const url = new URL(`${ZOOM_API_BASE}/${resource.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, delayMs));
}

function retryAfterMs(response: Response, nowMs: number, fallbackMs: number): number {
  const raw = clean(response.headers.get('retry-after'));
  const seconds = Number(raw);
  if (raw && Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (raw && Number.isFinite(dateMs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, dateMs - nowMs));
  return fallbackMs;
}

async function abortableSleep(
  delayMs: number,
  sleepImpl: (delayMs: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleepImpl(delayMs);
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      sleepImpl(delayMs),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchZoomResponse(
  url: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
  init: RequestInit = {},
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await zoomS2SFetch(url, {
      ...init,
      signal: options.signal,
    }, env, { fetchImpl: options.fetchImpl, nowMs: options.nowMs });
    if (response.ok || !retryable(response.status) || attempt === MAX_ATTEMPTS) return response;
    const fallbackMs = 250 * (2 ** (attempt - 1));
    await abortableSleep(response.status === 429
      ? retryAfterMs(response, options.nowMs, fallbackMs)
      : fallbackMs, options.sleepImpl, options.signal);
  }
  throw new ZoomMeetingRecordsError('zoom_meeting_retry_exhausted', 502);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ZoomMeetingRecordsError('zoom_meeting_invalid_response', 502, 'Zoom API returned invalid JSON');
  }
}

async function requireZoomJson(
  url: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
): Promise<Record<string, unknown>> {
  const response = await fetchZoomResponse(url, env, options);
  if (!response.ok) {
    throw new ZoomMeetingRecordsError(
      response.status === 401 ? 'zoom_s2s_unauthorized' : 'zoom_meeting_request_failed',
      response.status === 401 ? 401 : 502,
      `Zoom meeting request failed (HTTP ${response.status})`,
    );
  }
  return readJson(response);
}

function normalizeRecordingFile(value: unknown, index: number): ZoomRecordingFile | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const id = cleanId(input.id) || `recording-file-${index + 1}`;
  const fileType = clean(input.file_type).toUpperCase();
  const recordingType = clean(input.recording_type);
  const recordingStart = validIso(input.recording_start);
  const recordingEnd = validIso(input.recording_end);
  const downloadUrl = clean(input.download_url);
  const status = clean(input.status);
  return {
    id,
    file_type: fileType,
    ...(recordingType ? { recording_type: recordingType } : {}),
    ...(recordingStart ? { recording_start: recordingStart } : {}),
    ...(recordingEnd ? { recording_end: recordingEnd } : {}),
    ...(downloadUrl ? { download_url: downloadUrl } : {}),
    ...(status ? { status } : {}),
  };
}

function candidateStartMs(candidate: ZoomMeetingInstanceCandidate): number {
  const ms = Date.parse(candidate.start_time || '');
  return Number.isFinite(ms) ? ms : 0;
}

function candidateEndMs(candidate: ZoomMeetingInstanceCandidate): number {
  const explicit = Date.parse(candidate.end_time || '');
  if (Number.isFinite(explicit)) return explicit;
  const startMs = candidateStartMs(candidate);
  const duration = Number(candidate.duration_minutes);
  return startMs && Number.isFinite(duration) ? startMs + Math.max(0, duration) * 60_000 : startMs;
}

function overlapMs(candidate: ZoomMeetingInstanceCandidate, window: ZoomMeetingAttendanceWindow): number {
  return Math.max(0, Math.min(candidateEndMs(candidate), window.endMs) - Math.max(candidateStartMs(candidate), window.startMs));
}

function startDistanceFromWindowMs(candidate: ZoomMeetingInstanceCandidate, window: ZoomMeetingAttendanceWindow): number {
  const startMs = candidateStartMs(candidate);
  if (startMs < window.startMs) return window.startMs - startMs;
  if (startMs > window.endMs) return startMs - window.endMs;
  return 0;
}

function transcriptFiles(candidate: ZoomMeetingInstanceCandidate): ZoomRecordingFile[] {
  return candidate.recordings.filter((file) => file.file_type === 'TRANSCRIPT');
}

function validWindows(windows: ZoomMeetingAttendanceWindow[]): ZoomMeetingAttendanceWindow[] {
  return windows.filter((window) => (
    Number.isFinite(window.startMs)
    && Number.isFinite(window.endMs)
    && window.endMs >= window.startMs
  ));
}

function normalizedScheduledWindow(scheduledAt: string, scheduledEndAt?: string): ZoomMeetingAttendanceWindow {
  const startMs = Date.parse(requiredIso(scheduledAt, 'scheduled_at'));
  const parsedEndMs = Date.parse(scheduledEndAt || '');
  return {
    startMs,
    endMs: Number.isFinite(parsedEndMs) && parsedEndMs >= startMs
      ? parsedEndMs
      : startMs + DEFAULT_SCHEDULED_DURATION_MS,
  };
}

function selectionInputHash(
  scheduledAt: string,
  scheduledEndAt: string | undefined,
  attendance: ZoomMeetingAttendanceWindow[] = [],
): string {
  const schedule = normalizedScheduledWindow(scheduledAt, scheduledEndAt);
  const windows = validWindows(attendance)
    .map((window) => ({ startMs: window.startMs, endMs: window.endMs }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  return createHash('sha256').update(JSON.stringify({ schedule, attendance: windows })).digest('hex');
}

/**
 * 只在参会/排期附近的实际实例中选场。四小时容差覆盖提前开会、拖堂和排期偏差，
 * 同时能排除复用数字 meeting id 时相隔数天的历史实例。
 */
export function chooseZoomMeetingCandidate(
  candidates: ZoomMeetingInstanceCandidate[],
  scheduledAt: string,
  scheduledEndAt?: string,
  attendance: ZoomMeetingAttendanceWindow[] = [],
): ZoomMeetingInstanceCandidate | undefined {
  const scheduledWindow = normalizedScheduledWindow(scheduledAt, scheduledEndAt);
  const scheduledStartMs = scheduledWindow.startMs;
  const attendanceWindows = validWindows(attendance);
  return [...candidates]
    .filter((candidate) => !!candidate.uuid && !!candidateStartMs(candidate))
    .filter((candidate) => (
      attendanceWindows.some((window) => overlapMs(candidate, window) > 0)
      || overlapMs(candidate, scheduledWindow) > 0
      || startDistanceFromWindowMs(candidate, scheduledWindow) <= CANDIDATE_WINDOW_TOLERANCE_MS
    ))
    .sort((left, right) => {
      const leftAttendance = attendanceWindows.reduce((sum, window) => sum + overlapMs(left, window), 0);
      const rightAttendance = attendanceWindows.reduce((sum, window) => sum + overlapMs(right, window), 0);
      const attendanceOverlapDelta = Number(rightAttendance > 0) - Number(leftAttendance > 0);
      if (attendanceOverlapDelta) return attendanceOverlapDelta;
      if (rightAttendance !== leftAttendance) return rightAttendance - leftAttendance;
      const scheduledOverlapDelta = Number(overlapMs(right, scheduledWindow) > 0) - Number(overlapMs(left, scheduledWindow) > 0);
      if (scheduledOverlapDelta) return scheduledOverlapDelta;
      const leftScheduled = overlapMs(left, scheduledWindow);
      const rightScheduled = overlapMs(right, scheduledWindow);
      if (rightScheduled !== leftScheduled) return rightScheduled - leftScheduled;
      const leftDistance = Math.abs(candidateStartMs(left) - scheduledStartMs);
      const rightDistance = Math.abs(candidateStartMs(right) - scheduledStartMs);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      const transcriptDelta = Number(transcriptFiles(right).length > 0) - Number(transcriptFiles(left).length > 0);
      return transcriptDelta || left.uuid.localeCompare(right.uuid);
    })[0];
}

async function fetchRecordings(
  uuid: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
): Promise<{ files: ZoomRecordingFile[]; downloadAccessToken?: string }> {
  const response = await fetchZoomResponse(zoomUrl(
    `meetings/${zoomUuidPathSegment(uuid)}/recordings`,
    { include_fields: 'download_access_token' },
  ), env, options);
  if (response.status === 404) return { files: [] };
  if (!response.ok) {
    throw new ZoomMeetingRecordsError('zoom_recordings_request_failed', 502, `Zoom recordings request failed (HTTP ${response.status})`);
  }
  const body = await readJson(response);
  const files = Array.isArray(body.recording_files)
    ? body.recording_files.map(normalizeRecordingFile).filter((file): file is ZoomRecordingFile => !!file)
    : [];
  const downloadAccessToken = clean(body.download_access_token);
  return { files, ...(downloadAccessToken ? { downloadAccessToken } : {}) };
}

function instanceUuid(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const input = value as Record<string, unknown>;
  return clean(input.uuid);
}

async function discoverCandidates(
  meetingId: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
): Promise<DiscoveredCandidate[]> {
  const body = await requireZoomJson(zoomUrl(
    `past_meetings/${zoomUuidPathSegment(meetingId)}/instances`,
  ), env, options);
  const instances = Array.isArray(body.meetings) ? body.meetings : [];
  const discovered: DiscoveredCandidate[] = [];
  for (const instance of instances) {
    const uuid = instanceUuid(instance);
    if (!uuid) continue;
    const segment = zoomUuidPathSegment(uuid);
    const [detail, recordings] = await Promise.all([
      requireZoomJson(zoomUrl(`past_meetings/${segment}`), env, options),
      fetchRecordings(uuid, env, options),
    ]);
    const instanceRecord = instance as Record<string, unknown>;
    const startTime = validIso(detail.start_time) || validIso(instanceRecord.start_time)
      || recordings.files.map((file) => file.recording_start).find(Boolean);
    const durationMinutes = Number(detail.duration ?? instanceRecord.duration);
    let endTime = validIso(detail.end_time) || validIso(instanceRecord.end_time);
    if (!endTime && startTime && Number.isFinite(durationMinutes)) {
      endTime = new Date(Date.parse(startTime) + Math.max(0, durationMinutes) * 60_000).toISOString();
    }
    if (!endTime) {
      endTime = recordings.files
        .map((file) => file.recording_end)
        .filter((value): value is string => !!value)
        .sort()
        .at(-1);
    }
    discovered.push({
      stored: {
        uuid,
        ...(startTime ? { start_time: startTime } : {}),
        ...(endTime ? { end_time: endTime } : {}),
        ...(Number.isFinite(durationMinutes) ? { duration_minutes: Math.max(0, durationMinutes) } : {}),
        recordings: recordings.files,
      },
      ...(recordings.downloadAccessToken ? { downloadAccessToken: recordings.downloadAccessToken } : {}),
    });
  }
  return discovered.sort((left, right) => left.stored.uuid.localeCompare(right.stored.uuid));
}

function normalizeParticipant(value: unknown): ZoomParticipantInterval | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const joinTime = validIso(input.join_time);
  const leaveTime = validIso(input.leave_time);
  const displayName = clean(input.name);
  const identityQuality: ZoomIdentityQuality = cleanId(input.id)
    ? 'signed_in'
    : clean(input.user_email)
      ? 'external_email'
      : 'anonymous';
  return {
    ...(joinTime ? { join_time: joinTime } : {}),
    ...(leaveTime ? { leave_time: leaveTime } : {}),
    display_name: displayName,
    identity_quality: identityQuality,
  };
}

async function fetchParticipants(
  uuid: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
): Promise<ZoomParticipantInterval[]> {
  const participants: ZoomParticipantInterval[] = [];
  let nextPageToken = '';
  const seenTokens = new Set<string>();
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const body = await requireZoomJson(zoomUrl(
      `past_meetings/${zoomUuidPathSegment(uuid)}/participants`,
      { page_size: '300', ...(nextPageToken ? { next_page_token: nextPageToken } : {}) },
    ), env, options);
    if (Array.isArray(body.participants)) {
      participants.push(...body.participants.map(normalizeParticipant).filter((item): item is ZoomParticipantInterval => !!item));
    }
    const token = clean(body.next_page_token);
    if (!token) return participants;
    if (seenTokens.has(token)) {
      throw new ZoomMeetingRecordsError('zoom_pagination_token_loop', 502, 'Zoom participant pagination token repeated');
    }
    seenTokens.add(token);
    nextPageToken = token;
  }
  throw new ZoomMeetingRecordsError('zoom_pagination_limit_exceeded', 502, 'Zoom participant pagination limit exceeded');
}

function vttOffsetMs(value: string): number | undefined {
  const match = value.trim().replace(',', '.').match(/^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return undefined;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  if (minutes >= 60 || seconds >= 60) return undefined;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function stripVttMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
}

function splitSpeakerLabel(value: string): { speaker: ZoomTranscriptSpeaker; text: string } {
  const colon = value.indexOf(':');
  const labelShape = colon >= 0 && colon <= 160 && (colon === value.length - 1 || /\s/.test(value[colon + 1] || ''));
  if (!labelShape) {
    return { speaker: { stable_id: null, attribution_quality: 'display_label' }, text: value.trim() };
  }
  const displayName = value.slice(0, colon).trim();
  return {
    speaker: {
      ...(displayName ? { display_name: displayName } : {}),
      stable_id: null,
      attribution_quality: 'display_label',
    },
    text: value.slice(colon + 1).trim(),
  };
}

/** 只按第一个符合 `label: text` 的冒号切分，正文后续冒号原样保留；空标签和 Unknown Speaker 均可承载。 */
export function parseZoomVtt(vtt: string): ParsedVttCue[] {
  const cues: ParsedVttCue[] = [];
  const blocks = vtt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split('\n').map((row) => row.trimEnd());
    const timingIndex = rows.findIndex((row) => row.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = rows[timingIndex].match(/^\s*(\S+)\s+-->\s+(\S+)/);
    if (!timing) continue;
    const startOffsetMs = vttOffsetMs(timing[1]);
    const endOffsetMs = vttOffsetMs(timing[2]);
    if (startOffsetMs === undefined || endOffsetMs === undefined) continue;
    const rawText = stripVttMarkup(rows.slice(timingIndex + 1).join(' ').replace(/\s+/g, ' '));
    const attributed = splitSpeakerLabel(rawText);
    cues.push({
      startOffsetMs,
      endOffsetMs: Math.max(startOffsetMs + 1, endOffsetMs),
      speaker: attributed.speaker,
      text: attributed.text,
    });
  }
  return cues.sort((left, right) => (
    left.startOffsetMs - right.startOffsetMs
    || left.endOffsetMs - right.endOffsetMs
  ));
}

async function fetchDirectWithRetry(url: string, options: RequestOptions): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await zoomDownloadTokenFetch(url, { signal: options.signal }, { fetchImpl: options.fetchImpl });
    if (response.ok || !retryable(response.status) || attempt === MAX_ATTEMPTS) return response;
    const fallbackMs = 250 * (2 ** (attempt - 1));
    await abortableSleep(response.status === 429
      ? retryAfterMs(response, options.nowMs, fallbackMs)
      : fallbackMs, options.sleepImpl, options.signal);
  }
  throw new ZoomMeetingRecordsError('zoom_download_retry_exhausted', 502);
}

async function downloadZoomText(
  downloadUrl: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
  downloadAccessToken?: string,
): Promise<{ body: string; contentType: string }> {
  let response = await fetchZoomResponse(downloadUrl, env, options);
  if (!response.ok && (response.status === 401 || response.status === 403) && downloadAccessToken) {
    const fallbackUrl = new URL(downloadUrl);
    fallbackUrl.searchParams.set('access_token', downloadAccessToken);
    response = await fetchDirectWithRetry(fallbackUrl.toString(), options);
  }
  if (!response.ok) {
    throw new ZoomMeetingRecordsError('zoom_transcript_download_failed', 502, `Zoom transcript download failed (HTTP ${response.status})`);
  }
  return { body: await response.text(), contentType: clean(response.headers.get('content-type')).toLowerCase() };
}

function validZoomVttBody(body: string, contentType: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (contentType.includes('text/html') || /^\s*<(?:!doctype\s+html|html)(?:\s|>)/i.test(trimmed)) return false;
  return contentType.includes('text/vtt')
    || /(?:^|\n)\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d+:)?\d{2}:\d{2}[.,]\d{3}(?:\s|$)/m.test(body);
}

async function downloadClassicTranscripts(
  candidate: DiscoveredCandidate,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
): Promise<{ files: ParsedTranscriptFile[]; complete: boolean }> {
  const files = transcriptFiles(candidate.stored);
  const downloadable = files.filter((file) => file.download_url && (file.recording_start || candidate.stored.start_time));
  const outcomes = await Promise.all(downloadable.map(async (file): Promise<ParsedTranscriptFile | null> => {
    const downloaded = await downloadZoomText(file.download_url || '', env, options, candidate.downloadAccessToken);
    if (!validZoomVttBody(downloaded.body, downloaded.contentType)) return null;
    const cues = parseZoomVtt(downloaded.body);
    const usedInstanceStart = !file.recording_start;
    const recordingStartMs = Date.parse(file.recording_start || candidate.stored.start_time || '');
    if (!Number.isFinite(recordingStartMs)) return null;
    const lines = cues.map((cue): ZoomTranscriptLine => ({
      start_time: new Date(recordingStartMs + cue.startOffsetMs).toISOString(),
      end_time: new Date(recordingStartMs + cue.endOffsetMs).toISOString(),
      speaker: cue.speaker,
      text: cue.text,
      recording_file_id: file.id,
    }));
    return { file, cues, lines, used_instance_start: usedInstanceStart };
  }));
  const parsed = outcomes.filter((file): file is ParsedTranscriptFile => !!file);
  const cueCount = parsed.reduce((sum, file) => sum + file.cues.length, 0);
  return { files: parsed, complete: files.length > 0 && parsed.length === files.length && cueCount > 0 };
}

export function zoomTimestampQuality(files: ParsedTranscriptFile[]): ZoomTimestampQuality {
  if (files.length > 1 || files.some((file) => file.used_instance_start)) return 'approximate_pause_unknown';
  const only = files[0];
  if (!only?.file.recording_start || !only.file.recording_end || !only.cues.length) return 'derived_no_pause';
  const recordingDuration = Date.parse(only.file.recording_end) - Date.parse(only.file.recording_start);
  const transcriptSpan = only.cues.at(-1)!.endOffsetMs - only.cues[0].startOffsetMs;
  const mismatch = Math.abs(recordingDuration - transcriptSpan);
  const threshold = Math.max(TIMESTAMP_MISMATCH_MIN_MS, recordingDuration * TIMESTAMP_MISMATCH_RATIO);
  return recordingDuration > 0 && mismatch > threshold ? 'approximate_pause_unknown' : 'derived_no_pause';
}

function sortedLines(files: ParsedTranscriptFile[]): ZoomTranscriptLine[] {
  return files.flatMap((file) => file.lines).sort((left, right) => (
    left.start_time.localeCompare(right.start_time)
    || left.end_time.localeCompare(right.end_time)
    || left.recording_file_id.localeCompare(right.recording_file_id)
  ));
}

function srtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function zoomMeetingLinesToSrt(lines: ZoomTranscriptLine[], t0: string): string {
  const t0Ms = Date.parse(requiredIso(t0, 'meeting_t0'));
  return lines.map((line, index) => {
    const startMs = Math.max(0, Date.parse(line.start_time) - t0Ms);
    const endMs = Math.max(startMs + 1, Date.parse(line.end_time) - t0Ms);
    const text = line.speaker.display_name ? `${line.speaker.display_name}: ${line.text}` : line.text;
    return `${index + 1}\n${srtTimestamp(startMs)} --> ${srtTimestamp(endMs)}\n${text}`;
  }).join('\n\n');
}

function probeEnabled(env: ZoomMeetingRecordsEnv): boolean {
  const value = clean(env.ZOOM_MEETING_TRANSCRIPT_PROBE).toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

function notReadyProbe(body: Record<string, unknown>): boolean {
  const reason = clean(body.download_restriction_reason).toUpperCase();
  const message = clean(body.message).toUpperCase();
  return reason.includes('NOT_READY') || message.includes('NOT_READY') || message.includes('NOT READY');
}

async function probeMeetingTranscript(
  uuid: string,
  env: ZoomMeetingRecordsEnv,
  options: RequestOptions,
): Promise<ProbeOutcome> {
  const checkedAt = new Date(options.nowMs).toISOString();
  try {
    const response = await fetchZoomResponse(zoomUrl(`meetings/${zoomUuidPathSegment(uuid)}/transcript`), env, options);
    const body = await readJson(response);
    if (!response.ok) {
      return { state: { status: notReadyProbe(body) ? 'not_ready' : 'error', checked_at: checkedAt }, cues: [] };
    }
    if (body.can_download !== true || !clean(body.download_url)) {
      return { state: { status: 'not_ready', checked_at: checkedAt }, cues: [] };
    }
    const download = await fetchZoomResponse(clean(body.download_url), env, options);
    if (!download.ok) return { state: { status: 'error', checked_at: checkedAt }, cues: [] };
    const downloadBody = await download.text();
    const contentType = clean(download.headers.get('content-type')).toLowerCase();
    if (!validZoomVttBody(downloadBody, contentType)) {
      return { state: { status: 'not_ready', checked_at: checkedAt }, cues: [] };
    }
    const cues = parseZoomVtt(downloadBody);
    if (!cues.length) return { state: { status: 'not_ready', checked_at: checkedAt }, cues: [] };
    return {
      state: {
        status: 'ready',
        checked_at: checkedAt,
        cue_count: cues.length,
        timestamp_quality: 'anchor_undocumented',
      },
      cues,
    };
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return { state: { status: 'error', checked_at: checkedAt }, cues: [] };
  }
}

function finalizeProbe(
  outcome: ProbeOutcome,
  classicLines: ZoomTranscriptLine[],
  t0: string | undefined,
  options: RequestOptions,
): ZoomMeetingTranscriptProbeState {
  const probe = { ...outcome.state };
  if (probe.status !== 'ready') return probe;
  if (outcome.cues.length && classicLines.length && t0) {
    const t0Ms = Date.parse(t0);
    probe.first_delta_ms = Math.round(outcome.cues[0].startOffsetMs - (Date.parse(classicLines[0].start_time) - t0Ms));
    probe.last_delta_ms = Math.round(outcome.cues.at(-1)!.endOffsetMs - (Date.parse(classicLines.at(-1)!.end_time) - t0Ms));
  }
  options.logger('provider_zoom_transcript_probe', {
    provider_name: 'zoom',
    provider_artifact: 'meeting_transcript',
    provider_status: 'ready',
    provider_probe_cue_count: outcome.cues.length,
    provider_classic_cue_count: classicLines.length,
    ...(probe.first_delta_ms !== undefined ? { provider_first_delta_ms: probe.first_delta_ms } : {}),
    ...(probe.last_delta_ms !== undefined ? { provider_last_delta_ms: probe.last_delta_ms } : {}),
    provider_timestamp_quality: 'anchor_undocumented',
  });
  return probe;
}

function candidateByUuid(job: ZoomMeetingJobState): ZoomMeetingInstanceCandidate | undefined {
  return job.candidates.find((candidate) => candidate.uuid === job.chosen_instance_uuid);
}

function responseFromJob(job: ZoomMeetingJobState): ZoomMeetingTranscriptResult {
  const chosen = candidateByUuid(job);
  const result: ZoomMeetingTranscriptResult = {
    status: job.status,
    ...(job.status === 'no_record'
      ? { reason: chosen ? 'recording_missing' as const : 'instance_not_found' as const }
      : job.status === 'not_generated'
        ? { reason: 'transcript_not_generated' as const }
        : {}),
    ...(job.participants ? { participants: job.participants } : {}),
    ...(chosen ? {
      record: {
        name: chosen.uuid,
        ...(chosen.start_time ? { start_time: chosen.start_time } : {}),
        ...(chosen.end_time ? { end_time: chosen.end_time } : {}),
      },
      instance_uuid: chosen.uuid,
      ...(chosen.start_time ? { t0: chosen.start_time, started_at: chosen.start_time } : {}),
      ...(chosen.end_time ? { ended_at: chosen.end_time } : {}),
    } : {}),
    ...(job.next_check_at && !job.terminal ? { next_check_at: job.next_check_at } : {}),
  };
  if (job.status === 'ready' && chosen?.start_time && job.transcript_lines && job.timestamp_quality) {
    const srt = zoomMeetingLinesToSrt(job.transcript_lines, chosen.start_time);
    result.transcript = {
      name: `past_meetings/${zoomUuidPathSegment(chosen.uuid)}/transcripts`,
      lines: job.transcript_lines,
      srt,
      timestamp_quality: job.timestamp_quality,
    };
    result.srt = srt;
    result.timestamp_quality = job.timestamp_quality;
  }
  return result;
}

function pollAnchorMs(
  current: ZoomMeetingJobState | undefined,
  chosen: ZoomMeetingInstanceCandidate | undefined,
  scheduledAt: string,
  scheduledEndAt?: string,
): number {
  const value = chosen?.end_time || chosen?.start_time || scheduledEndAt || current?.scheduled_end_at || scheduledAt;
  return Date.parse(requiredIso(value, 'zoom_meeting_poll_anchor'));
}

function probeRecheckDue(
  job: ZoomMeetingJobState | undefined,
  nowMs: number,
  enabled: boolean,
  env: ZoomMeetingRecordsEnv,
): boolean {
  if (!enabled || job?.status !== 'ready' || !job.chosen_instance_uuid || job.probe?.status === 'ready') return false;
  if (!terminalRecheckAllowed(job, nowMs, env)) return false;
  return providerArtifactTerminalRecheckDue({ terminal: true, updated_at: job.probe?.checked_at || job.updated_at }, nowMs, TERMINAL_RECHECK_MS);
}

async function refreshReadyProbe(
  job: ZoomMeetingJobState,
  env: ZoomMeetingRecordsEnv,
  ref: ZoomMeetingRecordsRef,
  key: string,
  options: RequestOptions,
): Promise<ZoomMeetingTranscriptResult> {
  const chosen = candidateByUuid(job);
  if (!chosen) return responseFromJob(job);
  const updated: ZoomMeetingJobState = {
    ...job,
    probe: finalizeProbe(
      await probeMeetingTranscript(chosen.uuid, env, options),
      job.transcript_lines || [],
      chosen.start_time,
      options,
    ),
    updated_at: new Date(options.nowMs).toISOString(),
  };
  persistJob(ref.path, key, updated);
  return responseFromJob(updated);
}

async function runCatchUp(
  env: ZoomMeetingRecordsEnv,
  recordsRef: ZoomMeetingRecordsRef,
  input: {
    meetingId: string;
    scheduledAt: string;
    scheduledEndAt?: string;
    attendance?: ZoomMeetingAttendanceWindow[];
  },
  rawOptions: ZoomMeetingRecordsOptions,
): Promise<ZoomMeetingTranscriptResult> {
  const meetingId = cleanId(input.meetingId);
  if (!/^\d+$/.test(meetingId)) throw new ZoomMeetingRecordsError('zoom_meeting_id_invalid', 400, 'space_name must be a numeric Zoom meeting id');
  const scheduledAt = requiredIso(input.scheduledAt, 'scheduled_at');
  const scheduledEndAt = input.scheduledEndAt ? requiredIso(input.scheduledEndAt, 'scheduled_end_at') : undefined;
  const nowMs = rawOptions.nowMs ?? Date.now();
  const key = meetingKey(meetingId, scheduledAt);
  const current = loadState(recordsRef.path).meetings[key];
  const inputHash = selectionInputHash(scheduledAt, scheduledEndAt, input.attendance);
  const selectionInputsChanged = !!current && current.selection_input_hash !== inputHash;
  const enabledProbe = probeEnabled(env);
  const terminalRetryDue = !!current?.terminal
    && terminalRecheckAllowed(current, nowMs, env)
    && providerArtifactTerminalRecheckDue(current, nowMs, TERMINAL_RECHECK_MS);
  const shouldRefreshProbe = probeRecheckDue(current, nowMs, enabledProbe, env);
  if (!selectionInputsChanged && ((current?.terminal && !terminalRetryDue && !shouldRefreshProbe)
    || (current?.next_check_at && nowMs < Date.parse(current.next_check_at)))) {
    return responseFromJob(current);
  }

  const options: RequestOptions = {
    fetchImpl: rawOptions.fetchImpl || fetch,
    sleepImpl: rawOptions.sleepImpl || defaultSleep,
    nowMs,
    signal: rawOptions.signal,
    logger: rawOptions.logger || ((event, details) => console.info(`[zoom-meeting-records] ${event}`, JSON.stringify(details))),
  };
  if (shouldRefreshProbe && !terminalRetryDue && current && !selectionInputsChanged) {
    return refreshReadyProbe(current, env, recordsRef, key, options);
  }

  const discovered = await discoverCandidates(meetingId, env, options);
  const candidates = discovered.map((candidate) => candidate.stored);
  const chosenStored = chooseZoomMeetingCandidate(candidates, scheduledAt, scheduledEndAt, input.attendance);
  const chosen = chosenStored ? discovered.find((candidate) => candidate.stored.uuid === chosenStored.uuid) : undefined;
  if (current?.status === 'ready'
    && terminalRetryDue
    && !selectionInputsChanged
    && (!chosenStored || chosenStored.uuid === current.chosen_instance_uuid)) {
    const rechecked = { ...current, updated_at: new Date(nowMs).toISOString() };
    persistJob(recordsRef.path, key, rechecked);
    return responseFromJob(rechecked);
  }
  const poll = providerArtifactNextPoll(
    pollAnchorMs(current, chosenStored, scheduledAt, scheduledEndAt),
    nowMs,
    ZOOM_MEETING_POLL_MINUTES,
  );
  const updated: ZoomMeetingJobState = {
    meeting_id: meetingId,
    scheduled_at: scheduledAt,
    ...(scheduledEndAt ? { scheduled_end_at: scheduledEndAt } : {}),
    selection_input_hash: inputHash,
    candidates,
    ...(chosenStored ? { chosen_instance_uuid: chosenStored.uuid } : {}),
    status: chosenStored?.recordings.length ? 'pending' : 'no_record',
    ...(poll.nextCheckAt ? { next_check_at: poll.nextCheckAt } : {}),
    attempt: poll.attempt,
    terminal: false,
    updated_at: new Date(nowMs).toISOString(),
  };

  if (chosen && chosenStored) {
    const probePromise = enabledProbe
      ? probeMeetingTranscript(chosenStored.uuid, env, options)
      : Promise.resolve<ProbeOutcome | undefined>(undefined);
    const [participants, classic, probe] = await Promise.all([
      fetchParticipants(chosenStored.uuid, env, options),
      downloadClassicTranscripts(chosen, env, options),
      probePromise,
    ]);
    updated.participants = participants;
    const lines = sortedLines(classic.files);
    if (classic.files.length) {
      updated.transcript_file_ids = classic.files.map((file) => file.file.id);
      updated.transcript_lines = lines;
      updated.timestamp_quality = zoomTimestampQuality(classic.files);
    }
    // classic 下载与 probe 并行；probe 的失败/NOT_READY 只落自身状态，不改变主链结果。
    if (probe) updated.probe = finalizeProbe(probe, lines, chosenStored.start_time, options);
    if (classic.complete) {
      updated.status = 'ready';
      updated.terminal = true;
      updated.fetched_at = new Date(nowMs).toISOString();
      delete updated.next_check_at;
    }
  }

  if (!updated.terminal && poll.exhausted) {
    updated.status = chosenStored?.recordings.length ? 'not_generated' : 'no_record';
    updated.terminal = true;
    delete updated.next_check_at;
  }
  persistJob(recordsRef.path, key, updated);
  return responseFromJob(updated);
}

export function zoomMeetingRecordsPath(env: ZoomMeetingRecordsEnv = process.env): string {
  return resolve(clean(env.ZOOM_RECORDS_STATE_PATH) || DEFAULT_ZOOM_RECORDS_PATH);
}

export async function fetchZoomMeetingTranscript(
  env: ZoomMeetingRecordsEnv = process.env,
  recordsRef: ZoomMeetingRecordsRef = { path: zoomMeetingRecordsPath(env) },
  input: {
    meetingId: string;
    scheduledAt: string;
    scheduledEndAt?: string;
    attendance?: ZoomMeetingAttendanceWindow[];
  },
  options: ZoomMeetingRecordsOptions = {},
): Promise<ZoomMeetingTranscriptResult> {
  let scheduledKey = input.scheduledAt;
  try { scheduledKey = requiredIso(input.scheduledAt, 'scheduled_at'); } catch { /* runCatchUp 返回一致的稳定错误 */ }
  const lockKey = `${recordsRef.path}|${cleanId(input.meetingId)}|${scheduledKey}`;
  let inputHash: string | undefined;
  try { inputHash = selectionInputHash(input.scheduledAt, input.scheduledEndAt, input.attendance); } catch { /* 输入错误交给 runCatchUp 统一返回 */ }

  while (true) {
    const pending = jobsInFlight.pending(lockKey);
    if (!pending) return jobsInFlight.run(lockKey, () => runCatchUp(env, recordsRef, input, options));
    await pending.catch(() => undefined);
    if (!inputHash) continue;
    const persisted = loadState(recordsRef.path).meetings[meetingKey(cleanId(input.meetingId), scheduledKey)];
    if (persisted?.selection_input_hash === inputHash) return responseFromJob(persisted);
  }
}

function sourceScheduledEnd(source: ZoomMeetingSource): string {
  return new Date(Date.parse(source.scheduled_at) + Math.max(0, source.duration_minutes) * 60_000).toISOString();
}

/** hub 周期扫 Zoom 排期快照：会议窗口结束后创建/推进 job，且由 records 状态机限频并重查终态。 */
export async function backfillZoomMeetingTranscripts(
  env: ZoomMeetingRecordsEnv = process.env,
  recordsRef: ZoomMeetingRecordsRef = { path: zoomMeetingRecordsPath(env) },
  syncRef: ZoomMeetingSyncRef = { path: zoomMeetingSyncPath(env) },
  options: ZoomMeetingRecordsOptions = {},
): Promise<ZoomMeetingTranscriptBackfillResult> {
  const nowMs = options.nowMs ?? Date.now();
  const result: ZoomMeetingTranscriptBackfillResult = { scanned: 0, advanced: 0, completed: 0, errors: [] };
  let recordsState = loadState(recordsRef.path);
  const recordsRetentionMs = nonNegativeDuration(env.ZOOM_RECORDS_RETENTION_MS, DEFAULT_RECORDS_RETENTION_MS);
  const prunable = Object.entries(recordsState.meetings)
    .filter(([, job]) => job.terminal && nowMs > jobScheduledEndMs(job) + recordsRetentionMs)
    .map(([key]) => key);
  if (prunable.length) {
    // Re-read immediately before the atomic save so pruning cannot overwrite jobs completed by a
    // concurrent request between the initial snapshot and this cleanup pass.
    const fresh = loadState(recordsRef.path);
    for (const key of prunable) {
      const job = fresh.meetings[key];
      if (job?.terminal && nowMs > jobScheduledEndMs(job) + recordsRetentionMs) delete fresh.meetings[key];
    }
    atomicSaveProviderArtifactState(recordsRef.path, fresh);
    recordsState = fresh;
  }
  for (const source of readZoomMeetingSources(syncRef)) {
    if (options.signal?.aborted) throw options.signal.reason;
    const scheduledEndAt = sourceScheduledEnd(source);
    if (Date.parse(scheduledEndAt) > nowMs) continue;
    const existing = recordsState.meetings[meetingKey(source.meeting_id, source.scheduled_at)];
    if (existing?.terminal && !terminalRecheckAllowed(existing, nowMs, env)) continue;
    result.scanned += 1;
    try {
      const transcript = await fetchZoomMeetingTranscript(env, recordsRef, {
        meetingId: source.meeting_id,
        scheduledAt: source.scheduled_at,
        scheduledEndAt,
      }, { ...options, nowMs });
      result.advanced += 1;
      if (transcript.status === 'ready') result.completed += 1;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      result.errors.push(`${source.meeting_id}|${source.scheduled_at}: ${String((error as Error)?.message || error)}`);
    }
  }
  return result;
}

export function zoomMeetingRecordsErrorPayload(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (!(error instanceof ZoomMeetingRecordsError)) return zoomOAuthErrorPayload(error);
  return { status: error.status, body: { error: { code: error.code, message: error.message } } };
}
