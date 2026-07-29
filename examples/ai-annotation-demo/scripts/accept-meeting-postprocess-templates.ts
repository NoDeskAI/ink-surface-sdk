import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MeetingSummaryCardsV2 } from '../server/meeting-postprocess/contracts';
import { MEETING_POSTPROCESS_TEMPLATES, MEETING_TEMPLATE_IDS, type MeetingTemplateId } from '../server/meeting-postprocess/templates';
import { debugMeetingPostprocess } from './debug-meeting-postprocess';

interface Fixture {
  title: string;
  started_at_ms?: number;
  utterances: Array<{ id?: string; start_ms: number; end_ms: number; text: string }>;
}

interface DebugArtifact {
  kind: string;
  status: string;
  bytes: number;
  content: unknown;
}

interface AcceptanceRow {
  template_id: MeetingTemplateId;
  template_label: string;
  status: 'passed' | 'failed';
  wall_time_ms: number;
  model_calls: number;
  cards_bytes: number;
  evidence_refs: number;
  invalid_evidence_refs: string[];
  file: string;
  error?: string;
}

function option(args: string[], name: string): string | undefined {
  return args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function selectedTemplates(args: string[]): MeetingTemplateId[] {
  const values = (option(args, 'templates') || 'all').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 1 && values[0] === 'all') return [...MEETING_TEMPLATE_IDS];
  for (const value of values) {
    if (!MEETING_TEMPLATE_IDS.includes(value as MeetingTemplateId)) throw new Error(`unknown meeting template: ${value}`);
  }
  return values as MeetingTemplateId[];
}

function fixtureDate(args: string[]): string | undefined {
  const value = option(args, 'meeting-date');
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`invalid meeting date: ${value}`);
  return value;
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-').slice(0, 80) || 'meeting';
}

function artifact(output: Record<string, unknown>, kind: string): DebugArtifact | undefined {
  return (output.artifacts as DebugArtifact[]).find((item) => item.kind === kind && item.status === 'ready');
}

function allEvidenceRefs(cards: MeetingSummaryCardsV2): string[] {
  return [cards.key_points, cards.decisions, cards.action_items, cards.highlights, cards.risks, cards.open_questions]
    .flatMap((items) => items.flatMap((item) => item.evidence_refs));
}

function readableResult(input: {
  fixture: Fixture;
  templateId: MeetingTemplateId;
  output: Record<string, unknown>;
  invalidRefs: string[];
  meetingDate?: string;
}): string {
  const cardsArtifact = artifact(input.output, 'meeting.summary_cards');
  const summaryArtifact = artifact(input.output, 'meeting.summary');
  const cards = cardsArtifact?.content as MeetingSummaryCardsV2 | undefined;
  const summary = typeof summaryArtifact?.content === 'string'
    ? input.meetingDate
      ? summaryArtifact.content.replace('| 会议时间 | 未记录 |', `| 会议时间 | ${input.meetingDate}（具体时间未记录） |`)
      : summaryArtifact.content
    : '（生成失败）';
  const durations = (input.output.model_call_durations_ms as number[] || []).map((value) => `${(value / 1_000).toFixed(1)}s`).join('、') || 'mock/未记录';
  const checks = [
    `- [${cards ? 'x' : ' '}] 快速纪要 Cards 已生成`,
    `- [${summaryArtifact ? 'x' : ' '}] 可读摘要已生成`,
    `- [${input.invalidRefs.length === 0 ? 'x' : ' '}] 证据引用全部有效${input.invalidRefs.length ? `：${input.invalidRefs.join('、')}` : ''}`,
  ];
  return [
    `# ${MEETING_POSTPROCESS_TEMPLATES[input.templateId].label}｜${input.fixture.title}`,
    '',
    `- 模板：\`${input.templateId}\` / \`${MEETING_POSTPROCESS_TEMPLATES[input.templateId].version}\``,
    `- 输入：${input.fixture.utterances.length} 条发言`,
    `- 总耗时：${(Number(input.output.wall_time_ms) / 1_000).toFixed(1)}s`,
    `- 模型调用：${input.output.model_calls} 次（${durations}）`,
    `- Cards 大小：${cardsArtifact?.bytes || 0} B`,
    '',
    '## 自动检查',
    '',
    ...checks,
    '',
    '## 快速纪要',
    '',
    summary,
    '',
  ].join('\n');
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index]);
    }
  }));
  return results;
}

