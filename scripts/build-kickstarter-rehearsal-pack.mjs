import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-rehearsal';
const outJsonPath = `${outDir}/rehearsal-pack.json`;
const outReadmePath = `${outDir}/README.md`;

const sourcePaths = {
  demoManifest: 'test-results/ai-pen-demo-evidence/manifest.json',
  browserSmoke: 'test-results/ai-pen-browser-smoke/result.json',
  launchReviewPack: 'test-results/ai-pen-launch-review-pack/review-pack.json',
  criticalPath: 'test-results/ai-pen-kickstarter-critical-path/critical-path.json',
  weeklySprint: 'test-results/ai-pen-kickstarter-weekly-sprint/weekly-sprint.json',
  kpiDashboard: 'test-results/ai-pen-launch-kpi-dashboard/dashboard.json',
  claimDowngrade: 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json',
  publicCopyLock: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
  supplierQuoteAudit: 'test-results/ai-pen-kickstarter-supplier-quote-audit/report.json',
  pageReviewAudit: 'test-results/ai-pen-kickstarter-page-review-audit/report.json',
  riskRegister: 'test-results/ai-pen-kickstarter-risk-register/risk-register.json',
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  kickstarterPageDraft: 'docs/project/inkloop-ai-pen-kickstarter/campaign/kickstarter-page-draft.md',
  campaignVideoScript: 'docs/project/inkloop-ai-pen-kickstarter/campaign/campaign-video-script.md',
  rewardsFaqDraft: 'docs/project/inkloop-ai-pen-kickstarter/campaign/rewards-faq-draft.md',
  claimEvidenceMatrix: 'docs/project/inkloop-ai-pen-kickstarter/campaign/claim-evidence-matrix.md',
  launchReadinessTracker: 'docs/project/inkloop-ai-pen-kickstarter/launch-readiness-tracker.md',
  demoRunbook: 'docs/project/inkloop-ai-pen-kickstarter/demo-runbook.md',
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
    return { key, path: relativePath, available: false, error: `missing source file: ${relativePath}`, data: null };
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
    return { key, path: relativePath, available: false, error: `unreadable JSON source: ${relativePath}: ${error.message}`, data: null };
  }
}

