import type { MeetingMindMapV1, MeetingSummaryCardsV2 } from './contracts';
import { meetingMindMapV1Schema } from './contracts';

export const MEETING_MIND_MAP_PROJECTION_VERSION = 'meeting_mind_map_projection_v1';

export function projectMeetingMindMap(
  cards: MeetingSummaryCardsV2,
  sourceFingerprint: string,
): MeetingMindMapV1 {
  const rootId = 'root';
  const nodes: MeetingMindMapV1['nodes'] = [{
    id: rootId,
    parent_id: null,
    kind: 'root',
    label: cards.theme || cards.overview || '会议纪要',
    evidence_refs: [],
  }];
  const sections: Array<{
    id: string;
    label: string;
    kind: MeetingMindMapV1['nodes'][number]['kind'];
    items: Array<{ id: string; label: string; evidence_refs: string[] }>;
  }> = [
    { id: 'key-points', label: cards.section_titles?.discussion || '关键讨论要点', kind: 'point', items: cards.key_points.map((item) => ({ id: item.id, label: item.text, evidence_refs: item.evidence_refs })) },
    { id: 'decisions', label: '结论与决策', kind: 'decision', items: cards.decisions.map((item) => ({ id: item.id, label: item.text, evidence_refs: item.evidence_refs })) },
    { id: 'actions', label: cards.section_titles?.next_steps || '后续步骤与提醒', kind: 'action', items: cards.action_items.map((item) => ({ id: item.id, label: item.task, evidence_refs: item.evidence_refs })) },
    { id: 'risks', label: '风险与提醒', kind: 'risk', items: cards.risks.map((item) => ({ id: item.id, label: item.text, evidence_refs: item.evidence_refs })) },
    { id: 'questions', label: '待确认问题', kind: 'question', items: cards.open_questions.map((item) => ({ id: item.id, label: item.text, evidence_refs: item.evidence_refs })) },
    { id: 'notes', label: '个人重点', kind: 'note', items: cards.personal_notes.map((item) => ({ id: item.id, label: item.text, evidence_refs: [...item.mark_refs, ...item.supporting_utterance_refs] })) },
  ];

  for (const section of sections.filter((item) => item.items.length > 0)) {
    nodes.push({ id: `section:${section.id}`, parent_id: rootId, kind: 'section', label: section.label, evidence_refs: [] });
    for (const item of section.items) {
      nodes.push({
        id: `${section.id}:${item.id}`,
        parent_id: `section:${section.id}`,
        kind: section.kind,
        label: item.label,
        evidence_refs: [...item.evidence_refs],
      });
    }
  }

  return meetingMindMapV1Schema.parse({
    schema_version: '1.0',
    source: 'meeting.summary_cards',
    source_fingerprint: sourceFingerprint,
    nodes,
  });
}
