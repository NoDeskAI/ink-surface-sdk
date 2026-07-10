import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-p0-command-brief';
const outJsonPath = `${outDir}/command-brief.json`;
const outReadmePath = `${outDir}/README.md`;

const sourcePaths = {
  demoEvidence: 'test-results/ai-pen-demo-evidence/manifest.json',
  opsRefresh: 'test-results/ai-pen-kickstarter-ops-refresh/ops-refresh.json',
  weeklySprint: 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json',
  actionPlan: 'test-results/ai-pen-launch-action-plan/action-plan.json',
};

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { available: false, path: relativePath, error: `missing source: ${relativePath}`, data: null };
  }
  try {
    return {
      available: true,
      path: relativePath,
      error: null,
      data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')),
    };
  } catch (error) {
    return { available: false, path: relativePath, error: `unreadable source: ${relativePath}: ${error.message}`, data: null };
  }
}

function sourceMap(sources) {
  return Object.fromEntries(
    Object.entries(sources).map(([key, source]) => [
      key,
      { path: source.path, available: source.available, error: source.error },
    ]),
  );
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function currentStatus({ demo, ops }) {
  const demoReady = demo?.status === 'local_demo_ready';
  const launchReady = ops?.snapshot?.launch_audit_status === 'launch_ready'
    && ops?.snapshot?.launch_freeze_status === 'launch_freeze_ready';
  if (launchReady) return 'launch_ready';
  if (demoReady && ops?.status === 'ops_refresh_launch_not_ready') return 'demo_ready_p0_launch_blocked';
  if (demoReady) return 'demo_ready_launch_unknown';
  return 'demo_or_launch_not_ready';
}

function buildFirst48h(weekly) {
  const tasks = Array.isArray(weekly?.tasks) ? weekly.tasks : [];
  return uniqueBy(tasks, (task) => task.gate_id)
    .slice(0, 3)
    .map((task, index) => ({
      day: index < 2 ? 'Day 1' : 'Day 2',
      gate_id: task.gate_id,
      owner: task.owner,
      milestone_date: task.milestone_date,
      action: task.next_action,
      raw_target: task.expected_input,
      report_target: task.expected_report,
      analyzer_command: task.runnable_analyzer_command,
      evidence_checklist: task.evidence_checklist ?? [],
      done_when: task.done_when,
    }));
}

function buildWeeklyGateFocus(weekly) {
  const tasks = Array.isArray(weekly?.tasks) ? weekly.tasks : [];
  return uniqueBy(tasks, (task) => `${task.gate_id}:${task.milestone_date}`)
    .slice(0, 5)
    .map((task) => ({
      pressure: task.pressure,
      gate_id: task.gate_id,
      milestone_date: task.milestone_date,
      days_to_due: task.days_to_due,
      owner: task.owner,
      action: task.next_action,
      evidence_record: task.evidence_record,
      raw_target: task.expected_input,
      command: task.runnable_analyzer_command,
    }));
}

function buildLaunchGateFocus(actionPlan) {
  const actions = Array.isArray(actionPlan?.action_items) ? actionPlan.action_items : [];
  return actions
    .filter((item) => item.priority === 'P0')
    .slice(0, 8)
    .map((item) => ({
      gate_id: item.id,
      label: item.label,
      owner: item.owner,
      due: item.due,
      status: item.status,
      next_action: item.action,
      evidence_record: item.evidence_record,
      done_when: item.done_when,
      blockers: item.audit?.blockers ?? [],
    }));
}

function buildDomainQueue(ops) {
  const queue = Array.isArray(ops?.sources_data?.launch_operations_queue)
    ? ops.sources_data.launch_operations_queue
    : [];
  const domains = ['supplier_quote', 'page_review', 'prelaunch', 'launch_signoff'];
  return domains.map((domain) => {
    const items = queue.filter((item) => item.domain === domain).slice(0, 5);
    return {
      domain,
      domain_label: items[0]?.domain_label ?? domain,
      p0_count: queue.filter((item) => item.domain === domain && item.priority === 'P0').length,
      next_required_input_count: queue.filter((item) => item.domain === domain).length,
      top_inputs: items.map((item) => ({
        id: item.id,
        owner: item.owner,
        required_input: item.required_input,
        evidence_target: item.evidence_target,
        next_command: item.next_command,
      })),
    };
  });
}

function rows(items, columns, empty = '| n/a | n/a |') {
  if (!items.length) return empty;
  return items.map((item) => `| ${columns.map((column) => item[column] ?? 'n/a').join(' | ')} |`).join('\n');
}

function markdownCommandList(items) {
  const commands = [...new Set(items.map((item) => item.analyzer_command || item.command).filter(Boolean))];
  return commands.length ? commands.map((command) => `- \`${command}\``).join('\n') : '- n/a';
}

function domainRows(domains) {
  return domains
    .map((domain) => `| ${domain.domain_label} | ${domain.next_required_input_count} | ${domain.p0_count} | ${domain.top_inputs[0]?.required_input ?? 'n/a'} | ${domain.top_inputs[0]?.next_command ? `\`${domain.top_inputs[0].next_command}\`` : 'n/a'} |`)
    .join('\n');
}

function topInputRows(domains) {
  const inputs = domains.flatMap((domain) => domain.top_inputs.map((item) => ({ domain: domain.domain_label, ...item })));
  if (!inputs.length) return '| n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .map((item) => `| ${item.domain} | ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} |`)
    .join('\n');
}

const sources = Object.fromEntries(Object.entries(sourcePaths).map(([key, sourcePath]) => [key, readJson(sourcePath)]));
const accessIssues = Object.values(sources).filter((source) => !source.available).map((source) => source.error);
const demo = sources.demoEvidence.data;
const ops = sources.opsRefresh.data;
const weekly = sources.weeklySprint.data;
const actionPlan = sources.actionPlan.data;

const report = {
  schema: 'inkloop.kickstarter_p0_command_brief.v1',
  generated_at: new Date().toISOString(),
  status: currentStatus({ demo, ops }),
  sources: sourceMap(sources),
  access_issues: accessIssues,
  launch_snapshot: {
    demo_status: demo?.status ?? 'missing',
    ops_status: ops?.status ?? 'missing',
    launch_audit_status: ops?.snapshot?.launch_audit_status ?? 'missing',
    ready_launch_gates: `${ops?.snapshot?.ready_gate_count ?? 0}/${ops?.snapshot?.gate_count ?? 0}`,
    launch_freeze_status: ops?.snapshot?.launch_freeze_status ?? 'missing',
    launch_freeze_gates_ready: `${ops?.snapshot?.launch_freeze_ready_gate_count ?? 0}/${ops?.snapshot?.launch_freeze_gate_count ?? 0}`,
    open_p0_risks: `${ops?.snapshot?.open_p0_count ?? 0}/${ops?.snapshot?.risk_count ?? 0}`,
    supplier_ready_quotes: `${ops?.snapshot?.supplier_ready_quote_rows ?? 0}/${ops?.snapshot?.supplier_quote_rows ?? 0}`,
    page_review_ready_sections: `${ops?.snapshot?.page_review_ready_sections ?? 0}/${ops?.snapshot?.page_review_sections ?? 0}`,
    prelaunch_fields_ready: ops?.snapshot
      ? `${ops.snapshot.prelaunch_page_field_count - ops.snapshot.prelaunch_page_missing_field_count}/${ops.snapshot.prelaunch_page_field_count}`
      : 'missing',
    launch_signoff_ready_owners: `${ops?.snapshot?.launch_signoff_ready_owners ?? 0}/${ops?.snapshot?.launch_signoff_owners ?? 0}`,
    launch_operations_next_required_inputs: ops?.snapshot?.launch_operations_next_required_input_count ?? 'missing',
  },
  first_48h_capture_plan: buildFirst48h(weekly),
  weekly_gate_focus: buildWeeklyGateFocus(weekly),
  launch_gate_focus: buildLaunchGateFocus(actionPlan),
  operations_domains: buildDomainQueue(ops),
  non_claims: [
    'This P0 command brief is not launch approval.',
    'Local demo readiness does not prove Kickstarter launch readiness.',
    'Do not convert fixture data or template rows into public Kickstarter claims.',
    'Kickstarter launch remains a manual action after human Go/No-Go signoff.',
  ],
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outJsonPath, `${JSON.stringify(report, null, 2)}\n`);

const first48Rows = rows(
  report.first_48h_capture_plan,
  ['day', 'gate_id', 'owner', 'milestone_date', 'action', 'raw_target'],
  '| n/a | n/a | n/a | n/a | n/a | n/a |',
);
const weeklyRows = rows(
  report.weekly_gate_focus,
  ['pressure', 'gate_id', 'milestone_date', 'days_to_due', 'owner', 'action'],
  '| n/a | n/a | n/a | n/a | n/a | n/a |',
);
const launchRows = rows(
  report.launch_gate_focus,
  ['gate_id', 'label', 'owner', 'due', 'status', 'next_action'],
  '| n/a | n/a | n/a | n/a | n/a | n/a |',
);
const snapshotRows = Object.entries(report.launch_snapshot)
  .map(([key, value]) => `| ${key} | ${value} |`)
  .join('\n');
const accessIssueText = accessIssues.length ? accessIssues.map((item) => `- ${item}`).join('\n') : '- None';

writeFileSync(outReadmePath, `# InkLoop AI Pen Kickstarter P0 Command Brief

Schema: \`${report.schema}\`

Generated at: ${report.generated_at}

Status: \`${report.status}\`

This brief compresses the current launch operating state into one execution view. It reads the latest demo evidence, ops refresh, weekly sprint, and launch action plan. It is not launch approval.

## Launch Snapshot

| Item | Value |
| --- | --- |
${snapshotRows}

## First 48 Hours

| Day | Gate | Owner | Milestone | Action | Raw Target |
| --- | --- | --- | --- | --- | --- |
${first48Rows}

## Analyzer Commands

${markdownCommandList(report.first_48h_capture_plan)}

## Weekly Gate Focus

| Pressure | Gate | Milestone | Days | Owner | Action |
| --- | --- | --- | ---: | --- | --- |
${weeklyRows}

## Launch Gate Focus

| Gate | Label | Owner | Due | Status | Next Action |
| --- | --- | --- | --- | --- | --- |
${launchRows}

## Operations Domains

| Domain | Required Inputs | P0 Inputs | First Required Input | Next Command |
| --- | ---: | ---: | --- | --- |
${domainRows(report.operations_domains)}

## Top Cross-Functional Inputs

| Domain | ID | Owner | Required Input | Evidence Target |
| --- | --- | --- | --- | --- |
${topInputRows(report.operations_domains)}

## Required Review Loop

1. Fill real raw files into the current intake folder before running analyzers.
2. Run the listed analyzer commands and keep failing \`gate_checks\` visible.
3. Run \`npm run launch:evidence:intake-audit\`.
4. Update evidence records only when raw files, reports, artifacts, and human decisions exist.
5. Run \`npm run kickstarter:ops-refresh\` and regenerate this brief with \`npm run kickstarter:p0-command-brief\`.

## Non-Claims

${report.non_claims.map((item) => `- ${item}`).join('\n')}

## Access Issues

${accessIssueText}

Detailed JSON: [command-brief.json](./command-brief.json)
`);

if (accessIssues.length > 0) {
  console.error('P0 command brief has access issues:');
  for (const issue of accessIssues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`P0 command brief ready: ${outReadmePath}`);
