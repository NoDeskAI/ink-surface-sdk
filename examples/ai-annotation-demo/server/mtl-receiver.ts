import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleCalendarSyncPath, googleMeetRecordsPath, resolveAnyUserGoogleToken, type GoogleOAuthEnv } from './google-oauth-state';
import { fetchGoogleMeetingTranscript, googleMeetRecordsErrorPayload, type GoogleMeetAttendanceWindow } from './google-meet-records';
import { resolveMtlToken, type MtlReceiverAuthEnv, type MtlReceiverIdentity } from './mtl-receiver-auth';

const DEFAULT_MTL_EVENTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../.inkloop/mtl-events');
const MAX_LIVE_WINDOWS = 20;
const MAX_BATCH_SIZE = 200;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface MtlReceiverEnv extends MtlReceiverAuthEnv, GoogleOAuthEnv {
  MTL_EVENTS_ROOT?: string;
}

export interface MtlLiveMeetingWindow {
  platform: string;
  meeting_id: string;
  external_meeting_id?: string;
  meeting_code?: string;
  meeting_url?: string;
  title?: string;
  started_at_ms: number;
  ended_at_ms?: number;
  detector_source?: string;
  observer_surface?: string;
  updated_at: string;
}

interface MtlLiveStateFile {
  schema_version: 'inkloop.mtl_live_state.v1';
  windows: MtlLiveMeetingWindow[];
}

interface MtlReceiverOptions {
  env?: MtlReceiverEnv;
  now?: () => number;
  onMeetingEnded?: (
    identity: MtlReceiverIdentity,
    window: MtlLiveMeetingWindow,
  ) => Promise<void> | void;
}

interface AuditEvidence {
  url?: string;
  window_title?: string;
}

interface StoredGoogleCalendarSource {
  meeting_code?: string;
  scheduled_at?: string;
  scheduled_end_at?: string;
}

function clean(value: unknown, maxLength = 512): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safePathPart(value: string, fallback: string): string {
  const normalized = clean(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '');
  return normalized || fallback;
}

function eventsRoot(env: MtlReceiverEnv): string {
  return resolve(clean(env.MTL_EVENTS_ROOT) || DEFAULT_MTL_EVENTS_ROOT);
}

export function mtlLiveStatePath(identity: MtlReceiverIdentity, env: MtlReceiverEnv = process.env): string {
  return resolve(
    eventsRoot(env),
    safePathPart(identity.tenant_id, 'tenant'),
    safePathPart(identity.user_id, 'user'),
    'live-state.json',
  );
}

export function mtlEventsAuditPath(identity: MtlReceiverIdentity, env: MtlReceiverEnv = process.env): string {
  return resolve(dirname(mtlLiveStatePath(identity, env)), 'events.jsonl');
}

function emptyLiveState(): MtlLiveStateFile {
  return { schema_version: 'inkloop.mtl_live_state.v1', windows: [] };
}

function readLiveStateFile(identity: MtlReceiverIdentity, env: MtlReceiverEnv): MtlLiveStateFile {
  try {
    const parsed = JSON.parse(readFileSync(mtlLiveStatePath(identity, env), 'utf8')) as Partial<MtlLiveStateFile>;
    return {
      schema_version: 'inkloop.mtl_live_state.v1',
      windows: Array.isArray(parsed.windows) ? parsed.windows.slice(0, MAX_LIVE_WINDOWS) : [],
    };
  } catch {
    return emptyLiveState();
  }
}

