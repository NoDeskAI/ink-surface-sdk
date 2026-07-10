import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-launch-freeze';
const outJsonPath = `${outDir}/launch-freeze.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const sourcePaths = {
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  publicCopyLock: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
  riskRegister: 'test-results/ai-pen-kickstarter-risk-register/risk-register.json',
  proofShotAudit: 'test-results/ai-pen-kickstarter-proof-shot-audit/report.json',
  launchReviewPack: 'test-results/ai-pen-launch-review-pack/review-pack.json',
  rehearsalPack: 'test-results/ai-pen-kickstarter-rehearsal/rehearsal-pack.json',
  operatorPack: 'test-results/ai-pen-launch-operator-pack/operator-pack.json',
  supplierQuoteAudit: 'test-results/ai-pen-kickstarter-supplier-quote-audit/report.json',
  pageReviewAudit: 'test-results/ai-pen-kickstarter-page-review-audit/report.json',
  launchSignoffAudit: 'test-results/ai-pen-kickstarter-launch-signoff-audit/report.json',
  launchFreezeSignoff: 'docs/project/inkloop-ai-pen-kickstarter/evidence/launch-freeze-signoff.md',
  kickstarterPageChecklist: 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md',
  bomSupplierTracker: 'docs/project/inkloop-ai-pen-kickstarter/evidence/bom-supplier-tracker.md',
  gtmMetricsTracker: 'docs/project/inkloop-ai-pen-kickstarter/evidence/gtm-metrics-tracker.md',
  pageDraft: 'docs/project/inkloop-ai-pen-kickstarter/campaign/kickstarter-page-draft.md',
  videoScript: 'docs/project/inkloop-ai-pen-kickstarter/campaign/campaign-video-script.md',
  rewardsFaq: 'docs/project/inkloop-ai-pen-kickstarter/campaign/rewards-faq-draft.md',
  claimMatrix: 'docs/project/inkloop-ai-pen-kickstarter/campaign/claim-evidence-matrix.md',
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

function hasBlockingPlaceholder(value) {
  return !value || /\bTBD\b|not ready|0% publish evidence|not requested|rejected|unknown/i.test(value);
}

function decisionIsReady(value) {
  return Boolean(value) && /^ready\b/i.test(value.trim()) && !/not ready|conditional|draft/i.test(value);
}

function linkIsReady(value) {
  return Boolean(value) && !hasBlockingPlaceholder(value);
}

function signoffIsReady(value) {
  return Boolean(value) && /^approved\b|^ready\b/i.test(value.trim()) && !/not ready|conditional|draft|TBD/i.test(value);
}

function allOwnerSignoffsReady(signoffFields) {
  const required = [
    'Campaign owner signoff',
    'Hardware owner signoff',
    'GTM owner signoff',
    'Legal/privacy owner signoff',
    'Operations owner signoff',
    'Founder manual launch signoff',
  ];
  return required.every((field) => signoffIsReady(signoffFields[field]));
}

function gate(id, label, ready, evidence, blockers, nextAction) {
  return {
    id,
    label,
    status: ready ? 'ready' : 'not_ready',
    evidence,
    blockers: ready ? [] : blockers.filter(Boolean),
    next_action: ready ? 'Keep evidence immutable for launch freeze review.' : nextAction,
  };
}

function buildFreezeGates({ sources, pageFields, bomFields, gtmFields, signoffFields }) {
  const launchAudit = sources.launchAudit.data;
  const publicCopyLock = sources.publicCopyLock.data;
  const riskRegister = sources.riskRegister.data;
  const proofShotAudit = sources.proofShotAudit.data;
  const launchReviewPack = sources.launchReviewPack.data;
  const rehearsalPack = sources.rehearsalPack.data;
  const operatorPack = sources.operatorPack.data;
  const supplierQuoteAudit = sources.supplierQuoteAudit.data;
  const pageReviewAudit = sources.pageReviewAudit.data;
  const launchSignoffAudit = sources.launchSignoffAudit.data;

  const openP0Count = riskRegister?.summary?.open_p0_count ?? 999;
  const readyProofShots = proofShotAudit?.summary?.ready_shot_count ?? 0;
  const proofShotCount = proofShotAudit?.summary?.shot_count ?? 0;
  const pageDecision = pageFields.Decision ?? '';
  const bomDecision = bomFields.Decision ?? '';
  const gtmDecision = gtmFields.Decision ?? '';
  const finalLaunchDecision = signoffFields['Final launch decision'] ?? '';

  return [
    gate(
      'F-LAUNCH-EVIDENCE',
      'All launch evidence gates are ready',
      launchAudit?.status === 'launch_ready_evidence_present',
      sources.launchAudit.path,
      [`launch audit status: ${launchAudit?.status ?? 'unknown'}`, `${launchAudit?.summary?.not_ready_gate_count ?? 'unknown'} launch gates are still red`],
      'Close every launch evidence record with real raw artifacts, analyzer reports, supporting links, and pass/conditional-pass decisions.',
    ),
    gate(
      'F-P0-RISK',
      'No open P0 launch risks',
      openP0Count === 0 && riskRegister?.status === 'risk_register_ready',
      sources.riskRegister.path,
      [`risk register status: ${riskRegister?.status ?? 'unknown'}`, `open P0 risks: ${openP0Count}`],
      'Fix, downgrade, or explicitly disclose each open P0 risk before launch freeze.',
    ),
    gate(
      'F-PUBLIC-COPY',
      'Public copy lock is ready',
      publicCopyLock?.status === 'public_copy_lock_ready',
      sources.publicCopyLock.path,
      [`public copy lock status: ${publicCopyLock?.status ?? 'unknown'}`, `${publicCopyLock?.summary?.draft_only_count ?? 'unknown'} draft-only claims remain`],
      'Refresh claim downgrade, proof-shot audit, and campaign draft sources until public copy lock reaches ready.',
    ),
    gate(
      'F-FINAL-CUT-PROOF',
      'Final-cut proof shots are ready',
      proofShotAudit?.status === 'final_cut_ready',
      sources.proofShotAudit.path,
      [`proof-shot audit status: ${proofShotAudit?.status ?? 'unknown'}`, `final-cut proof shots: ${readyProofShots}/${proofShotCount}`],
      'Film real proof shots, fill shot logs and claim review CSVs, and rerun the proof-shot audit.',
    ),
    gate(
      'F-KICKSTARTER-PREVIEW',
      'Kickstarter preview link is ready',
      linkIsReady(pageFields['Kickstarter preview link']) && pageReviewAudit?.status === 'page_review_ready',
      sources.kickstarterPageChecklist.path,
      [
        `Kickstarter preview link: ${pageFields['Kickstarter preview link'] ?? 'missing'}`,
        `page review audit: ${pageReviewAudit?.status ?? 'unknown'}`,
      ],
      'Create the Kickstarter preview, run the page review audit, paste the reviewable link into the page checklist, and rerun this freeze pack.',
    ),
    gate(
      'F-LEGAL-PRIVACY',
      'Legal and privacy review is linked',
      linkIsReady(pageFields['Legal/privacy review link']) && pageReviewAudit?.status === 'page_review_ready',
      sources.kickstarterPageChecklist.path,
      [
        `Legal/privacy review link: ${pageFields['Legal/privacy review link'] ?? 'missing'}`,
        `page review audit: ${pageReviewAudit?.status ?? 'unknown'}`,
      ],
      'Complete outside legal/privacy review for AI, data handling, hardware, delivery, and risk disclosures, then rerun the page review audit.',
    ),
    gate(
      'F-PAGE-DECISION',
      'Campaign page decision is ready',
      decisionIsReady(pageDecision) && pageReviewAudit?.status === 'page_review_ready',
      sources.kickstarterPageChecklist.path,
      [`page decision: ${pageDecision || 'missing'}`, `page review audit: ${pageReviewAudit?.status ?? 'unknown'}`],
      'Move page checklist decision from draft/conditional to ready only after preview, claims, risks, rewards, page review audit, and reviews are closed.',
    ),
    gate(
      'F-REWARDS-PRICING',
      'Rewards and pricing are supplier backed',
      decisionIsReady(bomDecision) &&
        linkIsReady(bomFields['Pricing sheet path']) &&
        linkIsReady(bomFields['Supplier quote folder']) &&
        supplierQuoteAudit?.status === 'supplier_quotes_ready',
      sources.bomSupplierTracker.path,
      [
        `BOM decision: ${bomDecision || 'missing'}`,
        `pricing sheet: ${bomFields['Pricing sheet path'] ?? 'missing'}`,
        `supplier quote folder: ${bomFields['Supplier quote folder'] ?? 'missing'}`,
        `supplier quote audit: ${supplierQuoteAudit?.status ?? 'unknown'}`,
      ],
      'Attach real BOM, pricing sheet, supplier quotes, backup suppliers, lead times, public pricing decision, and a ready supplier quote audit.',
    ),
    gate(
      'F-GTM-DEMAND',
      'GTM launch demand is ready',
      decisionIsReady(gtmDecision) && linkIsReady(gtmFields['GTM analyzer report path']) && linkIsReady(gtmFields['Kickstarter dashboard export link']),
      sources.gtmMetricsTracker.path,
      [`GTM decision: ${gtmDecision || 'missing'}`, `GTM report: ${gtmFields['GTM analyzer report path'] ?? 'missing'}`, `Kickstarter dashboard export: ${gtmFields['Kickstarter dashboard export link'] ?? 'missing'}`],
      'Attach weekly CRM export, Kickstarter dashboard export, testimonial evidence, and first-day likely backer snapshot.',
    ),
    gate(
      'F-REHEARSAL-HANDOFF',
      'External rehearsal package is publish-evidence ready',
      rehearsalPack?.status === 'publish_evidence_ready',
      sources.rehearsalPack.path,
      [`rehearsal pack status: ${rehearsalPack?.status ?? 'unknown'}`],
      'Rerun rehearsal after launch evidence, public copy, and proof shots are ready, then keep the final handoff immutable.',
    ),
    gate(
      'F-OPERATOR-CLOSEOUT',
      'Operator pack has no remaining field capture blockers',
      operatorPack?.status === 'operator_pack_launch_evidence_ready',
      sources.operatorPack.path,
      [`operator pack status: ${operatorPack?.status ?? 'unknown'}`],
      'Finish field capture sessions and evidence-record writeback so the operator pack reaches launch-evidence-ready.',
    ),
    gate(
      'F-WEEKLY-REVIEW',
      'Weekly launch review pack agrees with launch readiness',
      launchReviewPack?.status === 'launch_evidence_ready',
      sources.launchReviewPack.path,
      [`launch review pack status: ${launchReviewPack?.status ?? 'unknown'}`],
      'Rerun the weekly launch review pack after all launch gates, P0 risks, public copy, and proof shots are closed.',
    ),
    gate(
      'F-HUMAN-SIGNOFF',
      'Final owner signoff and manual launch coverage are ready',
      allOwnerSignoffsReady(signoffFields) &&
        decisionIsReady(finalLaunchDecision) &&
        linkIsReady(signoffFields['Manual launch operator']) &&
        linkIsReady(signoffFields['Launch room coverage']) &&
        launchSignoffAudit?.status === 'launch_signoff_ready',
      sources.launchSignoffAudit.path,
      [
        `launch signoff audit: ${launchSignoffAudit?.status ?? 'unknown'}`,
        `signoff status: ${signoffFields['Signoff status'] ?? 'missing'}`,
        `campaign owner: ${signoffFields['Campaign owner signoff'] ?? 'missing'}`,
        `hardware owner: ${signoffFields['Hardware owner signoff'] ?? 'missing'}`,
        `GTM owner: ${signoffFields['GTM owner signoff'] ?? 'missing'}`,
        `legal/privacy owner: ${signoffFields['Legal/privacy owner signoff'] ?? 'missing'}`,
        `operations owner: ${signoffFields['Operations owner signoff'] ?? 'missing'}`,
        `founder manual launch signoff: ${signoffFields['Founder manual launch signoff'] ?? 'missing'}`,
        `manual launch operator: ${signoffFields['Manual launch operator'] ?? 'missing'}`,
        `launch room coverage: ${signoffFields['Launch room coverage'] ?? 'missing'}`,
        `final launch decision: ${finalLaunchDecision || 'missing'}`,
      ],
      'Collect explicit campaign, hardware, GTM, legal/privacy, operations, and founder signoffs after all freeze evidence is ready; assign the manual Kickstarter launch owner and launch-room coverage.',
    ),
  ];
}

function statusFor({ accessIssues, freezeGates }) {
  if (accessIssues.length > 0) return 'launch_freeze_missing_sources';
  if (freezeGates.every((item) => item.status === 'ready')) return 'launch_freeze_ready';
  return 'launch_freeze_not_ready';
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, targetPath)})`;
}

