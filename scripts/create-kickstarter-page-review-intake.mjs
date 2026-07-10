import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultRunId = new Date().toISOString().slice(0, 10);
const pageChecklistPath = 'docs/project/inkloop-ai-pen-kickstarter/evidence/kickstarter-page-risk-checklist.md';

function parseArgs(argv) {
  const options = { runId: defaultRunId, outDir: null };
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
  options.outDir ??= `test-results/ai-pen-kickstarter-page-review-intake/${options.runId}`;
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

function csvCell(value) {
  const normalized = String(value ?? '');
  return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function csv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

const pageReviewRows = [
  ['field', 'value', 'evidence_path_or_url', 'owner', 'reviewer', 'decision', 'notes'],
  ['Kickstarter preview link', 'TBD', 'screenshots/kickstarter-preview.png', 'Campaign', 'TBD', 'Not reviewed', 'Reviewable Kickstarter preview URL'],
  ['Legal/privacy review link', 'TBD', 'reviews/legal-privacy-review.md', 'Legal/privacy', 'TBD', 'Not reviewed', 'AI, data, hardware, delivery, refund, and support review'],
  ['Page owner review', 'TBD', 'reviews/page-owner-review.md', 'Campaign', 'TBD', 'Not reviewed', 'Final campaign owner review'],
  ['Founder page approval', 'TBD', 'reviews/founder-page-approval.md', 'Founder', 'TBD', 'Not reviewed', 'Founder approval before public page freeze'],
];

const sectionRows = [
  ['section', 'evidence_link', 'claim_status', 'review_decision', 'reviewer', 'notes'],
  ['Hero promise', 'TBD', 'draft', 'Not reviewed', 'TBD', 'AI Pen + Capture Surface promise visible'],
  ['Education use case', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Real teacher proof or downgraded wording'],
  ['Business meeting use case', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Board-evidence meeting output wording'],
  ['What is in the Starter Kit', 'TBD', 'draft', 'Not reviewed', 'TBD', 'No e-paper base promise'],
  ['Rewards and pricing', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Must match supplier quote audit'],
  ['AI and privacy disclosure', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Cloud AI and reviewability disclosed'],
  ['Risks and challenges', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Hardware, supply, AI, delivery risks visible'],
  ['FAQ', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Unsupported claims removed or downgraded'],
  ['Launch-day comments and support macros', 'TBD', 'draft', 'Not reviewed', 'TBD', 'Support escalation reviewed'],
];

const legalRows = [
  ['check', 'evidence_path_or_url', 'owner', 'decision', 'notes'],
  ['AI disclosure reviewed', 'TBD', 'Legal/privacy', 'Not reviewed', 'AI outputs are reviewable and may be cloud processed'],
  ['Privacy and data handling reviewed', 'TBD', 'Legal/privacy', 'Not reviewed', 'Captured ink, optional meeting context, and cloud processing explained'],
  ['Hardware prototype risk reviewed', 'TBD', 'Legal/privacy', 'Not reviewed', 'Prototype maturity and development risk disclosed'],
  ['Delivery and manufacturing risk reviewed', 'TBD', 'Legal/privacy', 'Not reviewed', 'Supplier, certification, shipping, and delay risks disclosed'],
  ['Refund/support language reviewed', 'TBD', 'Legal/privacy', 'Not reviewed', 'Kickstarter delivery/support language reviewed'],
  ['Unsupported claims removed', 'TBD', 'Campaign', 'Not reviewed', 'Any-whiteboard, perfect AI, zero latency, guaranteed delivery removed'],
];

function reviewMarkdown(title, schema, decisionLabel = 'Decision') {
  return `# ${title}

Schema: \`${schema}\`

| Field | Value |
| --- | --- |
| Review date | TBD |
| Owner | TBD |
| Reviewer | TBD |
| Kickstarter preview link | TBD |
| Legal/privacy review link | TBD |
| ${decisionLabel} | Not reviewed |

## Notes

TBD
`;
}

function readme({ outDir, generatedAt }) {
  return `# InkLoop AI Pen Kickstarter Page Review Intake

Schema: \`inkloop.kickstarter_page_review_intake.v1\`

Generated at: ${generatedAt}

This intake is the staging package for the formal Kickstarter page preview, section review, legal/privacy review, and final owner review. It is not publish approval.

## Files

| File | Purpose |
| --- | --- |
| \`raw/page-review-fields.csv\` | Preview URL, legal/privacy review link, page owner review, and founder approval rows |
| \`raw/page-section-review.csv\` | Required Kickstarter page sections with evidence links and review decisions |
| \`raw/legal-privacy-review.csv\` | AI, privacy, hardware, delivery, refund/support, and unsupported-claim checks |
| \`screenshots/\` | Kickstarter preview screenshots and proof images |
| \`exports/\` | Kickstarter preview exports, page PDFs, or review exports |
| \`reviews/\` | Page owner, legal/privacy, and founder review notes |
| \`artifacts/\` | Supporting claim, risk, privacy, or copy review files |

## Workflow

1. Create a reviewable Kickstarter preview page.
2. Put screenshots under \`${outDir}/screenshots/\` and exports under \`${outDir}/exports/\`.
3. Fill \`raw/page-review-fields.csv\` with real preview/review links, owners, reviewers, and decisions.
4. Fill \`raw/page-section-review.csv\` with evidence links and reviewed decisions for every public page section.
5. Fill \`raw/legal-privacy-review.csv\` after AI/privacy, data, hardware, delivery, refund/support, and unsupported-claim review.
6. Fill \`reviews/page-owner-review.md\`, \`reviews/legal-privacy-review.md\`, and \`reviews/founder-page-approval.md\`.
7. Run \`npm run kickstarter:page-review-audit\`.
8. Copy approved links into \`${pageChecklistPath}\` only after the audit is ready.

## Non-Claims

- This intake package is not publish approval.
- A Kickstarter preview URL is not demand proof.
- Legal/privacy review does not replace real hardware, supplier, GTM, proof-shot, or founder launch signoff evidence.
- Template rows with TBD are intentionally rejected by the audit.
`;
}

function manifest({ outDir, generatedAt }) {
  return {
    schema: 'inkloop.kickstarter_page_review_intake.v1',
    generated_at: generatedAt,
    out_dir: outDir,
    page_checklist: pageChecklistPath,
    required_commands: [
      'npm run kickstarter:page-review-audit',
      'npm run kickstarter:public-copy-lock',
      'npm run kickstarter:launch-freeze-pack',
      'npm run kickstarter:ops-refresh',
    ],
    non_claims: [
      'Kickstarter page review intake is not publish approval.',
      'A Kickstarter preview URL is not demand proof.',
      'Template rows with TBD are intentionally rejected by the audit.',
    ],
  };
}

const { outDir } = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();

for (const dir of ['raw', 'screenshots', 'exports', 'reviews', 'artifacts']) {
  mkdirSync(absolute(`${outDir}/${dir}`), { recursive: true });
}

write(`${outDir}/README.md`, readme({ outDir, generatedAt }));
write(`${outDir}/manifest.json`, JSON.stringify(manifest({ outDir, generatedAt }), null, 2));
write(`${outDir}/raw/page-review-fields.csv`, csv(pageReviewRows));
write(`${outDir}/raw/page-section-review.csv`, csv(sectionRows));
write(`${outDir}/raw/legal-privacy-review.csv`, csv(legalRows));
write(`${outDir}/reviews/page-owner-review.md`, reviewMarkdown('Kickstarter Page Owner Review', 'inkloop.kickstarter_page_owner_review.v1'));
write(`${outDir}/reviews/legal-privacy-review.md`, reviewMarkdown('Kickstarter Legal And Privacy Review', 'inkloop.kickstarter_legal_privacy_review.v1', 'Legal/privacy decision'));
write(`${outDir}/reviews/founder-page-approval.md`, reviewMarkdown('Kickstarter Founder Page Approval', 'inkloop.kickstarter_founder_page_approval.v1', 'Founder decision'));

console.log(`Kickstarter page review intake package created: ${outDir}`);
console.log(`README: ${outDir}/README.md`);
