import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_DEMO_PDF = resolve(PACKAGE_ROOT, 'public/demo/AI时代的UX范式.pdf');
const DEFAULT_OUT = resolve(PACKAGE_ROOT, '.inkloop/reports/reflow-trust-loop.json');

interface CommandResult {
  ok: boolean;
  command: string[];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  json?: Record<string, unknown>;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseJsonFromOutput(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function run(args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn('npm', args, { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      const json = parseJsonFromOutput(stdout);
      resolveResult({ ok: code === 0, command: ['npm', ...args], stdout, stderr, exit_code: code, json });
    });
  });
}

function bool(value: unknown): boolean {
  return value === true;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' ? value : 0;
}

function objectField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main(): Promise<void> {
  const outPath = resolve(argValue('--out') || DEFAULT_OUT);
  const pages = argValue('--pages') || '3';
  const pdfPath = resolve(argValue('--pdf') || DEFAULT_DEMO_PDF);
  const falsificationOut = resolve(PACKAGE_ROOT, '.inkloop/reports/reflow-falsification-unit8.json');

  const started = Date.now();
  const falsification = await run(['run', 'verify:reader-reflow-falsification', '--', pdfPath, `--pages=${pages}`, `--out=${falsificationOut}`]);
  const textIntegrity = await run(['run', 'verify:reflow-text', '--', pdfPath, `--pages=${pages}`]);
  const obsidianReading = await run(['run', 'smoke:obsidian-reading-kind-coverage']);

  const falsificationDecision = stringField(falsification.json, 'decision');
  const textPassed = bool(textIntegrity.json?.passed);
  const obsidianOk = bool(obsidianReading.json?.ok);
  const obsidianVault = objectField(obsidianReading.json, 'vault_projection');
  const activeVaultGuard = objectField(obsidianVault, 'active_vault_reading_guard');
  const allPass = falsification.ok
    && textIntegrity.ok
    && obsidianReading.ok
    && falsificationDecision === 'continue_local_reflow'
    && textPassed
    && obsidianOk;

  const report = {
    schema_version: 'inkloop.reader_reflow_trust_loop_report.v1',
    generated_at: new Date().toISOString(),
    latency_ms: Date.now() - started,
    target_pdf: pdfPath,
    pages_checked: Number(pages),
    decision: allPass ? 'local_reflow_preferred' : 'needs_attention',
    checks: {
      falsification: {
        ok: falsification.ok,
        decision: falsificationDecision,
        evidence_path: falsificationOut,
        summary: falsification.json?.summary ?? null,
      },
      text_integrity: {
        ok: textIntegrity.ok && textPassed,
        passed: textPassed,
        failed_pages: textIntegrity.json?.failed_pages ?? [],
      },
      obsidian_reading_projection: {
        ok: obsidianReading.ok && obsidianOk,
        rendered_file_count: numberField(obsidianReading.json, 'rendered_file_count'),
        active_vault_checked_files: numberField(activeVaultGuard, 'checked_files'),
      },
    },
    product_scope: {
      no_blank_fallback: 'covered_by_reader_state_and_falsification_tests',
      page_state: 'reader_ready_and_vpage_events_publish_canonical_page_state',
      source_return: 'ai_reply_source_return_forces_original_surface_and_bbox_flash',
      physical_stylus: 'not_covered_by_this_no_device_smoke',
    },
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!allPass) process.exit(1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
