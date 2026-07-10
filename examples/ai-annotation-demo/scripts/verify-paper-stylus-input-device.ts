import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const WAIT_MS = Number(process.env.PAPER_STYLUS_INPUT_TIMEOUT_MS || 20_000);
const TARGET_DEVICE = process.env.PAPER_STYLUS_INPUT_DEVICE || 'auto';
const INJECT_SYNTHETIC_STYLUS = process.env.PAPER_STYLUS_INJECT_SYNTHETIC === '1';
const SYNTHETIC_INJECT_DELAY_MS = Number(process.env.PAPER_STYLUS_INJECT_DELAY_MS || 1_000);
const OUTPUT_ROOT = resolve(process.cwd(), process.env.PAPER_STYLUS_INPUT_OUTPUT_DIR || 'test-results/paper-stylus-input');

interface InputDevice {
  path: string;
  name: string;
  raw: string;
  score: number;
  has_abs_x: boolean;
  has_abs_y: boolean;
  has_pressure: boolean;
  has_stylus_key: boolean;
}

interface EventCapture {
  path: string;
  device_name: string;
  line_count: number;
  abs_x_count: number;
  abs_y_count: number;
  abs_pressure_count: number;
  btn_touch_count: number;
  btn_stylus_count: number;
  syn_report_count: number;
  last_lines: string[];
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adb(args: string[], options: { optional?: boolean; timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ADB, args, { timeout: options.timeoutMs || 15_000 });
    return String(stdout || '').trim();
  } catch (error) {
    if (options.optional) return '';
    throw error;
  }
}

async function ensureDevice(): Promise<{ serial: string; model?: string; manufacturer?: string; android_version?: string }> {
  const devices = await adb(['devices', '-l']);
  const rows = devices.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  const active = rows.find((line) => /\bdevice\b/.test(line));
  if (!active) throw new Error(`no Android device is connected:\n${devices}`);
  const [model, manufacturer, androidVersion] = await Promise.all([
    adb(['shell', 'getprop', 'ro.product.model'], { optional: true }),
    adb(['shell', 'getprop', 'ro.product.manufacturer'], { optional: true }),
    adb(['shell', 'getprop', 'ro.build.version.release'], { optional: true }),
  ]);
  return { serial: active.split(/\s+/)[0], model, manufacturer, android_version: androidVersion };
}

function parseInputDevices(text: string): InputDevice[] {
  const sections = text.split(/\n(?=add device \d+: )/g).map((section) => section.trim()).filter(Boolean);
  return sections.flatMap((raw) => {
    const path = raw.match(/^add device \d+:\s+(\S+)/)?.[1];
    const name = raw.match(/^\s*name:\s+"([^"]+)"/m)?.[1] || '';
    if (!path || !name) return [];
    const hasAbsX = /\bABS_X\b/.test(raw) || /\bABS_MT_POSITION_X\b/.test(raw);
    const hasAbsY = /\bABS_Y\b/.test(raw) || /\bABS_MT_POSITION_Y\b/.test(raw);
    const hasPressure = /\bABS_PRESSURE\b/.test(raw) || /\bABS_MT_PRESSURE\b/.test(raw);
    const hasStylusKey = /\bBTN_STYLUS\b|\bBTN_TOOL_(?:PEN|BRUSH|RUBBER)\b/i.test(raw);
    const nameScore = /wacom|stylus|pen|digitizer|huion|emr|emp/i.test(name) ? 4 : 0;
    const score = nameScore + (hasStylusKey ? 4 : 0) + (hasPressure ? 2 : 0) + (hasAbsX && hasAbsY ? 2 : 0);
    return [{
      path,
      name,
      raw,
      score,
      has_abs_x: hasAbsX,
      has_abs_y: hasAbsY,
      has_pressure: hasPressure,
      has_stylus_key: hasStylusKey,
    }];
  }).sort((a, b) => b.score - a.score);
}

