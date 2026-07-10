import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-prelaunch-page';
const outJsonPath = `${outDir}/prelaunch-page.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const sourcePaths = {
  prelaunchPagePack: 'docs/project/inkloop-ai-pen-kickstarter/campaign/prelaunch-page-pack.md',
  publicCopyLock: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
  claimDowngrade: 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json',
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  prelaunchPageIntakeAudit: 'test-results/ai-pen-kickstarter-prelaunch-page-intake-audit/report.json',
  gtmMetricsTracker: 'docs/project/inkloop-ai-pen-kickstarter/evidence/gtm-metrics-tracker.md',
  kickstarterPageChecklist: 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md',
  sourceGtmPlan: 'docs/project/inkloop-ai-pen-kickstarter/source/06_Kickstarter_GTM与众筹页面方案.md',
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

function readOptionalJsonSource(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { path: relativePath, available: false, optional: true, error: `optional source not yet generated: ${relativePath}`, data: null };
  }
  try {
    return { path: relativePath, available: true, optional: true, error: null, data: JSON.parse(readFileSync(absolute(relativePath), 'utf8')) };
  } catch (error) {
    return { path: relativePath, available: false, optional: true, error: `unreadable optional source file: ${relativePath}: ${error.message}`, data: null };
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
    .filter((source) => !source.available && !source.optional)
    .map((source) => source.error);
}

function parseLineValue(markdown, label) {
  const prefix = `${label}:`;
  const line = markdown.split(/\r?\n/).find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : 'missing';
}

function parseFieldTable(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return {};
  const fields = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (Object.keys(fields).length > 0) break;
      continue;
    }
    if (/^\|\s*-+/.test(trimmed)) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2 || cells[0] === 'Field') continue;
    fields[cells[0]] = {
      value: cells[1],
      approval_state: cells[2] ?? '',
    };
  }
  return fields;
}

function parseTrackerSummary(markdown) {
  const fields = {};
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || /^\|\s*-+/.test(trimmed)) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2 || cells[0] === 'Field') continue;
    fields[cells[0]] = cells[1];
    if (cells[0] === 'Decision') break;
  }
  return fields;
}

function isMissing(value) {
  return !value || /\bTBD\b|\[PRELAUNCH_URL\]|\[LAUNCH_URL\]|Missing|Not ready|unknown/i.test(value);
}

function fieldRows(fields) {
  return Object.entries(fields)
    .map(([field, item]) => `| ${field} | ${item.value} | ${item.approval_state} | ${isMissing(`${item.value} ${item.approval_state}`) ? 'not_ready' : 'drafted'} |`)
    .join('\n');
}

function blockerRows(fields) {
  const blockers = Object.entries(fields).filter(([, item]) => isMissing(`${item.value} ${item.approval_state}`));
  if (!blockers.length) return '| n/a | n/a |';
  return blockers.map(([field, item]) => `| ${field} | value: ${item.value}; approval: ${item.approval_state} |`).join('\n');
}

const prelaunchRequiredInputCatalog = {
  'Kickstarter preview link': {
    id: 'preview_url',
    owner: 'Campaign',
    required_input: 'Paste the Kickstarter creator preview URL and capture the matching preview screenshot or preview-page artifact.',
    evidence_target: 'test-results/ai-pen-kickstarter-prelaunch-page-intake/<run>/raw/page-fields.csv and screenshots/kickstarter-preview.png',
    unlocks: ['prelaunch_intake_ready', 'prelaunch_page_ready', 'G-PAGE-1'],
    next_command: 'npm run kickstarter:prelaunch-page-intake-audit',
  },
  'Pre-launch URL': {
    id: 'live_prelaunch_url',
    owner: 'Campaign',
    required_input: 'Paste the public Kickstarter pre-launch URL after the page is created and confirm it opens to the Notify me CTA.',
    evidence_target: 'test-results/ai-pen-kickstarter-prelaunch-page-intake/<run>/raw/page-fields.csv and screenshots/prelaunch-page.png',
    unlocks: ['prelaunch_intake_ready', 'prelaunch_page_ready', 'G-GTM-1'],
    next_command: 'npm run kickstarter:prelaunch-page-intake-audit',
  },
  Owner: {
    id: 'page_owner',
    owner: 'Campaign',
    required_input: 'Name the accountable page owner who will resolve page edits, traffic timing, and final publish decisions.',
    evidence_target: 'test-results/ai-pen-kickstarter-prelaunch-page-intake/<run>/raw/owner-review.csv',
    unlocks: ['owner_review_ready', 'launch_signoff_ready'],
    next_command: 'npm run kickstarter:prelaunch-page-intake-audit',
  },
  'Final reviewer': {
    id: 'final_reviewer',
    owner: 'Founder / Campaign',
    required_input: 'Record the final reviewer decision for page scope, claims, CTA, non-claims, and launch traffic timing.',
    evidence_target: 'test-results/ai-pen-kickstarter-prelaunch-page-intake/<run>/reviews/founder-review.md',
    unlocks: ['founder_review_ready', 'launch_freeze_ready'],
    next_command: 'npm run kickstarter:prelaunch-page-intake-audit',
  },
};

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function requiredInputRows(inputs) {
  if (!inputs.length) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .map((item) => `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | ${item.unlocks.join(', ')} | \`${item.next_command}\` |`)
    .join('\n');
}

