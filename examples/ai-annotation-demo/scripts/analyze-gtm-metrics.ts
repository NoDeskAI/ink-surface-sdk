/**
 * Analyze Kickstarter pre-launch GTM metrics.
 *
 * Accepted input:
 * - CSV with one weekly snapshot per row
 * - JSON array of weekly snapshots
 * - wrappers shaped as { rows: [...] }, { snapshots: [...] }, or { records: [...] }
 *
 * Usage:
 *   npm run evidence:gtm-metrics -- fixtures/gtm-metrics-sample.csv
 *   npm run evidence:gtm-metrics -- /path/to/gtm-snapshots.csv --out /tmp/gtm-report.json
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

interface GtmSnapshot {
  line: number;
  week_ending: string;
  email_list: number;
  ks_followers: number;
  testimonials: number;
  first_day_likely_backers: number;
  education_leads: number;
  business_leads: number;
  source_export_link?: string;
  decision?: string;
}

interface GtmTargets {
  checkpoint_email_list: number;
  checkpoint_ks_followers: number;
  launch_email_list: number;
  launch_ks_followers: number;
  launch_testimonials: number;
  launch_first_day_likely_backers: number;
}

interface DeltaSummary {
  email_list_delta: number;
  ks_followers_delta: number;
  testimonials_delta: number;
  first_day_likely_backers_delta: number;
  education_leads_delta: number;
  business_leads_delta: number;
}

interface ProgressSummary {
  email_list_progress_to_launch: number;
  ks_followers_progress_to_launch: number;
  testimonials_progress_to_launch: number;
  first_day_backers_progress_to_launch: number;
  stronger_segment: 'education' | 'business' | 'tie' | 'none';
  education_share: number;
  business_share: number;
}

interface AnalyzerReport {
  ok: boolean;
  input: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  validation_issues: ValidationIssueRecord[];
  targets: GtmTargets;
  summary: {
    latest_snapshot: GtmSnapshot | null;
    previous_snapshot: GtmSnapshot | null;
    weeks_tracked: number;
    latest_week_over_week_delta: DeltaSummary | null;
    progress: ProgressSummary | null;
  };
  gate_checks: {
    schema_pass_rate: number;
    gtm_model_has_required_inputs: boolean;
    checkpoint_email_ge_500: boolean | null;
    checkpoint_ks_followers_ge_150: boolean | null;
    launch_email_ge_1000: boolean | null;
    launch_ks_followers_ge_300: boolean | null;
    testimonials_ge_8: boolean | null;
    first_day_likely_backers_ge_50: boolean | null;
    has_education_and_business_leads: boolean | null;
    launch_demand_ready: boolean | null;
  };
}

const defaultTargets: GtmTargets = {
  checkpoint_email_list: 500,
  checkpoint_ks_followers: 150,
  launch_email_list: 1000,
  launch_ks_followers: 300,
  launch_testimonials: 8,
  launch_first_day_likely_backers: 50,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseTarget(value: string, name: keyof GtmTargets): number {
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed >= 0, `${name} must be a non-negative number`);
  return parsed;
}

function parseArgs(argv: string[]): { input: string; out?: string; targets: GtmTargets } {
  const args = [...argv];
  const input = args.shift();
  assert(input, 'usage: analyze-gtm-metrics.ts <gtm.csv|gtm.json> [--out report.json]');
  let out: string | undefined;
  const targets = { ...defaultTargets };
  while (args.length > 0) {
    const arg = args.shift();
    const value = args.shift();
    assert(value, `${arg} requires a value`);
    if (arg === '--out') {
      out = value;
    } else if (arg === '--checkpoint-email') {
      targets.checkpoint_email_list = parseTarget(value, 'checkpoint_email_list');
    } else if (arg === '--checkpoint-ks-followers') {
      targets.checkpoint_ks_followers = parseTarget(value, 'checkpoint_ks_followers');
    } else if (arg === '--launch-email') {
      targets.launch_email_list = parseTarget(value, 'launch_email_list');
    } else if (arg === '--launch-ks-followers') {
      targets.launch_ks_followers = parseTarget(value, 'launch_ks_followers');
    } else if (arg === '--launch-testimonials') {
      targets.launch_testimonials = parseTarget(value, 'launch_testimonials');
    } else if (arg === '--launch-first-day-backers') {
      targets.launch_first_day_likely_backers = parseTarget(value, 'launch_first_day_likely_backers');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { input: resolve(input), out: out ? resolve(out) : undefined, targets };
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
  const wrapped = record.rows ?? record.snapshots ?? record.records;
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

function readString(fields: Record<string, unknown>, field: string): string {
  return String(fields[field] ?? '').trim();
}

function readNumber(fields: Record<string, unknown>, field: string): number | null {
  const value = fields[field];
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function requireNumber(record: InputRecord, issues: ValidationIssueRecord[], field: string): number {
  const value = readNumber(record.fields, field);
  if (value === null || value < 0) {
    issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required non-negative number is missing' });
    return 0;
  }
  return value;
}

function validateRecord(record: InputRecord): { value?: GtmSnapshot; issues: ValidationIssueRecord[] } {
  const issues: ValidationIssueRecord[] = [];
  const weekEnding = readString(record.fields, 'week_ending');
  if (!weekEnding) {
    issues.push({ line: record.line, path: `rows.${record.line}.week_ending`, message: 'required string is missing' });
  }
  const snapshot = {
    line: record.line,
    week_ending: weekEnding,
    email_list: requireNumber(record, issues, 'email_list'),
    ks_followers: requireNumber(record, issues, 'ks_followers'),
    testimonials: requireNumber(record, issues, 'testimonials'),
    first_day_likely_backers: requireNumber(record, issues, 'first_day_likely_backers'),
    education_leads: requireNumber(record, issues, 'education_leads'),
    business_leads: requireNumber(record, issues, 'business_leads'),
    source_export_link: readString(record.fields, 'source_export_link') || undefined,
    decision: readString(record.fields, 'decision') || undefined,
  };
  return issues.length > 0 ? { issues } : { issues, value: snapshot };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function progress(value: number, target: number): number {
  if (target <= 0) return 0;
  return round(Math.min(value / target, 1));
}

function latestSnapshots(snapshots: GtmSnapshot[]): { latest: GtmSnapshot | null; previous: GtmSnapshot | null } {
  const sorted = [...snapshots].sort((a, b) => a.week_ending.localeCompare(b.week_ending));
  return {
    latest: sorted[sorted.length - 1] ?? null,
    previous: sorted[sorted.length - 2] ?? null,
  };
}

function delta(latest: GtmSnapshot, previous: GtmSnapshot): DeltaSummary {
  return {
    email_list_delta: latest.email_list - previous.email_list,
    ks_followers_delta: latest.ks_followers - previous.ks_followers,
    testimonials_delta: latest.testimonials - previous.testimonials,
    first_day_likely_backers_delta: latest.first_day_likely_backers - previous.first_day_likely_backers,
    education_leads_delta: latest.education_leads - previous.education_leads,
    business_leads_delta: latest.business_leads - previous.business_leads,
  };
}

function progressSummary(latest: GtmSnapshot, targets: GtmTargets): ProgressSummary {
  const totalSegmentLeads = latest.education_leads + latest.business_leads;
  let strongerSegment: ProgressSummary['stronger_segment'] = 'none';
  if (latest.education_leads > latest.business_leads) strongerSegment = 'education';
  else if (latest.business_leads > latest.education_leads) strongerSegment = 'business';
  else if (totalSegmentLeads > 0) strongerSegment = 'tie';
  return {
    email_list_progress_to_launch: progress(latest.email_list, targets.launch_email_list),
    ks_followers_progress_to_launch: progress(latest.ks_followers, targets.launch_ks_followers),
    testimonials_progress_to_launch: progress(latest.testimonials, targets.launch_testimonials),
    first_day_backers_progress_to_launch: progress(latest.first_day_likely_backers, targets.launch_first_day_likely_backers),
    stronger_segment: strongerSegment,
    education_share: totalSegmentLeads > 0 ? round(latest.education_leads / totalSegmentLeads) : 0,
    business_share: totalSegmentLeads > 0 ? round(latest.business_leads / totalSegmentLeads) : 0,
  };
}

function analyze(input: string, records: InputRecord[], targets: GtmTargets): AnalyzerReport {
  const validationIssues: ValidationIssueRecord[] = [];
  const snapshots: GtmSnapshot[] = [];
  for (const record of records) {
    const result = validateRecord(record);
    validationIssues.push(...result.issues);
    if (result.value) snapshots.push(result.value);
  }

  const { latest, previous } = latestSnapshots(snapshots);
  const launchDemandReady = latest
    ? latest.email_list >= targets.launch_email_list &&
      latest.ks_followers >= targets.launch_ks_followers &&
      latest.testimonials >= targets.launch_testimonials &&
      latest.first_day_likely_backers >= targets.launch_first_day_likely_backers
    : null;

  return {
    ok: validationIssues.length === 0 && snapshots.length > 0,
    input,
    row_count: records.length,
    valid_row_count: snapshots.length,
    invalid_row_count: records.length - snapshots.length,
    validation_issues: validationIssues,
    targets,
    summary: {
      latest_snapshot: latest,
      previous_snapshot: previous,
      weeks_tracked: snapshots.length,
      latest_week_over_week_delta: latest && previous ? delta(latest, previous) : null,
      progress: latest ? progressSummary(latest, targets) : null,
    },
    gate_checks: {
      schema_pass_rate: records.length ? round(snapshots.length / records.length) : 0,
      gtm_model_has_required_inputs: snapshots.length > 0,
      checkpoint_email_ge_500: latest ? latest.email_list >= targets.checkpoint_email_list : null,
      checkpoint_ks_followers_ge_150: latest ? latest.ks_followers >= targets.checkpoint_ks_followers : null,
      launch_email_ge_1000: latest ? latest.email_list >= targets.launch_email_list : null,
      launch_ks_followers_ge_300: latest ? latest.ks_followers >= targets.launch_ks_followers : null,
      testimonials_ge_8: latest ? latest.testimonials >= targets.launch_testimonials : null,
      first_day_likely_backers_ge_50: latest ? latest.first_day_likely_backers >= targets.launch_first_day_likely_backers : null,
      has_education_and_business_leads: latest ? latest.education_leads > 0 && latest.business_leads > 0 : null,
      launch_demand_ready: launchDemandReady,
    },
  };
}

async function main(): Promise<void> {
  const { input, out, targets } = parseArgs(process.argv.slice(2));
  const records = parseRecords(await readFile(input, 'utf8'));
  const report = analyze(input, records, targets);
  const json = JSON.stringify(report, null, 2);
  if (out) await writeFile(out, `${json}\n`, 'utf8');
  console.log(json);
  if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
