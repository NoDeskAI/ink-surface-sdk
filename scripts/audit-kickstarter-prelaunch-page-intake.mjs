import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultBaseDir = 'test-results/ai-pen-kickstarter-prelaunch-page-intake';
const outDir = 'test-results/ai-pen-kickstarter-prelaunch-page-intake-audit';
const outJsonPath = `${outDir}/report.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const requiredPageFields = ['Kickstarter preview link', 'Pre-launch URL', 'Owner', 'Final reviewer'];
const requiredOwnerReviewItems = [
  'Kickstarter preview captured',
  'Pre-launch page URL captured',
  'Public copy lock reviewed',
  'Claim downgrade reviewed',
  'Hero asset approved',
  'GTM tracking ready',
  'Education and business segments ready',
  'Founder review complete',
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
      return {
        dir,
        generatedAt: Number.isNaN(generatedAt) ? 0 : generatedAt,
      };
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
    /^\[PRELAUNCH_URL\]$/i.test(normalized) ||
    /^0$/i.test(normalized) ||
    /^none$/i.test(normalized) ||
    /^n\/a$/i.test(normalized) ||
    /^not\s+(run|ready|reviewed|available)$/i.test(normalized) ||
    /\bTBD\b|\[PRELAUNCH_URL\]|\[LAUNCH_URL\]|missing|unknown/i.test(normalized)
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
  if (/^(feishu|lark|obsidian|inkloop):/i.test(normalized)) return true;
  if (path.isAbsolute(normalized)) return existsSync(normalized);
  return existsSync(absolute(path.join(baseDir, normalized))) || existsSync(absolute(normalized));
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

function evaluatePageFields(rows, intakeDir) {
  return requiredPageFields.map((field) => {
    const row = rows.find((candidate) => candidate.field === field);
    const blockers = [];
    if (!row) {
      blockers.push('missing row');
    } else {
      if (isPlaceholder(row.value)) blockers.push('value is missing or TBD');
      if ((field === 'Kickstarter preview link' || field === 'Pre-launch URL') && !isUrl(row.value)) {
        blockers.push('value must be an https URL');
      }
      if (!isUsableArtifact(row.evidence_path, intakeDir)) blockers.push('evidence_path is missing or unresolved');
      if (isPlaceholder(row.reviewer)) blockers.push('reviewer is missing');
    }
    return {
      field,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      value: row?.value ?? 'missing',
      evidence_path: row?.evidence_path ?? 'missing',
      reviewer: row?.reviewer ?? 'missing',
      blockers,
    };
  });
}

function evaluateOwnerReview(rows, intakeDir) {
  return requiredOwnerReviewItems.map((item) => {
    const row = rows.find((candidate) => candidate.item === item);
    const blockers = [];
    if (!row) {
      blockers.push('missing row');
    } else {
      if (isPlaceholder(row.owner)) blockers.push('owner is missing');
      if (!isApproved(row.decision)) blockers.push('decision is not approved, ready, reviewed, or conditional pass');
      if (!isUsableArtifact(row.evidence_path, intakeDir)) blockers.push('evidence_path is missing or unresolved');
      if (isPlaceholder(row.reviewer)) blockers.push('reviewer is missing');
    }
    return {
      item,
      status: blockers.length === 0 ? 'ready' : 'not_ready',
      owner: row?.owner ?? 'missing',
      decision: row?.decision ?? 'missing',
      evidence_path: row?.evidence_path ?? 'missing',
      reviewer: row?.reviewer ?? 'missing',
      blockers,
    };
  });
}

function evaluateTracking(rows) {
  const usableRows = rows.filter(
    (row) =>
      !isPlaceholder(row.channel) &&
      !isPlaceholder(row.target_segment) &&
      isUrl(row.url) &&
      !isPlaceholder(row.utm_source) &&
      !isPlaceholder(row.utm_campaign) &&
      !isPlaceholder(row.utm_content) &&
      !isPlaceholder(row.owner) &&
      isApproved(row.ready_to_send),
  );
  return {
    status: usableRows.length > 0 ? 'ready' : 'not_ready',
    row_count: rows.length,
    usable_row_count: usableRows.length,
    blockers: usableRows.length > 0 ? [] : ['no ready Notify me tracking row with URL, UTM, owner, and approved send state'],
  };
}

function readme(report) {
  const fieldRows = report.page_fields
    .map((field) => `| ${field.field} | ${field.status} | ${field.value} | ${field.evidence_path} | ${field.blockers.join('; ') || 'none'} |`)
    .join('\n');
  const reviewRows = report.owner_review
    .map((item) => `| ${item.item} | ${item.status} | ${item.decision} | ${item.evidence_path} | ${item.blockers.join('; ') || 'none'} |`)
    .join('\n');
  const blockers = report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- None';
  return `# InkLoop AI Pen Kickstarter Pre-Launch Page Intake Audit