function requiredInputForField(field, item) {
  const catalog = prelaunchRequiredInputCatalog[field] ?? {
    id: `page_field_${slug(field)}`,
    owner: 'Campaign',
    required_input: `Replace the placeholder value for ${field} and mark the review state ready.`,
    evidence_target: 'test-results/ai-pen-kickstarter-prelaunch-page-intake/<run>/raw/page-fields.csv',
    unlocks: ['prelaunch_page_ready'],
    next_command: 'npm run kickstarter:prelaunch-page-intake-audit',
  };
  return {
    ...catalog,
    type: 'prelaunch_page_field',
    field,
    current_value: item.value,
    approval_state: item.approval_state,
    priority: 'P0',
  };
}

function isGtmReady(gtmSummary) {
  return /^ready\b/i.test(gtmSummary.Decision ?? '') && !/not ready|conditional|TBD/i.test(gtmSummary.Decision ?? '');
}

function buildNextRequiredInputs({ fields, publicCopyLock, claimDowngrade, launchAudit, prelaunchPageIntakeAudit, gtmSummary }) {
  const inputs = Object.entries(fields)
    .filter(([, item]) => isMissing(`${item.value} ${item.approval_state}`))
    .map(([field, item]) => requiredInputForField(field, item));

  if (prelaunchPageIntakeAudit?.status !== 'prelaunch_intake_ready') {
    inputs.push({
      id: 'prelaunch_intake_evidence',
      type: 'intake_gate',
      owner: 'Campaign / GTM',
      required_input: 'Fill the latest pre-launch intake with real preview/live URLs, screenshots, Notify me tracking export, owner review, and founder review.',
      evidence_target: 'test-results/ai-pen-kickstarter-prelaunch-page-intake/<run>/',
      unlocks: ['prelaunch_intake_ready', 'prelaunch_page_ready'],
      next_command: 'npm run kickstarter:prelaunch-page-intake-audit',
      priority: 'P0',
    });
  }
  if (publicCopyLock?.status !== 'public_copy_lock_ready') {
    inputs.push({
      id: 'public_copy_lock',
      type: 'copy_gate',
      owner: 'Campaign / Legal',
      required_input: 'Resolve blocked or draft-only public claims before using this page copy for traffic.',
      evidence_target: 'test-results/ai-pen-kickstarter-public-copy-lock/copy-lock.json',
      unlocks: ['public_copy_lock_ready', 'prelaunch_page_ready'],
      next_command: 'npm run kickstarter:public-copy-lock',
      priority: 'P0',
    });
  }
  if (claimDowngrade?.status !== 'claims_public_copy_ready') {
    inputs.push({
      id: 'claim_downgrade',
      type: 'copy_gate',
      owner: 'Campaign / Product',
      required_input: 'Downgrade unsupported claims to demo/prototype-safe language or keep them internal only.',
      evidence_target: 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json',
      unlocks: ['claims_public_copy_ready', 'public_copy_lock_ready'],
      next_command: 'npm run kickstarter:claim-downgrade',
      priority: 'P0',
    });
  }
  if (launchAudit?.status !== 'launch_ready_evidence_present') {
    inputs.push({
      id: 'launch_evidence_records',
      type: 'launch_gate',
      owner: 'Hardware / Product / GTM',
      required_input: 'Attach real prototype, Capture Surface, demo, supplier, GTM, page/legal, and proof-shot evidence records before treating the page as launch-backed.',
      evidence_target: 'docs/project/inkloop-ai-pen-kickstarter/evidence/README.md',
      unlocks: ['launch_ready_evidence_present', 'launch_freeze_ready'],
      next_command: 'npm run launch:evidence:audit',
      priority: 'P0',
    });
  }
  if (!isGtmReady(gtmSummary)) {
    inputs.push({
      id: 'gtm_proof',
      type: 'demand_gate',
      owner: 'GTM',
      required_input: 'Update the GTM tracker with real Kickstarter follower, email list, source, and weekly review evidence before sending traffic.',
      evidence_target: 'docs/project/inkloop-ai-pen-kickstarter/evidence/gtm-metrics-tracker.md',
      unlocks: ['launch_demand_ready', 'prelaunch_page_ready'],
      next_command: 'npm run launch:kpi-dashboard',
      priority: 'P0',
    });
  }

  return inputs;
}

