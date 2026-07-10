import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const projectRoot = 'docs/project/inkloop-ai-pen-kickstarter';
const campaignRoot = `${projectRoot}/campaign`;
const failures = [];
const checked = [];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function note(message) {
  checked.push(message);
}

function fail(message) {
  failures.push(message);
}

function mustExist(relativePath, label = relativePath) {
  if (!existsSync(absolute(relativePath))) {
    fail(`missing ${label}: ${relativePath}`);
    return false;
  }
  return true;
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function requireIncludes(relativePath, needles) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${relativePath} does not include required campaign guardrail text: ${needle}`);
  }
  note(`${relativePath}: required campaign guardrails present`);
}

function requireNotIncludes(relativePath, needles) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  for (const needle of needles) {
    if (text.includes(needle)) fail(`${relativePath} includes stale campaign placeholder or claim text: ${needle}`);
  }
  note(`${relativePath}: stale campaign placeholders absent`);
}

const claimIds = [
  'C-HW-1',
  'C-HW-2',
  'C-SURF-1',
  'C-SURF-2',
  'C-LIVE-1',
  'C-EDU-1',
  'C-MTG-1',
  'C-AI-1',
  'C-OBS-1',
  'C-EPAPER-1',
  'C-SUPPLY-1',
  'C-GTM-1',
];

const campaignFiles = [
  `${campaignRoot}/kickstarter-page-draft.md`,
  `${campaignRoot}/rewards-faq-draft.md`,
  `${campaignRoot}/campaign-video-script.md`,
  `${campaignRoot}/claim-evidence-matrix.md`,
  `${campaignRoot}/prelaunch-page-pack.md`,
  `${campaignRoot}/launch-day-comms-pack.md`,
];

const publicClaimFiles = [
  `${campaignRoot}/kickstarter-page-draft.md`,
  `${campaignRoot}/rewards-faq-draft.md`,
  `${campaignRoot}/campaign-video-script.md`,
  `${campaignRoot}/prelaunch-page-pack.md`,
  `${campaignRoot}/launch-day-comms-pack.md`,
];

const dangerousClaims = [
  { label: 'any whiteboard without setup', pattern: /works?\s+on\s+any\s+(ordinary\s+)?whiteboard\s+without\s+setup/i },
  { label: 'perfect capture', pattern: /perfect\s+capture/i },
  { label: 'perfect AI or lesson generation', pattern: /perfect\s+(ai|lesson|formula|diagram|transcription|generation)/i },
  { label: 'meeting summaries as public output wording', pattern: /\bmeeting\s+summar(y|ies)\b/i },
  { label: 'automatic meeting minutes from audio or transcript', pattern: /automatic\s+meeting\s+(minutes|summary|summaries).*(audio|transcript|subtitles?)/i },
  { label: 'zero or instant latency', pattern: /\b(zero|instant)\s+latency\b/i },
  { label: 'fully autonomous meeting assistant', pattern: /fully\s+autonomous\s+meeting\s+assistant/i },
  { label: 'AI always correct', pattern: /AI\s+is\s+always\s+correct/i },
  { label: 'Obsidian as capture truth source', pattern: /Obsidian\s+is\s+the\s+capture\s+truth\s+source/i },
  { label: 'e-paper tablet included in base kit', pattern: /e-?paper\s+tablet\s+included\s+in\s+base\s+kit/i },
  { label: 'multi-pen included in base product', pattern: /multi-pen\s+is\s+included\s+in\s+the\s+base\s+product/i },
  { label: 'final price or delivery guaranteed', pattern: /(final\s+price|delivery)\s+(and\s+delivery\s+)?(is\s+|are\s+)?guaranteed/i },
  { label: 'audience demand already proven', pattern: /audience\s+demand\s+is\s+already\s+proven/i },
  { label: 'real prototype capture validated', pattern: /real\s+prototype\s+capture\s+is\s+validated/i },
  { label: 'A2/A3 accuracy proven', pattern: /A2\/A3\s+accuracy\s+is\s+proven/i },
];

const allowedContextPatterns = [
  /^#+\s*FAQ/i,
  /Do not claim/i,
  /Lines To Avoid/i,
  /Wording To Avoid/i,
  /Avoid saying/i,
  /Evidence required/i,
  /Required proof/i,
  /Required Before/i,
  /Required Evidence/i,
  /Evidence Status/i,
  /Final Cut Checklist/i,
  /Publish phrase after real evidence/i,
  /Draft-only phrase until evidence exists/i,
  /Claim Evidence Matrix/i,
  /What To Avoid/i,
  /Do not use/i,
];

function isAllowedGuardrailContext(activeHeadings, line, recentContext) {
  if (/^\s*\|\s*.*Wording To Avoid/i.test(line)) return true;
  if (
    activeHeadings.some((heading) => /^FAQ$/i.test(heading)) &&
    /^#{1,6}\s+Does it generate automatic meeting minutes from audio\?\s*$/i.test(line)
  ) return true;
  if (/\b(Avoid|Do not claim|not claim|requires evidence|required before|proof required)\b/i.test(line)) return true;
  if (recentContext.some((contextLine) => /\b(Avoid saying|Do not claim|Lines To Avoid|Wording To Avoid)\b/i.test(contextLine))) return true;
  return activeHeadings.some((heading) => allowedContextPatterns.some((pattern) => pattern.test(heading)));
}

function scanDangerousPublicClaims(relativePath) {
  if (!mustExist(relativePath)) return;
  const lines = readText(relativePath).split(/\r?\n/);
  const activeHeadings = [];
  const recentContext = [];
  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const depth = heading[1].length;
      activeHeadings.length = depth - 1;
      activeHeadings[depth - 1] = heading[2];
      recentContext.length = 0;
    }
    for (const claim of dangerousClaims) {
      if (!claim.pattern.test(line)) continue;
      if (isAllowedGuardrailContext(activeHeadings, line, recentContext)) continue;
      fail(`${relativePath}:${index + 1} contains unsupported public claim (${claim.label}): ${line.trim()}`);
    }
    if (line.trim()) {
      recentContext.push(line.trim());
      if (recentContext.length > 4) recentContext.shift();
    }
  });
  note(`${relativePath}: unsupported public claim scan passed`);
}

function verifyCampaignStructure() {
  for (const file of campaignFiles) mustExist(file);
  requireIncludes(`${campaignRoot}/README.md`, [
    'not publish-ready until the evidence gates',
    'claim-evidence-matrix.md',
    'prelaunch-page-pack.md',
    'launch-day-comms-pack.md',
    'If a gate has only sample/demo evidence, use demo wording',
  ]);
  requireIncludes(`${campaignRoot}/kickstarter-page-draft.md`, [
    'Status: First formal draft, evidence-bound, not publish-ready',
    'Public hardware wording must wait for real prototype video',
    'Single AI Pen capture is the core Kickstarter promise.',
    'Capture Surface is required for accurate spatial capture.',
    'E-paper reading and review remain part of the InkLoop Paper roadmap, not the October 2026 base reward.',
    'Multi-pen, multi-color, and deep third-party integrations are later-stage workflows.',
    'Do not claim yet:',
    'Pricing cannot be finalized until BOM',
    'AI outputs are editable, dismissible, and traceable.',
    'For meetings, board/ink events are the required evidence path.',
    'should not be presented as automatic meeting minutes.',
    'All claims checked against [claim-evidence-matrix.md](./claim-evidence-matrix.md)',
  ]);
  requireNotIncludes(`${campaignRoot}/kickstarter-page-draft.md`, [
    'meeting summaries',
  ]);
  requireIncludes(`${campaignRoot}/rewards-faq-draft.md`, [
    'Pricing is intentionally marked TBD',
    'Only `supplier_backed_for_public_page` should be used to approve public pricing.',
    'Avoid saying: Works on any whiteboard without setup.',
    'Single-pen capture is the core Kickstarter commitment.',
    'No. InkLoop Paper and e-paper review are second-loop runtime reuse and roadmap work.',
    'AI-generated outputs may be incomplete or wrong.',
    'Does it generate automatic meeting minutes from audio?',
    'V1 meeting outputs are board-event-first.',
    'Audio, subtitles, speaker, agenda, and timeline data may be optional context',
  ]);
  requireNotIncludes(`${campaignRoot}/rewards-faq-draft.md`, [
    'meeting summaries',
  ]);
  requireIncludes(`${campaignRoot}/campaign-video-script.md`, [
    'Status: First formal draft, proof-shot dependent',
    '## Required Proof Shots',
    '## Lines To Avoid',
    'Shows Capture Surface requirement clearly',
    'Waiting for real proof shot and calibration evidence',
    'Waiting for real prototype take and raw run log',
    'Waiting for real-time take and latency report',
    'Waiting for reviewed education and meeting takes',
    'Waiting for page checklist and legal/privacy review',
    'Guardrail active; final transcript still requires review',
    'Final cut must pass `npm run verify:kickstarter-claims`',
    'Shows user review step for AI output',
    'Avoids unsupported claims',
  ]);
  requireNotIncludes(`${campaignRoot}/campaign-video-script.md`, [
    '| Shows Capture Surface requirement clearly | TBD |',
    '| Shows real pen writing, not only UI mock | TBD |',
    '| Shows Live Board timing without speed-up deception | TBD |',
    '| Shows user review step for AI output | TBD |',
    '| Mentions risks/limits in page or video | TBD |',
    '| Avoids unsupported claims | TBD |',
  ]);
  requireIncludes(`${campaignRoot}/launch-day-comms-pack.md`, [
    'Status: First launch-day comms draft, not approved for send',
    'This comms pack is not launch approval.',
    'Do not send any item until the launch freeze pack',
    '## T-24h Seed User Launch Email',
    '## Comment FAQ Macros',
    '## T Manual Launch Checklist',
    'Kickstarter launch is manual.',
    '## T+5m Email Blast',
    '## T+15m Social Posts',
    '## T+24h First-Day Thank-You Update',
    '## Support Escalation',
    '## Launch-Day Readiness Mapping',
    'Do not add claims outside the claim evidence matrix during live comments.',
  ]);
  requireIncludes(`${campaignRoot}/prelaunch-page-pack.md`, [
    'Status: First pre-launch page draft, not approved to publish',
    'Notify me on launch',
    'UTM convention',
    'Required visible boundaries',
    'Capture Surface is required for accurate capture.',
    'Single-pen capture is the core first-version commitment.',
    'Obsidian is an optional projection/export path, not the capture source of truth.',
    'Do not drive traffic until the page owner confirms the Kickstarter preview link',
    'This pre-launch page pack is not publish approval.',
    'A pre-launch follower count does not prove launch demand',
  ]);
}

function verifyClaimEvidenceMatrix() {
  const file = `${campaignRoot}/claim-evidence-matrix.md`;
  if (!mustExist(file)) return;
  const text = readText(file);
  for (const claimId of claimIds) {
    if (!text.includes(`| ${claimId} |`)) fail(`claim matrix missing ${claimId}`);
  }
  for (const required of [
    'The page can only use public wording that matches the current evidence status.',
    'Demo-only',
    'Blocked until hardware',
    'External',
    'If a claim has only `Demo-only` evidence, write it as a prototype/demo workflow',
    'E-paper tablet included in base kit.',
    'Final price and delivery are guaranteed.',
    'AI is always correct.',
    'source file/session units',
    'source-unit frontmatter in demo vault',
    'Obsidian can receive reviewed knowledge projection grouped by source file or meeting session with backlinks.',
    'Audio/subtitles/timeline may be optional context only.',
    'Automatic meeting minutes from audio or subtitles.',
  ]) {
    if (!text.includes(required)) fail(`claim matrix missing guardrail: ${required}`);
  }
  note('claim evidence matrix has required claim ids and downgrade rules');
}

function verifyCampaignRiskChecklist() {
  requireIncludes(`${projectRoot}/evidence/kickstarter-page-risk-checklist.md`, [
    'Conditional draft / Not ready for publish',
    'Needs legal/privacy review before publish',
    'Kickstarter preview link',
    'Pre-launch page pack link',
    'Legal/privacy review link',
    'Launch-day comms and comment FAQ link',
    'Live comment escalation',
    'Guardrails included',
    'Hardware run log',
    'Latency report',
    'Obsidian receives reviewed projection grouped by source file or meeting session with backlinks',
  ]);
}

verifyCampaignStructure();
verifyClaimEvidenceMatrix();
verifyCampaignRiskChecklist();
for (const file of publicClaimFiles) scanDangerousPublicClaims(file);

if (failures.length > 0) {
  console.error('Kickstarter campaign claim verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Kickstarter campaign claim verification passed:');
for (const message of checked) console.log(`- ${message}`);
