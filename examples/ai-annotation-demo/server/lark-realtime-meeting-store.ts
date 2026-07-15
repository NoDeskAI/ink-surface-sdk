import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LarkMeetingSource } from './lark-meeting-sources';

export interface LarkRealtimeMeetingRecord {
  id: string;
  title: string;
  status: 'upcoming' | 'live' | 'ended';
  scheduled_at: string;
  started_at?: string;
  ended_at?: string;
  meeting_url?: string;
  meeting_no?: string;
  feishu_meeting_id?: string;
  owner_open_id?: string;
  participant_open_ids?: string[];
  source_event_type?: string;
  source_event_id?: string;
  source_transport?: 'lark_ws_event' | 'lark_http_event' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface LarkRealtimeMeetingStoreFile {
  schema_version: 'inkloop.lark_realtime_meetings.v1';
  updated_at: string;
  meetings: LarkRealtimeMeetingRecord[];
}

export interface LarkRealtimeMeetingInput {
  title?: unknown;
  status?: unknown;
  scheduled_at?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  meeting_url?: unknown;
  meeting_no?: unknown;
  feishu_meeting_id?: unknown;
  owner_open_id?: unknown;
  participant_open_ids?: unknown;
  source_event_type?: unknown;
  source_event_id?: unknown;
  source_transport?: LarkRealtimeMeetingRecord['source_transport'];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function uniqueText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
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

function meetingNoFromUrl(value: string): string {
  return value.match(/https:\/\/(?:vc|meeting)\.feishu\.cn\/j\/(\d+)/)?.[1] || '';
}

function normalizeMeetingNo(value: unknown): string {
  const raw = text(value);
  const fromUrl = meetingNoFromUrl(raw);
  if (fromUrl) return fromUrl;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 16 ? digits : '';
}

function normalizeStatus(value: unknown, endedAt?: string): LarkRealtimeMeetingRecord['status'] {
  const raw = text(value).toLowerCase();
  if (raw === 'ended' || raw === 'live' || raw === 'upcoming') return raw;
  return endedAt ? 'ended' : 'live';
}

function defaultPath(root: string): string {
  return resolve(root, process.env.INKLOOP_LARK_REALTIME_MEETING_STORE || '.inkloop/lark-realtime-meetings.json');
}

function readStore(path: string): LarkRealtimeMeetingStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LarkRealtimeMeetingStoreFile>;
    return {
      schema_version: 'inkloop.lark_realtime_meetings.v1',
      updated_at: text(parsed.updated_at) || new Date(0).toISOString(),
      meetings: Array.isArray(parsed.meetings) ? parsed.meetings.filter((item): item is LarkRealtimeMeetingRecord => !!item && typeof item === 'object') : [],
    };
  } catch {
    return { schema_version: 'inkloop.lark_realtime_meetings.v1', updated_at: new Date(0).toISOString(), meetings: [] };
  }
}

function writeStore(path: string, store: LarkRealtimeMeetingStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
}

function recordIdentity(input: {
  feishuMeetingId?: string;
  meetingNo?: string;
  meetingUrl?: string;
  sourceEventId?: string;
  scheduledAt: string;
}): string {
  const day = input.scheduledAt.slice(0, 10);
  if (input.feishuMeetingId) return `lark_meeting:${input.feishuMeetingId}`;
  if (input.meetingNo) return `lark_no:${input.meetingNo}:${day}`;
  if (input.meetingUrl) return `lark_url:${input.meetingUrl}:${day}`;
  if (input.sourceEventId) return `lark_event:${input.sourceEventId}`;
  return `lark_manual:${Date.parse(input.scheduledAt) || Date.now()}`;
}

