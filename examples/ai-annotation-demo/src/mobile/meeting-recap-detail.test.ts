import { describe, expect, it } from 'vitest';
import type { TranscriptCue } from '../integration/panel-feishu/align';
import type { PersistedMark, PersistedMeeting } from '../core/store-format';
import { buildSummaryPrompt, selectInkPageTranscriptCues } from './meeting-recap';

function cue(index: number, startS: number): TranscriptCue {
  return {
    index,
    startMs: startS * 1000,
    endMs: (startS + 5) * 1000,
    speaker: `说话人 ${index}`,
    text: `第 ${index} 句`,
    rawText: `说话人 ${index}: 第 ${index} 句`,
  };
}

function meeting(t0: number): PersistedMeeting {
  return {
    meeting_id: 'mtg_detail',
    workspace_id: 'ws_detail',
    title: '时间字段评审',
    scheduled_at: new Date(t0).toISOString(),
    started_at: new Date(t0).toISOString(),
    ended_at: new Date(t0 + 5 * 60_000).toISOString(),
    status: 'ended',
    material_doc_ids: [],
    created_at: new Date(t0).toISOString(),
    updated_at: new Date(t0).toISOString(),
  };
}

function summaryMark(t0: number, relMs: number, text: string, feature: PersistedMark['feature_type'] = 'handwriting'): PersistedMark {
  return {
    abs_timestamp: t0 + relMs + 2_000,
    pen_down_at: t0 + relMs,
    marked_text: text,
    feature_type: feature,
  } as PersistedMark;
}

describe('meeting recap detail transcript selection', () => {
  it('uses the ink page time window when meeting ink timestamps are plausible', () => {
    const t0 = 1_000_000;
    const cues = Array.from({ length: 20 }, (_, i) => cue(i + 1, i * 10));

    const selected = selectInkPageTranscriptCues({
      cues,
      marks: [{ abs_timestamp: t0 + 95_000 }, { abs_timestamp: t0 + 106_000 }],
      meeting: meeting(t0),
      pageIndex: 0,
      totalPages: 4,
      t0AbsMs: t0,
      offsetMs: 0,
      limit: 4,
    });

    expect(selected.source).toBe('time');
    expect(selected.meta).toContain('约对齐');
    expect(selected.cues.map((c) => c.index)).toEqual([9, 10, 11, 12]);
  });

  it('returns a terminal pre-meeting state instead of faking transcript alignment by page order', () => {
    const t0 = 1_000_000;
    const cues = Array.from({ length: 12 }, (_, i) => cue(i + 1, i * 10));

    const selected = selectInkPageTranscriptCues({
      cues,
      marks: [{ abs_timestamp: t0 - 7 * 24 * 3600_000 }],
      meeting: meeting(t0),
      pageIndex: 2,
      totalPages: 4,
      t0AbsMs: t0,
      offsetMs: 0,
      limit: 3,
    });

    expect(selected).toEqual({ cues: [], meta: '会前准备·不参与转写对齐', source: 'pre_meeting' });
  });

  it('returns a terminal post-meeting state for a page containing only late additions', () => {
    const t0 = 1_000_000;
    const selected = selectInkPageTranscriptCues({
      cues: [cue(1, 0)],
      marks: [{ abs_timestamp: t0 + 16 * 60_000 }],
      meeting: meeting(t0),
      pageIndex: 0,
      totalPages: 1,
      t0AbsMs: t0,
      offsetMs: 0,
    });

    expect(selected).toEqual({ cues: [], meta: '会后补充·不参与转写对齐', source: 'post_meeting' });
  });

  it('uses only in-meeting pen-down times when a page mixes preparation and live notes', () => {
    const t0 = 1_000_000;
    const cues = Array.from({ length: 20 }, (_, i) => cue(i + 1, i * 10));
    const selected = selectInkPageTranscriptCues({
      cues,
      marks: [
        { abs_timestamp: t0 - 20 * 60_000 },
        { abs_timestamp: t0 + 180_000, pen_down_at: t0 + 95_000 },
      ],
      meeting: meeting(t0),
      pageIndex: 0,
      totalPages: 1,
      t0AbsMs: t0,
      offsetMs: 0,
      limit: 4,
    });

    expect(selected.source).toBe('time');
    expect(selected.meta).toContain('1:35-1:35');
    expect(selected.cues.map((item) => item.index)).toEqual([9, 10, 11, 12]);
  });

  it('groups summary ink into preparation, live, and follow-up sections without fake clocks outside the meeting', () => {
    const t0 = Date.parse('2026-07-09T08:00:00.000Z');
    const current = meeting(t0);
    const result = buildSummaryPrompt(current, [{ ...cue(1, 5), speaker: '主持人' }], [
      summaryMark(t0, -11 * 60_000, '确认议程'),
      summaryMark(t0, 30_000, '关键决策'),
      summaryMark(t0, 16 * 60_000, '', 'drawing'),
    ]);

    expect(result).toMatchInlineSnapshot(`
      {
        "prompt": "会议标题：时间字段评审
      开始时间：2026-07-09T08:00:00.000Z

      <转写 可能因过长被截断·见末尾标记>
      [0:05]主持人：第 1 句
      </转写>

      <手写标注 各为用户当时的强调·时间是近似会议相对时刻·非与某句转写的精确对应>
      会前准备（不参与转写时间对齐）：
      - 确认议程
      会中手记：
      [0:30] 关键决策
      会后补充（不参与转写时间对齐）：
      - （一处图形/圈画·别推断其文字含义）
      </手写标注>

      请按系统要求产出会后思路总结。",
        "truncated": false,
        "usedCueCount": 1,
      }
    `);
  });
});
