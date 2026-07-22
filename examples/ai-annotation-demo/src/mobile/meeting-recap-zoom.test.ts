import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedMeeting } from '../core/store-format';

const mocks = vi.hoisted(() => ({
  getCachedMinute: vi.fn(),
  putCachedMinute: vi.fn(),
  getMeeting: vi.fn(),
  mutateMeeting: vi.fn(),
  updateMeeting: vi.fn(),
  fetchZoomMeetingTranscript: vi.fn(),
  getFoldedMarksByContext: vi.fn(),
  triggerBoardOcr: vi.fn(),
  isBoardOcrInFlight: vi.fn(),
  meetings: new Map<string, PersistedMeeting>(),
  appliedPatches: [] as Array<Partial<PersistedMeeting>>,
}));

vi.mock('../local/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local/store')>(),
  getCachedMinute: mocks.getCachedMinute,
  putCachedMinute: mocks.putCachedMinute,
  getMeeting: mocks.getMeeting,
  mutateMeeting: mocks.mutateMeeting,
  updateMeeting: mocks.updateMeeting,
  getFoldedMarksByContext: mocks.getFoldedMarksByContext,
}));

vi.mock('../capture/board-ocr', async (importOriginal) => ({
  ...await importOriginal<typeof import('../capture/board-ocr')>(),
  triggerBoardOcr: mocks.triggerBoardOcr,
  isBoardOcrInFlight: mocks.isBoardOcrInFlight,
}));

vi.mock('../integration/zoom/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../integration/zoom/client')>(),
  fetchZoomMeetingTranscript: mocks.fetchZoomMeetingTranscript,
}));

import {
  ensureProviderPanelSummary,
  loadZoomTranscript,
  meetingSummaryTranscriptCacheToken,
  requestProviderPanelSummary,
  recapTranscriptMissingMessage,
  recapTranscriptPageDescription,
  recapTranscriptRetryLabel,
  recapTranscriptSpeakerLabel,
  renderRecapCard,
  renderProviderParticipantsOverview,
  renderZoomSmartNoteHtml,
  zoomSmartNoteCardState,
  zoomTranscriptAlignmentLabel,
} from './meeting-recap';

