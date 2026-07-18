/**
 * Zoom 排期会议快照同步：枚举显式/账号 Licensed 主持人，串行消费 List Meetings 分页并用
 * Get Meeting 补齐单次/周期会议；快照原子落盘，缺席项短期标 missing_since 后按保留期删除。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicSaveProviderArtifactState,
  loadProviderArtifactState,
  ProviderArtifactSingleFlight,
} from './provider-artifact-poller';
import {
  zoomOAuthErrorPayload,
  zoomS2SFetch,
  type ZoomS2SEnv,
} from './zoom-oauth-state';
import { zoomUuidPathSegment } from './zoom-uuid';

const ZOOM_API_BASE = 'https://api.zoom.us/v2';
const DEFAULT_ZOOM_SYNC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../.inkloop/zoom-sync/state.json');
const DEFAULT_MIN_SYNC_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_DISCOVERED_HOSTS = 10;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_PAGES = 100;
const DEFAULT_MISSING_SOURCE_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface ZoomMeetingSyncEnv extends ZoomS2SEnv {
  ZOOM_HOST_USER_IDS?: string;
  ZOOM_SYNC_STATE_PATH?: string;
  ZOOM_MISSING_SOURCE_RETENTION_MS?: string;
}

export interface ZoomMeetingSource {
  platform: 'zoom';
  meeting_id: string;
  topic: string;
  scheduled_at: string;
  duration_minutes: number;
  join_url: string;
  host_user_id: string;
  occurrence_id?: string;
  timezone?: string;
  missing_since?: string;
}

interface ZoomSyncFile {
  schema_version: 'inkloop.zoom_sync.v1';
  meetings: ZoomMeetingSource[];
  fetched_at?: string;
}

interface ZoomUser {
  id?: string;
  type?: number;
}

interface ZoomMeeting {
  id?: string | number;
  type?: number;
  topic?: string;
  start_time?: string;
  timezone?: string;
  join_url?: string;
  duration?: number;
  host_id?: string;
  occurrence_id?: string;
  status?: string;
  occurrences?: ZoomMeeting[];
}

export interface ZoomMeetingSyncRef {
  path: string;
}

export interface ZoomMeetingSyncOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: number;
  minIntervalMs?: number;
  force?: boolean;
  signal?: AbortSignal;
}

interface ZoomRequestOptions {
  fetchImpl: typeof fetch;
  sleepImpl: (delayMs: number) => Promise<void>;
  nowMs: number;
  signal?: AbortSignal;
}

export interface ZoomMeetingSourcesResult {
  source: 'zoom';
  source_count: number;
  sources: ZoomMeetingSource[];
  fetched_at?: string;
  throttled: boolean;
}

export class ZoomMeetingSyncError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'ZoomMeetingSyncError';
    this.status = status;
    this.code = code;
  }
}

const syncInflight = new ProviderArtifactSingleFlight<ZoomMeetingSourcesResult>();

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

export function zoomMeetingIdFromUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'zoom.us' && !hostname.endsWith('.zoom.us')) return '';
    const meetingId = url.pathname.match(/^\/j\/(\d+)(?:\/|$)/)?.[1] || '';
    return /^\d+$/.test(meetingId) ? meetingId : '';
  } catch {
    return '';
  }
}

function emptyState(): ZoomSyncFile {
  return { schema_version: 'inkloop.zoom_sync.v1', meetings: [] };
}

function normalizeScheduledAt(value: unknown): string {
  const raw = clean(value);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** 只接受设备契约字段，保证历史/远端对象中的 start_url 不会被透传进状态文件。 */
