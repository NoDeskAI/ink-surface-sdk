/**
 * Analyze a real AI Pen RawPenFrame log.
 *
 * Accepted input:
 * - JSONL with one RawPenFrame per line
 * - JSON array of RawPenFrame objects
 * - wrappers shaped as { frame: RawPenFrame } or { raw_pen_frame: RawPenFrame }
 *
 * Usage:
 *   npm run evidence:ai-pen-run -- fixtures/ai-pen-run-sample.jsonl
 *   npm run evidence:ai-pen-run -- /path/to/raw-pen-run.jsonl --out /tmp/report.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  isRawPenFrame,
  validateRawPenFrame,
  type RawPenFrame,
  type RuntimeSchemaValidationIssue,
} from 'ink-surface-sdk/runtime-schema';

interface FrameRecord {
  line: number;
  frame: unknown;
}

interface ValidationIssueRecord extends RuntimeSchemaValidationIssue {
  line: number;
}

interface LatencyStats {
  count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  negative_count: number;
}

interface AnalyzerReport {
  ok: boolean;
  input: string;
  frame_count: number;
  valid_frame_count: number;
  invalid_frame_count: number;
  validation_issues: ValidationIssueRecord[];
  summary: {
    pen_ids: string[];
    session_ids: string[];
    surface_ids: string[];
    firmware_versions: string[];
    duration_ms: number;
    duration_min: number;
    tip_state_counts: Record<RawPenFrame['tip_state'], number>;
    strokes_started: number;
    complete_strokes: number;
    open_strokes: number;
    orphan_up_frames: number;
    host_latency_ms: LatencyStats | null;
  };
  gate_checks: {
    schema_pass_rate: number;
    has_down_and_up: boolean;
    has_complete_stroke: boolean;
    host_latency_p50_le_150: boolean | null;
    host_latency_p95_le_300: boolean | null;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): { input: string; out?: string } {
  const args = [...argv];
  const input = args.shift();
  assert(input, 'usage: analyze-ai-pen-run.ts <frames.jsonl|frames.json> [--out report.json]');
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

function unwrapFrame(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.frame) return record.frame;
  if (record.raw_pen_frame) return record.raw_pen_frame;
  return value;
}

function parseRecords(text: string): FrameRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const values = JSON.parse(trimmed) as unknown[];
    assert(Array.isArray(values), 'JSON input must be an array');
    return values.map((value, index) => ({ line: index + 1, frame: unwrapFrame(value) }));
  }
  return trimmed
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() && !line.trim().startsWith('#'))
    .map(({ line, index }) => ({ line: index + 1, frame: unwrapFrame(JSON.parse(line)) }));
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

function latencyStats(frames: RawPenFrame[]): LatencyStats | null {
  const latencies = frames
    .filter((frame) => frame.ts_host_ms !== undefined)
    .map((frame) => Number(frame.ts_host_ms) - frame.ts_device_ms);
  if (latencies.length === 0) return null;
  return {
    count: latencies.length,
    p50_ms: percentile(latencies, 0.5),
    p95_ms: percentile(latencies, 0.95),
    p99_ms: percentile(latencies, 0.99),
    max_ms: Math.max(...latencies),
    negative_count: latencies.filter((value) => value < 0).length,
  };
}

function strokeStats(frames: RawPenFrame[]): Pick<AnalyzerReport['summary'], 'strokes_started' | 'complete_strokes' | 'open_strokes' | 'orphan_up_frames'> {
  const active = new Map<string, boolean>();
  let strokesStarted = 0;
  let completeStrokes = 0;
  let orphanUps = 0;
  for (const frame of [...frames].sort((a, b) => a.ts_device_ms - b.ts_device_ms)) {
    const key = `${frame.session_id}:${frame.pen_id}`;
    const isActive = active.get(key) === true;
    if (frame.tip_state === 'down' && !isActive) {
      strokesStarted += 1;
      active.set(key, true);
    } else if (frame.tip_state === 'up') {
      if (isActive) {
        completeStrokes += 1;
        active.set(key, false);
      } else {
        orphanUps += 1;
      }
    }
  }
  return {
    strokes_started: strokesStarted,
    complete_strokes: completeStrokes,
    open_strokes: [...active.values()].filter(Boolean).length,
    orphan_up_frames: orphanUps,
  };
}

function analyze(input: string, records: FrameRecord[]): AnalyzerReport {
  const validationIssues: ValidationIssueRecord[] = [];
  const validFrames: RawPenFrame[] = [];
  for (const record of records) {
    const issues = validateRawPenFrame(record.frame, `frames.${record.line}`);
    if (issues.length > 0) {
      validationIssues.push(...issues.map((issue) => ({ ...issue, line: record.line })));
    } else if (isRawPenFrame(record.frame)) {
      validFrames.push(record.frame);
    }
  }

  const tsValues = validFrames.map((frame) => frame.ts_device_ms);
  const durationMs = tsValues.length > 1 ? Math.max(...tsValues) - Math.min(...tsValues) : 0;
  const hostLatency = latencyStats(validFrames);
  const tipStateCounts = { down: 0, hover: 0, up: 0 };
  for (const frame of validFrames) tipStateCounts[frame.tip_state] += 1;
  const strokes = strokeStats(validFrames);
  const hasDownAndUp = tipStateCounts.down > 0 && tipStateCounts.up > 0;

  return {
    ok: validationIssues.length === 0 && strokes.complete_strokes > 0,
    input,
    frame_count: records.length,
    valid_frame_count: validFrames.length,
    invalid_frame_count: validationIssues.length ? records.length - validFrames.length : 0,
    validation_issues: validationIssues,
    summary: {
      pen_ids: unique(validFrames.map((frame) => frame.pen_id)),
      session_ids: unique(validFrames.map((frame) => frame.session_id)),
      surface_ids: unique(validFrames.map((frame) => frame.surface_id)),
      firmware_versions: unique(validFrames.map((frame) => frame.firmware_version)),
      duration_ms: durationMs,
      duration_min: Number((durationMs / 60_000).toFixed(3)),
      tip_state_counts: tipStateCounts,
      ...strokes,
      host_latency_ms: hostLatency,
    },
    gate_checks: {
      schema_pass_rate: records.length ? Number((validFrames.length / records.length).toFixed(4)) : 0,
      has_down_and_up: hasDownAndUp,
      has_complete_stroke: strokes.complete_strokes > 0,
      host_latency_p50_le_150: hostLatency ? hostLatency.p50_ms <= 150 : null,
      host_latency_p95_le_300: hostLatency ? hostLatency.p95_ms <= 300 : null,
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
