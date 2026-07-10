import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = 'test-results/ai-pen-kickstarter-public-copy-lock';
const outJsonPath = `${outDir}/copy-lock.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const sourcePaths = {
  claimDowngrade: 'test-results/ai-pen-kickstarter-claim-downgrade/claim-downgrade.json',
  launchAudit: 'test-results/ai-pen-launch-evidence-audit/report.json',
  proofShotAudit: 'test-results/ai-pen-kickstarter-proof-shot-audit/report.json',
  pageDraft: 'docs/project/inkloop-ai-pen-kickstarter/campaign/kickstarter-page-draft.md',
  videoScript: 'docs/project/inkloop-ai-pen-kickstarter/campaign/campaign-video-script.md',
  rewardsFaq: 'docs/project/inkloop-ai-pen-kickstarter/campaign/rewards-faq-draft.md',
  claimMatrix: 'docs/project/inkloop-ai-pen-kickstarter/campaign/claim-evidence-matrix.md',
  prelaunchPagePack: 'docs/project/inkloop-ai-pen-kickstarter/campaign/prelaunch-page-pack.md',
  launchDayCommsPack: 'docs/project/inkloop-ai-pen-kickstarter/campaign/launch-day-comms-pack.md',
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
    return { path: relativePath, available: false, error: `missing source file: ${relativePath}`, data: null };
  }
  return { path: relativePath, available: true, error: null, data: readFileSync(absolute(relativePath), 'utf8') };
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

function statusFor({ sources, claimDowngrade, launchAudit, proofShotAudit }) {
  if (sourceIssues(sources).length > 0) return 'public_copy_lock_missing_sources';
  const claimsReady = claimDowngrade?.status === 'claims_public_copy_ready';
  const launchReady = launchAudit?.status === 'launch_ready_evidence_present';
  const proofReady = proofShotAudit?.status === 'final_cut_ready';
  if (claimsReady && launchReady && proofReady) return 'public_copy_lock_ready';
  return 'public_copy_lock_not_ready';
}

function groupClaims(claims) {
  return {
    public_claim_allowed: claims.filter((claim) => claim.public_decision === 'public_claim_allowed'),
    guardrail_copy_allowed: claims.filter((claim) => claim.public_decision === 'guardrail_copy_allowed'),
    demo_wording_only: claims.filter((claim) => claim.public_decision === 'demo_wording_only'),
    draft_only_until_evidence: claims.filter((claim) => claim.public_decision === 'draft_only_until_evidence'),
    review_required: claims.filter((claim) => claim.public_decision === 'review_required'),
  };
}

function copyRows(claims) {
  if (!claims.length) return '| n/a | n/a | n/a | n/a | n/a |';
  return claims
    .map(
      (claim) =>
        `| ${claim.claim_id} | ${claim.public_decision} | ${claim.allowed_current_wording} | ${claim.wording_to_avoid} | ${claim.reason} |`,
    )
    .join('\n');
}

function shotRows(shots) {
  if (!shots.length) return '| n/a | n/a | n/a | n/a |';
  return shots
    .map((shot) => `| ${shot.id} | ${shot.gate} | ${shot.status} | ${(shot.blockers ?? []).join('; ') || 'none'} |`)
    .join('\n');
}

function blockedRows(claims) {
  const blocked = claims.filter((claim) => claim.public_decision === 'draft_only_until_evidence' || claim.public_decision === 'review_required');
  if (!blocked.length) return '| n/a | n/a | n/a | n/a |';
  return blocked
    .map((claim) => `| ${claim.claim_id} | ${claim.claim} | ${claim.public_decision} | ${claim.reason} |`)
    .join('\n');
}

function mdLink(targetPath, label = targetPath) {
  if (!targetPath) return 'n/a';
  return `[${label}](${path.relative(outDir, targetPath)})`;
}

function readme(report) {
  const accessIssues = report.access_issues.length ? report.access_issues.map((issue) => `- ${issue}`).join('\n') : '- None';
  const commands = report.required_commands.map((command) => `- \`${command}\``).join('\n');
  const nonClaims = report.non_claims.map((claim) => `- ${claim}`).join('\n');

  return `# InkLoop AI Pen Kickstarter Public Copy Lock

Schema: \`inkloop.kickstarter_public_copy_lock.v1\`

Status: \`${report.status}\`

This is the pre-publish copy lock for Kickstarter page, video narration, ads, landing pages, launch emails, social posts, and comment replies. It is not publish approval.

## Snapshot

| Item | Value |
| --- | --- |
| Launch audit status | ${report.snapshot.launch_audit_status} |
| Claim downgrade status | ${report.snapshot.claim_downgrade_status} |
| Proof-shot audit status | ${report.snapshot.proof_shot_audit_status} |
| Claims | ${report.summary.claim_count} |
| Public claim allowed | ${report.summary.public_claim_allowed_count} |
| Guardrail copy allowed | ${report.summary.guardrail_copy_allowed_count} |
| Demo wording only | ${report.summary.demo_wording_only_count} |
| Draft only until evidence | ${report.summary.draft_only_count} |
| Final-cut proof shots | ${report.summary.ready_shot_count}/${report.summary.shot_count} |

## Copy Decisions

| Claim | Decision | Allowed Current Wording | Wording To Avoid | Reason |
| --- | --- | --- | --- | --- |
${copyRows(report.claims)}

## Blocked Public Claims

| Claim | Meaning | Decision | Reason |
| --- | --- | --- | --- |
${blockedRows(report.claims)}

## Proof-Shot Lock

| Shot | Gate | Status | Blockers |
| --- | --- | --- | --- |
${shotRows(report.proof_shots)}

## Required Commands

${commands}

## Campaign Draft Sources

| Draft | Path |
| --- | --- |
| Kickstarter page | ${mdLink(sourcePaths.pageDraft)} |
| Campaign video script | ${mdLink(sourcePaths.videoScript)} |
| Rewards and FAQ | ${mdLink(sourcePaths.rewardsFaq)} |
| Claim matrix | ${mdLink(sourcePaths.claimMatrix)} |
| Pre-launch page pack | ${mdLink(sourcePaths.prelaunchPagePack)} |
| Launch-day comms pack | ${mdLink(sourcePaths.launchDayCommsPack)} |

## Non-Claims

${nonClaims}

## Access Issues

${accessIssues}

Detailed JSON: [copy-lock.json](./copy-lock.json)
`;
}

