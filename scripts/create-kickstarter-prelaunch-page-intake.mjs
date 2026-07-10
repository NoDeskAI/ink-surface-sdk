import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultRunId = new Date().toISOString().slice(0, 10);
const prelaunchPackPath = 'docs/project/inkloop-ai-pen-kickstarter/campaign/prelaunch-page-pack.md';

function parseArgs(argv) {
  const options = {
    runId: defaultRunId,
    outDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-id') {
      options.runId = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      options.outDir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.runId) throw new Error('--run-id requires a value');
  options.outDir ??= `test-results/ai-pen-kickstarter-prelaunch-page-intake/${options.runId}`;
  return options;
}

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function write(relativePath, content) {
  const fullPath = absolute(relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${content.trimEnd()}\n`);
}

function parseFieldTable(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    if (/^\|\s*-+/.test(trimmed)) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2 || cells[0] === 'Field') continue;
    rows.push({
      field: cells[0],
      value: cells[1],
      approval_state: cells[2] ?? '',
    });
  }
  return rows;
}

function csvCell(value) {
  const normalized = String(value ?? '');
  if (!/[",\n]/.test(normalized)) return normalized;
  return `"${normalized.replace(/"/g, '""')}"`;
}

function csv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function pageFieldsCsv(fields) {
  return csv([
    ['field', 'value', 'approval_state', 'evidence_path', 'reviewer', 'notes'],
    ...fields.map((field) => [field.field, field.value, field.approval_state, 'artifacts/TBD.png', 'TBD', 'TBD']),
  ]);
}

function notifyTrackingCsv() {
  return csv([
    [
      'date',
      'channel',
      'target_segment',
      'message_or_asset',
      'url',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'owner',
      'ready_to_send',
      'result',
      'notes',
    ],
    [
      'YYYY-MM-DD',
      'TBD',
      'Education / Business',
      'TBD',
      'https://www.kickstarter.com/projects/TBD',
      'TBD',
      'organic',
      'inkloop_ks_prelaunch',
      'TBD',
      'TBD',
      'TBD',
      'TBD',
      'TBD',
    ],
  ]);
}

function ownerReviewCsv() {
  return csv([
    ['item', 'owner', 'decision', 'evidence_path', 'reviewer', 'notes'],
    ['Kickstarter preview captured', 'Campaign', 'Not reviewed', 'screenshots/TBD-preview.png', 'TBD', 'TBD'],
    ['Pre-launch page URL captured', 'Campaign', 'Not reviewed', 'screenshots/TBD-prelaunch.png', 'TBD', 'TBD'],
    ['Public copy lock reviewed', 'Campaign', 'Not reviewed', 'artifacts/public-copy-lock-review.md', 'TBD', 'TBD'],
    ['Claim downgrade reviewed', 'Campaign', 'Not reviewed', 'artifacts/claim-downgrade-review.md', 'TBD', 'TBD'],
    ['Hero asset approved', 'Campaign', 'Not reviewed', 'artifacts/TBD-hero.png', 'TBD', 'TBD'],
    ['GTM tracking ready', 'GTM', 'Not reviewed', 'artifacts/utm-and-crm-routing.md', 'TBD', 'TBD'],
    ['Education and business segments ready', 'GTM', 'Not reviewed', 'raw/notify-me-tracking.csv', 'TBD', 'TBD'],
    ['Founder review complete', 'Founder', 'Not reviewed', 'reviews/founder-review.md', 'TBD', 'TBD'],
  ]);
}

function founderReview() {
  return `# Founder Pre-Launch Review

Schema: \`inkloop.kickstarter_prelaunch_owner_review.v1\`

This review is not launch approval. It only decides whether the Kickstarter pre-launch page and Notify me funnel can start collecting followers.

## Review

| Field | Value |
| --- | --- |
| Review date | TBD |
| Founder reviewer | TBD |
| Kickstarter preview link | TBD |
| Pre-launch URL | TBD |
| Public copy lock report | TBD |
| Claim downgrade report | TBD |
| GTM tracker/source | TBD |
| Decision | Not reviewed |

## Required Checks

| Check | Decision | Evidence |
| --- | --- | --- |
| Page preview matches AI Pen + Capture Surface V1 scope | TBD | TBD |
| Capture Surface requirement is visible | TBD | TBD |
| E-paper is not promised as the base reward | TBD | TBD |
| AI outputs are described as reviewed outputs | TBD | TBD |
| Notify me CTA and UTM tracking are ready | TBD | TBD |
| Education and business outreach targets are ready | TBD | TBD |
| Unsupported claims are absent or downgraded | TBD | TBD |

## Notes

TBD
`;
}

