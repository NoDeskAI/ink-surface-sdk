import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const defaultBaseDir = 'test-results/ai-pen-kickstarter-supplier-quote-intake';
const outDir = 'test-results/ai-pen-kickstarter-supplier-quote-audit';
const outJsonPath = `${outDir}/report.json`;
const outReadmePath = `${outDir}/README.md`;
const strict = process.argv.includes('--strict');

const coreComponents = ['MCU / sensor module', 'Battery / charging', 'Shell / mechanical', 'A3 Capture Surface material', 'Starter Kit box', 'Assembly and QA'];

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
    /^0$/i.test(normalized) ||
    /^none$/i.test(normalized) ||
    /^n\/a$/i.test(normalized) ||
    /^not\s+(run|ready|reviewed|requested|available)$/i.test(normalized) ||
    /\bTBD\b|unknown|missing/i.test(normalized)
  );
}

function isApproved(value) {
  return /^(yes|true|pass|approved|conditional pass|conditional-pass|ready|reviewed)$/i.test(normalizeRef(value));
}

function isQuoted(value) {
  return /^(quoted|confirmed|approved)$/i.test(normalizeRef(value));
}

function positiveNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0;
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

function readOptionalJson(relativePath) {
  if (!existsSync(absolute(relativePath))) {
    return { present: false, parse_ok: false, data: null, error: `missing JSON: ${relativePath}` };
  }
  try {
    return { present: true, parse_ok: true, data: readJson(relativePath), error: null };
  } catch (error) {
    return { present: true, parse_ok: false, data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function evaluateBom(rows) {
  const requiredRows = rows.filter((row) => String(row.required).toLowerCase() !== 'false');
  const rowsWithCost = requiredRows.filter((row) => positiveNumber(row.unit_cost_usd));
  const quotedRows = requiredRows.filter((row) => isQuoted(row.quote_status) && !isPlaceholder(row.primary_supplier));
  const backupRows = requiredRows.filter((row) => !isPlaceholder(row.backup_supplier));
  const coreCoverage = coreComponents.map((component) => {
    const row = rows.find((candidate) => candidate.component === component);
    const ready =
      row &&
      positiveNumber(row.unit_cost_usd) &&
      isQuoted(row.quote_status) &&
      !isPlaceholder(row.primary_supplier) &&
      !isPlaceholder(row.backup_supplier) &&
      positiveNumber(row.lead_time_days);
    return {
      component,
      status: ready ? 'ready' : 'not_ready',
      blockers: ready
        ? []
        : [
            row ? null : 'missing BOM row',
            row && !positiveNumber(row.unit_cost_usd) ? 'unit_cost_usd is missing or zero' : null,
            row && !isQuoted(row.quote_status) ? 'quote_status is not quoted/confirmed' : null,
            row && isPlaceholder(row.primary_supplier) ? 'primary_supplier is missing' : null,
            row && isPlaceholder(row.backup_supplier) ? 'backup_supplier is missing' : null,
            row && !positiveNumber(row.lead_time_days) ? 'lead_time_days is missing or zero' : null,
          ].filter(Boolean),
    };
  });
  return {
    row_count: rows.length,
    required_row_count: requiredRows.length,
    required_rows_with_cost: rowsWithCost.length,
    quoted_required_rows: quotedRows.length,
    backup_required_rows: backupRows.length,
    bom_completeness_rate: requiredRows.length ? Number((rowsWithCost.length / requiredRows.length).toFixed(2)) : 0,
    quote_coverage_rate: requiredRows.length ? Number((quotedRows.length / requiredRows.length).toFixed(2)) : 0,
    backup_coverage_rate: requiredRows.length ? Number((backupRows.length / requiredRows.length).toFixed(2)) : 0,
    core_components_ready: coreCoverage.filter((item) => item.status === 'ready').length,
    core_components_total: coreCoverage.length,
    core_coverage: coreCoverage,
  };
}

function evaluateQuotes(rows, bomRows, intakeDir) {
  const requiredComponents = new Set(bomRows.filter((row) => String(row.required).toLowerCase() !== 'false').map((row) => row.component));
  const readyQuotes = rows.filter(
    (row) =>
      requiredComponents.has(row.component) &&
      ['primary', 'backup'].includes(String(row.supplier_role).toLowerCase()) &&
      !isPlaceholder(row.supplier_name) &&
      isQuoted(row.quote_status) &&
      isUsableArtifact(row.quote_path_or_url, intakeDir) &&
      positiveNumber(row.unit_cost_usd) &&
      positiveNumber(row.lead_time_days) &&
      !isPlaceholder(row.owner),
  );
  const componentRows = [...requiredComponents].map((component) => {
    const rowsForComponent = rows.filter((row) => row.component === component);
    const primaryReady = rowsForComponent.some((row) => String(row.supplier_role).toLowerCase() === 'primary' && readyQuotes.includes(row));
    const backupReady = rowsForComponent.some((row) => String(row.supplier_role).toLowerCase() === 'backup' && readyQuotes.includes(row));
    return {
      component,
      primary_ready: primaryReady,
      backup_ready: backupReady,
      status: primaryReady && backupReady ? 'ready' : 'not_ready',
      blockers: [
        primaryReady ? null : 'primary quote missing or unresolved',
        backupReady ? null : 'backup quote missing or unresolved',
      ].filter(Boolean),
    };
  });
  return {
    row_count: rows.length,
    ready_quote_count: readyQuotes.length,
    required_component_count: componentRows.length,
    components_with_primary_and_backup: componentRows.filter((row) => row.status === 'ready').length,
    component_rows: componentRows,
  };
}

function evaluateAnalyzer(reportSource) {
  const report = reportSource.data;
  const checks = report?.gate_checks ?? {};
  return {
    present: reportSource.present,
    parse_ok: reportSource.parse_ok,
    ok: report?.ok === true,
    bom_completeness_ge_80: checks.bom_completeness_ge_80 === true,
    confirmed_quote_coverage_ge_80: checks.confirmed_quote_coverage_ge_80 === true,
    backup_coverage_ge_80: checks.backup_coverage_ge_80 === true,
    supplier_backed_for_public_page: checks.supplier_backed_for_public_page === true,
    summary: report?.summary ?? null,
    error: reportSource.error,
  };
}

function reviewReady(relativePath) {
  if (!isNonEmptyFile(relativePath)) return false;
  const text = readFileSync(absolute(relativePath), 'utf8');
  const decisionLine = text.split(/\r?\n/).find((line) => /^\|\s*Decision\s*\|/i.test(line.trim()));
  return decisionLine ? isApproved(decisionLine.split('|').map((cell) => cell.trim())[2]) : false;
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

function buildNextRequiredInputs({ intakeDir, bom, quotes, analyzerReport, reviewPath, supplyReviewReady, csvErrors }) {
  const csvInputs = csvErrors.map((error) => ({
    id: `csv_${slug(error)}`,
    type: 'source_csv',
    owner: 'Ops / Hardware',
    required_input: `Fix the supplier quote intake source file: ${error}.`,
    evidence_target: `${intakeDir}/raw/`,
    source_label: 'source CSV',
    current_value: 'missing_or_invalid',
    blockers: [error],
    unlocks: ['supplier_quotes_ready'],
    next_command: 'npm run kickstarter:supplier-quote-audit',
    priority: 'P0',
  }));

  const bomInputs = (bom?.core_coverage ?? [])
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `bom_${slug(row.component)}`,
      type: 'bom_component',
      owner: 'Hardware / Ops',
      required_input: `Fill unit cost, quote status, primary supplier, backup supplier, and lead time for ${row.component}.`,
      evidence_target: `${intakeDir}/raw/bom.csv`,
      source_label: row.component,
      current_value: row.status,
      blockers: row.blockers,
      unlocks: ['bom_completeness_ge_80', 'supplier_quotes_ready'],
      next_command: 'npm run kickstarter:supplier-quote-audit',
      priority: 'P0',
    }));

  const quoteInputs = (quotes?.component_rows ?? [])
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      id: `quote_${slug(row.component)}`,
      type: 'supplier_quote',
      owner: 'Ops / Hardware',
      required_input: `Attach usable primary and backup quote artifacts with supplier, cost, lead time, status, and owner for ${row.component}.`,
      evidence_target: `${intakeDir}/raw/supplier-quotes.csv and ${intakeDir}/artifacts/`,
      source_label: row.component,
      current_value: `primary=${row.primary_ready ? 'ready' : 'missing'}; backup=${row.backup_ready ? 'ready' : 'missing'}`,
      blockers: row.blockers,
      unlocks: ['confirmed_quote_coverage_ge_80', 'backup_coverage_ge_80', 'supplier_quotes_ready'],
      next_command: 'npm run kickstarter:supplier-quote-audit',
      priority: 'P0',
    }));

  const analyzerInputs = [
    analyzerReport.present
      ? null
      : {
          id: 'reward_pricing_report',
          type: 'analyzer_report',
          owner: 'Ops / Finance',
          required_input: 'Run or attach the reward pricing analyzer report for the current BOM and supplier quote intake.',
          evidence_target: `${intakeDir}/reports/reward-pricing-report.json`,
          source_label: 'reward pricing analyzer report',
          current_value: 'missing',
          blockers: ['reward pricing analyzer report is missing'],
          unlocks: ['supplier_backed_for_public_page', 'supplier_quotes_ready'],
          next_command: `npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- ${intakeDir}/raw/bom.csv --out ${intakeDir}/reports/reward-pricing-report.json`,
          priority: 'P0',
        },
    analyzerReport.ok
      ? null
      : {
          id: 'reward_pricing_gate_ok',
          type: 'analyzer_gate',
          owner: 'Ops / Finance',
          required_input: 'Update BOM, quotes, and pricing assumptions until the reward pricing report ok gate passes.',
          evidence_target: `${intakeDir}/reports/reward-pricing-report.json`,
          source_label: 'reward pricing ok',
          current_value: String(analyzerReport.ok),
          blockers: [
            analyzerReport.confirmed_quote_coverage_ge_80 ? null : 'confirmed quote coverage gate is not passing',
            analyzerReport.backup_coverage_ge_80 ? null : 'backup coverage gate is not passing',
            analyzerReport.supplier_backed_for_public_page ? null : 'supplier_backed_for_public_page gate is not passing',
          ].filter(Boolean),
          unlocks: ['supplier_backed_for_public_page', 'launch_freeze_ready'],
          next_command: 'npm run kickstarter:supplier-quote-audit',
          priority: 'P0',
        },
  ].filter(Boolean);

  const reviewInput = supplyReviewReady
    ? []
    : [
        {
          id: 'human_supply_review',
          type: 'human_review',
          owner: 'Ops / Hardware / Founder',
          required_input: 'Record an approved/ready/reviewed human supply review decision after checking BOM, quotes, backup suppliers, pricing, and fulfillment risk.',
          evidence_target: reviewPath,
          source_label: 'supply review',
          current_value: 'not_ready',
          blockers: ['human supply review decision is not approved/ready/reviewed'],
          unlocks: ['supplier_quotes_ready', 'launch_freeze_ready'],
          next_command: 'npm run kickstarter:supplier-quote-audit',
          priority: 'P0',
        },
      ];

  return [...csvInputs, ...bomInputs, ...quoteInputs, ...analyzerInputs, ...reviewInput];
}

