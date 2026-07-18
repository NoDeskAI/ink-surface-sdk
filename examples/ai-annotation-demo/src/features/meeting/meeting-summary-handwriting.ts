import { isUnrecognizedHandwritingText } from '../../app/mark-text';
import { markTime } from '../../core/mark-time';
import type { PersistedMark, PersistedMeeting } from '../../core/store-format';
import { meetingMarkPhase } from '../../mobile/meeting-home-model';

export interface MeetingHandwritingSections {
  pre_meeting: string[];
  in_meeting: Array<{ relative_time: string; text: string }>;
  post_meeting: string[];
  omitted_count?: Partial<Record<'pre_meeting' | 'in_meeting' | 'post_meeting', number>>;
}

export const MEETING_HANDWRITING_MAX_CHARS = 8_000;
export const MEETING_HANDWRITING_MAX_ITEMS = 80;
export const MEETING_HANDWRITING_MAX_ITEM_CHARS = 500;

type HandwritingPhase = 'pre_meeting' | 'in_meeting' | 'post_meeting';
type HandwritingCandidate = { relative_time?: string; text: string; truncated: boolean };
type HandwritingAllocation = {
  source: HandwritingCandidate[];
  selected: HandwritingCandidate[];
  cursor: number;
  truncatedItems: number;
};

const PHASE_ORDER: HandwritingPhase[] = ['in_meeting', 'pre_meeting', 'post_meeting'];
const PHASE_ITEM_BUDGET: Record<HandwritingPhase, number> = { pre_meeting: 16, in_meeting: 48, post_meeting: 16 };
const PHASE_CHAR_BUDGET: Record<HandwritingPhase, number> = { pre_meeting: 1_600, in_meeting: 4_800, post_meeting: 1_600 };

