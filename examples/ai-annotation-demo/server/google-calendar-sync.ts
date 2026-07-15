import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeAbsoluteMs } from '../vendor/meeting-timeline-sdk/time.mjs';

const GOOGLE_CALENDAR_EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export interface GoogleMeetingSource {
  platform: 'google_meet';
  calendar_event_id: string;
  ical_uid?: string;
  recurring_event_id?: string;
  original_start_time?: string;
  title: string;
  scheduled_at: string;
  scheduled_end_at?: string;
  meeting_code?: string;
  meeting_url?: string;
  organizer_email?: string;
  status: 'confirmed' | 'cancelled';
}

interface GoogleCalendarSyncFile {
  schema_version: 'inkloop.google_calendar_sync.v1';
  sync_token?: string;
  updated_at?: string;
  meet_events: Record<string, GoogleMeetingSource>;
}

export interface GoogleCalendarSyncRef {
  path: string;
}

export interface GoogleCalendarSyncOptions {
  fetchImpl?: typeof fetch;
  refreshAccessToken?: () => Promise<string>;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: number;
}

export interface GoogleMeetingSourcesResult {
  source: 'google_calendar';
  source_count: number;
  sources: GoogleMeetingSource[];
  sync_token_present: boolean;
  full_sync: boolean;
  cursor_reset: boolean;
}

interface GoogleCalendarEvent {
  id?: string;
  iCalUID?: string;
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  hangoutLink?: string;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string }; name?: string };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

interface GoogleCalendarPage {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

class GoogleCalendarError extends Error {
  status: number;
  code: string;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'GoogleCalendarError';
    this.status = status;
    this.code = code;
  }
}

function emptyState(): GoogleCalendarSyncFile {
  return { schema_version: 'inkloop.google_calendar_sync.v1', meet_events: {} };
}

function loadState(path: string): GoogleCalendarSyncFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GoogleCalendarSyncFile>;
    return {
      schema_version: 'inkloop.google_calendar_sync.v1',
      ...(typeof parsed.sync_token === 'string' && parsed.sync_token ? { sync_token: parsed.sync_token } : {}),
      ...(typeof parsed.updated_at === 'string' ? { updated_at: parsed.updated_at } : {}),
      meet_events: parsed.meet_events && typeof parsed.meet_events === 'object' ? parsed.meet_events : {},
    };
  } catch {
    return emptyState();
  }
}