function emptyReport({ reason }) {
  const nextRequiredInputs = [
    {
      id: 'supplier_quote_intake',
      type: 'missing_source',
      owner: 'Ops / Hardware',
      required_input: `Create or restore a supplier quote intake package under ${defaultBaseDir}.`,
      evidence_target: defaultBaseDir,
      source_label: defaultBaseDir,
      current_value: 'missing',
      blockers: [reason],
      unlocks: ['supplier_quotes_ready'],
      next_command: 'npm run kickstarter:supplier-quote-intake',
      priority: 'P0',
    },
  ];
  return {
    schema: 'inkloop.kickstarter_supplier_quote_audit.v1',
    generated_at: new Date().toISOString(),
    strict,
    intake_dir: null,
    status: 'supplier_quotes_not_ready',
    summary: {
      bom_required_rows_with_cost: 0,
      bom_required_rows: 0,
      quoted_required_rows: 0,
      backup_required_rows: 0,
      ready_quote_count: 0,
      quote_row_count: 0,
      next_required_input_count: nextRequiredInputs.length,
      blocker_count: 1,
    },
    blockers: [reason],
    bom: null,
    quotes: null,
    analyzer: null,
    review_ready: false,
    next_required_inputs: nextRequiredInputs,
    non_claims: [
      'Supplier quote audit is not reward pricing approval.',
      'A ready audit still requires the BOM/supplier evidence record and launch evidence audit to be updated from reviewed paths.',
      'Template rows with TBD are intentionally rejected.',
    ],
  };
}