export function upsertLarkRealtimeMeeting(root: string, input: LarkRealtimeMeetingInput, nowMs = Date.now()): LarkRealtimeMeetingRecord {
  const path = defaultPath(root);
  const store = readStore(path);
  const now = new Date(nowMs).toISOString();
  const meetingUrl = text(input.meeting_url);
  const meetingNo = normalizeMeetingNo(input.meeting_no) || meetingNoFromUrl(meetingUrl);
  const feishuMeetingId = text(input.feishu_meeting_id);
  const startedAt = iso(input.started_at) || iso(input.scheduled_at) || now;
  const endedAt = iso(input.ended_at);
  const scheduledAt = iso(input.scheduled_at) || startedAt;
  const sourceEventId = text(input.source_event_id);
  const id = recordIdentity({ feishuMeetingId, meetingNo, meetingUrl, sourceEventId, scheduledAt });
  const existing = store.meetings.find((item) => item.id === id);
  const resolvedOwnerOpenId = text(input.owner_open_id) || text(existing?.owner_open_id);
  const participantOpenIds = [...new Set([
    ...uniqueText(existing?.participant_open_ids),
    ...uniqueText(input.participant_open_ids),
  ])];
  const record: LarkRealtimeMeetingRecord = {
    id,
    title: text(input.title) || existing?.title || '飞书即时会议',
    status: normalizeStatus(input.status, endedAt) === 'ended' || existing?.status === 'ended' ? 'ended' : normalizeStatus(input.status, endedAt),
    scheduled_at: existing?.scheduled_at || scheduledAt,
    started_at: existing?.started_at || startedAt,
    ...(endedAt || existing?.ended_at ? { ended_at: endedAt || existing?.ended_at } : {}),
    ...(meetingUrl || existing?.meeting_url ? { meeting_url: meetingUrl || existing?.meeting_url } : {}),
    ...(meetingNo || existing?.meeting_no ? { meeting_no: meetingNo || existing?.meeting_no } : {}),
    ...(feishuMeetingId || existing?.feishu_meeting_id ? { feishu_meeting_id: feishuMeetingId || existing?.feishu_meeting_id } : {}),
    ...(resolvedOwnerOpenId ? { owner_open_id: resolvedOwnerOpenId } : {}),
    ...(participantOpenIds.length ? { participant_open_ids: participantOpenIds } : {}),
    ...(text(input.source_event_type) || existing?.source_event_type ? { source_event_type: text(input.source_event_type) || existing?.source_event_type } : {}),
    ...(sourceEventId || existing?.source_event_id ? { source_event_id: sourceEventId || existing?.source_event_id } : {}),
    ...(input.source_transport || existing?.source_transport ? { source_transport: input.source_transport || existing?.source_transport } : {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  store.meetings = [record, ...store.meetings.filter((item) => item.id !== id)].slice(0, 100);
  store.updated_at = now;
  writeStore(path, store);
  return record;
}

export function listLarkRealtimeMeetings(root: string, options: { nowMs?: number; lookbackSeconds?: number; lookaheadSeconds?: number } = {}): LarkRealtimeMeetingRecord[] {
  const nowMs = options.nowMs ?? Date.now();
  const min = nowMs - Math.max(60, options.lookbackSeconds ?? 2 * 24 * 60 * 60) * 1000;
  const max = nowMs + Math.max(60, options.lookaheadSeconds ?? 14 * 24 * 60 * 60) * 1000;
  return readStore(defaultPath(root)).meetings.filter((item) => {
    const start = Date.parse(item.scheduled_at);
    const end = item.ended_at ? Date.parse(item.ended_at) : start;
    return Number.isFinite(start) && start <= max && Math.max(start, end || start) >= min;
  });
}

export function larkRealtimeMeetingSources(root: string, options: { nowMs?: number; lookbackSeconds?: number; lookaheadSeconds?: number; userOpenIds?: string[] } = {}): LarkMeetingSource[] {
  const userOpenIds = new Set(uniqueText(options.userOpenIds));
  return listLarkRealtimeMeetings(root, options).filter((item) => (
    !userOpenIds.size
    || userOpenIds.has(text(item.owner_open_id))
    || uniqueText(item.participant_open_ids).some((openId) => userOpenIds.has(openId))
  )).map((item) => ({
    source_id: `realtime:${item.id}`,
    source: 'lark_meeting_timeline',
    title: item.title,
    status: item.status,
    scheduled_at: item.scheduled_at,
    ...(item.started_at ? { started_at: item.started_at } : {}),
    ...(item.ended_at ? { ended_at: item.ended_at } : {}),
    start_time_reliable: true,
    ...(item.meeting_url ? { meeting_url: item.meeting_url } : {}),
    ...(item.meeting_no ? { meeting_no: item.meeting_no } : {}),
    ...(item.feishu_meeting_id ? { feishu_meeting_id: item.feishu_meeting_id } : {}),
    raw: {
      source: 'lark_realtime_meeting_store',
      source_event_type: item.source_event_type,
      source_event_id: item.source_event_id,
      source_transport: item.source_transport,
    },
  }));
}

export function larkRealtimeMeetingStoreStatus(root: string): { configured: true; path: string; count: number; updated_at: string | null } {
  const path = defaultPath(root);
  const store = readStore(path);
  return {
    configured: true,
    path,
    count: store.meetings.length,
    updated_at: store.updated_at === new Date(0).toISOString() ? null : store.updated_at,
  };
}
