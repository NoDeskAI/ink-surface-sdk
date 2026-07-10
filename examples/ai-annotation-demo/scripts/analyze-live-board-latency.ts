/**
 * Analyze AI Pen to Live Board render latency.
 *
 * Accepted input:
 * - CSV with one timing record per row
 * - JSONL with one timing record per line
 * - JSON array of timing records
 * - wrappers shaped as { records: [...] }, { events: [...] }, { timings: [...] }, or { latency_records: [...] }
 *
 * Usage:
 *   npm run evidence:live-board-latency -- fixtures/live-board-latency-sample.csv
 *   npm run evidence:live-board-latency -- /path/to/live-board-timing.csv --out /tmp/live-board-latency-report.json
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

interface TimingRecord {
  line: number;
  run_id: string;
  scenario: string;
  event_id: string;
  raw_frame_timestamp_ms: number;
  host_receive_timestamp_ms: number;
  ink_event_timestamp_ms?: number;
  render_commit_timestamp_ms?: number;
  dropped: boolean;
  transport?: string;
  pen_id?: string;
  session_id?: string;
}

interface LatencyStats {
  count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
}

interface RunSummary {
  run_id: string;
  scenarios: string[];
  transports: string[];
  event_count: number;
  delivered_event_count: number;
  drop_count: number;
  drop_rate: number;
  duration_ms: number;
  end_to_end_latency_ms: LatencyStats | null;
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
    scenarios: string[];
    transports: string[];
    pen_ids: string[];
    session_ids: string[];
    event_count: number;
    delivered_event_count: number;
    drop_count: number;
    drop_rate: number;
    stage_latency_ms: {
      pen_to_host: LatencyStats | null;
      host_to_ink_event: LatencyStats | null;
      ink_event_to_render: LatencyStats | null;
      end_to_end: LatencyStats | null;
    };
    runs: RunSummary[];
  };
  gate_checks: {
    schema_pass_rate: number;
    has_rendered_events: boolean;
    end_to_end_p50_le_150: boolean | null;
    end_to_end_p95_le_300: boolean | null;
    drop_rate_le_1_percent: boolean;
    has_education_session: boolean;
    has_meeting_session: boolean;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): { input: string; out?: string } {
  const args = [...argv];
  const input = args.shift();
  assert(input, 'usage: analyze-live-board-latency.ts <timing.csv|timing.json|timing.jsonl> [--out report.json]');
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
  const wrapped = record.records ?? record.events ?? record.timings ?? record.latency_records;
  return Array.isArray(wrapped) ? wrapped : [];
}

function parseRecords(text: string): InputRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const rows = unwrapJsonRows(JSON.parse(trimmed));
    return rows.map((value, index) => ({
      line: index + 1,
      fields: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    }));
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = unwrapJsonRows(parsed);
      const values = rows.length > 0 ? rows : [parsed];
      return values.map((value, index) => ({
        line: index + 1,
        fields: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
      }));
    } catch {
      return trimmed
        .split(/\r?\n/)
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.trim() && !line.trim().startsWith('#'))
        .map(({ line, index }) => {
          const value = JSON.parse(line) as unknown;
          return {
            line: index + 1,
            fields: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
          };
        });
    }
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

function latencyStats(values: number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    p50_ms: round(percentile(values, 0.5)),
    p95_ms: round(percentile(values, 0.95)),
    p99_ms: round(percentile(values, 0.99)),
    max_ms: round(Math.max(...values)),
    mean_ms: round(total / values.length),
  };
}

function readString(fields: Record<string, unknown>, field: string): string {
  return String(fields[field] ?? '').trim();
}

function readFirstString(fields: Record<string, unknown>, fieldsToTry: string[]): string {
  for (const field of fieldsToTry) {
    const value = readString(fields, field);
    if (value) return value;
  }
  return '';
}

function readNumber(fields: Record<string, unknown>, fieldsToTry: string[]): number | null {
  for (const field of fieldsToTry) {
    const value = fields[field];
    if (value === undefined || value === null || value === '') continue;
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return null;
}

function readBoolean(fields: Record<string, unknown>, fieldsToTry: string[]): boolean {
  const value = readFirstString(fields, fieldsToTry).toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'dropped';
}

function validateRecord(record: InputRecord): { value?: TimingRecord; issues: ValidationIssueRecord[] } {
  const issues: ValidationIssueRecord[] = [];
  const requireString = (name: string, fieldsToTry: string[]): string => {
    const value = readFirstString(record.fields, fieldsToTry);
    if (!value) issues.push({ line: record.line, path: `rows.${record.line}.${name}`, message: 'required string is missing' });
    return value;
  };
  const requireNumber = (name: string, fieldsToTry: string[]): number => {
    const value = readNumber(record.fields, fieldsToTry);
    if (value === null) {
      issues.push({ line: record.line, path: `rows.${record.line}.${name}`, message: 'required finite number is missing' });
      return 0;
    }
    return value;
  };

  const dropped = readBoolean(record.fields, ['dropped', 'drop', 'is_dropped']);
  const runId = requireString('run_id', ['run_id', 'runId']);
  const scenario = requireString('scenario', ['scenario', 'mode']);
  const eventId = requireString('event_id', ['event_id', 'eventId', 'frame_id', 'stroke_id']);
  const rawFrameTs = requireNumber('raw_frame_timestamp_ms', ['raw_frame_timestamp_ms', 'rawFrameTimestampMs', 'ts_device_ms', 'frame_timestamp_ms']);
  const hostReceiveTs = requireNumber('host_receive_timestamp_ms', ['host_receive_timestamp_ms', 'hostReceiveTimestampMs', 'ts_host_ms', 'host_timestamp_ms']);
  const inkEventTs = readNumber(record.fields, ['ink_event_timestamp_ms', 'inkEventTimestampMs', 'ledger_append_timestamp_ms', 'event_append_timestamp_ms']);
  const renderCommitTs = readNumber(record.fields, ['render_commit_timestamp_ms', 'renderCommitTimestampMs', 'rendered_at_ms', 'paint_timestamp_ms']);

  if (!dropped && inkEventTs === null) {
    issues.push({ line: record.line, path: `rows.${record.line}.ink_event_timestamp_ms`, message: 'required finite number is missing for delivered event' });
  }
  if (!dropped && renderCommitTs === null) {
    issues.push({ line: record.line, path: `rows.${record.line}.render_commit_timestamp_ms`, message: 'required finite number is missing for delivered event' });
  }
  const orderedPairs: Array<[string, number | null, string, number | null]> = [
    ['host_receive_timestamp_ms', hostReceiveTs, 'raw_frame_timestamp_ms', rawFrameTs],
    ['ink_event_timestamp_ms', inkEventTs, 'host_receive_timestamp_ms', hostReceiveTs],
    ['render_commit_timestamp_ms', renderCommitTs, 'ink_event_timestamp_ms', inkEventTs],
  ];
  for (const [laterName, later, earlierName, earlier] of orderedPairs) {
    if (later !== null && earlier !== null && later < earlier) {
      issues.push({
        line: record.line,
        path: `rows.${record.line}.${laterName}`,
        message: `${laterName} must be greater than or equal to ${earlierName}`,
      });
    }
  }

  if (issues.length > 0) return { issues };
  return {
    issues,
    value: {
      line: record.line,
      run_id: runId,
      scenario: scenario.trim().toLowerCase(),
      event_id: eventId,
      raw_frame_timestamp_ms: rawFrameTs,
      host_receive_timestamp_ms: hostReceiveTs,
      ink_event_timestamp_ms: inkEventTs ?? undefined,
      render_commit_timestamp_ms: renderCommitTs ?? undefined,
      dropped,
      transport: readFirstString(record.fields, ['transport', 'connection']) || undefined,
      pen_id: readFirstString(record.fields, ['pen_id', 'penId']) || undefined,
      session_id: readFirstString(record.fields, ['session_id', 'sessionId']) || undefined,
    },
  };
}

function dropRate(total: number, dropped: number): number {
  return total ? round(dropped / total) : 0;
}

function delivered(records: TimingRecord[]): TimingRecord[] {
  return records.filter((record) => !record.dropped && record.ink_event_timestamp_ms !== undefined && record.render_commit_timestamp_ms !== undefined);
}

function runSummaries(records: TimingRecord[]): RunSummary[] {
  const groups = new Map<string, TimingRecord[]>();
  for (const record of records) {
    const current = groups.get(record.run_id) ?? [];
    current.push(record);
    groups.set(record.run_id, current);
  }
  return [...groups.entries()]
    .map(([runId, runRecords]) => {
      const rendered = delivered(runRecords);
      const rawTimestamps = runRecords.map((record) => record.raw_frame_timestamp_ms);
      const renderTimestamps = rendered.map((record) => Number(record.render_commit_timestamp_ms));
      const durationMs =
        rawTimestamps.length > 0 && renderTimestamps.length > 0 ? Math.max(...renderTimestamps) - Math.min(...rawTimestamps) : 0;
      return {
        run_id: runId,
        scenarios: unique(runRecords.map((record) => record.scenario)),
        transports: unique(runRecords.map((record) => record.transport)),
        event_count: runRecords.length,
        delivered_event_count: rendered.length,
        drop_count: runRecords.filter((record) => record.dropped).length,
        drop_rate: dropRate(runRecords.length, runRecords.filter((record) => record.dropped).length),
        duration_ms: round(durationMs),
        end_to_end_latency_ms: latencyStats(rendered.map((record) => Number(record.render_commit_timestamp_ms) - record.raw_frame_timestamp_ms)),
      };
    })
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
}

function analyze(input: string, records: InputRecord[]): AnalyzerReport {
  const validationIssues: ValidationIssueRecord[] = [];
  const validRecords: TimingRecord[] = [];
  for (const record of records) {
    const result = validateRecord(record);
    validationIssues.push(...result.issues);
    if (result.value) validRecords.push(result.value);
  }

  const rendered = delivered(validRecords);
  const dropCount = validRecords.filter((record) => record.dropped).length;
  const endToEndStats = latencyStats(rendered.map((record) => Number(record.render_commit_timestamp_ms) - record.raw_frame_timestamp_ms));
  const p50Pass = endToEndStats ? endToEndStats.p50_ms <= 150 : null;
  const p95Pass = endToEndStats ? endToEndStats.p95_ms <= 300 : null;
  const currentDropRate = dropRate(validRecords.length, dropCount);
  const scenarios = unique(validRecords.map((record) => record.scenario));

  return {
    ok: validationIssues.length === 0 && rendered.length > 0 && p50Pass === true && p95Pass === true && currentDropRate <= 0.01,
    input,
    row_count: records.length,
    valid_row_count: validRecords.length,
    invalid_row_count: records.length - validRecords.length,
    validation_issues: validationIssues,
    summary: {
      run_ids: unique(validRecords.map((record) => record.run_id)),
      scenarios,
      transports: unique(validRecords.map((record) => record.transport)),
      pen_ids: unique(validRecords.map((record) => record.pen_id)),
      session_ids: unique(validRecords.map((record) => record.session_id)),
      event_count: validRecords.length,
      delivered_event_count: rendered.length,
      drop_count: dropCount,
      drop_rate: currentDropRate,
      stage_latency_ms: {
        pen_to_host: latencyStats(validRecords.map((record) => record.host_receive_timestamp_ms - record.raw_frame_timestamp_ms)),
        host_to_ink_event: latencyStats(
          rendered.map((record) => Number(record.ink_event_timestamp_ms) - record.host_receive_timestamp_ms),
        ),
        ink_event_to_render: latencyStats(
          rendered.map((record) => Number(record.render_commit_timestamp_ms) - Number(record.ink_event_timestamp_ms)),
        ),
        end_to_end: endToEndStats,
      },
      runs: runSummaries(validRecords),
    },
    gate_checks: {
      schema_pass_rate: records.length ? round(validRecords.length / records.length) : 0,
      has_rendered_events: rendered.length > 0,
      end_to_end_p50_le_150: p50Pass,
      end_to_end_p95_le_300: p95Pass,
      drop_rate_le_1_percent: currentDropRate <= 0.01,
      has_education_session: scenarios.includes('education'),
      has_meeting_session: scenarios.includes('meeting') || scenarios.includes('business_meeting'),
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
