import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultBaseDir = 'test-results/ai-pen-kickstarter-page-review-intake';
const outDir = 'test-results/ai-pen-kickstarter-page-review-audit';
const outJsonPath = `${outDir}/report.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const requiredReviewFields = ['Kickstarter preview link', 'Legal/privacy review link', 'Page owner review', 'Founder page approval'];
const requiredSections = [
  'Hero promise',
  'Education use case',
  'Business meeting use case',
  'What is in the Starter Kit',
  'Rewards and pricing',
  'AI and privacy disclosure',
  'Risks and challenges',
  'FAQ',
  'Launch-day comments and support macros',
];
const requiredLegalChecks = [
  'AI disclosure reviewed',
  'Privacy and data handling reviewed',
  'Hardware prototype risk reviewed',
  'Delivery and manufacturing risk reviewed',
  'Refund/support language reviewed',
  'Unsupported claims removed',
];

function parseArgs(argv) {
  const options = { intake: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') continue;
    if (arg === '--intake') {
      options.intake = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(absolute(relativePath), 'utf8'));
}

function latestIntakeDir() {
  const basePath = absolute(defaultBaseDir);
  if (!existsSync(basePath)) return null;
  const dirs = readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = `${defaultBaseDir}/${entry.name}`;
      const manifestPath = `${dir}/manifest.json`;
      if (!existsSync(absolute(manifestPath))) return null;
      const manifest = readJson(manifestPath);
      const generatedAt = Date.parse(manifest.generated_at ?? '');
      return { dir, generatedAt: Number.isNaN(generatedAt) ? 0 : generatedAt };
    })
    .filter(Boolean)
    .sort((a, b) => a.generatedAt - b.generatedAt || a.dir.localeCompare(b.dir));
  return dirs.at(-1)?.dir ?? null;
}

function normalizeRef(value) {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^`|`$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function isPlaceholder(value) {
  const normalized = normalizeRef(value);
  return (
    !normalized ||
    /^TBD$/i.test(normalized) ||
    /^0$/i.test(normalized) ||
    /^none$/i.test(normalized) ||
    /^n\/a$/i.test(normalized) ||
    /^not\s+(run|ready|reviewed|available)$/i.test(normalized) ||
    /\bTBD\b|missing|unknown|\[PRELAUNCH_URL\]|\[LAUNCH_URL\]/i.test(normalized)
  );
}

function isApproved(value) {
  return /^(yes|true|pass|approved|conditional pass|conditional-pass|ready|reviewed)$/i.test(normalizeRef(value));
}

function isUrl(value) {
  return /^https:\/\/.+/i.test(normalizeRef(value));
}

function isUsableArtifact(value, baseDir) {
  const normalized = normalizeRef(value);
  if (isPlaceholder(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) return true;
  if (/^(feishu|lark):/i.test(normalized)) return true;
  if (path.isAbsolute(normalized)) return existsSync(normalized);
  return existsSync(absolute(path.join(baseDir, normalized))) || existsSync(absolute(normalized));
}

function isNonEmptyFile(relativePath) {
  return existsSync(absolute(relativePath)) && statSync(absolute(relativePath)).size > 0;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function readCsv(relativePath) {
  const fullPath = absolute(relativePath);
  if (!existsSync(fullPath)) return { rows: [], error: `missing CSV: ${relativePath}` };
  const lines = readFileSync(fullPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length === 0) return { rows: [], error: `empty CSV: ${relativePath}` };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  return { rows, error: null };
}

function reviewDecisionReady(relativePath, decisionLabel) {
  if (!isNonEmptyFile(relativePath)) return false;
  const text = readFileSync(absolute(relativePath), 'utf8');
  const labelPattern = new RegExp(`^\\|\\s*${decisionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`, 'i');
  const decisionLine = text.split(/\r?\n/).find((line) => labelPattern.test(line.trim()));
  return decisionLine ? isApproved(decisionLine.split('|').map((cell) => cell.trim())[2]) : false;
}

function evaluateReviewFields(rows, intakeDir) {
  return requiredReviewFields.map((field) => {
    const row = rows.find((candidate) => candidate.field === field);
    const blockers = [];
    if (!row) {
      blockers.push('missing row');
    } else {
      if (isPlaceholder(row.value)) blockers.push('value is missing or TBD');
      if ((field === 'Kickstarter preview link' || field === 'Legal/privacy review link') && !isUrl(row.value)) {
        blockers.push('value must be an https URL');
      }
      if (!isUsableArtifact(row.evidence_path_or_url, intakeDir)) blockers.push('evidence_path_or_url is missing or unresolved');
      if (isPlaceholder(row.owner)) blockers.push('owner is missing');
      if (isPlaceholder(row.reviewer)) blockers.push('reviewer is missing');
      if (!isApproved(row.decision)) blockers.push('decision is not approved, ready, reviewed, or conditional pass');
    }
    return {
      field,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      value: row?.value ?? 'missing',
      evidence_path_or_url: row?.evidence_path_or_url ?? 'missing',
      decision: row?.decision ?? 'missing',
      blockers,
    };
  });
}

function evaluateSections(rows) {
  return requiredSections.map((section) => {
    const row = rows.find((candidate) => candidate.section === section);
    const blockers = [];
    if (!row) {
      blockers.push('missing row');
    } else {
      if (isPlaceholder(row.evidence_link)) blockers.push('evidence_link is missing');
      if (isPlaceholder(row.claim_status) || /^draft$/i.test(row.claim_status)) blockers.push('claim_status is still draft or missing');
      if (!isApproved(row.review_decision)) blockers.push('review_decision is not approved, ready, reviewed, or conditional pass');
      if (isPlaceholder(row.reviewer)) blockers.push('reviewer is missing');
    }
    return {
      section,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      claim_status: row?.claim_status ?? 'missing',
      review_decision: row?.review_decision ?? 'missing',
      blockers,
    };
  });
}

function evaluateLegal(rows, intakeDir) {
  return requiredLegalChecks.map((check) => {
    const row = rows.find((candidate) => candidate.check === check);
    const blockers = [];
    if (!row) {
      blockers.push('missing row');
    } else {
      if (!isUsableArtifact(row.evidence_path_or_url, intakeDir)) blockers.push('evidence_path_or_url is missing or unresolved');
      if (isPlaceholder(row.owner)) blockers.push('owner is missing');
      if (!isApproved(row.decision)) blockers.push('decision is not approved, ready, reviewed, or conditional pass');
    }
    return {
      check,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      decision: row?.decision ?? 'missing',
      evidence_path_or_url: row?.evidence_path_or_url ?? 'missing',
      blockers,
    };
  });
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function requiredInputRows(inputs) {
  if (!inputs.length) return '| n/a | n/a | n/a | n/a | n/a | n/a |';
  return inputs
    .map(
      (item) =>
        `| ${item.id} | ${item.owner} | ${item.required_input} | ${item.evidence_target} | ${item.blockers.join('; ') || 'none'} | \`${item.next_command}\` |`,
    )
    .join('\n');
}