function zoomMeeting(patch: Partial<PersistedMeeting> = {}): PersistedMeeting {
  const meeting: PersistedMeeting = {
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
  mocks.meetings.set(meeting.meeting_id, meeting);
  return meeting;
}

const ZOOM_CACHE_TOKEN = 'zoom:local-zoom-1:20260718T010000Z';

describe('meeting recap Zoom transcript branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.meetings.clear();
    mocks.appliedPatches.length = 0;
    mocks.getCachedMinute.mockResolvedValue(null);
    mocks.putCachedMinute.mockResolvedValue(undefined);
    mocks.updateMeeting.mockResolvedValue(null);
    mocks.getFoldedMarksByContext.mockResolvedValue([]);
    mocks.triggerBoardOcr.mockResolvedValue({ document_id: 'mtgboard_local-zoom-1', marks: 0, ok: 0, empty: 0, ms: 0 });
    mocks.isBoardOcrInFlight.mockReturnValue(false);
    mocks.getMeeting.mockImplementation(async (id: string) => mocks.meetings.get(id) ?? null);
    mocks.mutateMeeting.mockImplementation(async (id: string, mutator: (current: PersistedMeeting) => Partial<PersistedMeeting> | null) => {
      const current = mocks.meetings.get(id);
      if (!current) return null;
      const patch = mutator(current);
      if (!patch) return null;
      mocks.appliedPatches.push(patch);
      Object.assign(current, patch);
      return current;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the minute cache before the network request and falls back to it while pending', async () => {
    const order: string[] = [];
    const cachedSrt = '1\n00:00:03,000 --> 00:00:04,000\nGrace: Cached line';
    mocks.getCachedMinute.mockImplementation(async () => {
      order.push('cache');
      return { minute_token: ZOOM_CACHE_TOKEN, srt: cachedSrt, fetched_at: '2026-07-18T03:00:00.000Z' };
    });
    mocks.fetchZoomMeetingTranscript.mockImplementation(async () => {
      order.push('network');
      return { status: 'pending', participants: [], next_check_at: '2026-07-18T03:05:00.000Z' };
    });

    const loaded = await loadZoomTranscript(zoomMeeting());

    expect(order).toEqual(['cache', 'network']);
    expect(loaded).toMatchObject({ sourceToken: ZOOM_CACHE_TOKEN, cues: [{ speaker: 'Grace', text: 'Cached line' }] });
    expect(mocks.appliedPatches).toContainEqual({ provider_transcript_status: 'pending' });
    expect(mocks.putCachedMinute).not.toHaveBeenCalled();
  });

  it('caches ready SRT and writes the complete actual-session anchor without undefined fields', async () => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({
      status: 'ready',
      participants: [{
        display_name: 'Ada', identity_quality: 'signed_in',
        join_time: '2026-07-18T01:02:00.000Z', leave_time: '2026-07-18T01:47:00.000Z',
      }],
      instance_uuid: '/zoom-instance-1',
      t0: '2026-07-18T01:02:00.000Z',
      started_at: '2026-07-18T01:02:00.000Z',
      ended_at: '2026-07-18T01:47:00.000Z',
      timestamp_quality: 'approximate_pause_unknown',
      smart_note: {
        title: 'Zoom 发布复盘',
        text: '## 决定\n\n周五发布。',
        export_uri: 'https://zoom.us/summary/zoom-instance-1',
        overview: '确认发布时间。',
        details: [{ label: '决定', summary: '周五发布。' }],
        next_steps: ['Ada 完成验证'],
        created_time: '2026-07-18T10:00:00Z',
        fetched_at: '2026-07-18T02:00:05.000Z',
      },
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
      sourceToken: ZOOM_CACHE_TOKEN,
      timestampQuality: 'approximate_pause_unknown',
      cues: [{ speaker: 'Ada', text: 'Ship it' }, { text: 'No label' }],
    });
    expect(mocks.fetchZoomMeetingTranscript).toHaveBeenCalledWith('987654321', '2026-07-18T01:00:00.000Z');
    expect(meeting).toMatchObject({
      provider_transcript_status: 'ready',
      provider_meeting_id: '/zoom-instance-1',
      provider_transcript_ref: 'past_meetings/%2Fzoom-instance-1/transcripts',
      vc_meeting_start_t0: startMs,
      t0_source: 'provider_event',
      align_state: 'event',
      started_at: '2026-07-18T01:02:00.000Z',
      ended_at: '2026-07-18T01:47:00.000Z',
      provider_participants: [{
        name: 'Ada', identity: 'signed_in',
        joined_at: '2026-07-18T01:02:00.000Z', left_at: '2026-07-18T01:47:00.000Z',
      }],
      zoom_smart_note: {
        title: 'Zoom 发布复盘',
        text: '## 决定\n\n周五发布。',
        export_uri: 'https://zoom.us/summary/zoom-instance-1',
        overview: '确认发布时间。',
        details: [{ label: '决定', summary: '周五发布。' }],
        next_steps: ['Ada 完成验证'],
        created_time: '2026-07-18T10:00:00Z',
        fetched_at: '2026-07-18T02:00:05.000Z',
      },
    });
    expect(mocks.appliedPatches[0]).toEqual(expect.objectContaining({
      provider_participants: [{
        name: 'Ada', identity: 'signed_in',
        joined_at: '2026-07-18T01:02:00.000Z', left_at: '2026-07-18T01:47:00.000Z',
      }],
    }));
    const applied = mocks.appliedPatches[0] as Record<string, unknown>;
    expect(Object.values(applied)).not.toContain(undefined);
    expect(mocks.putCachedMinute).toHaveBeenCalledWith(expect.objectContaining({
      minute_token: ZOOM_CACHE_TOKEN,
      meeting_id: 'local-zoom-1',
      duration_ms: 45 * 60_000,
    }));
  });

  it('renders a lightweight participant section without replacing the transcript speaker count', () => {
    const meeting = zoomMeeting({
      provider_participants: [
        { name: 'Ada', joined_at: '2026-07-18T09:00:00', left_at: '2026-07-18T09:20:00', identity: 'signed_in' },
        { name: 'Ada', joined_at: '2026-07-18T09:30:00', left_at: '2026-07-18T09:45:00', identity: 'signed_in' },
        { name: '外部同事', joined_at: '2026-07-18T09:05:00', left_at: '2026-07-18T09:15:00', identity: 'external_email' },
      ],
    });

    expect(renderProviderParticipantsOverview(meeting)).toMatchInlineSnapshot(`
      "<section class=\"rc-over-participants\" id=\"rc-participants\"><div class=\"rc-sec-title\"><b>参会（2 人）</b></div><div class=\"rc-participant-list\"><span class=\"rc-participant-li\">Ada · 共 35 分钟 · 2 段：09:00–09:20、09:30–09:45</span><span class=\"rc-participant-li\">外部同事（访客） · 共 10 分钟 · 09:05–09:15</span></div></section>"
    `);
    expect(renderProviderParticipantsOverview(zoomMeeting())).toBe('');
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

    expect(mocks.appliedPatches).toContainEqual({ provider_transcript_status: 'ready' });
    expect(meeting.started_at).toBe('2026-07-18T01:02:00.000Z');
    expect(meeting.vc_meeting_start_t0).toBe(Date.parse('2026-07-18T01:02:00.000Z'));
  });

  it('atomically replaces a stale provider-event anchor when the selected instance UUID changes', async () => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({
      status: 'ready',
      participants: [],
      instance_uuid: '/zoom-instance-new',
      t0: '2026-07-18T01:06:00.000Z',
      started_at: '2026-07-18T01:06:30.000Z',
      ended_at: '2026-07-18T01:56:00.000Z',
      transcript: {
        name: 'past_meetings/%2Fzoom-instance-new/transcripts',
        lines: [],
        srt: '1\n00:00:01,000 --> 00:00:02,000\nAda: New occurrence',
        timestamp_quality: 'derived_no_pause',
      },
    });
    const meeting = zoomMeeting({
      provider_meeting_id: '/zoom-instance-old',
      provider_transcript_ref: 'past_meetings/%2Fzoom-instance-old/transcripts',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:01:00.000Z'),
      started_at: '2026-07-18T01:01:00.000Z',
      ended_at: '2026-07-18T01:40:00.000Z',
      t0_source: 'provider_event',
      align_state: 'event',
    });

    await loadZoomTranscript(meeting);

    expect(mocks.appliedPatches[0]).toMatchObject({
      provider_meeting_id: '/zoom-instance-new',
      provider_transcript_ref: 'past_meetings/%2Fzoom-instance-new/transcripts',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:06:00.000Z'),
      started_at: '2026-07-18T01:06:30.000Z',
      ended_at: '2026-07-18T01:56:00.000Z',
      t0_source: 'provider_event',
    });
  });

  it('drops a late transcript result after the Zoom meeting is rescheduled', async () => {
    const meeting = zoomMeeting();
    mocks.fetchZoomMeetingTranscript.mockImplementation(async () => {
      meeting.scheduled_at = '2026-07-19T01:00:00.000Z';
      return {
        status: 'ready',
        participants: [{
          display_name: 'Stale participant', identity_quality: 'signed_in',
          join_time: '2026-07-18T01:00:00.000Z', leave_time: '2026-07-18T01:30:00.000Z',
        }],
        instance_uuid: '/stale-instance',
        transcript: {
          name: 'stale-transcript',
          lines: [],
          srt: '1\n00:00:01,000 --> 00:00:02,000\nStale',
          timestamp_quality: 'derived_no_pause',
        },
      };
    });

    await expect(loadZoomTranscript(meeting)).resolves.toBeNull();
    expect(mocks.appliedPatches).toEqual([]);
    expect(mocks.putCachedMinute).not.toHaveBeenCalled();
  });

  it.each([
    ['no_record', '未找到实际召开的场次。'],
    ['not_generated', '转写未生成（可能未开启云录制）。'],
    ['pending', '正在等待 Zoom 会后转写生成。'],
  ] as const)('persists and displays the %s state', async (status, message) => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({ status, participants: [] });
    const meeting = zoomMeeting();

    const loaded = await loadZoomTranscript(meeting);

    expect(loaded).toMatchObject({ sourceToken: ZOOM_CACHE_TOKEN, cues: [] });
    expect(mocks.appliedPatches).toContainEqual({ provider_transcript_status: status });
    expect(recapTranscriptMissingMessage(meeting)).toBe(message);
  });

  it.each([
    ['instance_not_found', 'no_record', '未找到实际召开的场次'],
    ['recording_missing', 'no_record', '该场次未开启云录制，没有转写'],
    ['recording_missing_companion_missing', 'no_record', '该场次无云录制，Zoom AI Companion 也没有转写'],
    ['transcript_not_generated', 'not_generated', '转写尚未生成或未开启'],
  ] as const)('uses server reason %s for terminal copy', async (reason, status, message) => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({ status, reason, participants: [] });
    const meeting = zoomMeeting();

    await loadZoomTranscript(meeting);

    expect(recapTranscriptMissingMessage(meeting)).toBe(`${message}。`);
    expect(renderRecapCard(meeting)).toContain(message);
  });

  it('转写未生成时仍落库名单并渲染参会区', async () => {
    mocks.fetchZoomMeetingTranscript.mockResolvedValue({
      status: 'not_generated',
      reason: 'transcript_not_generated',
      participants: [{
        display_name: 'Ada', identity_quality: 'signed_in',
        join_time: '2026-07-18T01:02:00.000Z', leave_time: '2026-07-18T01:42:00.000Z',
      }],
    });
    const meeting = zoomMeeting();

    await loadZoomTranscript(meeting);

    expect(meeting.provider_participants).toHaveLength(1);
    expect(renderProviderParticipantsOverview(meeting)).toContain('Ada · 共 40 分钟');
  });

  it('旧场总结请求失败前已改期时不污染新场', async () => {
    const meeting = zoomMeeting();
    mocks.getFoldedMarksByContext.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      meeting.scheduled_at = '2026-07-19T01:00:00.000Z';
      throw new Error('总结请求失败');
    }));

    const result = await requestProviderPanelSummary(meeting, [{
      index: 1, startMs: 0, endMs: 1_000, speaker: '', text: '旧场内容', rawText: '旧场内容',
    }]);

    expect(result).toMatchObject({ summary: null, failurePersisted: false, occurrenceToken: '20260718T010000Z' });
    expect(mocks.appliedPatches).toEqual([]);
    expect(meeting.panel_summary_status).toBeUndefined();
  });

  it('models pending retry, alignment quality, speaker fallback, and the Zoom recap card copy', () => {
    expect(recapTranscriptRetryLabel(zoomMeeting({ provider_transcript_status: 'pending' }))).toBe('重试');
    expect(recapTranscriptRetryLabel({ platform: 'google_meet', provider_transcript_status: 'pending' })).toBe('重新检查');
    expect(zoomTranscriptAlignmentLabel('approximate_pause_unknown')).toBe('时间为近似（录制中断未校准）');
    expect(zoomTranscriptAlignmentLabel('derived_no_pause')).toBe('Zoom 场次时间对齐');
    expect(zoomTranscriptAlignmentLabel('companion_offset_anchor')).toBe('Zoom AI Companion 场次时间对齐');
    expect(recapTranscriptSpeakerLabel({ platform: 'zoom' }, '')).toBe('未知说话人');
    expect(recapTranscriptSpeakerLabel({ platform: 'zoom' }, 'Unknown Speaker')).toBe('Unknown Speaker');
    expect(recapTranscriptPageDescription({ platform: 'zoom' })).toBe('这里展示 Zoom 会后逐句原始发言；不混入官方纪要，也不混入 InkLoop 后处理。');
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

  it('renders the Zoom official-summary slot with AI Companion attribution and source markdown', () => {
    const meeting = zoomMeeting({
      zoom_smart_note: {
        title: '发布复盘',
        text: '## 决定\n\n周五发布。',
        export_uri: 'https://zoom.us/summary/doc',
        overview: '确认发布时间。',
        details: [{ label: '决定', summary: '周五发布。' }],
        next_steps: ['完成真机验证'],
        created_time: '2026-07-18T10:00:00Z',
        fetched_at: '2026-07-18T02:00:05.000Z',
      },
    });

    expect(zoomSmartNoteCardState(meeting)).toEqual({
      meta: '已同步', body: '查看 Zoom AI Companion 官方纪要原文。', disabled: false,
    });
    expect(renderZoomSmartNoteHtml(meeting)).toContain('Zoom AI Companion');
    expect(renderZoomSmartNoteHtml(meeting)).toContain('<b>决定</b>');
    expect(renderZoomSmartNoteHtml(meeting)).not.toContain('## 决定');
    expect(renderZoomSmartNoteHtml(meeting)).toContain('2026-07-18T10:00:00Z');
    expect(renderZoomSmartNoteHtml(meeting)).toContain('href="https://zoom.us/summary/doc"');
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
    const meeting = zoomMeeting({
      provider_meeting_id: '/zoom-instance-1',
      zoom_smart_note: {
        title: 'Zoom 官方纪要',
        text: 'AI Companion notes say the recovery path should ship first.',
        details: [],
        next_steps: [],
        fetched_at: '2026-07-18T02:00:05.000Z',
      },
    });
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
    expect(request.smart_note).toBe('AI Companion notes say the recovery path should ship first.');
    expect(request.handwriting_sections).toBeUndefined();
    expect(request.platform).toBe('zoom');
    expect(summary).toMatchObject({
      minute_token: ZOOM_CACHE_TOKEN,
      meeting_id: '/zoom-instance-1',
      model: 'glm-test',
    });
    expect(meetingSummaryTranscriptCacheToken({
      summary_source: { transcript_cache_token: 'zoom:local-zoom-1', mark_count: 1, cue_count: 1 },
    })).toBe('zoom:local-zoom-1');
    expect(mocks.appliedPatches).toContainEqual(expect.objectContaining({
      panel_summary: summary,
      panel_summary_status: 'ready',
    }));
  });

  it('drops a late provider summary after the Zoom occurrence changes', async () => {
    const meeting = zoomMeeting();
    const fetchMock = vi.fn().mockImplementation(async () => {
      meeting.scheduled_at = '2026-07-19T01:00:00.000Z';
      return new Response(JSON.stringify({
        model: 'glm-test',
        summary: { conclusions: ['stale'], action_items: [], risks: [], open_questions: [], next_steps: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const cues = [{ index: 1, startMs: 0, endMs: 1_000, speaker: '', text: 'old occurrence', rawText: 'old occurrence' }];

    await expect(ensureProviderPanelSummary(meeting, cues)).resolves.toBeNull();
    expect(mocks.appliedPatches).toEqual([]);
  });
});
