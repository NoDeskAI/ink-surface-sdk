import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultRunId = new Date().toISOString().slice(0, 10);
const bomTrackerPath = 'docs/project/inkloop-ai-pen-kickstarter/evidence/bom-supplier-tracker.md';

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
  options.outDir ??= `test-results/ai-pen-kickstarter-supplier-quote-intake/${options.runId}`;
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

function csv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const normalized = String(value ?? '');
          return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
        })
        .join(','),
    )
    .join('\n');
}

const bomRows = [
  ['reward_sku', 'category', 'component', 'required', 'quantity_per_reward', 'unit_cost_usd', 'primary_supplier', 'backup_supplier', 'quote_status', 'confidence', 'lead_time_days', 'moq', 'risk'],
  ['starter_kit', 'Pen', 'MCU / sensor module', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Sensor module price not quoted'],
  ['starter_kit', 'Pen', 'Battery / charging', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Battery certification path open'],
  ['starter_kit', 'Pen', 'Shell / mechanical', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Mechanical tolerance not validated'],
  ['starter_kit', 'Surface', 'A3 Capture Surface material', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Material durability not validated'],
  ['starter_kit', 'Surface', 'A2 Capture Surface material', 'false', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Material durability not validated'],
  ['starter_kit', 'Packaging', 'Starter Kit box', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Packaging dimensions not final'],
  ['starter_kit', 'Assembly', 'Assembly and QA', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Factory route not quoted'],
  ['starter_kit', 'Software', 'AI credit buffer', 'true', '1', '0', 'TBD', 'TBD', 'unknown', 'Low', '0', '0', 'Usage cost can vary'],
];

const supplierQuoteRows = [
  ['component', 'supplier_role', 'supplier_name', 'quote_status', 'quote_path_or_url', 'valid_until', 'currency', 'unit_cost_usd', 'moq', 'lead_time_days', 'owner', 'notes'],
  ['MCU / sensor module', 'primary', 'TBD', 'Not requested', 'quotes/TBD.pdf', 'YYYY-MM-DD', 'USD', '0', '0', '0', 'TBD', 'TBD'],
  ['MCU / sensor module', 'backup', 'TBD', 'Not requested', 'quotes/TBD.pdf', 'YYYY-MM-DD', 'USD', '0', '0', '0', 'TBD', 'TBD'],
  ['Battery / charging', 'primary', 'TBD', 'Not requested', 'quotes/TBD.pdf', 'YYYY-MM-DD', 'USD', '0', '0', '0', 'TBD', 'TBD'],
  ['A3 Capture Surface material', 'primary', 'TBD', 'Not requested', 'quotes/TBD.pdf', 'YYYY-MM-DD', 'USD', '0', '0', '0', 'TBD', 'TBD'],
  ['Starter Kit box', 'primary', 'TBD', 'Not requested', 'quotes/TBD.pdf', 'YYYY-MM-DD', 'USD', '0', '0', '0', 'TBD', 'TBD'],
  ['Assembly and QA', 'primary', 'TBD', 'Not requested', 'quotes/TBD.pdf', 'YYYY-MM-DD', 'USD', '0', '0', '0', 'TBD', 'TBD'],
];

const riskRows = [
  ['risk', 'component', 'impact', 'mitigation', 'owner', 'decision'],
  ['Sensor module price not quoted', 'MCU / sensor module', 'Reward price may be wrong', 'Get primary and backup quote', 'TBD', 'Open'],
  ['Material durability not validated', 'Capture Surface', 'Cannot support public durability claim', 'Tie supplier quote to material test batch', 'TBD', 'Open'],
  ['Factory route not quoted', 'Assembly and QA', 'Delivery risk', 'Get assembly route and QA fixture quote', 'TBD', 'Open'],
];

function readme({ outDir, generatedAt }) {
  const analyzerCommand = `npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- ${outDir}/raw/bom.csv --out ${outDir}/reports/reward-pricing-report.json`;
  return `# InkLoop AI Pen Kickstarter Supplier Quote Intake

Schema: \`inkloop.kickstarter_supplier_quote_intake.v1\`

Generated at: ${generatedAt}

This supplier quote intake is not reward pricing approval. It is the staging package for BOM rows, primary supplier quotes, backup supplier quotes, MOQ, lead time, pricing model output, and supply-risk review before the BOM/supplier evidence record is updated.

## Files

| File | Purpose |
| --- | --- |
| \`raw/bom.csv\` | Reward BOM input for the reward pricing analyzer |
| \`raw/supplier-quotes.csv\` | Quote index for primary and backup supplier files |
| \`raw/supplier-risk-review.csv\` | Supply, certification, pricing, and delivery risks |
| \`quotes/\` | Quote PDFs, screenshots, emails, or Feishu/Lark exports |
| \`reports/reward-pricing-report.json\` | Analyzer output from \`evidence:reward-pricing\` |
| \`reviews/supply-review.md\` | Human supply/pricing review |

## Analyzer

Replace template rows first, then run:

\`\`\`bash
${analyzerCommand}
\`\`\`

## Workflow

1. Fill \`raw/bom.csv\` with actual unit costs, primary suppliers, backup suppliers, quote status, MOQ, and lead time.
2. Put quote artifacts under \`${outDir}/quotes/\` or link external quote URLs in \`raw/supplier-quotes.csv\`.
3. Run the reward pricing analyzer.
4. Fill \`reviews/supply-review.md\` with the pricing, margin, lead-time, and downgrade decision.
5. Run \`npm run kickstarter:supplier-quote-audit\`.
6. Only after audit review, copy resolved paths into \`${bomTrackerPath}\` and rerun \`npm run kickstarter:ops-refresh\`.

## Non-Claims

- This intake package is not reward pricing approval.
- Estimated rows are not enough for public Kickstarter reward pricing.
- Public pricing requires confirmed quote coverage, backup supplier coverage, and a passing reward pricing report.
`;
}

function supplyReview() {
  return `# Supplier And Reward Pricing Review

Schema: \`inkloop.kickstarter_supplier_quote_review.v1\`

| Field | Value |
| --- | --- |
| Review date | TBD |
| Owner | TBD |
| BOM version | TBD |
| Reward SKU | starter_kit |
| Reward pricing report | reports/reward-pricing-report.json |
| Supplier quote folder | quotes/ |
| Decision | Not reviewed |

## Decision Checks

| Check | Decision | Evidence |
| --- | --- | --- |
| BOM >= 80% complete | TBD | TBD |
| Confirmed quote coverage >= 80% | TBD | TBD |
| Backup supplier coverage >= 80% | TBD | TBD |
| All reward prices have positive margin | TBD | TBD |
| MOQ and lead time are compatible with launch plan | TBD | TBD |
| Public reward price is approved or explicitly downgraded | TBD | TBD |
| Delivery/certification risks are disclosed | TBD | TBD |

## Notes

TBD
`;
}

function manifest({ outDir, generatedAt }) {
  return {
    schema: 'inkloop.kickstarter_supplier_quote_intake.v1',
    generated_at: generatedAt,
    out_dir: outDir,
    bom_tracker: bomTrackerPath,
    analyzer_command: `npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- ${outDir}/raw/bom.csv --out ${outDir}/reports/reward-pricing-report.json`,
    required_commands: [
      'npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- <intake>/raw/bom.csv --out <intake>/reports/reward-pricing-report.json',
      'npm run kickstarter:supplier-quote-audit',
      'npm run launch:evidence:audit',
      'npm run kickstarter:ops-refresh',
      'npm run kickstarter:launch-freeze-pack',
    ],
    non_claims: [
      'Supplier quote intake is not reward pricing approval.',
      'Estimated rows are not enough for public Kickstarter reward pricing.',
      'Public pricing requires confirmed quote coverage, backup supplier coverage, and a passing reward pricing report.',
    ],
  };
}

const { outDir } = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();

for (const dir of ['raw', 'quotes', 'reports', 'reviews', 'artifacts']) {
  mkdirSync(absolute(`${outDir}/${dir}`), { recursive: true });
}

write(`${outDir}/README.md`, readme({ outDir, generatedAt }));
write(`${outDir}/manifest.json`, JSON.stringify(manifest({ outDir, generatedAt }), null, 2));
write(`${outDir}/raw/bom.csv`, csv(bomRows));
write(`${outDir}/raw/supplier-quotes.csv`, csv(supplierQuoteRows));
write(`${outDir}/raw/supplier-risk-review.csv`, csv(riskRows));
write(`${outDir}/reviews/supply-review.md`, supplyReview());

console.log(`Kickstarter supplier quote intake package created: ${outDir}`);
console.log('BOM rows: 8');
console.log(`README: ${outDir}/README.md`);