function ownerForReviewField(field) {
  if (/legal|privacy/i.test(field)) return 'Legal/privacy';
  if (/founder/i.test(field)) return 'Founder';
  return 'Campaign';
}

function ownerForPageSection(section) {
  if (/education|business|hero|starter kit|rewards|faq|comments/i.test(section)) return 'Campaign / Product';
  if (/AI and privacy|Risks/i.test(section)) return 'Campaign / Legal';
  return 'Campaign';
}

function buildNextRequiredInputs({ intakeDir, reviewFields, pageSections, legalChecks, reviewFiles, csvErrors }) {
  const csvInputs = csvErrors.map((error) => ({
    id: `csv_${slug(error)}`,
    type: 'source_csv',
    owner: 'Campaign / Ops',
    required_input: `Fix the Kickstarter page review intake source file: ${error}.`,
    evidence_target: `${intakeDir}/raw/`,
    source_label: 'source CSV',
    current_value: 'missing_or_invalid',
    blockers: [error],
    unlocks: ['page_review_ready'],
    next_command: 'npm run kickstarter:page-review-audit',
    priority: 'P0',
  }));

  const fieldInputs = reviewFields
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `review_field_${slug(row.field)}`,
      type: 'review_field',
      owner: ownerForReviewField(row.field),
      required_input: `Fill "${row.field}" with a real value, evidence artifact, reviewer, and approved/ready decision.`,
      evidence_target: `${intakeDir}/raw/page-review-fields.csv`,
      source_label: row.field,
      current_value: row.value,
      blockers: row.blockers,
      unlocks: ['page_review_ready', 'launch_freeze_ready'],
      next_command: 'npm run kickstarter:page-review-audit',
      priority: 'P0',
    }));

  const sectionInputs = pageSections
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `page_section_${slug(row.section)}`,
      type: 'page_section',
      owner: ownerForPageSection(row.section),
      required_input: `Attach evidence, claim status, reviewer, and approved/ready review decision for "${row.section}".`,
      evidence_target: `${intakeDir}/raw/page-section-review.csv`,
      source_label: row.section,
      current_value: row.review_decision,
      blockers: row.blockers,
      unlocks: ['page_sections_ready', 'page_review_ready'],
      next_command: 'npm run kickstarter:page-review-audit',
      priority: 'P0',
    }));

  const legalInputs = legalChecks
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `legal_check_${slug(row.check)}`,
      type: 'legal_privacy_check',
      owner: 'Legal/privacy',
      required_input: `Attach review evidence and approved/ready decision for "${row.check}".`,
      evidence_target: `${intakeDir}/raw/legal-privacy-review.csv`,
      source_label: row.check,
      current_value: row.decision,
      blockers: row.blockers,
      unlocks: ['legal_privacy_checks_ready', 'page_review_ready'],
      next_command: 'npm run kickstarter:page-review-audit',
      priority: 'P0',
    }));

  const reviewFileInputs = [
    reviewFiles.page_owner_ready
      ? null
      : {
          id: 'review_file_page_owner',
          type: 'review_file',
          owner: 'Campaign',
          required_input: 'Record the page owner review file decision as approved/ready/reviewed after checking the preview page and section decisions.',
          evidence_target: `${intakeDir}/reviews/page-owner-review.md`,
          source_label: 'page owner review',
          current_value: 'not_ready',
          blockers: ['page owner review file decision is not ready'],
          unlocks: ['page_owner_review_ready', 'page_review_ready'],
          next_command: 'npm run kickstarter:page-review-audit',
          priority: 'P0',
        },
    reviewFiles.legal_privacy_ready
      ? null
      : {
          id: 'review_file_legal_privacy',
          type: 'review_file',
          owner: 'Legal/privacy',
          required_input: 'Record the legal/privacy review file decision as approved/ready/reviewed after checking AI, data, delivery, risk, refund, and claim language.',
          evidence_target: `${intakeDir}/reviews/legal-privacy-review.md`,
          source_label: 'legal/privacy review',
          current_value: 'not_ready',
          blockers: ['legal/privacy review file decision is not ready'],
          unlocks: ['legal_privacy_review_ready', 'page_review_ready'],
          next_command: 'npm run kickstarter:page-review-audit',
          priority: 'P0',
        },
    reviewFiles.founder_approval_ready
      ? null
      : {
          id: 'review_file_founder_approval',
          type: 'review_file',
          owner: 'Founder',
          required_input: 'Record the founder page approval decision as approved/ready/reviewed after checking public claims, downgrade scope, rewards, and launch timing.',
          evidence_target: `${intakeDir}/reviews/founder-page-approval.md`,
          source_label: 'founder page approval',
          current_value: 'not_ready',
          blockers: ['founder page approval file decision is not ready'],
          unlocks: ['founder_page_approval_ready', 'launch_freeze_ready'],
          next_command: 'npm run kickstarter:page-review-audit',
          priority: 'P0',
        },
  ].filter(Boolean);

  return [...csvInputs, ...fieldInputs, ...sectionInputs, ...legalInputs, ...reviewFileInputs];
}