function sanitizeSource(value: unknown): ZoomMeetingSource | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const meetingId = clean(input.meeting_id);
  const scheduledAt = normalizeScheduledAt(input.scheduled_at);
  const joinUrl = clean(input.join_url);
  const hostUserId = clean(input.host_user_id);
  if (!meetingId || !scheduledAt || !joinUrl || !hostUserId) return null;
  const duration = Number(input.duration_minutes);
  const occurrenceId = clean(input.occurrence_id);
  const timezone = clean(input.timezone);
  const missingSince = normalizeScheduledAt(input.missing_since);
  return {
    platform: 'zoom',
    meeting_id: meetingId,
    topic: clean(input.topic) || 'Zoom Meeting',
    scheduled_at: scheduledAt,
    duration_minutes: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    join_url: joinUrl,
    host_user_id: hostUserId,
    ...(occurrenceId ? { occurrence_id: occurrenceId } : {}),
    ...(timezone ? { timezone } : {}),
    ...(missingSince ? { missing_since: missingSince } : {}),
  };
}

function loadState(path: string): ZoomSyncFile {
  return loadProviderArtifactState(path, emptyState, (value) => {
    const parsed = value && typeof value === 'object' ? value as Partial<ZoomSyncFile> : {};
    const meetings = Array.isArray(parsed.meetings)
      ? parsed.meetings.map(sanitizeSource).filter((item): item is ZoomMeetingSource => !!item)
      : [];
    const fetchedAt = normalizeScheduledAt(parsed.fetched_at);
    return {
      schema_version: 'inkloop.zoom_sync.v1',
      meetings,
      ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
    };
  });
}

function sourceKey(source: Pick<ZoomMeetingSource, 'host_user_id' | 'meeting_id' | 'occurrence_id'>): string {
  return `${source.host_user_id}|${source.meeting_id}|${source.occurrence_id || ''}`;
}

function sortSources(sources: ZoomMeetingSource[]): ZoomMeetingSource[] {
  return sources.sort((left, right) => (
    left.scheduled_at.localeCompare(right.scheduled_at)
    || left.meeting_id.localeCompare(right.meeting_id)
    || left.host_user_id.localeCompare(right.host_user_id)
  ));
}

function resultFromState(state: ZoomSyncFile, throttled: boolean): ZoomMeetingSourcesResult {
  const sources = sortSources([...state.meetings]);
  return {
    source: 'zoom',
    source_count: sources.length,
    sources,
    ...(state.fetched_at ? { fetched_at: state.fetched_at } : {}),
    throttled,
  };
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

async function abortableSleep(delayMs: number, options: ZoomRequestOptions): Promise<void> {
  if (!options.signal) return options.sleepImpl(delayMs);
  if (options.signal.aborted) throw options.signal.reason;
  const signal = options.signal;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      options.sleepImpl(delayMs),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ZoomMeetingSyncError('zoom_api_invalid_response', 502, 'Zoom API returned invalid JSON');
  }
}

async function fetchZoomJson(
  url: string,
  env: ZoomMeetingSyncEnv,
  options: ZoomRequestOptions,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await zoomS2SFetch(url, { signal: options.signal }, env, { fetchImpl: options.fetchImpl, nowMs: options.nowMs });
    if (response.ok) return readJson(response);
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      const fallbackMs = 250 * (2 ** (attempt - 1));
      await abortableSleep(response.status === 429
        ? retryAfterMs(response, options.nowMs, fallbackMs)
        : fallbackMs, options);
      continue;
    }
    throw new ZoomMeetingSyncError(
      response.status === 401 ? 'zoom_s2s_unauthorized' : 'zoom_api_request_failed',
      response.status === 401 ? 401 : 502,
      `Zoom API request failed (HTTP ${response.status})`,
    );
  }
  throw new ZoomMeetingSyncError('zoom_api_retry_exhausted', 502);
}

function explicitHostIds(env: ZoomMeetingSyncEnv): string[] {
  return [...new Set(clean(env.ZOOM_HOST_USER_IDS).split(',').map((value) => value.trim()).filter(Boolean))];
}

