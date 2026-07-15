import type { MeetingStatus, PersistedMeeting, PersistedWorkspace } from '../core/store-format';
import type { GoogleMeetingLiveWindow, GoogleMeetingSource } from '../integration/google-meet/client';
import { findMeetingForProviderSource } from './meeting-platform';

export interface GoogleMeetingSyncDependencies {
  listAllMeetings: () => Promise<PersistedMeeting[]>;
  upsertScheduleWorkspace: () => Promise<PersistedWorkspace>;
  createMeeting: (workspaceId: string, input: { title: string; scheduled_at: string; status?: MeetingStatus }) => Promise<PersistedMeeting>;
  updateMeeting: (id: string, patch: Partial<PersistedMeeting>) => Promise<PersistedMeeting | null>;
  nowMs?: number;
}

export interface GoogleMeetingSyncResult {
  imported: number;
  updated: number;
  cancelled: number;
}

export interface GoogleMeetingLiveSyncResult {
  matched: number;
  updated: number;
}

function sourceStatus(source: GoogleMeetingSource, nowMs: number): MeetingStatus {
  if (source.status === 'cancelled') return 'ended';
  const startMs = Date.parse(source.scheduled_at);
  const endMs = Date.parse(source.scheduled_end_at || '');
  if (Number.isFinite(endMs) && endMs <= nowMs) return 'ended';
  if (Number.isFinite(startMs) && startMs <= nowMs) return 'live';
  return 'upcoming';
}

/** 生成 updateMeeting 用的 patch。updateMeeting 是 {...cur,...patch} 合并，patch 里显式 undefined 会抹掉已有值，
 *  所以时间字段一律条件展开（对齐 syncCalendarMeetings 的飞书日历语义）；唯一例外是改期清理（见下）。 */
export function googleMeetingPatch(
  source: GoogleMeetingSource,
  nowMs = Date.now(),
  existing?: PersistedMeeting,
): Partial<PersistedMeeting> {
  const status = sourceStatus(source, nowMs);
  const endedAt = status === 'ended'
    ? source.scheduled_end_at || (source.status === 'cancelled' ? source.scheduled_at : undefined)
    : undefined;
  // 已结束/开过的场次被改期回 upcoming：必须清掉过时时间字段，否则 effectiveMeetingStatus 因旧 ended_at 恒判 ended。
  const rescheduled = status === 'upcoming' && !!existing
    && !!(existing.started_at || existing.ended_at || existing.vc_meeting_start_t0 || existing.t0_source || existing.align_state);
  return {
    platform: 'google_meet',
    title: source.title || 'Google Meet',
    scheduled_at: source.scheduled_at,
    status,
    source_kind: 'calendar',
    provider_calendar_event_id: source.calendar_event_id,
    ...(source.meeting_url ? { meeting_url: source.meeting_url } : {}),
    // Calendar meetingCode is an entry code, not a conferenceRecord instance id. P2 will fill provider_meeting_id.
    ...(source.meeting_code ? { calendar_meeting_no: source.meeting_code } : {}),
    ...(status === 'live' && !existing?.started_at
      ? { started_at: source.scheduled_at, vc_meeting_start_t0: Date.parse(source.scheduled_at), t0_source: 'calendar', align_state: 'estimated' }
      : {}),
    ...(status === 'ended' && endedAt ? { ended_at: endedAt } : {}),
    ...(rescheduled
      ? { started_at: undefined, ended_at: undefined, vc_meeting_start_t0: undefined, t0_source: undefined, align_state: undefined }
      : {}),
  };
}

export async function syncGoogleMeetingSources(
  sources: GoogleMeetingSource[],
  dependencies: GoogleMeetingSyncDependencies,
): Promise<GoogleMeetingSyncResult> {
  const result: GoogleMeetingSyncResult = { imported: 0, updated: 0, cancelled: 0 };
  if (!sources.length) return result;
  const workspace = await dependencies.upsertScheduleWorkspace();
  let meetings = await dependencies.listAllMeetings();
  const nowMs = dependencies.nowMs ?? Date.now();

  for (const source of sources.filter((item) => item.platform === 'google_meet' && item.calendar_event_id && item.scheduled_at)) {
    const existing = findMeetingForProviderSource(meetings, {
      platform: 'google_meet',
      calendarEventId: source.calendar_event_id,
    });
    if (source.status === 'cancelled' && !existing) continue;
    const patch = googleMeetingPatch(source, nowMs, existing);
    if (existing) {
      await dependencies.updateMeeting(existing.meeting_id, patch);
      meetings = meetings.map((meeting) => meeting.meeting_id === existing.meeting_id
        ? { ...meeting, ...patch, updated_at: new Date(nowMs).toISOString() } as PersistedMeeting
        : meeting);
      result.updated += 1;
      if (source.status === 'cancelled') result.cancelled += 1;
      continue;
    }
    const created = await dependencies.createMeeting(workspace.workspace_id, {
      title: source.title || 'Google Meet',
      scheduled_at: source.scheduled_at,
      status: patch.status || 'upcoming',
    });
    await dependencies.updateMeeting(created.meeting_id, patch);
    meetings = [...meetings, { ...created, ...patch, updated_at: new Date(nowMs).toISOString() } as PersistedMeeting];
    result.imported += 1;
  }
  return result;
}

function hasStrongerGoogleAnchor(meeting: PersistedMeeting): boolean {
  return meeting.t0_source === 'provider_event' || meeting.t0_source === 'recording_event';
}

/** Merge MTL detector windows only into Calendar-created Google cards. Unknown windows remain
 * server-side diagnostics and never manufacture or overwrite an unrelated local meeting. */
export async function syncGoogleMeetingLiveState(
  windows: GoogleMeetingLiveWindow[],
  dependencies: Pick<GoogleMeetingSyncDependencies, 'listAllMeetings' | 'updateMeeting'>,
): Promise<GoogleMeetingLiveSyncResult> {
  const result: GoogleMeetingLiveSyncResult = { matched: 0, updated: 0 };
  if (!windows.length) return result;
  let meetings = await dependencies.listAllMeetings();
  const ordered = [...windows].sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at));
  for (const window of ordered) {
    if (window.platform !== 'google_meet' || !window.meeting_code || !Number.isFinite(window.started_at_ms)) continue;
    const existing = findMeetingForProviderSource(meetings, {
      platform: 'google_meet',
      meetingNo: window.meeting_code,
      scheduledAt: new Date(window.started_at_ms).toISOString(),
    });
    if (!existing) continue;
    result.matched += 1;
    const strongerAnchor = hasStrongerGoogleAnchor(existing);
    const patch: Partial<PersistedMeeting> = window.ended_at_ms
      ? {
        status: 'ended',
        ended_at: strongerAnchor && existing.ended_at
          ? existing.ended_at
          : new Date(window.ended_at_ms).toISOString(),
      }
      : {
        status: 'live',
        ended_at: undefined,
        ...(!strongerAnchor ? {
          started_at: new Date(window.started_at_ms).toISOString(),
          vc_meeting_start_t0: window.started_at_ms,
          t0_source: 'local_detector' as const,
          align_state: 'estimated' as const,
        } : {}),
      };
    await dependencies.updateMeeting(existing.meeting_id, patch);
    meetings = meetings.map((meeting) => meeting.meeting_id === existing.meeting_id
      ? { ...meeting, ...patch }
      : meeting);
    result.updated += 1;
  }
  return result;
}