function readme(report) {
  const blockers = report.blockers.length ? report.blockers.map((blocker) => `- ${blocker}`).join('\n') : '- None';
  const coreRows = report.bom?.core_coverage?.length
    ? report.bom.core_coverage.map((row) => `| ${row.component} | ${row.status} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a |';
  const quoteRows = report.quotes?.component_rows?.length
    ? report.quotes.component_rows.map((row) => `| ${row.component} | ${row.primary_ready ? 'ready' : 'missing'} | ${row.backup_ready ? 'ready' : 'missing'} | ${row.blockers.join('; ') || 'none'} |`).join('\n')
    : '| n/a | n/a | n/a | n/a |';
  const nextRequiredRows = requiredInputRows(report.next_required_inputs ?? []);
  return `# InkLoop AI Pen Kickstarter Supplier Quote Audit

Schema: \`inkloop.kickstarter_supplier_quote_audit.v1\`

Generated at: ${report.generated_at}

Status: ${report.status}

Intake: \`${report.intake_dir ?? 'missing'}\`

This audit checks whether BOM rows, supplier quote artifacts, backup supplier coverage, and reward pricing analyzer output are ready to support Kickstarter reward pricing. It does not replace human pricing approval, launch evidence audit, or supplier contracts.

## Summary

| Item | Value |
| --- | --- |
| Required BOM rows with cost | ${report.summary.bom_required_rows_with_cost}/${report.summary.bom_required_rows} |
| Quoted required rows | ${report.summary.quoted_required_rows}/${report.summary.bom_required_rows} |
| Backup-covered required rows | ${report.summary.backup_required_rows}/${report.summary.bom_required_rows} |
| Ready quote rows | ${report.summary.ready_quote_count}/${report.summary.quote_row_count} |
| Reward pricing report ok | ${report.analyzer?.ok ?? false} |
| Supplier-backed public page | ${report.analyzer?.supplier_backed_for_public_page ?? false} |
| Human supply review ready | ${report.review_ready} |
| Next required inputs | ${report.summary.next_required_input_count} |

## Core BOM Coverage

| Component | Status | Blockers |
| --- | --- | --- |
${coreRows}

## Quote Coverage

| Component | Primary Quote | Backup Quote | Blockers |
| --- | --- | --- | --- |
${quoteRows}

## Next Required Inputs

| ID | Owner | Required Input | Evidence Target | Blockers | Next Command |
| --- | --- | --- | --- | --- | --- |
${nextRequiredRows}

## Blockers

${blockers}

## Non-Claims

- Passing this audit only means the supplier quote package is ready for evidence-record review.
- It does not approve a Kickstarter reward price.
- It does not replace supplier contracts, legal/privacy review, launch evidence audit strict mode, or human launch freeze signoff.

Detailed JSON: [report.json](./report.json)
`;
}

const options = parseArgs(process.argv.slice(2));
const intakeDir = options.intake ?? latestIntakeDir();
if (!intakeDir) {
  const report = emptyReport({ reason: `no supplier quote intake directory found under ${defaultBaseDir}` });
  mkdirSync(absolute(outDir), { recursive: true });
  writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absolute(outReadmePath), readme(report));
  console.log(`Kickstarter supplier quote audit status: ${report.status}`);
  console.log('BOM cost rows: 0/0');
  console.log('Ready quote rows: 0/0');
  console.log(`Report: ${outReadmePath}`);
  if (strict) {
    console.error('Strict Kickstarter supplier quote audit failed: no supplier quote intake package exists.');
    process.exit(1);
  }
  process.exit(0);
}

