import { beforeEach, describe, expect, it } from 'vitest';

import { state } from '../app/state';
import type { InferenceView, ScreenOverlay } from '../core/contracts';
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import { buildRecords } from './insight-panel';

function mark(over: Partial<PersistedMark>): PersistedMark {
  return {
    entry_id: `ent_${over.mark_id ?? 'm0'}`,
    document_id: 'doc_ux',
    page_id: 'pg_ux_0',
    page_index: 0,
    seq: 1,
    created_at: '2026-07-08T04:00:00.000Z',
    mark_id: 'm0',
    strokes: [],
    bbox: [0.1, 0.1, 0.2, 0.02],
    tool: 'pen',
    color: '#111',
    pointer_type: 'pen',
    device_id: 'dev_test',
    abs_timestamp: 1,
    feature_type: 'markup',
    feature_confidence: 0.95,
    kind_source: 'runtime-sync',
    scored_type: 'underline',
    scored_score: 0.9,
    hmp: null,
    marked_text: '',
    is_tombstone: false,
    origin: 'ai_pen',
    ...over,
  };
}

function aiTurn(markIds: string[], over: Partial<PersistedAiTurn> & { overlay_id?: string; anchor_bbox?: [number, number, number, number]; ai_reply?: string } = {}): PersistedAiTurn {
  const anchorBbox = over.anchor_bbox ?? [0.12, 0.12, 0.24, 0.04];
  const reply = over.ai_reply ?? 'AI 旁注结果';
  const overlay: ScreenOverlay = {
    overlay_id: over.overlay_id ?? 'ov_ai_1',
    trace_id: 'trace_ai_1',
    page_id: 'pg_ux_0',
    result_id: 'res_ai_1',
    overlay_type: 'note',
    geometry: { anchor_bbox: anchorBbox },
    display_text: reply,
    dismissible: true,
    created_at: '2026-07-08T04:00:05.000Z',
    state: 'shown',
    result_type: 'inspiration',
  };
  return {
    entry_id: `ent_${overlay.overlay_id}`,
    document_id: 'doc_ux',
    page_id: 'pg_ux_0',
    page_index: 0,
    seq: over.seq ?? 10,
    created_at: over.created_at ?? '2026-07-08T04:00:05.000Z',
    overlay_id: overlay.overlay_id,
    overlay,
    overlay_state: 'shown',
    user_edited_text: null,
    ai_reply: reply,
    anchor: { surface_id: 'pg_ux_0', mark_ids: markIds, object_refs: [] },
    inference_view: { anchor_bbox: anchorBbox } as InferenceView,
    prompt_snapshot: '',
    system_prompt_hash: 'annotator@v1',
    settings_snapshot: { inferModel: 'test', reflowProvider: 'local' },
    trigger: 'handwriting',
    model: 'test',
    supersedes: null,
  };
}

describe('insight panel records', () => {
  beforeEach(() => {
    state.documentId = 'doc_ux';
    state.pageId = 'pg_ux_0';
    state.pageIndex = 0;
    state.textBlocks = [];
    state.overlays = [];
  });

  it('renders one bound snapshot per mark anchored by the same AI turn', () => {
    const records = buildRecords([
      mark({ mark_id: 'm_ai_1', marked_text: '第一页第一个 AI 标记' }),
      mark({ mark_id: 'm_pen_2', marked_text: '第二页物理笔补充', origin: 'pen', page_id: 'pg_ux_1', page_index: 1 }),
    ], [
      aiTurn(['m_ai_1', 'm_pen_2']),
    ]);

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.id)).toEqual(['bound:ov_ai_1:m_ai_1', 'bound:ov_ai_1:m_pen_2']);
    expect(records[0]).toMatchObject({
      label: 'AI 笔',
      anchorText: '第一页第一个 AI 标记',
    });
    expect(records[1]).toMatchObject({
      label: '笔迹',
      anchorText: '第二页物理笔补充',
    });
  });

  it('reassigns duplicate AI turn anchors to the nearest unconsumed AI pen mark', () => {
    const records = buildRecords([
      mark({ mark_id: 'm_ai_title', bbox: [0.2, 0.1, 0.48, 0.02], marked_text: '标题下方 AI 笔' }),
      mark({ mark_id: 'm_ai_abstract', bbox: [0.12, 0.27, 0.5, 0.02], marked_text: '摘要区域 AI 笔' }),
      mark({ mark_id: 'm_pen_author', bbox: [0.32, 0.17, 0.3, 0.02], marked_text: '作者信息', origin: 'pen' }),
    ], [
      aiTurn(['m_ai_title'], { overlay_id: 'ov_title', seq: 20, anchor_bbox: [0.2, 0.1, 0.48, 0.02], ai_reply: '标题自己的 AI 返回' }),
      aiTurn(['m_ai_title'], { overlay_id: 'ov_abstract', seq: 21, anchor_bbox: [0.12, 0.27, 0.5, 0.02], ai_reply: '摘要自己的 AI 返回' }),
    ]);

    expect(records.map((record) => record.id)).toEqual([
      'bound:ov_abstract:m_ai_abstract',
      'bound:ov_title:m_ai_title',
      'mark:m_pen_author',
    ]);
    expect(records[0]).toMatchObject({ label: 'AI 笔', anchorText: '摘要区域 AI 笔', aiText: '摘要自己的 AI 返回' });
    expect(records[1]).toMatchObject({ label: 'AI 笔', anchorText: '标题下方 AI 笔', aiText: '标题自己的 AI 返回' });
  });

  it('does not repeat the same AI reply across separate AI pen turns', () => {
    const records = buildRecords([
      mark({ mark_id: 'm_ai_title', bbox: [0.2, 0.1, 0.48, 0.02], marked_text: '标题下方 AI 笔' }),
      mark({ mark_id: 'm_ai_abstract', bbox: [0.12, 0.27, 0.5, 0.02], marked_text: '摘要区域 AI 笔' }),
    ], [
      aiTurn(['m_ai_title'], { overlay_id: 'ov_title', seq: 20, anchor_bbox: [0.2, 0.1, 0.48, 0.02], ai_reply: '重复的 AI 返回' }),
      aiTurn(['m_ai_title'], { overlay_id: 'ov_abstract', seq: 21, anchor_bbox: [0.12, 0.27, 0.5, 0.02], ai_reply: '重复的 AI 返回' }),
    ]);

    expect(records.map((record) => record.id)).toEqual([
      'bound:ov_abstract:m_ai_abstract',
      'bound:ov_title:m_ai_title',
    ]);
    expect(records.filter((record) => record.aiText === '重复的 AI 返回')).toHaveLength(1);
  });
});
