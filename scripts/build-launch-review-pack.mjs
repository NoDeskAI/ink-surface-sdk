import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-launch-review-pack';
const outJsonPath = `${outDir}/review-pack.json`;
const outReadmePath = `${outDir}/README.md`;
const coreStatusPhrase = 'local demo is ready but Kickstarter launch is not ready';

const sourcePaths = {
  demoManifest: 'test-results/ai-pen-demo-evidence/manifest.json',
  browserSmoke: 'test-results/ai-pen-browser-smoke/result.json',
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
  riskRegister: 'test-results/ai-pen-kickstarter-risk-register/risk-register.json',
};

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function normalizePath(filePath) {
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath) ? filePath : absolute(filePath);
  const relative = path.relative(root, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return filePath;
}

function readJsonSource(key, relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return {
      key,
      path: relativePath,
      available: false,
      error: `missing source file: ${relativePath}`,
      data: null,
    };
  }

  try {
    return {
      key,
      path: relativePath,
      available: true,
      error: null,
      data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')),
    };
  } catch (error) {
    return {
      key,
      path: relativePath,
      available: false,
      error: `unreadable source file: ${relativePath}: ${error.message}`,
      data: null,
    };
  }
}

function sourceMap() {
  return Object.fromEntries(
    Object.entries(sourcePaths).map(([key, relativePath]) => {
      const source = readJsonSource(key, relativePath);
      return [
        key,
        {
          path: relativePath,
          available: source.available,
          error: source.error,
        },
      ];
    }),
  );
}

function readSources() {
  return Object.fromEntries(
    Object.entries(sourcePaths).map(([key, relativePath]) => [key, readJsonSource(key, relativePath)]),
  );
}

function sourceIssues(sources) {
  return Object.values(sources)
    .filter((source) => !source.available)
    .map((source) => source.error);
}

function artifactCount(demoManifest) {
  const artifacts = demoManifest?.artifacts;
  if (Array.isArray(artifacts)) return artifacts.filter((artifact) => artifact.exists !== false).length;
  if (typeof demoManifest?.artifact_count === 'number') return demoManifest.artifact_count;
  return 0;
}

function artifactByLabel(demoManifest, labels) {
  const artifacts = Array.isArray(demoManifest?.artifacts) ? demoManifest.artifacts : [];
  return artifacts.find((artifact) => labels.some((label) => artifact.label?.toLowerCase().includes(label)));
}

function browserScreenshots(browserSmoke) {
  const screenshots = browserSmoke?.screenshots ?? {};
  return Object.fromEntries(
    Object.entries(screenshots).map(([key, filePath]) => [key, normalizePath(filePath)]),
  );
}

function presentationAssets(demoManifest, browserSmoke) {
  const educationScreenshot =
    browserScreenshots(browserSmoke).education ??
    artifactByLabel(demoManifest, ['education projection screenshot'])?.path ??
    null;
  const meetingScreenshot =
    browserScreenshots(browserSmoke).meeting ??
    artifactByLabel(demoManifest, ['meeting projection screenshot'])?.path ??
    null;
  const apk = artifactByLabel(demoManifest, ['debug apk'])?.path ?? null;
  const obsidianVault = artifactByLabel(demoManifest, ['obsidian demo vault readme'])?.path ?? null;

  return [
    {
      label: 'Education projection screenshot',
      path: normalizePath(educationScreenshot),
      exists: educationScreenshot ? existsSync(absolute(normalizePath(educationScreenshot))) : false,
    },
    {
      label: 'Meeting projection screenshot',
      path: normalizePath(meetingScreenshot),
      exists: meetingScreenshot ? existsSync(absolute(normalizePath(meetingScreenshot))) : false,
    },
    {
      label: 'Android/Paper debug APK',
      path: normalizePath(apk),
      exists: apk ? existsSync(absolute(normalizePath(apk))) : false,
    },
    {
      label: 'Obsidian demo vault README',
      path: normalizePath(obsidianVault),
      exists: obsidianVault ? existsSync(absolute(normalizePath(obsidianVault))) : false,
    },
  ];
}