function sourceRows(sources) {
  return Object.entries(sources)
    .map(([key, source]) => `| ${key} | ${source.available ? 'available' : 'missing'} | ${mdLink(source.path)} | ${source.error ?? 'none'} |`)
    .join('\n');
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, targetPath)})`;
}

function statusFor({ accessIssues, prelaunchStatus, fields, publicCopyLock, claimDowngrade, launchAudit, prelaunchPageIntakeAudit, gtmSummary }) {
  if (accessIssues.length > 0) return 'prelaunch_page_missing_sources';
  const fieldsReady = Object.values(fields).every((item) => !isMissing(`${item.value} ${item.approval_state}`));
  const packApproved = /^approved|^ready/i.test(prelaunchStatus) && !/not approved|draft/i.test(prelaunchStatus);
  const publicCopyReady = publicCopyLock?.status === 'public_copy_lock_ready';
  const claimsReady = claimDowngrade?.status === 'claims_public_copy_ready';
  const launchEvidenceReady = launchAudit?.status === 'launch_ready_evidence_present';
  const prelaunchIntakeReady = prelaunchPageIntakeAudit?.status === 'prelaunch_intake_ready';
  const gtmReady = isGtmReady(gtmSummary);
  if (fieldsReady && packApproved && publicCopyReady && claimsReady && launchEvidenceReady && prelaunchIntakeReady && gtmReady) return 'prelaunch_page_ready';
  return 'prelaunch_page_not_ready';
}

function readme(report) {
  const accessIssues = report.access_issues.length ? report.access_issues.map((issue) => `- ${issue}`).join('\n') : '- None';
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');

  return `# InkLoop AI Pen Kickstarter Pre-Launch Page Pack

Schema: \`inkloop.kickstarter_prelaunch_page_pack.v1\`

Status: \`${report.status}\`

This package checks the Kickstarter pre-launch page and Notify me funnel before the October 2026 launch window. It is not publish approval.

## Snapshot

| Item | Value |
| --- | --- |
| Pre-launch pack status | ${report.snapshot.prelaunch_pack_status} |
| Public copy lock status | ${report.snapshot.public_copy_lock_status} |
| Claim downgrade status | ${report.snapshot.claim_downgrade_status} |
| Launch audit status | ${report.snapshot.launch_audit_status} |
| Pre-launch intake audit status | ${report.snapshot.prelaunch_intake_status} |
| Pre-launch intake ready fields | ${report.snapshot.prelaunch_intake_ready_fields}/${report.snapshot.prelaunch_intake_field_count} |
| Pre-launch intake ready owner reviews | ${report.snapshot.prelaunch_intake_ready_reviews}/${report.snapshot.prelaunch_intake_review_count} |
| Notify me tracking ready rows | ${report.snapshot.prelaunch_intake_ready_tracking_rows}/${report.snapshot.prelaunch_intake_tracking_rows} |
| GTM decision | ${report.snapshot.gtm_decision} |
| Kickstarter preview link | ${report.snapshot.kickstarter_preview_link} |
| Pre-launch URL | ${report.snapshot.prelaunch_url} |
| Target publish window | ${report.snapshot.target_publish_window} |
| Field count | ${report.summary.field_count} |
| Missing field count | ${report.summary.missing_field_count} |

## Pre-Launch Page Fields

| Field | Draft Value | Approval State | Status |
| --- | --- | --- | --- |
${fieldRows(report.prelaunch_fields)}

## Current Blockers

| Field | Blocker |
| --- | --- |
${blockerRows(report.prelaunch_fields)}

## Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Unlocks | Next Command |
| --- | --- | --- | --- | --- | --- |
${requiredInputRows(report.next_required_inputs)}

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

Detailed JSON: [prelaunch-page.json](./prelaunch-page.json)
`;
}

const sources = {
  prelaunchPagePack: readTextSource(sourcePaths.prelaunchPagePack),
  publicCopyLock: readJsonSource(sourcePaths.publicCopyLock),
  claimDowngrade: readJsonSource(sourcePaths.claimDowngrade),
  launchAudit: readJsonSource(sourcePaths.launchAudit),
  prelaunchPageIntakeAudit: readOptionalJsonSource(sourcePaths.prelaunchPageIntakeAudit),
  gtmMetricsTracker: readTextSource(sourcePaths.gtmMetricsTracker),
  kickstarterPageChecklist: readTextSource(sourcePaths.kickstarterPageChecklist),
  sourceGtmPlan: readTextSource(sourcePaths.sourceGtmPlan),
};

