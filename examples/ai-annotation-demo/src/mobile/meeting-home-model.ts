import type { MeetingStatus, PersistedMeeting } from '../core/store-format';
import { markTime, type MarkTimeFields } from '../core/mark-time';
import { meetingPlatformOf, type MeetingPlatform } from './meeting-platform';

export type MeetingHomeFilter = 'active' | 'history';

export const MEETING_PROVIDER_LEAD_OPTIONS: readonly MeetingPlatform[] = ['lark', 'google_meet', 'zoom', 'manual'];

export interface MeetingHomeBuckets {
  active: PersistedMeeting[];
  history: PersistedMeeting[];
  historyTotal: number;
}

export function filterMeetingsByPlatform(meetings: PersistedMeeting[], platform: MeetingPlatform): PersistedMeeting[] {
  return meetings.filter((meeting) => meetingPlatformOf(meeting) === platform);
}

const LIVE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STALE_MEETING_DURATION_MS = 60 * 60 * 1000;
export const MEETING_MARK_GRACE_MS = 10 * 60 * 1000;
export type MeetingMarkPhase = 'pre' | 'in' | 'post';

export function normalizeMeetingHomeFilter(value: unknown): MeetingHomeFilter {
  return value === 'history' ? 'history' : 'active';
}

function parseMs(value: string | undefined): number {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

export function effectiveMeetingStatus(meeting: Pick<PersistedMeeting, 'status' | 'started_at' | 'scheduled_at' | 'ended_at'>, nowMs = Date.now()): MeetingStatus {
  const endedAt = parseMs(meeting.ended_at);
  if (endedAt > 0 && endedAt <= nowMs) return 'ended';
  const scheduledAt = parseMs(meeting.scheduled_at);
  if (meeting.status === 'upcoming' && scheduledAt > 0 && scheduledAt <= nowMs) {
    if (!endedAt && nowMs - scheduledAt > LIVE_STALE_AFTER_MS) return 'ended';
    return 'live';
  }
  if (meeting.status === 'live') {
    const startedAt = parseMs(meeting.started_at) || scheduledAt;
    if (startedAt > 0 && nowMs - startedAt > LIVE_STALE_AFTER_MS) return 'ended';
  }
  return meeting.status;
}

export function effectiveMeetingEndIso(meeting: Pick<PersistedMeeting, 'started_at' | 'scheduled_at' | 'ended_at'>, nowMs = Date.now()): string | undefined {
  const endedAt = parseMs(meeting.ended_at);
  if (endedAt > 0) return new Date(endedAt).toISOString();
  const startedAt = parseMs(meeting.started_at) || parseMs(meeting.scheduled_at);
  if (startedAt > 0 && nowMs - startedAt > LIVE_STALE_AFTER_MS) {
    return new Date(startedAt + DEFAULT_STALE_MEETING_DURATION_MS).toISOString();
  }
  return undefined;
}

export function meetingMarkPhase(
  mark: MarkTimeFields,
  meeting: Pick<PersistedMeeting, 'started_at' | 'scheduled_at' | 'ended_at'>,
  nowMs = Date.now(),
): MeetingMarkPhase {
  const at = markTime(mark);
  const startedAt = parseMs(meeting.started_at) || parseMs(meeting.scheduled_at);
  if (startedAt > 0 && at < startedAt - MEETING_MARK_GRACE_MS) return 'pre';
  const endedAt = parseMs(meeting.ended_at) || parseMs(effectiveMeetingEndIso(meeting, nowMs));
  if (endedAt > 0 && at > endedAt + MEETING_MARK_GRACE_MS) return 'post';
  return 'in';
}

export function meetingHomeBuckets(
  meetings: PersistedMeeting[],
  opts: { historyLimit?: number; nowMs?: number } = {},
): MeetingHomeBuckets {
  const historyLimit = opts.historyLimit ?? 20;
  const nowMs = opts.nowMs ?? Date.now();
  const normalized = meetings.map((meeting) => {
    const status = effectiveMeetingStatus(meeting, nowMs);
    if (status === meeting.status) return meeting;
    return {
      ...meeting,
      status,
      ended_at: effectiveMeetingEndIso(meeting, nowMs),
    };
  });
  const active = normalized
    .filter((meeting) => meeting.status !== 'ended')
    .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
  const historyAll = normalized
    .filter((meeting) => meeting.status === 'ended')
    .sort((a, b) => (b.scheduled_at || b.started_at || '').localeCompare(a.scheduled_at || a.started_at || ''));
  return {
    active,
    history: historyAll.slice(0, historyLimit),
    historyTotal: historyAll.length,
  };
}
