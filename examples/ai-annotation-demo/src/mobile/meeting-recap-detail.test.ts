import { describe, expect, it } from 'vitest';
import type { TranscriptCue } from '../integration/panel-feishu/align';
import type { PersistedMark, PersistedMeeting } from '../core/store-format';
import { buildSummaryPrompt, meetingRawMediaPresentation, meetingSummaryProgress, renderInterviewArchiveHtml, renderMeetingSummaryCardsHtml, selectInkPageTranscriptCues } from './meeting-recap';

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
    const t0 = Date.parse('2026-07-09T08:00:00.000Z');
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
    const t0 = Date.parse('2026-07-09T08:00:00.000Z');
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
    const t0 = Date.parse('2026-07-09T08:00:00.000Z');
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
    const t0 = Date.parse('2026-07-09T08:00:00.000Z');
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

  it('treats OCR-empty placeholders as unrecognized handwriting in the summary prompt', () => {
    const t0 = Date.parse('2026-07-09T08:00:00.000Z');
    const result = buildSummaryPrompt(meeting(t0), [cue(1, 5)], [
      { ...summaryMark(t0, 30_000, '手写 6 笔'), ocr_empty: true },
    ]);

    expect(result.prompt).toContain('无法识别的手写·别推断其文字含义');
    expect(result.prompt).not.toContain('手写 6 笔');
  });
});