function readTextSource(key, relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { key, path: relativePath, available: false, error: `missing source file: ${relativePath}`, text: '' };
  }
  try {
    return { key, path: relativePath, available: true, error: null, text: readFileSync(absolute(relativePath), 'utf8') };
  } catch (error) {
    return { key, path: relativePath, available: false, error: `unreadable text source: ${relativePath}: ${error.message}`, text: '' };
  }
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, normalizePath(targetPath))})`;
}

function artifactByLabel(demoManifest, labels) {
  const artifacts = Array.isArray(demoManifest?.artifacts) ? demoManifest.artifacts : [];
  return artifacts.find((artifact) => labels.some((label) => artifact.label?.toLowerCase().includes(label)));
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

function extractProofShotGaps(videoScriptText) {
  return videoScriptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\|\s*[^|]+\s*\|\s*TBD\s*\|$/.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      return {
        check: cells[0],
        required_before_final_cut: cells[1],
      };
    });
}

function assetState(label, relativePath, kind) {
  return {
    label,
    kind,
    path: normalizePath(relativePath),
    exists: relativePath ? existsSync(absolute(normalizePath(relativePath))) : false,
  };
}

function buildDemoAssets(demoManifest, browserSmoke) {
  const screenshots = browserSmoke?.screenshots ?? {};
  return [
    assetState('Education projection screenshot', screenshots.education ?? artifactByLabel(demoManifest, ['education projection screenshot'])?.path, 'demo'),
    assetState('Meeting projection screenshot', screenshots.meeting ?? artifactByLabel(demoManifest, ['meeting projection screenshot'])?.path, 'demo'),
    assetState('Android/Paper debug APK', artifactByLabel(demoManifest, ['debug apk'])?.path, 'demo'),
    assetState('Obsidian demo vault README', artifactByLabel(demoManifest, ['obsidian demo vault readme'])?.path, 'demo'),
    assetState('Demo evidence bundle', sourcePaths.demoManifest, 'demo'),
    assetState('Kickstarter critical path', sourcePaths.criticalPath, 'project'),
    assetState('Kickstarter weekly sprint', sourcePaths.weeklySprint, 'project'),
    assetState('Launch KPI dashboard', sourcePaths.kpiDashboard, 'project'),
    assetState('Kickstarter claim downgrade pack', sourcePaths.claimDowngrade, 'project'),
    assetState('Kickstarter public copy lock', sourcePaths.publicCopyLock, 'project'),
    assetState('Kickstarter supplier quote audit', sourcePaths.supplierQuoteAudit, 'project'),
    assetState('Kickstarter page review audit', sourcePaths.pageReviewAudit, 'project'),
    assetState('Kickstarter risk register', sourcePaths.riskRegister, 'project'),
    assetState('Weekly launch review pack', sourcePaths.launchReviewPack, 'project'),
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
      pass_signal: 'Demo evidence bundle exposes presentation_handoff before rehearsal starts.',
      boundary: 'Local demo ready does not equal Kickstarter launch ready.',
    },
  ];
}

function demoAcceptanceSignals(demoManifest) {
  if (Array.isArray(demoManifest?.acceptance_signals) && demoManifest.acceptance_signals.length > 0) {
    return demoManifest.acceptance_signals;
  }
  return ['Demo evidence bundle must expose acceptance_signals before rehearsal starts.'];
}

function buildCampaignAssets() {
  return [
    assetState('Kickstarter page draft', sourcePaths.kickstarterPageDraft, 'campaign'),
    assetState('90-second campaign video script', sourcePaths.campaignVideoScript, 'campaign'),
    assetState('Rewards and FAQ draft', sourcePaths.rewardsFaqDraft, 'campaign'),
    assetState('Claim evidence matrix', sourcePaths.claimEvidenceMatrix, 'campaign'),
    assetState('Launch readiness tracker', sourcePaths.launchReadinessTracker, 'project'),
    assetState('Demo runbook', sourcePaths.demoRunbook, 'project'),
  ];
}

function statusFor({ localDemoReady, campaignDraftsAvailable, launchStatus, publicCopyReady }) {
  if ((launchStatus === 'launch_evidence_ready' || launchStatus === 'launch_ready_evidence_present') && publicCopyReady) {
    return 'publish_evidence_ready';
  }
  if (launchStatus === 'launch_evidence_ready' || launchStatus === 'launch_ready_evidence_present') {
    return 'rehearsal_ready_public_copy_not_ready';
  }
  if (localDemoReady && campaignDraftsAvailable && launchStatus === 'not_launch_ready') return 'rehearsal_ready_launch_not_ready';
  if (localDemoReady && campaignDraftsAvailable) return 'rehearsal_ready_launch_unknown';
  if (localDemoReady) return 'demo_ready_campaign_incomplete';
  return 'not_rehearsal_ready';
}

function assetRows(assets) {
  return assets
    .map((asset) => `| ${asset.kind} | ${asset.label} | ${asset.exists ? 'present' : 'missing'} | ${asset.path ? mdLink(asset.path) : 'n/a'} |`)
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

function proofRows(items) {
  if (items.length === 0) return '| n/a | n/a |';
  return items.map((item) => `| ${item.check} | ${item.required_before_final_cut} |`).join('\n');
}

function redGateRows(redGates) {
  if (!redGates.length) return '| n/a | n/a | n/a | n/a |';
  return redGates
    .map((gate) => `| ${gate.id} | ${gate.status} | ${gate.owner} | ${gate.next_action} |`)
    .join('\n');
}

function readme(pack) {
  const accessIssues = pack.access_issues.length
    ? pack.access_issues.map((issue) => `- ${issue}`).join('\n')
    : '- None';
  const commands = pack.required_commands.map((command) => `- \`${command}\``).join('\n');
  const mustNotClaim = pack.must_not_claim.map((claim) => `- ${claim}`).join('\n');
  const reviewerChecklist = pack.reviewer_checklist.map((item) => `- ${item}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Rehearsal Pack

Schema: \`inkloop.kickstarter_rehearsal_pack.v1\`

Status: \`${pack.status}\`

This Kickstarter rehearsal pack is not publish approval. It is the single handoff package for a local external demo or campaign-video rehearsal: what to show, which assets to open, which proof shots are still missing, and which claims must stay out of the script until real evidence closes the launch gates.

## Rehearsal Status

| Item | Value |
| --- | --- |
| Local demo status | ${pack.local_demo.status} |
| Browser smoke ok | ${pack.local_demo.browser_smoke_ok} |
| Launch status | ${pack.launch.status} |
| Critical path status | ${pack.critical_path.status} |
| Days to preferred launch | ${pack.critical_path.days_to_preferred_launch} |
| Critical path due this week | ${pack.critical_path.due_this_week} |
| Critical path at risk | ${pack.critical_path.at_risk} |
| Weekly sprint status | ${pack.weekly_sprint.status} |
| Weekly sprint tasks | ${pack.weekly_sprint.task_count} |
| KPI dashboard status | ${pack.kpi_dashboard.status} |
| KPI metrics ready | ${pack.kpi_dashboard.ready_metric_count}/${pack.kpi_dashboard.metric_count} |
| Claim downgrade status | ${pack.claim_downgrade.status} |
| Draft-only claims | ${pack.claim_downgrade.draft_only_count}/${pack.claim_downgrade.claim_count} |
| Public copy lock status | ${pack.public_copy_lock.status} |
| Public copy draft-only claims | ${pack.public_copy_lock.draft_only_count}/${pack.public_copy_lock.claim_count} |
| Supplier quote audit status | ${pack.supplier_quote_audit.status} |
| Supplier BOM cost rows | ${pack.supplier_quote_audit.bom_required_rows_with_cost}/${pack.supplier_quote_audit.bom_required_rows} |
| Supplier ready quote rows | ${pack.supplier_quote_audit.ready_quote_count}/${pack.supplier_quote_audit.quote_row_count} |
| Page review audit status | ${pack.page_review_audit.status} |
| Page sections ready | ${pack.page_review_audit.ready_section_count}/${pack.page_review_audit.section_count} |
| Legal/privacy checks ready | ${pack.page_review_audit.ready_legal_check_count}/${pack.page_review_audit.legal_check_count} |
| Risk register status | ${pack.risk_register.status} |
| Open P0 risks | ${pack.risk_register.open_p0_count}/${pack.risk_register.risk_count} |
| Ready launch gates | ${pack.launch.ready_gate_count}/${pack.launch.gate_count} |
| Red launch gates | ${pack.launch.red_gate_count} |
| Proof-shot gaps | ${pack.proof_shot_gaps.length} |

## Required Commands

${commands}

## Demo Assets

| Kind | Asset | State | Path |
| --- | --- | --- | --- |
${assetRows(pack.demo_assets)}

## Demo Handoff

| Step | Surface | Open | Pass Signal | Boundary |
| ---: | --- | --- | --- | --- |
${handoffRows(pack.local_demo.presentation_handoff)}

## Demo Acceptance Signals

${listRows(pack.local_demo.acceptance_signals)}

## Campaign Assets

| Kind | Asset | State | Path |
| --- | --- | --- | --- |
${assetRows(pack.campaign_assets)}

## Rehearsal Run Of Show

1. Open the Web/Desktop AI Pen demo and show the education path from raw pen import to reviewed lesson projection.
2. Show the meeting path from marked board events to reviewed decisions, actions, risks, and diagram projection.
3. Open the Obsidian demo vault and show only accepted or edited projections with \`inkloop://doc/...\` backlinks.
4. Show Android/Paper as runtime reuse and local-first packaging, not the October 2026 base Kickstarter hardware.
5. Review the Kickstarter page draft and video script against the claim evidence matrix.
6. Close with the launch review pack: local demo is ready, public launch evidence is still not ready.

## Proof-Shot Gaps

| Check | Required Before Final Cut |
| --- | --- |
${proofRows(pack.proof_shot_gaps)}

## Red Gates To Mention Internally

| Gate | Status | Owner | Next Action |
| --- | --- | --- | --- |
${redGateRows(pack.red_gates)}

## Reviewer Checklist

${reviewerChecklist}

## Must Not Claim

${mustNotClaim}

## Access Issues

${accessIssues}

Detailed manifest: [rehearsal-pack.json](./rehearsal-pack.json)
`;
}