const manifestPath = `${intakeDir}/manifest.json`;
if (!existsSync(absolute(manifestPath))) {
  const report = { ...emptyReport({ reason: `missing supplier quote intake manifest: ${manifestPath}` }), intake_dir: intakeDir };
  mkdirSync(absolute(outDir), { recursive: true });
  writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(absolute(outReadmePath), readme(report));
  console.log(`Kickstarter supplier quote audit status: ${report.status}`);
  console.log('BOM cost rows: 0/0');
  console.log('Ready quote rows: 0/0');
  console.log(`Report: ${outReadmePath}`);
  if (strict) {
    console.error('Strict Kickstarter supplier quote audit failed: missing supplier quote intake manifest.');
    process.exit(1);
  }
  process.exit(0);
}

const bomCsv = readCsv(`${intakeDir}/raw/bom.csv`);
const quoteCsv = readCsv(`${intakeDir}/raw/supplier-quotes.csv`);
const analyzerReport = evaluateAnalyzer(readOptionalJson(`${intakeDir}/reports/reward-pricing-report.json`));
const bom = evaluateBom(bomCsv.rows);
const quotes = evaluateQuotes(quoteCsv.rows, bomCsv.rows, intakeDir);
const reviewPath = `${intakeDir}/reviews/supply-review.md`;
const supplyReviewReady = reviewReady(reviewPath);
const csvErrors = [bomCsv.error, quoteCsv.error].filter(Boolean);