describe('meeting summary state', () => {
  it('keeps durable raw-media deletion states distinct and retryable', () => {
    expect(meetingRawMediaPresentation({ status: 'deleted', reason: 'formal_transcript_terminal', updated_at_ms: 1 })).toMatchObject({ label: '转写完成后已自动删除', canDelete: false });
    expect(meetingRawMediaPresentation({ status: 'deleted', reason: 'user_requested', updated_at_ms: 1 })).toMatchObject({ label: '已按你的要求删除', canDelete: false });
    expect(meetingRawMediaPresentation({ status: 'delete_failed', reason: 'user_requested', updated_at_ms: 1, error: 'disk' })).toMatchObject({ label: '上次删除失败', canDelete: true, button: '重试删除云端临时音频' });
    expect(meetingRawMediaPresentation(null, 'not_found')).toMatchObject({ label: '尚未产生云端媒体', canDelete: false });
  });

  it('renders the full interview archive in a sandboxed HTML viewer', () => {
    const current = meeting(Date.parse('2026-07-09T08:00:00.000Z'));
    current.interview_archive_html = { artifact_id: 'archive', filename: '访谈.html', html: '<!doctype html><html><body><h1>研究者即时发现</h1></body></html>', finality: 'final', generated_at: new Date().toISOString() };
    const html = renderInterviewArchiveHtml(current);
    expect(html).toContain('sandbox=""');
    expect(html).toContain('srcdoc="&lt;!doctype html&gt;');
    expect(html).toContain('下载 HTML');
  });
  it('makes a partial realtime transcript explicit', () => {
    expect(meetingSummaryProgress({ coverage: { utterances: 'partial', handwriting_ocr: 'complete', started_at_ms: 0, ended_at_ms: 1 } }, 'final')).toEqual({ label: '实时转写追平中 · 当前为部分结果', partial: true });
  });

  it('distinguishes provisional and final complete summaries', () => {
    const complete = { coverage: { utterances: 'complete' as const, handwriting_ocr: 'complete' as const, started_at_ms: 0, ended_at_ms: 1 } };
    expect(meetingSummaryProgress(complete, 'provisional').label).toContain('初步结果');
    expect(meetingSummaryProgress(complete, 'final')).toEqual({ label: '最终结果', partial: false });
  });

  it('renders cards while ignoring all legacy full-report content and controls', () => {
    const current = meeting(Date.parse('2026-07-09T08:00:00.000Z'));
    current.summary_cards_v2 = {
      schema_version: '2.0', artifact_state: 'final', theme: '访谈摘要', overview: '只显示这份短摘要',
      key_points: [], decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [],
      coverage: { utterances: 'complete', handwriting_ocr: 'complete', started_at_ms: 0, ended_at_ms: 1 },
    };
    current.panel_summary = {
      generated_at: Date.now(), summary: { conclusions: [], action_items: [], risks: [], open_questions: [], next_steps: [], report_markdown: '# 旧完整报告正文' },
    };
    current.full_report_v2 = { artifact_id: 'legacy', title: '旧完整报告', report_markdown: '# 另一份旧报告正文', finality: 'final' };

    const html = renderMeetingSummaryCardsHtml(current);
    expect(html).toContain('只显示这份短摘要');
    expect(html).not.toContain('旧完整报告正文');
    expect(html).not.toContain('另一份旧报告正文');
    expect(html).not.toMatch(/生成完整报告|查看完整报告|ps-report/);
  });

  it('keeps the interview template confirmation, pending, and next-action sections distinct', () => {
    const current = meeting(Date.parse('2026-07-09T08:00:00.000Z'));
    current.summary_cards_v2 = {
      schema_version: '2.0', template_id: 'interview_memo', artifact_state: 'final', theme: '访谈备忘录', overview: '访谈背景',
      key_points: [], highlights: [], risks: [], personal_notes: [],
      decisions: [
        { id: 'd1', text: '确认继续合作', status: 'confirmed', evidence_refs: ['u1'] },
        { id: 'd2', text: '预算范围尚未确认', status: 'tentative', evidence_refs: ['u1'] },
      ],
      open_questions: [{ id: 'q1', text: '具体时间待确认', evidence_refs: ['u1'] }],
      action_items: [{ id: 'a1', task: '发送补充材料', owner: null, due_at: null, commitment: 'explicit', evidence_refs: ['u1'] }],
      coverage: { utterances: 'complete', handwriting_ocr: 'complete', started_at_ms: 0, ended_at_ms: 1 },
    };

    const html = renderMeetingSummaryCardsHtml(current);
    expect(html).toContain('确认事项');
    expect(html).toContain('确认继续合作');
    expect(html).toContain('待确认事项');
    expect(html).toContain('预算范围尚未确认');
    expect(html).toContain('具体时间待确认');
    expect(html).toContain('下一步行动');
    expect(html).toContain('发送补充材料');
  });

  it.each([
    ['university_notes', '关键概念与定义', '熵', null, '衡量系统无序程度', '熵：衡量系统无序程度'],
    ['interactive_classroom', '重要术语表', '递归', null, '函数调用自身', '递归：函数调用自身'],
    ['reasoning_summary', '方案权衡', '结论', null, '选择低延迟方案', '结论：选择低延迟方案'],
    ['interview_memo', '按问题整理的访谈记录', '使用频率？', 'Holly', '每周三次', '使用频率？：（Holly）每周三次'],
  ] as const)('renders %s from template-owned sections', (templateId, title, label, speaker, text, expected) => {
    const current = meeting(Date.parse('2026-07-09T08:00:00.000Z'));
    current.summary_cards_v2 = {
      schema_version: '2.0', template_id: templateId, artifact_state: 'final', theme: '专属模板', overview: '旧摘要不应代替专属结构',
      key_points: [{ id: 'legacy', text: '旧通用讨论要点', evidence_refs: ['u1'] }], decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [],
      template_sections: [{ id: 'owned', title, summary: null, items: [{ id: 'i1', text, label, speaker, evidence_refs: ['u1'] }] }],
      coverage: { utterances: 'complete', handwriting_ocr: 'complete', started_at_ms: 0, ended_at_ms: 1 },
    };
    const html = renderMeetingSummaryCardsHtml(current);
    expect(html).toContain(title);
    expect(html).toContain(expected);
    expect(html).not.toContain('旧通用讨论要点');
  });

  it('renders meeting expert pyramid layers instead of the generic three-section layout', () => {
    const current = meeting(Date.parse('2026-07-09T08:00:00.000Z'));
    current.summary_cards_v2 = {
      schema_version: '2.0', template_id: 'meeting_expert', artifact_state: 'final', theme: '[决策型] 发布：本周上线', overview: '本周完成上线。',
      section_titles: { background: '错误背景标题', discussion: '错误讨论标题', next_steps: '错误后续标题' },
      key_points: [{ id: 'k1', text: '讨论脉络', evidence_refs: ['u1'] }],
      decisions: [{ id: 'd1', text: '本周上线', status: 'confirmed', evidence_refs: ['u1'] }],
      action_items: [{ id: 'a1', task: '完成发布', owner: 'Ada', due_at: null, commitment: 'explicit', evidence_refs: ['u1'] }],
      highlights: [{ id: 'h1', text: '关键数据', evidence_refs: ['u1'] }],
      risks: [{ id: 'r1', text: '[分析] 存在风险', mitigation: null, evidence_refs: ['u1'] }],
      open_questions: [], personal_notes: [],
      coverage: { utterances: 'complete', handwriting_ocr: 'complete', started_at_ms: 0, ended_at_ms: 1 },
    };
    const html = renderMeetingSummaryCardsHtml(current);
    expect(html).toContain('第一层：核心信息');
    expect(html).toContain('第二层：关键脉络');
    expect(html).toContain('第三层：深度洞察');
    expect(html).not.toContain('错误背景标题');
    expect(html).not.toContain('错误讨论标题');
    expect(html).not.toContain('错误后续标题');
  });
});
