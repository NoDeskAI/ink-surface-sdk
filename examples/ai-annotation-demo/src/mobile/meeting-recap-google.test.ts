import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  ensureGooglePanelSummary,
  googleSmartNoteCardState,
  isFeishuReloginError,
  loadGoogleTranscript,
  recapTranscriptMissingMessage,
  renderGoogleRecordingsHtml,
} from './meeting-recap';

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
  afterEach(() => vi.unstubAllGlobals());

  it('preserves provider missing semantics instead of leaving a loading label', () => {
    expect(recapTranscriptMissingMessage(googleMeeting({ provider_transcript_status: 'not_generated' })))
      .toContain('provider_transcript_status=not_generated');
    expect(recapTranscriptMissingMessage(googleMeeting({ provider_transcript_status: 'no_record' })))
      .toContain('provider_transcript_status=no_record');
    expect(recapTranscriptMissingMessage(googleMeeting({ provider_transcript_status: 'pending' })))
      .toContain('尚未生成');
    expect(recapTranscriptMissingMessage({
      platform: 'lark',
      feishu_meeting_id: 'om_1',
    })).toContain('未检测到妙记');
  });

  it('recognizes the production panel 409 reauth response', () => {
    expect(isFeishuReloginError({ status: 409, code: 'reauth_required' })).toBe(true);
    expect(isFeishuReloginError({ status: 502, message: 'upstream unavailable' })).toBe(false);
  });

  it('generates and persists a structured InkLoop panel summary through the hub', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'glm-test',
      summary: {
        conclusions: ['确认先发布会议恢复能力'],
        action_items: [{ task: '补充真机验证', owner: 'Ada' }],
        risks: [],
        open_questions: ['长转写分块何时上线'],
        next_steps: ['完成回归'],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const cues = [{
      index: 1,
      startMs: 1_000,
      endMs: 2_000,
      speaker: 'Ada',
      text: '确认先发布会议恢复能力，并补充真机验证。',
      rawText: 'Ada: 确认先发布会议恢复能力，并补充真机验证。',
    }, ...Array.from({ length: 200 }, (_, index) => ({
      index: index + 2,
      startMs: (index + 2) * 1_000,
      endMs: (index + 3) * 1_000,
      speaker: 'Grace',
      text: `长转写片段 ${index} ${'内容'.repeat(50)}`,
      rawText: `Grace: 长转写片段 ${index}`,
    }))];
    const summary = await ensureGooglePanelSummary(googleMeeting({
      google_smart_note: {
        text: 'Gemini notes say the recovery path should ship first.',
        fetched_at: '2026-07-15T02:10:00.000Z',
      },
    }), cues);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/google/meeting-summary');
    const request = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(request.transcript).toContain('[0:01]Ada：确认先发布会议恢复能力');
    expect(request.transcript).toContain('转写在此截断');
    expect(request.transcript.length).toBeLessThan(16_200);
    expect(request.smart_note).toBe('Gemini notes say the recovery path should ship first.');
    expect(summary).toMatchObject({
      minute_token: 'google_meet:local-google-1',
      meeting_id: 'abc-defg-hij',
      model: 'glm-test',
      summary: { conclusions: ['确认先发布会议恢复能力'] },
    });
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-google-1', expect.objectContaining({
      panel_summary: summary,
      panel_summary_status: 'ready',
    }));
  });

  it('shares the in-flight generation and does not resend when a summary already exists', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const cues = [{ index: 1, startMs: 0, endMs: 1_000, speaker: '', text: '讨论发布计划。', rawText: '讨论发布计划。' }];
    const meeting = googleMeeting();

    const first = ensureGooglePanelSummary(meeting, cues);
    const second = ensureGooglePanelSummary(meeting, cues);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(new Response(JSON.stringify({
      model: 'glm-test',
      summary: { conclusions: ['发布计划已讨论'], action_items: [], risks: [], open_questions: [], next_steps: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(mocks.updateMeeting).toHaveBeenCalledTimes(1);
    const cached = await ensureGooglePanelSummary(googleMeeting({ panel_summary: a! }), cues);
    expect(cached).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      smart_note: {
        text: 'Gemini overview\n\nDecision: ship recovery first.',
        export_uri: 'https://docs.google.com/document/d/note-1/edit',
      },
      recordings: [{ export_uri: 'https://drive.google.com/file/d/video-1/view', state: 'FILE_GENERATED' }],
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
      google_smart_note: expect.objectContaining({
        text: 'Gemini overview\n\nDecision: ship recovery first.',
        export_uri: 'https://docs.google.com/document/d/note-1/edit',
      }),
      google_recordings: [{ export_uri: 'https://drive.google.com/file/d/video-1/view', state: 'FILE_GENERATED' }],
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

  it('persists the Drive scope-missing state without requiring a transcript body', async () => {
    mocks.getGoogleMeetingTranscript.mockResolvedValue({
      status: 'pending',
      smart_note: {
        export_uri: 'https://docs.google.com/document/d/note-1/edit',
        scope_missing: true,
      },
    });
    const meeting = googleMeeting();

    await loadGoogleTranscript(meeting);

    expect(mocks.updateMeeting).toHaveBeenCalledWith(meeting.meeting_id, expect.objectContaining({
      provider_transcript_status: 'pending',
      google_smart_note_scope_missing: true,
    }));
    expect(meeting.google_smart_note).toBeUndefined();
  });

  it('models all smart-note card states and renders no recording markup for an empty list', () => {
    expect(googleSmartNoteCardState(googleMeeting({
      google_smart_note: { text: 'Synced', fetched_at: '2026-07-15T02:00:00.000Z' },
    }))).toEqual(expect.objectContaining({ meta: '已同步', disabled: false }));
    expect(googleSmartNoteCardState(googleMeeting({ google_smart_note_scope_missing: true }))).toEqual({
      meta: '需要授权',
      body: '需要重新授权 Google（新增 Drive 读取权限）',
      disabled: true,
    });
    expect(googleSmartNoteCardState(googleMeeting())).toEqual(expect.objectContaining({ meta: '未接入', disabled: true }));
    expect(renderGoogleRecordingsHtml(googleMeeting())).toBe('');
    expect(renderGoogleRecordingsHtml(googleMeeting({
      google_recordings: [{ export_uri: 'https://drive.google.com/file/d/video-1/view', state: 'FILE_GENERATED' }],
    }))).toContain('target="_blank" rel="noopener">在 Google Drive 查看</a>');
  });
});
