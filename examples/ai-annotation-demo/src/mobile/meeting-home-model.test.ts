import { describe, expect, it } from 'vitest';
import type { PersistedMeeting } from '../core/store-format';
import { effectiveMeetingEndIso, effectiveMeetingStatus, filterMeetingsByPlatform, MEETING_PROVIDER_LEAD_OPTIONS, meetingHomeBuckets, normalizeMeetingHomeFilter } from './meeting-home-model';

function meeting(id: string, status: PersistedMeeting['status'], scheduledAt: string, startedAt?: string): PersistedMeeting {
  return {
    meeting_id: id,
    workspace_id: 'ws_1',
    title: id,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    status,
    material_doc_ids: [],
    material_links: [],
    created_at: scheduledAt,
    updated_at: scheduledAt,
  };
}

describe('meeting home model', () => {
  it('keeps active meetings ascending and history descending', () => {
    const buckets = meetingHomeBuckets([
      meeting('ended-old', 'ended', '2026-07-01T10:00:00.000Z'),
      meeting('upcoming-late', 'upcoming', '2026-07-10T10:00:00.000Z'),
      meeting('live-now', 'live', '2026-07-08T10:00:00.000Z'),
      meeting('ended-new', 'ended', '2026-07-07T15:00:00.000Z'),
    ], { nowMs: Date.parse('2026-07-08T11:00:00.000Z') });

    expect(buckets.active.map((item) => item.meeting_id)).toEqual(['live-now', 'upcoming-late']);
    expect(buckets.history.map((item) => item.meeting_id)).toEqual(['ended-new', 'ended-old']);
    expect(buckets.historyTotal).toBe(2);
  });

  it('limits visible history without losing the total count', () => {
    const meetings = Array.from({ length: 24 }, (_, index) =>
      meeting(`ended-${index}`, 'ended', `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    const buckets = meetingHomeBuckets(meetings, { historyLimit: 20 });

    expect(buckets.history).toHaveLength(20);
    expect(buckets.historyTotal).toBe(24);
    expect(buckets.history[0].meeting_id).toBe('ended-23');
  });

  it('normalizes unknown filter values to active', () => {
    expect(normalizeMeetingHomeFilter('history')).toBe('history');
    expect(normalizeMeetingHomeFilter('all')).toBe('active');
    expect(normalizeMeetingHomeFilter(null)).toBe('active');
  });

  it('moves stale live meetings into history with a deterministic fallback end time', () => {
    const stale = meeting('weekly', 'live', '2026-07-07T07:00:00.000Z', '2026-07-07T07:01:00.000Z');
    const buckets = meetingHomeBuckets([stale], { nowMs: Date.parse('2026-07-08T07:00:00.000Z') });

    expect(effectiveMeetingStatus(stale, Date.parse('2026-07-08T07:00:00.000Z'))).toBe('ended');
    expect(effectiveMeetingEndIso(stale, Date.parse('2026-07-08T07:00:00.000Z'))).toBe('2026-07-07T08:01:00.000Z');
    expect(buckets.active).toEqual([]);
    expect(buckets.history[0]).toMatchObject({ meeting_id: 'weekly', status: 'ended', ended_at: '2026-07-07T08:01:00.000Z' });
  });

  it('promotes an upcoming calendar meeting to live after its scheduled start', () => {
    const current = {
      ...meeting('weekly', 'upcoming', '2026-07-09T07:00:00.000Z'),
      ended_at: '2026-07-09T08:00:00.000Z',
    };
    const buckets = meetingHomeBuckets([current], { nowMs: Date.parse('2026-07-09T07:14:00.000Z') });

    expect(effectiveMeetingStatus(current, Date.parse('2026-07-09T07:14:00.000Z'))).toBe('live');
    expect(buckets.active[0]).toMatchObject({ meeting_id: 'weekly', status: 'live' });
    expect(buckets.history).toEqual([]);
  });

  it('filters provider meetings before applying active/history buckets', () => {
    const lark = { ...meeting('lark', 'upcoming', '2026-07-09T07:00:00.000Z'), platform: 'lark' as const };
    const google = { ...meeting('google', 'ended', '2026-07-08T07:00:00.000Z'), platform: 'google_meet' as const };
    const zoom = { ...meeting('zoom', 'upcoming', '2026-07-09T08:00:00.000Z'), platform: 'zoom' as const };
    const manual = meeting('manual', 'live', '2026-07-09T07:00:00.000Z');

    expect(filterMeetingsByPlatform([lark, google, zoom, manual], 'lark').map((item) => item.meeting_id)).toEqual(['lark']);
    expect(filterMeetingsByPlatform([lark, google, zoom, manual], 'google_meet').map((item) => item.meeting_id)).toEqual(['google']);
    expect(filterMeetingsByPlatform([lark, google, zoom, manual], 'zoom').map((item) => item.meeting_id)).toEqual(['zoom']);
    expect(filterMeetingsByPlatform([lark, google, zoom, manual], 'manual').map((item) => item.meeting_id)).toEqual(['manual']);
    expect(meetingHomeBuckets([lark, zoom, manual], { nowMs: Date.parse('2026-07-09T06:00:00.000Z') }).active
      .map((item) => item.meeting_id)).toEqual(['lark', 'manual', 'zoom']);
  });

  it('sorts Lark, Google, and Zoom meetings in one schedule without changing platform identity', () => {
    const lark = { ...meeting('lark-late', 'upcoming', '2026-07-09T09:00:00.000Z'), platform: 'lark' as const };
    const google = { ...meeting('google-live', 'live', '2026-07-09T08:00:00.000Z'), platform: 'google_meet' as const };
    const zoom = { ...meeting('zoom-middle', 'upcoming', '2026-07-09T08:30:00.000Z'), platform: 'zoom' as const };

    const buckets = meetingHomeBuckets([lark, google, zoom], { nowMs: Date.parse('2026-07-09T07:00:00.000Z') });

    expect(buckets.active.map((item) => [item.meeting_id, item.platform])).toEqual([
      ['google-live', 'google_meet'],
      ['zoom-middle', 'zoom'],
      ['lark-late', 'lark'],
    ]);
  });

  it('keeps the provider lead order stable with Zoom enabled and Teams hidden', () => {
    expect(MEETING_PROVIDER_LEAD_OPTIONS).toEqual(['lark', 'google_meet', 'zoom', 'manual']);
    expect(MEETING_PROVIDER_LEAD_OPTIONS).not.toContain('microsoft_teams');
  });
});