export async function acceptMeetingPostprocessTemplates(
  args = process.argv.slice(2),
  runPostprocess: typeof debugMeetingPostprocess = debugMeetingPostprocess,
): Promise<{ output_dir: string; rows: AcceptanceRow[] }> {
  const fixturePath = resolve(args.find((value) => !value.startsWith('--')) || 'fixtures/meeting-postprocess/ordinary.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const meetingDate = fixtureDate(args);
  const outputDir = resolve(option(args, 'output-dir') || `.inkloop/meeting-postprocess-acceptance/${safeFilePart(fixture.title)}-${Date.now()}`);
  const templates = selectedTemplates(args);
  const concurrencyValue = Number(option(args, 'concurrency') || 2);
  const concurrency = Number.isInteger(concurrencyValue) && concurrencyValue > 0 && concurrencyValue <= 5 ? concurrencyValue : 2;
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const passthrough = args.filter((value) => value.startsWith('--conclusion=') || value.startsWith('--impression=') || value.startsWith('--pain-point='));
  const rows = await mapWithConcurrency(templates, concurrency, async (templateId): Promise<AcceptanceRow> => {
    const label = MEETING_POSTPROCESS_TEMPLATES[templateId].label;
    const fileName = `${String(templates.indexOf(templateId) + 1).padStart(2, '0')}-${templateId}-${safeFilePart(label)}.md`;
    try {
      const output = await runPostprocess([
        fixturePath,
        `--template=${templateId}`,
        ...(args.includes('--real-model') ? ['--real-model'] : []),
        '--production-chunks',
        ...passthrough,
      ]);
      const cardsArtifact = artifact(output, 'meeting.summary_cards');
      if (!cardsArtifact) throw new Error('meeting.summary_cards was not generated');
      const cards = cardsArtifact.content as MeetingSummaryCardsV2;
      const known = new Set(fixture.utterances.map((item) => item.id).filter((id): id is string => Boolean(id)));
      const refs = allEvidenceRefs(cards);
      const invalidRefs = [...new Set(refs.filter((ref) => !known.has(ref)))];
      writeFileSync(resolve(outputDir, fileName), readableResult({ fixture, templateId, output, invalidRefs, meetingDate }), { mode: 0o600 });
      return { template_id: templateId, template_label: label, status: invalidRefs.length ? 'failed' : 'passed', wall_time_ms: Number(output.wall_time_ms), model_calls: Number(output.model_calls), cards_bytes: cardsArtifact.bytes, evidence_refs: refs.length, invalid_evidence_refs: invalidRefs, file: fileName };
    } catch (error) {
      const message = String((error as Error)?.message || error);
      writeFileSync(resolve(outputDir, fileName), `# ${label}｜${fixture.title}\n\n生成失败：${message}\n`, { mode: 0o600 });
      return { template_id: templateId, template_label: label, status: 'failed', wall_time_ms: 0, model_calls: 0, cards_bytes: 0, evidence_refs: 0, invalid_evidence_refs: [], file: fileName, error: message };
    }
  });
  const table = rows.map((row) => `| [${row.template_label}](./${row.file}) | ${row.status === 'passed' ? '通过' : '失败'} | ${(row.wall_time_ms / 1_000).toFixed(1)}s | ${row.model_calls} | ${row.cards_bytes} B | ${row.evidence_refs} |`).join('\n');
  const readme = [
    `# ${templates.length === 1 ? '单模板' : '五模板'}后处理验收｜${fixture.title}`,
    '',
    `输入文件：\`${basename(fixturePath)}\`，共 ${fixture.utterances.length} 条发言。`,
    '',
    '| 模板 | 状态 | 耗时 | 模型调用 | Cards | 证据引用 |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    table,
    '',
    '建议依次检查：事实准确性、模板差异、重点是否遗漏、是否虚构 owner/due，以及信息密度是否合适。',
    '',
  ].join('\n');
  writeFileSync(resolve(outputDir, 'README.md'), readme, { mode: 0o600 });
  writeFileSync(resolve(outputDir, 'manifest.json'), `${JSON.stringify({ fixture: fixturePath, title: fixture.title, utterances: fixture.utterances.length, rows }, null, 2)}\n`, { mode: 0o600 });
  return { output_dir: outputDir, rows };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  acceptMeetingPostprocessTemplates().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.rows.some((row) => row.status === 'failed')) process.exitCode = 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
