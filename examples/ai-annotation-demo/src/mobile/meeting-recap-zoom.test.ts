import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedMeeting } from '../core/store-format';

const mocks = vi.hoisted(() => ({
  getCachedMinute: vi.fn(),
  putCachedMinute: vi.fn(),
  updateMeeting: vi.fn(),
  fetchZoomMeetingTranscript: vi.fn(),
}));

vi.mock('../local/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local/store')>(),
  getCachedMinute: mocks.getCachedMinute,
  putCachedMinute: mocks.putCachedMinute,
  updateMeeting: mocks.updateMeeting,
}));

vi.mock('../integration/zoom/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../integration/zoom/client')>(),
  fetchZoomMeetingTranscript: mocks.fetchZoomMeetingTranscript,
}));

import {
  ensureProviderPanelSummary,
  loadZoomTranscript,
  meetingSummaryTranscriptCacheToken,
  recapTranscriptMissingMessage,
  recapTranscriptPageDescription,
  recapTranscriptRetryLabel,
  recapTranscriptSpeakerLabel,
  renderRecapCard,
  zoomTranscriptAlignmentLabel,
} from './meeting-recap';

function zoomMeeting(patch: Partial<PersistedMeeting> = {}): PersistedMeeting {
  return {
    meeting_id: 'local-zoom-1',
    workspace_id: 'ws_schedule',
    title: 'Zoom review',
    platform: 'zoom',
    provider_space_name: '987654321',
    scheduled_at: '2026-07-18T01:00:00.000Z',
    status: 'ended',
    material_doc_ids: [],
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
    ...patch,
  };
}