function gateRows(gates) {
  return gates
    .map((item) => `| ${item.id} | ${item.status} | ${item.label} | ${mdLink(item.evidence)} | ${item.blockers.join('; ') || 'none'} | ${item.next_action} |`)
    .join('\n');
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

  return `# InkLoop AI Pen Kickstarter Launch Freeze Pack

Schema: \`inkloop.kickstarter_launch_freeze.v1\`

Status: \`${report.status}\`

This is the final Go/No-Go evidence package for the October 2026 Kickstarter launch freeze. It is not launch approval and it does not create human sign-off.

## Snapshot

| Item | Value |
| --- | --- |
| Launch audit status | ${report.snapshot.launch_audit_status} |
| Public copy lock status | ${report.snapshot.public_copy_lock_status} |
| Risk register status | ${report.snapshot.risk_register_status} |
| Open P0 risks | ${report.snapshot.open_p0_count}/${report.snapshot.risk_count} |
| Proof-shot audit status | ${report.snapshot.proof_shot_audit_status} |
| Final-cut proof shots | ${report.snapshot.ready_shot_count}/${report.snapshot.shot_count} |
| Kickstarter preview link | ${report.snapshot.kickstarter_preview_link} |
| Legal/privacy review link | ${report.snapshot.legal_privacy_review_link} |
| Page review audit status | ${report.snapshot.page_review_audit_status} |
| Page sections ready | ${report.snapshot.page_review_ready_sections}/${report.snapshot.page_review_sections} |
| Legal/privacy checks ready | ${report.snapshot.page_review_ready_legal_checks}/${report.snapshot.page_review_legal_checks} |
| Launch signoff audit status | ${report.snapshot.launch_signoff_audit_status} |
| Owner signoffs ready | ${report.snapshot.launch_signoff_ready_owners}/${report.snapshot.launch_signoff_owners} |
| Signoff launch-day tasks ready | ${report.snapshot.launch_signoff_ready_tasks}/${report.snapshot.launch_signoff_tasks} |
| Page decision | ${report.snapshot.page_decision} |
| BOM decision | ${report.snapshot.bom_decision} |
| Supplier quote audit status | ${report.snapshot.supplier_quote_audit_status} |
| Supplier BOM cost rows | ${report.snapshot.supplier_bom_cost_rows}/${report.snapshot.supplier_bom_required_rows} |
| Supplier ready quote rows | ${report.snapshot.supplier_ready_quote_rows}/${report.snapshot.supplier_quote_rows} |
| GTM decision | ${report.snapshot.gtm_decision} |
| Launch review status | ${report.snapshot.launch_review_status} |
| Rehearsal status | ${report.snapshot.rehearsal_status} |
| Operator pack status | ${report.snapshot.operator_pack_status} |
| Human signoff status | ${report.snapshot.signoff_status} |
| Final launch decision | ${report.snapshot.final_launch_decision} |
| Freeze gates ready | ${report.summary.ready_gate_count}/${report.summary.gate_count} |

## Freeze Gates

| Gate | Status | Required Evidence | Source | Blockers | Next Action |
| --- | --- | --- | --- | --- | --- |
${gateRows(report.freeze_gates)}

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

Detailed JSON: [launch-freeze.json](./launch-freeze.json)
`;
}