Schema: \`inkloop.kickstarter_prelaunch_page_intake_audit.v1\`

Generated at: ${report.generated_at}

Status: ${report.status}

Intake: \`${report.intake_dir}\`

This audit checks whether the pre-launch page intake has actual URL values, screenshots or supporting artifacts, Notify me tracking rows, and owner/founder review. It does not replace public copy lock, claim downgrade, GTM evidence, legal/privacy review, launch evidence audit, or Kickstarter publish approval.

## Page Field Checks

| Field | Status | Value | Evidence | Blockers |
| --- | --- | --- | --- | --- |
${fieldRows}

## Owner Review Checks

| Item | Status | Decision | Evidence | Blockers |
| --- | --- | --- | --- | --- |
${reviewRows}

## Notify Me Tracking

| Status | Rows | Ready Rows |
| --- | ---: | ---: |
| ${report.notify_me_tracking.status} | ${report.notify_me_tracking.row_count} | ${report.notify_me_tracking.usable_row_count} |

## Blockers

${blockers}

## Non-Claims

- Passing this audit only means the pre-launch intake rows look ready for review.
- It does not prove demand, launch readiness, or claim safety.
- Template rows with TBD are expected to fail until real Kickstarter and GTM artifacts are added.

Detailed JSON: [report.json](./report.json)
`;
}

const options = parseArgs(process.argv.slice(2));
const intakeDir = options.intake ?? latestIntakeDir();
if (!intakeDir) {
  const report = {
    schema: 'inkloop.kickstarter_prelaunch_page_intake_audit.v1',
    generated_at: new Date().toISOString(),
    strict,
    intake_dir: null,
    source_manifest: null,
    status: 'prelaunch_intake_not_ready',
    summary: {
      page_field_count: 0,
      ready_page_field_count: 0,
      owner_review_count: 0,
      ready_owner_review_count: 0,
      tracking_row_count: 0,
      ready_tracking_row_count: 0,
      blocker_count: 1,
    },
    manifest_schema: 'missing',
    page_fields: [],
    owner_review: [],
    notify_me_tracking: {
      status: 'not_ready',
      row_count: 0,
      usable_row_count: 0,
      blockers: ['no pre-launch page intake package exists'],
    },
    blockers: [`no pre-launch page intake directory found under ${defaultBaseDir}`],
    non_claims: [
      'Pre-launch page intake audit is not publish approval.',
      'A ready intake still requires public copy lock, claim downgrade, GTM exports, launch evidence, and owner/founder approval in the main pack.',
      'Template rows with TBD are intentionally rejected.',
    ],
  };
  mkdirSync(absolute(outDir), { recursive: true });
  writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absolute(outReadmePath), readme(report));
  console.log(`Kickstarter pre-launch page intake audit status: ${report.status}`);
  console.log('Page fields: 0/0 ready');
  console.log('Owner reviews: 0/0 ready');
  console.log('Notify me tracking rows: 0/0 ready');
  console.log(`Report: ${outReadmePath}`);
  if (strict) {
    console.error('Strict Kickstarter pre-launch page intake audit failed: no pre-launch page intake package exists.');
    process.exit(1);
  }
  process.exit(0);
}
const manifestPath = `${intakeDir}/manifest.json`;
if (!existsSync(absolute(manifestPath))) {
  const report = {
    schema: 'inkloop.kickstarter_prelaunch_page_intake_audit.v1',
    generated_at: new Date().toISOString(),
    strict,
    intake_dir: intakeDir,
    source_manifest: manifestPath,
    status: 'prelaunch_intake_not_ready',
    summary: {
      page_field_count: 0,
      ready_page_field_count: 0,
      owner_review_count: 0,
      ready_owner_review_count: 0,
      tracking_row_count: 0,
      ready_tracking_row_count: 0,
      blocker_count: 1,
    },
    manifest_schema: 'missing',
    page_fields: [],
    owner_review: [],
    notify_me_tracking: {
      status: 'not_ready',
      row_count: 0,
      usable_row_count: 0,
      blockers: ['missing pre-launch intake manifest'],
    },
    blockers: [`missing pre-launch intake manifest: ${manifestPath}`],
    non_claims: [
      'Pre-launch page intake audit is not publish approval.',
      'A ready intake still requires public copy lock, claim downgrade, GTM exports, launch evidence, and owner/founder approval in the main pack.',
      'Template rows with TBD are intentionally rejected.',
    ],
  };
  mkdirSync(absolute(outDir), { recursive: true });
  writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absolute(outReadmePath), readme(report));
  console.log(`Kickstarter pre-launch page intake audit status: ${report.status}`);
  console.log('Page fields: 0/0 ready');
  console.log('Owner reviews: 0/0 ready');
  console.log('Notify me tracking rows: 0/0 ready');
  console.log(`Report: ${outReadmePath}`);
  if (strict) {
    console.error('Strict Kickstarter pre-launch page intake audit failed: missing pre-launch intake manifest.');
    process.exit(1);
  }
  process.exit(0);
}