function saveState(path: string, state: GoogleCalendarSyncFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

function eventTime(value: { dateTime?: string; date?: string } | undefined, field: string): string | undefined {
  const input = value?.dateTime || (value?.date ? `${value.date}T00:00:00.000Z` : '');
  if (!input) return undefined;
  try {
    const ms = normalizeAbsoluteMs(input, field);
    return ms === undefined ? undefined : new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

function isMeetConference(event: GoogleCalendarEvent): boolean {
  const solution = event.conferenceData?.conferenceSolution;
  return solution?.key?.type === 'hangoutsMeet' || /google\s*meet/i.test(solution?.name || '');
}

function normalizeEvent(event: GoogleCalendarEvent, previous?: GoogleMeetingSource): GoogleMeetingSource | null {
  const eventId = String(event.id || '').trim();
  if (!eventId) return null;
  const cancelled = event.status === 'cancelled';
  const videoUrl = event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video' && entry.uri)?.uri;
  const meetingUrl = String(videoUrl || event.hangoutLink || '').trim();
  const meet = isMeetConference(event);
  if (!cancelled && (!meet || !meetingUrl)) return null;
  if (cancelled && !previous && (!meet || !meetingUrl)) return null;
  const scheduledAt = eventTime(event.start, 'google_calendar_start')
    || eventTime(event.originalStartTime, 'google_calendar_original_start')
    || previous?.scheduled_at;
  if (!scheduledAt) return null;
  const originalStartTime = eventTime(event.originalStartTime, 'google_calendar_original_start') || previous?.original_start_time;
  return {
    platform: 'google_meet',
    calendar_event_id: eventId,
    ...(event.iCalUID || previous?.ical_uid ? { ical_uid: event.iCalUID || previous?.ical_uid } : {}),
    ...(event.recurringEventId || previous?.recurring_event_id ? { recurring_event_id: event.recurringEventId || previous?.recurring_event_id } : {}),
    ...(originalStartTime ? { original_start_time: originalStartTime } : {}),
    title: String(event.summary || previous?.title || 'Google Meet').trim() || 'Google Meet',
    scheduled_at: scheduledAt,
    ...(eventTime(event.end, 'google_calendar_end') || previous?.scheduled_end_at
      ? { scheduled_end_at: eventTime(event.end, 'google_calendar_end') || previous?.scheduled_end_at }
      : {}),
    ...(event.conferenceData?.conferenceId || previous?.meeting_code
      ? { meeting_code: event.conferenceData?.conferenceId || previous?.meeting_code }
      : {}),
    ...(meetingUrl || previous?.meeting_url ? { meeting_url: meetingUrl || previous?.meeting_url } : {}),
    ...(event.organizer?.email || previous?.organizer_email ? { organizer_email: event.organizer?.email || previous?.organizer_email } : {}),
    status: cancelled ? 'cancelled' : 'confirmed',
  };
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

async function fetchPage(
  url: string,
  auth: { token: string; refreshed: boolean },
  options: Required<Pick<GoogleCalendarSyncOptions, 'fetchImpl' | 'sleepImpl'>> & Pick<GoogleCalendarSyncOptions, 'refreshAccessToken'>,
): Promise<{ page?: GoogleCalendarPage; gone?: boolean }> {
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const response = await options.fetchImpl(url, { headers: { authorization: `Bearer ${auth.token}` } });
    if (response.status === 410) return { gone: true };
    if (response.status === 401 && !auth.refreshed && options.refreshAccessToken) {
      auth.token = await options.refreshAccessToken();
      auth.refreshed = true;
      attempt -= 1;
      continue;
    }
    if (response.ok) return { page: await readJson(response) as GoogleCalendarPage };
    const body = await readJson(response);
    if (retryable(response.status) && attempt < MAX_ATTEMPTS) {
      await options.sleepImpl(250 * (2 ** (attempt - 1)));
      continue;
    }
    const apiError = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {};
    const message = String(apiError.message || `Google Calendar HTTP ${response.status}`);
    throw new GoogleCalendarError(
      response.status === 401 ? 'google_calendar_reauth_required' : 'google_calendar_request_failed',
      response.status === 401 ? 401 : 502,
      message,
    );
  }
  throw new GoogleCalendarError('google_calendar_retry_exhausted', 502);
}

function calendarUrl(input: { syncToken?: string; pageToken?: string; nowMs: number }): string {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('maxResults', '2500');
  if (input.syncToken) {
    url.searchParams.set('syncToken', input.syncToken);
  } else {
    url.searchParams.set('timeMin', new Date(input.nowMs - LOOKBACK_MS).toISOString());
    url.searchParams.set('timeMax', new Date(input.nowMs + LOOKAHEAD_MS).toISOString());
  }
  if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);
  return url.toString();
}

async function fetchCycle(
  auth: { token: string; refreshed: boolean },
  syncToken: string | undefined,
  nowMs: number,
  options: Required<Pick<GoogleCalendarSyncOptions, 'fetchImpl' | 'sleepImpl'>> & Pick<GoogleCalendarSyncOptions, 'refreshAccessToken'>,
): Promise<{ events: GoogleCalendarEvent[]; nextSyncToken?: string; gone: boolean }> {
  const events: GoogleCalendarEvent[] = [];
  let pageToken = '';
  let nextSyncToken = '';
  do {
    const result = await fetchPage(calendarUrl({ syncToken, pageToken: pageToken || undefined, nowMs }), auth, options);
    if (result.gone) return { events: [], gone: true };
    const page = result.page || {};
    events.push(...(Array.isArray(page.items) ? page.items : []));
    pageToken = String(page.nextPageToken || '');
    nextSyncToken = String(page.nextSyncToken || nextSyncToken || '');
  } while (pageToken);
  return { events, ...(nextSyncToken ? { nextSyncToken } : {}), gone: false };
}

export async function fetchGoogleMeetingSources(
  token: string,
  syncState: GoogleCalendarSyncRef,
  options: GoogleCalendarSyncOptions = {},
): Promise<GoogleMeetingSourcesResult> {
  if (!String(token || '').trim()) throw new GoogleCalendarError('google_calendar_token_missing', 401);
  const nowMs = options.nowMs ?? Date.now();
  const state = loadState(syncState.path);
  const requestOptions = {
    fetchImpl: options.fetchImpl || fetch,
    sleepImpl: options.sleepImpl || defaultSleep,
    refreshAccessToken: options.refreshAccessToken,
  };
  const auth = { token, refreshed: false };
  const initialFullSync = !state.sync_token;
  let cursorReset = false;
  let cycle = await fetchCycle(auth, state.sync_token, nowMs, requestOptions);
  if (cycle.gone) {
    cursorReset = true;
    delete state.sync_token;
    saveState(syncState.path, { ...state, updated_at: new Date(nowMs).toISOString() });
    cycle = await fetchCycle(auth, undefined, nowMs, requestOptions);
    if (cycle.gone) throw new GoogleCalendarError('google_calendar_cursor_reset_failed', 502);
  }

  const previousEvents = state.meet_events;
  if (initialFullSync || cursorReset) state.meet_events = {};
  const changedSources: GoogleMeetingSource[] = [];
  for (const event of cycle.events) {
    const eventId = String(event.id || '').trim();
    const source = normalizeEvent(event, eventId ? previousEvents[eventId] : undefined);
    if (!source) continue;
    changedSources.push(source);
    if (source.status === 'cancelled') delete state.meet_events[source.calendar_event_id];
    else state.meet_events[source.calendar_event_id] = source;
  }
  if (cycle.nextSyncToken) state.sync_token = cycle.nextSyncToken;
  state.updated_at = new Date(nowMs).toISOString();
  saveState(syncState.path, state);
  const cancelled = changedSources.filter((source) => source.status === 'cancelled');
  const sources = [...Object.values(state.meet_events), ...cancelled];
  sources.sort((left, right) => left.scheduled_at.localeCompare(right.scheduled_at));
  return {
    source: 'google_calendar',
    source_count: sources.length,
    sources,
    sync_token_present: !!state.sync_token,
    full_sync: initialFullSync || cursorReset,
    cursor_reset: cursorReset,
  };
}

export function googleCalendarErrorPayload(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  const status = error instanceof GoogleCalendarError ? error.status : Number((error as { status?: number })?.status) || 500;
  const code = error instanceof GoogleCalendarError ? error.code : 'google_calendar_sync_failed';
  const message = error instanceof Error ? error.message : String(error);
  return { status, body: { error: { code, message } } };
}
