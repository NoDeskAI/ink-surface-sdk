import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-ops-refresh';
const outJsonPath = `${outDir}/ops-refresh.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const refreshCommands = [
  {
    id: 'launch-evidence-intake-audit',
    label: 'Launch evidence intake audit',
    npm_script: 'launch:evidence:intake-audit',
    artifact: 'test-results/ai-pen-launch-evidence-intake-audit/report.json',
  },
  {
    id: 'launch-evidence-record-update-plan',
    label: 'Launch evidence record update plan',
    npm_script: 'launch:evidence:record-update-plan',
    artifact: 'test-results/ai-pen-launch-evidence-record-update-plan/record-update-plan.json',
  },
  {
    id: 'launch-evidence-record-apply',
    label: 'Launch evidence record apply dry run',
    npm_script: 'launch:evidence:apply-record-updates',
    artifact: 'test-results/ai-pen-launch-evidence-record-apply/apply-report.json',
  },
  {
    id: 'launch-evidence-audit',
    label: 'Launch evidence audit',
    npm_script: 'launch:evidence:audit',
    artifact: 'test-results/ai-pen-launch-evidence-audit/report.json',
  },
  {
    id: 'launch-action-plan',
    label: 'Launch action plan',
    npm_script: 'launch:action-plan',
    artifact: 'test-results/ai-pen-launch-action-plan/action-plan.json',
  },
  {
    id: 'kickstarter-critical-path',
    label: 'Kickstarter critical path',
    npm_script: 'launch:critical-path',
    artifact: 'test-results/ai-pen-kickstarter-critical-path/critical-path.json',
  },
  {
    id: 'kickstarter-weekly-sprint',
    label: 'Kickstarter weekly sprint',
    npm_script: 'launch:weekly-sprint',
    artifact: 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json',
  },
  {
    id: 'launch-kpi-dashboard',
    label: 'Launch KPI dashboard',
    npm_script: 'launch:kpi-dashboard',
    artifact: 'test-results/ai-pen-launch-kpi-dashboard/dashboard.json',
  },
  {
    id: 'kickstarter-claim-downgrade',
    label: 'Kickstarter claim downgrade pack',
    npm_script: 'kickstarter:claim-downgrade',
    artifact: 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json',
  },
  {
    id: 'kickstarter-proof-shot-audit',
    label: 'Kickstarter proof-shot audit',
    npm_script: 'kickstarter:proof-shot-audit',
    artifact: 'test-results/ai-pen-kickstarter-proof-shot-audit/report.json',
  },
  {
    id: 'kickstarter-public-copy-lock',
    label: 'Kickstarter public copy lock',
    npm_script: 'kickstarter:public-copy-lock',
    artifact: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
  },
  {
    id: 'kickstarter-supplier-quote-audit',
    label: 'Kickstarter supplier quote audit',
    npm_script: 'kickstarter:supplier-quote-audit',
    artifact: 'test-results/ai-pen-kickstarter-supplier-quote-audit/report.json',
  },
  {
    id: 'kickstarter-page-review-audit',
    label: 'Kickstarter page review audit',
    npm_script: 'kickstarter:page-review-audit',
    artifact: 'test-results/ai-pen-kickstarter-page-review-audit/report.json',
  },
  {
    id: 'kickstarter-prelaunch-page-intake-audit',
    label: 'Kickstarter pre-launch page intake audit',
    npm_script: 'kickstarter:prelaunch-page-intake-audit',
    artifact: 'test-results/ai-pen-kickstarter-prelaunch-page-intake-audit/report.json',
  },
  {
    id: 'kickstarter-prelaunch-page-pack',
    label: 'Kickstarter pre-launch page pack',
    npm_script: 'kickstarter:prelaunch-page-pack',
    artifact: 'test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json',
  },
  {
    id: 'kickstarter-risk-register',
    label: 'Kickstarter risk register',
    npm_script: 'kickstarter:risk-register',
    artifact: 'test-results/ai-pen-kickstarter-risk-register/risk-register.json',
  },
  {
    id: 'kickstarter-launch-signoff-audit',
    label: 'Kickstarter launch signoff audit',
    npm_script: 'kickstarter:launch-signoff-audit',
    artifact: 'test-results/ai-pen-kickstarter-launch-signoff-audit/report.json',
  },
  {
    id: 'launch-review-pack',
    label: 'Weekly Launch Review Pack',
    npm_script: 'launch:review-pack',
    artifact: 'test-results/ai-pen-launch-review-pack/review-pack.json',
  },
  {
    id: 'kickstarter-rehearsal-pack',
    label: 'Kickstarter rehearsal pack',
    npm_script: 'kickstarter:rehearsal-pack',
    artifact: 'test-results/ai-pen-kickstarter-rehearsal/rehearsal-pack.json',
  },
  {
    id: 'launch-operator-pack',
    label: 'Launch operator pack',
    npm_script: 'launch:operator-pack',
    artifact: 'test-results/ai-pen-launch-operator-pack/operator-pack.json',
  },
  {
    id: 'kickstarter-launch-freeze-pack',
    label: 'Kickstarter launch freeze pack',
    npm_script: 'kickstarter:launch-freeze-pack',
    artifact: 'test-results/ai-pen-kickstarter-launch-freeze/launch-freeze.json',
  },
  {
    id: 'kickstarter-launch-day-command-center',
    label: 'Kickstarter launch-day command center',
    npm_script: 'kickstarter:launch-day-command-center',
    artifact: 'test-results/ai-pen-kickstarter-launch-day-command-center/command-center.json',
  },
];

const sourcePaths = {
  intakeAudit: 'test-results/ai-pen-launch-evidence-intake-audit/report.json',
  recordUpdatePlan: 'test-results/ai-pen-launch-evidence-record-update-plan/record-update-plan.json',
  recordApplyReport: 'test-results/ai-pen-launch-evidence-record-apply/apply-report.json',
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  actionPlan: 'test-results/ai-pen-launch-action-plan/action-plan.json',
  criticalPath: 'test-results/ai-pen-kickstarter-critical-path/critical-path.json',
  weeklySprint: 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json',
  kpiDashboard: 'test-results/ai-pen-launch-kpi-dashboard/dashboard.json',
  claimDowngrade: 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json',
  publicCopyLock: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
  supplierQuoteAudit: 'test-results/ai-pen-kickstarter-supplier-quote-audit/report.json',
  pageReviewAudit: 'test-results/ai-pen-kickstarter-page-review-audit/report.json',
  prelaunchPageIntakeAudit: 'test-results/ai-pen-kickstarter-prelaunch-page-intake-audit/report.json',
  prelaunchPagePack: 'test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json',
  riskRegister: 'test-results/ai-pen-kickstarter-risk-register/risk-register.json',
  launchSignoffAudit: 'test-results/ai-pen-kickstarter-launch-signoff-audit/report.json',
  launchReviewPack: 'test-results/ai-pen-launch-review-pack/review-pack.json',
  rehearsalPack: 'test-results/ai-pen-kickstarter-rehearsal/rehearsal-pack.json',
  proofShotAudit: 'test-results/ai-pen-kickstarter-proof-shot-audit/report.json',
  operatorPack: 'test-results/ai-pen-launch-operator-pack/operator-pack.json',
  launchFreezePack: 'test-results/ai-pen-kickstarter-launch-freeze/launch-freeze.json',
  launchDayCommandCenter: 'test-results/ai-pen-kickstarter-launch-day-command-center/command-center.json',
};

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

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, targetPath)})`;
}

