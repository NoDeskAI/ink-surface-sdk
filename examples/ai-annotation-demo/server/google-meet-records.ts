import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeGoogleMeetTranscriptEntries } from '../vendor/meeting-timeline-sdk/adapters/transcript.mjs';
import { normalizeAbsoluteMs } from '../vendor/meeting-timeline-sdk/time.mjs';

const GOOGLE_MEET_BASE = 'https://meet.googleapis.com/v2';
const GOOGLE_DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const MAX_ATTEMPTS = 3;
const SMART_NOTE_TEXT_MAX_BYTES = 100 * 1024;
export const GOOGLE_MEET_POLL_MINUTES = [2, 5, 15, 30, 60, 120] as const;

export interface GoogleMeetRecordsRef {
  path: string;
}

export interface GoogleMeetRecord {
  name: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
  space?: string;
}

export interface GoogleMeetTranscript {
  name: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: { document?: string; exportUri?: string };
}

export interface GoogleMeetSmartNote {
  name: string;
  docsDestination?: { document?: string; exportUri?: string };
}

export interface GoogleMeetRecording {
  name: string;
  state?: string;
  driveDestination?: { file?: string; exportUri?: string };
}

export interface GoogleMeetSmartNoteArtifact {
  name: string;
  exportUri?: string;
  document?: string;
  text?: string;
}

export interface GoogleMeetRecordingArtifact {
  name: string;
  state?: string;
  drive_file?: string;
  export_uri?: string;
}

export interface GoogleMeetParticipant {
  name?: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
  [key: string]: unknown;
}

export interface GoogleMeetTranscriptEntry {
  name?: string;
  participant?: string | { name?: string; displayName?: string };
  startTime?: string;
  endTime?: string;
  text?: string;
  languageCode?: string;
  [key: string]: unknown;
}

export interface GoogleMeetTranscriptLine {
  start_time: string;
  end_time: string;
  speaker_id: string;
  speaker_name?: string;
  text: string;
}

export interface GoogleMeetAttendanceWindow {
  startMs: number;
  endMs: number;
}

interface StoredRecordCandidate {
  record: GoogleMeetRecord;
  transcripts: GoogleMeetTranscript[];
  participants?: GoogleMeetParticipant[];
}

export interface GoogleMeetJobState {
  meeting_code: string;
  scheduled_at: string;
  records: StoredRecordCandidate[];
  chosen_record_name?: string;
  transcript_name?: string;
  transcript_state?: string;
  entries?: GoogleMeetTranscriptEntry[];
  participants?: GoogleMeetParticipant[];
  smart_note?: GoogleMeetSmartNoteArtifact;
  smart_note_scope_missing?: boolean;
  recordings?: GoogleMeetRecordingArtifact[];
  artifacts_fetched_at?: string;
  status: 'pending' | 'ready' | 'not_generated' | 'no_record';
  next_check_at?: string;
  attempt: number;
  terminal: boolean;
  fetched_at?: string;
  updated_at: string;
}

interface GoogleMeetRecordsFile {
  schema_version: 'inkloop.google_meet_records.v1';
  meetings: Record<string, GoogleMeetJobState>;
}

export interface GoogleMeetRecordsOptions {
  fetchImpl?: typeof fetch;
  refreshAccessToken?: () => Promise<string>;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: number;
  grantedScopes?: readonly string[];
}

export interface GoogleMeetingTranscriptResult {
  status: 'ready' | 'pending' | 'not_generated' | 'no_record';
  record?: { name: string; start_time?: string; end_time?: string };
  transcript?: { name: string; lines: GoogleMeetTranscriptLine[]; srt: string };
  smart_note?: { title?: string; text?: string; export_uri?: string; scope_missing?: boolean };
  recordings?: Array<{ export_uri: string; state: string }>;
  participants?: GoogleMeetParticipant[];
  next_check_at?: string;
}

class GoogleMeetRecordsError extends Error {
  status: number;
  code: string;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'GoogleMeetRecordsError';
    this.status = status;
    this.code = code;
  }
}

function emptyState(): GoogleMeetRecordsFile {
  return { schema_version: 'inkloop.google_meet_records.v1', meetings: {} };
}

function loadState(path: string): GoogleMeetRecordsFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoogleMeetRecordsFile>;
    return {
      schema_version: 'inkloop.google_meet_records.v1',
      meetings: parsed.meetings && typeof parsed.meetings === 'object' ? parsed.meetings : {},
    };
  } catch {
    return emptyState();
  }
}

function saveState(path: string, state: GoogleMeetRecordsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  // tmp+rename 原子落盘：进程中途挂掉不会留半截 JSON（loadState 解析失败=整库清空）
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** 写入点统一走这里：写时重新 load、只合并自己的 key、立即落盘。
 * runCatchUp/backfill 都是「函数开头 load → 长 await → 结尾 save 整文件」，两个不同会议的
 * 请求并发时后写的会用自己手里的旧快照把先写的更新整个冲掉（review P1-2）。Node 单线程下
 * 这段同步 load-merge-save 不可能被打断，天然免锁。 */
function persistJob(path: string, key: string, job: GoogleMeetJobState): void {
  const fresh = loadState(path);
  fresh.meetings[key] = job;
  saveState(path, fresh);
}

function absoluteMs(value: string | number | Date | undefined, field: string): number {
  const normalized = normalizeAbsoluteMs(value, field);
  if (normalized === undefined) throw new GoogleMeetRecordsError('google_meet_time_invalid', 400, `Missing ${field}`);
  return normalized;
}

function meetingKey(meetingCode: string, scheduledAt: string): string {
  return `${meetingCode.trim()}|${new Date(absoluteMs(scheduledAt, 'scheduled_at')).toISOString()}`;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface RequestOptions {
  fetchImpl: typeof fetch;
  sleepImpl: (delayMs: number) => Promise<void>;
  refreshAccessToken?: () => Promise<string>;
}

async function fetchResponse(
  url: string,
  auth: { token: string; refreshed: boolean },
  options: RequestOptions,
): Promise<Response> {
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const response = await options.fetchImpl(url, { headers: { authorization: `Bearer ${auth.token}` } });
    if (response.status === 401 && !auth.refreshed && options.refreshAccessToken) {
      auth.token = await options.refreshAccessToken();
      auth.refreshed = true;
      attempt -= 1;
      continue;
    }
    if (response.ok) return response;
    const body = await readJson(response);
    if (retryable(response.status) && attempt < MAX_ATTEMPTS) {
      await options.sleepImpl(250 * (2 ** (attempt - 1)));
      continue;
    }
    const apiError = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {};
    const message = String(apiError.message || `Google Meet HTTP ${response.status}`);
    throw new GoogleMeetRecordsError(
      response.status === 401 ? 'google_meet_reauth_required' : 'google_meet_request_failed',
      response.status === 401 ? 401 : 502,
      message,
    );
  }
  throw new GoogleMeetRecordsError('google_meet_retry_exhausted', 502);
}

async function fetchJson(
  url: string,
  auth: { token: string; refreshed: boolean },
  options: RequestOptions,
): Promise<Record<string, unknown>> {
  return readJson(await fetchResponse(url, auth, options));
}

async function fetchText(
  url: string,
  auth: { token: string; refreshed: boolean },
  options: RequestOptions,
): Promise<string> {
  return (await fetchResponse(url, auth, options)).text();
}

function meetUrl(resource: string, query: Record<string, string> = {}): string {
  const url = new URL(`${GOOGLE_MEET_BASE}/${resource.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function driveExportUrl(document: string): string | null {
  const raw = document.trim();
  if (!raw) return null;
  let id = raw;
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/(?:d|documents)\/([^/]+)/);
    id = match?.[1] || url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    id = raw.replace(/^documents\//, '').split('/').filter(Boolean).at(-1) || '';
  }
  if (!id) return null;
  const url = new URL(`${GOOGLE_DRIVE_BASE}/files/${encodeURIComponent(id)}/export`);
  url.searchParams.set('mimeType', 'text/plain');
  return url.toString();
}

function capUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= maxBytes ? text : bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

async function listAll<T>(input: {
  resource: string;
  collection: string;
  query?: Record<string, string>;
  auth: { token: string; refreshed: boolean };
  options: RequestOptions;
}): Promise<T[]> {
  const items: T[] = [];
  let pageToken = '';
  do {
    const body = await fetchJson(meetUrl(input.resource, {
      ...(input.query || {}),
      pageSize: '100',
      ...(pageToken ? { pageToken } : {}),
    }), input.auth, input.options);
    const pageItems = body[input.collection];
    if (Array.isArray(pageItems)) items.push(...pageItems as T[]);
    pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
  } while (pageToken);
  return items;
}

function recordStartMs(record: GoogleMeetRecord): number {
  try {
    return normalizeAbsoluteMs(record.startTime, 'conference_record_start') || 0;
  } catch {
    return 0;
  }
}

export function chooseGoogleMeetRecord(records: GoogleMeetRecord[], scheduledAt: string): GoogleMeetRecord | undefined {
  const scheduledMs = absoluteMs(scheduledAt, 'scheduled_at');
  let chosen: GoogleMeetRecord | undefined;
  let chosenDistance = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const startMs = recordStartMs(record);
    if (!record.name || !startMs) continue;
    const distance = Math.abs(startMs - scheduledMs);
    if (!chosen || distance < chosenDistance || (distance === chosenDistance && record.name.localeCompare(chosen.name) < 0)) {
      chosen = record;
      chosenDistance = distance;
    }
  }
  return chosen;
}

/** 选场：**有可用转写的场次绝对优先**（同一日程可能被反复进出产生多个场次，只有真开了转写的那场才是"正主"），
 *  组内再按离计划时间最近取。真机踩过：计划时间离"复进无转写的第二场"更近，纯时间就近会选错。 */
export function chooseGoogleMeetCandidate(
  candidates: StoredRecordCandidate[],
  scheduledAt: string,
  attendance: GoogleMeetAttendanceWindow[] = [],
): StoredRecordCandidate | undefined {
  const validAttendance = attendance.filter((window) => (
    Number.isFinite(window.startMs)
    && Number.isFinite(window.endMs)
    && window.endMs >= window.startMs
  ));
  const overlapping = validAttendance.length
    ? candidates.filter((candidate) => {
      const startMs = recordStartMs(candidate.record);
      let endMs = startMs;
      try {
        endMs = normalizeAbsoluteMs(candidate.record.endTime, 'conference_record_end') || startMs;
      } catch {
        endMs = startMs;
      }
      return !!startMs && validAttendance.some((window) => (
        Math.min(endMs, window.endMs) > Math.max(startMs, window.startMs)
      ));
    })
    : [];
  const attendancePool = overlapping.length ? overlapping : candidates;
  const withTranscript = attendancePool.filter((candidate) => candidate.transcripts.some(transcriptReady));
  const pool = withTranscript.length ? withTranscript : attendancePool;
  const chosenRecord = chooseGoogleMeetRecord(pool.map((candidate) => candidate.record), scheduledAt);
  return chosenRecord ? pool.find((candidate) => candidate.record.name === chosenRecord.name) : undefined;
}

function transcriptReady(transcript: GoogleMeetTranscript): boolean {
  return transcript.state === 'FILE_GENERATED' || transcript.state === 'ENDED';
}

function chooseTranscript(transcripts: GoogleMeetTranscript[]): GoogleMeetTranscript | undefined {
  const ranked = [...transcripts].sort((left, right) => {
    const readyDelta = Number(transcriptReady(right)) - Number(transcriptReady(left));
    if (readyDelta) return readyDelta;
    return String(left.startTime || left.name).localeCompare(String(right.startTime || right.name));
  });
  return ranked[0];
}

export function normalizeGoogleMeetSmartNote(note: GoogleMeetSmartNote): GoogleMeetSmartNoteArtifact | null {
  const name = String(note?.name || '').trim();
  if (!name) return null;
  const exportUri = String(note.docsDestination?.exportUri || '').trim();
  const document = String(note.docsDestination?.document || '').trim();
  return { name, ...(exportUri ? { exportUri } : {}), ...(document ? { document } : {}) };
}

export function normalizeGoogleMeetRecording(recording: GoogleMeetRecording): GoogleMeetRecordingArtifact | null {
  const name = String(recording?.name || '').trim();
  if (!name) return null;
  const state = String(recording.state || '').trim();
  const driveFile = String(recording.driveDestination?.file || '').trim();
  const exportUri = String(recording.driveDestination?.exportUri || '').trim();
  return {
    name,
    ...(state ? { state } : {}),
    ...(driveFile ? { drive_file: driveFile } : {}),
    ...(exportUri ? { export_uri: exportUri } : {}),
  };
}

async function fetchChosenArtifacts(
  recordName: string,
  auth: { token: string; refreshed: boolean },
  options: RequestOptions,
  grantedScopes: readonly string[],
): Promise<Pick<GoogleMeetJobState, 'smart_note' | 'smart_note_scope_missing' | 'recordings'>> {
  // 纪要/录像互为可选：一件拉挂不连累另一件（review P1-3）。失败件留空，backfill 窗口内自动重试。
  const optional = async <T>(what: string, run: () => Promise<T[]>): Promise<T[]> => {
    try { return await run(); } catch (e) {
      console.warn(`[google-meet-records] optional artifact ${what} fetch failed:`, String((e as Error)?.message || e));
      return [];
    }
  };
  const smartNotes = await optional('smartNotes', () => listAll<GoogleMeetSmartNote>({
    resource: `${recordName}/smartNotes`,
    collection: 'smartNotes',
    auth,
    options,
  }));
  const recordings = await optional('recordings', () => listAll<GoogleMeetRecording>({
    resource: `${recordName}/recordings`,
    collection: 'recordings',
    auth,
    options,
  }));
  const smartNote = smartNotes
    .map(normalizeGoogleMeetSmartNote)
    .filter((note): note is GoogleMeetSmartNoteArtifact => !!note)
    .sort((left, right) => left.name.localeCompare(right.name))[0];
  const normalizedRecordings = recordings
    .map(normalizeGoogleMeetRecording)
    .filter((recording): recording is GoogleMeetRecordingArtifact => !!recording);
  let scopeMissing = false;
  if (smartNote?.document) {
    if (!grantedScopes.includes(GOOGLE_DRIVE_READONLY_SCOPE)) {
      scopeMissing = true;
    } else {
      const exportUrl = driveExportUrl(smartNote.document);
      if (exportUrl) {
        try {
          smartNote.text = capUtf8(await fetchText(exportUrl, auth, options), SMART_NOTE_TEXT_MAX_BYTES);
        } catch (e) {
          // Doc 导出瞬时失败：保留纪要壳（text 缺失→backfillDue 继续为真），窗口内重试补正文
          console.warn('[google-meet-records] smart note doc export failed:', String((e as Error)?.message || e));
        }
      }
    }
  }
  return {
    ...(smartNote ? { smart_note: smartNote } : {}),
    ...(scopeMissing ? { smart_note_scope_missing: true } : {}),
    ...(normalizedRecordings.length ? { recordings: normalizedRecordings } : {}),
  };
}

function recordCandidatesByName(candidates: StoredRecordCandidate[]): Map<string, StoredRecordCandidate> {
  return new Map(candidates.map((candidate) => [candidate.record.name, candidate]));
}

function participantDisplayName(participant: GoogleMeetParticipant): string | undefined {
  const name = participant.signedinUser?.displayName
    || participant.anonymousUser?.displayName
    || participant.phoneUser?.displayName;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

export function normalizeGoogleMeetingLines(
  entries: GoogleMeetTranscriptEntry[],
  participants: GoogleMeetParticipant[] = [],
): GoogleMeetTranscriptLine[] {
  const names = new Map<string, string>();
  for (const participant of participants) {
    const name = participantDisplayName(participant);
    const resource = typeof participant.name === 'string' ? participant.name : '';
    if (!name || !resource) continue;
    names.set(resource, name);
    names.set(resource.split('/').at(-1) || resource, name);
  }
  const normalized = normalizeGoogleMeetTranscriptEntries({ entries }) as Array<Record<string, unknown>>;
  return normalized.flatMap((line) => {
    const startTime = typeof line.start_time === 'string' ? line.start_time : '';
    const endTime = typeof line.end_time === 'string' ? line.end_time : '';
    const text = typeof line.text === 'string' ? line.text.trim() : '';
    if (!startTime || !endTime || !text) return [];
    const speakerId = typeof line.speaker_id === 'string' ? line.speaker_id : '';
    const raw = line.raw && typeof line.raw === 'object' ? line.raw as GoogleMeetTranscriptEntry : {};
    const rawParticipant = typeof raw.participant === 'string' ? raw.participant : raw.participant?.name || '';
    const speakerName = names.get(rawParticipant)
      || names.get(speakerId)
      || (typeof line.speaker_name === 'string' ? line.speaker_name : undefined);
    return [{
      start_time: startTime,
      end_time: endTime,
      speaker_id: speakerId,
      ...(speakerName ? { speaker_name: speakerName } : {}),
      text,
    }];
  });
}

function srtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export function googleMeetingLinesToSrt(lines: GoogleMeetTranscriptLine[], recordStartTime: string): string {
  const recordStartMs = absoluteMs(recordStartTime, 'conference_record_start');
  return lines.map((line, index) => {
    const startMs = Math.max(0, absoluteMs(line.start_time, 'transcript_entry_start') - recordStartMs);
    const endMs = Math.max(startMs + 1, absoluteMs(line.end_time, 'transcript_entry_end') - recordStartMs);
    const speaker = line.speaker_name || line.speaker_id;
    const text = speaker ? `${speaker}: ${line.text}` : line.text;
    return `${index + 1}\n${srtTimestamp(startMs)} --> ${srtTimestamp(endMs)}\n${text}`;
  }).join('\n\n');
}

function responseFromJob(job: GoogleMeetJobState): GoogleMeetingTranscriptResult {
  const chosen = job.chosen_record_name ? recordCandidatesByName(job.records).get(job.chosen_record_name) : undefined;
  const record = chosen?.record;
  const result: GoogleMeetingTranscriptResult = {
    status: job.status,
    ...(record ? { record: { name: record.name, ...(record.startTime ? { start_time: record.startTime } : {}), ...(record.endTime ? { end_time: record.endTime } : {}) } } : {}),
    ...(job.participants?.length ? { participants: job.participants } : {}),
    ...(job.next_check_at && !job.terminal ? { next_check_at: job.next_check_at } : {}),
    ...(job.smart_note ? { smart_note: {
      ...(job.smart_note.text ? { text: job.smart_note.text } : {}),
      ...(job.smart_note.exportUri ? { export_uri: job.smart_note.exportUri } : {}),
      ...(job.smart_note_scope_missing ? { scope_missing: true } : {}),
    } } : {}),
    ...(job.recordings?.some((recording) => recording.export_uri) ? {
      recordings: job.recordings.flatMap((recording) => recording.export_uri
        ? [{ export_uri: recording.export_uri, state: recording.state || 'STATE_UNSPECIFIED' }]
        : []),
    } : {}),
  };
  if (job.status === 'ready' && record?.startTime && job.transcript_name && job.entries) {
    const lines = normalizeGoogleMeetingLines(job.entries, job.participants);
    result.transcript = {
      name: job.transcript_name,
      lines,
      srt: googleMeetingLinesToSrt(lines, record.startTime),
    };
  }
  return result;
}

function pollAnchorMs(job: GoogleMeetJobState, chosen?: GoogleMeetRecord): number {
  const input = chosen?.endTime || chosen?.startTime || job.scheduled_at;
  return absoluteMs(input, 'google_meet_poll_anchor');
}

function nextPoll(anchorMs: number, nowMs: number): { attempt: number; nextCheckAt?: string; exhausted: boolean } {
  const elapsedMs = Math.max(0, nowMs - anchorMs);
  const elapsedMinutes = elapsedMs / 60_000;
  const attempt = GOOGLE_MEET_POLL_MINUTES.filter((minute) => elapsedMinutes >= minute).length;
  const nextMinute = GOOGLE_MEET_POLL_MINUTES[attempt];
  return {
    attempt,
    ...(nextMinute ? { nextCheckAt: new Date(anchorMs + nextMinute * 60_000).toISOString() } : {}),
    exhausted: elapsedMinutes >= GOOGLE_MEET_POLL_MINUTES.at(-1)!,
  };
}

async function fetchCandidates(
  meetingCode: string,
  auth: { token: string; refreshed: boolean },
  options: RequestOptions,
): Promise<StoredRecordCandidate[]> {
  const records = await listAll<GoogleMeetRecord>({
    resource: 'conferenceRecords',
    collection: 'conferenceRecords',
    query: { filter: `space.meeting_code="${meetingCode.replaceAll('"', '')}"` },
    auth,
    options,
  });
  const candidates: StoredRecordCandidate[] = [];
  for (const record of records.filter((item) => typeof item.name === 'string' && item.name)) {
    const transcripts = await listAll<GoogleMeetTranscript>({
      resource: `${record.name}/transcripts`,
      collection: 'transcripts',
      auth,
      options,
    });
    let participants: GoogleMeetParticipant[] | undefined;
    try {
      participants = await listAll<GoogleMeetParticipant>({
        resource: `${record.name}/participants`,
        collection: 'participants',
        auth,
        options,
      });
    } catch {
      participants = undefined;
    }
    candidates.push({ record, transcripts, ...(participants ? { participants } : {}) });
  }
  return candidates;
}