function pickStylusDevice(devices: InputDevice[]): InputDevice {
  const target = TARGET_DEVICE.trim();
  if (target && target !== 'auto') {
    const match = devices.find((device) => device.path === target || device.name.toLowerCase().includes(target.toLowerCase()));
    if (!match) throw new Error(`target stylus input device not found: ${target}`);
    return match;
  }
  const best = devices.find((device) => device.score >= 6 && device.has_abs_x && device.has_abs_y);
  if (!best) throw new Error(`no stylus-like input device found: ${devices.map((device) => `${device.path}:${device.name}:score=${device.score}`).join(', ')}`);
  return best;
}

function startEventCapture(device: InputDevice): { stop: () => Promise<EventCapture> } {
  const evidence: EventCapture = {
    path: device.path,
    device_name: device.name,
    line_count: 0,
    abs_x_count: 0,
    abs_y_count: 0,
    abs_pressure_count: 0,
    btn_touch_count: 0,
    btn_stylus_count: 0,
    syn_report_count: 0,
    last_lines: [],
  };
  const child = spawn(ADB, ['shell', 'getevent', '-lt', device.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutRemainder = '';
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      evidence.exit = { code, signal };
      closed = true;
      resolve();
    });
  });
  const rememberLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    evidence.line_count += 1;
    if (trimmed.includes('ABS_X')) evidence.abs_x_count += 1;
    if (trimmed.includes('ABS_Y')) evidence.abs_y_count += 1;
    if (trimmed.includes('ABS_PRESSURE')) evidence.abs_pressure_count += 1;
    if (trimmed.includes('BTN_TOUCH')) evidence.btn_touch_count += 1;
    if (trimmed.includes('BTN_STYLUS') || trimmed.includes('BTN_TOOL_')) evidence.btn_stylus_count += 1;
    if (trimmed.includes('SYN_REPORT')) evidence.syn_report_count += 1;
    evidence.last_lines.push(trimmed);
    if (evidence.last_lines.length > 80) evidence.last_lines.shift();
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutRemainder += chunk.toString('utf8');
    const lines = stdoutRemainder.split('\n');
    stdoutRemainder = lines.pop() || '';
    lines.forEach(rememberLine);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) evidence.error = text;
  });
  child.once('error', (error) => {
    evidence.error = error.message;
  });
  return {
    stop: async () => {
      rememberLine(stdoutRemainder);
      stdoutRemainder = '';
      if (!closed) child.kill('SIGTERM');
      await Promise.race([
        closedPromise,
        sleep(800).then(() => {
          if (!closed) child.kill('SIGKILL');
        }),
      ]);
      return evidence;
    },
  };
}

