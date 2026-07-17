import { isUnrecognizedHandwritingText } from '../../app/mark-text';
import { markTime } from '../../core/mark-time';
import type { PersistedMark, PersistedMeeting } from '../../core/store-format';
import { meetingMarkPhase } from '../../mobile/meeting-home-model';

export interface MeetingHandwritingSections {
  pre_meeting: string[];
  in_meeting: Array<{ relative_time: string; text: string }>;
  post_meeting: string[];
}

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

/** 设备端思路总结与 hub 自动总结共用的三段手写组料。 */
export function buildMeetingHandwritingSections(
  meeting: PersistedMeeting,
  marks: PersistedMark[],
  t0AbsMs: number,
  offsetMs = 0,
): MeetingHandwritingSections {
  const sections: MeetingHandwritingSections = { pre_meeting: [], in_meeting: [], post_meeting: [] };
  for (const mark of [...marks].sort((left, right) => markTime(left) - markTime(right))) {
    const text = handwritingContent(mark);
    switch (meetingMarkPhase(mark, meeting)) {
      case 'pre':
        sections.pre_meeting.push(text);
        break;
      case 'in':
        sections.in_meeting.push({ relative_time: relativeClock(markTime(mark) - t0AbsMs - offsetMs), text });
        break;
      case 'post':
        sections.post_meeting.push(text);
        break;
    }
  }
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
  return lines;
}
