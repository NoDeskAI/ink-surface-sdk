import type { PersistedMeeting } from '../core/store-format';

export type MeetingPlatform = NonNullable<PersistedMeeting['platform']>;
export type MeetingTranscriptSource =
  | 'lark_minute'
  | 'google_meet_transcript'
  | 'zoom_transcript'
  | 'microsoft_teams_transcript'
  | 'manual_transcript';

const MEETING_TRANSCRIPT_SOURCES: Record<MeetingPlatform, MeetingTranscriptSource> = {
  lark: 'lark_minute',
  google_meet: 'google_meet_transcript',
  zoom: 'zoom_transcript',
  microsoft_teams: 'microsoft_teams_transcript',
  manual: 'manual_transcript',
};

const TRANSCRIPT_CACHE_PREFIXES: Record<MeetingPlatform, string> = {
  lark: 'feishu_note_docx',
  google_meet: 'google_meet',
  zoom: 'zoom',
  microsoft_teams: 'microsoft_teams',
  manual: 'manual',
};

const PROVIDER_SCHEDULE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 兼容未写 platform 的存量会议；存在任一 feishu_* 字段即表示飞书来源。 */
export function meetingPlatformOf(meeting: Partial<PersistedMeeting>): MeetingPlatform {
  if (meeting.platform) return meeting.platform;
  const hasFeishuField = Object.keys(meeting).some((key) => key.startsWith('feishu_'));
  return hasFeishuField ? 'lark' : 'manual';
}

export function meetingTranscriptSource(meeting: Partial<PersistedMeeting>): MeetingTranscriptSource {
  return MEETING_TRANSCRIPT_SOURCES[meetingPlatformOf(meeting)];
}

/** 飞书妙记 token 仍直接作为主缓存键；此函数命名其 note/docx 兜底缓存及其它平台缓存。 */
export function providerTranscriptCacheToken(platform: MeetingPlatform, localMeetingId: string): string {
  return `${TRANSCRIPT_CACHE_PREFIXES[platform]}:${localMeetingId}`;
}

export function providerMeetingLockKey(platform: MeetingPlatform, id: string): string {
  return `${platform}:${id}`;
}

export type MeetingKeyLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createMeetingKeyLock(): MeetingKeyLock {
  const locks = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const job = prev.catch(() => {}).then(fn);
    const tail = job.then(() => undefined, () => undefined);
    locks.set(key, tail);
    void tail.finally(() => { if (locks.get(key) === tail) locks.delete(key); });
    return job;
  };
}

export interface ProviderMeetingSourceKeys {
  platform: MeetingPlatform;
  calendarEventId?: string;
  spaceName?: string;
  meetingId?: string;
  meetingUrl?: string;
  meetingNo?: string;
  scheduledAt?: string;
}

function normalizedMeetingUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

/** 按平台命名空间匹配 provider 键，避免不同平台复用相同 id 时串卡。 */
export function findMeetingForProviderSource(
  meetings: PersistedMeeting[],
  source: ProviderMeetingSourceKeys,
): PersistedMeeting | undefined {
  const samePlatform = meetings.filter((meeting) => meetingPlatformOf(meeting) === source.platform);
  if (source.calendarEventId) {
    const byCalendarEvent = samePlatform.find((meeting) => {
      const eventId = source.platform === 'lark'
        ? meeting.feishu_calendar_event_id
        : meeting.provider_calendar_event_id;
      return eventId === source.calendarEventId;
    });
    if (byCalendarEvent) return byCalendarEvent;
  }
  if (source.spaceName) {
    const bySpaceName = samePlatform.find((meeting) => meeting.provider_space_name === source.spaceName);
    if (bySpaceName) return bySpaceName;
  }
  if (source.meetingId) {
    const byMeetingId = samePlatform.find((meeting) => {
      const meetingId = source.platform === 'lark'
        ? meeting.feishu_meeting_id
        : meeting.provider_meeting_id;
      return meetingId === source.meetingId;
    });
    if (byMeetingId) return byMeetingId;
  }
  const sourceUrl = normalizedMeetingUrl(source.meetingUrl);
  if (sourceUrl) {
    const byMeetingUrl = samePlatform.find((meeting) => normalizedMeetingUrl(meeting.meeting_url) === sourceUrl);
    if (byMeetingUrl) return byMeetingUrl;
  }
  if (source.meetingNo && (source.platform === 'lark' || source.platform === 'google_meet')) {
    const scheduledDay = source.scheduledAt?.slice(0, 10) ?? '';
    const byMeetingNo = samePlatform.find((meeting) => {
      if (meeting.feishu_meeting_no !== source.meetingNo && meeting.calendar_meeting_no !== source.meetingNo) return false;
      return !meeting.scheduled_at || !scheduledDay || meeting.scheduled_at.slice(0, 10) === scheduledDay;
    });
    if (byMeetingNo) return byMeetingNo;
  }
  const hasApplicableMeetingNo = !!source.meetingNo && (source.platform === 'lark' || source.platform === 'google_meet');
  // 强标识存在但未命中时不能降级按时间合并；Google detector 等调用依赖“不匹配即忽略”。
  if (source.calendarEventId || source.spaceName || source.meetingId || sourceUrl || hasApplicableMeetingNo) return undefined;
  const scheduledAtMs = source.scheduledAt ? Date.parse(source.scheduledAt) : NaN;
  if (!Number.isFinite(scheduledAtMs)) return undefined;
  return samePlatform
    .map((meeting) => ({ meeting, distance: Math.abs(Date.parse(meeting.scheduled_at) - scheduledAtMs) }))
    .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= PROVIDER_SCHEDULE_WINDOW_MS)
    .sort((left, right) => left.distance - right.distance)[0]?.meeting;
}