async function injectSyntheticStylusStroke(device: InputDevice): Promise<{ ok: boolean; event_path: string; delay_ms: number; error?: string }> {
  await sleep(SYNTHETIC_INJECT_DELAY_MS);
  const command = [
    `sendevent ${device.path} 1 320 1`,
    `sendevent ${device.path} 1 330 1`,
    `sendevent ${device.path} 3 0 10000`,
    `sendevent ${device.path} 3 1 7000`,
    `sendevent ${device.path} 3 24 900`,
    `sendevent ${device.path} 3 25 0`,
    `sendevent ${device.path} 0 0 0`,
    'sleep 0.1',
    `sendevent ${device.path} 3 0 12000`,
    `sendevent ${device.path} 3 1 8500`,
    `sendevent ${device.path} 3 24 780`,
    `sendevent ${device.path} 0 0 0`,
    'sleep 0.1',
    `sendevent ${device.path} 3 24 0`,
    `sendevent ${device.path} 1 330 0`,
    `sendevent ${device.path} 1 320 0`,
    `sendevent ${device.path} 0 0 0`,
  ].join('; ');
  try {
    await execFileAsync(ADB, ['shell', command], { timeout: 10_000 });
    return { ok: true, event_path: device.path, delay_ms: SYNTHETIC_INJECT_DELAY_MS };
  } catch (error) {
    return {
      ok: false,
      event_path: device.path,
      delay_ms: SYNTHETIC_INJECT_DELAY_MS,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const deviceInfo = await ensureDevice();
  const inputListText = await adb(['shell', 'getevent', '-lp'], { timeoutMs: 15_000 });
  const devices = parseInputDevices(inputListText);
  const stylus = pickStylusDevice(devices);
  const dumpsysInput = await adb(['shell', `dumpsys input | grep -i -E "stylus|pen|touch|wacom|huion|digit|Device [0-9]" | head -220`], { optional: true });
  const interruptsBefore = await adb(['shell', 'cat /proc/interrupts'], { optional: true });
  const capture = startEventCapture(stylus);
  const synthetic = INJECT_SYNTHETIC_STYLUS ? injectSyntheticStylusStroke(stylus) : Promise.resolve(null);
  console.error(`[paper-stylus-input] waiting ${WAIT_MS}ms target=${stylus.path} "${stylus.name}" synthetic=${INJECT_SYNTHETIC_STYLUS ? 'on' : 'off'}`);
  await sleep(WAIT_MS);
  const eventCapture = await capture.stop();
  const syntheticResult = await synthetic;
  const interruptsAfter = await adb(['shell', 'cat /proc/interrupts'], { optional: true });
  const physicalOk = !INJECT_SYNTHETIC_STYLUS && eventCapture.line_count > 0;
  const syntheticOk = INJECT_SYNTHETIC_STYLUS && eventCapture.line_count > 0;
  const syntheticUnavailable = INJECT_SYNTHETIC_STYLUS && !!syntheticResult && !syntheticResult.ok && /permission denied/i.test(syntheticResult.error || '');
  const reason = physicalOk
    ? 'captured_real_stylus_input'
    : syntheticOk
      ? 'synthetic_stylus_input_observed'
      : syntheticUnavailable
        ? 'synthetic_injection_unavailable'
        : eventCapture.error
          ? 'capture_error'
          : 'no_stylus_input_observed';
  const reportPath = join(OUTPUT_ROOT, `paper-stylus-input-${runId}.json`);
  const report = {
    ok: physicalOk || syntheticOk,
    physical_acceptance_ok: physicalOk,
    synthetic_diagnostic_ok: syntheticOk,
    reason,
    started_at: startedAt,
    capture_window_ms: WAIT_MS,
    injected_synthetic_stylus: INJECT_SYNTHETIC_STYLUS,
    device: deviceInfo,
    target: stylus,
    discovered_devices: devices.map((device) => ({
      path: device.path,
      name: device.name,
      score: device.score,
      has_abs_x: device.has_abs_x,
      has_abs_y: device.has_abs_y,
      has_pressure: device.has_pressure,
      has_stylus_key: device.has_stylus_key,
    })),
    capture: eventCapture,
    synthetic_injection: syntheticResult,
    diagnosis: {
      reason,
      line_count: eventCapture.line_count,
      abs_x_count: eventCapture.abs_x_count,
      abs_y_count: eventCapture.abs_y_count,
      abs_pressure_count: eventCapture.abs_pressure_count,
      btn_touch_count: eventCapture.btn_touch_count,
      syn_report_count: eventCapture.syn_report_count,
      synthetic_injection_available: !syntheticUnavailable,
      next_action: physicalOk
        ? 'Run app-level RawPenFrame capture or latency analysis with the same real physical stroke.'
        : syntheticUnavailable
          ? 'This production T10 build blocks sendevent injection; run smoke:paper-stylus-input:live while drawing one real physical stylus stroke.'
          : 'Run smoke:paper-stylus-input:live while drawing one real physical stylus stroke on the connected Paper device.',
    },
    system: {
      dumpsys_input_excerpt: dumpsysInput,
      interrupts_before_excerpt: interruptsBefore.split('\n').filter((line) => /wacom|stylus|pen|touch|i2c|gpio|onyx|emp/i.test(line)).slice(0, 80),
      interrupts_after_excerpt: interruptsAfter.split('\n').filter((line) => /wacom|stylus|pen|touch|i2c|gpio|onyx|emp/i.test(line)).slice(0, 80),
    },
    output: { report_path: reportPath },
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