function relativeClock(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  const negative = ms < 0 && seconds > 0;
  return `${negative ? '-' : ''}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function handwritingContent(mark: PersistedMark): string {
  const text = (mark.marked_text || '').trim();
  if (isUnrecognizedHandwritingText(mark)) return '（一处无法识别的手写·别推断其文字含义）';
  return text || `（一处${mark.feature_type === 'drawing' ? '图形/圈画' : '无法识别的手写'}·别推断其文字含义）`;
}

function truncateHandwritingText(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  if (limit <= 1) return { text: '…'.slice(0, limit), truncated: true };
  return { text: `${value.slice(0, limit - 1)}…`, truncated: true };
}

function candidateCost(candidate: HandwritingCandidate): number {
  return candidate.text.length + (candidate.relative_time?.length ?? 0);
}

function takeWholeCandidate(allocation: HandwritingAllocation, charLimit: number, itemLimit: number): number {
  const candidate = allocation.source[allocation.cursor];
  if (!candidate || allocation.selected.length >= itemLimit || candidateCost(candidate) > charLimit) return 0;
  allocation.selected.push(candidate);
  allocation.cursor += 1;
  if (candidate.truncated) allocation.truncatedItems += 1;
  return candidateCost(candidate);
}

function takeFinalCandidate(allocation: HandwritingAllocation, charLimit: number): number {
  const candidate = allocation.source[allocation.cursor];
  const clockChars = candidate?.relative_time?.length ?? 0;
  if (!candidate || charLimit <= clockChars) return 0;
  const clipped = truncateHandwritingText(candidate.text, Math.min(MEETING_HANDWRITING_MAX_ITEM_CHARS, charLimit - clockChars));
  allocation.selected.push({ ...candidate, text: clipped.text, truncated: candidate.truncated || clipped.truncated });
  allocation.cursor += 1;
  allocation.truncatedItems += 1;
  return clockChars + clipped.text.length;
}

function allocateHandwritingCandidates(
  candidates: Record<HandwritingPhase, HandwritingCandidate[]>,
): Record<HandwritingPhase, HandwritingAllocation> {
  const allocation = (phase: HandwritingPhase): HandwritingAllocation => ({
    source: candidates[phase], selected: [], cursor: 0, truncatedItems: 0,
  });
  const allocations: Record<HandwritingPhase, HandwritingAllocation> = {
    pre_meeting: allocation('pre_meeting'),
    in_meeting: allocation('in_meeting'),
    post_meeting: allocation('post_meeting'),
  };
  let usedChars = 0;
  let usedItems = 0;

  // 会中是总结主证据，预留 60%；会前/会后各留 20%，避免任一长段按输入顺序挤掉其他阶段。
  for (const phase of PHASE_ORDER) {
    let phaseChars = 0;
    while (allocations[phase].selected.length < PHASE_ITEM_BUDGET[phase]) {
      const used = takeWholeCandidate(
        allocations[phase],
        PHASE_CHAR_BUDGET[phase] - phaseChars,
        PHASE_ITEM_BUDGET[phase],
      );
      if (!used) break;
      phaseChars += used;
      usedChars += used;
      usedItems += 1;
    }
  }

  // 空闲额度按会中、会前、会后轮转复用；只有总预算最后一条允许二次截断。
  let progressed = true;
  while (progressed && usedItems < MEETING_HANDWRITING_MAX_ITEMS && usedChars < MEETING_HANDWRITING_MAX_CHARS) {
    progressed = false;
    for (const phase of PHASE_ORDER) {
      if (usedItems >= MEETING_HANDWRITING_MAX_ITEMS || usedChars >= MEETING_HANDWRITING_MAX_CHARS) break;
      const allocation = allocations[phase];
      const remainingChars = MEETING_HANDWRITING_MAX_CHARS - usedChars;
      const used = takeWholeCandidate(allocation, remainingChars, MEETING_HANDWRITING_MAX_ITEMS)
        || takeFinalCandidate(allocation, remainingChars);
      if (!used) continue;
      usedChars += used;
      usedItems += 1;
      progressed = true;
    }
  }
  return allocations;
}

/** 设备端思路总结与 hub 自动总结共用的三段手写组料。 */
export function buildMeetingHandwritingSections(
  meeting: PersistedMeeting,
  marks: PersistedMark[],
  t0AbsMs: number,
  offsetMs = 0,
): MeetingHandwritingSections {
  const candidates: Record<HandwritingPhase, HandwritingCandidate[]> = { pre_meeting: [], in_meeting: [], post_meeting: [] };
  for (const mark of [...marks].sort((left, right) => markTime(left) - markTime(right))) {
    const content = truncateHandwritingText(handwritingContent(mark), MEETING_HANDWRITING_MAX_ITEM_CHARS);
    switch (meetingMarkPhase(mark, meeting)) {
      case 'pre':
        candidates.pre_meeting.push({ ...content });
        break;
      case 'in':
        candidates.in_meeting.push({ relative_time: relativeClock(markTime(mark) - t0AbsMs - offsetMs), ...content });
        break;
      case 'post':
        candidates.post_meeting.push({ ...content });
        break;
    }
  }
  const allocations = allocateHandwritingCandidates(candidates);
  const sections: MeetingHandwritingSections = {
    pre_meeting: allocations.pre_meeting.selected.map((item) => item.text),
    in_meeting: allocations.in_meeting.selected.map((item) => ({ relative_time: item.relative_time || '0:00', text: item.text })),
    post_meeting: allocations.post_meeting.selected.map((item) => item.text),
  };
  const omittedCount = Object.fromEntries((Object.keys(allocations) as HandwritingPhase[]).flatMap((phase) => {
    const count = allocations[phase].source.length - allocations[phase].selected.length + allocations[phase].truncatedItems;
    return count > 0 ? [[phase, count]] : [];
  })) as NonNullable<MeetingHandwritingSections['omitted_count']>;
  if (Object.keys(omittedCount).length) sections.omitted_count = omittedCount;
  return sections;
}

export function hasMeetingHandwritingSections(sections: MeetingHandwritingSections): boolean {
  return sections.pre_meeting.length > 0 || sections.in_meeting.length > 0 || sections.post_meeting.length > 0;
}

export function meetingHandwritingSectionLines(sections: MeetingHandwritingSections): string[] {
  const lines: string[] = [];
  if (sections.pre_meeting.length) {
    lines.push('会前准备（不参与转写时间对齐）：');
    for (const text of sections.pre_meeting) lines.push(`- ${text}`);
  }
  if (sections.in_meeting.length) {
    lines.push('会中手记：');
    for (const item of sections.in_meeting) lines.push(`[${item.relative_time}] ${item.text}`);
  }
  if (sections.post_meeting.length) {
    lines.push('会后补充（不参与转写时间对齐）：');
    for (const text of sections.post_meeting) lines.push(`- ${text}`);
  }
  if (sections.omitted_count) {
    const labels: Record<HandwritingPhase, string> = { pre_meeting: '会前', in_meeting: '会中', post_meeting: '会后' };
    const detail = (Object.keys(labels) as HandwritingPhase[]).flatMap((phase) => {
      const count = sections.omitted_count?.[phase] ?? 0;
      return count > 0 ? [`${labels[phase]} ${count} 条`] : [];
    });
    if (detail.length) lines.push(`（手写组料已按预算裁剪：${detail.join('；')}）`);
  }
  return lines;
}
