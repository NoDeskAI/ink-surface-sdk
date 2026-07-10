import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-launch-day-command-center';
const outJsonPath = `${outDir}/command-center.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const sourcePaths = {
  launchFreezePack: 'test-results/ai-pen-kickstarter-launch-freeze/launch-freeze.json',
  publicCopyLock: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
  riskRegister: 'test-results/ai-pen-kickstarter-risk-register/risk-register.json',
  proofShotAudit: 'test-results/ai-pen-kickstarter-proof-shot-audit/report.json',
  launchSignoffAudit: 'test-results/ai-pen-kickstarter-launch-signoff-audit/report.json',
  launchFreezeSignoff: 'docs/project/inkloop-ai-pen-kickstarter/evidence/launch-freeze-signoff.md',
  gtmMetricsTracker: 'docs/project/inkloop-ai-pen-kickstarter/evidence/gtm-metrics-tracker.md',
  kickstarterPageChecklist: 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md',
  campaignPageDraft: 'docs/project/inkloop-ai-pen-kickstarter/campaign/kickstarter-page-draft.md',
  rewardsFaqDraft: 'docs/project/inkloop-ai-pen-kickstarter/campaign/rewards-faq-draft.md',
  launchDayCommsPack: 'docs/project/inkloop-ai-pen-kickstarter/campaign/launch-day-comms-pack.md',
  sourceGtmPlan: 'docs/project/inkloop-ai-pen-kickstarter/source/06_Kickstarter_GTM与众筹页面方案.md',
};

const launchDayTimeline = [
  {
    time: 'T-24h',
    checklist_item: 'Seed user launch email prepared',
    owner: 'GTM',
    action: 'Send or schedule seed-user email with launch time, reward tiers, and Early Bird quantity.',
    required_evidence: 'email draft, send list, sender, and send time',
  },
  {
    time: 'T-24h',
    checklist_item: 'Trial user reminder prepared',
    owner: 'GTM',
    action: 'Remind trial users to comment or share after launch.',
    required_evidence: 'trial-user reminder draft and consent-backed contact segment',
  },
  {
    time: 'T-24h',
    checklist_item: 'Comment FAQ template prepared',
    owner: 'Campaign / Ops',
    action: 'Prepare comment-area FAQ templates for compatibility, Surface limits, privacy, delivery, refunds, AI review, and risks.',
    required_evidence: 'comment FAQ script or support macro file',
  },
  {
    time: 'T-24h',
    checklist_item: 'Page rewards shipping risk and video final check complete',
    owner: 'Campaign / Ops',
    action: 'Check page, rewards, shipping, risk disclosures, and video playback before manual launch.',
    required_evidence: 'final page QA checklist and reviewer notes',
  },
  {
    time: 'T-24h',
    checklist_item: 'Founder and team online shift confirmed',
    owner: 'Founder / Ops',
    action: 'Confirm founder and response team online coverage for launch day.',
    required_evidence: 'launch-room roster and escalation path',
  },
  {
    time: 'T-2h',
    checklist_item: 'Launch soon email prepared',
    owner: 'GTM',
    action: 'Send the final launch-soon email.',
    required_evidence: 'launch-soon email draft and send target',
  },
  {
    time: 'T',
    checklist_item: 'Manual Kickstarter launch owner assigned',
    owner: 'Founder / Campaign',
    action: 'Manually launch the Kickstarter project; Kickstarter launch cannot be scheduled automatically.',
    required_evidence: 'assigned launch operator and final Go/No-Go signoff',
  },
  {
    time: 'T+5m',
    checklist_item: 'Email blast prepared',
    owner: 'GTM',
    action: 'Send launch email blast.',
    required_evidence: 'email blast draft, segment, and send confirmation plan',
  },
  {
    time: 'T+15m',
    checklist_item: 'Social posts prepared',
    owner: 'Campaign',
    action: 'Publish social posts.',
    required_evidence: 'social copy, assets, accounts, and posting owner',
  },
  {
    time: 'T+30m',
    checklist_item: 'Seed supporter outreach prepared',
    owner: 'GTM',
    action: 'DM seed supporters.',
    required_evidence: 'seed supporter list and message template',
  },
  {
    time: 'T+1h',
    checklist_item: 'Comment FAQ response rotation prepared',
    owner: 'Campaign / Ops',
    action: 'Run first comment-area response pass.',
    required_evidence: 'FAQ response rotation and escalation path',
  },
  {
    time: 'T+3h',
    checklist_item: 'Short demo clip prepared',
    owner: 'Campaign',
    action: 'Publish short demo clip.',
    required_evidence: 'approved short demo clip and caption',
  },
  {
    time: 'T+6h',
    checklist_item: 'First progress update and FAQ supplement prepared',
    owner: 'Campaign / Ops',
    action: 'Publish first progress update and FAQ supplement.',
    required_evidence: 'progress update draft and FAQ delta',
  },
  {
    time: 'T+12h',
    checklist_item: 'Conversion review and top FAQ adjustment prepared',
    owner: 'GTM / Campaign',
    action: 'Review conversion and adjust top-page FAQ.',
    required_evidence: 'conversion snapshot and top FAQ edit notes',
  },
  {
    time: 'T+24h',
    checklist_item: 'First-day thank-you update prepared',
    owner: 'Campaign',
    action: 'Publish first-day thank-you update.',
    required_evidence: 'thank-you update draft and first-day metrics',
  },
  {
    time: 'First 24h',
    checklist_item: 'Support escalation path prepared',
    owner: 'Ops',
    action: 'Keep support escalation path active for payment, delivery, refund, AI/privacy, and hardware questions.',
    required_evidence: 'support owner roster and escalation rules',
  },
];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJsonSource(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { path: relativePath, available: false, error: `missing source file: ${relativePath}`, data: null };
  }
  try {
    return { path: relativePath, available: true, error: null, data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')) };
  } catch (error) {
    return { path: relativePath, available: false, error: `unreadable source file: ${relativePath}: ${error.message}`, data: null };
  }
}

function readTextSource(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { path: relativePath, available: false, error: `missing source file: ${relativePath}`, text: '' };
  }
  try {
    return { path: relativePath, available: true, error: null, text: readFileSync(absolute(relativePath), 'utf8') };
  } catch (error) {
    return { path: relativePath, available: false, error: `unreadable source file: ${relativePath}: ${error.message}`, text: '' };
  }
}

function sourceMap(sources) {
  return Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [
      key,
      {
        path: source.path,
        available: source.available,
        error: source.error,
      },
    ]),
  );
}

function sourceIssues(sources) {
  return Object.values(sources)
    .filter((source) => !source.available)
    .map((source) => source.error);
}

function parseFieldTable(markdown) {
  const fields = {};
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || /^\|\s*-+/.test(trimmed)) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const [key, value] = cells;
    if (!key || key.toLowerCase() === 'field' || key.toLowerCase() === 'question') continue;
    fields[key] = value;
  }
  return fields;
}

function parseLineValue(markdown, label) {
  const prefix = `${label}:`;
  const line = markdown.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : 'missing';
}

function parseTableAfterHeading(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const tableLines = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (tableLines.length === 0 && !trimmed.startsWith('|')) continue;
    if (!trimmed.startsWith('|')) break;
    tableLines.push(trimmed);
  }
  if (tableLines.length < 3) return [];
  const headers = tableLines[0]
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  return tableLines.slice(2).map((line) => {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

function valueIsReady(value) {
  return Boolean(value) && !/\bTBD\b|not ready|missing|blocked|unknown|rejected/i.test(value);
}

function decisionIsReady(value) {
  return Boolean(value) && /^ready\b|^approved\b/i.test(value.trim()) && !/not ready|conditional|draft|TBD/i.test(value);
}

function buildTimelineTasks(signoffRows) {
  const rowsByItem = new Map(signoffRows.map((row) => [row['Checklist Item'], row]));
  return launchDayTimeline.map((item) => {
    const signoff = rowsByItem.get(item.checklist_item);
    const status = signoff?.Status ?? 'missing';
    const evidenceLink = signoff?.['Evidence Link'] ?? 'missing';
    const ready = valueIsReady(status) && valueIsReady(evidenceLink);
    return {
      ...item,
      signoff_status: status,
      evidence_link: evidenceLink,
      notes: signoff?.Notes ?? '',
      status: ready ? 'ready' : 'not_ready',
      blockers: ready ? [] : [`status: ${status}`, `evidence link: ${evidenceLink}`],
    };
  });
}

function statusFor({ accessIssues, launchFreezePack, launchSignoffAudit, signoffFields, tasks }) {
  if (accessIssues.length > 0) return 'launch_day_missing_sources';
  if (launchFreezePack?.status !== 'launch_freeze_ready') return 'launch_day_blocked_by_launch_freeze';
  if (launchSignoffAudit?.status !== 'launch_signoff_ready') return 'launch_day_blocked_by_signoff';
  const signoffReady = decisionIsReady(signoffFields['Final launch decision']) && valueIsReady(signoffFields['Manual launch operator']) && valueIsReady(signoffFields['Launch room coverage']);
  if (signoffReady && tasks.every((task) => task.status === 'ready')) return 'launch_day_ready';
  return 'launch_day_not_ready';
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, targetPath)})`;
}