function emptyReport(reason) {
  const nextRequiredInputs = [
    {
      id: 'page_review_intake',
      type: 'missing_source',
      owner: 'Campaign / Legal',
      required_input: `Create or restore a Kickstarter page review intake package under ${defaultBaseDir}.`,
      evidence_target: defaultBaseDir,
      source_label: defaultBaseDir,
      current_value: 'missing',
      blockers: [reason],
      unlocks: ['page_review_ready'],
      next_command: 'npm run kickstarter:page-review-intake',
      priority: 'P0',
    },
  ];
  return {
    schema: 'inkloop.kickstarter_page_review_audit.v1',
    generated_at: new Date().toISOString(),
    strict,
    intake_dir: null,
    status: 'page_review_not_ready',
    summary: {
      review_field_count: 0,
      ready_review_field_count: 0,
      section_count: 0,
      ready_section_count: 0,
      legal_check_count: 0,
      ready_legal_check_count: 0,
      next_required_input_count: nextRequiredInputs.length,
      blocker_count: 1,
    },
    review_fields: [],
    page_sections: [],
    legal_privacy_checks: [],
    review_files: {
      page_owner_ready: false,
      legal_privacy_ready: false,
      founder_approval_ready: false,
    },
    blockers: [reason],
    next_required_inputs: nextRequiredInputs,
    non_claims: [
      'Kickstarter page review audit is not publish approval.',
      'A ready page review audit still requires launch freeze signoff before launch.',
      'Template rows with TBD are intentionally rejected.',
    ],
  };
}

