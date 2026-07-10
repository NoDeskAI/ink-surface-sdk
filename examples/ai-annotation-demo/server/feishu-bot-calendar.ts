const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
const DEFAULT_LOOKBACK_SECONDS = 6 * 60 * 60;
const DEFAULT_LOOKAHEAD_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_EVENT_PAGE_SIZE = 50;

type FetchLike = typeof fetch;

export interface FeishuBotCalendarEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
}

export interface FeishuBotCalendarFetchOptions {
  nowMs?: number;
  lookbackSeconds?: number;
  lookaheadSeconds?: number;
  pageSize?: number;
  fetchImpl?: FetchLike;
  env?: FeishuBotCalendarEnv;
}

interface FeishuTimeInfo {
  timestamp?: string;
  date?: string;
  timezone?: string;
}

interface FeishuRawCalendar {
  calendar_id?: string;
  summary?: string;
  title?: string;
  [key: string]: unknown;
}

interface FeishuRawEvent {
  event_id?: string;
  summary?: string;
  start_time?: FeishuTimeInfo;
  end_time?: FeishuTimeInfo;
  recurring?: boolean;
  status?: string;
  vchat?: { meeting_url?: string; vc_type?: string } | null;
  event_organizer?: { display_name?: string };
  [key: string]: unknown;
}

export interface FeishuBotCalendarEvent {
  event_id: string;
  summary?: string;
  start_time?: FeishuTimeInfo;
  end_time?: FeishuTimeInfo;
  recurring?: boolean;
  has_meeting: boolean;
  vchat?: { meeting_url?: string; vc_type?: string } | null;
  calendar_id: string;
  calendar_summary?: string;
  source: 'bot_calendar';
}

export interface FeishuBotCalendarResult {
  connected: boolean;
  configured: boolean;
  source: 'feishu_bot_calendar';
  auth_mode: 'tenant_access_token';
  events: FeishuBotCalendarEvent[];
  calendars: Array<{ calendar_id: string; summary?: string }>;
  error?: {
    code: string;
    message: string;
    permission_url?: string;
    required_scopes?: string[];
  };
}

function appConfig(env: FeishuBotCalendarEnv): { appId: string; appSecret: string; baseUrl: string } | null {
  const appId = String(env.FEISHU_APP_ID || env.LARK_APP_ID || '').trim();
  const appSecret = String(env.FEISHU_APP_SECRET || env.LARK_APP_SECRET || '').trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    baseUrl: String(env.FEISHU_BASE_URL || env.LARK_BASE_URL || DEFAULT_FEISHU_BASE_URL).replace(/\/+$/, ''),
  };
}

function emptyResult(configured: boolean, error?: FeishuBotCalendarResult['error']): FeishuBotCalendarResult {
  return {
    connected: false,
    configured,
    source: 'feishu_bot_calendar',
    auth_mode: 'tenant_access_token',
    events: [],
    calendars: [],
    ...(error ? { error } : {}),
  };
}

function permissionUrl(appId: string, scopes: string[]): string {
  const q = encodeURIComponent(scopes.join(','));
  return `https://open.feishu.cn/app/${appId}/auth?q=${q}&op_from=openapi&token_type=tenant`;
}

function extractPermissionUrl(message: string): string | undefined {
  return message.match(/https:\/\/open\.feishu\.cn\/app\/[^\s，]+/)?.[0];
}

function permissionError(appId: string, message: string): FeishuBotCalendarResult['error'] {
  const requiredScopes = ['calendar:calendar:read', 'calendar:calendar.event:read'];
  return {
    code: 'missing_calendar_scope',
    message,
    permission_url: extractPermissionUrl(message) || permissionUrl(appId, requiredScopes),
    required_scopes: requiredScopes,
  };
}

async function requestJson(fetchImpl: FetchLike, baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; }
  catch { json = { raw: text }; }
  return { status: res.status, json };
}

function feishuMsg(json: Record<string, unknown>): string {
  return String(json.msg || json.message || json.error || json.code || 'unknown Feishu error');
}

function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return (json.data && typeof json.data === 'object') ? json.data as Record<string, unknown> : {};
}

function normalizeCalendars(json: Record<string, unknown>): Array<{ calendar_id: string; summary?: string }> {
  const data = dataOf(json);
  const raw = (Array.isArray(data.calendar_list) ? data.calendar_list : Array.isArray(data.items) ? data.items : []) as FeishuRawCalendar[];
  return raw
    .map((item) => ({ calendar_id: String(item.calendar_id || '').trim(), summary: item.summary || item.title }))
    .filter((item) => item.calendar_id);
}

function normalizePrimaryCalendar(json: Record<string, unknown>): { calendar_id: string; summary?: string } | null {
  const data = dataOf(json);
  const raw = ((data.calendar && typeof data.calendar === 'object') ? data.calendar : data) as FeishuRawCalendar;
  const calendarId = String(raw.calendar_id || '').trim();
  return calendarId ? { calendar_id: calendarId, summary: raw.summary || raw.title } : null;
}

function eventStartMs(event: Pick<FeishuRawEvent, 'start_time'>): number {
  const timestamp = event.start_time?.timestamp;
  if (timestamp) {
    const n = Number(timestamp);
    return Number.isFinite(n) ? n * 1000 : 0;
  }
  const date = event.start_time?.date;
  return date ? new Date(`${date}T00:00:00+08:00`).getTime() : 0;
}