const sources = {
  demoManifest: readJsonSource('demoManifest', sourcePaths.demoManifest),
  browserSmoke: readJsonSource('browserSmoke', sourcePaths.browserSmoke),
  launchReviewPack: readJsonSource('launchReviewPack', sourcePaths.launchReviewPack),
  criticalPath: readJsonSource('criticalPath', sourcePaths.criticalPath),
  weeklySprint: readJsonSource('weeklySprint', sourcePaths.weeklySprint),
  kpiDashboard: readJsonSource('kpiDashboard', sourcePaths.kpiDashboard),
  claimDowngrade: readJsonSource('claimDowngrade', sourcePaths.claimDowngrade),
  publicCopyLock: readJsonSource('publicCopyLock', sourcePaths.publicCopyLock),
  supplierQuoteAudit: readJsonSource('supplierQuoteAudit', sourcePaths.supplierQuoteAudit),
  pageReviewAudit: readJsonSource('pageReviewAudit', sourcePaths.pageReviewAudit),
  riskRegister: readJsonSource('riskRegister', sourcePaths.riskRegister),
  launchAudit: readJsonSource('launchAudit', sourcePaths.launchAudit),
  kickstarterPageDraft: readTextSource('kickstarterPageDraft', sourcePaths.kickstarterPageDraft),
  campaignVideoScript: readTextSource('campaignVideoScript', sourcePaths.campaignVideoScript),
  rewardsFaqDraft: readTextSource('rewardsFaqDraft', sourcePaths.rewardsFaqDraft),
  claimEvidenceMatrix: readTextSource('claimEvidenceMatrix', sourcePaths.claimEvidenceMatrix),
  launchReadinessTracker: readTextSource('launchReadinessTracker', sourcePaths.launchReadinessTracker),
  demoRunbook: readTextSource('demoRunbook', sourcePaths.demoRunbook),
};

