import { createRequire } from 'node:module';
import { upsertLarkRealtimeMeeting, type LarkRealtimeMeetingRecord } from './lark-realtime-meeting-store';

export interface LarkWsMeetingEventsEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
  INKLOOP_LARK_WS_EVENTS?: string;
}

export interface LarkWsMeetingEventsStatus {
  enabled: boolean;
  state: 'disabled' | 'missing_credentials' | 'missing_sdk' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  mode: 'long_connection';
  registered_event_types: string[];
  recent_event_count: number;
  recent_meeting_count: number;
  last_event_at: string | null;
  last_event_type: string | null;
  last_meeting_id: string | null;
  last_error: string | null;
}

const require = createRequire(import.meta.url);

const registeredEventTypes = [
  'vc.meeting.all_meeting_started_v1',
  'vc.meeting.all_meeting_ended_v1',
  'vc.meeting.meeting_started_v1',
  'vc.meeting.meeting_ended_v1',
  'vc.meeting.join_meeting_v1',
  'vc.meeting.leave_meeting_v1',
];

let wsClient: { start?: (opts: unknown) => Promise<unknown>; close?: (opts?: unknown) => unknown; getConnectionStatus?: () => { state?: string; reconnectAttempts?: number } } | null = null;
let started = false;
let status: LarkWsMeetingEventsStatus = {
  enabled: false,
  state: 'disabled',
  mode: 'long_connection',
  registered_event_types: registeredEventTypes,
  recent_event_count: 0,
  recent_meeting_count: 0,
  last_event_at: null,
  last_event_type: null,
  last_meeting_id: null,
  last_error: null,
};

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const t = text(value);
    if (t) return t;
  }
  return '';
}

