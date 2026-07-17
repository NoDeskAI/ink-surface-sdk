import type { MeetingStatus, PersistedMeeting, PersistedWorkspace } from '../core/store-format';
import type { ZoomMeetingLiveWindow, ZoomMeetingSource } from '../integration/zoom/client';
import { findMeetingForProviderSource, meetingPlatformOf } from './meeting-platform';

export interface ZoomMeetingSyncDependencies {
  listAllMeetings: () => Promise<PersistedMeeting[]>;
  upsertScheduleWorkspace: () => Promise<PersistedWorkspace>;
  createMeeting: (workspaceId: string, input: { title: string; scheduled_at: string; status?: MeetingStatus }) => Promise<PersistedMeeting>;
  updateMeeting: (id: string, patch: Partial<PersistedMeeting>) => Promise<PersistedMeeting | null>;
  mutateMeeting: (id: string, mutator: (current: PersistedMeeting) => Partial<PersistedMeeting> | null) => Promise<PersistedMeeting | null>;
  nowMs?: number;
}

export interface ZoomMeetingSyncResult {
  imported: number;
  updated: number;
}

export interface ZoomMeetingLiveSyncResult {
  matched: number;
  updated: number;
}

function scheduledEndMs(source: Pick<ZoomMeetingSource, 'scheduled_at' | 'duration_minutes'>): number {
  const startMs = Date.parse(source.scheduled_at);
  const duration = Number(source.duration_minutes);
  return Number.isFinite(startMs) && Number.isFinite(duration) && duration > 0
    ? startMs + duration * 60_000
    : NaN;
}

function sourceStatus(source: ZoomMeetingSource, nowMs: number): MeetingStatus {
  const startMs = Date.parse(source.scheduled_at);
  const endMs = scheduledEndMs(source);
  if (Number.isFinite(endMs) && endMs <= nowMs) return 'ended';
  if (Number.isFinite(startMs) && startMs <= nowMs) return 'live';
  return 'upcoming';
}

/** updateMeeting 是 spread 合并，可选字段只在有值时才进 patch；
 * 显式 undefined 只保留给「改期清理」与「detector 误结束后重开卡」两个场景（沿用 google 版教训）。 */
export function zoomMeetingPatch(
  source: ZoomMeetingSource,
  nowMs = Date.now(),
  existing?: PersistedMeeting,
): Partial<PersistedMeeting> {
  const status = sourceStatus(source, nowMs);
  const endMs = scheduledEndMs(source);
  const rescheduled = status === 'upcoming' && !!existing
    && !!(existing.started_at || existing.ended_at || existing.vc_meeting_start_t0 || existing.t0_source || existing.align_state);
  return {
    platform: 'zoom',
    title: source.topic || 'Zoom',
    scheduled_at: source.scheduled_at,
    status,
    source_kind: 'calendar',
    provider_space_name: source.meeting_id,
    ...(source.topic ? { topic: source.topic } : {}),
    ...(Number.isFinite(source.duration_minutes) ? { duration: source.duration_minutes } : {}),
    ...(source.join_url ? { meeting_url: source.join_url } : {}),
    ...(status === 'live' && !existing?.started_at
      ? {
        started_at: source.scheduled_at,
        vc_meeting_start_t0: Date.parse(source.scheduled_at),
        t0_source: 'calendar',
        align_state: 'estimated',
      }
      : {}),
    ...(status === 'ended' && Number.isFinite(endMs) && !(existing && hasStrongerZoomAnchor(existing) && existing.ended_at)
      ? { ended_at: new Date(endMs).toISOString() }
      : {}),
    ...(rescheduled
      ? {
        started_at: undefined,
        ended_at: undefined,
        provider_meeting_id: undefined,
        provider_transcript_ref: undefined,
        provider_transcript_status: undefined,
        provider_transcript_reason: undefined,
        vc_meeting_start_t0: undefined,
        t0_source: undefined,
        align_offset_ms: undefined,
        align_state: undefined,
        summary: undefined,
        summary_generated_at: undefined,
        summary_source: undefined,
        panel_summary: undefined,
        panel_summary_fetched_at: undefined,
        panel_summary_status: undefined,
        panel_summary_unread: undefined,
        exported_at: undefined,
      }
      : {}),
  };
}