const demoManifest = sources.demoManifest.data;
const browserSmoke = sources.browserSmoke.data;
const launchReviewPack = sources.launchReviewPack.data;
const criticalPath = sources.criticalPath.data;
const weeklySprint = sources.weeklySprint.data;
const kpiDashboard = sources.kpiDashboard.data;
const claimDowngrade = sources.claimDowngrade.data;
const publicCopyLock = sources.publicCopyLock.data;
const supplierQuoteAudit = sources.supplierQuoteAudit.data;
const pageReviewAudit = sources.pageReviewAudit.data;
const riskRegister = sources.riskRegister.data;
const launchAudit = sources.launchAudit.data;
const campaignDraftsAvailable = [
  sources.kickstarterPageDraft,
  sources.campaignVideoScript,
  sources.rewardsFaqDraft,
  sources.claimEvidenceMatrix,
].every((source) => source.available);
const localDemoReady = demoManifest?.status === 'local_demo_ready' && browserSmoke?.ok === true;
const launchStatus = launchAudit?.status ?? launchReviewPack?.launch?.audit_status ?? 'unknown';
const publicCopyReady = publicCopyLock?.status === 'public_copy_lock_ready' || launchReviewPack?.public_copy_lock?.status === 'public_copy_lock_ready';
const redGates = Array.isArray(launchReviewPack?.red_gates) ? launchReviewPack.red_gates : [];

