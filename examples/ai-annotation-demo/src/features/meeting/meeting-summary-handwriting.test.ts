import { describe, expect, it } from 'vitest';
import type { PersistedMark, PersistedMeeting } from '../../core/store-format';
import {
  buildMeetingHandwritingSections,
  MEETING_HANDWRITING_MAX_CHARS,
  MEETING_HANDWRITING_MAX_ITEMS,
  MEETING_HANDWRITING_MAX_ITEM_CHARS,
} from './meeting-summary-handwriting';

const T0 = Date.parse('2026-07-18T01:00:00.000Z');

function meeting(): PersistedMeeting {
  return {
    meeting_id: 'meeting-budget', workspace_id: 'workspace', title: '预算测试',
    scheduled_at: new Date(T0).toISOString(), started_at: new Date(T0).toISOString(),
    ended_at: new Date(T0 + 60 * 60_000).toISOString(), status: 'ended', material_doc_ids: [],
    created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(),
  };
}

function mark(id: string, at: number, text: string): PersistedMark {
  return {
    mark_id: id, entry_id: `entry-${id}`, document_id: 'board', page_id: 'page', page_index: 0,
    seq: 1, created_at: new Date(at).toISOString(), strokes: [], bbox: [0, 0, 0.1, 0.1],
    tool: 'pen', color: '#111', pointer_type: 'pen', device_id: 'test', abs_timestamp: at,
    feature_type: 'handwriting', feature_confidence: 1, scored_type: 'handwriting', scored_score: 1,
    hmp: null, marked_text: text, is_tombstone: false,
  };
}

describe('会议总结手写组料预算', () => {
  it('会前超长时仍保留会中与会后，并输出明确省略标记', () => {
    const pre = Array.from({ length: 40 }, (_, index) => mark(`pre-${index}`, T0 - 20 * 60_000 + index, `会前-${index}-${'甲'.repeat(490)}`));
    const sections = buildMeetingHandwritingSections(meeting(), [
      ...pre,
      mark('in', T0 + 30_000, '会中关键决策'),
      mark('post', T0 + 80 * 60_000, '会后补充行动'),
    ], T0);

    expect(sections.in_meeting).toEqual([{ relative_time: '0:30', text: '会中关键决策' }]);
    expect(sections.post_meeting).toEqual(['会后补充行动']);
    expect(sections.omitted_count?.pre_meeting).toBeGreaterThan(0);
  });

  it('总量不超过 8k/80 条且单条不超过 500 字符', () => {
    const marks = Array.from({ length: 120 }, (_, index) => {
      const at = index % 3 === 0 ? T0 - 20 * 60_000 : index % 3 === 1 ? T0 + index * 1_000 : T0 + 80 * 60_000;
      return mark(`mark-${index}`, at, `${index}-${'乙'.repeat(700)}`);
    });
    const sections = buildMeetingHandwritingSections(meeting(), marks, T0);
    const texts = [
      ...sections.pre_meeting,
      ...sections.in_meeting.map((item) => item.text),
      ...sections.post_meeting,
    ];
    const chars = texts.reduce((total, text) => total + text.length, 0)
      + sections.in_meeting.reduce((total, item) => total + item.relative_time.length, 0);

    expect(texts.length).toBeGreaterThan(0);
    expect(texts.length).toBeLessThanOrEqual(MEETING_HANDWRITING_MAX_ITEMS);
    expect(chars).toBeLessThanOrEqual(MEETING_HANDWRITING_MAX_CHARS);
    expect(Math.max(...texts.map((text) => text.length))).toBeLessThanOrEqual(MEETING_HANDWRITING_MAX_ITEM_CHARS);
    expect(sections.omitted_count).toBeDefined();
  });
});