function normalizeEvents(json: Record<string, unknown>, calendar: { calendar_id: string; summary?: string }): FeishuBotCalendarEvent[] {
  const data = dataOf(json);
  const raw = (Array.isArray(data.items) ? data.items : Array.isArray(data.event_list) ? data.event_list : []) as FeishuRawEvent[];
  return raw
    .filter((item) => item.status !== 'cancelled')
    .map((item) => ({
      event_id: String(item.event_id || '').trim(),
      summary: item.summary,
      start_time: item.start_time,
      end_time: item.end_time,
      recurring: !!item.recurring,
      has_meeting: true,
      vchat: item.vchat || null,
      calendar_id: calendar.calendar_id,
      calendar_summary: calendar.summary,
      source: 'bot_calendar' as const,
    }))
    .filter((item) => item.event_id && eventStartMs(item) > 0);
}

async function tenantAccessToken(fetchImpl: FetchLike, config: { appId: string; appSecret: string; baseUrl: string }): Promise<{ token?: string; error?: FeishuBotCalendarResult['error'] }> {
  const res = await requestJson(fetchImpl, config.baseUrl, '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  if (res.json.code !== 0) {
    return { error: { code: 'token_failed', message: feishuMsg(res.json) } };
  }
  const token = String(res.json.tenant_access_token || '').trim();
  return token ? { token } : { error: { code: 'token_missing', message: 'Feishu token response missing tenant_access_token' } };
}

function isPermissionDenied(json: Record<string, unknown>): boolean {
  const msg = feishuMsg(json);
  return Number(json.code) === 99991672 || /Access denied|scope|permission|权限/.test(msg);
}

function isFieldValidationError(json: Record<string, unknown>): boolean {
  return Number(json.code) === 99992402 || /field validation failed/i.test(feishuMsg(json));
}

async function listAccessibleCalendars(fetchImpl: FetchLike, config: { appId: string; baseUrl: string }, token: string): Promise<{ calendars?: Array<{ calendar_id: string; summary?: string }>; error?: FeishuBotCalendarResult['error'] }> {
  const headers = { authorization: `Bearer ${token}` };
  const listed = await requestJson(fetchImpl, config.baseUrl, '/open-apis/calendar/v4/calendars', { headers });
  if (listed.json.code !== 0) {
    const message = feishuMsg(listed.json);
    return { error: isPermissionDenied(listed.json) ? permissionError(config.appId, message) : { code: 'calendar_list_failed', message } };
  }
  const calendars = normalizeCalendars(listed.json);
  if (calendars.length) return { calendars };
  const primary = await requestJson(fetchImpl, config.baseUrl, '/open-apis/calendar/v4/calendars/primary', { headers });
  if (primary.json.code !== 0) {
    const message = feishuMsg(primary.json);
    return { error: isPermissionDenied(primary.json) ? permissionError(config.appId, message) : { code: 'calendar_primary_failed', message } };
  }
  const primaryCalendar = normalizePrimaryCalendar(primary.json);
  return { calendars: primaryCalendar ? [primaryCalendar] : [] };
}

export async function fetchFeishuBotCalendarEvents(options: FeishuBotCalendarFetchOptions = {}): Promise<FeishuBotCalendarResult> {
  const env = options.env || process.env;
  const config = appConfig(env);
  if (!config) {
    return emptyResult(false, {
      code: 'not_configured',
      message: 'FEISHU_APP_ID/FEISHU_APP_SECRET or LARK_APP_ID/LARK_APP_SECRET is not configured',
    });
  }
  const fetchImpl = options.fetchImpl || fetch;
  const token = await tenantAccessToken(fetchImpl, config);
  if (!token.token) return emptyResult(true, token.error);
  const calendars = await listAccessibleCalendars(fetchImpl, config, token.token);
  if (!calendars.calendars) return emptyResult(true, calendars.error);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const start = nowSeconds - Math.max(0, Math.floor(options.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS));
  const end = nowSeconds + Math.max(60, Math.floor(options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS));
  const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? DEFAULT_EVENT_PAGE_SIZE), 1), 100);
  const headers = { authorization: `Bearer ${token.token}` };
  const events: FeishuBotCalendarEvent[] = [];
  for (const calendar of calendars.calendars) {
    let pageToken = '';
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({ start_time: String(start), end_time: String(end), page_size: String(pageSize) });
      if (pageToken) params.set('page_token', pageToken);
      let res = await requestJson(fetchImpl, config.baseUrl, `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendar.calendar_id)}/events?${params.toString()}`, { headers });
      if (res.json.code !== 0 && isFieldValidationError(res.json) && !pageToken) {
        res = await requestJson(fetchImpl, config.baseUrl, `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendar.calendar_id)}/events`, { headers });
      }
      if (res.json.code !== 0) {
        const message = feishuMsg(res.json);
        return emptyResult(true, isPermissionDenied(res.json) ? permissionError(config.appId, message) : { code: 'event_list_failed', message });
      }
      events.push(...normalizeEvents(res.json, calendar));
      const data = dataOf(res.json);
      if (!data.has_more || !data.page_token) break;
      pageToken = String(data.page_token);
    }
  }
  const deduped = new Map<string, FeishuBotCalendarEvent>();
  for (const event of events) deduped.set(`${event.calendar_id}:${event.event_id}`, event);
  return {
    connected: true,
    configured: true,
    source: 'feishu_bot_calendar',
    auth_mode: 'tenant_access_token',
    calendars: calendars.calendars,
    events: [...deduped.values()].sort((a, b) => eventStartMs(a) - eventStartMs(b)),
  };
}