function demoHandoff(demoManifest) {
  if (Array.isArray(demoManifest?.presentation_handoff) && demoManifest.presentation_handoff.length > 0) {
    return demoManifest.presentation_handoff;
  }
  return [
    {
      step: 1,
      surface: 'Launch boundary',
      open: 'test-results/ai-pen-demo-evidence/manifest.json',
      pass_signal: 'Demo evidence bundle exposes presentation_handoff before review starts.',
      boundary: 'Local demo ready does not equal Kickstarter launch ready.',
    },
  ];
}

function demoAcceptanceSignals(demoManifest) {
  if (Array.isArray(demoManifest?.acceptance_signals) && demoManifest.acceptance_signals.length > 0) {
    return demoManifest.acceptance_signals;
  }
  return ['Demo evidence bundle must expose acceptance_signals before review starts.'];
}

function buildRedGates(actionPlan) {
  const actionItems = Array.isArray(actionPlan?.action_items) ? actionPlan.action_items : [];
  return actionItems
    .filter((item) => item.status !== 'ready')
    .map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      priority: item.priority,
      owner: item.owner,
      due: item.due,
      source_milestone: item.source_milestone,
      next_action: item.action,
      evidence_record: item.evidence_record,
      analyzer_command: item.command,
      done_when: item.done_when,
      blockers: item.audit?.blockers ?? [],
    }));
}

function statusFor({ localDemoReady, launchReady, auditStatus, actionPlanAvailable }) {
  if (launchReady) return 'launch_evidence_ready';
  if (localDemoReady && auditStatus === 'not_launch_ready' && actionPlanAvailable) return 'demo_ready_launch_not_ready';
  if (localDemoReady && auditStatus === 'not_launch_ready') return 'demo_ready_launch_not_ready_no_action_plan';
  if (localDemoReady) return 'demo_ready_launch_unknown';
  if (auditStatus === 'not_launch_ready') return 'demo_not_ready_launch_not_ready';
  return 'unknown';
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  const relative = path.relative(outDir, normalizePath(targetPath));
  return `[${label}](${relative})`;
}

function tableRows(items) {
  if (items.length === 0) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return items
    .map((item) => `| ${item.priority} | ${item.id} | ${item.status} | ${item.owner} | ${item.due} | ${item.next_action} |`)
    .join('\n');
}

function assetRows(assets) {
  if (assets.length === 0) return '| n/a | n/a | n/a |';
  return assets
    .map((asset) => `| ${asset.label} | ${asset.exists ? 'present' : 'missing'} | ${asset.path ? mdLink(asset.path) : 'n/a'} |`)
    .join('\n');
}

