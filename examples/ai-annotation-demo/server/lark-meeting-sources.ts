import { fetchFeishuBotCalendarEvents, type FeishuBotCalendarEvent } from './feishu-bot-calendar';
import { fetchFeishuBotWorkspaces, fetchFeishuBotWorkspaceMembers, fetchFeishuBotWorkspaceMessages, type FeishuBotMessage, type FeishuBotWorkspace } from './feishu-bot-im';
import { resolveUserOAuthToken } from './lark-oauth-state';
import { createLarkClient } from '../Lark-Meeting-Timeline-main/src/larkClient.mjs';

const DEFAULT_LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const DEFAULT_LOOKAHEAD_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
const CALENDAR_END_GRACE_MS = 2 * 60 * 60 * 1000;
const USER_CALENDAR_SCOPES = ['calendar:calendar:read', 'calendar:calendar.event:read'];

export interface LarkMeetingSourcesEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
  LARK_MEETING_AUTH_STATE_PATH?: string;
}

export interface LarkMeetingSourcesOptions {
  nowMs?: number;
  lookbackSeconds?: number;
  lookaheadSeconds?: number;
  pageSize?: number;
  userOpenIds?: string[];
  extraSources?: LarkMeetingSource[];
  env?: LarkMeetingSourcesEnv;
  createClient?: (env: Record<string, unknown>) => MinimalLarkClient;
}

export interface LarkMeetingSource {
  source_id: string;
  source: 'bot_calendar' | 'user_calendar' | 'bot_chat_message' | 'lark_meeting_timeline';
  title: string;
  status: 'upcoming' | 'live' | 'ended';
  scheduled_at: string;
  started_at?: string;
  ended_at?: string;
  start_time_reliable: boolean;
  meeting_url?: string;
  meeting_no?: string;
  feishu_meeting_id?: string;
  feishu_minute_token?: string;
  calendar_event_id?: string;
  calendar_id?: string;
  chat_id?: string;
  chat_name?: string;
  message_id?: string;
  raw?: unknown;
}

export interface LarkMeetingSourcesResult {
  connected: boolean;
  configured: boolean;
  source: 'lark_meeting_sources';
  source_count: number;
  sources: LarkMeetingSource[];
  errors: Array<{ source: string; code: string; message: string; required_scope?: string; permission_url?: string }>;
}

interface MinimalLarkClient {
  isConfigured?: boolean;
  searchMeetings?: (opts: Record<string, unknown>) => Promise<unknown>;
  searchMeetingsWithToken?: (token: string, opts: Record<string, unknown>) => Promise<unknown>;
  listMeetingsByNo?: (meetingNo: string, opts: Record<string, unknown>) => Promise<unknown>;
  listMeetingsByNoWithToken?: (meetingNo: string, token: string, opts: Record<string, unknown>) => Promise<unknown>;
}

interface CalendarMeetingEvent {
  event_id: string;
  summary?: string;
  start_time?: { timestamp?: string; date?: string; timezone?: string };
  end_time?: { timestamp?: string; timezone?: string };
  recurring?: boolean;
  recurrence_rule?: string;
  has_meeting: boolean;
  vchat?: { meeting_url?: string; vc_type?: string } | null;
  calendar_id: string;
  calendar_summary?: string;
  source: 'bot_calendar' | 'user_calendar';
  raw?: unknown;
}

function appConfig(env: LarkMeetingSourcesEnv): { appId: string; appSecret: string; baseUrl?: string } | null {
  const appId = String(env.LARK_APP_ID || env.FEISHU_APP_ID || '').trim();
  const appSecret = String(env.LARK_APP_SECRET || env.FEISHU_APP_SECRET || '').trim();
  const baseUrl = String(env.LARK_BASE_URL || env.FEISHU_BASE_URL || '').trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret, ...(baseUrl ? { baseUrl } : {}) };
}

function permissionUrl(appId: string, scopes: string[]): string {
  return `https://open.feishu.cn/app/${appId}/auth?q=${encodeURIComponent(scopes.join(','))}&op_from=openapi&token_type=tenant`;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const t = text(value);
    if (t) return t;
  }
  return undefined;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity: string) => {
    const lower = String(entity).toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : lower.startsWith('#') ? Number.parseInt(lower.slice(1), 10) : NaN;
    return Number.isFinite(code) ? String.fromCodePoint(code) : full;
  }).replace(/\u00a0/g, ' ');
}

function cleanTitle(value: unknown): string | undefined {
  const t = text(value);
  return t ? decodeHtmlEntities(t).trim() || undefined : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
}

function meetingNoFromUrl(url?: string): string | undefined {
  return url?.match(/https:\/\/(?:vc|meeting)\.feishu\.cn\/j\/(\d+)/)?.[1];
}

function meetingNoFromText(value?: string): string | undefined {
  const fromUrl = meetingNoFromUrl(value);
  if (fromUrl) return fromUrl;
  const m = String(value || '').match(/(?:会议号|meeting\s*(?:no|id)|会议\s*ID)[^\d\r\n]{0,12}([0-9][0-9 \t-]{7,20}[0-9])/i);
  const normalized = m?.[1]?.replace(/\D/g, '');
  return normalized && normalized.length >= 9 && normalized.length <= 12 ? normalized : undefined;
}

