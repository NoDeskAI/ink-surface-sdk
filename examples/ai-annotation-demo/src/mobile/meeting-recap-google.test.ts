import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedMeeting } from '../core/store-format';

const mocks = vi.hoisted(() => ({
  getCachedMinute: vi.fn(),
  putCachedMinute: vi.fn(),
  updateMeeting: vi.fn(),
  getGoogleMeetingTranscript: vi.fn(),
}));

vi.mock('../local/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local/store')>(),
  getCachedMinute: mocks.getCachedMinute,
  putCachedMinute: mocks.putCachedMinute,
  updateMeeting: mocks.updateMeeting,
}));

vi.mock('../integration/google-meet/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../integration/google-meet/client')>(),
  getGoogleMeetingTranscript: mocks.getGoogleMeetingTranscript,
}));

import { loadGoogleTranscript } from './meeting-recap';

function googleMeeting(patch: Partial<PersistedMeeting> = {}): PersistedMeeting {
  return {
    meeting_id: 'local-google-1',
    workspace_id: 'ws_schedule',
    title: 'Google review',
    platform: 'google_meet',
    calendar_meeting_no: 'abc-defg-hij',
    scheduled_at: '2026-07-15T01:00:00.000Z',
    status: 'ended',
    material_doc_ids: [],
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    ...patch,
  };
}

describe('meeting recap Google transcript branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCachedMinute.mockResolvedValue(null);
    mocks.putCachedMinute.mockResolvedValue(undefined);
    mocks.updateMeeting.mockResolvedValue(null);
  });

  it('caches ready SRT and patches provider-event t0 without undefined fields', async () => {
    mocks.getGoogleMeetingTranscript.mockResolvedValue({
      status: 'ready',
      record: {
        name: 'conferenceRecords/record-1',
        start_time: '2026-07-15T01:02:03.000Z',
        end_time: '2026-07-15T02:04:05.000Z',
      },
      transcript: {
        name: 'conferenceRecords/record-1/transcripts/transcript-1',
        lines: [],
        srt: '1\n00:00:01,000 --> 00:00:02,000\nAda: Hello',
      },
    });
    const meeting = googleMeeting();

    const loaded = await loadGoogleTranscript(meeting);

    const startMs = Date.parse('2026-07-15T01:02:03.000Z');
    expect(loaded).toMatchObject({ sourceToken: 'google_meet:local-google-1', cues: [{ speaker: 'Ada', text: 'Hello' }] });
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-google-1', expect.objectContaining({
      provider_meeting_id: 'conferenceRecords/record-1',
      provider_transcript_ref: 'conferenceRecords/record-1/transcripts/transcript-1',
      provider_transcript_status: 'ready',
      vc_meeting_start_t0: startMs,
      t0_source: 'provider_event',
      align_state: 'event',
      started_at: '2026-07-15T01:02:03.000Z',
      ended_at: '2026-07-15T02:04:05.000Z',
    }));
    const patch = mocks.updateMeeting.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.values(patch)).not.toContain(undefined);
    expect(mocks.putCachedMinute).toHaveBeenCalledWith(expect.objectContaining({
      minute_token: 'google_meet:local-google-1',
      meeting_id: 'local-google-1',
      duration_ms: Date.parse('2026-07-15T02:04:05.000Z') - startMs,
    }));
  });

  it('returns cached SRT while the provider is pending', async () => {
    const cachedSrt = '1\n00:00:03,000 --> 00:00:04,000\nGrace: Cached line';
    mocks.getCachedMinute.mockResolvedValue({
      minute_token: 'google_meet:local-google-1',
      srt: cachedSrt,
      fetched_at: '2026-07-15T03:00:00.000Z',
    });
    mocks.getGoogleMeetingTranscript.mockResolvedValue({ status: 'pending', next_check_at: '2026-07-15T03:05:00.000Z' });

    const loaded = await loadGoogleTranscript(googleMeeting());

    expect(loaded).toMatchObject({ sourceToken: 'google_meet:local-google-1', cues: [{ speaker: 'Grace', text: 'Cached line' }] });
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-google-1', { provider_transcript_status: 'pending' });
    expect(mocks.putCachedMinute).not.toHaveBeenCalled();
  });
});