async function discoverHostIds(
  env: ZoomMeetingSyncEnv,
  options: ZoomRequestOptions,
): Promise<string[]> {
  const explicit = explicitHostIds(env);
  if (explicit.length) return explicit;
  const hosts: string[] = [];
  let nextPageToken = '';
  const seenTokens = new Set<string>();
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await fetchZoomJson(zoomUrl('users', {
      status: 'active',
      page_size: '30',
      ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
    }), env, options);
    const users = Array.isArray(page.users) ? page.users as ZoomUser[] : [];
    for (const user of users) {
      const id = clean(user.id);
      if (id && Number(user.type) >= 2 && !hosts.includes(id)) hosts.push(id);
      if (hosts.length >= MAX_DISCOVERED_HOSTS) return hosts;
    }
    const token = clean(page.next_page_token);
    if (!token) return hosts;
    if (seenTokens.has(token)) throw new ZoomMeetingSyncError('zoom_pagination_token_loop', 502, 'Zoom user pagination token repeated');
    seenTokens.add(token);
    nextPageToken = token;
  }
  throw new ZoomMeetingSyncError('zoom_pagination_limit_exceeded', 502, 'Zoom user pagination limit exceeded');
}

async function listHostMeetings(
  hostUserId: string,
  env: ZoomMeetingSyncEnv,
  options: ZoomRequestOptions,
): Promise<ZoomMeeting[]> {
  const meetings: ZoomMeeting[] = [];
  let nextPageToken = '';
  const seenTokens = new Set<string>();
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await fetchZoomJson(zoomUrl(`users/${zoomUuidPathSegment(hostUserId)}/meetings`, {
      type: 'scheduled',
      page_size: '30',
      ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
    }), env, options);
    if (Array.isArray(page.meetings)) meetings.push(...page.meetings as ZoomMeeting[]);
    const token = clean(page.next_page_token);
    if (!token) return meetings;
    if (seenTokens.has(token)) throw new ZoomMeetingSyncError('zoom_pagination_token_loop', 502, 'Zoom meeting pagination token repeated');
    seenTokens.add(token);
    nextPageToken = token;
  }
  throw new ZoomMeetingSyncError('zoom_pagination_limit_exceeded', 502, 'Zoom meeting pagination limit exceeded');
}

async function listMeetingOccurrences(
  meetingId: string,
  env: ZoomMeetingSyncEnv,
  options: ZoomRequestOptions,
): Promise<ZoomMeeting[]> {
  const occurrences: ZoomMeeting[] = [];
  let nextPageToken = '';
  const seenTokens = new Set<string>();
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await fetchZoomJson(zoomUrl(`meetings/${zoomUuidPathSegment(meetingId)}`, {
      show_previous_occurrences: 'true',
      ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
    }), env, options);
    if (Array.isArray(page.occurrences)) occurrences.push(...page.occurrences as ZoomMeeting[]);
    const token = clean(page.next_page_token);
    if (!token) return occurrences;
    if (seenTokens.has(token)) throw new ZoomMeetingSyncError('zoom_pagination_token_loop', 502, 'Zoom occurrence pagination token repeated');
    seenTokens.add(token);
    nextPageToken = token;
  }
  throw new ZoomMeetingSyncError('zoom_pagination_limit_exceeded', 502, 'Zoom occurrence pagination limit exceeded');
}