function timelineRows(tasks) {
  return tasks
    .map(
      (task) =>
        `| ${task.time} | ${task.status} | ${task.owner} | ${task.action} | ${task.required_evidence} | ${task.signoff_status} | ${task.evidence_link} |`,
    )
    .join('\n');
}

function blockerRows(tasks) {
  const blocked = tasks.filter((task) => task.status !== 'ready');
  if (!blocked.length) return '| n/a | n/a | n/a |';
  return blocked.map((task) => `| ${task.time} | ${task.checklist_item} | ${task.blockers.join('; ')} |`).join('\n');
}

function sourceRows(sources) {
  return Object.entries(sources)
    .map(([key, source]) => `| ${key} | ${source.available ? 'available' : 'missing'} | ${mdLink(source.path)} | ${source.error ?? 'none'} |`)
    .join('\n');
}

function readme(report) {
  const accessIssues = report.access_issues.length ? report.access_issues.map((issue) => `- ${issue}`).join('\n') : '- None';
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Launch Day Command Center

Schema: \`inkloop.kickstarter_launch_day_command_center.v1\`

Status: \`${report.status}\`

This command center turns the source launch-day plan into a refreshable operating package for the 2026-10-27 to 2026-10-30 Kickstarter launch window. It is not launch approval and it cannot replace the manual Kickstarter launch action.

## Snapshot

| Item | Value |
| --- | --- |
| Launch freeze status | ${report.snapshot.launch_freeze_status} |
| Launch freeze gates ready | ${report.snapshot.launch_freeze_ready_gate_count}/${report.snapshot.launch_freeze_gate_count} |
| Public copy lock status | ${report.snapshot.public_copy_lock_status} |
| Risk register status | ${report.snapshot.risk_register_status} |
| Open P0 risks | ${report.snapshot.open_p0_count}/${report.snapshot.risk_count} |
| Proof-shot audit status | ${report.snapshot.proof_shot_audit_status} |
| Launch signoff audit status | ${report.snapshot.launch_signoff_audit_status} |
| Owner signoffs ready | ${report.snapshot.launch_signoff_ready_owners}/${report.snapshot.launch_signoff_owners} |
| Signoff launch-day tasks ready | ${report.snapshot.launch_signoff_ready_tasks}/${report.snapshot.launch_signoff_tasks} |
| Human signoff status | ${report.snapshot.signoff_status} |
| Final launch decision | ${report.snapshot.final_launch_decision} |
| Manual launch operator | ${report.snapshot.manual_launch_operator} |
| Launch room coverage | ${report.snapshot.launch_room_coverage} |
| Launch-day comms pack status | ${report.snapshot.launch_day_comms_pack_status} |
| Timeline tasks ready | ${report.summary.ready_task_count}/${report.summary.task_count} |

## Launch-Day Timeline

| Time | Status | Owner | Action | Required Evidence | Signoff Status | Evidence Link |
| --- | --- | --- | --- | --- | --- | --- |
${timelineRows(report.timeline_tasks)}

## Current Blockers

| Time | Checklist Item | Blockers |
| --- | --- | --- |
${blockerRows(report.timeline_tasks)}

## Required Commands

${commands}

## Sources

| Source | State | Path | Error |
| --- | --- | --- | --- |
${sourceRows(report.sources)}

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Detailed JSON: [command-center.json](./command-center.json)
`;
}

