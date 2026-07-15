import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeGoogleMeetTranscriptEntries } from '../vendor/meeting-timeline-sdk/adapters/transcript.mjs';
import { normalizeAbsoluteMs } from '../vendor/meeting-timeline-sdk/time.mjs';

const GOOGLE_MEET_BASE = 'https://meet.googleapis.com/v2';
const MAX_ATTEMPTS = 3;
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
}

export interface GoogleMeetingTranscriptResult {
  status: 'ready' | 'pending' | 'not_generated' | 'no_record';
  record?: { name: string; start_time?: string; end_time?: string };
  transcript?: { name: string; lines: GoogleMeetTranscriptLine[]; srt: string };
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
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
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

async function fetchJson(
  url: string,
  auth: { token: string; refreshed: boolean },
  options: RequestOptions,
): Promise<Record<string, unknown>> {
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
    if (response.ok) return readJson(response);
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

function meetUrl(resource: string, query: Record<string, string> = {}): string {
  const url = new URL(`${GOOGLE_MEET_BASE}/${resource.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
  return url.toString();
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

const jobsInFlight = new Map<string, Promise<GoogleMeetingTranscriptResult>>();

async function runCatchUp(
  token: string,
  recordsRef: GoogleMeetRecordsRef,
  input: { meetingCode: string; scheduledAt: string },
  options: GoogleMeetRecordsOptions,
): Promise<GoogleMeetingTranscriptResult> {
  const meetingCode = input.meetingCode.trim();
  if (!meetingCode) throw new GoogleMeetRecordsError('google_meet_code_missing', 400);
  const scheduledAt = new Date(absoluteMs(input.scheduledAt, 'scheduled_at')).toISOString();
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(recordsRef.path);
  const key = meetingKey(meetingCode, scheduledAt);
  const current = state.meetings[key];
  if (current?.terminal || (current?.next_check_at && nowMs < Date.parse(current.next_check_at))) {
    return responseFromJob(current);
  }

  const requestOptions: RequestOptions = {
    fetchImpl: options.fetchImpl || fetch,
    sleepImpl: options.sleepImpl || defaultSleep,
    refreshAccessToken: options.refreshAccessToken,
  };
  const auth = { token, refreshed: false };
  const records = await fetchCandidates(meetingCode, auth, requestOptions);
  const chosenRecord = chooseGoogleMeetRecord(records.map((candidate) => candidate.record), scheduledAt);
  const chosen = chosenRecord ? recordCandidatesByName(records).get(chosenRecord.name) : undefined;
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

  state.meetings[key] = updated;
  saveState(recordsRef.path, state);
  return responseFromJob(updated);
}

export function fetchGoogleMeetingTranscript(
  token: string,
  recordsRef: GoogleMeetRecordsRef,
  input: { meetingCode: string; scheduledAt: string },
  options: GoogleMeetRecordsOptions = {},
): Promise<GoogleMeetingTranscriptResult> {
  if (!String(token || '').trim()) return Promise.reject(new GoogleMeetRecordsError('google_meet_token_missing', 401));
  const lockKey = `${recordsRef.path}|${input.meetingCode}|${input.scheduledAt}`;
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
