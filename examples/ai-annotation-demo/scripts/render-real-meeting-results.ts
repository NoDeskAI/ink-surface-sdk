import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = resolve('examples/ai-annotation-demo/.inkloop/real-meeting-tests');
const sources: Record<string, string> = {
  '011ab3f6b886': `${base}/cold-benchmark-2026-07-22-budget-v2/results/011ab3f6b886.json`,
  '09e5493239e5': `${base}/cold-benchmark-2026-07-22-production-chunks/results/09e5493239e5.json`,
  '9f06ee3208b6': `${base}/cold-benchmark-2026-07-22-budget-v2/results/9f06ee3208b6.json`,
  'c6cdbefb565d': `${base}/cold-benchmark-2026-07-22-budget-v2/results/c6cdbefb565d.json`,
  'eab7664919c6': `${base}/cold-benchmark-2026-07-22-normalized/results/eab7664919c6.json`,
};
const outDir = `${base}/最终5份会议纪要-2026-07-22`;
mkdirSync(outDir, { recursive: true });
const rows: Array<Record<string, unknown>> = [];
const vaultManifest = JSON.parse(readFileSync(`${base}/server-snapshot/local-vault-user/latest.json`, 'utf8'));
const meetingDateByHash = new Map<string, string>();
for (const asset of vaultManifest.assets || []) {
  const date = String(asset.path || '').match(/InkLoop\/Meetings\/(\d{4}-\d{2}-\d{2})\s/u)?.[1];
  const hash = String(asset.content_hash || '').replace(/^sha256:/u, '').slice(0, 12);
  if (date && hash) meetingDateByHash.set(hash, date);
}

function durationLabel(durationMs: number | null): string {
  if (durationMs === null) return '未记录';
  const minutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${minutes} 分钟`;
}

for (const [id, file] of Object.entries(sources)) {
  const output = JSON.parse(readFileSync(file, 'utf8'));
  const fixture = JSON.parse(readFileSync(`${base}/fixtures-review/${id}.json`, 'utf8'));
  const artifact = output.artifacts.find((item: any) => item.kind === 'meeting.summary_cards');
  if (!artifact) throw new Error(`missing cards: ${id}`);
  const cards = artifact.content;
  const titles = cards.section_titles || { background: '背景与概览', discussion: '关键讨论要点', next_steps: '后续步骤与提醒' };
  const titleDate = meetingDateByHash.get(id) || fixture.title.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || fixture.import_metadata?.meeting_date || null;
  const participants = [...new Set(fixture.utterances.map((item: any) => item.speaker)
    .filter((speaker: unknown): speaker is string => typeof speaker === 'string' && Boolean(speaker.trim()) && !/^(?:说话人|speaker)\s*\d+$/iu.test(speaker.trim())))] as string[];
  const timelineStart = fixture.utterances.length ? Math.min(...fixture.utterances.map((item: any) => item.start_ms)) : null;
  const timelineEnd = fixture.utterances.length ? Math.max(...fixture.utterances.map((item: any) => item.end_ms)) : null;
  const metadata = cards.meeting_metadata || {
    started_at: null,
    duration_ms: timelineStart === null || timelineEnd === null ? null : Math.max(0, timelineEnd - timelineStart),
    participants,
  };
  const known = new Set<string>(fixture.utterances.map((item: any) => item.id));
  const refs: string[] = [];
  for (const key of ['key_points', 'decisions', 'action_items', 'highlights', 'risks', 'open_questions']) {
    for (const item of cards[key] || []) refs.push(...(item.evidence_refs || []));
  }
  const invalid = [...new Set(refs.filter((ref) => !known.has(ref)))];
  if (invalid.length) throw new Error(`invalid evidence refs: ${id}`);
  const meetingTime = metadata.started_at
    ? new Date(metadata.started_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : titleDate ? `${titleDate}（具体时间未记录）` : '未记录';
  const visibleParticipants = (metadata.participants?.length ? metadata.participants : participants)
    .filter((speaker: string) => !/^(?:说话人|speaker)\s*\d+$/iu.test(speaker.trim()));
  let markdown = `# ${cards.theme || fixture.title}\n\n| 基本信息 | 内容 |\n| --- | --- |\n| 会议时间 | ${meetingTime} |\n| 会议时长 | ${durationLabel(metadata.duration_ms)} |\n| 参会人员 | ${visibleParticipants.join('、') || '未记录'} |\n\n## ${titles.background}\n\n${cards.overview || '（未生成）'}`;
  const discussion = [
    ...(cards.decisions || []).map((item: any) => `- ${item.status === 'tentative' ? '（暂定）' : ''}${item.text}`),
    ...(cards.key_points || []).map((item: any) => `- ${item.text}`),
    ...(cards.highlights || []).map((item: any) => `- ${item.text}`),
  ].slice(0, 5);
  if (discussion.length) markdown += `\n## ${titles.discussion}\n\n${discussion.join('\n')}`;
  const nextSteps = [
    ...(cards.action_items || []).map((item: any) => `- ${item.task}${item.owner ? `（负责人：${item.owner}` : ''}${item.due_at ? `${item.owner ? '；' : '（'}截止：${item.due_at}` : ''}${item.owner || item.due_at ? '）' : ''}${item.commitment === 'proposed' ? '（提议）' : ''}`),
    ...(cards.risks || []).map((item: any) => `- 风险：${item.text}${item.mitigation ? `（应对：${item.mitigation}）` : ''}`),
    ...(cards.open_questions || []).map((item: any) => `- 待确认：${item.text}`),
    ...(cards.personal_notes || []).map((item: any) => `- 提醒：${item.text}`),
  ].slice(0, 5);
  if (nextSteps.length) markdown += `\n## ${titles.next_steps}\n\n${nextSteps.join('\n')}`;
  const used = [...new Set(refs)];
  markdown += '\n';
  const safeTitle = fixture.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const outputPath = `${outDir}/${id}-${safeTitle}.md`;
  writeFileSync(outputPath, markdown, { mode: 0o600 });
  rows.push({ id, title: fixture.title, file: outputPath, utterances: fixture.utterances.length, wall_time_ms: output.wall_time_ms, source_bytes: fixture.import_metadata.source_bytes, cards_bytes: artifact.bytes, model_calls: output.model_calls, evidence_refs: refs.length, unique_evidence_refs: used.length });
}
writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
const index = `# 最终 5 份会议纪要\n\n这是 2026-07-22 最终优化版本生成的可阅读结果。目录内只有本页、5 份会议纪要和机器可读清单。\n\n${rows.map((row, index) => `${index + 1}. [${row.title}](./${String(row.file).split('/').at(-1)}) — ${row.utterances} 条发言，${(Number(row.wall_time_ms) / 1000).toFixed(1)} 秒`).join('\n')}\n`;
writeFileSync(`${outDir}/README.md`, index, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