function meetingNoFromLarkSearchText(value?: string): string | undefined {
  const explicit = meetingNoFromText(value);
  if (explicit) return explicit;
  const m = String(value || '').match(/\bID[^\d\r\n]{0,12}([0-9][0-9 \t-]{7,20}[0-9])/i);
  const normalized = m?.[1]?.replace(/\D/g, '');
  return normalized && normalized.length >= 9 && normalized.length <= 12 ? normalized : undefined;
}

function meetingUrlFromText(value?: string): string | undefined {
  return String(value || '').match(/https:\/\/(?:vc|meeting)\.feishu\.cn\/[^\s"')]+/)?.[0];
}

function parseMs(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function isoFrom(value: unknown): string | undefined {
  const ms = parseMs(value);
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function shanghaiDateParts(ms: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function shanghaiIso(year: number, month: number, day: number, hour = 0, minute = 0): string | undefined {
  if (!year || !month || !day) return undefined;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function shanghaiDateWithOffset(nowMs: number, dayOffset: number): { year: number; month: number; day: number } {
  const today = shanghaiDateParts(nowMs);
  const baseMs = Date.parse(`${String(today.year).padStart(4, '0')}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}T00:00:00+08:00`);
  return shanghaiDateParts(baseMs + dayOffset * 24 * 60 * 60 * 1000);
}

function dateTimeFromDisplayText(value: string | undefined, nowMs: number): string | undefined {
  const raw = String(value || '');
  const relative = raw.match(/(今天|昨天|明天)\s*(\d{1,2}):(\d{2})/);
  if (relative) {
    const offset = relative[1] === '昨天' ? -1 : relative[1] === '明天' ? 1 : 0;
    const d = shanghaiDateWithOffset(nowMs, offset);
    return shanghaiIso(d.year, d.month, d.day, Number(relative[2]), Number(relative[3]));
  }
  const yearMonthDayTime = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[^\d]{0,16}(\d{1,2}):(\d{2})/);
  if (yearMonthDayTime) {
    return shanghaiIso(Number(yearMonthDayTime[1]), Number(yearMonthDayTime[2]), Number(yearMonthDayTime[3]), Number(yearMonthDayTime[4]), Number(yearMonthDayTime[5]));
  }
  const monthDayTime = raw.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (monthDayTime) {
    const today = shanghaiDateParts(nowMs);
    return shanghaiIso(today.year, Number(monthDayTime[1]), Number(monthDayTime[2]), Number(monthDayTime[3]), Number(monthDayTime[4]));
  }
  const yearMonthDay = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (yearMonthDay) return shanghaiIso(Number(yearMonthDay[1]), Number(yearMonthDay[2]), Number(yearMonthDay[3]));
  return undefined;
}

function firstDisplayLine(value: string | undefined): string | undefined {
  return value?.split('\n').map((line) => line.trim()).find(Boolean);
}

function statusFor(startIso: string, endIso: string | undefined, nowMs: number, endGraceMs = 0): LarkMeetingSource['status'] {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : 0;
  if (end && end + endGraceMs <= nowMs) return 'ended';
  if (!end && start <= nowMs && nowMs - start > 6 * 60 * 60 * 1000) return 'ended';
  if (start <= nowMs && (!end || end + endGraceMs > nowMs)) return 'live';
  return 'upcoming';
}

function eventStartIso(event: Pick<FeishuBotCalendarEvent, 'start_time'>): string | undefined {
  const ts = event.start_time?.timestamp;
  if (ts) return isoFrom(ts);
  const date = event.start_time?.date;
  return date ? new Date(`${date}T00:00:00+08:00`).toISOString() : undefined;
}

function eventEndIso(event: Pick<FeishuBotCalendarEvent, 'end_time'>): string | undefined {
  return event.end_time?.timestamp ? isoFrom(event.end_time.timestamp) : undefined;
}

function calendarSource(event: CalendarMeetingEvent, nowMs: number): LarkMeetingSource | null {
  const scheduledAt = eventStartIso(event);
  if (!scheduledAt) return null;
  const endedAt = eventEndIso(event);
  const meetingUrl = event.vchat?.meeting_url;
  const meetingNo = meetingNoFromUrl(meetingUrl);
  return {
    source_id: `calendar:${event.calendar_id}:${event.event_id}`,
    source: event.source,
    title: cleanTitle(event.summary) || cleanTitle(event.calendar_summary) || '飞书会议',
    status: statusFor(scheduledAt, endedAt, nowMs, CALENDAR_END_GRACE_MS),
    scheduled_at: scheduledAt,
    ...(endedAt ? { ended_at: endedAt } : {}),
    start_time_reliable: true,
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(meetingNo ? { meeting_no: meetingNo } : {}),
    calendar_event_id: event.event_id,
    calendar_id: event.calendar_id,
    raw: event,
  };
}

function candidateRecords(raw: unknown): Record<string, unknown>[] {
  const data = obj(obj(raw).data || raw);
  return [
    data.items,
    data.meetings,
    data.meeting_briefs,   // list_by_no 的返回形状（{id, meeting_no, topic}）
    data.meeting_list,
    data.list,
    data.meeting ? [data.meeting] : null,
  ].map(arr).find((items) => items.length) ?? [];
}

function meetingSourceFromRecord(record: Record<string, unknown>, fallback: Partial<LarkMeetingSource>, nowMs: number): LarkMeetingSource | null {
  const meeting = obj(record.meeting || record);
  const meta = obj(meeting.meta_data || record.meta_data);
  const displayInfo = firstText(meeting.display_info, record.display_info);
  const metaDescription = firstText(meta.description);
  const searchableText = [displayInfo, metaDescription].filter(Boolean).join('\n');
  const meetingId = firstText(meeting.id, meeting.meeting_id, record.id, record.meeting_id, fallback.feishu_meeting_id);
  const meetingNo = firstText(meeting.meeting_no, meeting.open_meeting_id, record.meeting_no, record.open_meeting_id, meetingNoFromLarkSearchText(searchableText), fallback.meeting_no);
  const meetingUrl = firstText(meeting.url, meeting.meeting_url, meeting.join_url, meeting.share_url, record.url, record.meeting_url, record.join_url, meetingUrlFromText(searchableText), fallback.meeting_url);
  const title = cleanTitle(firstText(meeting.topic, meeting.title, meeting.name, record.topic, record.title, firstDisplayLine(displayInfo), fallback.title)) || '飞书会议';
  const startRaw = firstText(meeting.start_time, meeting.start_at, meeting.begin_time, record.start_time, record.start_at, record.begin_time);
  const endRaw = firstText(meeting.end_time, meeting.end_at, record.end_time, record.end_at);
  const scheduledAt = isoFrom(startRaw) || dateTimeFromDisplayText(metaDescription, nowMs) || dateTimeFromDisplayText(displayInfo, nowMs) || fallback.scheduled_at;
  if (!scheduledAt) return null;
  const endedAt = isoFrom(endRaw) || fallback.ended_at;
  return {
    source_id: `lark:${meetingId || meetingNo || meetingUrl || fallback.source_id || title}`,
    source: 'lark_meeting_timeline',
    title,
    status: statusFor(scheduledAt, endedAt, nowMs),
    scheduled_at: scheduledAt,
    ...(Date.parse(scheduledAt) <= nowMs ? { started_at: scheduledAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    start_time_reliable: !!startRaw,
    ...(meetingId ? { feishu_meeting_id: meetingId } : {}),
    ...(meetingNo ? { meeting_no: meetingNo } : {}),
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(firstText(meeting.minute_token, meeting.minutes_token, obj(meeting.minute).token, record.minute_token, record.minutes_token) ? { feishu_minute_token: firstText(meeting.minute_token, meeting.minutes_token, obj(meeting.minute).token, record.minute_token, record.minutes_token) } : {}),
    ...(fallback.calendar_event_id ? { calendar_event_id: fallback.calendar_event_id } : {}),
    ...(fallback.calendar_id ? { calendar_id: fallback.calendar_id } : {}),
    ...(fallback.chat_id ? { chat_id: fallback.chat_id } : {}),
    ...(fallback.chat_name ? { chat_name: fallback.chat_name } : {}),
    ...(fallback.message_id ? { message_id: fallback.message_id } : {}),
    raw: record,
  };
}

function chatSource(workspace: FeishuBotWorkspace, message: FeishuBotMessage, nowMs: number): LarkMeetingSource | null {
  const rawText = [message.text, message.raw_content].filter(Boolean).join('\n');
  const meetingUrl = message.meeting_url || meetingUrlFromText(rawText);
  const meetingNo = meetingNoFromText(meetingUrl || rawText);
  if (!meetingUrl && !meetingNo) return null;
  const scheduledAt = isoFrom(message.create_time) || new Date(nowMs).toISOString();
  return {
    source_id: `chat:${workspace.chat_id}:${message.message_id}`,
    source: 'bot_chat_message',
    title: cleanTitle(message.text?.slice(0, 48)) || '群内会议链接',
    status: statusFor(scheduledAt, undefined, nowMs),
    scheduled_at: scheduledAt,
    start_time_reliable: false,
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(meetingNo ? { meeting_no: meetingNo } : {}),
    chat_id: workspace.chat_id,
    chat_name: workspace.name,
    message_id: message.message_id,
    raw: message,
  };
}

function hasScopes(actual: string[], required: string[]): boolean {
  const set = new Set(actual);
  return required.every((scope) => set.has(scope));
}

function uniqueText(values: Array<string | undefined>): string[] {
  return values.map((value) => String(value || '').trim()).filter((value, index, all) => !!value && all.indexOf(value) === index);
}

async function botWorkspaceVisibleToUser(workspace: FeishuBotWorkspace, userOpenIds: string[], env: LarkMeetingSourcesEnv): Promise<boolean> {
  if (!userOpenIds.length) return true;
  const members = await fetchFeishuBotWorkspaceMembers(workspace.chat_id, { env, pageSize: 100 });
  if (members.error) return false;
  const allowed = new Set(userOpenIds);
  return members.members.some((member) => allowed.has(member.open_id));
}

function feishuMsg(json: Record<string, unknown>): string {
  return String(json.msg || json.message || json.error || json.code || 'unknown Feishu error');
}

function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return obj(json.data || {});
}

function isPermissionDenied(json: Record<string, unknown>): boolean {
  const msg = feishuMsg(json);
  return Number(json.code) === 99991672 || /Access denied|scope|permission|权限/.test(msg);
}

function isFieldValidationError(json: Record<string, unknown>): boolean {
  return Number(json.code) === 99992402 || /field validation failed/i.test(feishuMsg(json));
}

async function requestUserJson(baseUrl: string, token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
  });
  const raw = await res.text();
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return { code: res.status, raw }; }
}

function normalizeCalendars(json: Record<string, unknown>): Array<{ calendar_id: string; summary?: string }> {
  const data = dataOf(json);
  return arr(data.calendar_list || data.items)
    .map((item) => ({ calendar_id: String(item.calendar_id || '').trim(), summary: cleanTitle(item.summary || item.title) }))
    .filter((item) => item.calendar_id);
}

function normalizePrimaryCalendar(json: Record<string, unknown>): { calendar_id: string; summary?: string } | null {
  const data = dataOf(json);
  const calendar = obj(data.calendar || data);
  const calendarId = String(calendar.calendar_id || '').trim();
  return calendarId ? { calendar_id: calendarId, summary: cleanTitle(calendar.summary || calendar.title) } : null;
}

function normalizeUserEvents(json: Record<string, unknown>, calendar: { calendar_id: string; summary?: string }): CalendarMeetingEvent[] {
  const data = dataOf(json);
  return arr(data.items || data.event_list)
    .filter((item) => item.status !== 'cancelled')
    .map((item) => ({
      event_id: String(item.event_id || '').trim(),
      summary: cleanTitle(item.summary),
      start_time: obj(item.start_time) as CalendarMeetingEvent['start_time'],
      end_time: obj(item.end_time) as CalendarMeetingEvent['end_time'],
      recurring: !!item.recurring,
      recurrence_rule: text(item.recurrence),
      has_meeting: true,
      vchat: (item.vchat && typeof item.vchat === 'object' ? item.vchat : null) as CalendarMeetingEvent['vchat'],
      calendar_id: calendar.calendar_id,
      calendar_summary: calendar.summary,
      source: 'user_calendar' as const,
      raw: item,
    }))
    .filter((item) => item.event_id && !!eventStartIso(item));
}

function recurrenceIntervalWeeks(rule: string | undefined): number {
  if (!rule || !/FREQ=WEEKLY/i.test(rule)) return 0;
  const interval = Number(rule.match(/(?:^|;)INTERVAL=(\d+)/i)?.[1] || 1);
  return Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1;
}

function eventStartMs(event: CalendarMeetingEvent): number {
  const iso = eventStartIso(event);
  return iso ? Date.parse(iso) : 0;
}

function eventEndMs(event: CalendarMeetingEvent): number {
  const iso = eventEndIso(event);
  return iso ? Date.parse(iso) : 0;
}

function withEventTimestamp(event: CalendarMeetingEvent, startMs: number, endMs: number, eventId: string): CalendarMeetingEvent {
  return {
    ...event,
    event_id: eventId,
    start_time: { timestamp: String(Math.floor(startMs / 1000)), timezone: event.start_time?.timezone },
    end_time: { timestamp: String(Math.floor(endMs / 1000)), timezone: event.end_time?.timezone || event.start_time?.timezone },
  };
}

function expandCalendarEvent(event: CalendarMeetingEvent, startSeconds: number, endSeconds: number): CalendarMeetingEvent[] {
  const startMs = eventStartMs(event);
  if (!startMs) return [];
  const endMs = eventEndMs(event) || startMs + 60 * 60 * 1000;
  const windowStartMs = startSeconds * 1000;
  const windowEndMs = endSeconds * 1000;
  const intervalWeeks = recurrenceIntervalWeeks(event.recurrence_rule);
  if (!intervalWeeks) return startMs <= windowEndMs && endMs >= windowStartMs ? [event] : [];

  const periodMs = intervalWeeks * 7 * 24 * 60 * 60 * 1000;
  const durationMs = Math.max(60_000, endMs - startMs);
  const baseEventId = event.event_id.replace(/_\d+$/, '');
  const firstIndex = Math.max(0, Math.floor((windowStartMs - startMs) / periodMs) - 1);
  const out: CalendarMeetingEvent[] = [];
  for (let index = firstIndex; index < firstIndex + 200; index += 1) {
    const occurrenceStartMs = startMs + index * periodMs;
    const occurrenceEndMs = occurrenceStartMs + durationMs;
    if (occurrenceStartMs > windowEndMs) break;
    if (occurrenceEndMs < windowStartMs) continue;
    const occurrenceSeconds = Math.floor(occurrenceStartMs / 1000);
    const eventId = occurrenceStartMs === startMs ? event.event_id : `${baseEventId}_${occurrenceSeconds}`;
    out.push(withEventTimestamp(event, occurrenceStartMs, occurrenceEndMs, eventId));
  }
  return out;
}

async function fetchUserCalendarSources(params: {
  config: { appId: string; baseUrl?: string };
  token: string;
  nowMs: number;
  lookbackSeconds: number;
  lookaheadSeconds: number;
  pageSize: number;
}): Promise<{ sources: LarkMeetingSource[]; error?: LarkMeetingSourcesResult['errors'][number] }> {
  const baseUrl = (params.config.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(/\/+$/, '');
  const listed = await requestUserJson(baseUrl, params.token, '/open-apis/calendar/v4/calendars');
  if (listed.code !== 0) {
    const message = feishuMsg(listed);
    return {
      sources: [],
      error: isPermissionDenied(listed)
        ? { source: 'user_calendar', code: 'missing_oauth_scope', message, required_scope: USER_CALENDAR_SCOPES.join(','), permission_url: permissionUrl(params.config.appId, USER_CALENDAR_SCOPES) }
        : { source: 'user_calendar', code: 'calendar_list_failed', message },
    };
  }
  let calendars = normalizeCalendars(listed);
  if (!calendars.length) {
    const primary = await requestUserJson(baseUrl, params.token, '/open-apis/calendar/v4/calendars/primary');
    if (primary.code !== 0) {
      const message = feishuMsg(primary);
      return {
        sources: [],
        error: isPermissionDenied(primary)
          ? { source: 'user_calendar', code: 'missing_oauth_scope', message, required_scope: USER_CALENDAR_SCOPES.join(','), permission_url: permissionUrl(params.config.appId, USER_CALENDAR_SCOPES) }
          : { source: 'user_calendar', code: 'calendar_primary_failed', message },
      };
    }
    const primaryCalendar = normalizePrimaryCalendar(primary);
    calendars = primaryCalendar ? [primaryCalendar] : [];
  }

  const nowSeconds = Math.floor(params.nowMs / 1000);
  const start = nowSeconds - Math.max(0, Math.floor(params.lookbackSeconds));
  const end = nowSeconds + Math.max(60, Math.floor(params.lookaheadSeconds));
  const pageSize = Math.min(Math.max(Math.floor(params.pageSize), 1), 100);
  const sources: LarkMeetingSource[] = [];
  for (const calendar of calendars.slice(0, 20)) {
    let pageToken = '';
    for (let page = 0; page < 5; page += 1) {
      const search = new URLSearchParams({ start_time: String(start), end_time: String(end), page_size: String(pageSize) });
      if (pageToken) search.set('page_token', pageToken);
      let json = await requestUserJson(baseUrl, params.token, `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendar.calendar_id)}/events?${search.toString()}`);
      if (json.code !== 0 && isFieldValidationError(json) && !pageToken) {
        json = await requestUserJson(baseUrl, params.token, `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendar.calendar_id)}/events`);
      }
      if (json.code !== 0) {
        const message = feishuMsg(json);
        return {
          sources,
          error: isPermissionDenied(json)
            ? { source: 'user_calendar', code: 'missing_oauth_scope', message, required_scope: USER_CALENDAR_SCOPES.join(','), permission_url: permissionUrl(params.config.appId, USER_CALENDAR_SCOPES) }
            : { source: 'user_calendar', code: 'event_list_failed', message },
        };
      }
      for (const event of normalizeUserEvents(json, calendar).flatMap((item) => expandCalendarEvent(item, start, end))) {
        const source = calendarSource(event, params.nowMs);
        if (source) sources.push(source);
      }
      const data = dataOf(json);
      if (!data.has_more || !data.page_token) break;
      pageToken = String(data.page_token);
    }
  }
  return { sources };
}

const isCalendarSource = (source: LarkMeetingSource): boolean => source.source === 'user_calendar' || source.source === 'bot_calendar';
const isVcSource = (source: LarkMeetingSource): boolean => source.source === 'lark_meeting_timeline';
const sourceRank = (source: LarkMeetingSource): number => {
  if (source.source === 'lark_meeting_timeline') return 40;
  if (source.source === 'user_calendar') return 30;
  if (source.source === 'bot_calendar') return 20;
  return 10;
};

function sourceIdentityKeys(source: LarkMeetingSource): string[] {
  const keys = [`source:${source.source_id}`];
  const day = source.scheduled_at.slice(0, 10);
  if (source.meeting_no && day) keys.push(`no:${source.meeting_no}:${day}`);
  if (source.calendar_event_id) keys.push(`cal:${source.calendar_event_id}`);
  if (source.feishu_meeting_id) keys.push(`meeting:${source.feishu_meeting_id}`);
  if (source.meeting_url && day) keys.push(`url:${source.meeting_url}:${day}`);
  return keys;
}

function pickPrimarySource(sources: LarkMeetingSource[]): LarkMeetingSource {
  return [...sources].sort((a, b) => {
    const rank = sourceRank(b) - sourceRank(a);
    if (rank) return rank;
    return Number(b.start_time_reliable) - Number(a.start_time_reliable);
  })[0];
}

function pickFirst<T>(sources: LarkMeetingSource[], select: (source: LarkMeetingSource) => T | undefined): T | undefined {
  for (const source of sources) {
    const value = select(source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function chooseMeetingStatus(sources: LarkMeetingSource[], nowMs: number): LarkMeetingSource['status'] {
  const vcEnded = sources.find((source) => isVcSource(source) && source.status === 'ended');
  if (vcEnded) return 'ended';
  const calendarEnded = sources.find((source) => isCalendarSource(source) && source.status === 'ended' && source.ended_at);
  if (calendarEnded) return 'ended';
  if (sources.some((source) => source.status === 'live')) return 'live';
  if (sources.some((source) => source.status === 'ended')) return 'ended';
  return sources.some((source) => Date.parse(source.scheduled_at) <= nowMs) ? 'live' : 'upcoming';
}

function fusedMeetingSource(sources: LarkMeetingSource[], nowMs: number): LarkMeetingSource {
  const ranked = [...sources].sort((a, b) => sourceRank(b) - sourceRank(a));
  const primary = pickPrimarySource(sources);
  const calendar = ranked.find(isCalendarSource);
  const vc = ranked.find(isVcSource);
  const chat = ranked.find((source) => !!source.chat_id);
  const endedAt = pickFirst(ranked.filter((source) => isVcSource(source) && source.status === 'ended'), (source) => source.ended_at)
    ?? pickFirst(ranked.filter(isCalendarSource), (source) => source.ended_at)
    ?? pickFirst(ranked, (source) => source.ended_at);
  const startedAt = pickFirst(ranked.filter(isVcSource), (source) => source.started_at)
    ?? pickFirst(ranked, (source) => source.started_at);
  const meetingUrl = pickFirst(ranked, (source) => source.meeting_url);
  const meetingNo = pickFirst(ranked, (source) => source.meeting_no);
  const feishuMeetingId = pickFirst(ranked.filter(isVcSource), (source) => source.feishu_meeting_id);
  const minuteToken = pickFirst(ranked, (source) => source.feishu_minute_token);

  return {
    ...primary,
    source: vc?.source ?? primary.source,
    title: cleanTitle(vc?.title) || cleanTitle(calendar?.title) || cleanTitle(primary.title) || '飞书会议',
    status: chooseMeetingStatus(sources, nowMs),
    scheduled_at: calendar?.scheduled_at ?? vc?.scheduled_at ?? primary.scheduled_at,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    start_time_reliable: sources.some((source) => source.start_time_reliable),
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(meetingNo ? { meeting_no: meetingNo } : {}),
    ...(feishuMeetingId ? { feishu_meeting_id: feishuMeetingId } : {}),
    ...(minuteToken ? { feishu_minute_token: minuteToken } : {}),
    ...(calendar?.calendar_event_id ? { calendar_event_id: calendar.calendar_event_id } : {}),
    ...(calendar?.calendar_id ? { calendar_id: calendar.calendar_id } : {}),
    ...(chat?.chat_id ? { chat_id: chat.chat_id } : {}),
    ...(chat?.chat_name ? { chat_name: chat.chat_name } : {}),
    ...(chat?.message_id ? { message_id: chat.message_id } : {}),
    raw: sources.length > 1
      ? { merged_source_ids: sources.map((source) => source.source_id), sources: sources.map((source) => ({ source: source.source, source_id: source.source_id, status: source.status, scheduled_at: source.scheduled_at, ended_at: source.ended_at })) }
      : primary.raw,
  };
}

function mergeSources(sources: LarkMeetingSource[], nowMs: number): LarkMeetingSource[] {
  const parent = sources.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const pa = find(a), pb = find(b);
    if (pa !== pb) parent[pb] = pa;
  };
  const seen = new Map<string, number>();
  sources.forEach((source, index) => {
    for (const key of sourceIdentityKeys(source)) {
      const existing = seen.get(key);
      if (existing == null) seen.set(key, index);
      else union(index, existing);
    }
  });
  const groups = new Map<number, LarkMeetingSource[]>();
  sources.forEach((source, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(source);
    groups.set(root, group);
  });
  return [...groups.values()]
    .map((group) => fusedMeetingSource(group, nowMs))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

/**
 * 单场按需解析：给定入会短号 + 该场计划时间，用 ±6h 窗单次 list_by_no 拿真 VC meeting_id。
 * 打开某场会议时才调（一次一场），替代原先一次性给一批会议批量解析（那会触发飞书频率限流、
 * 且周期会所有实例共享短号必须靠具体时间窗才能区分实例）。
 */
export async function resolveLarkMeetingInstance(
  meetingNo: string,
  scheduledAt: string,
  options: Pick<LarkMeetingSourcesOptions, 'env' | 'createClient' | 'nowMs'> = {},
): Promise<{ meeting: LarkMeetingSource | null }> {
  const no = String(meetingNo || '').trim();
  const targetMs = Date.parse(scheduledAt);
  if (!/^\d{6,20}$/.test(no) || !Number.isFinite(targetMs)) {
    throw Object.assign(new Error('invalid meeting_no or scheduled_at'), { status: 400 });
  }
  const env = options.env || process.env;
  const config = appConfig(env);
  if (!config) throw Object.assign(new Error('Lark is not configured'), { status: 503 });
  const nowMs = options.nowMs ?? Date.now();
  const oauth = await resolveUserOAuthToken(env, nowMs, { createClient: options.createClient });
  const client = (options.createClient || createLarkClient)({
    ...process.env,
    ...env,
    LARK_APP_ID: config.appId,
    LARK_APP_SECRET: config.appSecret,
    ...(config.baseUrl ? { LARK_BASE_URL: config.baseUrl } : {}),
  }) as MinimalLarkClient;

  const WINDOW_SECONDS = 6 * 3600;
  const opts = {
    start_time: Math.floor(targetMs / 1000) - WINDOW_SECONDS,
    end_time: Math.floor(targetMs / 1000) + WINDOW_SECONDS,
    page_size: 10,
  };
  // 先 user token（拿本人可见的 VC 实例），失败/无 token 再退 tenant token（应用身份·部分会应用可读）。
  // 恢复旧批量循环里有过的 fallback——只 user 一条路会在 token 缺 scope/过期时整个解析失败。
  let raw: unknown;
  if (oauth.usable && oauth.token && client.listMeetingsByNoWithToken) {
    try {
      raw = await client.listMeetingsByNoWithToken(no, oauth.token, opts);
    } catch (userError) {
      if (!client.listMeetingsByNo) throw userError;
      raw = await client.listMeetingsByNo(no, opts);
    }
  } else {
    raw = await client.listMeetingsByNo?.(no, opts);
  }
  const code = obj(raw).code;
  if (code != null && Number(code) !== 0) throw new Error(feishuMsg(obj(raw)));

  const candidates = candidateRecords(raw)
    .map((record) => meetingSourceFromRecord(record, { meeting_no: no, scheduled_at: new Date(targetMs).toISOString() }, nowMs))
    .filter((source): source is LarkMeetingSource =>
      !!source
      && source.meeting_no === no
      && !!source.feishu_meeting_id
      && source.feishu_meeting_id !== no);
  // 周期会同短号多实例：list_by_no brief 没有自己的开始时间（meetingSourceFromRecord 回填了 targetMs），
  // 无法按时间区分。±6h 窗通常只返回一个实例；若返回多于一个 → 歧义，宁可返 null 也不猜（避免配到相邻实例）。
  const meeting = candidates.length === 1 ? candidates[0] : null;
  return { meeting };
}

export async function fetchLarkMeetingSources(options: LarkMeetingSourcesOptions = {}): Promise<LarkMeetingSourcesResult> {
  const env = options.env || process.env;
  const config = appConfig(env);
  const nowMs = options.nowMs ?? Date.now();
  const lookbackSeconds = Math.max(60, Math.floor(options.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS));
  const lookaheadSeconds = Math.max(60, Math.floor(options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS));
  const startSeconds = Math.floor((nowMs - lookbackSeconds * 1000) / 1000);
  const endSeconds = Math.floor((nowMs + lookaheadSeconds * 1000) / 1000);
  const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? 20), 1), 50);
  const sources: LarkMeetingSource[] = [];
  const errors: LarkMeetingSourcesResult['errors'] = [];
  if (!config) {
    return { connected: false, configured: false, source: 'lark_meeting_sources', source_count: 0, sources: [], errors: [{ source: 'config', code: 'not_configured', message: 'FEISHU_APP_ID/FEISHU_APP_SECRET or LARK_APP_ID/LARK_APP_SECRET is not configured' }] };
  }
  sources.push(...(options.extraSources || []));

  const userOAuth = await resolveUserOAuthToken(env, nowMs, { createClient: options.createClient });
  const userOpenIds = uniqueText([...(options.userOpenIds || []), ...userOAuth.userOpenIds]);
  // 与 realtime store 同一过滤契约：调用方传数组=要求按身份过滤；数组为空（请求者无飞书身份）时
  // bot 日历/bot 群聊/VC 搜索三路全部跳过——否则无身份反而看到全 tenant 会议（泄漏）。
  // undefined=demo/内部调用不过滤，维持原全量行为。判定只看调用方数组，不混入本机 OAuth state 的杂散身份。
  const identityRequiredButMissing = Array.isArray(options.userOpenIds) && options.userOpenIds.length === 0;

  if (!identityRequiredButMissing) {
  try {
    const cal = await fetchFeishuBotCalendarEvents({ nowMs, lookbackSeconds, lookaheadSeconds, pageSize, env });
    if (cal.error) errors.push({ source: 'bot_calendar', code: cal.error.code, message: cal.error.message, permission_url: cal.error.permission_url, required_scope: cal.error.required_scopes?.join(',') });
    for (const event of cal.events) {
      const source = calendarSource({ ...event, source: 'bot_calendar' }, nowMs);
      if (source) sources.push(source);
    }
  } catch (e) {
    errors.push({ source: 'bot_calendar', code: 'calendar_failed', message: String((e as Error)?.message || e) });
  }

  try {
    const workspaces = await fetchFeishuBotWorkspaces({ env });
    if (workspaces.error) errors.push({ source: 'bot_im', code: workspaces.error.code, message: workspaces.error.message, permission_url: workspaces.error.permission_url, required_scope: workspaces.error.required_scopes?.join(',') });
    for (const workspace of workspaces.workspaces.filter((w) => w.chat_status === 'normal').slice(0, 20)) {
      if (!(await botWorkspaceVisibleToUser(workspace, userOpenIds, env))) continue;
      const page = await fetchFeishuBotWorkspaceMessages(workspace.chat_id, { nowMs, lookbackSeconds: Math.max(lookbackSeconds, 14 * 24 * 60 * 60), pageSize: 50, env });
      if (page.error) errors.push({ source: 'bot_chat_message', code: page.error.code, message: page.error.message, permission_url: page.error.permission_url, required_scope: page.error.required_scopes?.join(',') });
      for (const message of page.messages) {
        const source = chatSource(workspace, message, nowMs);
        if (source) sources.push(source);
      }
    }
  } catch (e) {
    errors.push({ source: 'bot_im', code: 'chat_scan_failed', message: String((e as Error)?.message || e) });
  }
  }

  const client = (options.createClient || createLarkClient)({
    ...process.env,
    ...env,
    LARK_APP_ID: config.appId,
    LARK_APP_SECRET: config.appSecret,
    ...(config.baseUrl ? { LARK_BASE_URL: config.baseUrl } : {}),
  }) as MinimalLarkClient;
  if (!userOAuth.usable) {
    const expiredWithoutRefresh = userOAuth.reason === 'oauth_token_expired' && !userOAuth.refreshTokenPresent;
    const refreshFailed = userOAuth.reason === 'oauth_refresh_failed';
    errors.push({
      source: 'lark_oauth',
      code: userOAuth.reason || 'oauth_unavailable',
      message: expiredWithoutRefresh
        ? '飞书用户 OAuth token 已过期，且本地没有 refresh_token；需要重新登录一次，之后才能自动续期。'
        : refreshFailed
          ? `飞书用户 OAuth token 自动续期失败：${userOAuth.refreshError || 'unknown'}`
          : '未检测到可用飞书用户 OAuth token；登录后会优先用用户身份查询 VC 会议。',
      required_scope: 'vc:meeting.search:read',
      permission_url: permissionUrl(config.appId, ['vc:meeting.search:read']),
    });
  } else if (!hasScopes(userOAuth.scopes, USER_CALENDAR_SCOPES)) {
    errors.push({
      source: 'user_calendar',
      code: 'missing_oauth_scope',
      message: '当前飞书 OAuth token 缺少用户日历读取权限；重新登录后才能看到本人日历里的待开始会议。',
      required_scope: USER_CALENDAR_SCOPES.join(','),
      permission_url: permissionUrl(config.appId, USER_CALENDAR_SCOPES),
    });
  } else if (userOAuth.token && !identityRequiredButMissing) {
    try {
      const userCalendar = await fetchUserCalendarSources({ config, token: userOAuth.token, nowMs, lookbackSeconds, lookaheadSeconds, pageSize });
      sources.push(...userCalendar.sources);
      if (userCalendar.error) errors.push(userCalendar.error);
    } catch (e) {
      errors.push({ source: 'user_calendar', code: 'calendar_failed', message: String((e as Error)?.message || e), required_scope: USER_CALENDAR_SCOPES.join(','), permission_url: permissionUrl(config.appId, USER_CALENDAR_SCOPES) });
    }
  }
  // 不再在这里批量 list_by_no 解析每一场的真 meeting_id——一次性给一批会解析会触发飞书频率限流
  // (list_by_no_cooldown)，且周期会所有实例共享短号、批量用大窗无法区分实例。改为打开某场会议时
  // 用该场 scheduled_at 的 ±6h 窗按需单场解析（见 resolveLarkMeetingInstance / 前端 resolveMeetingInstance）。
  try {
    if (!identityRequiredButMissing && (client.searchMeetings || (userOAuth.token && client.searchMeetingsWithToken))) {
      const vcSearchPageSize = Math.min(pageSize, 10);
      const baseOpts = { start_time: startSeconds, end_time: endSeconds, page_size: vcSearchPageSize };
      const opts = userOAuth.token && userOpenIds.length
        ? { ...baseOpts, participant_ids: userOpenIds }
        : baseOpts;
      const raw = userOAuth.token && client.searchMeetingsWithToken
        ? await client.searchMeetingsWithToken(userOAuth.token, opts)
        : await client.searchMeetings?.(baseOpts);
      for (const record of candidateRecords(raw)) {
        const source = meetingSourceFromRecord(record, {}, nowMs);
        if (source) sources.push(source);
      }
    }
  } catch (e) {
    errors.push({ source: 'lark_meeting_timeline_search', code: 'search_failed', message: String((e as Error)?.message || e), required_scope: 'vc:meeting.search:read', permission_url: permissionUrl(config.appId, ['vc:meeting.search:read']) });
  }

  const merged = mergeSources(sources, nowMs);
  return {
    connected: sources.length > 0 || errors.some((error) => error.source !== 'config'),
    configured: true,
    source: 'lark_meeting_sources',
    source_count: merged.length,
    sources: merged,
    errors,
  };
}