const sources = {
  launchAudit: readJsonSource(sourcePaths.launchAudit),
  publicCopyLock: readJsonSource(sourcePaths.publicCopyLock),
  riskRegister: readJsonSource(sourcePaths.riskRegister),
  proofShotAudit: readJsonSource(sourcePaths.proofShotAudit),
  launchReviewPack: readJsonSource(sourcePaths.launchReviewPack),
  rehearsalPack: readJsonSource(sourcePaths.rehearsalPack),
  operatorPack: readJsonSource(sourcePaths.operatorPack),
  supplierQuoteAudit: readJsonSource(sourcePaths.supplierQuoteAudit),
  pageReviewAudit: readJsonSource(sourcePaths.pageReviewAudit),
  launchSignoffAudit: readJsonSource(sourcePaths.launchSignoffAudit),
  launchFreezeSignoff: readTextSource(sourcePaths.launchFreezeSignoff),
  kickstarterPageChecklist: readTextSource(sourcePaths.kickstarterPageChecklist),
  bomSupplierTracker: readTextSource(sourcePaths.bomSupplierTracker),
  gtmMetricsTracker: readTextSource(sourcePaths.gtmMetricsTracker),
  pageDraft: readTextSource(sourcePaths.pageDraft),
  videoScript: readTextSource(sourcePaths.videoScript),
  rewardsFaq: readTextSource(sourcePaths.rewardsFaq),
  claimMatrix: readTextSource(sourcePaths.claimMatrix),
};