const sources = {
  claimDowngrade: readJsonSource(sourcePaths.claimDowngrade),
  launchAudit: readJsonSource(sourcePaths.launchAudit),
  proofShotAudit: readJsonSource(sourcePaths.proofShotAudit),
  pageDraft: readTextSource(sourcePaths.pageDraft),
  videoScript: readTextSource(sourcePaths.videoScript),
  rewardsFaq: readTextSource(sourcePaths.rewardsFaq),
  claimMatrix: readTextSource(sourcePaths.claimMatrix),
  prelaunchPagePack: readTextSource(sourcePaths.prelaunchPagePack),
  launchDayCommsPack: readTextSource(sourcePaths.launchDayCommsPack),
};

const claims = sources.claimDowngrade.data?.claims ?? [];
const grouped = groupClaims(claims);
const proofShots = sources.proofShotAudit.data?.shots ?? [];
const report = {
  schema: 'inkloop.kickstarter_public_copy_lock.v1',
  generated_at: new Date().toISOString(),
  strict,
  status: statusFor({
    sources,
    claimDowngrade: sources.claimDowngrade.data,
    launchAudit: sources.launchAudit.data,
    proofShotAudit: sources.proofShotAudit.data,
  }),
  sources: sourceMap(sources),
  access_issues: sourceIssues(sources),
  snapshot: {
    launch_audit_status: sources.launchAudit.data?.status ?? 'unknown',
    claim_downgrade_status: sources.claimDowngrade.data?.status ?? 'unknown',
    proof_shot_audit_status: sources.proofShotAudit.data?.status ?? 'unknown',
  },
  summary: {
    claim_count: claims.length,
    public_claim_allowed_count: grouped.public_claim_allowed.length,
    guardrail_copy_allowed_count: grouped.guardrail_copy_allowed.length,
    demo_wording_only_count: grouped.demo_wording_only.length,
    draft_only_count: grouped.draft_only_until_evidence.length,
    review_required_count: grouped.review_required.length,
    shot_count: proofShots.length,
    ready_shot_count: proofShots.filter((shot) => shot.status === 'final_cut_ready').length,
  },
  claims,
  proof_shots: proofShots.map((shot) => ({
    id: shot.id,
    gate: shot.gate,
    check: shot.check,
    status: shot.status,
    blockers: shot.blockers ?? [],
    shot_log_path: shot.shot_log_path,
    claim_review_path: shot.claim_review_path,
  })),
  required_commands: [
    'npm run kickstarter:claim-downgrade',
    'npm run kickstarter:proof-shot-audit',
    'npm run launch:evidence:audit',
    'npm run kickstarter:public-copy-lock',
    'npm run kickstarter:ops-refresh',
  ],
  non_claims: [
    'This public copy lock is not publish approval.',
    'Demo wording cannot be upgraded into public performance claims without real launch evidence gates.',
    'Draft-only claims must stay out of Kickstarter page, video narration, ads, landing pages, launch emails, social posts, and comment replies.',
    'The pre-launch page pack still requires Kickstarter preview URL, owner review, GTM tracking, and public-copy lock before traffic is sent.',
    'Final public copy still requires human page review, legal/privacy review, and Kickstarter preview review.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter public copy lock status: ${report.status}`);
console.log(`Claims public/draft: ${report.summary.public_claim_allowed_count}/${report.summary.draft_only_count}`);
console.log(`Proof shots ready: ${report.summary.ready_shot_count}/${report.summary.shot_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'public_copy_lock_ready') {
  console.error('Strict public copy lock failed: claims, launch evidence, or proof shots are not publish-ready.');
  process.exit(1);
}
