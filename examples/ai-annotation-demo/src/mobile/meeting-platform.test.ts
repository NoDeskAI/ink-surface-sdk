import { describe, expect, it } from 'vitest';
import type { PersistedMeeting } from '../core/store-format';
import { findMeetingForProviderSource, meetingPlatformOf, meetingTranscriptSource } from './meeting-platform';

function meeting(id: string, patch: Partial<PersistedMeeting> = {}): PersistedMeeting {
  return {
    meeting_id: id,
    workspace_id: 'workspace-1',
    title: id,
    scheduled_at: '2026-07-14T10:00:00.000Z',
    status: 'upcoming',
    material_doc_ids: [],
    created_at: '2026-07-14T09:00:00.000Z',
    updated_at: '2026-07-14T09:00:00.000Z',
    ...patch,
  };
}

describe('meetingPlatformOf', () => {
  it('uses an explicit platform before legacy fields', () => {
    expect(meetingPlatformOf({ platform: 'google_meet', feishu_meeting_id: 'legacy-id' })).toBe('google_meet');
    expect(meetingPlatformOf({ platform: 'manual' })).toBe('manual');
  });

  it('infers lark from legacy feishu fields', () => {
    expect(meetingPlatformOf({ feishu_calendar_event_id: 'event-1' })).toBe('lark');
    expect(meetingPlatformOf({ feishu_minute_token: 'minute-1' })).toBe('lark');
    expect(meetingPlatformOf({ feishu_meeting_no: '' })).toBe('lark');
  });

  it('falls back to manual when no provider field exists', () => {
    expect(meetingPlatformOf({ meeting_id: 'meeting-1' })).toBe('manual');
  });

  it('derives the provider transcript source without changing lark semantics', () => {
    expect(meetingTranscriptSource({ feishu_minute_token: 'minute-1' })).toBe('lark_minute');
    expect(meetingTranscriptSource({ platform: 'google_meet' })).toBe('google_meet_transcript');
  });
});

describe('findMeetingForProviderSource', () => {
  it('does not merge equal calendar event ids across platforms', () => {
    const lark = meeting('lark-meeting', {
      platform: 'lark',
      feishu_calendar_event_id: 'shared-event',
    });
    const google = meeting('google-meeting', {
      platform: 'google_meet',
      provider_calendar_event_id: 'shared-event',
    });

    expect(findMeetingForProviderSource([lark], {
      platform: 'google_meet',
      calendarEventId: 'shared-event',
    })).toBeUndefined();
    expect(findMeetingForProviderSource([lark, google], {
      platform: 'google_meet',
      calendarEventId: 'shared-event',
    })).toBe(google);
  });

  it('preserves legacy lark matching without an explicit platform', () => {
    const byEvent = meeting('legacy-event', {
      feishu_calendar_event_id: 'event-1',
    });
    const byMeetingNo = meeting('legacy-number', {
      feishu_topic: 'Legacy Lark meeting',
      calendar_meeting_no: '123456789',
    });

    expect(findMeetingForProviderSource([byEvent], {
      platform: 'lark',
      calendarEventId: 'event-1',
    })).toBe(byEvent);
    expect(findMeetingForProviderSource([byMeetingNo], {
      platform: 'lark',
      meetingNo: '123456789',
      scheduledAt: '2026-07-14T11:00:00.000Z',
    })).toBe(byMeetingNo);
  });
});
