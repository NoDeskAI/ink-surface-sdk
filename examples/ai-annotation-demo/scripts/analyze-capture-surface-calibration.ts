/**
 * Analyze Capture Surface calibration measurements.
 *
 * Accepted input:
 * - CSV with one measured point per row
 * - JSON array of point records
 * - JSON wrappers shaped as { records: [...] }, { measurements: [...] }, or { calibration_records: [...] }
 *
 * Usage:
 *   npm run evidence:capture-surface -- fixtures/capture-surface-calibration-sample.csv
 *   npm run evidence:capture-surface -- /path/to/calibration.csv --out /tmp/capture-surface-report.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Region = 'center' | 'edge' | 'corner' | 'unknown';

interface InputRecord {
  line: number;
  fields: Record<string, unknown>;
}

interface ValidationIssueRecord {
  line: number;
  path: string;
  message: string;
}

interface CalibrationRecord {
  line: number;
  run_id: string;
  surface_id: string;
  surface_size: string;
  point_id: string;
  region: Region;
  expected_x_mm: number;
  expected_y_mm: number;
  observed_x_mm: number;
  observed_y_mm: number;
  lighting?: string;
  condition?: string;
  error_mm: number;
}

interface ErrorStats {
  count: number;
  p50_mm: number;
  p95_mm: number;
  max_mm: number;
  mean_mm: number;
}

interface SessionSummary extends ErrorStats {
  run_id: string;
  surface_ids: string[];
  surface_sizes: string[];
  stable: boolean;
}

interface AnalyzerReport {
  ok: boolean;
  input: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  validation_issues: ValidationIssueRecord[];
  summary: {
    run_ids: string[];
    surface_ids: string[];
    surface_sizes: string[];
    regions: Region[];
    lighting_conditions: string[];
    condition_tags: string[];
    error_mm: ErrorStats;
    region_error_mm: Partial<Record<Region, ErrorStats>>;
    sessions: SessionSummary[];
    total_sessions: number;
    stable_sessions: number;
    stability_rate: number;
  };
  gate_checks: {
    schema_pass_rate: number;
    p95_error_le_5mm: boolean;
    stability_rate_ge_95: boolean;
    has_edge_or_corner_points: boolean;
    has_a2_or_a3_surface: boolean;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): { input: string; out?: string } {
  const args = [...argv];
  const input = args.shift();
  assert(input, 'usage: analyze-capture-surface-calibration.ts <calibration.csv|calibration.json> [--out report.json]');
  let out: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--out') {
      out = args.shift();
      assert(out, '--out requires a path');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { input: resolve(input), out: out ? resolve(out) : undefined };
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
  const wrapped = record.records ?? record.measurements ?? record.calibration_records;
  return Array.isArray(wrapped) ? wrapped : [];
}

function parseRecords(text: string): InputRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return unwrapJsonRows(JSON.parse(trimmed)).map((value, index) => ({
      line: index + 1,
      fields: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    }));
  }
  return parseCsvRecords(text);
}

function unique(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))].sort();
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function errorStats(records: CalibrationRecord[]): ErrorStats {
  const errors = records.map((record) => record.error_mm);
  const total = errors.reduce((sum, value) => sum + value, 0);
  return {
    count: errors.length,
    p50_mm: round(percentile(errors, 0.5)),
    p95_mm: round(percentile(errors, 0.95)),
    max_mm: round(errors.length ? Math.max(...errors) : 0),
    mean_mm: round(errors.length ? total / errors.length : 0),
  };
}

function groupByRun(records: CalibrationRecord[]): Map<string, CalibrationRecord[]> {
  const groups = new Map<string, CalibrationRecord[]>();
  for (const record of records) {
    const current = groups.get(record.run_id) ?? [];
    current.push(record);
    groups.set(record.run_id, current);
  }
  return groups;
}

function normalizeRegion(value: unknown): Region | null {
  const region = String(value ?? 'unknown').trim().toLowerCase();
  if (region === '') return 'unknown';
  if (region === 'center' || region === 'edge' || region === 'corner' || region === 'unknown') return region;
  return null;
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

function validateRecord(record: InputRecord): { value?: CalibrationRecord; issues: ValidationIssueRecord[] } {
  const issues: ValidationIssueRecord[] = [];
  const requireString = (field: string): string => {
    const value = readString(record.fields, field);
    if (!value) issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required string is missing' });
    return value;
  };
  const requireNumber = (field: string): number => {
    const value = readNumber(record.fields, field);
    if (value === null) {
      issues.push({ line: record.line, path: `rows.${record.line}.${field}`, message: 'required finite number is missing' });
      return 0;
    }
    return value;
  };

  const region = normalizeRegion(record.fields.region);
  if (region === null) {
    issues.push({
      line: record.line,
      path: `rows.${record.line}.region`,
      message: 'region must be center, edge, corner, or unknown',
    });
  }

  const runId = requireString('run_id');
  const surfaceId = requireString('surface_id');
  const surfaceSize = requireString('surface_size');
  const pointId = requireString('point_id');
  const expectedX = requireNumber('expected_x_mm');
  const expectedY = requireNumber('expected_y_mm');
  const observedX = requireNumber('observed_x_mm');
  const observedY = requireNumber('observed_y_mm');
  if (issues.length > 0 || !region) return { issues };

  const error = Math.hypot(observedX - expectedX, observedY - expectedY);
  return {
    issues,
    value: {
      line: record.line,
      run_id: runId,
      surface_id: surfaceId,
      surface_size: surfaceSize,
      point_id: pointId,
      region,
      expected_x_mm: expectedX,
      expected_y_mm: expectedY,
      observed_x_mm: observedX,
      observed_y_mm: observedY,
      lighting: readString(record.fields, 'lighting') || undefined,
      condition: readString(record.fields, 'condition') || undefined,
      error_mm: error,
    },
  };
}

function sessionSummaries(records: CalibrationRecord[]): SessionSummary[] {
  return [...groupByRun(records).entries()]
    .map(([runId, runRecords]) => {
      const stats = errorStats(runRecords);
      return {
        run_id: runId,
        surface_ids: unique(runRecords.map((record) => record.surface_id)),
        surface_sizes: unique(runRecords.map((record) => record.surface_size)),
        stable: stats.p95_mm <= 5,
        ...stats,
      };
    })
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
}

function regionStats(records: CalibrationRecord[]): Partial<Record<Region, ErrorStats>> {
  const stats: Partial<Record<Region, ErrorStats>> = {};
  for (const region of ['center', 'edge', 'corner', 'unknown'] as const) {
    const regionRecords = records.filter((record) => record.region === region);
    if (regionRecords.length > 0) stats[region] = errorStats(regionRecords);
  }
  return stats;
}

function analyze(input: string, records: InputRecord[]): AnalyzerReport {
  const validationIssues: ValidationIssueRecord[] = [];
  const validRecords: CalibrationRecord[] = [];
  for (const record of records) {
    const result = validateRecord(record);
    validationIssues.push(...result.issues);
    if (result.value) validRecords.push(result.value);
  }

  const sessions = sessionSummaries(validRecords);
  const stableSessions = sessions.filter((session) => session.stable).length;
  const stabilityRate = sessions.length ? round(stableSessions / sessions.length) : 0;
  const overallStats = errorStats(validRecords);
  const regions = [...new Set(validRecords.map((record) => record.region))].sort() as Region[];
  const surfaceSizes = unique(validRecords.map((record) => record.surface_size));
  const hasEdgeOrCorner = validRecords.some((record) => record.region === 'edge' || record.region === 'corner');
  const hasA2OrA3 = surfaceSizes.some((size) => size.toLowerCase() === 'a2' || size.toLowerCase() === 'a3');
  const p95Pass = validRecords.length > 0 && overallStats.p95_mm <= 5;
  const stabilityPass = sessions.length > 0 && stabilityRate >= 0.95;

  return {
    ok: validationIssues.length === 0 && p95Pass && stabilityPass && hasEdgeOrCorner && hasA2OrA3,
    input,
    row_count: records.length,
    valid_row_count: validRecords.length,
    invalid_row_count: records.length - validRecords.length,
    validation_issues: validationIssues,
    summary: {
      run_ids: unique(validRecords.map((record) => record.run_id)),
      surface_ids: unique(validRecords.map((record) => record.surface_id)),
      surface_sizes: surfaceSizes,
      regions,
      lighting_conditions: unique(validRecords.map((record) => record.lighting)),
      condition_tags: unique(validRecords.map((record) => record.condition)),
      error_mm: overallStats,
      region_error_mm: regionStats(validRecords),
      sessions,
      total_sessions: sessions.length,
      stable_sessions: stableSessions,
      stability_rate: stabilityRate,
    },
    gate_checks: {
      schema_pass_rate: records.length ? round(validRecords.length / records.length) : 0,
      p95_error_le_5mm: p95Pass,
      stability_rate_ge_95: stabilityPass,
      has_edge_or_corner_points: hasEdgeOrCorner,
      has_a2_or_a3_surface: hasA2OrA3,
    },
  };
}

async function main(): Promise<void> {
  const { input, out } = parseArgs(process.argv.slice(2));
  const records = parseRecords(await readFile(input, 'utf8'));
  const report = analyze(input, records);
  const json = JSON.stringify(report, null, 2);
  if (out) await writeFile(out, `${json}\n`, 'utf8');
  console.log(json);
  if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