const GOOGLE_MEET_ARTIFACT_BACKFILL_WINDOW_MS = 60 * 60_000;
const GOOGLE_MEET_ARTIFACT_BACKFILL_MIN_INTERVAL_MS = 2 * 60_000;

// Gemini 智能纪要在会议结束后几分钟才导出成 Doc：转写 ready 的首次拉取常拿到"只有资源名"的空壳
// （无 docsDestination/text）。空壳不算终态——会议结束后一小时内限频回查，直到拿到正文或窗口关闭。
function googleMeetArtifactBackfillDue(job: GoogleMeetJobState | undefined, nowMs: number): boolean {
  if (job?.status !== 'ready') return false;
  const fetchedAtMs = Date.parse(job.artifacts_fetched_at || '');
  if (!Number.isFinite(fetchedAtMs)) return true;
  if (job.smart_note_scope_missing) return false; // scope 缺失走 driveScopeAdded 专门路径
  if (job.smart_note?.text) return false;
  const chosen = job.chosen_record_name ? recordCandidatesByName(job.records).get(job.chosen_record_name) : undefined;
  if (nowMs - pollAnchorMs(job, chosen?.record) > GOOGLE_MEET_ARTIFACT_BACKFILL_WINDOW_MS) return false;
  return nowMs - fetchedAtMs >= GOOGLE_MEET_ARTIFACT_BACKFILL_MIN_INTERVAL_MS;
}