function outputTail(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-8);
}

function runRefreshCommand(command) {
  const result = spawnSync('npm', ['run', command.npm_script], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ...command,
    command: `npm run ${command.npm_script}`,
    exit_code: result.status ?? 1,
    ok: result.status === 0,
    stdout_tail: outputTail(result.stdout),
    stderr_tail: outputTail(result.stderr),
  };
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

function statusFor({ commandResults, sources }) {
  if (commandResults.some((command) => !command.ok)) return 'ops_refresh_failed';
  if (sourceIssues(sources).length > 0) return 'ops_refresh_missing_sources';
  const launchReady = sources.launchAudit.data?.status === 'launch_ready_evidence_present';
  const noOpenP0 = (sources.riskRegister.data?.summary?.open_p0_count ?? 1) === 0;
  const finalCutReady = sources.proofShotAudit.data?.status === 'final_cut_ready';
  const publicCopyReady = sources.publicCopyLock.data?.status === 'public_copy_lock_ready';
  const supplierQuotesReady = sources.supplierQuoteAudit.data?.status === 'supplier_quotes_ready';
  const pageReviewReady = sources.pageReviewAudit.data?.status === 'page_review_ready';
  const prelaunchIntakeReady = sources.prelaunchPageIntakeAudit.data?.status === 'prelaunch_intake_ready';
  const prelaunchPageReady = sources.prelaunchPagePack.data?.status === 'prelaunch_page_ready';
  const launchSignoffReady = sources.launchSignoffAudit.data?.status === 'launch_signoff_ready';
  const launchFreezeReady = sources.launchFreezePack.data?.status === 'launch_freeze_ready';
  const launchDayReady = sources.launchDayCommandCenter.data?.status === 'launch_day_ready';
  if (
    launchReady &&
    noOpenP0 &&
    finalCutReady &&
    publicCopyReady &&
    supplierQuotesReady &&
    pageReviewReady &&
    prelaunchIntakeReady &&
    prelaunchPageReady &&
    launchSignoffReady &&
    launchFreezeReady &&
    launchDayReady
  )
    return 'ops_refresh_launch_ready';
  return 'ops_refresh_launch_not_ready';
}

function actionRows(actionPlan) {
  const items = actionPlan?.action_items ?? [];
  if (!items.length) return '| n/a | n/a | n/a | n/a | n/a |';
  return items
    .filter((item) => item.status !== 'ready')
    .slice(0, 8)
    .map((item) => `| ${item.id} | ${item.status} | ${item.owner} | ${item.due} | ${item.action} |`)
    .join('\n');
}

const queueDomainOrder = ['supplier', 'page_review', 'prelaunch', 'launch_signoff'];

function withDomain(domain, label, inputs) {
  return (Array.isArray(inputs) ? inputs : []).map((item) => ({
    domain,
    domain_label: label,
    ...item,
    queue_id: `${domain}:${item.id}`,
  }));
}

function buildLaunchOperationsQueue({ supplierInputs, pageReviewInputs, prelaunchInputs, launchSignoffInputs }) {
  return [
    ...withDomain('supplier', 'Supplier Quote', supplierInputs),
    ...withDomain('page_review', 'Page Review', pageReviewInputs),
    ...withDomain('prelaunch', 'Pre-Launch', prelaunchInputs),
    ...withDomain('launch_signoff', 'Launch Signoff', launchSignoffInputs),
  ].sort((a, b) => {
    const domainDelta = queueDomainOrder.indexOf(a.domain) - queueDomainOrder.indexOf(b.domain);
    if (domainDelta !== 0) return domainDelta;
    return String(a.id).localeCompare(String(b.id));
  });
}

function domainSummaryRows(summary) {
  if (!summary.length) return '| n/a | n/a | n/a |';
  return summary.map((item) => `| ${item.domain_label} | ${item.next_required_input_count} | ${item.p0_count} |`).join('\n');
}

function launchOperationsQueueRows(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .slice(0, 20)
    .map(
      (item) =>
        `| ${item.domain_label} | ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | \`${item.next_command}\` |`,
    )
    .join('\n');
}

function prelaunchInputRows(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .slice(0, 10)
    .map((item) => `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | \`${item.next_command}\` |`)
    .join('\n');
}

function launchSignoffInputRows(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .slice(0, 12)
    .map((item) => `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | \`${item.next_command}\` |`)
    .join('\n');
}

function supplierInputRows(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .slice(0, 12)
    .map((item) => `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | \`${item.next_command}\` |`)
    .join('\n');
}

function pageReviewInputRows(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .slice(0, 12)
    .map((item) => `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | \`${item.next_command}\` |`)
    .join('\n');
}

function commandRows(commandResults) {
  return commandResults
    .map((command) => `| ${command.label} | \`${command.command}\` | ${command.ok ? 'ok' : 'failed'} | ${mdLink(command.artifact)} |`)
    .join('\n');
}

function readme(report) {
  const accessIssues = report.access_issues.length
    ? report.access_issues.map((issue) => `- ${issue}`).join('\n')
    : '- None';
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Ops Refresh

Schema: \`inkloop.kickstarter_ops_refresh.v1\`

Status: \`${report.status}\`

This ops refresh runs the weekly Kickstarter operating chain and writes one summary package for project review. This ops refresh is not launch approval.

## Launch Snapshot

| Item | Value |
| --- | --- |
| Launch audit status | ${report.snapshot.launch_audit_status} |
| Ready launch gates | ${report.snapshot.ready_gate_count}/${report.snapshot.gate_count} |
| Red launch gates | ${report.snapshot.red_gate_count} |
| Intake audit status | ${report.snapshot.intake_audit_status} |
| Record update plan status | ${report.snapshot.record_update_plan_status} |
| Evidence records ready to update | ${report.snapshot.ready_record_update_count}/${report.snapshot.record_update_count} |
| Record apply dry-run status | ${report.snapshot.record_apply_status} |
| Record apply eligible fields | ${report.snapshot.record_apply_eligible_field_count} |
| Critical path status | ${report.snapshot.critical_path_status} |
| Weekly sprint status | ${report.snapshot.weekly_sprint_status} |
| Weekly sprint tasks | ${report.snapshot.weekly_sprint_task_count} |
| KPI dashboard status | ${report.snapshot.kpi_dashboard_status} |
| KPI metrics ready | ${report.snapshot.ready_metric_count}/${report.snapshot.metric_count} |
| Claim downgrade status | ${report.snapshot.claim_downgrade_status} |
| Draft-only claims | ${report.snapshot.draft_only_claim_count}/${report.snapshot.claim_count} |
| Public copy lock status | ${report.snapshot.public_copy_lock_status} |
| Public copy draft-only claims | ${report.snapshot.public_copy_draft_only_count}/${report.snapshot.public_copy_claim_count} |
| Supplier quote audit status | ${report.snapshot.supplier_quote_status} |
| Supplier BOM cost rows | ${report.snapshot.supplier_bom_cost_rows}/${report.snapshot.supplier_bom_required_rows} |
| Supplier ready quote rows | ${report.snapshot.supplier_ready_quote_rows}/${report.snapshot.supplier_quote_rows} |
| Supplier next required inputs | ${report.snapshot.supplier_next_required_input_count} |
| Page review audit status | ${report.snapshot.page_review_status} |
| Page sections ready | ${report.snapshot.page_review_ready_sections}/${report.snapshot.page_review_sections} |
| Legal/privacy checks ready | ${report.snapshot.page_review_ready_legal_checks}/${report.snapshot.page_review_legal_checks} |
| Page review next required inputs | ${report.snapshot.page_review_next_required_input_count} |
| Pre-launch intake audit status | ${report.snapshot.prelaunch_intake_status} |
| Pre-launch intake ready fields | ${report.snapshot.prelaunch_intake_ready_fields}/${report.snapshot.prelaunch_intake_field_count} |
| Pre-launch intake ready owner reviews | ${report.snapshot.prelaunch_intake_ready_reviews}/${report.snapshot.prelaunch_intake_review_count} |
| Notify me tracking ready rows | ${report.snapshot.prelaunch_intake_ready_tracking_rows}/${report.snapshot.prelaunch_intake_tracking_rows} |
| Pre-launch page status | ${report.snapshot.prelaunch_page_status} |
| Pre-launch page fields ready | ${report.snapshot.prelaunch_page_field_count - report.snapshot.prelaunch_page_missing_field_count}/${report.snapshot.prelaunch_page_field_count} |
| Pre-launch next required inputs | ${report.snapshot.prelaunch_page_next_required_input_count} |
| Risk register status | ${report.snapshot.risk_register_status} |
| Open P0 risks | ${report.snapshot.open_p0_count}/${report.snapshot.risk_count} |
| Review pack status | ${report.snapshot.review_pack_status} |
| Rehearsal pack status | ${report.snapshot.rehearsal_pack_status} |
| Proof-shot audit status | ${report.snapshot.proof_shot_audit_status} |
| Final-cut proof shots | ${report.snapshot.ready_shot_count}/${report.snapshot.shot_count} |
| Launch operator pack status | ${report.snapshot.operator_pack_status} |
| Operator capture sessions | ${report.snapshot.operator_capture_session_count} |
| Operator field work orders | ${report.snapshot.operator_field_work_order_count} |
| Launch signoff audit status | ${report.snapshot.launch_signoff_status} |
| Owner signoffs ready | ${report.snapshot.launch_signoff_ready_owners}/${report.snapshot.launch_signoff_owners} |
| Signoff launch-day tasks ready | ${report.snapshot.launch_signoff_ready_tasks}/${report.snapshot.launch_signoff_tasks} |
| Launch signoff next required inputs | ${report.snapshot.launch_signoff_next_required_input_count} |
| Launch freeze status | ${report.snapshot.launch_freeze_status} |
| Launch freeze gates ready | ${report.snapshot.launch_freeze_ready_gate_count}/${report.snapshot.launch_freeze_gate_count} |
| Launch-day command center status | ${report.snapshot.launch_day_command_center_status} |
| Launch-day tasks ready | ${report.snapshot.launch_day_ready_task_count}/${report.snapshot.launch_day_task_count} |
| Launch operations next required inputs | ${report.snapshot.launch_operations_next_required_input_count} |

## Command Results

| Step | Command | Result | Artifact |
| --- | --- | --- | --- |
${commandRows(report.command_results)}

## Current Red-Gate Actions

| Gate | Status | Owner | Due | Next Action |
| --- | --- | --- | --- | --- |
${actionRows(report.sources_data.action_plan)}

## Launch Operations Queue Summary

| Domain | Next Required Inputs | P0 Inputs |
| --- | --- | --- |
${domainSummaryRows(report.sources_data.launch_operations_domain_summary)}

## Top Launch Operations Queue

| Domain | ID | Owner | Required Input | Evidence Target | Next Command |
| --- | --- | --- | --- | --- | --- |
${launchOperationsQueueRows(report.sources_data.launch_operations_queue)}

## Supplier Quote Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Next Command |
| --- | --- | --- | --- | --- |
${supplierInputRows(report.sources_data.supplier_next_required_inputs)}

## Page Review Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Next Command |
| --- | --- | --- | --- | --- |
${pageReviewInputRows(report.sources_data.page_review_next_required_inputs)}

## Pre-Launch Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Next Command |
| --- | --- | --- | --- | --- |
${prelaunchInputRows(report.sources_data.prelaunch_next_required_inputs)}

## Launch Signoff Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Next Command |
| --- | --- | --- | --- | --- |
${launchSignoffInputRows(report.sources_data.launch_signoff_next_required_inputs)}

## Operating Notes

1. Run \`npm run kickstarter:ops-refresh\` before weekly review, rehearsal status review, or campaign-copy review.
2. Run \`npm run kickstarter:proof-shot-intake\` only when starting a new filming session; this refresh audits the latest proof-shot intake instead of creating a new one.
3. Run \`npm run launch:evidence:apply-record-updates:write\` only after reviewing the dry-run report, raw files, analyzer reports, supporting artifacts, and reviewer notes.
4. Run \`npm run verify:local-demo-handoff\` before an external demo that needs browser screenshots, APK assembly, Obsidian vault, and demo evidence bundle.
5. Keep \`npm run launch:evidence:audit:strict\` failing until real launch evidence records are complete.
6. Keep \`npm run kickstarter:ops-refresh:strict\` failing until launch evidence, open P0 risk, final-cut proof shots, public copy lock, supplier quotes, page review, pre-launch page, launch freeze, and launch-day command center are ready.
7. Use \`npm run kickstarter:launch-freeze-pack\` for the final Go/No-Go evidence package before page freeze.
8. Use \`npm run kickstarter:launch-day-command-center\` to turn the source T-24h to T+24h launch script into a refreshable operating board. Kickstarter launch is a manual action, not scheduled automation.
9. Run \`npm run kickstarter:prelaunch-page-intake\` before creating or updating the Kickstarter pre-launch page, then use \`npm run kickstarter:prelaunch-page-intake-audit\` to check preview/live URL evidence, Notify me tracking, screenshots, and owner review.
10. Use \`npm run kickstarter:prelaunch-page-pack\` before sending any pre-launch traffic; it checks the Kickstarter preview URL, Notify me funnel, owner review, public copy lock, pre-launch intake audit, and GTM tracking state.
11. Run \`npm run kickstarter:supplier-quote-intake\` before requesting supplier quotes or revising reward pricing; this refresh audits the latest supplier quote intake instead of creating one.
12. Run \`npm run kickstarter:page-review-intake\` before formal Kickstarter page/legal/privacy review; this refresh audits the latest page review intake instead of creating one.
13. Use \`npm run kickstarter:launch-signoff-audit\` before launch freeze review so owner signoffs, manual launch operator, launch-room coverage, and launch-day task evidence are checked separately from the freeze pack.

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Detailed JSON: [ops-refresh.json](./ops-refresh.json)
`;
}

const commandResults = refreshCommands.map(runRefreshCommand);
const sources = Object.fromEntries(Object.entries(sourcePaths).map(([key, relativePath]) => [key, readJsonSource(relativePath)]));
const supplierNextRequiredInputs = sources.supplierQuoteAudit.data?.next_required_inputs ?? [];
const pageReviewNextRequiredInputs = sources.pageReviewAudit.data?.next_required_inputs ?? [];
const prelaunchNextRequiredInputs = sources.prelaunchPagePack.data?.next_required_inputs ?? [];
const launchSignoffNextRequiredInputs = sources.launchSignoffAudit.data?.next_required_inputs ?? [];
const launchOperationsQueue = buildLaunchOperationsQueue({
  supplierInputs: supplierNextRequiredInputs,
  pageReviewInputs: pageReviewNextRequiredInputs,
  prelaunchInputs: prelaunchNextRequiredInputs,
  launchSignoffInputs: launchSignoffNextRequiredInputs,
});
const launchOperationsDomainSummary = queueDomainOrder.map((domain) => {
  const domainItems = launchOperationsQueue.filter((item) => item.domain === domain);
  return {
    domain,
    domain_label: domainItems[0]?.domain_label ?? domain,
    next_required_input_count: domainItems.length,
    p0_count: domainItems.filter((item) => item.priority === 'P0').length,
  };
});
const report = {
  schema: 'inkloop.kickstarter_ops_refresh.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({ commandResults, sources }),
  sources: sourceMap(sources),
  access_issues: sourceIssues(sources),
  command_results: commandResults,
  snapshot: {
    launch_audit_status: sources.launchAudit.data?.status ?? 'unknown',
    gate_count: sources.launchAudit.data?.summary?.gate_count ?? 0,
    ready_gate_count: sources.launchAudit.data?.summary?.ready_gate_count ?? 0,
    red_gate_count: sources.launchAudit.data?.summary?.not_ready_gate_count ?? 0,
    intake_audit_status: sources.intakeAudit.data?.status ?? 'unknown',
    record_update_plan_status: sources.recordUpdatePlan.data?.status ?? 'unknown',
    record_update_count: sources.recordUpdatePlan.data?.summary?.record_count ?? 0,
    ready_record_update_count: sources.recordUpdatePlan.data?.summary?.ready_record_count ?? 0,
    record_apply_status: sources.recordApplyReport.data?.status ?? 'unknown',
    record_apply_eligible_field_count: sources.recordApplyReport.data?.summary?.eligible_field_count ?? 0,
    critical_path_status: sources.criticalPath.data?.status ?? 'unknown',
    weekly_sprint_status: sources.weeklySprint.data?.status ?? 'unknown',
    weekly_sprint_task_count: sources.weeklySprint.data?.summary?.task_count ?? 0,
    kpi_dashboard_status: sources.kpiDashboard.data?.status ?? 'unknown',
    metric_count: sources.kpiDashboard.data?.summary?.metric_count ?? 0,
    ready_metric_count: sources.kpiDashboard.data?.summary?.ready_metric_count ?? 0,
    claim_downgrade_status: sources.claimDowngrade.data?.status ?? 'unknown',
    claim_count: sources.claimDowngrade.data?.summary?.claim_count ?? 0,
    draft_only_claim_count: sources.claimDowngrade.data?.summary?.draft_only_count ?? 0,
    public_copy_lock_status: sources.publicCopyLock.data?.status ?? 'unknown',
    public_copy_claim_count: sources.publicCopyLock.data?.summary?.claim_count ?? 0,
    public_copy_draft_only_count: sources.publicCopyLock.data?.summary?.draft_only_count ?? 0,
    supplier_quote_status: sources.supplierQuoteAudit.data?.status ?? 'unknown',
    supplier_bom_required_rows: sources.supplierQuoteAudit.data?.summary?.bom_required_rows ?? 0,
    supplier_bom_cost_rows: sources.supplierQuoteAudit.data?.summary?.bom_required_rows_with_cost ?? 0,
    supplier_quote_rows: sources.supplierQuoteAudit.data?.summary?.quote_row_count ?? 0,
    supplier_ready_quote_rows: sources.supplierQuoteAudit.data?.summary?.ready_quote_count ?? 0,
    supplier_next_required_input_count:
      sources.supplierQuoteAudit.data?.summary?.next_required_input_count ?? sources.supplierQuoteAudit.data?.next_required_inputs?.length ?? 0,
    page_review_status: sources.pageReviewAudit.data?.status ?? 'unknown',
    page_review_sections: sources.pageReviewAudit.data?.summary?.section_count ?? 0,
    page_review_ready_sections: sources.pageReviewAudit.data?.summary?.ready_section_count ?? 0,
    page_review_legal_checks: sources.pageReviewAudit.data?.summary?.legal_check_count ?? 0,
    page_review_ready_legal_checks: sources.pageReviewAudit.data?.summary?.ready_legal_check_count ?? 0,
    page_review_next_required_input_count:
      sources.pageReviewAudit.data?.summary?.next_required_input_count ?? sources.pageReviewAudit.data?.next_required_inputs?.length ?? 0,
    prelaunch_intake_status: sources.prelaunchPageIntakeAudit.data?.status ?? 'unknown',
    prelaunch_intake_field_count: sources.prelaunchPageIntakeAudit.data?.summary?.page_field_count ?? 0,
    prelaunch_intake_ready_fields: sources.prelaunchPageIntakeAudit.data?.summary?.ready_page_field_count ?? 0,
    prelaunch_intake_review_count: sources.prelaunchPageIntakeAudit.data?.summary?.owner_review_count ?? 0,
    prelaunch_intake_ready_reviews: sources.prelaunchPageIntakeAudit.data?.summary?.ready_owner_review_count ?? 0,
    prelaunch_intake_tracking_rows: sources.prelaunchPageIntakeAudit.data?.summary?.tracking_row_count ?? 0,
    prelaunch_intake_ready_tracking_rows: sources.prelaunchPageIntakeAudit.data?.summary?.ready_tracking_row_count ?? 0,
    prelaunch_page_status: sources.prelaunchPagePack.data?.status ?? 'unknown',
    prelaunch_page_field_count: sources.prelaunchPagePack.data?.summary?.field_count ?? 0,
    prelaunch_page_missing_field_count: sources.prelaunchPagePack.data?.summary?.missing_field_count ?? 0,
    prelaunch_page_next_required_input_count:
      sources.prelaunchPagePack.data?.summary?.next_required_input_count ?? sources.prelaunchPagePack.data?.next_required_inputs?.length ?? 0,
    risk_register_status: sources.riskRegister.data?.status ?? 'unknown',
    risk_count: sources.riskRegister.data?.summary?.risk_count ?? 0,
    open_p0_count: sources.riskRegister.data?.summary?.open_p0_count ?? 0,
    review_pack_status: sources.launchReviewPack.data?.status ?? 'unknown',
    rehearsal_pack_status: sources.rehearsalPack.data?.status ?? 'unknown',
    proof_shot_audit_status: sources.proofShotAudit.data?.status ?? 'unknown',
    shot_count: sources.proofShotAudit.data?.summary?.shot_count ?? 0,
    ready_shot_count: sources.proofShotAudit.data?.summary?.ready_shot_count ?? 0,
    operator_pack_status: sources.operatorPack.data?.status ?? 'unknown',
    operator_capture_session_count: sources.operatorPack.data?.capture_sessions?.length ?? 0,
    operator_field_work_order_count: sources.operatorPack.data?.field_work_orders?.length ?? 0,
    launch_signoff_status: sources.launchSignoffAudit.data?.status ?? 'unknown',
    launch_signoff_owners: sources.launchSignoffAudit.data?.summary?.owner_signoff_count ?? 0,
    launch_signoff_ready_owners: sources.launchSignoffAudit.data?.summary?.ready_owner_signoff_count ?? 0,
    launch_signoff_tasks: sources.launchSignoffAudit.data?.summary?.launch_day_task_count ?? 0,
    launch_signoff_ready_tasks: sources.launchSignoffAudit.data?.summary?.ready_launch_day_task_count ?? 0,
    launch_signoff_next_required_input_count:
      sources.launchSignoffAudit.data?.summary?.next_required_input_count ?? sources.launchSignoffAudit.data?.next_required_inputs?.length ?? 0,
    launch_freeze_status: sources.launchFreezePack.data?.status ?? 'unknown',
    launch_freeze_gate_count: sources.launchFreezePack.data?.summary?.gate_count ?? 0,
    launch_freeze_ready_gate_count: sources.launchFreezePack.data?.summary?.ready_gate_count ?? 0,
    launch_day_command_center_status: sources.launchDayCommandCenter.data?.status ?? 'unknown',
    launch_day_task_count: sources.launchDayCommandCenter.data?.summary?.task_count ?? 0,
    launch_day_ready_task_count: sources.launchDayCommandCenter.data?.summary?.ready_task_count ?? 0,
    launch_operations_next_required_input_count: launchOperationsQueue.length,
  },
  sources_data: {
    action_plan: sources.actionPlan.data,
    supplier_next_required_inputs: supplierNextRequiredInputs,
    page_review_next_required_inputs: pageReviewNextRequiredInputs,
    prelaunch_next_required_inputs: prelaunchNextRequiredInputs,
    launch_signoff_next_required_inputs: launchSignoffNextRequiredInputs,
    launch_operations_queue: launchOperationsQueue,
    launch_operations_domain_summary: launchOperationsDomainSummary,
  },
  non_claims: [
    'This ops refresh is not launch approval.',
    'A refreshed status package does not replace raw hardware, Capture Surface, GTM, supplier, legal/privacy, or Kickstarter preview evidence.',
    'The default refresh does not create a new proof-shot intake package; create one explicitly before filming.',
    'The default refresh audits the latest supplier quote intake but does not create one; create one explicitly before requesting supplier quotes or revising reward pricing.',
    'The default refresh audits the latest Kickstarter page review intake but does not create one; create one explicitly before formal page/legal/privacy review.',
    'The default refresh audits the latest pre-launch page intake but does not create one; create one explicitly before preparing or updating the Kickstarter pre-launch page.',
    'The launch signoff audit is not human approval; responsible owners must update signoff rows manually after reviewing real evidence.',
    'The launch freeze package is a Go/No-Go evidence package, not human launch approval.',
    'The launch-day command center is an operating board only; Kickstarter launch remains a manual action.',
    'The pre-launch page package is not publish approval and does not prove demand without real Kickstarter follower and GTM exports.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter ops refresh status: ${report.status}`);
console.log(`Launch audit: ${report.snapshot.launch_audit_status}; gates ready: ${report.snapshot.ready_gate_count}/${report.snapshot.gate_count}`);
console.log(`Risk register: ${report.snapshot.risk_register_status}; open P0 risks: ${report.snapshot.open_p0_count}/${report.snapshot.risk_count}`);
console.log(`Rehearsal: ${report.snapshot.rehearsal_pack_status}; proof shots ready: ${report.snapshot.ready_shot_count}/${report.snapshot.shot_count}`);
console.log(`Supplier quotes: ${report.snapshot.supplier_quote_status}; BOM cost rows: ${report.snapshot.supplier_bom_cost_rows}/${report.snapshot.supplier_bom_required_rows}; ready quotes: ${report.snapshot.supplier_ready_quote_rows}/${report.snapshot.supplier_quote_rows}`);
console.log(`Supplier next required inputs: ${report.snapshot.supplier_next_required_input_count}`);
console.log(`Page review: ${report.snapshot.page_review_status}; sections ready: ${report.snapshot.page_review_ready_sections}/${report.snapshot.page_review_sections}; legal/privacy checks ready: ${report.snapshot.page_review_ready_legal_checks}/${report.snapshot.page_review_legal_checks}`);
console.log(`Page review next required inputs: ${report.snapshot.page_review_next_required_input_count}`);
console.log(
  `Pre-launch intake: ${report.snapshot.prelaunch_intake_status}; fields ready: ${report.snapshot.prelaunch_intake_ready_fields}/${report.snapshot.prelaunch_intake_field_count}; owner reviews ready: ${report.snapshot.prelaunch_intake_ready_reviews}/${report.snapshot.prelaunch_intake_review_count}`,
);
console.log(`Pre-launch page: ${report.snapshot.prelaunch_page_status}; fields ready: ${report.snapshot.prelaunch_page_field_count - report.snapshot.prelaunch_page_missing_field_count}/${report.snapshot.prelaunch_page_field_count}`);
console.log(`Pre-launch next required inputs: ${report.snapshot.prelaunch_page_next_required_input_count}`);
console.log(`Launch signoff: ${report.snapshot.launch_signoff_status}; owners ready: ${report.snapshot.launch_signoff_ready_owners}/${report.snapshot.launch_signoff_owners}; signoff tasks ready: ${report.snapshot.launch_signoff_ready_tasks}/${report.snapshot.launch_signoff_tasks}`);
console.log(`Launch signoff next required inputs: ${report.snapshot.launch_signoff_next_required_input_count}`);
console.log(`Launch freeze: ${report.snapshot.launch_freeze_status}; gates ready: ${report.snapshot.launch_freeze_ready_gate_count}/${report.snapshot.launch_freeze_gate_count}`);
console.log(`Launch day: ${report.snapshot.launch_day_command_center_status}; tasks ready: ${report.snapshot.launch_day_ready_task_count}/${report.snapshot.launch_day_task_count}`);
console.log(`Launch operations next required inputs: ${report.snapshot.launch_operations_next_required_input_count}`);
console.log(`Report: ${outReadmePath}`);

if (commandResults.some((command) => !command.ok)) {
  console.error('Kickstarter ops refresh failed: one or more refresh commands failed.');
  process.exit(1);
}

if (strict && report.status !== 'ops_refresh_launch_ready') {
  console.error('Strict Kickstarter ops refresh failed: launch evidence, P0 risk, final-cut proof-shot, public-copy lock, supplier quotes, page review, pre-launch page, launch signoff, launch-freeze, human-signoff, or launch-day command-center gates are not ready.');
  process.exit(1);
}
