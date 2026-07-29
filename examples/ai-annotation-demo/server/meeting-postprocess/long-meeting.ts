import type { MeetingSummaryExtraction, MeetingUtterance } from './contracts';
import { sha256 } from './identity';

export interface UtteranceChunk { id: string; hash: string; utterances: MeetingUtterance[]; start_ms: number; end_ms: number }

export function chunkUtterances(input: MeetingUtterance[], maxChars = 12_000, overlap = 2): UtteranceChunk[] {
  const sorted = [...input].sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
  const chunks: UtteranceChunk[] = [];
  let cursor = 0;
  while (cursor < sorted.length) {
    let end = cursor;
    let chars = 0;
    while (end < sorted.length && (chars === 0 || chars + sorted[end].text.length <= maxChars)) chars += sorted[end++].text.length;
    const utterances = sorted.slice(cursor, end);
    const hash = sha256(utterances.map(({ id, revision, start_ms, end_ms, speaker_id, speaker_name, text }) => ({ id, revision, start_ms, end_ms, speaker_id, speaker_name, text })));
    chunks.push({ id: `chunk_${chunks.length + 1}_${hash.slice(0, 10)}`, hash, utterances, start_ms: utterances[0].start_ms, end_ms: utterances.at(-1)?.end_ms || utterances[0].end_ms });
    if (end >= sorted.length) break;
    cursor = Math.max(cursor + 1, end - Math.max(0, overlap));
  }
  return chunks;
}

function uniqueByText<T extends { id: string }>(items: T[], text: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = text(item).toLowerCase().replace(/[\s，。！？、,.!?;；:：]+/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 分块候选的确定性归并。事实只去除完全等价的重复，不擅自把 tentative 升级为 confirmed。 */
export function reduceExtractions(parts: MeetingSummaryExtraction[]): MeetingSummaryExtraction {
  return {
    theme: parts.map((part) => part.theme).find(Boolean) || '',
    overview: parts.map((part) => part.overview).find(Boolean) || '',
    section_titles: parts.map((part) => part.section_titles).find(Boolean) || { background: '背景与概览', discussion: '关键讨论要点', next_steps: '后续步骤与提醒' },
    key_points: uniqueByText(parts.flatMap((part) => part.key_points), (item) => item.text).slice(0, 30),
    decisions: uniqueByText(parts.flatMap((part) => part.decisions), (item) => `${item.status}:${item.text}`).slice(0, 30),
    action_items: uniqueByText(parts.flatMap((part) => part.action_items), (item) => `${item.commitment}:${item.task}:${item.owner || ''}:${item.due_at || ''}`).slice(0, 50),
    highlights: uniqueByText(parts.flatMap((part) => part.highlights), (item) => item.text).slice(0, 30),
    risks: uniqueByText(parts.flatMap((part) => part.risks), (item) => `${item.text}:${item.mitigation || ''}`).slice(0, 30),
    open_questions: uniqueByText(parts.flatMap((part) => part.open_questions), (item) => item.text).slice(0, 30),
    personal_notes: uniqueByText(parts.flatMap((part) => part.personal_notes), (item) => `${item.kind}:${item.text}`).slice(0, 50),
    template_sections: parts.flatMap((part) => part.template_sections).reduce<MeetingSummaryExtraction['template_sections']>((sections, section) => {
      const existing = sections.find((candidate) => candidate.id === section.id);
      if (!existing) sections.push({ ...section, items: uniqueByText(section.items, (item) => `${item.label || ''}:${item.speaker || ''}:${item.text}`) });
      else {
        existing.summary ||= section.summary;
        existing.items = uniqueByText([...existing.items, ...section.items], (item) => `${item.label || ''}:${item.speaker || ''}:${item.text}`).slice(0, 12);
      }
      return sections;
    }, []).slice(0, 16),
  };
}