/** artifact-only 回补：只重拉 smartNotes/recordings，保留 ready job 的转写与记录不动。 */
async function backfillJobArtifacts(
  job: GoogleMeetJobState,
  auth: { token: string; refreshed: boolean },
  requestOptions: RequestOptions,
  grantedScopes: readonly string[],
  nowMs: number,
): Promise<GoogleMeetJobState | null> {
  const chosen = job.chosen_record_name ? recordCandidatesByName(job.records).get(job.chosen_record_name) : undefined;
  if (!chosen?.record.name) return null;
  const artifacts = await fetchChosenArtifacts(chosen.record.name, auth, requestOptions, grantedScopes);
  const updated: GoogleMeetJobState = {
    ...job,
    ...(artifacts.smart_note ? { smart_note: artifacts.smart_note } : {}),
    ...(artifacts.recordings ? { recordings: artifacts.recordings } : {}),
    artifacts_fetched_at: new Date(nowMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  };
  if (artifacts.smart_note_scope_missing) updated.smart_note_scope_missing = true;
  else delete updated.smart_note_scope_missing;
  return updated;
}

export interface GoogleMeetSmartNoteBackfillResult {
  scanned: number;
  backfilled: number;
  completed: number;
  errors: string[];
}

/** hub 侧周期回补：扫 meet-records 里"ready 但纪要正文没到手且仍在窗口内"的 job，主动补拉。
 * 设备不在线/recap 没打开也能拿到 Gemini 纪要——设备端请求只是另一个触发源，不是唯一触发源。 */
export async function backfillGoogleMeetSmartNotes(
  token: string,
  recordsRef: GoogleMeetRecordsRef,
  options: GoogleMeetRecordsOptions = {},
): Promise<GoogleMeetSmartNoteBackfillResult> {
  const nowMs = options.nowMs ?? Date.now();
  const result: GoogleMeetSmartNoteBackfillResult = { scanned: 0, backfilled: 0, completed: 0, errors: [] };
  if (!String(token || '').trim()) return result;
  const state = loadState(recordsRef.path);
  const requestOptions: RequestOptions = {
    fetchImpl: options.fetchImpl || fetch,
    sleepImpl: options.sleepImpl || defaultSleep,
    refreshAccessToken: options.refreshAccessToken,
  };
  const auth = { token, refreshed: false };
  for (const [key, job] of Object.entries(state.meetings)) {
    if (!googleMeetArtifactBackfillDue(job, nowMs)) continue;
    result.scanned += 1;
    try {
      const updated = await backfillJobArtifacts(job, auth, requestOptions, options.grantedScopes || [], nowMs);
      if (!updated) continue;
      // 逐条 persistJob（写时重读合并）：整轮扫完才 save 会用开头的旧快照冲掉扫描期间 runCatchUp 的并发写
      persistJob(recordsRef.path, key, updated);
      result.backfilled += 1;
      if (updated.smart_note?.text) result.completed += 1;
    } catch (e) {
      result.errors.push(`${key}: ${String((e as Error)?.message || e)}`);
    }
  }
  return result;
}

const jobsInFlight = new Map<string, Promise<GoogleMeetingTranscriptResult>>();

async function runCatchUp(
  token: string,
  recordsRef: GoogleMeetRecordsRef,
  input: { meetingCode: string; scheduledAt: string; attendance?: GoogleMeetAttendanceWindow[] },
  options: GoogleMeetRecordsOptions,
): Promise<GoogleMeetingTranscriptResult> {
  const meetingCode = input.meetingCode.trim();
  if (!meetingCode) throw new GoogleMeetRecordsError('google_meet_code_missing', 400);
  const scheduledAt = new Date(absoluteMs(input.scheduledAt, 'scheduled_at')).toISOString();
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(recordsRef.path);
  const key = meetingKey(meetingCode, scheduledAt);
  const current = state.meetings[key];
  const currentUpdatedMs = Date.parse(current?.updated_at || '');
  const terminalRetryDue = !!current?.terminal
    && current.status !== 'ready'
    && (!Number.isFinite(currentUpdatedMs) || nowMs - currentUpdatedMs >= 10 * 60_000);
  const driveScopeAdded = !!current?.smart_note_scope_missing && (options.grantedScopes || []).includes(GOOGLE_DRIVE_READONLY_SCOPE);
  const artifactBackfillDue = googleMeetArtifactBackfillDue(current, nowMs);
  if ((current?.terminal && !terminalRetryDue && !driveScopeAdded && !artifactBackfillDue)
    || (current?.next_check_at && nowMs < Date.parse(current.next_check_at))) {
    return responseFromJob(current);
  }

  const requestOptions: RequestOptions = {
    fetchImpl: options.fetchImpl || fetch,
    sleepImpl: options.sleepImpl || defaultSleep,
    refreshAccessToken: options.refreshAccessToken,
  };
  const auth = { token, refreshed: false };

  // ready job 只差 artifact（智能纪要空壳/新授权 drive scope）时走 artifact-only 回补：
  // 不重拉 conference records/transcripts/entries——全量重跑一旦 Google 列表瞬时抖空，
  // 已到手的 ready 转写会被降级覆盖成 pending/no_record。
  if (current?.status === 'ready' && (artifactBackfillDue || driveScopeAdded)) {
    try {
      const refreshed = await backfillJobArtifacts(current, auth, requestOptions, options.grantedScopes || [], nowMs);
      if (refreshed) {
        persistJob(recordsRef.path, key, refreshed);
        return responseFromJob(refreshed);
      }
      // chosen record 异常缺失才会走到这：退回全量路径自愈。
    } catch (e) {
      // 纪要/录像是可选产物：回补失败不能把已 ready 的转写响应打成 5xx（review P1-3），窗口内下次再试
      console.warn('[google-meet-records] artifact backfill failed, keep ready transcript:', String((e as Error)?.message || e));
      return responseFromJob(current);
    }
  }

  const records = await fetchCandidates(meetingCode, auth, requestOptions);
  const chosen = chooseGoogleMeetCandidate(records, scheduledAt, input.attendance);
  const chosenRecord = chosen?.record;
  const anchorMs = pollAnchorMs(current || {
    meeting_code: meetingCode,
    scheduled_at: scheduledAt,
    records: [],
    status: 'pending',
    attempt: 0,
    terminal: false,
    updated_at: new Date(nowMs).toISOString(),
  }, chosenRecord);
  const poll = nextPoll(anchorMs, nowMs);
  const transcript = chosen ? chooseTranscript(chosen.transcripts) : undefined;
  const updated: GoogleMeetJobState = {
    meeting_code: meetingCode,
    scheduled_at: scheduledAt,
    records,
    ...(chosenRecord ? { chosen_record_name: chosenRecord.name } : {}),
    ...(transcript?.name ? { transcript_name: transcript.name } : {}),
    ...(transcript?.state ? { transcript_state: transcript.state } : {}),
    ...(chosen?.participants ? { participants: chosen.participants } : {}),
    status: chosenRecord ? 'pending' : 'no_record',
    ...(poll.nextCheckAt ? { next_check_at: poll.nextCheckAt } : {}),
    attempt: poll.attempt,
    terminal: false,
    updated_at: new Date(nowMs).toISOString(),
  };

  if (chosenRecord) {
    try {
      const artifacts = await fetchChosenArtifacts(
        chosenRecord.name,
        auth,
        requestOptions,
        options.grantedScopes || [],
      );
      Object.assign(updated, artifacts);
      updated.artifacts_fetched_at = new Date(nowMs).toISOString();
    } catch (e) {
      // 可选产物失败不连累转写主链（review P1-3）；不落 artifacts_fetched_at → backfillDue 视为待补，窗口内自动重试
      console.warn('[google-meet-records] artifacts fetch failed, transcript flow continues:', String((e as Error)?.message || e));
    }
  }

  if (chosenRecord && transcript?.name && transcriptReady(transcript)) {
    const entries = await listAll<GoogleMeetTranscriptEntry>({
      resource: `${transcript.name}/entries`,
      collection: 'transcriptEntries',
      auth,
      options: requestOptions,
    });
    updated.entries = entries;
    updated.status = 'ready';
    updated.terminal = true;
    updated.fetched_at = new Date(nowMs).toISOString();
    delete updated.next_check_at;
  } else if (poll.exhausted) {
    updated.status = chosenRecord ? 'not_generated' : 'no_record';
    updated.terminal = true;
    delete updated.next_check_at;
  }

  persistJob(recordsRef.path, key, updated);
  return responseFromJob(updated);
}

export function fetchGoogleMeetingTranscript(
  token: string,
  recordsRef: GoogleMeetRecordsRef,
  input: { meetingCode: string; scheduledAt: string; attendance?: GoogleMeetAttendanceWindow[] },
  options: GoogleMeetRecordsOptions = {},
): Promise<GoogleMeetingTranscriptResult> {
  if (!String(token || '').trim()) return Promise.reject(new GoogleMeetRecordsError('google_meet_token_missing', 401));
  // scheduledAt 归一化后再做 single-flight key：同一会议的等价时间写法（±时区/秒精度）不该绕过去重。
  let scheduledKey = input.scheduledAt;
  try { scheduledKey = new Date(absoluteMs(input.scheduledAt, 'scheduled_at')).toISOString(); } catch { /* 非法输入交给 runCatchUp 抛同样的错 */ }
  const lockKey = `${recordsRef.path}|${input.meetingCode.trim()}|${scheduledKey}`;
  const existing = jobsInFlight.get(lockKey);
  if (existing) return existing;
  const job = runCatchUp(token, recordsRef, input, options).finally(() => jobsInFlight.delete(lockKey));
  jobsInFlight.set(lockKey, job);
  return job;
}

export function googleMeetRecordsErrorPayload(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  const status = error instanceof GoogleMeetRecordsError ? error.status : Number((error as { status?: number })?.status) || 500;
  const code = error instanceof GoogleMeetRecordsError ? error.code : 'google_meet_records_failed';
  const message = error instanceof Error ? error.message : String(error);
  return { status, body: { error: { code, message } } };
}
