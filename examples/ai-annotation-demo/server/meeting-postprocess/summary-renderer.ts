import type { MeetingSummaryCardsV2 } from './contracts';
import { templateSummaryLayers } from '../../src/features/meeting/template-summary-presentation';

function durationLabel(durationMs: number | null): string {
  if (durationMs === null) return '未记录';
  const minutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${minutes} 分钟`;
}

export function renderMeetingSummary(cards: MeetingSummaryCardsV2): string {
  const interview = cards.template_id === 'interview_memo';
  const layers = templateSummaryLayers(cards).map((layer) => [
    layer.title ? `## ${layer.title}` : '',
    ...layer.blocks.map((block) => [`### ${block.title}`, block.paragraph || '', block.rows.map((row) => `- ${row}`).join('\n')].filter(Boolean).join('\n\n')),
  ].filter(Boolean).join('\n\n'));
  const sections = [
    `| ${interview ? '访谈时间' : '会议时间'} | ${cards.meeting_metadata.started_at ? new Date(cards.meeting_metadata.started_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录'} |\n| --- | --- |\n| ${interview ? '访谈时长' : '会议时长'} | ${durationLabel(cards.meeting_metadata.duration_ms)} |\n| ${interview ? '参与人员' : '参会人员'} | ${cards.meeting_metadata.participants.join('、') || '未记录'} |`,
    ...layers,
  ].filter(Boolean);
  const title = cards.theme || '会议纪要';
  return `# ${title}\n\n${sections.join('\n\n')}`.trim();
}
