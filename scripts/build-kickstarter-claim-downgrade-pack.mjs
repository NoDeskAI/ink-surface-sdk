import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projectRoot = 'docs/project/inkloop-ai-pen-kickstarter';
const matrixPath = `${projectRoot}/campaign/claim-evidence-matrix.md`;
const launchAuditPath = 'test-results/ai-pen-launch-evidence-audit/report.json';
const kpiDashboardPath = 'test-results/ai-pen-launch-kpi-dashboard/dashboard.json';
const outDir = 'test-results/ai-pen-kickstarter-claim-downgrade';
const outJsonPath = `${outDir}/claim-downgrade.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const fallbackClaimGates = {
  'C-HW-1': ['G-HW-1'],
  'C-HW-2': ['G-HW-1'],
  'C-SURF-1': ['G-SURF-1'],
  'C-SURF-2': ['G-SURF-1'],
  'C-LIVE-1': ['G-LIVE-1'],
  'C-EDU-1': ['G-EDU-1'],
  'C-MTG-1': ['G-MTG-1'],
  'C-SUPPLY-1': ['G-SUPPLY-1'],
  'C-GTM-1': ['G-GTM-1'],
};

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function readJsonSource(relativePath) {
  if (!existsSync(absolute(relativePath))) return { available: false, data: null, error: `missing source file: ${relativePath}` };
  try {
    return { available: true, data: JSON.parse(readText(relativePath)), error: null };
  } catch (error) {
    return {
      available: false,
      data: null,
      error: `unreadable source file: ${relativePath}: ${error.message}`,
    };
  }
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseClaimRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes('| Claim ID | Claim | Current Status |'));
  if (headerIndex < 0) throw new Error('claim matrix table header not found');
  const rows = [];

  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) break;
    const [claimId, claim, currentStatus, requiredEvidence, allowedCurrentWording, wordingToAvoid] = splitMarkdownRow(line);
    if (!claimId?.startsWith('C-')) continue;
    rows.push({
      claim_id: claimId,
      claim,
      matrix_status: currentStatus,
      required_evidence: requiredEvidence,
      allowed_current_wording: stripQuotes(allowedCurrentWording),
      wording_to_avoid: stripQuotes(wordingToAvoid),
    });
  }

  return rows;
}

function stripQuotes(value) {
  return value?.replace(/^"|"$/g, '') ?? '';
}

function extractMarkdownLinks(text) {
  const links = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(text))) links.push(match[1]);
  return links;
}

function normalizeEvidencePath(link) {
  if (!link) return null;
  const withoutAnchor = link.split('#')[0];
  const resolved = path.resolve(root, projectRoot, 'campaign', withoutAnchor);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

function gateMaps(launchAudit) {
  const byId = new Map();
  const byFile = new Map();
  for (const gate of launchAudit?.gates ?? []) {
    byId.set(gate.id, gate);
    byFile.set(gate.file, gate);
  }
  return { byId, byFile };
}

function gatesForClaim(claim, maps) {
  const linkedGates = extractMarkdownLinks(claim.required_evidence)
    .map(normalizeEvidencePath)
    .filter(Boolean)
    .map((file) => maps.byFile.get(file))
    .filter(Boolean);
  if (linkedGates.length > 0) return uniqueBy(linkedGates, (gate) => gate.id);
  return (fallbackClaimGates[claim.claim_id] ?? []).map((gateId) => maps.byId.get(gateId)).filter(Boolean);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicDecision(claim, relatedGates) {
  if (relatedGates.length > 0 && relatedGates.every((gate) => gate.status === 'launch_ready_evidence_present')) {
    return 'public_claim_allowed';
  }
  if (/Verified/i.test(claim.matrix_status)) {
    return 'guardrail_copy_allowed';
  }
  if (/Demo-only/i.test(claim.matrix_status)) {
    return 'demo_wording_only';
  }
  if (/Blocked|External|Missing/i.test(claim.matrix_status)) {
    return 'draft_only_until_evidence';
  }
  return 'review_required';
}

function decisionReason(claim, relatedGates) {
  if (relatedGates.length === 0) return `matrix status is ${claim.matrix_status}; no launch evidence gate is linked`;
  const notReady = relatedGates.filter((gate) => gate.status !== 'launch_ready_evidence_present');
  if (notReady.length === 0) return 'all linked launch evidence gates are ready';
  const blockers = notReady.flatMap((gate) => gate.blockers ?? []).slice(0, 3);
  return `${notReady.map((gate) => gate.id).join(', ')} not ready: ${blockers.join('; ') || 'evidence gate not ready'}`;
}

function buildClaims({ claims, launchAudit }) {
  const maps = gateMaps(launchAudit);
  return claims.map((claim) => {
    const relatedGates = gatesForClaim(claim, maps);
    return {
      ...claim,
      public_decision: publicDecision(claim, relatedGates),
      reason: decisionReason(claim, relatedGates),
      launch_gate_ids: relatedGates.map((gate) => gate.id),
      launch_gate_statuses: relatedGates.map((gate) => ({ id: gate.id, status: gate.status })),
      evidence_records: relatedGates.map((gate) => gate.file),
    };
  });
}

function statusFor({ sourceErrors, claims }) {
  if (sourceErrors.length > 0) return 'claim_pack_missing_sources';
  if (claims.every((claim) => claim.public_decision === 'public_claim_allowed' || claim.public_decision === 'guardrail_copy_allowed')) {
    return 'claims_public_copy_ready';
  }
  return 'claims_require_downgrade';
}

function claimRows(claims) {
  if (claims.length === 0) return '| n/a | n/a | n/a | n/a | n/a |';
  return claims
    .map(
      (claim) =>
        `| ${claim.claim_id} | ${claim.claim} | ${claim.public_decision} | ${claim.allowed_current_wording} | ${claim.wording_to_avoid} |`,
    )
    .join('\n');
}

function gateRows(claims) {
  const rows = claims.filter((claim) => claim.launch_gate_ids.length > 0);
  if (rows.length === 0) return '| n/a | n/a | n/a | n/a |';
  return rows
    .map(
      (claim) =>
        `| ${claim.claim_id} | ${claim.launch_gate_ids.join(', ')} | ${claim.launch_gate_statuses.map((gate) => `${gate.id}:${gate.status}`).join(', ')} | ${claim.reason} |`,
    )
    .join('\n');
}

function readme(report) {
  const accessIssues = report.access_issues.length
    ? report.access_issues.map((issue) => `- ${issue}`).join('\n')
    : '- None';
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Claim Downgrade Pack

Schema: \`inkloop.kickstarter_claim_downgrade.v1\`

Status: \`${report.status}\`

This pack converts the claim evidence matrix and current launch evidence audit into public-copy decisions. It is the working downgrade layer before any text is pasted into Kickstarter, a video script, an ad, or a landing page.

## Summary

| Item | Value |
| --- | --- |
| Launch audit status | ${report.launch_status} |
| KPI dashboard status | ${report.kpi_dashboard_status} |
| Claims | ${report.summary.claim_count} |
| Public claim allowed | ${report.summary.public_claim_allowed_count} |
| Guardrail copy allowed | ${report.summary.guardrail_copy_allowed_count} |
| Demo wording only | ${report.summary.demo_wording_only_count} |
| Draft only until evidence | ${report.summary.draft_only_count} |

## Public Copy Decisions

| Claim | Meaning | Decision | Allowed Current Wording | Wording To Avoid |
| --- | --- | --- | --- | --- |
${claimRows(report.claims)}

## Launch Gate Reasons

| Claim | Linked Gates | Gate Statuses | Reason |
| --- | --- | --- | --- |
${gateRows(report.claims)}

## Required Commands

${commands}

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Detailed JSON: [claim-downgrade.json](./claim-downgrade.json)
`;
}