const accessIssues = sourceIssues(sources);
const prelaunchFields = parseFieldTable(sources.prelaunchPagePack.text, '## Pre-Launch Page Fields');
const gtmSummary = parseTrackerSummary(sources.gtmMetricsTracker.text);
const prelaunchStatus = parseLineValue(sources.prelaunchPagePack.text, 'Status');
const nextRequiredInputs = buildNextRequiredInputs({
  fields: prelaunchFields,
  publicCopyLock: sources.publicCopyLock.data,
  claimDowngrade: sources.claimDowngrade.data,
  launchAudit: sources.launchAudit.data,
  prelaunchPageIntakeAudit: sources.prelaunchPageIntakeAudit.data,
  gtmSummary,
});
const report = {
  schema: 'inkloop.kickstarter_prelaunch_page_pack.v1',
  generated_at: new Date().toISOString(),
  strict,
  status: statusFor({
    accessIssues,
    prelaunchStatus,
    fields: prelaunchFields,
    publicCopyLock: sources.publicCopyLock.data,
    claimDowngrade: sources.claimDowngrade.data,
    launchAudit: sources.launchAudit.data,
    prelaunchPageIntakeAudit: sources.prelaunchPageIntakeAudit.data,
    gtmSummary,
  }),
  sources: sourceMap(sources),
  access_issues: accessIssues,
  snapshot: {
    prelaunch_pack_status: prelaunchStatus,
    public_copy_lock_status: sources.publicCopyLock.data?.status ?? 'unknown',
    claim_downgrade_status: sources.claimDowngrade.data?.status ?? 'unknown',
    launch_audit_status: sources.launchAudit.data?.status ?? 'unknown',
    prelaunch_intake_status: sources.prelaunchPageIntakeAudit.data?.status ?? 'missing',
    prelaunch_intake_field_count: sources.prelaunchPageIntakeAudit.data?.summary?.page_field_count ?? 0,
    prelaunch_intake_ready_fields: sources.prelaunchPageIntakeAudit.data?.summary?.ready_page_field_count ?? 0,
    prelaunch_intake_review_count: sources.prelaunchPageIntakeAudit.data?.summary?.owner_review_count ?? 0,
    prelaunch_intake_ready_reviews: sources.prelaunchPageIntakeAudit.data?.summary?.ready_owner_review_count ?? 0,
    prelaunch_intake_tracking_rows: sources.prelaunchPageIntakeAudit.data?.summary?.tracking_row_count ?? 0,
    prelaunch_intake_ready_tracking_rows: sources.prelaunchPageIntakeAudit.data?.summary?.ready_tracking_row_count ?? 0,
    gtm_decision: gtmSummary.Decision ?? 'missing',
    kickstarter_preview_link: prelaunchFields['Kickstarter preview link']?.value ?? 'missing',
    prelaunch_url: prelaunchFields['Pre-launch URL']?.value ?? 'missing',
    target_publish_window: prelaunchFields['Target publish window']?.value ?? 'missing',
  },
  summary: {
    field_count: Object.keys(prelaunchFields).length,
    missing_field_count: Object.values(prelaunchFields).filter((item) => isMissing(`${item.value} ${item.approval_state}`)).length,
    next_required_input_count: nextRequiredInputs.length,
    page_required_input_count: nextRequiredInputs.filter((item) => item.type === 'prelaunch_page_field').length,
    gate_required_input_count: nextRequiredInputs.filter((item) => item.type !== 'prelaunch_page_field').length,
  },
  prelaunch_fields: prelaunchFields,
  next_required_inputs: nextRequiredInputs,
  required_commands: [
    'npm run kickstarter:prelaunch-page-intake',
    'npm run kickstarter:prelaunch-page-intake-audit',
    'npm run kickstarter:claim-downgrade',
    'npm run kickstarter:public-copy-lock',
    'npm run launch:kpi-dashboard',
    'npm run kickstarter:prelaunch-page-pack',
    'npm run kickstarter:prelaunch-page-pack:strict',
  ],
  non_claims: [
    'This pre-launch page pack is not publish approval.',
    'A drafted pre-launch page does not prove launch demand.',
    'Notify me followers must be backed by real Kickstarter dashboard exports and GTM tracker updates.',
    'Do not drive traffic until public copy, page preview, owner review, and GTM tracking are ready.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter pre-launch page pack status: ${report.status}`);
console.log(`Fields ready: ${report.summary.field_count - report.summary.missing_field_count}/${report.summary.field_count}`);
console.log(`Next required inputs: ${report.summary.next_required_input_count}`);
console.log(`Public copy lock: ${report.snapshot.public_copy_lock_status}`);
console.log(`GTM decision: ${report.snapshot.gtm_decision}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'prelaunch_page_ready') {
  console.error('Strict Kickstarter pre-launch page pack failed: page fields, public copy, claim downgrade, launch evidence, GTM decision, or owner approval are not ready.');
  process.exit(1);
}