function readme(report) {
  const fieldRows = report.review_fields.length
    ? report.review_fields.map((row) => `| ${row.field} | ${row.status} | ${row.value} | ${row.decision} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a | n/a |';
  const sectionRows = report.page_sections.length
    ? report.page_sections.map((row) => `| ${row.section} | ${row.status} | ${row.claim_status} | ${row.review_decision} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a | n/a |';
  const legalRows = report.legal_privacy_checks.length
    ? report.legal_privacy_checks.map((row) => `| ${row.check} | ${row.status} | ${row.decision} | ${row.evidence_path_or_url} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a | n/a |';
  const nextRequiredRows = requiredInputRows(report.next_required_inputs ?? []);
  const blockers = report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- None';
  return `# InkLoop AI Pen Kickstarter Page Review Audit

Schema: \`inkloop.kickstarter_page_review_audit.v1\`

Generated at: ${report.generated_at}

Status: ${report.status}

Intake: \`${report.intake_dir ?? 'missing'}\`

This audit checks whether the formal Kickstarter preview page, page section review, legal/privacy review, and owner/founder review are ready for launch-freeze consideration. It does not approve publishing or launch.

## Summary

| Item | Value |
| --- | --- |
| Review fields ready | ${report.summary.ready_review_field_count}/${report.summary.review_field_count} |
| Page sections ready | ${report.summary.ready_section_count}/${report.summary.section_count} |
| Legal/privacy checks ready | ${report.summary.ready_legal_check_count}/${report.summary.legal_check_count} |
| Page owner review ready | ${report.review_files.page_owner_ready} |
| Legal/privacy review ready | ${report.review_files.legal_privacy_ready} |
| Founder approval ready | ${report.review_files.founder_approval_ready} |
| Next required inputs | ${report.summary.next_required_input_count} |

## Review Fields

| Field | Status | Value | Decision | Blockers |
| --- | --- | --- | --- | --- |
${fieldRows}

## Page Sections

| Section | Status | Claim Status | Review Decision | Blockers |
| --- | --- | --- | --- | --- |
${sectionRows}

## Legal And Privacy Checks

| Check | Status | Decision | Evidence | Blockers |
| --- | --- | --- | --- | --- |
${legalRows}

## Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Blockers | Next Command |
| --- | --- | --- | --- | --- | --- |
${nextRequiredRows}

## Blockers

${blockers}

## Non-Claims

- Passing this audit only means the page review package is ready for launch-freeze review.
- It does not approve Kickstarter publishing.
- It does not replace launch evidence audit strict mode, launch freeze signoff, or manual Kickstarter launch approval.

Detailed JSON: [report.json](./report.json)
`;
}

const options = parseArgs(process.argv.slice(2));
const intakeDir = options.intake ?? latestIntakeDir();
if (!intakeDir) {
  const report = emptyReport(`no Kickstarter page review intake directory found under ${defaultBaseDir}`);
  mkdirSync(absolute(outDir), { recursive: true });
  writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absolute(outReadmePath), readme(report));
  console.log(`Kickstarter page review audit status: ${report.status}`);
  console.log('Review fields: 0/0 ready');
  console.log('Page sections: 0/0 ready');
  console.log('Legal/privacy checks: 0/0 ready');
  console.log(`Report: ${outReadmePath}`);
  if (strict) {
    console.error('Strict Kickstarter page review audit failed: no page review intake package exists.');
    process.exit(1);
  }
  process.exit(0);
}

const manifestPath = `${intakeDir}/manifest.json`;
if (!existsSync(absolute(manifestPath))) {
  const report = { ...emptyReport(`missing Kickstarter page review intake manifest: ${manifestPath}`), intake_dir: intakeDir };
  mkdirSync(absolute(outDir), { recursive: true });
  writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absolute(outReadmePath), readme(report));
  console.log(`Kickstarter page review audit status: ${report.status}`);
  console.log('Review fields: 0/0 ready');
  console.log('Page sections: 0/0 ready');
  console.log('Legal/privacy checks: 0/0 ready');
  console.log(`Report: ${outReadmePath}`);
  if (strict) {
    console.error('Strict Kickstarter page review audit failed: missing page review intake manifest.');
    process.exit(1);
  }
  process.exit(0);
}