function normalizeMeeting(detail: ZoomMeeting, listed: ZoomMeeting, hostUserId: string): ZoomMeetingSource | null {
  const meetingId = cleanId(detail.id ?? listed.id);
  const scheduledAt = normalizeScheduledAt(detail.start_time || listed.start_time);
  const joinUrl = clean(detail.join_url || listed.join_url);
  if (!meetingId || !scheduledAt || !joinUrl) return null;
  const duration = Number(detail.duration ?? listed.duration);
  const occurrenceId = clean(detail.occurrence_id || listed.occurrence_id);
  const timezone = clean(detail.timezone || listed.timezone);
  return {
    platform: 'zoom',
    meeting_id: meetingId,
    topic: clean(detail.topic || listed.topic) || 'Zoom Meeting',
    scheduled_at: scheduledAt,
    duration_minutes: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    join_url: joinUrl,
    // Preserve the lookup identity used by configuration/discovery. A configured host may be an
    // email while Get Meeting returns an opaque host_id; authorization mappings must remain stable.
    host_user_id: hostUserId,
    ...(occurrenceId ? { occurrence_id: occurrenceId } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

async function runSync(
  env: ZoomMeetingSyncEnv,
  ref: ZoomMeetingSyncRef,
  options: ZoomMeetingSyncOptions,
): Promise<ZoomMeetingSourcesResult> {
  const nowMs = options.nowMs ?? Date.now();
  const current = loadState(ref.path);
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_SYNC_INTERVAL_MS);
  const fetchedAtMs = Date.parse(current.fetched_at || '');
  if (!options.force && Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs < minIntervalMs) {
    return resultFromState(current, true);
  }
  const requestOptions = {
    fetchImpl: options.fetchImpl || fetch,
    sleepImpl: options.sleepImpl || defaultSleep,
    nowMs,
    signal: options.signal,
  };
  const currentSources = new Map(current.meetings.map((source) => [sourceKey(source), source]));
  const nextSources = new Map<string, ZoomMeetingSource>();
  const hostIds = await discoverHostIds(env, requestOptions);
  for (const hostUserId of hostIds) {
    const listedMeetings = await listHostMeetings(hostUserId, env, requestOptions);
    for (const listed of listedMeetings) {
      if (![2, 8].includes(Number(listed.type))) continue;
      const meetingId = cleanId(listed.id);
      if (!meetingId) continue;
      const detail = await fetchZoomJson(zoomUrl(`meetings/${zoomUuidPathSegment(meetingId)}`), env, requestOptions) as ZoomMeeting;
      if (Number(listed.type) === 8) {
        const occurrences = await listMeetingOccurrences(meetingId, env, requestOptions);
        for (const occurrence of occurrences) {
          if (clean(occurrence.status).toLowerCase() === 'deleted') continue;
          const normalized = normalizeMeeting({ ...detail, ...occurrence, id: detail.id ?? listed.id }, listed, hostUserId);
          if (normalized?.occurrence_id) nextSources.set(sourceKey(normalized), normalized);
        }
      } else {
        const normalized = normalizeMeeting(detail, listed, hostUserId);
        if (normalized) nextSources.set(sourceKey(normalized), normalized);
      }
    }
  }

  const fetchedAt = new Date(nowMs).toISOString();
  const missingRetentionMs = nonNegativeDuration(env.ZOOM_MISSING_SOURCE_RETENTION_MS, DEFAULT_MISSING_SOURCE_RETENTION_MS);
  for (const [key, previous] of currentSources) {
    if (!nextSources.has(key)) {
      const missingSince = previous.missing_since || fetchedAt;
      if (nowMs - Date.parse(missingSince) <= missingRetentionMs) {
        nextSources.set(key, { ...previous, missing_since: missingSince });
      }
    }
  }
  const state: ZoomSyncFile = {
    schema_version: 'inkloop.zoom_sync.v1',
    meetings: sortSources([...nextSources.values()]),
    fetched_at: fetchedAt,
  };
  atomicSaveProviderArtifactState(ref.path, state);
  return resultFromState(state, false);
}

export function zoomMeetingSyncPath(env: ZoomMeetingSyncEnv = process.env): string {
  return resolve(clean(env.ZOOM_SYNC_STATE_PATH) || DEFAULT_ZOOM_SYNC_PATH);
}

/** 供会后回补只读消费最近一次排期快照；不触发网络同步，也不暴露内部缺损对象。 */
export function readZoomMeetingSources(
  ref: ZoomMeetingSyncRef = { path: zoomMeetingSyncPath() },
): ZoomMeetingSource[] {
  return resultFromState(loadState(ref.path), true).sources;
}

export function fetchZoomMeetingSources(
  env: ZoomMeetingSyncEnv = process.env,
  ref: ZoomMeetingSyncRef = { path: zoomMeetingSyncPath(env) },
  options: ZoomMeetingSyncOptions = {},
): Promise<ZoomMeetingSourcesResult> {
  return syncInflight.run(ref.path, () => runSync(env, ref, options));
}

export function zoomMeetingSyncErrorPayload(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (!(error instanceof ZoomMeetingSyncError)) return zoomOAuthErrorPayload(error);
  return { status: error.status, body: { error: { code: error.code, message: error.message } } };
}