const launchAuditSource = readJsonSource(launchAuditPath);
const kpiDashboardSource = readJsonSource(kpiDashboardPath);
const matrixAvailable = existsSync(absolute(matrixPath));
const sourceErrors = [
  ...(launchAuditSource.available ? [] : [launchAuditSource.error]),
  ...(kpiDashboardSource.available ? [] : [kpiDashboardSource.error]),
  ...(matrixAvailable ? [] : [`missing source file: ${matrixPath}`]),
];
const matrixText = matrixAvailable ? readText(matrixPath) : '';
const claims = matrixAvailable ? buildClaims({ claims: parseClaimRows(matrixText), launchAudit: launchAuditSource.data }) : [];
const publicClaimAllowed = claims.filter((claim) => claim.public_decision === 'public_claim_allowed');
const guardrailCopyAllowed = claims.filter((claim) => claim.public_decision === 'guardrail_copy_allowed');
const demoWordingOnly = claims.filter((claim) => claim.public_decision === 'demo_wording_only');
const draftOnly = claims.filter((claim) => claim.public_decision === 'draft_only_until_evidence');

const report = {
  schema: 'inkloop.kickstarter_claim_downgrade.v1',
  generated_at: new Date().toISOString(),
  status: statusFor({ sourceErrors, claims }),
  sources: {
    claim_evidence_matrix: matrixPath,
    launch_audit: launchAuditPath,
    kpi_dashboard: kpiDashboardPath,
  },
  access_issues: sourceErrors,
  launch_status: launchAuditSource.data?.status ?? 'unknown',
  kpi_dashboard_status: kpiDashboardSource.data?.status ?? 'unknown',
  summary: {
    claim_count: claims.length,
    public_claim_allowed_count: publicClaimAllowed.length,
    guardrail_copy_allowed_count: guardrailCopyAllowed.length,
    demo_wording_only_count: demoWordingOnly.length,
    draft_only_count: draftOnly.length,
  },
  claims,
  required_commands: [
    'npm run launch:evidence:audit',
    'npm run launch:kpi-dashboard',
    'npm run kickstarter:claim-downgrade',
    'npm run verify:kickstarter-claims',
  ],
  non_claims: [
    'This downgrade pack is not publish approval.',
    'Demo-only claims must stay as demo workflow wording until real launch evidence is linked.',
    'Draft-only claims must not move into public Kickstarter copy, ads, or final video narration.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter claim downgrade status: ${report.status}`);
console.log(`Claims: ${report.summary.claim_count}; allowed=${report.summary.public_claim_allowed_count}; guardrail=${report.summary.guardrail_copy_allowed_count}; demo-only=${report.summary.demo_wording_only_count}; draft-only=${report.summary.draft_only_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status === 'claim_pack_missing_sources') {
  console.error('Strict Kickstarter claim downgrade failed: required sources are missing or unreadable.');
  process.exit(1);
}