function writeLiveStateFile(identity: MtlReceiverIdentity, env: MtlReceiverEnv, state: MtlLiveStateFile): void {
  const path = mtlLiveStatePath(identity, env);
  mkdirSync(dirname(path), { recursive: true });
  state.windows.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  state.windows = state.windows.slice(0, MAX_LIVE_WINDOWS);
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

export function listMtlMeetingWindows(
  identity: MtlReceiverIdentity,
  env: MtlReceiverEnv = process.env,
  platform?: string,
): MtlLiveMeetingWindow[] {
  const normalizedPlatform = normalizeMtlPlatform(clean(platform, 64));
  return readLiveStateFile(identity, env).windows
    .filter((window) => !normalizedPlatform || window.platform === normalizedPlatform)
    .map((window) => ({ ...window }));
}

export function normalizeGoogleMeetCode(value: unknown): string | undefined {
  const input = clean(value, 128).toLowerCase();
  const compact = input.replaceAll('-', '');
  if (!/^[a-z]{10}$/.test(compact)) return undefined;
  return `${compact.slice(0, 3)}-${compact.slice(3, 7)}-${compact.slice(7)}`;
}

function canonicalUrl(value: unknown): string | undefined {
  const input = clean(value, 2_048);
  if (!input) return undefined;
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeMtlPlatform(value: string): string {
  return value.toLowerCase().replaceAll('-', '_');
}

export function meetingCodeFromMtlPayload(payload: Record<string, unknown>): string | undefined {
  const platform = normalizeMtlPlatform(clean(payload.platform, 64));
  if (platform !== 'google_meet') return undefined;
  const meetingUrl = canonicalUrl(payload.meeting_url);
  if (meetingUrl) {
    const url = new URL(meetingUrl);
    if (url.hostname.toLowerCase() === 'meet.google.com') {
      const fromPath = normalizeGoogleMeetCode(url.pathname.split('/').filter(Boolean)[0]);
      if (fromPath) return fromPath;
    }
  }
  return normalizeGoogleMeetCode(payload.meeting_id);
}

function evidenceRows(payload: Record<string, unknown>): AuditEvidence[] {
  const record = recordOf(payload.meeting_app_record);
  const snapshot = recordOf(record.snapshot);
  const page = recordOf(snapshot.page);
  const dom = recordOf(snapshot.dom);
  const candidates = [
    { url: snapshot.url, title: snapshot.title },
    { url: page.url, title: page.title },
    { url: dom.url, title: dom.title },
    { url: payload.meeting_url, title: payload.title },
  ];
  const tabs = Array.isArray(payload.tabs) ? payload.tabs.slice(0, 20) : [];
  for (const tab of tabs) {
    const row = recordOf(tab);
    candidates.push({ url: row.url, title: row.title });
  }
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const url = canonicalUrl(candidate.url);
    const windowTitle = clean(candidate.title, 512) || undefined;
    if (!url && !windowTitle) return [];
    const key = `${url || ''}\u0000${windowTitle || ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...(url ? { url } : {}), ...(windowTitle ? { window_title: windowTitle } : {}) }];
  });
}

function appendAudit(
  identity: MtlReceiverIdentity,
  env: MtlReceiverEnv,
  eventType: string,
  payload: Record<string, unknown>,
  nowMs: number,
  extra: Record<string, unknown> = {},
): void {
  const path = mtlEventsAuditPath(identity, env);
  mkdirSync(dirname(path), { recursive: true });
  const platform = normalizeMtlPlatform(clean(payload.platform, 64));
  const meetingId = clean(payload.meeting_id, 256);
  const externalMeetingId = clean(payload.external_meeting_id, 256);
  const detectorSource = clean(payload.detector_source || payload.source, 256);
  const observerSurface = clean(payload.observer_surface, 128);
  const action = clean(payload.action, 128);
  const evidence = evidenceRows(payload);
  const row = {
    schema_version: 'inkloop.mtl_event_audit.v1',
    event_type: eventType,
    identity: { tenant_id: identity.tenant_id, user_id: identity.user_id },
    received_at: new Date(nowMs).toISOString(),
    received_at_ms: nowMs,
    ...(platform ? { platform } : {}),
    ...(meetingId ? { meeting_id: meetingId } : {}),
    ...(externalMeetingId ? { external_meeting_id: externalMeetingId } : {}),
    ...(meetingCodeFromMtlPayload(payload) ? { meeting_code: meetingCodeFromMtlPayload(payload) } : {}),
    ...(canonicalUrl(payload.meeting_url) ? { meeting_url: canonicalUrl(payload.meeting_url) } : {}),
    ...(Number.isFinite(Number(payload.start_time_ms)) ? { start_time_ms: Number(payload.start_time_ms) } : {}),
    ...(Number.isFinite(Number(payload.end_time_ms)) ? { end_time_ms: Number(payload.end_time_ms) } : {}),
    ...(Number.isFinite(Number(payload.captured_at_ms)) ? { captured_at_ms: Number(payload.captured_at_ms) } : {}),
    ...(Number.isFinite(Number(payload.sent_at_ms)) ? { sent_at_ms: Number(payload.sent_at_ms) } : {}),
    ...(detectorSource ? { detector_source: detectorSource } : {}),
    ...(observerSurface ? { observer_surface: observerSurface } : {}),
    ...(action ? { action } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...extra,
  };
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, error: { code, message, ...extra } };
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        rejected = true;
        reject(Object.assign(new Error('mtl_payload_too_large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const parsed = JSON.parse(raw || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('mtl_json_object_required'), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function requiredText(payload: Record<string, unknown>, field: string): string {
  const value = clean(payload[field], 512);
  if (!value) throw Object.assign(new Error(`mtl_${field}_missing`), { status: 400, field });
  return value;
}

function requiredTime(payload: Record<string, unknown>, field: string): number {
  const value = Number(payload[field]);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error(`mtl_${field}_invalid`), { status: 400, field });
  }
  return Math.round(value);
}

function startMeeting(
  identity: MtlReceiverIdentity,
  env: MtlReceiverEnv,
  payload: Record<string, unknown>,
  nowMs: number,
): { deduplicated: boolean; meeting: MtlLiveMeetingWindow } {
  const platform = normalizeMtlPlatform(requiredText(payload, 'platform'));
  const meetingId = requiredText(payload, 'meeting_id');
  const startedAtMs = requiredTime(payload, 'start_time_ms');
  const state = readLiveStateFile(identity, env);
  const active = state.windows.find((window) => window.ended_at_ms === undefined);
  if (active) {
    if (active.platform === platform && active.meeting_id === meetingId) {
      appendAudit(identity, env, 'meeting_session_start', payload, nowMs, { deduplicated: true });
      return { deduplicated: true, meeting: active };
    }
    appendAudit(identity, env, 'meeting_session_start_conflict', payload, nowMs, {
      current_platform: active.platform,
      current_meeting_id: active.meeting_id,
    });
    throw Object.assign(new Error('mtl_active_meeting_conflict'), { status: 409, current: active });
  }

  const prior = state.windows.find((window) => (
    window.platform === platform
    && window.meeting_id === meetingId
    && window.started_at_ms === startedAtMs
  ));
  if (prior) {
    appendAudit(identity, env, 'meeting_session_start', payload, nowMs, { deduplicated: true });
    return { deduplicated: true, meeting: prior };
  }

  const meetingUrl = canonicalUrl(payload.meeting_url);
  const externalMeetingId = clean(payload.external_meeting_id, 256);
  const title = clean(payload.title, 512);
  const detectorSource = clean(payload.detector_source, 256);
  const observerSurface = clean(payload.observer_surface, 128);
  const window: MtlLiveMeetingWindow = {
    platform,
    meeting_id: meetingId,
    ...(externalMeetingId ? { external_meeting_id: externalMeetingId } : {}),
    ...(meetingCodeFromMtlPayload({ ...payload, platform, meeting_id: meetingId })
      ? { meeting_code: meetingCodeFromMtlPayload({ ...payload, platform, meeting_id: meetingId }) }
      : {}),
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(title ? { title } : {}),
    started_at_ms: startedAtMs,
    ...(detectorSource ? { detector_source: detectorSource } : {}),
    ...(observerSurface ? { observer_surface: observerSurface } : {}),
    updated_at: new Date(nowMs).toISOString(),
  };
  state.windows.unshift(window);
  writeLiveStateFile(identity, env, state);
  appendAudit(identity, env, 'meeting_session_start', { ...payload, platform, meeting_id: meetingId }, nowMs);
  return { deduplicated: false, meeting: window };
}

function endMeeting(
  identity: MtlReceiverIdentity,
  env: MtlReceiverEnv,
  payload: Record<string, unknown>,
  nowMs: number,
): MtlLiveMeetingWindow {
  const meetingId = requiredText(payload, 'meeting_id');
  const platform = payload.platform === undefined
    ? undefined
    : normalizeMtlPlatform(requiredText(payload, 'platform'));
  const endedAtMs = requiredTime(payload, 'end_time_ms');
  const state = readLiveStateFile(identity, env);
  const activeIndex = state.windows.findIndex((window) => window.ended_at_ms === undefined);
  const active = activeIndex >= 0 ? state.windows[activeIndex] : undefined;
  if (!active || active.meeting_id !== meetingId || (platform !== undefined && active.platform !== platform)) {
    appendAudit(identity, env, 'meeting_session_end_mismatch', payload, nowMs, {
      ...(active ? { current_platform: active.platform, current_meeting_id: active.meeting_id } : {}),
    });
    throw Object.assign(new Error('mtl_active_meeting_mismatch'), { status: 409, current: active });
  }
  const detectorSource = clean(payload.detector_source, 256);
  const observerSurface = clean(payload.observer_surface, 128);
  const ended: MtlLiveMeetingWindow = {
    ...active,
    ended_at_ms: Math.max(active.started_at_ms, endedAtMs),
    ...(detectorSource ? { detector_source: detectorSource } : {}),
    ...(observerSurface ? { observer_surface: observerSurface } : {}),
    updated_at: new Date(nowMs).toISOString(),
  };
  state.windows[activeIndex] = ended;
  writeLiveStateFile(identity, env, state);
  appendAudit(identity, env, 'meeting_session_end', { ...payload, platform: active.platform }, nowMs);
  return ended;
}

function annotationId(payload: Record<string, unknown>): string {
  return clean(payload.id || payload.annotation_id, 256) || `mtl_ann_${randomBytes(12).toString('hex')}`;
}

function recordAnnotation(
  identity: MtlReceiverIdentity,
  env: MtlReceiverEnv,
  payload: Record<string, unknown>,
  nowMs: number,
): { accepted: true; annotation_id: string; operation: 'recorded' } {
  const id = annotationId(payload);
  const nestedPayload = recordOf(payload.payload);
  const meeting = recordOf(nestedPayload.meeting);
  appendAudit(identity, env, 'annotation', {
    meeting_id: clean(payload.meeting_id || meeting.meeting_id, 256),
    platform: clean(payload.platform || meeting.platform, 64),
    detector_source: clean(payload.source, 256),
    captured_at_ms: payload.captured_at_ms,
  }, nowMs, {
    annotation_id: id,
    annotation_kind: clean(payload.kind, 128) || 'annotation',
    annotation_intent: clean(payload.intent, 128) || undefined,
  });
  return { accepted: true, annotation_id: id, operation: 'recorded' };
}

function overlapMs(left: GoogleMeetAttendanceWindow, right: GoogleMeetAttendanceWindow): number {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
}

function storedCalendarScheduledAt(
  identity: MtlReceiverIdentity,
  env: MtlReceiverEnv,
  window: MtlLiveMeetingWindow,
): string {
  try {
    const path = googleCalendarSyncPath(env, { tenantId: identity.tenant_id, userId: identity.user_id });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { meet_events?: Record<string, StoredGoogleCalendarSource> };
    const matching = Object.values(parsed.meet_events || {}).filter((source) => (
      normalizeGoogleMeetCode(source.meeting_code) === window.meeting_code
      && Number.isFinite(Date.parse(source.scheduled_at || ''))
    ));
    const attendance = { startMs: window.started_at_ms, endMs: window.ended_at_ms || window.started_at_ms };
    matching.sort((left, right) => {
      const leftRange = {
        startMs: Date.parse(left.scheduled_at || ''),
        endMs: Date.parse(left.scheduled_end_at || left.scheduled_at || ''),
      };
      const rightRange = {
        startMs: Date.parse(right.scheduled_at || ''),
        endMs: Date.parse(right.scheduled_end_at || right.scheduled_at || ''),
      };
      const overlapDelta = overlapMs(attendance, rightRange) - overlapMs(attendance, leftRange);
      if (overlapDelta) return overlapDelta;
      return Math.abs(leftRange.startMs - window.started_at_ms) - Math.abs(rightRange.startMs - window.started_at_ms);
    });
    if (matching[0]?.scheduled_at) return matching[0].scheduled_at;
  } catch {
    // Calendar has not synced yet; the local detector start is still a valid catch-up anchor.
  }
  return new Date(window.started_at_ms).toISOString();
}

export function mtlAttendanceWindows(
  identity: MtlReceiverIdentity,
  meetingCode: string,
  env: MtlReceiverEnv = process.env,
  nowMs = Date.now(),
): GoogleMeetAttendanceWindow[] {
  const normalizedCode = normalizeGoogleMeetCode(meetingCode);
  if (!normalizedCode) return [];
  return listMtlMeetingWindows(identity, env).flatMap((window) => {
    if (window.platform !== 'google_meet' || window.meeting_code !== normalizedCode) return [];
    return [{ startMs: window.started_at_ms, endMs: window.ended_at_ms || nowMs }];
  });
}

export async function runMtlGoogleTranscriptCatchUp(
  identity: MtlReceiverIdentity,
  window: MtlLiveMeetingWindow,
  env: MtlReceiverEnv = process.env,
): Promise<void> {
  if (window.platform !== 'google_meet' || !window.meeting_code) return;
  const userIdentity = { tenantId: identity.tenant_id, userId: identity.user_id };
  const resolved = await resolveAnyUserGoogleToken(env, userIdentity);
  if (!resolved.usable || !resolved.token) {
    console.info(`[mtl-receiver] transcript catch-up skipped: ${resolved.reason || 'google_token_unavailable'} tenant=${identity.tenant_id} user=${identity.user_id} meeting=${window.meeting_code}`);
    return;
  }
  try {
    await fetchGoogleMeetingTranscript(resolved.token, {
      path: googleMeetRecordsPath(env, userIdentity),
    }, {
      meetingCode: window.meeting_code,
      scheduledAt: storedCalendarScheduledAt(identity, env, window),
      attendance: [{ startMs: window.started_at_ms, endMs: window.ended_at_ms || Date.now() }],
    }, {
      refreshAccessToken: async () => {
        const refreshed = await resolveAnyUserGoogleToken(env, userIdentity, Date.now(), { forceRefresh: true });
        if (!refreshed.usable || !refreshed.token) throw Object.assign(new Error('reauth_required'), { status: 401 });
        return refreshed.token;
      },
    });
  } catch (error) {
    const failure = googleMeetRecordsErrorPayload(error);
    console.warn(`[mtl-receiver] transcript catch-up failed: ${failure.body.error.code} tenant=${identity.tenant_id} user=${identity.user_id} meeting=${window.meeting_code}`);
  }
}

function scheduleMeetingEnded(
  identity: MtlReceiverIdentity,
  window: MtlLiveMeetingWindow,
  options: MtlReceiverOptions,
  env: MtlReceiverEnv,
): void {
  const callback = options.onMeetingEnded || ((resolvedIdentity, ended) => runMtlGoogleTranscriptCatchUp(resolvedIdentity, ended, env));
  queueMicrotask(() => {
    Promise.resolve(callback(identity, window)).catch(() => {
      console.warn('[mtl-receiver] meeting end hook failed');
    });
  });
}

export async function handleMtlReceiver(
  req: IncomingMessage,
  res: ServerResponse,
  options: MtlReceiverOptions = {},
): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://inkloop.local');
  if (!url.pathname.startsWith('/api/mtl/')) return false;
  res.setHeader('cache-control', 'no-store');
  const match = url.pathname.match(/^\/api\/mtl\/([a-f0-9]{32})(\/api\/.*)$/i);
  const env = options.env || process.env;
  const identity = match ? resolveMtlToken(match[1], env) : null;
  if (!match || !identity) {
    sendJson(res, 404, errorBody('not_found', 'Not found'));
    return true;
  }

  const path = match[2];
  if (path === '/api/state') {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('method_not_allowed', 'GET only'));
    else sendJson(res, 200, { ok: true, service: 'inkloop-mtl-receiver' });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, errorBody('method_not_allowed', 'POST only'));
    return true;
  }

  const nowMs = options.now?.() ?? Date.now();
  try {
    const payload = await readJsonBody(req);
    if (path === '/api/meeting-session/start') {
      const result = startMeeting(identity, env, payload, nowMs);
      sendJson(res, 200, {
        ok: true,
        ...(result.deduplicated ? { deduplicated: true } : {}),
        meeting: result.meeting,
      });
      return true;
    }
    if (path === '/api/meeting-session/end') {
      const meeting = endMeeting(identity, env, payload, nowMs);
      sendJson(res, 200, { ok: true, meeting });
      scheduleMeetingEnded(identity, meeting, options, env);
      return true;
    }
    if (path === '/api/annotations') {
      sendJson(res, 200, { ack: recordAnnotation(identity, env, payload, nowMs) });
      return true;
    }
    if (path === '/api/annotations/batch') {
      const rows = Array.isArray(payload.annotations) ? payload.annotations : [];
      if (!rows.length) {
        sendJson(res, 400, errorBody('mtl_annotations_missing', 'annotations array is required'));
        return true;
      }
      if (rows.length > MAX_BATCH_SIZE) {
        sendJson(res, 413, errorBody('mtl_annotations_batch_limit', `annotations batch limit is ${MAX_BATCH_SIZE}`));
        return true;
      }
      const acks = rows.map((row) => recordAnnotation(identity, env, recordOf(row), nowMs));
      sendJson(res, 200, { accepted: true, count: acks.length, acks });
      return true;
    }
    if (path === '/api/meeting-platform/p0-reference' || path === '/api/meeting-platform/runtime-events') {
      appendAudit(
        identity,
        env,
        path.endsWith('p0-reference') ? 'meeting_platform_p0_reference' : 'meeting_platform_runtime_event',
        payload,
        nowMs,
      );
      sendJson(res, 200, { ok: true });
      return true;
    }
    sendJson(res, 404, errorBody('not_found', 'Not found'));
    return true;
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 400;
    const code = clean((error as Error)?.message || error, 128) || 'mtl_request_invalid';
    const current = (error as { current?: MtlLiveMeetingWindow }).current;
    sendJson(res, status, errorBody(code, code, {
      ...(current ? { current_meeting: { platform: current.platform, meeting_id: current.meeting_id } } : {}),
    }));
    return true;
  }
}