const accessIssues = sourceIssues(sources);
const pageFields = parseFieldTable(sources.kickstarterPageChecklist.text);
const bomFields = parseFieldTable(sources.bomSupplierTracker.text);
const gtmFields = parseFieldTable(sources.gtmMetricsTracker.text);
const signoffFields = parseFieldTable(sources.launchFreezeSignoff.text);
const freezeGates = buildFreezeGates({ sources, pageFields, bomFields, gtmFields, signoffFields });
const readyGates = freezeGates.filter((item) => item.status === 'ready');

const report = {
  schema: 'inkloop.kickstarter_launch_freeze.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({ accessIssues, freezeGates }),
  sources: sourceMap(sources),
  access_issues: accessIssues,
  snapshot: {
    launch_audit_status: sources.launchAudit.data?.status ?? 'unknown',
    public_copy_lock_status: sources.publicCopyLock.data?.status ?? 'unknown',
    risk_register_status: sources.riskRegister.data?.status ?? 'unknown',
    risk_count: sources.riskRegister.data?.summary?.risk_count ?? 0,
    open_p0_count: sources.riskRegister.data?.summary?.open_p0_count ?? 0,
    proof_shot_audit_status: sources.proofShotAudit.data?.status ?? 'unknown',
    shot_count: sources.proofShotAudit.data?.summary?.shot_count ?? 0,
    ready_shot_count: sources.proofShotAudit.data?.summary?.ready_shot_count ?? 0,
    kickstarter_preview_link: pageFields['Kickstarter preview link'] ?? 'missing',
    legal_privacy_review_link: pageFields['Legal/privacy review link'] ?? 'missing',
    page_review_audit_status: sources.pageReviewAudit.data?.status ?? 'unknown',
    page_review_sections: sources.pageReviewAudit.data?.summary?.section_count ?? 0,
    page_review_ready_sections: sources.pageReviewAudit.data?.summary?.ready_section_count ?? 0,
    page_review_legal_checks: sources.pageReviewAudit.data?.summary?.legal_check_count ?? 0,
    page_review_ready_legal_checks: sources.pageReviewAudit.data?.summary?.ready_legal_check_count ?? 0,
    launch_signoff_audit_status: sources.launchSignoffAudit.data?.status ?? 'unknown',
    launch_signoff_owners: sources.launchSignoffAudit.data?.summary?.owner_signoff_count ?? 0,
    launch_signoff_ready_owners: sources.launchSignoffAudit.data?.summary?.ready_owner_signoff_count ?? 0,
    launch_signoff_tasks: sources.launchSignoffAudit.data?.summary?.launch_day_task_count ?? 0,
    launch_signoff_ready_tasks: sources.launchSignoffAudit.data?.summary?.ready_launch_day_task_count ?? 0,
    page_decision: pageFields.Decision ?? 'missing',
    bom_decision: bomFields.Decision ?? 'missing',
    gtm_decision: gtmFields.Decision ?? 'missing',
    launch_review_status: sources.launchReviewPack.data?.status ?? 'unknown',
    rehearsal_status: sources.rehearsalPack.data?.status ?? 'unknown',
    operator_pack_status: sources.operatorPack.data?.status ?? 'unknown',
    supplier_quote_audit_status: sources.supplierQuoteAudit.data?.status ?? 'unknown',
    supplier_bom_required_rows: sources.supplierQuoteAudit.data?.summary?.bom_required_rows ?? 0,
    supplier_bom_cost_rows: sources.supplierQuoteAudit.data?.summary?.bom_required_rows_with_cost ?? 0,
    supplier_quote_rows: sources.supplierQuoteAudit.data?.summary?.quote_row_count ?? 0,
    supplier_ready_quote_rows: sources.supplierQuoteAudit.data?.summary?.ready_quote_count ?? 0,
    signoff_status: signoffFields['Signoff status'] ?? 'missing',
    final_launch_decision: signoffFields['Final launch decision'] ?? 'missing',
  },
  summary: {
    gate_count: freezeGates.length,
    ready_gate_count: readyGates.length,
    not_ready_gate_count: freezeGates.length - readyGates.length,
  },
  freeze_gates: freezeGates,
  required_commands: [
    'npm run kickstarter:ops-refresh',
    'npm run launch:evidence:audit:strict',
    'npm run kickstarter:public-copy-lock:strict',
    'npm run kickstarter:supplier-quote-audit:strict',
    'npm run kickstarter:page-review-audit:strict',
    'npm run kickstarter:launch-signoff-audit:strict',
    'npm run kickstarter:proof-shot-audit:strict',
    'npm run kickstarter:risk-register:strict',
    'npm run launch:operator-pack:strict',
    'npm run kickstarter:launch-freeze-pack',
    'npm run kickstarter:launch-freeze-pack:strict',
  ],
  non_claims: [
    'This launch freeze pack is not launch approval.',
    'A ready freeze pack requires explicit human approval from campaign, hardware, GTM, legal/privacy, operations, and founder owners.',
    'Human signoff rows must be updated by the responsible owners and pass the launch signoff audit, not inferred from local demo output.',
    'Demo fixtures, analyzer samples, and local smoke tests do not count as Kickstarter launch evidence.',
    'Missing Kickstarter preview, page review audit, legal/privacy review, supplier quote audit, GTM exports, or proof-shot approvals must keep the freeze status red.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter launch freeze status: ${report.status}`);
console.log(`Freeze gates ready: ${report.summary.ready_gate_count}/${report.summary.gate_count}`);
console.log(`Open P0 risks: ${report.snapshot.open_p0_count}/${report.snapshot.risk_count}; proof shots ready: ${report.snapshot.ready_shot_count}/${report.snapshot.shot_count}`);
console.log(`Launch signoff: ${report.snapshot.launch_signoff_audit_status}; owners ready: ${report.snapshot.launch_signoff_ready_owners}/${report.snapshot.launch_signoff_owners}; launch-day tasks ready: ${report.snapshot.launch_signoff_ready_tasks}/${report.snapshot.launch_signoff_tasks}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'launch_freeze_ready') {
  console.error('Strict Kickstarter launch freeze failed: launch evidence, public copy, P0 risk, proof shots, page preview, legal/privacy, rewards, GTM, launch signoff, rehearsal, or operator gates are not ready.');
  process.exit(1);
}