function rootReadme({ outDir, generatedAt, fields }) {
  return `# InkLoop AI Pen Kickstarter Pre-Launch Page Intake

Schema: \`inkloop.kickstarter_prelaunch_page_intake.v1\`

Generated at: ${generatedAt}

Kickstarter pre-launch page intake is not publish approval. This package is the staging area for the Kickstarter preview URL, live pre-launch URL, Notify me funnel tracking, screenshots, owner review, and founder review before any pre-launch traffic is sent.

## Files

| File | Purpose |
| --- | --- |
| \`raw/page-fields.csv\` | Concrete values and evidence paths for the pre-launch page fields currently drafted in \`${prelaunchPackPath}\` |
| \`raw/notify-me-tracking.csv\` | Channel, UTM, owner, and readiness rows for pre-launch traffic |
| \`raw/owner-review.csv\` | Owner review decisions for preview, live URL, copy lock, claim downgrade, hero asset, GTM tracking, segments, and founder approval |
| \`reviews/founder-review.md\` | Human founder review record |
| \`screenshots/\` | Kickstarter preview, pre-launch page, and Notify me funnel screenshots |
| \`exports/\` | Kickstarter dashboard, CRM, email, or analytics exports |
| \`artifacts/\` | Public copy lock review notes, hero assets, UTM plans, or supporting files |

## Current Draft Fields

${fields.map((field) => `- ${field.field}: ${field.value} (${field.approval_state})`).join('\n')}

## Workflow

1. Create or update the Kickstarter pre-launch page in Kickstarter.
2. Put screenshots under \`${outDir}/screenshots/\`.
3. Put dashboard, CRM, email, or analytics exports under \`${outDir}/exports/\`.
4. Fill \`raw/page-fields.csv\` with actual preview/live URL values and evidence paths.
5. Fill \`raw/notify-me-tracking.csv\` for every channel that will send traffic.
6. Fill \`raw/owner-review.csv\` and \`reviews/founder-review.md\` after review.
7. Run \`npm run kickstarter:prelaunch-page-intake-audit\`.
8. Run \`npm run kickstarter:prelaunch-page-pack\`, \`npm run kickstarter:ops-refresh\`, and keep strict mode red until public copy, GTM, launch evidence, and owner review are ready.

## Non-Claims

- This intake package is not publish approval.
- A preview URL is not demand evidence.
- Notify me counts must come from real Kickstarter dashboard and GTM exports before they affect launch readiness.
- Template rows with TBD are intentionally rejected by the intake audit.
`;
}

function manifest({ outDir, generatedAt, fields }) {
  return {
    schema: 'inkloop.kickstarter_prelaunch_page_intake.v1',
    generated_at: generatedAt,
    out_dir: outDir,
    source_prelaunch_pack: prelaunchPackPath,
    page_fields: fields,
    required_commands: [
      'npm run kickstarter:prelaunch-page-intake-audit',
      'npm run kickstarter:prelaunch-page-pack',
      'npm run kickstarter:public-copy-lock',
      'npm run launch:kpi-dashboard',
      'npm run kickstarter:ops-refresh',
      'npm run kickstarter:prelaunch-page-pack:strict',
    ],
    non_claims: [
      'Kickstarter pre-launch page intake is not publish approval.',
      'A preview URL is not launch demand evidence.',
      'Template rows with TBD are intentionally rejected by the audit.',
    ],
  };
}

const { outDir } = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();
const prelaunchPack = readFileSync(absolute(prelaunchPackPath), 'utf8');
const fields = parseFieldTable(prelaunchPack, '## Pre-Launch Page Fields');
if (fields.length === 0) throw new Error(`no pre-launch page fields found in ${prelaunchPackPath}`);

for (const dir of ['raw', 'screenshots', 'exports', 'artifacts', 'reviews']) {
  mkdirSync(absolute(`${outDir}/${dir}`), { recursive: true });
}

write(`${outDir}/README.md`, rootReadme({ outDir, generatedAt, fields }));
write(`${outDir}/manifest.json`, JSON.stringify(manifest({ outDir, generatedAt, fields }), null, 2));
write(`${outDir}/raw/page-fields.csv`, pageFieldsCsv(fields));
write(`${outDir}/raw/notify-me-tracking.csv`, notifyTrackingCsv());
write(`${outDir}/raw/owner-review.csv`, ownerReviewCsv());
write(`${outDir}/reviews/founder-review.md`, founderReview());

console.log(`Kickstarter pre-launch page intake package created: ${outDir}`);
console.log(`Page fields: ${fields.length}`);
console.log(`README: ${outDir}/README.md`);