describe('meeting recap Zoom transcript branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCachedMinute.mockResolvedValue(null);
    mocks.putCachedMinute.mockResolvedValue(undefined);
    mocks.updateMeeting.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the minute cache before the network request and falls back to it while pending', async () => {
    const order: string[] = [];
    const cachedSrt = '1\n00:00:03,000 --> 00:00:04,000\nGrace: Cached line';
    mocks.getCachedMinute.mockImplementation(async () => {
      order.push('cache');
      return { minute_token: 'zoom:local-zoom-1', srt: cachedSrt, fetched_at: '2026-07-18T03:00:00.000Z' };
    });
    mocks.fetchZoomMeetingTranscript.mockImplementation(async () => {
      order.push('network');
      return { status: 'pending', participants: [], next_check_at: '2026-07-18T03:05:00.000Z' };
    });

    const loaded = await loadZoomTranscript(zoomMeeting());

    expect(order).toEqual(['cache', 'network']);
    expect(loaded).toMatchObject({ sourceToken: 'zoom:local-zoom-1', cues: [{ speaker: 'Grace', text: 'Cached line' }] });
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-zoom-1', { provider_transcript_status: 'pending' });
    expect(mocks.putCachedMinute).not.toHaveBeenCalled();
  });

  it('caches ready SRT and writes the complete actual-session anchor without undefined fields', async () => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({
      status: 'ready',
      participants: [{ display_name: 'Ada', identity_quality: 'signed_in' }],
      instance_uuid: '/zoom-instance-1',
      t0: '2026-07-18T01:02:00.000Z',
      started_at: '2026-07-18T01:02:00.000Z',
      ended_at: '2026-07-18T01:47:00.000Z',
      timestamp_quality: 'approximate_pause_unknown',
      transcript: {
        name: 'past_meetings/%2Fzoom-instance-1/transcripts',
        lines: [],
        srt: '1\n00:00:01,000 --> 00:00:02,000\nAda: Ship it\n\n2\n00:00:03,000 --> 00:00:04,000\nNo label',
        timestamp_quality: 'approximate_pause_unknown',
      },
    });
    const meeting = zoomMeeting({
      started_at: '2026-07-18T01:03:00.000Z',
      ended_at: '2026-07-18T01:45:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:03:00.000Z'),
      t0_source: 'local_detector',
      align_state: 'estimated',
    });

    const loaded = await loadZoomTranscript(meeting);

    const startMs = Date.parse('2026-07-18T01:02:00.000Z');
    expect(loaded).toMatchObject({
      sourceToken: 'zoom:local-zoom-1',
      timestampQuality: 'approximate_pause_unknown',
      cues: [{ speaker: 'Ada', text: 'Ship it' }, { text: 'No label' }],
    });
    expect(mocks.fetchZoomMeetingTranscript).toHaveBeenCalledWith('987654321', '2026-07-18T01:00:00.000Z');
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-zoom-1', {
      provider_transcript_status: 'ready',
      provider_meeting_id: '/zoom-instance-1',
      provider_transcript_ref: 'past_meetings/%2Fzoom-instance-1/transcripts',
      vc_meeting_start_t0: startMs,
      t0_source: 'provider_event',
      align_state: 'event',
      started_at: '2026-07-18T01:02:00.000Z',
      ended_at: '2026-07-18T01:47:00.000Z',
    });
    const patch = mocks.updateMeeting.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.values(patch)).not.toContain(undefined);
    expect(mocks.putCachedMinute).toHaveBeenCalledWith(expect.objectContaining({
      minute_token: 'zoom:local-zoom-1',
      meeting_id: 'local-zoom-1',
      duration_ms: 45 * 60_000,
    }));
  });

  it.each(['provider_event', 'recording_event'] as const)('does not regress an existing %s stronger anchor', async (t0Source) => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({
      status: 'ready',
      participants: [],
      instance_uuid: '/zoom-instance-1',
      t0: '2026-07-18T01:01:00.000Z',
      started_at: '2026-07-18T01:01:00.000Z',
      ended_at: '2026-07-18T01:50:00.000Z',
      transcript: {
        name: 'past_meetings/%2Fzoom-instance-1/transcripts',
        lines: [],
        srt: '1\n00:00:01,000 --> 00:00:02,000\nAda: Ready',
        timestamp_quality: 'derived_no_pause',
      },
    });
    const meeting = zoomMeeting({
      provider_transcript_status: 'pending',
      provider_meeting_id: '/zoom-instance-1',
      provider_transcript_ref: 'past_meetings/%2Fzoom-instance-1/transcripts',
      started_at: '2026-07-18T01:02:00.000Z',
      ended_at: '2026-07-18T01:47:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:02:00.000Z'),
      t0_source: t0Source,
      align_state: 'event',
    });

    await loadZoomTranscript(meeting);

    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-zoom-1', { provider_transcript_status: 'ready' });
    expect(meeting.started_at).toBe('2026-07-18T01:02:00.000Z');
    expect(meeting.vc_meeting_start_t0).toBe(Date.parse('2026-07-18T01:02:00.000Z'));
  });

  it.each([
    ['no_record', '未找到实际召开的场次。'],
    ['not_generated', '转写未生成（可能未开启云录制）。'],
    ['pending', '正在等待 Zoom 会后转写生成。'],
  ] as const)('persists and displays the %s state', async (status, message) => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({ status, participants: [] });
    const meeting = zoomMeeting();

    const loaded = await loadZoomTranscript(meeting);

    expect(loaded).toMatchObject({ sourceToken: 'zoom:local-zoom-1', cues: [] });
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-zoom-1', { provider_transcript_status: status });
    expect(recapTranscriptMissingMessage(meeting)).toBe(message);
  });

  it('models pending retry, alignment quality, speaker fallback, and the Zoom recap card copy', () => {
    expect(recapTranscriptRetryLabel(zoomMeeting({ provider_transcript_status: 'pending' }))).toBe('重试');
    expect(recapTranscriptRetryLabel({ platform: 'google_meet', provider_transcript_status: 'pending' })).toBe('重新检查');
    expect(zoomTranscriptAlignmentLabel('approximate_pause_unknown')).toBe('时间为近似（录制中断未校准）');
    expect(zoomTranscriptAlignmentLabel('derived_no_pause')).toBe('Zoom 场次时间对齐');
    expect(recapTranscriptSpeakerLabel({ platform: 'zoom' }, '')).toBe('未知说话人');
    expect(recapTranscriptSpeakerLabel({ platform: 'zoom' }, 'Unknown Speaker')).toBe('Unknown Speaker');
    expect(recapTranscriptPageDescription({ platform: 'zoom' })).toBe('这里展示 Zoom 会后录制的逐句原始发言；不混入官方纪要，也不混入 InkLoop 后处理。');
    expect(recapTranscriptPageDescription({ platform: 'google_meet' })).toBe('这里展示 Google Meet逐句原始发言；不混入智能纪要，也不混入 InkLoop 后处理。');
    expect(renderRecapCard(zoomMeeting())).toContain('Zoom 会后转写');
    expect(renderRecapCard(zoomMeeting({ provider_transcript_status: 'no_record' }))).toContain('未找到实际召开的场次');
    expect(renderRecapCard(zoomMeeting({ provider_transcript_status: 'not_generated' }))).toContain('转写未生成（可能未开启云录制）');
  });

  it('does not call the Zoom provider for Lark, Google, or incomplete Zoom meetings', async () => {
    await expect(loadZoomTranscript(zoomMeeting({ platform: 'lark' }))).resolves.toBeNull();
    await expect(loadZoomTranscript(zoomMeeting({ platform: 'google_meet' }))).resolves.toBeNull();
    await expect(loadZoomTranscript(zoomMeeting({ provider_space_name: undefined }))).resolves.toBeNull();
    expect(mocks.getCachedMinute).not.toHaveBeenCalled();
    expect(mocks.fetchZoomMeetingTranscript).not.toHaveBeenCalled();
  });

  it('generates and persists the Zoom InkLoop summary through the provider-neutral endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'glm-test',
      summary: {
        conclusions: ['确认发布 Zoom 会后恢复'],
        action_items: [{ task: '补充录制中断验证', owner: 'Ada' }],
        risks: [],
        open_questions: [],
        next_steps: ['完成回归'],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const meeting = zoomMeeting({ provider_meeting_id: '/zoom-instance-1' });
    const cues = [{
      index: 1,
      startMs: 1_000,
      endMs: 2_000,
      speaker: 'Ada',
      text: '确认发布 Zoom 会后恢复。',
      rawText: 'Ada: 确认发布 Zoom 会后恢复。',
    }];

    const summary = await ensureProviderPanelSummary(meeting, cues);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/meetings/summary');
    const request = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(request.transcript).toContain('[0:01]Ada：确认发布 Zoom 会后恢复。');
    expect(request.smart_note).toBeUndefined();
    expect(summary).toMatchObject({
      minute_token: 'zoom:local-zoom-1',
      meeting_id: '/zoom-instance-1',
      model: 'glm-test',
    });
    expect(meetingSummaryTranscriptCacheToken({
      summary_source: { transcript_cache_token: 'zoom:local-zoom-1', mark_count: 1, cue_count: 1 },
    })).toBe('zoom:local-zoom-1');
    expect(mocks.updateMeeting).toHaveBeenCalledWith('local-zoom-1', expect.objectContaining({
      panel_summary: summary,
      panel_summary_status: 'ready',
    }));
  });
});
