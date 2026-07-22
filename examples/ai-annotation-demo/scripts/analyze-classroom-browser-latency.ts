import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const input = resolve(process.argv[2] || 'test-results/education-classroom-latency.csv');
const outIndex = process.argv.indexOf('--out'); const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : undefined;
const lines = (await readFile(input, 'utf8')).trim().split(/\r?\n/); const headers = lines.shift()!.split(',');
const records = lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
if (records.length < 10) throw new Error('classroom_latency_insufficient_samples');
if (records.some((record) => record.scenario !== 'browser_simulation' || record.dropped === 'true')) throw new Error('classroom_latency_invalid_record');
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)];
const kinds = ['world_stroke', 'transient_view', 'durable_view'];
const by_kind = Object.fromEntries(kinds.map((kind) => {
  const values = records.filter((record) => record.kind === kind).map((record) => Number(record.render_commit_timestamp_ms) - Number(record.teacher_sample_timestamp_ms));
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`classroom_latency_invalid_${kind}`);
  return [kind, { sample_count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) }];
}));
const reports = Object.values(by_kind) as Array<{ sample_count: number; p50_ms: number; p95_ms: number }>;
const report = { ok: reports.every((item) => item.p50_ms <= 150 && item.p95_ms <= 300), evidence_kind: 'browser_simulation', sample_count: records.length, by_kind, thresholds: { p50_ms: 150, p95_ms: 300 } };
if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
