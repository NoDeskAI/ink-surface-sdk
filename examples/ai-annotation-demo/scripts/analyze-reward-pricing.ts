/**
 * Analyze Kickstarter reward pricing from BOM rows.
 *
 * Accepted input:
 * - CSV with one BOM line per reward/component
 * - JSON array of BOM rows
 * - wrappers shaped as { rows: [...] }, { bom_lines: [...] }, or { records: [...] }
 *
 * Usage:
 *   npm run evidence:reward-pricing -- fixtures/reward-pricing-sample.csv
 *   npm run evidence:reward-pricing -- /path/to/bom.csv --out /tmp/reward-pricing-report.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface InputRecord {
  line: number;
  fields: Record<string, unknown>;
}

interface ValidationIssueRecord {
  line: number;
  path: string;
  message: string;
}

interface BomLine {
  line: number;
  reward_sku: string;
  category: string;
  component: string;
  required: boolean;
  quantity_per_reward: number;
  unit_cost_usd: number;
  primary_supplier?: string;
  backup_supplier?: string;
  quote_status: string;
  confidence?: string;
  lead_time_days?: number;
  moq?: number;
  risk?: string;
  extended_cost_usd: number;
}

interface PricingAssumptions {
  target_margin_rate: number;
  platform_fee_rate: number;
  payment_fee_rate: number;
  pledge_manager_fee_rate: number;
  duty_tax_buffer_rate: number;
  warranty_buffer_rate: number;
  contingency_rate: number;
  round_to_usd: number;
}

interface RewardSummary {
  reward_sku: string;
  line_count: number;
  required_line_count: number;
  required_lines_with_cost: number;
  bom_completeness_rate: number;
  quote_coverage_rate: number;
  backup_coverage_rate: number;
  max_lead_time_days: number;
  base_unit_cost_usd: number;
  buffer_cost_usd: number;
  landed_unit_cost_usd: number;
  minimum_pledge_price_usd: number;
  rounded_minimum_pledge_price_usd: number;
  expected_net_after_fees_usd: number;
  expected_margin_usd: number;
  expected_margin_rate: number;
  top_cost_categories: Array<{ category: string; cost_usd: number }>;
  open_risks: string[];
}

interface AnalyzerReport {
  ok: boolean;
  input: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  validation_issues: ValidationIssueRecord[];
  assumptions: PricingAssumptions;
  summary: {
    reward_skus: string[];
    total_required_lines: number;
    required_lines_with_cost: number;
    bom_completeness_rate: number;
    quote_coverage_rate: number;
    confirmed_quote_coverage_rate: number;
    backup_coverage_rate: number;
    max_lead_time_days: number;
    rewards: RewardSummary[];
  };
  gate_checks: {
    schema_pass_rate: number;
    bom_completeness_ge_80: boolean;
    quote_coverage_ge_80: boolean;
    confirmed_quote_coverage_ge_80: boolean;
    backup_coverage_ge_80: boolean;
    all_rewards_have_positive_price: boolean;
    pricing_model_has_required_inputs: boolean;
    supplier_backed_for_public_page: boolean;
  };
}

const defaultAssumptions: PricingAssumptions = {
  target_margin_rate: 0.35,
  platform_fee_rate: 0.05,
  payment_fee_rate: 0.04,
  pledge_manager_fee_rate: 0.02,
  duty_tax_buffer_rate: 0.08,
  warranty_buffer_rate: 0.08,
  contingency_rate: 0.12,
  round_to_usd: 5,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseRate(value: string, name: keyof PricingAssumptions): number {
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed >= 0 && parsed < 1, `${name} must be a decimal rate between 0 and 1`);
  return parsed;
}

function parsePositiveNumber(value: string, name: keyof PricingAssumptions): number {
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed > 0, `${name} must be a positive number`);
  return parsed;
}

function parseArgs(argv: string[]): { input: string; out?: string; assumptions: PricingAssumptions } {
  const args = [...argv];
  const input = args.shift();
  assert(input, 'usage: analyze-reward-pricing.ts <bom.csv|bom.json> [--out report.json]');
  let out: string | undefined;
  const assumptions = { ...defaultAssumptions };
  while (args.length > 0) {
    const arg = args.shift();
    const value = args.shift();
    assert(value, `${arg} requires a value`);
    if (arg === '--out') {
      out = value;
    } else if (arg === '--target-margin') {
      assumptions.target_margin_rate = parseRate(value, 'target_margin_rate');
    } else if (arg === '--platform-fee') {
      assumptions.platform_fee_rate = parseRate(value, 'platform_fee_rate');
    } else if (arg === '--payment-fee') {
      assumptions.payment_fee_rate = parseRate(value, 'payment_fee_rate');
    } else if (arg === '--pledge-manager-fee') {
      assumptions.pledge_manager_fee_rate = parseRate(value, 'pledge_manager_fee_rate');
    } else if (arg === '--duty-tax-buffer') {
      assumptions.duty_tax_buffer_rate = parseRate(value, 'duty_tax_buffer_rate');
    } else if (arg === '--warranty-buffer') {
      assumptions.warranty_buffer_rate = parseRate(value, 'warranty_buffer_rate');
    } else if (arg === '--contingency') {
      assumptions.contingency_rate = parseRate(value, 'contingency_rate');
    } else if (arg === '--round-to') {
      assumptions.round_to_usd = parsePositiveNumber(value, 'round_to_usd');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { input: resolve(input), out: out ? resolve(out) : undefined, assumptions };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function parseCsvRecords(text: string): InputRecord[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((row, index) => {
    const fields: Record<string, unknown> = {};
    headers.forEach((header, headerIndex) => {
      fields[header] = row[headerIndex]?.trim() ?? '';
    });
    return { line: index + 2, fields };
  });
}

function unwrapJsonRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const wrapped = record.rows ?? record.bom_lines ?? record.records;
  return Array.isArray(wrapped) ? wrapped : [];
}

function parseRecords(text: string): InputRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const rows = unwrapJsonRows(JSON.parse(trimmed));
    return rows.map((value, index) => ({
      line: index + 1,
      fields: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    }));
  }
  return parseCsvRecords(text);
}

function unique(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))].sort();
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function readString(fields: Record<string, unknown>, field: string): string {
  return String(fields[field] ?? '').trim();
}

function readNumber(fields: Record<string, unknown>, field: string): number | null {
  const value = fields[field];
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function readBoolean(fields: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const raw = readString(fields, field).toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'required';
}

function validateRecord(record: InputRecord): { value?: BomLine; issues: ValidationIssueRecord[] } {
  const issues: ValidationIssueRecord[] = [];
  const requireString = (field: string): string => {
    const value = readString(record.fields, field);
    if (!value) issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required string is missing' });
    return value;
  };
  const requireNumber = (field: string): number => {
    const value = readNumber(record.fields, field);
    if (value === null || value < 0) {
      issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required non-negative number is missing' });
      return 0;
    }
    return value;
  };

  const rewardSku = requireString('reward_sku');
  const category = requireString('category');
  const component = requireString('component');
  const quantity = requireNumber('quantity_per_reward');
  const unitCost = requireNumber('unit_cost_usd');
  const quoteStatus = readString(record.fields, 'quote_status') || 'unknown';
  const leadTime = readNumber(record.fields, 'lead_time_days');
  const moq = readNumber(record.fields, 'moq');
  if (quantity <= 0) {
    issues.push({ line: record.line, path: `rows.${record.line}.quantity_per_reward`, message: 'quantity_per_reward must be greater than 0' });
  }
  if (issues.length > 0) return { issues };

  return {
    issues,
    value: {
      line: record.line,
      reward_sku: rewardSku,
      category,
      component,
      required: readBoolean(record.fields, 'required', true),
      quantity_per_reward: quantity,
      unit_cost_usd: unitCost,
      primary_supplier: readString(record.fields, 'primary_supplier') || undefined,
      backup_supplier: readString(record.fields, 'backup_supplier') || undefined,
      quote_status: quoteStatus.trim().toLowerCase(),
      confidence: readString(record.fields, 'confidence') || undefined,
      lead_time_days: leadTime ?? undefined,
      moq: moq ?? undefined,
      risk: readString(record.fields, 'risk') || undefined,
      extended_cost_usd: quantity * unitCost,
    },
  };
}

function groupBySku(lines: BomLine[]): Map<string, BomLine[]> {
  const groups = new Map<string, BomLine[]>();
  for (const line of lines) {
    const current = groups.get(line.reward_sku) ?? [];
    current.push(line);
    groups.set(line.reward_sku, current);
  }
  return groups;
}

function coverageRate(lines: BomLine[], predicate: (line: BomLine) => boolean): number {
  const required = lines.filter((line) => line.required);
  if (required.length === 0) return 0;
  return round(required.filter(predicate).length / required.length);
}

function roundedPrice(price: number, roundTo: number): number {
  return Math.ceil(price / roundTo) * roundTo;
}

function categoryRollup(lines: BomLine[]): Array<{ category: string; cost_usd: number }> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line.category, (map.get(line.category) ?? 0) + line.extended_cost_usd);
  return [...map.entries()]
    .map(([category, cost]) => ({ category, cost_usd: round(cost) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

function summarizeReward(rewardSku: string, lines: BomLine[], assumptions: PricingAssumptions): RewardSummary {
  const requiredLines = lines.filter((line) => line.required);
  const baseCost = lines.reduce((sum, line) => sum + line.extended_cost_usd, 0);
  const bufferRate = assumptions.duty_tax_buffer_rate + assumptions.warranty_buffer_rate + assumptions.contingency_rate;
  const bufferCost = baseCost * bufferRate;
  const landedCost = baseCost + bufferCost;
  const feeRate = assumptions.platform_fee_rate + assumptions.payment_fee_rate + assumptions.pledge_manager_fee_rate;
  const denominator = (1 - feeRate) * (1 - assumptions.target_margin_rate);
  const minimumPrice = denominator > 0 ? landedCost / denominator : 0;
  const roundedMinimum = roundedPrice(minimumPrice, assumptions.round_to_usd);
  const netAfterFees = roundedMinimum * (1 - feeRate);
  const margin = netAfterFees - landedCost;

  return {
    reward_sku: rewardSku,
    line_count: lines.length,
    required_line_count: requiredLines.length,
    required_lines_with_cost: requiredLines.filter((line) => line.unit_cost_usd > 0).length,
    bom_completeness_rate: coverageRate(lines, (line) => line.unit_cost_usd > 0),
    quote_coverage_rate: coverageRate(lines, (line) => line.quote_status === 'quoted' || line.quote_status === 'estimated'),
    backup_coverage_rate: coverageRate(lines, (line) => Boolean(line.backup_supplier)),
    max_lead_time_days: Math.max(0, ...lines.map((line) => line.lead_time_days ?? 0)),
    base_unit_cost_usd: round(baseCost),
    buffer_cost_usd: round(bufferCost),
    landed_unit_cost_usd: round(landedCost),
    minimum_pledge_price_usd: round(minimumPrice),
    rounded_minimum_pledge_price_usd: round(roundedMinimum),
    expected_net_after_fees_usd: round(netAfterFees),
    expected_margin_usd: round(margin),
    expected_margin_rate: netAfterFees > 0 ? round(margin / netAfterFees) : 0,
    top_cost_categories: categoryRollup(lines).slice(0, 5),
    open_risks: unique(lines.map((line) => line.risk)).filter((risk) => risk.toLowerCase() !== 'none'),
  };
}

function analyze(input: string, records: InputRecord[], assumptions: PricingAssumptions): AnalyzerReport {
  const validationIssues: ValidationIssueRecord[] = [];
  const validLines: BomLine[] = [];
  for (const record of records) {
    const result = validateRecord(record);
    validationIssues.push(...result.issues);
    if (result.value) validLines.push(result.value);
  }

  const rewards = [...groupBySku(validLines).entries()]
    .map(([rewardSku, lines]) => summarizeReward(rewardSku, lines, assumptions))
    .sort((a, b) => a.reward_sku.localeCompare(b.reward_sku));
  const requiredLines = validLines.filter((line) => line.required);
  const bomCompleteness = coverageRate(validLines, (line) => line.unit_cost_usd > 0);
  const quoteCoverage = coverageRate(validLines, (line) => line.quote_status === 'quoted' || line.quote_status === 'estimated');
  const confirmedQuoteCoverage = coverageRate(validLines, (line) => line.quote_status === 'quoted');
  const backupCoverage = coverageRate(validLines, (line) => Boolean(line.backup_supplier));
  const allRewardsHavePrice = rewards.length > 0 && rewards.every((reward) => reward.rounded_minimum_pledge_price_usd > 0);
  const pricingModelHasInputs = bomCompleteness >= 0.8 && quoteCoverage >= 0.8 && backupCoverage >= 0.8 && allRewardsHavePrice;
  const supplierBackedForPublicPage = pricingModelHasInputs && confirmedQuoteCoverage >= 0.8;

  return {
    ok: validationIssues.length === 0 && pricingModelHasInputs,
    input,
    row_count: records.length,
    valid_row_count: validLines.length,
    invalid_row_count: records.length - validLines.length,
    validation_issues: validationIssues,
    assumptions,
    summary: {
      reward_skus: unique(validLines.map((line) => line.reward_sku)),
      total_required_lines: requiredLines.length,
      required_lines_with_cost: requiredLines.filter((line) => line.unit_cost_usd > 0).length,
      bom_completeness_rate: bomCompleteness,
      quote_coverage_rate: quoteCoverage,
      confirmed_quote_coverage_rate: confirmedQuoteCoverage,
      backup_coverage_rate: backupCoverage,
      max_lead_time_days: Math.max(0, ...validLines.map((line) => line.lead_time_days ?? 0)),
      rewards,
    },
    gate_checks: {
      schema_pass_rate: records.length ? round(validLines.length / records.length) : 0,
      bom_completeness_ge_80: bomCompleteness >= 0.8,
      quote_coverage_ge_80: quoteCoverage >= 0.8,
      confirmed_quote_coverage_ge_80: confirmedQuoteCoverage >= 0.8,
      backup_coverage_ge_80: backupCoverage >= 0.8,
      all_rewards_have_positive_price: allRewardsHavePrice,
      pricing_model_has_required_inputs: pricingModelHasInputs,
      supplier_backed_for_public_page: supplierBackedForPublicPage,
    },
  };
}

async function main(): Promise<void> {
  const { input, out, assumptions } = parseArgs(process.argv.slice(2));
  const records = parseRecords(await readFile(input, 'utf8'));
  const report = analyze(input, records, assumptions);
  const json = JSON.stringify(report, null, 2);
  if (out) await writeFile(out, `${json}\n`, 'utf8');
  console.log(json);
  if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
