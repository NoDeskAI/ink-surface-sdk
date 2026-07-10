import { describe, expect, it } from 'vitest';
import type { PersistedMeeting } from '../../core/store-format';
import type { TranscriptCue } from '../panel-feishu/align';
import { buildEpaperMeetingTimeline } from './epaper-timeline';

const t0 = Date.parse('2026-07-07T02:00:00.000Z');

const meeting: PersistedMeeting = {
  meeting_id: 'mtg_epaper_sdk',
  workspace_id: 'ws_demo',
  title: 'InkLoop 会议链路评审',
  scheduled_at: new Date(t0).toISOString(),
  status: 'ended',
  started_at: new Date(t0).toISOString(),
  ended_at: new Date(t0 + 8 * 60_000).toISOString(),
  material_doc_ids: [],
  feishu_meeting_id: 'om_123',
  feishu_meeting_no: '123456789',
  feishu_topic: 'InkLoop 会议链路评审',
  vc_meeting_start_t0: t0,
  t0_source: 'vc_event',
  align_offset_ms: 0,
  align_state: 'event',
  created_at: new Date(t0).toISOString(),
  updated_at: new Date(t0).toISOString(),
};

const cues: TranscriptCue[] = [
  { index: 1, startMs: 0, endMs: 8_000, speaker: '张宇', text: '今天先确认会议场景的电子纸入口。', rawText: '张宇：今天先确认会议场景的电子纸入口。' },
  { index: 2, startMs: 12_000, endMs: 20_000, speaker: '张宇', text: '手写标记需要进入后处理，而不是只停留在页面上。', rawText: '张宇：手写标记需要进入后处理，而不是只停留在页面上。' },
  { index: 3, startMs: 75_000, endMs: 88_000, speaker: '同事', text: 'Obsidian 只看会议输出，不混进阅读笔记。', rawText: '同事：Obsidian 只看会议输出，不混进阅读笔记。' },
];

describe('e-paper meeting timeline bridge', () => {
  it('feeds transcript and e-paper marks into the SDK renderer model', () => {
    const timeline = buildEpaperMeetingTimeline({
      meeting,
      cues,
      t0AbsMs: t0,
      offsetMs: 0,
      marks: [
        {
          mark_id: 'mk_meeting_followup',
          abs_timestamp: t0 + 14_500,
          feature_type: 'handwriting',
          marked_text: '任务：把会议标记接入后处理',
          page_index: 0,
        },
      ],
    });

    expect(timeline.sdkView.status).toBe('timeline_view_ready');
    expect(timeline.sdkView.diagnostics.rail_counts).toMatchObject({ annotations: 1, transcript: 3 });
    expect(timeline.sdkView.markers.map((marker) => marker.rail)).toContain('annotations');
    expect(timeline.segmentMarks).toMatchObject([{ mark_id: 'mk_meeting_followup', relMs: 14_500 }]);
    expect(timeline.segments.some((segment) => segment.kind === 'active' && segment.marks.length === 1)).toBe(true);
  });

  it('keeps pre-meeting e-paper marks visible as uncalibrated SDK annotations', () => {
    const timeline = buildEpaperMeetingTimeline({
      meeting,
      cues: [],
      t0AbsMs: t0,
      offsetMs: 0,
      marks: [
        {
          mark_id: 'mk_before',
          abs_timestamp: t0 - 30_000,
          feature_type: 'drawing',
          marked_text: '',
          page_index: 0,
        },
      ],
    });

    expect(timeline.sdkView.diagnostics.uncalibrated_marker_count).toBe(1);
    expect(timeline.segmentMarks[0]).toMatchObject({ mark_id: 'mk_before', relMs: -30_000, feature_type: 'drawing' });
    expect(timeline.segments[0]).toMatchObject({ kind: 'active', startMs: -30_000 });
  });
});