const pack = {
  schema: 'inkloop.kickstarter_rehearsal_pack.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({ localDemoReady, campaignDraftsAvailable, launchStatus, publicCopyReady }),
  sources: sourceMap(sources),
  access_issues: sourceIssues(sources),
  local_demo: {
    status: demoManifest?.status ?? 'unknown',
    browser_smoke_ok: browserSmoke?.ok === true,
    browser_smoke_url: browserSmoke?.url ?? demoManifest?.browser_smoke?.url ?? null,
    presentation_handoff: demoHandoff(demoManifest),
    acceptance_signals: demoAcceptanceSignals(demoManifest),
  },
  launch: {
    status: launchStatus,
    gate_count: launchAudit?.summary?.gate_count ?? launchReviewPack?.launch?.gate_count ?? 0,
    ready_gate_count: launchAudit?.summary?.ready_gate_count ?? launchReviewPack?.launch?.ready_gate_count ?? 0,
    red_gate_count: redGates.length || launchAudit?.summary?.not_ready_gate_count || 0,
  },
  critical_path: {
    status: criticalPath?.status ?? launchReviewPack?.critical_path?.status ?? 'unknown',
    days_to_preferred_launch:
      criticalPath?.summary?.days_to_preferred_launch ?? launchReviewPack?.critical_path?.days_to_preferred_launch ?? null,
    due_this_week: criticalPath?.summary?.status_counts?.due_this_week ?? launchReviewPack?.critical_path?.due_this_week ?? 0,
    at_risk: criticalPath?.summary?.status_counts?.at_risk ?? launchReviewPack?.critical_path?.at_risk ?? 0,
    overdue: criticalPath?.summary?.status_counts?.overdue ?? launchReviewPack?.critical_path?.overdue ?? 0,
  },
  weekly_sprint: {
    status: weeklySprint?.status ?? launchReviewPack?.weekly_sprint?.status ?? 'unknown',
    task_count: weeklySprint?.summary?.task_count ?? launchReviewPack?.weekly_sprint?.task_count ?? 0,
    at_risk_task_count: weeklySprint?.summary?.at_risk_task_count ?? launchReviewPack?.weekly_sprint?.at_risk_task_count ?? 0,
    due_this_week_task_count:
      weeklySprint?.summary?.due_this_week_task_count ?? launchReviewPack?.weekly_sprint?.due_this_week_task_count ?? 0,
    overdue_task_count: weeklySprint?.summary?.overdue_task_count ?? launchReviewPack?.weekly_sprint?.overdue_task_count ?? 0,
  },
  kpi_dashboard: {
    status: kpiDashboard?.status ?? launchReviewPack?.kpi_dashboard?.status ?? 'unknown',
    metric_count: kpiDashboard?.summary?.metric_count ?? launchReviewPack?.kpi_dashboard?.metric_count ?? 0,
    ready_metric_count: kpiDashboard?.summary?.ready_metric_count ?? launchReviewPack?.kpi_dashboard?.ready_metric_count ?? 0,
    not_ready_metric_count:
      kpiDashboard?.summary?.not_ready_metric_count ?? launchReviewPack?.kpi_dashboard?.not_ready_metric_count ?? 0,
  },
  claim_downgrade: {
    status: claimDowngrade?.status ?? launchReviewPack?.claim_downgrade?.status ?? 'unknown',
    claim_count: claimDowngrade?.summary?.claim_count ?? launchReviewPack?.claim_downgrade?.claim_count ?? 0,
    public_claim_allowed_count:
      claimDowngrade?.summary?.public_claim_allowed_count ?? launchReviewPack?.claim_downgrade?.public_claim_allowed_count ?? 0,
    guardrail_copy_allowed_count:
      claimDowngrade?.summary?.guardrail_copy_allowed_count ?? launchReviewPack?.claim_downgrade?.guardrail_copy_allowed_count ?? 0,
    demo_wording_only_count:
      claimDowngrade?.summary?.demo_wording_only_count ?? launchReviewPack?.claim_downgrade?.demo_wording_only_count ?? 0,
    draft_only_count: claimDowngrade?.summary?.draft_only_count ?? launchReviewPack?.claim_downgrade?.draft_only_count ?? 0,
  },
  public_copy_lock: {
    status: publicCopyLock?.status ?? launchReviewPack?.public_copy_lock?.status ?? 'unknown',
    claim_count: publicCopyLock?.summary?.claim_count ?? launchReviewPack?.public_copy_lock?.claim_count ?? 0,
    public_claim_allowed_count:
      publicCopyLock?.summary?.public_claim_allowed_count ?? launchReviewPack?.public_copy_lock?.public_claim_allowed_count ?? 0,
    guardrail_copy_allowed_count:
      publicCopyLock?.summary?.guardrail_copy_allowed_count ?? launchReviewPack?.public_copy_lock?.guardrail_copy_allowed_count ?? 0,
    demo_wording_only_count:
      publicCopyLock?.summary?.demo_wording_only_count ?? launchReviewPack?.public_copy_lock?.demo_wording_only_count ?? 0,
    draft_only_count: publicCopyLock?.summary?.draft_only_count ?? launchReviewPack?.public_copy_lock?.draft_only_count ?? 0,
    ready_shot_count: publicCopyLock?.summary?.ready_shot_count ?? launchReviewPack?.public_copy_lock?.ready_shot_count ?? 0,
    shot_count: publicCopyLock?.summary?.shot_count ?? launchReviewPack?.public_copy_lock?.shot_count ?? 0,
  },
  supplier_quote_audit: {
    status: supplierQuoteAudit?.status ?? launchReviewPack?.supplier_quote_audit?.status ?? 'unknown',
    bom_required_rows: supplierQuoteAudit?.summary?.bom_required_rows ?? launchReviewPack?.supplier_quote_audit?.bom_required_rows ?? 0,
    bom_required_rows_with_cost:
      supplierQuoteAudit?.summary?.bom_required_rows_with_cost ??
      launchReviewPack?.supplier_quote_audit?.bom_required_rows_with_cost ??
      0,
    quote_row_count: supplierQuoteAudit?.summary?.quote_row_count ?? launchReviewPack?.supplier_quote_audit?.quote_row_count ?? 0,
    ready_quote_count: supplierQuoteAudit?.summary?.ready_quote_count ?? launchReviewPack?.supplier_quote_audit?.ready_quote_count ?? 0,
    blocker_count: supplierQuoteAudit?.summary?.blocker_count ?? launchReviewPack?.supplier_quote_audit?.blocker_count ?? 0,
  },
  page_review_audit: {
    status: pageReviewAudit?.status ?? launchReviewPack?.page_review_audit?.status ?? 'unknown',
    review_field_count: pageReviewAudit?.summary?.review_field_count ?? launchReviewPack?.page_review_audit?.review_field_count ?? 0,
    ready_review_field_count:
      pageReviewAudit?.summary?.ready_review_field_count ?? launchReviewPack?.page_review_audit?.ready_review_field_count ?? 0,
    section_count: pageReviewAudit?.summary?.section_count ?? launchReviewPack?.page_review_audit?.section_count ?? 0,
    ready_section_count: pageReviewAudit?.summary?.ready_section_count ?? launchReviewPack?.page_review_audit?.ready_section_count ?? 0,
    legal_check_count: pageReviewAudit?.summary?.legal_check_count ?? launchReviewPack?.page_review_audit?.legal_check_count ?? 0,
    ready_legal_check_count:
      pageReviewAudit?.summary?.ready_legal_check_count ?? launchReviewPack?.page_review_audit?.ready_legal_check_count ?? 0,
    blocker_count: pageReviewAudit?.summary?.blocker_count ?? launchReviewPack?.page_review_audit?.blocker_count ?? 0,
  },
  risk_register: {
    status: riskRegister?.status ?? launchReviewPack?.risk_register?.status ?? 'unknown',
    risk_count: riskRegister?.summary?.risk_count ?? launchReviewPack?.risk_register?.risk_count ?? 0,
    open_p0_count: riskRegister?.summary?.open_p0_count ?? launchReviewPack?.risk_register?.open_p0_count ?? 0,
    launch_impact_count: riskRegister?.summary?.launch_impact_count ?? launchReviewPack?.risk_register?.launch_impact_count ?? 0,
    at_risk_count: riskRegister?.summary?.at_risk_count ?? launchReviewPack?.risk_register?.at_risk_count ?? 0,
  },
  demo_assets: buildDemoAssets(demoManifest, browserSmoke),
  campaign_assets: buildCampaignAssets(),
  proof_shot_gaps: extractProofShotGaps(sources.campaignVideoScript.text),
  red_gates: redGates.map((gate) => ({
    id: gate.id,
    status: gate.status,
    owner: gate.owner,
    next_action: gate.next_action,
    evidence_record: gate.evidence_record,
  })),
  reviewer_checklist: [
    'Re-run `npm run verify:local-demo-handoff` before any external presentation.',
    'Re-run `npm run verify:kickstarter-claims` before copying campaign text into a deck, script, landing page, or Kickstarter draft.',
    'Re-run `npm run launch:critical-path` before any rehearsal that changes milestone pressure or launch dates.',
    'Re-run `npm run launch:weekly-sprint` before any rehearsal that changes the next sprint task list.',
    'Re-run `npm run launch:kpi-dashboard` before any rehearsal that changes KR, Launch Gate, or weekly board status.',
    'Re-run `npm run kickstarter:claim-downgrade` before copying any claim into Kickstarter, video narration, ads, or landing pages.',
    'Re-run `npm run kickstarter:public-copy-lock` before treating page, video, ad, or landing-page copy as final.',
    'Re-run `npm run kickstarter:supplier-quote-audit` before treating reward pricing, supply claims, or delivery assumptions as rehearsal-ready.',
    'Re-run `npm run kickstarter:page-review-audit` before treating the Kickstarter preview page, AI/privacy disclosure, or legal/privacy review as rehearsal-ready.',
    'Re-run `npm run kickstarter:risk-register` before any rehearsal that changes P0 status, downgrade decisions, or launch-risk pressure.',
    'Use `npm run launch:review-pack` as the status page at the end of every rehearsal.',
    'If a proof shot is still marked TBD, keep the related video or page claim in draft-only wording.',
    'Do not use strict launch audit as passed until real artifacts, analyzer reports, and pass or conditional-pass decisions are linked.',
  ],
  must_not_claim: [
    'Works on any whiteboard without setup.',
    'Perfect AI transcription, perfect lesson notes, or perfect diagram understanding.',
    'Zero latency or instant capture.',
    'Fully autonomous meeting assistant.',
    'E-paper tablet included in the October 2026 base Kickstarter reward.',
    'Supplier pricing, delivery dates, testimonials, or demand are proven before the evidence records show real proof.',
  ],
  required_commands: [
    'npm run verify:local-demo-handoff',
    'npm run verify:kickstarter-claims',
    'npm run launch:evidence:audit',
    'npm run launch:action-plan',
    'npm run launch:critical-path',
    'npm run launch:weekly-sprint',
    'npm run launch:kpi-dashboard',
    'npm run kickstarter:claim-downgrade',
    'npm run kickstarter:public-copy-lock',
    'npm run kickstarter:supplier-quote-audit',
    'npm run kickstarter:page-review-audit',
    'npm run kickstarter:risk-register',
    'npm run launch:review-pack',
    'npm run kickstarter:rehearsal-pack',
    'npm run launch:evidence:audit:strict',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(pack, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(pack));

console.log(`Kickstarter rehearsal pack status: ${pack.status}`);
console.log(`Local demo: ${pack.local_demo.status}; launch: ${pack.launch.status}; critical path: ${pack.critical_path.status}; weekly sprint: ${pack.weekly_sprint.status}; KPI dashboard: ${pack.kpi_dashboard.status}; claim downgrade: ${pack.claim_downgrade.status}; public copy lock: ${pack.public_copy_lock.status}; supplier quote audit: ${pack.supplier_quote_audit.status}; page review audit: ${pack.page_review_audit.status}; risk register: ${pack.risk_register.status}; proof-shot gaps: ${pack.proof_shot_gaps.length}`);
console.log(`Report: ${outReadmePath}`);
