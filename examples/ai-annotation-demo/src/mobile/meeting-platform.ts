import type { PersistedMeeting } from '../core/store-format';

export type MeetingPlatform = NonNullable<PersistedMeeting['platform']>;

/** 兼容未写 platform 的存量会议；存在任一 feishu_* 字段即表示飞书来源。 */
export function meetingPlatformOf(meeting: Partial<PersistedMeeting>): MeetingPlatform {
  if (meeting.platform) return meeting.platform;
  const hasFeishuField = Object.keys(meeting).some((key) => key.startsWith('feishu_'));
  return hasFeishuField ? 'lark' : 'manual';
}

export function meetingTranscriptSource(meeting: Partial<PersistedMeeting>): string {
  const platform = meetingPlatformOf(meeting);
  if (platform === 'google_meet') return 'google_meet_transcript';
  return platform === 'lark' ? 'lark_minute' : 'manual_transcript';
}

export interface ProviderMeetingSourceKeys {
  platform: MeetingPlatform;
  calendarEventId?: string;
  meetingId?: string;
  meetingNo?: string;
  scheduledAt?: string;
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
  if (source.meetingId) {
    const byMeetingId = samePlatform.find((meeting) => {
      const meetingId = source.platform === 'lark'
        ? meeting.feishu_meeting_id
        : meeting.provider_meeting_id;
      return meetingId === source.meetingId;
    });
    if (byMeetingId) return byMeetingId;
  }
  if (!source.meetingNo) return undefined;
  const scheduledDay = source.scheduledAt?.slice(0, 10) ?? '';
  return samePlatform.find((meeting) => {
    if (meeting.feishu_meeting_no !== source.meetingNo && meeting.calendar_meeting_no !== source.meetingNo) return false;
    return !meeting.scheduled_at || !scheduledDay || meeting.scheduled_at.slice(0, 10) === scheduledDay;
  });
}