export async function syncZoomMeetingSources(
  sources: ZoomMeetingSource[],
  dependencies: ZoomMeetingSyncDependencies,
): Promise<ZoomMeetingSyncResult> {
  const result: ZoomMeetingSyncResult = { imported: 0, updated: 0 };
  const usableSources = sources.filter((source) => (
    source.platform === 'zoom'
    && !!source.meeting_id
    && !!source.join_url
    && Number.isFinite(Date.parse(source.scheduled_at))
  ));
  if (!usableSources.length) return result;
  let meetings = await dependencies.listAllMeetings();
  let workspace: PersistedWorkspace | undefined;
  const nowMs = dependencies.nowMs ?? Date.now();

  for (const source of usableSources) {
    const existing = findMeetingForProviderSource(meetings, {
      platform: 'zoom',
      spaceName: source.meeting_id,
      meetingUrl: source.join_url,
      scheduledAt: source.scheduled_at,
    });
    if (source.missing_since) continue;
    const patch = zoomMeetingPatch(source, nowMs, existing);
    if (existing) {
      await dependencies.updateMeeting(existing.meeting_id, patch);
      meetings = meetings.map((meeting) => meeting.meeting_id === existing.meeting_id
        ? { ...meeting, ...patch, updated_at: new Date(nowMs).toISOString() } as PersistedMeeting
        : meeting);
      result.updated += 1;
      continue;
    }
    workspace ||= await dependencies.upsertScheduleWorkspace();
    const created = await dependencies.createMeeting(workspace.workspace_id, {
      title: source.topic || 'Zoom',
      scheduled_at: source.scheduled_at,
      status: patch.status || 'upcoming',
    });
    await dependencies.updateMeeting(created.meeting_id, patch);
    meetings = [...meetings, { ...created, ...patch, updated_at: new Date(nowMs).toISOString() } as PersistedMeeting];
    result.imported += 1;
  }
  return result;
}

function normalizeZoomMeetingId(value: unknown): string {
  const input = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return /^\d+$/.test(input) ? input : '';
}

export function zoomMeetingIdFromUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'zoom.us' && !hostname.endsWith('.zoom.us')) return '';
    return normalizeZoomMeetingId(url.pathname.match(/^\/j\/(\d+)(?:\/|$)/)?.[1]);
  } catch {
    return '';
  }
}

function canonicalZoomJoinUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return value.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function findMeetingForZoomWindow(
  meetings: PersistedMeeting[],
  window: ZoomMeetingLiveWindow,
): PersistedMeeting | undefined {
  const numericId = normalizeZoomMeetingId(window.meeting_id)
    || normalizeZoomMeetingId(window.external_meeting_id)
    || zoomMeetingIdFromUrl(window.meeting_url);
  if (numericId) {
    const byMeetingId = findMeetingForProviderSource(meetings, { platform: 'zoom', spaceName: numericId });
    if (byMeetingId) return byMeetingId;
  }
  const canonicalUrl = canonicalZoomJoinUrl(window.meeting_url);
  if (canonicalUrl) {
    const byUrl = meetings.find((meeting) => (
      meetingPlatformOf(meeting) === 'zoom'
      && canonicalZoomJoinUrl(meeting.meeting_url) === canonicalUrl
    ));
    if (byUrl) return byUrl;
  }
  return findMeetingForProviderSource(meetings, {
    platform: 'zoom',
    scheduledAt: new Date(window.started_at_ms).toISOString(),
  });
}

function hasStrongerZoomAnchor(meeting: PersistedMeeting): boolean {
  return meeting.t0_source === 'provider_event' || meeting.t0_source === 'recording_event';
}

/** MTL detector 窗口只允许更新已有 Zoom 日程卡，绝不新建卡（未匹配即忽略）。 */
export async function syncZoomMeetingLiveState(
  windows: ZoomMeetingLiveWindow[],
  dependencies: Pick<ZoomMeetingSyncDependencies, 'listAllMeetings' | 'mutateMeeting'>,
): Promise<ZoomMeetingLiveSyncResult> {
  const result: ZoomMeetingLiveSyncResult = { matched: 0, updated: 0 };
  if (!windows.length) return result;
  let meetings = await dependencies.listAllMeetings();
  const ordered = [...windows].sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at));
  for (const window of ordered) {
    if (window.platform !== 'zoom' || !Number.isFinite(window.started_at_ms)) continue;
    const existing = findMeetingForZoomWindow(meetings, window);
    if (!existing) continue;
    result.matched += 1;
    const updated = await dependencies.mutateMeeting(existing.meeting_id, (current) => {
      const strongerAnchor = hasStrongerZoomAnchor(current);
      return window.ended_at_ms
        ? {
          status: 'ended',
          ...(!(strongerAnchor && current.ended_at) ? { ended_at: new Date(window.ended_at_ms).toISOString() } : {}),
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
    });
    if (!updated) continue;
    meetings = meetings.map((meeting) => meeting.meeting_id === updated.meeting_id ? updated : meeting);
    result.updated += 1;
  }
  return result;
}