function handoffRows(handoff) {
  if (!Array.isArray(handoff) || handoff.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return handoff
    .map((item) => `| ${item.step ?? 'n/a'} | ${item.surface ?? 'n/a'} | ${item.open ?? 'n/a'} | ${item.pass_signal ?? 'n/a'} | ${item.boundary ?? 'n/a'} |`)
    .join('\n');
}

function listRows(items) {
  if (!Array.isArray(items) || items.length === 0) return '- n/a';
  return items.map((item) => `- ${item}`).join('\n');
}

function readme(pack) {
  const accessIssues = pack.access_issues.length
    ? pack.access_issues.map((issue) => `- ${issue}`).join('\n')
    : '- None';
  const checked = pack.local_demo.browser_smoke_checked.length
    ? pack.local_demo.browser_smoke_checked.map((entry) => `- ${entry}`).join('\n')
    : '- n/a';
  const nonClaims = pack.non_claims.map((claim) => `- ${claim}`).join('\n');
  const loop = pack.recommended_loop.map((step, index) => `${index + 1}. ${step}`).join('\n');

  return `# InkLoop AI Pen Weekly Launch Review Pack

Schema: \`inkloop.launch_review_pack.v1\`

Status: \`${pack.status}\`

The ${coreStatusPhrase}. This pack combines the latest local demo evidence, browser smoke, launch evidence intake audit, evidence record update plan, evidence record apply dry run, critical path, weekly sprint, KPI dashboard, claim downgrade pack, public copy lock, supplier quote audit, page review audit, risk register, launch evidence audit, and red-gate action plan for weekly review. It does not replace the strict launch evidence audit.

## Local Demo Evidence

| Item | Value |
| --- | --- |
| Demo status | ${pack.local_demo.status} |
| Browser smoke ok | ${pack.local_demo.browser_smoke_ok} |
| Demo artifacts present | ${pack.local_demo.artifact_count} |
| Demo failures | ${pack.local_demo.failures.length} |
| Demo evidence bundle | ${mdLink(sourcePaths.demoManifest)} |
| Browser smoke result | ${mdLink(sourcePaths.browserSmoke)} |

Browser smoke checked:

${checked}

## Demo Handoff

| Step | Surface | Open | Pass Signal | Boundary |
| ---: | --- | --- | --- | --- |
${handoffRows(pack.local_demo.presentation_handoff)}

## Demo Acceptance Signals

${listRows(pack.local_demo.acceptance_signals)}

## Presentation Assets

| Asset | State | Path |
| --- | --- | --- |
${assetRows(pack.presentation_assets)}

## Launch Readiness

| Item | Value |
| --- | --- |
| Audit status | ${pack.launch.audit_status} |
| Ready gates | ${pack.launch.ready_gate_count}/${pack.launch.gate_count} |
| Not-ready gates | ${pack.launch.not_ready_gate_count}/${pack.launch.gate_count} |
| Intake audit status | ${pack.staged_evidence.status} |
| Intake ready gates | ${pack.staged_evidence.ready_gate_count}/${pack.staged_evidence.gate_count} |
| Intake not-ready gates | ${pack.staged_evidence.not_ready_gate_count}/${pack.staged_evidence.gate_count} |
| Intake audit report | ${mdLink(sourcePaths.intakeAudit)} |
| Record update plan status | ${pack.record_update_plan.status} |
| Evidence records ready to update | ${pack.record_update_plan.ready_record_count}/${pack.record_update_plan.record_count} |
| Record update plan report | ${mdLink(sourcePaths.recordUpdatePlan)} |
| Record apply dry-run status | ${pack.record_apply_report.status} |
| Record apply eligible fields | ${pack.record_apply_report.eligible_field_count} |
| Record apply report | ${mdLink(sourcePaths.recordApplyReport)} |
| Critical path status | ${pack.critical_path.status} |
| Days to preferred launch | ${pack.critical_path.days_to_preferred_launch} |
| Due this week | ${pack.critical_path.due_this_week} |
| At risk within 21 days | ${pack.critical_path.at_risk} |
| Critical path report | ${mdLink(sourcePaths.criticalPath)} |
| Weekly sprint status | ${pack.weekly_sprint.status} |
| Weekly sprint tasks | ${pack.weekly_sprint.task_count} |
| Weekly sprint at-risk tasks | ${pack.weekly_sprint.at_risk_task_count} |
| Weekly sprint report | ${mdLink(sourcePaths.weeklySprint)} |
| KPI dashboard status | ${pack.kpi_dashboard.status} |
| KPI metrics ready | ${pack.kpi_dashboard.ready_metric_count}/${pack.kpi_dashboard.metric_count} |
| KPI metrics needing real evidence | ${pack.kpi_dashboard.not_ready_metric_count}/${pack.kpi_dashboard.metric_count} |
| KPI dashboard report | ${mdLink(sourcePaths.kpiDashboard)} |
| Claim downgrade status | ${pack.claim_downgrade.status} |
| Draft-only claims | ${pack.claim_downgrade.draft_only_count}/${pack.claim_downgrade.claim_count} |
| Demo-only claims | ${pack.claim_downgrade.demo_wording_only_count}/${pack.claim_downgrade.claim_count} |
| Claim downgrade report | ${mdLink(sourcePaths.claimDowngrade)} |
| Public copy lock status | ${pack.public_copy_lock.status} |
| Public copy draft-only claims | ${pack.public_copy_lock.draft_only_count}/${pack.public_copy_lock.claim_count} |
| Public copy lock report | ${mdLink(sourcePaths.publicCopyLock)} |
| Supplier quote audit status | ${pack.supplier_quote_audit.status} |
| Supplier BOM cost rows | ${pack.supplier_quote_audit.bom_required_rows_with_cost}/${pack.supplier_quote_audit.bom_required_rows} |
| Supplier ready quote rows | ${pack.supplier_quote_audit.ready_quote_count}/${pack.supplier_quote_audit.quote_row_count} |
| Supplier quote audit report | ${mdLink(sourcePaths.supplierQuoteAudit)} |
| Page review audit status | ${pack.page_review_audit.status} |
| Page sections ready | ${pack.page_review_audit.ready_section_count}/${pack.page_review_audit.section_count} |
| Legal/privacy checks ready | ${pack.page_review_audit.ready_legal_check_count}/${pack.page_review_audit.legal_check_count} |
| Page review audit report | ${mdLink(sourcePaths.pageReviewAudit)} |
| Risk register status | ${pack.risk_register.status} |
| Open P0 risks | ${pack.risk_register.open_p0_count}/${pack.risk_register.risk_count} |
| Launch-impacting risks | ${pack.risk_register.launch_impact_count}/${pack.risk_register.risk_count} |
| Risk register report | ${mdLink(sourcePaths.riskRegister)} |
| Action items | ${pack.launch.action_count} |
| Not-ready action items | ${pack.launch.not_ready_action_count} |
| Launch audit report | ${mdLink(sourcePaths.launchAudit)} |
| Launch action plan | ${mdLink(sourcePaths.actionPlan)} |

## This Week P0 Queue

| Priority | Gate | Status | Owner | Due | Next Action |
| --- | --- | --- | --- | --- | --- |
${tableRows(pack.red_gates)}

## Operating Loop

${loop}

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}
`;
}

const sources = readSources();
const demoManifest = sources.demoManifest.data;
const browserSmoke = sources.browserSmoke.data;
const intakeAudit = sources.intakeAudit.data;
const recordUpdatePlan = sources.recordUpdatePlan.data;
const recordApplyReport = sources.recordApplyReport.data;
const launchAudit = sources.launchAudit.data;
const actionPlan = sources.actionPlan.data;
const criticalPath = sources.criticalPath.data;
const weeklySprint = sources.weeklySprint.data;
const kpiDashboard = sources.kpiDashboard.data;
const claimDowngrade = sources.claimDowngrade.data;
const publicCopyLock = sources.publicCopyLock.data;
const supplierQuoteAudit = sources.supplierQuoteAudit.data;
const pageReviewAudit = sources.pageReviewAudit.data;
const riskRegister = sources.riskRegister.data;

const localDemoReady = demoManifest?.status === 'local_demo_ready' && browserSmoke?.ok === true;
const launchReady = launchAudit?.status === 'launch_ready_evidence_present';
const redGates = buildRedGates(actionPlan);
const pack = {
  schema: 'inkloop.launch_review_pack.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({
    localDemoReady,
    launchReady,
    auditStatus: launchAudit?.status ?? 'unknown',
    actionPlanAvailable: sources.actionPlan.available,
  }),
  sources: sourceMap(),
  access_issues: sourceIssues(sources),
  local_demo: {
    status: demoManifest?.status ?? 'unknown',
    generated_at: demoManifest?.generated_at ?? null,
    artifact_count: artifactCount(demoManifest),
    failures: demoManifest?.failures ?? [],
    browser_smoke_ok: browserSmoke?.ok === true,
    browser_smoke_url: browserSmoke?.url ?? demoManifest?.browser_smoke?.url ?? null,
    browser_smoke_checked: browserSmoke?.checked ?? demoManifest?.browser_smoke?.checked ?? [],
    presentation_handoff: demoHandoff(demoManifest),
    acceptance_signals: demoAcceptanceSignals(demoManifest),
  },
  launch: {
    audit_status: launchAudit?.status ?? 'unknown',
    audit_generated_at: launchAudit?.generated_at ?? null,
    strict: launchAudit?.strict ?? null,
    gate_count: launchAudit?.summary?.gate_count ?? 0,
    ready_gate_count: launchAudit?.summary?.ready_gate_count ?? 0,
    not_ready_gate_count: launchAudit?.summary?.not_ready_gate_count ?? 0,
    action_count: actionPlan?.action_count ?? 0,
    not_ready_action_count: actionPlan?.not_ready_action_count ?? redGates.length,
  },
  staged_evidence: {
    status: intakeAudit?.status ?? 'unknown',
    generated_at: intakeAudit?.generated_at ?? null,
    gate_count: intakeAudit?.summary?.gate_count ?? 0,
    ready_gate_count: intakeAudit?.summary?.ready_gate_count ?? 0,
    not_ready_gate_count: intakeAudit?.summary?.not_ready_gate_count ?? 0,
    blocker_count: intakeAudit?.summary?.blocker_count ?? 0,
  },
  record_update_plan: {
    status: recordUpdatePlan?.status ?? 'unknown',
    generated_at: recordUpdatePlan?.generated_at ?? null,
    record_count: recordUpdatePlan?.summary?.record_count ?? 0,
    ready_record_count: recordUpdatePlan?.summary?.ready_record_count ?? 0,
    blocked_record_count: recordUpdatePlan?.summary?.blocked_record_count ?? 0,
  },
  record_apply_report: {
    status: recordApplyReport?.status ?? 'unknown',
    generated_at: recordApplyReport?.generated_at ?? null,
    ready_record_count: recordApplyReport?.summary?.ready_record_count ?? 0,
    eligible_field_count: recordApplyReport?.summary?.eligible_field_count ?? 0,
    applied_field_count: recordApplyReport?.summary?.applied_field_count ?? 0,
    skipped_field_count: recordApplyReport?.summary?.skipped_field_count ?? 0,
  },
  critical_path: {
    status: criticalPath?.status ?? 'unknown',
    generated_at: criticalPath?.generated_at ?? null,
    days_to_preferred_launch: criticalPath?.summary?.days_to_preferred_launch ?? null,
    days_to_latest_fallback: criticalPath?.summary?.days_to_latest_fallback ?? null,
    due_this_week: criticalPath?.summary?.status_counts?.due_this_week ?? 0,
    at_risk: criticalPath?.summary?.status_counts?.at_risk ?? 0,
    overdue: criticalPath?.summary?.status_counts?.overdue ?? 0,
  },
  weekly_sprint: {
    status: weeklySprint?.status ?? 'unknown',
    generated_at: weeklySprint?.generated_at ?? null,
    task_count: weeklySprint?.summary?.task_count ?? 0,
    at_risk_task_count: weeklySprint?.summary?.at_risk_task_count ?? 0,
    due_this_week_task_count: weeklySprint?.summary?.due_this_week_task_count ?? 0,
    overdue_task_count: weeklySprint?.summary?.overdue_task_count ?? 0,
  },
  kpi_dashboard: {
    status: kpiDashboard?.status ?? 'unknown',
    generated_at: kpiDashboard?.generated_at ?? null,
    metric_count: kpiDashboard?.summary?.metric_count ?? 0,
    ready_metric_count: kpiDashboard?.summary?.ready_metric_count ?? 0,
    not_ready_metric_count: kpiDashboard?.summary?.not_ready_metric_count ?? 0,
    at_risk_gate_count: kpiDashboard?.summary?.at_risk_gate_count ?? 0,
  },
  claim_downgrade: {
    status: claimDowngrade?.status ?? 'unknown',
    generated_at: claimDowngrade?.generated_at ?? null,
    claim_count: claimDowngrade?.summary?.claim_count ?? 0,
    public_claim_allowed_count: claimDowngrade?.summary?.public_claim_allowed_count ?? 0,
    guardrail_copy_allowed_count: claimDowngrade?.summary?.guardrail_copy_allowed_count ?? 0,
    demo_wording_only_count: claimDowngrade?.summary?.demo_wording_only_count ?? 0,
    draft_only_count: claimDowngrade?.summary?.draft_only_count ?? 0,
  },
  public_copy_lock: {
    status: publicCopyLock?.status ?? 'unknown',
    generated_at: publicCopyLock?.generated_at ?? null,
    claim_count: publicCopyLock?.summary?.claim_count ?? 0,
    public_claim_allowed_count: publicCopyLock?.summary?.public_claim_allowed_count ?? 0,
    guardrail_copy_allowed_count: publicCopyLock?.summary?.guardrail_copy_allowed_count ?? 0,
    demo_wording_only_count: publicCopyLock?.summary?.demo_wording_only_count ?? 0,
    draft_only_count: publicCopyLock?.summary?.draft_only_count ?? 0,
    ready_shot_count: publicCopyLock?.summary?.ready_shot_count ?? 0,
    shot_count: publicCopyLock?.summary?.shot_count ?? 0,
  },
  supplier_quote_audit: {
    status: supplierQuoteAudit?.status ?? 'unknown',
    generated_at: supplierQuoteAudit?.generated_at ?? null,
    bom_required_rows: supplierQuoteAudit?.summary?.bom_required_rows ?? 0,
    bom_required_rows_with_cost: supplierQuoteAudit?.summary?.bom_required_rows_with_cost ?? 0,
    quote_row_count: supplierQuoteAudit?.summary?.quote_row_count ?? 0,
    ready_quote_count: supplierQuoteAudit?.summary?.ready_quote_count ?? 0,
    blocker_count: supplierQuoteAudit?.summary?.blocker_count ?? 0,
  },
  page_review_audit: {
    status: pageReviewAudit?.status ?? 'unknown',
    generated_at: pageReviewAudit?.generated_at ?? null,
    review_field_count: pageReviewAudit?.summary?.review_field_count ?? 0,
    ready_review_field_count: pageReviewAudit?.summary?.ready_review_field_count ?? 0,
    section_count: pageReviewAudit?.summary?.section_count ?? 0,
    ready_section_count: pageReviewAudit?.summary?.ready_section_count ?? 0,
    legal_check_count: pageReviewAudit?.summary?.legal_check_count ?? 0,
    ready_legal_check_count: pageReviewAudit?.summary?.ready_legal_check_count ?? 0,
    blocker_count: pageReviewAudit?.summary?.blocker_count ?? 0,
  },
  risk_register: {
    status: riskRegister?.status ?? 'unknown',
    generated_at: riskRegister?.generated_at ?? null,
    risk_count: riskRegister?.summary?.risk_count ?? 0,
    open_p0_count: riskRegister?.summary?.open_p0_count ?? 0,
    launch_impact_count: riskRegister?.summary?.launch_impact_count ?? 0,
    at_risk_count: riskRegister?.summary?.at_risk_count ?? 0,
  },
  red_gates: redGates,
  presentation_assets: presentationAssets(demoManifest, browserSmoke),
  non_claims: [
    `The ${coreStatusPhrase}.`,
    'No real AI Pen BLE/firmware logs are present.',
    'No physical Capture Surface calibration/material test proof is present.',
    'No real education or business meeting demo reviewer evidence is present.',
    'No supplier quote/BOM evidence or GTM demand proof is present.',
    'No Kickstarter preview link, page review audit, legal review, or privacy review proof is present.',
  ],
  recommended_loop: [
    'Run `npm run launch:evidence:intake` before each real rehearsal, supplier review, GTM export, or page review.',
    'Put raw files, videos, quotes, screenshots, exports, and review notes into the matching intake folder.',
    'Run the relevant analyzer command, then run `npm run launch:evidence:intake-audit` before editing evidence records.',
    'Run `npm run launch:evidence:record-update-plan`, then `npm run launch:evidence:apply-record-updates` to preview safe path-field writes.',
    'Run `npm run launch:evidence:apply-record-updates:write` only after human review, then set each evidence-record `Decision` row manually.',
    'Run `npm run launch:evidence:audit` to refresh gate status.',
    'Run `npm run launch:action-plan` to rebuild the red-gate execution queue.',
    'Run `npm run launch:critical-path` to refresh dated Kickstarter milestone pressure.',
    'Run `npm run launch:weekly-sprint` to build the next execution sprint from the critical path.',
    'Run `npm run launch:kpi-dashboard` to refresh the weekly KR and Launch Gate dashboard.',
    'Run `npm run kickstarter:claim-downgrade` to refresh public-copy downgrade decisions.',
    'Run `npm run kickstarter:public-copy-lock` before moving page, video, ad, or landing-page copy out of draft.',
    'Run `npm run kickstarter:page-review-intake` before formal Kickstarter page/legal/privacy review, then `npm run kickstarter:page-review-audit` before page freeze.',
    'Run `npm run kickstarter:risk-register` to refresh the weekly risk board and P0 response queue.',
    'Run `npm run launch:review-pack` before the weekly review.',
    'Keep `npm run launch:evidence:audit:strict` failing until all real evidence gates pass.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(pack, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(pack));

console.log(`Launch review pack status: ${pack.status}`);
console.log(`Local demo: ${pack.local_demo.status}; browser smoke ok: ${pack.local_demo.browser_smoke_ok}`);
console.log(`Intake audit: ${pack.staged_evidence.status}; staged gates ready: ${pack.staged_evidence.ready_gate_count}/${pack.staged_evidence.gate_count}`);
console.log(`Critical path: ${pack.critical_path.status}; days to preferred launch: ${pack.critical_path.days_to_preferred_launch}`);
console.log(`Weekly sprint: ${pack.weekly_sprint.status}; tasks: ${pack.weekly_sprint.task_count}`);
console.log(`KPI dashboard: ${pack.kpi_dashboard.status}; metrics ready: ${pack.kpi_dashboard.ready_metric_count}/${pack.kpi_dashboard.metric_count}`);
console.log(`Claim downgrade: ${pack.claim_downgrade.status}; draft-only claims: ${pack.claim_downgrade.draft_only_count}/${pack.claim_downgrade.claim_count}`);
console.log(`Public copy lock: ${pack.public_copy_lock.status}; draft-only claims: ${pack.public_copy_lock.draft_only_count}/${pack.public_copy_lock.claim_count}`);
console.log(`Page review: ${pack.page_review_audit.status}; sections ready: ${pack.page_review_audit.ready_section_count}/${pack.page_review_audit.section_count}; legal/privacy checks ready: ${pack.page_review_audit.ready_legal_check_count}/${pack.page_review_audit.legal_check_count}`);
console.log(`Risk register: ${pack.risk_register.status}; open P0 risks: ${pack.risk_register.open_p0_count}/${pack.risk_register.risk_count}`);
console.log(`Launch audit: ${pack.launch.audit_status}; red gates: ${pack.red_gates.length}`);
console.log(`Report: ${outReadmePath}`);