const sources = {
  launchFreezePack: readJsonSource(sourcePaths.launchFreezePack),
  publicCopyLock: readJsonSource(sourcePaths.publicCopyLock),
  riskRegister: readJsonSource(sourcePaths.riskRegister),
  proofShotAudit: readJsonSource(sourcePaths.proofShotAudit),
  launchSignoffAudit: readJsonSource(sourcePaths.launchSignoffAudit),
  launchFreezeSignoff: readTextSource(sourcePaths.launchFreezeSignoff),
  gtmMetricsTracker: readTextSource(sourcePaths.gtmMetricsTracker),
  kickstarterPageChecklist: readTextSource(sourcePaths.kickstarterPageChecklist),
  campaignPageDraft: readTextSource(sourcePaths.campaignPageDraft),
  rewardsFaqDraft: readTextSource(sourcePaths.rewardsFaqDraft),
  launchDayCommsPack: readTextSource(sourcePaths.launchDayCommsPack),
  sourceGtmPlan: readTextSource(sourcePaths.sourceGtmPlan),
};

const accessIssues = sourceIssues(sources);
const signoffFields = parseFieldTable(sources.launchFreezeSignoff.text);
const signoffRows = parseTableAfterHeading(sources.launchFreezeSignoff.text, '## Launch-Day Readiness');
const timelineTasks = buildTimelineTasks(signoffRows);
const readyTaskCount = timelineTasks.filter((task) => task.status === 'ready').length;
const report = {
  schema: 'inkloop.kickstarter_launch_day_command_center.v1',
  generated_at: new Date().toISOString(),
  strict,
  status: statusFor({
    accessIssues,
    launchFreezePack: sources.launchFreezePack.data,
    launchSignoffAudit: sources.launchSignoffAudit.data,
    signoffFields,
    tasks: timelineTasks,
  }),
  sources: sourceMap(sources),
  access_issues: accessIssues,
  snapshot: {
    launch_freeze_status: sources.launchFreezePack.data?.status ?? 'unknown',
    launch_freeze_gate_count: sources.launchFreezePack.data?.summary?.gate_count ?? 0,
    launch_freeze_ready_gate_count: sources.launchFreezePack.data?.summary?.ready_gate_count ?? 0,
    public_copy_lock_status: sources.publicCopyLock.data?.status ?? 'unknown',
    risk_register_status: sources.riskRegister.data?.status ?? 'unknown',
    risk_count: sources.riskRegister.data?.summary?.risk_count ?? 0,
    open_p0_count: sources.riskRegister.data?.summary?.open_p0_count ?? 0,
    proof_shot_audit_status: sources.proofShotAudit.data?.status ?? 'unknown',
    launch_signoff_audit_status: sources.launchSignoffAudit.data?.status ?? 'unknown',
    launch_signoff_owners: sources.launchSignoffAudit.data?.summary?.owner_signoff_count ?? 0,
    launch_signoff_ready_owners: sources.launchSignoffAudit.data?.summary?.ready_owner_signoff_count ?? 0,
    launch_signoff_tasks: sources.launchSignoffAudit.data?.summary?.launch_day_task_count ?? 0,
    launch_signoff_ready_tasks: sources.launchSignoffAudit.data?.summary?.ready_launch_day_task_count ?? 0,
    signoff_status: signoffFields['Signoff status'] ?? 'missing',
    final_launch_decision: signoffFields['Final launch decision'] ?? 'missing',
    manual_launch_operator: signoffFields['Manual launch operator'] ?? 'missing',
    launch_room_coverage: signoffFields['Launch room coverage'] ?? 'missing',
    launch_day_comms_pack_status: parseLineValue(sources.launchDayCommsPack.text, 'Status'),
  },
  summary: {
    task_count: timelineTasks.length,
    ready_task_count: readyTaskCount,
    not_ready_task_count: timelineTasks.length - readyTaskCount,
  },
  timeline_tasks: timelineTasks,
  required_commands: [
    'npm run kickstarter:ops-refresh',
    'npm run kickstarter:launch-signoff-audit:strict',
    'npm run kickstarter:launch-freeze-pack:strict',
    'npm run kickstarter:launch-day-command-center',
    'npm run kickstarter:launch-day-command-center:strict',
  ],
  non_claims: [
    'This launch-day command center is not launch approval.',
    'Kickstarter launch is a manual action and cannot be treated as scheduled automation.',
    'Do not run launch-day communications until launch freeze, launch signoff audit, public copy lock, GTM evidence, and support coverage are ready.',
    'A launch-day comms pack draft is not approval to send email, social, comment, update, or support replies.',
    'Local demo readiness does not count as launch-day readiness.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter launch-day command center status: ${report.status}`);
console.log(`Timeline tasks ready: ${report.summary.ready_task_count}/${report.summary.task_count}`);
console.log(`Launch freeze: ${report.snapshot.launch_freeze_status}; gates ready: ${report.snapshot.launch_freeze_ready_gate_count}/${report.snapshot.launch_freeze_gate_count}`);
console.log(`Launch signoff: ${report.snapshot.launch_signoff_audit_status}; owners ready: ${report.snapshot.launch_signoff_ready_owners}/${report.snapshot.launch_signoff_owners}; signoff tasks ready: ${report.snapshot.launch_signoff_ready_tasks}/${report.snapshot.launch_signoff_tasks}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'launch_day_ready') {
  console.error('Strict Kickstarter launch-day command center failed: launch freeze, human signoff, launch operator, launch-room coverage, or launch-day timeline tasks are not ready.');
  process.exit(1);
}