const manifest = readJson(manifestPath);
const pageFields = readCsv(`${intakeDir}/raw/page-fields.csv`);
const ownerReview = readCsv(`${intakeDir}/raw/owner-review.csv`);
const notifyMeTracking = readCsv(`${intakeDir}/raw/notify-me-tracking.csv`);
const csvErrors = [pageFields.error, ownerReview.error, notifyMeTracking.error].filter(Boolean);
const fieldChecks = evaluatePageFields(pageFields.rows, intakeDir);
const ownerReviewChecks = evaluateOwnerReview(ownerReview.rows, intakeDir);
const trackingCheck = evaluateTracking(notifyMeTracking.rows);
const blockers = [
  ...csvErrors,
  ...fieldChecks.flatMap((field) => field.blockers.map((blocker) => `${field.field}: ${blocker}`)),
  ...ownerReviewChecks.flatMap((item) => item.blockers.map((blocker) => `${item.item}: ${blocker}`)),
  ...trackingCheck.blockers,
].filter(Boolean);

const report = {
  schema: 'inkloop.kickstarter_prelaunch_page_intake_audit.v1',
  generated_at: new Date().toISOString(),
  strict,
  intake_dir: intakeDir,
  source_manifest: manifestPath,
  status: blockers.length === 0 ? 'prelaunch_intake_ready' : 'prelaunch_intake_not_ready',
  summary: {
    page_field_count: fieldChecks.length,
    ready_page_field_count: fieldChecks.filter((field) => field.status === 'ready').length,
    owner_review_count: ownerReviewChecks.length,
    ready_owner_review_count: ownerReviewChecks.filter((item) => item.status === 'ready').length,
    tracking_row_count: trackingCheck.row_count,
    ready_tracking_row_count: trackingCheck.usable_row_count,
    blocker_count: blockers.length,
  },
  manifest_schema: manifest.schema ?? 'unknown',
  page_fields: fieldChecks,
  owner_review: ownerReviewChecks,
  notify_me_tracking: trackingCheck,
  blockers,
  non_claims: [
    'Pre-launch page intake audit is not publish approval.',
    'A ready intake still requires public copy lock, claim downgrade, GTM exports, launch evidence, and owner/founder approval in the main pack.',
    'Template rows with TBD are intentionally rejected.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter pre-launch page intake audit status: ${report.status}`);
console.log(`Page fields: ${report.summary.ready_page_field_count}/${report.summary.page_field_count} ready`);
console.log(`Owner reviews: ${report.summary.ready_owner_review_count}/${report.summary.owner_review_count} ready`);
console.log(`Notify me tracking rows: ${report.summary.ready_tracking_row_count}/${report.summary.tracking_row_count} ready`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'prelaunch_intake_ready') {
  console.error('Strict Kickstarter pre-launch page intake audit failed: preview URL, live URL, owner review, or Notify me tracking evidence is incomplete.');
  process.exit(1);
}