function parseMs(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string | undefined {
  const ms = parseMs(value);
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

function eventHeader(payload: unknown): Record<string, unknown> {
  const raw = obj(payload);
  return obj(raw.header || obj(raw.event).header || obj(raw.data).header);
}

function eventPayload(payload: unknown): Record<string, unknown> {
  const raw = obj(payload);
  return obj(raw.event || obj(raw.data).event || obj(raw.event).event || raw);
}

function eventTypeFromPayload(payload: unknown, fallback = ''): string {
  const raw = obj(payload);
  const header = eventHeader(payload);
  return firstText(
    header.event_type,
    raw.event_type,
    raw.type,
    obj(raw.event).type,
    obj(raw.event).event_type,
    fallback,
  );
}

function eventIdFromPayload(payload: unknown): string {
  const raw = obj(payload);
  const header = eventHeader(payload);
  const event = eventPayload(payload);
  return firstText(header.event_id, raw.event_id, raw.uuid, event.event_id, event.id);
}

function meetingFromEvent(payload: unknown): Record<string, unknown> {
  const event = eventPayload(payload);
  return obj(
    event.meeting
      || event.meeting_info
      || event.vc_meeting
      || event.meeting_data
      || obj(event.data).meeting
      || obj(event.data).meeting_info
      || event,
  );
}

function eventParticipant(payload: unknown): Record<string, unknown> {
  const event = eventPayload(payload);
  return obj(event.participant || event.user || event.operator);
}

function meetingNoFromUrl(value: string): string {
  return value.match(/https:\/\/(?:vc|meeting)\.feishu\.cn\/j\/(\d+)/)?.[1] || '';
}

function meetingInputFromEvent(payload: unknown, eventType: string, nowMs: number): Parameters<typeof upsertLarkRealtimeMeeting>[1] | null {
  const meeting = meetingFromEvent(payload);
  const event = eventPayload(payload);
  const participant = eventParticipant(payload);
  const eventId = eventIdFromPayload(payload);
  const isEnd = /(_ended|meeting_ended|leave_meeting)/i.test(eventType);
  const isStart = /(_started|meeting_started|join_meeting)/i.test(eventType);
  if (!isStart && !isEnd) return null;

  const meetingUrl = firstText(meeting.url, meeting.meeting_url, meeting.join_url, meeting.share_url, event.meeting_url, event.join_url);
  const meetingNo = firstText(meeting.meeting_no, meeting.open_meeting_id, event.meeting_no, event.open_meeting_id, meetingNoFromUrl(meetingUrl));
  const feishuMeetingId = firstText(meeting.id, meeting.meeting_id, event.meeting_id, event.vc_meeting_id, event.open_meeting_id);
  const startedAt = iso(firstText(meeting.start_time, meeting.start_at, meeting.begin_time, event.start_time, event.start_at, event.begin_time)) || new Date(nowMs).toISOString();
  const endedAt = isEnd
    ? (iso(firstText(meeting.end_time, meeting.end_at, event.end_time, event.end_at)) || new Date(nowMs).toISOString())
    : undefined;
  const title = firstText(meeting.topic, meeting.title, meeting.name, event.topic, event.title)
    || (participant.name ? `飞书会议 · ${participant.name}` : '飞书即时会议');
  if (!feishuMeetingId && !meetingNo && !meetingUrl && !eventId) return null;
  return {
    title,
    status: isEnd ? 'ended' : 'live',
    scheduled_at: startedAt,
    started_at: startedAt,
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(meetingNo ? { meeting_no: meetingNo } : {}),
    ...(feishuMeetingId ? { feishu_meeting_id: feishuMeetingId } : {}),
    source_event_type: eventType,
    source_event_id: eventId,
    source_transport: 'lark_ws_event',
  };
}

function loadLarkSdk(): Record<string, unknown> | null {
  try {
    return require('../Lark-Meeting-Timeline-main/node_modules/@larksuiteoapi/node-sdk') as Record<string, unknown>;
  } catch {
    try {
      return require('@larksuiteoapi/node-sdk') as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function larkDomain(Lark: Record<string, unknown>, baseUrl?: string): unknown {
  const domain = obj(Lark.Domain);
  return String(baseUrl || '').includes('larksuite') ? domain.Lark : domain.Feishu;
}

function createDispatcher(Lark: Record<string, unknown>, root: string): unknown {
  const EventDispatcher = Lark.EventDispatcher as new (opts: Record<string, unknown>) => { register: (handlers: Record<string, (data: unknown) => Promise<unknown>>) => unknown; invoke?: (raw: unknown, params?: unknown) => Promise<unknown>; requestHandle?: { parse?: (raw: unknown) => unknown } };
  const LoggerLevel = obj(Lark.LoggerLevel);
  const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn });
  const handlers = Object.fromEntries(registeredEventTypes.map((eventType) => [
    eventType,
    async (data: unknown) => handleLarkWsEvent(root, data, eventType),
  ]));
  dispatcher.register(handlers);

  const originalInvoke = dispatcher.invoke?.bind(dispatcher);
  if (originalInvoke) {
    dispatcher.invoke = async (raw: unknown, params?: unknown) => {
      let parsed = raw;
      try {
        parsed = dispatcher.requestHandle?.parse?.(raw) ?? raw;
      } catch {
        parsed = raw;
      }
      const eventType = eventTypeFromPayload(parsed);
      if (registeredEventTypes.includes(eventType)) return originalInvoke(raw, params);
      if (/vc\.|meeting/i.test(eventType)) return handleLarkWsEvent(root, parsed, eventType);
      return originalInvoke(raw, params);
    };
  }
  return dispatcher;
}

async function handleLarkWsEvent(root: string, payload: unknown, forcedEventType?: string): Promise<{ ok: boolean; record?: LarkRealtimeMeetingRecord; ignored_reason?: string }> {
  const nowMs = Date.now();
  const eventType = forcedEventType || eventTypeFromPayload(payload);
  status = {
    ...status,
    recent_event_count: status.recent_event_count + 1,
    last_event_at: new Date(nowMs).toISOString(),
    last_event_type: eventType || 'unknown',
  };
  const input = meetingInputFromEvent(payload, eventType, nowMs);
  if (!input) return { ok: false, ignored_reason: 'not_meeting_start_or_end' };
  const record = upsertLarkRealtimeMeeting(root, input, nowMs);
  status = {
    ...status,
    recent_meeting_count: status.recent_meeting_count + 1,
    last_meeting_id: record.feishu_meeting_id || record.meeting_no || record.id,
  };
  return { ok: true, record };
}

export function startLarkWsMeetingEvents(root: string, env: LarkWsMeetingEventsEnv = process.env): LarkWsMeetingEventsStatus {
  if (started) return getLarkWsMeetingEventsStatus();
  if (String(env.INKLOOP_LARK_WS_EVENTS || '1') === '0') {
    status = { ...status, enabled: false, state: 'disabled' };
    return getLarkWsMeetingEventsStatus();
  }
  const appId = text(env.LARK_APP_ID) || text(env.FEISHU_APP_ID);
  const appSecret = text(env.LARK_APP_SECRET) || text(env.FEISHU_APP_SECRET);
  const baseUrl = text(env.LARK_BASE_URL) || text(env.FEISHU_BASE_URL);
  if (!appId || !appSecret) {
    status = { ...status, enabled: false, state: 'missing_credentials', last_error: 'missing_lark_app_credentials' };
    return getLarkWsMeetingEventsStatus();
  }
  const Lark = loadLarkSdk();
  if (!Lark?.WSClient || !Lark?.EventDispatcher) {
    status = { ...status, enabled: false, state: 'missing_sdk', last_error: 'missing @larksuiteoapi/node-sdk' };
    return getLarkWsMeetingEventsStatus();
  }
  const WSClient = Lark.WSClient as new (opts: Record<string, unknown>) => typeof wsClient;
  const LoggerLevel = obj(Lark.LoggerLevel);
  started = true;
  status = { ...status, enabled: true, state: 'connecting', last_error: null };
  wsClient = new WSClient({
    appId,
    appSecret,
    domain: larkDomain(Lark, baseUrl),
    loggerLevel: LoggerLevel.warn,
    autoReconnect: true,
    handshakeTimeoutMs: 15_000,
    source: 'inkloop-cloud-hub',
    onReady: () => { status = { ...status, state: 'connected', last_error: null }; },
    onReconnecting: () => { status = { ...status, state: 'reconnecting' }; },
    onReconnected: () => { status = { ...status, state: 'connected', last_error: null }; },
    onError: (error: Error) => { status = { ...status, state: 'failed', last_error: error.message || String(error) }; },
  });
  wsClient?.start?.({ eventDispatcher: createDispatcher(Lark, root) }).catch((error: Error) => {
    status = { ...status, state: 'failed', last_error: error.message || String(error) };
  });
  return getLarkWsMeetingEventsStatus();
}

export function getLarkWsMeetingEventsStatus(): LarkWsMeetingEventsStatus {
  const connection = wsClient?.getConnectionStatus?.();
  const state = connection?.state;
  return {
    ...status,
    state: (state === 'connected' || state === 'reconnecting' || state === 'connecting' || state === 'failed')
      ? state
      : status.state,
  };
}

export function stopLarkWsMeetingEvents(): void {
  try { wsClient?.close?.({ force: true }); } catch { /* best effort */ }
  wsClient = null;
  started = false;
  status = { ...status, enabled: false, state: 'disabled' };
}
