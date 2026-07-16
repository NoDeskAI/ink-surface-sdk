import { describe, expect, it } from 'vitest';
import type { PersistedMeeting } from '../core/store-format';
import {
  createMeetingKeyLock,
  findMeetingForProviderSource,
  meetingPlatformOf,
  meetingTranscriptSource,
  providerMeetingLockKey,
  providerTranscriptCacheToken,
  type MeetingPlatform,
} from './meeting-platform';

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

  it.each<[MeetingPlatform, string]>([
    ['lark', 'lark_minute'],
    ['google_meet', 'google_meet_transcript'],
    ['zoom', 'zoom_transcript'],
    ['microsoft_teams', 'microsoft_teams_transcript'],
    ['manual', 'manual_transcript'],
  ])('maps %s to its explicit transcript source', (platform, source) => {
    expect(meetingTranscriptSource({ platform })).toBe(source);
  });

  it('keeps legacy lark transcript inference', () => {
    expect(meetingTranscriptSource({ feishu_minute_token: 'minute-1' })).toBe('lark_minute');
  });
});

describe('providerTranscriptCacheToken', () => {
  it('locks existing lark/google keys and namespaces new providers', () => {
    expect(providerTranscriptCacheToken('lark', '7659677460199738340')).toBe('feishu_note_docx:7659677460199738340');
    expect(providerTranscriptCacheToken('google_meet', 'local-google-1')).toBe('google_meet:local-google-1');
    expect(providerTranscriptCacheToken('zoom', 'local-zoom-1')).toBe('zoom:local-zoom-1');
    expect(providerTranscriptCacheToken('microsoft_teams', 'local-teams-1')).toBe('microsoft_teams:local-teams-1');
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

  it('matches provider space before meeting id and normalized meeting URL', () => {
    const bySpace = meeting('zoom-space', {
      platform: 'zoom',
      provider_space_name: '987654321',
      provider_meeting_id: 'occurrence-other',
    });
    const byMeetingId = meeting('zoom-occurrence', {
      platform: 'zoom',
      provider_meeting_id: 'occurrence-1',
    });
    const byUrl = meeting('zoom-url', {
      platform: 'zoom',
      meeting_url: 'https://zoom.example.test/j/987654321/?pwd=secret&from=calendar',
    });

    expect(findMeetingForProviderSource([byMeetingId, bySpace], {
      platform: 'zoom',
      spaceName: '987654321',
      meetingId: 'occurrence-1',
    })).toBe(bySpace);
    expect(findMeetingForProviderSource([byUrl], {
      platform: 'zoom',
      meetingUrl: ' https://zoom.example.test/j/987654321?from=calendar&pwd=secret#join ',
    })).toBe(byUrl);
  });

  it('isolates equal provider ids across platforms', () => {
    const zoom = meeting('zoom-meeting', { platform: 'zoom', provider_meeting_id: 'shared-id' });
    const teams = meeting('teams-meeting', { platform: 'microsoft_teams', provider_meeting_id: 'shared-id' });

    expect(findMeetingForProviderSource([zoom, teams], {
      platform: 'microsoft_teams',
      meetingId: 'shared-id',
    })).toBe(teams);
  });

  it('does not read lark meeting-number fields for other providers', () => {
    const teams = meeting('teams-number', {
      platform: 'microsoft_teams',
      feishu_meeting_no: '123456789',
      calendar_meeting_no: '123456789',
    });

    expect(findMeetingForProviderSource([teams], {
      platform: 'microsoft_teams',
      meetingNo: '123456789',
    })).toBeUndefined();
  });

  it('falls back to the nearest meeting inside the scheduled time window', () => {
    const farther = meeting('farther', { platform: 'zoom', scheduled_at: '2026-07-14T12:00:00.000Z' });
    const nearer = meeting('nearer', { platform: 'zoom', scheduled_at: '2026-07-14T10:15:00.000Z' });

    expect(findMeetingForProviderSource([farther, nearer], {
      platform: 'zoom',
      scheduledAt: '2026-07-14T10:00:00.000Z',
    })).toBe(nearer);
    expect(findMeetingForProviderSource([nearer], {
      platform: 'zoom',
      scheduledAt: '2026-07-15T10:00:00.000Z',
    })).toBeUndefined();
  });
});

describe('provider meeting lock', () => {
  it('keeps panel/source lark routes mutually exclusive without blocking the same id on another platform', async () => {
    const withLock = createMeetingKeyLock();
    const panelKey = providerMeetingLockKey('lark', 'meeting-1');
    const sourceKey = providerMeetingLockKey('lark', 'meeting-1');
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sourceEntered = false;

    const panel = withLock(panelKey, async () => {
      markFirstEntered();
      await firstGate;
    });
    await firstEntered;
    const source = withLock(sourceKey, async () => { sourceEntered = true; });
    await withLock(providerMeetingLockKey('zoom', 'meeting-1'), async () => undefined);

    expect(sourceEntered).toBe(false);
    releaseFirst();
    await Promise.all([panel, source]);
    expect(sourceEntered).toBe(true);
  });
});