const reviewFieldsCsv = readCsv(`${intakeDir}/raw/page-review-fields.csv`);
const sectionCsv = readCsv(`${intakeDir}/raw/page-section-review.csv`);
const legalCsv = readCsv(`${intakeDir}/raw/legal-privacy-review.csv`);
const csvErrors = [reviewFieldsCsv.error, sectionCsv.error, legalCsv.error].filter(Boolean);

const reviewFields = evaluateReviewFields(reviewFieldsCsv.rows, intakeDir);
const pageSections = evaluateSections(sectionCsv.rows);
const legalChecks = evaluateLegal(legalCsv.rows, intakeDir);
const reviewFiles = {
  page_owner_ready: reviewDecisionReady(`${intakeDir}/reviews/page-owner-review.md`, 'Decision'),
  legal_privacy_ready: reviewDecisionReady(`${intakeDir}/reviews/legal-privacy-review.md`, 'Legal/privacy decision'),
  founder_approval_ready: reviewDecisionReady(`${intakeDir}/reviews/founder-page-approval.md`, 'Founder decision'),
};
const nextRequiredInputs = buildNextRequiredInputs({ intakeDir, reviewFields, pageSections, legalChecks, reviewFiles, csvErrors });

const blockers = [
  ...csvErrors,
  ...reviewFields.flatMap((row) => row.blockers.map((blocker) => `${row.field}: ${blocker}`)),
  ...pageSections.flatMap((row) => row.blockers.map((blocker) => `${row.section}: ${blocker}`)),
  ...legalChecks.flatMap((row) => row.blockers.map((blocker) => `${row.check}: ${blocker}`)),
  reviewFiles.page_owner_ready ? null : 'page owner review file decision is not ready',
  reviewFiles.legal_privacy_ready ? null : 'legal/privacy review file decision is not ready',
  reviewFiles.founder_approval_ready ? null : 'founder page approval file decision is not ready',
].filter(Boolean);

const report = {
  schema: 'inkloop.kickstarter_page_review_audit.v1',
  generated_at: new Date().toISOString(),
  strict,
  intake_dir: intakeDir,
  source_manifest: manifestPath,
  status: blockers.length === 0 ? 'page_review_ready' : 'page_review_not_ready',
  summary: {
    review_field_count: reviewFields.length,
    ready_review_field_count: reviewFields.filter((row) => row.status === 'ready').length,
    section_count: pageSections.length,
    ready_section_count: pageSections.filter((row) => row.status === 'ready').length,
    legal_check_count: legalChecks.length,
    ready_legal_check_count: legalChecks.filter((row) => row.status === 'ready').length,
    next_required_input_count: nextRequiredInputs.length,
    blocker_count: blockers.length,
  },
  review_fields: reviewFields,
  page_sections: pageSections,
  legal_privacy_checks: legalChecks,
  review_files: reviewFiles,
  blockers,
  next_required_inputs: nextRequiredInputs,
  non_claims: [
    'Kickstarter page review audit is not publish approval.',
    'A ready page review audit still requires launch freeze signoff before launch.',
    'Template rows with TBD are intentionally rejected.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter page review audit status: ${report.status}`);
console.log(`Review fields: ${report.summary.ready_review_field_count}/${report.summary.review_field_count} ready`);
console.log(`Page sections: ${report.summary.ready_section_count}/${report.summary.section_count} ready`);
console.log(`Legal/privacy checks: ${report.summary.ready_legal_check_count}/${report.summary.legal_check_count} ready`);
console.log(`Next required inputs: ${report.summary.next_required_input_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'page_review_ready') {
  console.error('Strict Kickstarter page review audit failed: preview page, legal/privacy review, page sections, or owner approvals are incomplete.');
  process.exit(1);
}