const blockers = [
  ...csvErrors,
  bom.bom_completeness_rate >= 0.8 ? null : 'BOM completeness is below 80%',
  bom.quote_coverage_rate >= 0.8 ? null : 'quoted required-row coverage is below 80%',
  bom.backup_coverage_rate >= 0.8 ? null : 'backup supplier coverage is below 80%',
  bom.core_components_ready === bom.core_components_total ? null : 'core component BOM rows are incomplete',
  quotes.components_with_primary_and_backup === quotes.required_component_count ? null : 'not every required component has usable primary and backup quote artifacts',
  analyzerReport.present ? null : 'reward pricing analyzer report is missing',
  analyzerReport.parse_ok ? null : 'reward pricing analyzer report does not parse',
  analyzerReport.ok ? null : 'reward pricing analyzer report ok is not true',
  analyzerReport.confirmed_quote_coverage_ge_80 ? null : 'confirmed quote coverage gate is not passing',
  analyzerReport.backup_coverage_ge_80 ? null : 'backup coverage gate is not passing',
  analyzerReport.supplier_backed_for_public_page ? null : 'supplier_backed_for_public_page gate is not passing',
  supplyReviewReady ? null : 'human supply review decision is not approved/ready/reviewed',
].filter(Boolean);
const nextRequiredInputs = buildNextRequiredInputs({ intakeDir, bom, quotes, analyzerReport, reviewPath, supplyReviewReady, csvErrors });

const report = {
  schema: 'inkloop.kickstarter_supplier_quote_audit.v1',
  generated_at: new Date().toISOString(),
  strict,
  intake_dir: intakeDir,
  source_manifest: manifestPath,
  status: blockers.length === 0 ? 'supplier_quotes_ready' : 'supplier_quotes_not_ready',
  summary: {
    bom_required_rows_with_cost: bom.required_rows_with_cost,
    bom_required_rows: bom.required_row_count,
    quoted_required_rows: bom.quoted_required_rows,
    backup_required_rows: bom.backup_required_rows,
    ready_quote_count: quotes.ready_quote_count,
    quote_row_count: quotes.row_count,
    next_required_input_count: nextRequiredInputs.length,
    blocker_count: blockers.length,
  },
  blockers,
  bom,
  quotes,
  analyzer: analyzerReport,
  review_ready: supplyReviewReady,
  review_path: reviewPath,
  next_required_inputs: nextRequiredInputs,
  non_claims: [
    'Supplier quote audit is not reward pricing approval.',
    'A ready audit still requires the BOM/supplier evidence record and launch evidence audit to be updated from reviewed paths.',
    'Template rows with TBD are intentionally rejected.',
  ],
};

mkdirSync(absolute(outDir), { recursive: true });
writeFileSync(absolute(outJsonPath), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(absolute(outReadmePath), readme(report));

console.log(`Kickstarter supplier quote audit status: ${report.status}`);
console.log(`BOM cost rows: ${report.summary.bom_required_rows_with_cost}/${report.summary.bom_required_rows}`);
console.log(`Ready quote rows: ${report.summary.ready_quote_count}/${report.summary.quote_row_count}`);
console.log(`Supplier-backed public page: ${report.analyzer.supplier_backed_for_public_page}`);
console.log(`Next required inputs: ${report.summary.next_required_input_count}`);
console.log(`Report: ${outReadmePath}`);

if (strict && report.status !== 'supplier_quotes_ready') {
  console.error('Strict Kickstarter supplier quote audit failed: supplier quotes, backup coverage, pricing report, or supply review is incomplete.');
  process.exit(1);
}
