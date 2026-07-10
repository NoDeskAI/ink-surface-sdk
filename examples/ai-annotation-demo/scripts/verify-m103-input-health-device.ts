import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const WAIT_MS = Number(process.env.M103_INPUT_HEALTH_TIMEOUT_MS || 45_000);
const INJECT_SYNTHETIC_STYLUS = process.env.M103_INPUT_HEALTH_INJECT_SYNTHETIC === '1';
const SYNTHETIC_INJECT_DELAY_MS = Number(process.env.M103_INPUT_HEALTH_INJECT_DELAY_MS || 1_000);
const OUTPUT_ROOT = resolve(process.cwd(), process.env.M103_INPUT_HEALTH_OUTPUT_DIR || 'test-results/m103-input-health');
const DEFAULT_HUION_EVENT_PATH = '/dev/input/event3';

interface InterruptRow {
  irq: string;
  total: number;
  label: string;
  raw: string;
}

interface InterruptDelta {
  irq: string;
  label: string;
  before_total: number;
  after_total: number;
  delta: number;
}

interface EventCapture {
  path: string;
  device_name?: string;
  line_count: number;
  abs_x_count: number;
  abs_y_count: number;
  abs_pressure_count: number;
  btn_touch_count: number;
  syn_report_count: number;
  last_lines: string[];
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: string;
}

interface HgtxxDebugState {
  gpio_debug_line: string;
  pinconf_line: string;
  pinmux_line: string;
  irq_spurious: string;
}

interface HuionSysfsState {
  huion_detect_status: string;
  wacom_cast_open: string;
  wacom_cast_orientation: string;
  work_area_enable: string;
  work_area_x_min: string;
  work_area_x_max: string;
  work_area_y_min: string;
  work_area_y_max: string;
  power_control: string;
  power_wakeup: string;
  wakeup_event_count: string;
  wakeup_active_count: string;
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

async function ensureDevice(): Promise<{ serial: string }> {
  const devices = await adb(['devices', '-l']);
  const rows = devices.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  const active = rows.find((line) => /\bdevice\b/.test(line));
  if (!active) throw new Error(`no Android device is connected:\n${devices}`);
  return { serial: active.split(/\s+/)[0] };
}

async function discoverHuionEventPath(): Promise<string> {
  const override = process.env.M103_HUION_INPUT_EVENT_PATH;
  if (override) return override;
  const path = await adb(['shell', `awk '
    /^N: Name="huion-ts"/ { in_huion=1; next }
    in_huion && /^H: Handlers=/ {
      for (i = 1; i <= NF; i++) if ($i ~ /^event[0-9]+$/) { print "/dev/input/" $i; exit }
    }
    /^$/ { in_huion=0 }
  ' /proc/bus/input/devices`], { optional: true });
  return path.trim() || DEFAULT_HUION_EVENT_PATH;
}

function parseInterrupts(text: string): InterruptRow[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const match = line.match(/^([^:]+):\s+(.+)$/);
    if (!match) return [];
    const irq = match[1].trim();
    const rest = match[2].trim().split(/\s+/);
    let total = 0;
    let labelStart = 0;
    for (; labelStart < rest.length; labelStart += 1) {
      if (!/^\d+$/.test(rest[labelStart])) break;
      total += Number(rest[labelStart]);
    }
    const label = rest.slice(labelStart).join(' ');
    return [{ irq, total, label, raw: line }];
  });
}

function relevantInterrupts(rows: InterruptRow[]): InterruptRow[] {
  return rows.filter((row) => /huion|hgtxx|fts_ts|touch|stylus|pen|i2c|gpio0\s+14|gpio0\s+6/i.test(`${row.irq} ${row.label}`));
}

function interruptDeltas(before: InterruptRow[], after: InterruptRow[]): InterruptDelta[] {
  const beforeByKey = new Map(before.map((row) => [`${row.irq}|${row.label}`, row]));
  return after.map((row) => {
    const prev = beforeByKey.get(`${row.irq}|${row.label}`);
    return {
      irq: row.irq,
      label: row.label,
      before_total: prev?.total || 0,
      after_total: row.total,
      delta: row.total - (prev?.total || 0),
    };
  }).filter((row) => row.delta !== 0 || /hgtxx|fts_ts|i2c|gpio/i.test(row.label));
}

function startEventCapture(path: string, deviceName?: string): { stop: () => Promise<EventCapture> } {
  const evidence: EventCapture = {
    path,
    device_name: deviceName,
    line_count: 0,
    abs_x_count: 0,
    abs_y_count: 0,
    abs_pressure_count: 0,
    btn_touch_count: 0,
    syn_report_count: 0,
    last_lines: [],
  };
  const child = spawn(ADB, ['shell', 'getevent', '-lt', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutRemainder = '';
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      evidence.exit = { code, signal };
      closed = true;
      resolve();
    });
  });
  const rememberLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    evidence.line_count += 1;
    if (trimmed.includes('ABS_X')) evidence.abs_x_count += 1;
    if (trimmed.includes('ABS_Y')) evidence.abs_y_count += 1;
    if (trimmed.includes('ABS_PRESSURE')) evidence.abs_pressure_count += 1;
    if (trimmed.includes('BTN_TOUCH')) evidence.btn_touch_count += 1;
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

async function injectSyntheticStylusStroke(eventPath: string, delayMs: number): Promise<{ ok: boolean; delay_ms: number; event_path: string; error?: string }> {
  await sleep(delayMs);
  const command = [
    `sendevent ${eventPath} 1 330 1`,
    `sendevent ${eventPath} 1 320 1`,
    `sendevent ${eventPath} 3 0 21000`,
    `sendevent ${eventPath} 3 1 16000`,
    `sendevent ${eventPath} 3 24 1200`,
    `sendevent ${eventPath} 0 0 0`,
    'sleep 0.1',
    `sendevent ${eventPath} 3 0 23000`,
    `sendevent ${eventPath} 3 1 18000`,
    `sendevent ${eventPath} 3 24 1000`,
    `sendevent ${eventPath} 0 0 0`,
    'sleep 0.1',
    `sendevent ${eventPath} 3 24 0`,
    `sendevent ${eventPath} 1 330 0`,
    `sendevent ${eventPath} 1 320 0`,
    `sendevent ${eventPath} 0 0 0`,
  ].join('; ');
  try {
    await execFileAsync(ADB, ['shell', command], { timeout: 10_000 });
    return { ok: true, delay_ms: delayMs, event_path: eventPath };
  } catch (error) {
    return { ok: false, delay_ms: delayMs, event_path: eventPath, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readSnapshot(huionEventPath: string): Promise<Record<string, unknown>> {
  const huionSysfsPath = huionEventPath.replace(/^\/dev\/input\//, '/sys/class/input/');
  const [
    geteventList,
    event3Realpath,
    event3Sysfs,
    i2cDevice,
    huionSysfs,
    properties,
    services,
    interrupts,
    gpioDebug,
    pinconf,
    pinmux,
    irqSpurious,
  ] = await Promise.all([
    adb(['shell', 'getevent', '-lp'], { optional: true }),
    adb(['shell', `readlink -f ${huionSysfsPath}/device 2>/dev/null || true`], { optional: true }),
    adb(['shell', `for f in name phys uniq properties uevent capabilities/ev capabilities/key capabilities/abs capabilities/prop power/runtime_status; do if [ -f ${huionSysfsPath}/device/$f ]; then echo ---$f---; cat ${huionSysfsPath}/device/$f; fi; done`], { optional: true }),
    adb(['shell', 'for f in name modalias uevent driver/module/version power/runtime_status; do if [ -e /sys/bus/i2c/devices/1-0008/$f ]; then echo ---$f---; cat /sys/bus/i2c/devices/1-0008/$f 2>/dev/null || readlink -f /sys/bus/i2c/devices/1-0008/$f; fi; done'], { optional: true }),
    adb(['shell', 'D=/sys/devices/platform/fe5a0000.i2c/i2c-1/1-0008; for f in huion_detect_status wacom_cast_open wacom_cast_orientation work_area_enable work_area_x_min work_area_x_max work_area_y_min work_area_y_max power/control power/wakeup; do key=$(echo "$f" | tr "/" "_"); printf "%s=" "$key"; cat "$D/$f" 2>/dev/null || true; echo; done; printf "wakeup_event_count="; cat "$D/wakeup/wakeup13/event_count" 2>/dev/null || true; echo; printf "wakeup_active_count="; cat "$D/wakeup/wakeup13/active_count" 2>/dev/null || true; echo'], { optional: true }),
    adb(['shell', 'getprop | grep -Ei "haoqing|hq|hw|eink|stylus|pen|input|touch|sys.is.openhw|sys.hw.process" | head -200'], { optional: true }),
    adb(['shell', 'ps -A | grep -Ei "haoqingdrawserver|system_server|inkloop|input"'], { optional: true }),
    adb(['shell', 'cat /proc/interrupts'], { optional: true }),
    adb(['shell', 'cat /sys/kernel/debug/gpio 2>/dev/null | grep -Ei "HW_EMR_INT_IRQ|hgtxx|huion|gpio-14" || true'], { optional: true }),
    adb(['shell', 'grep -E "pin 14 \\(gpio0-14\\)|huion" /sys/kernel/debug/pinctrl/pinctrl-rockchip-pinctrl/pinconf-pins 2>/dev/null || true'], { optional: true }),
    adb(['shell', 'grep -E "pin 14 \\(gpio0-14\\)|huion" /sys/kernel/debug/pinctrl/pinctrl-rockchip-pinctrl/pinmux-pins 2>/dev/null || true'], { optional: true }),
    adb(['shell', 'cat /proc/irq/86/spurious 2>/dev/null || true'], { optional: true }),
  ]);
  const parsedInterrupts = relevantInterrupts(parseInterrupts(interrupts));
  const hgtxxDebug: HgtxxDebugState = {
    gpio_debug_line: gpioDebug,
    pinconf_line: pinconf,
    pinmux_line: pinmux,
    irq_spurious: irqSpurious,
  };
  const huionState = Object.fromEntries(
    huionSysfs.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [key, rest.join('=').trim()];
      }),
  ) as unknown as HuionSysfsState;
  return {
    getevent_list: geteventList,
    huion_event_path: huionEventPath,
    event3_realpath: event3Realpath,
    event3_sysfs: event3Sysfs,
    i2c_1_0008_snapshot: i2cDevice,
    huion_sysfs: huionState,
    relevant_properties: properties,
    relevant_services: services,
    relevant_interrupts: parsedInterrupts,
    hgtxx_debug: hgtxxDebug,
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const { serial } = await ensureDevice();
  const huionEventPath = await discoverHuionEventPath();
  await adb(['shell', 'logcat', '-c'], { optional: true });
  const before = await readSnapshot(huionEventPath);
  const beforeInterrupts = before.relevant_interrupts as InterruptRow[];
  const event3Capture = startEventCapture(huionEventPath, 'huion-ts');
  const event2Capture = startEventCapture('/dev/input/event2', 'gsensor');
  const synthetic = INJECT_SYNTHETIC_STYLUS ? injectSyntheticStylusStroke(huionEventPath, SYNTHETIC_INJECT_DELAY_MS) : Promise.resolve(null);
  console.error(`[m103-input-health] waiting ${WAIT_MS}ms huion=${huionEventPath} synthetic=${INJECT_SYNTHETIC_STYLUS ? 'on' : 'off'}; draw a real M103 stylus stroke for live acceptance`);
  await sleep(WAIT_MS);
  const syntheticResult = await synthetic;
  const [event3, event2, after, logcat] = await Promise.all([
    event3Capture.stop(),
    event2Capture.stop(),
    readSnapshot(huionEventPath),
    adb(['shell', 'logcat -d -t 800 | grep -Ei "huion|event3|stylus|InputReader|InputDispatcher|HqHwBridge|InkLoopInputSource|hgtxx|haoqingdrawserver" | tail -n 160'], { optional: true }),
  ]);
  const afterInterrupts = after.relevant_interrupts as InterruptRow[];
  const deltas = interruptDeltas(beforeInterrupts, afterInterrupts);
  const hgtxxDelta = deltas.find((row) => /hgtxx/i.test(row.label))?.delta || 0;
  const fe5aI2cDelta = deltas.find((row) => /fe5a0000\.i2c/i.test(row.label))?.delta || 0;
  const beforeHgtxxDebug = before.hgtxx_debug as HgtxxDebugState | undefined;
  const afterHgtxxDebug = after.hgtxx_debug as HgtxxDebugState | undefined;
  const beforeHuionSysfs = before.huion_sysfs as HuionSysfsState | undefined;
  const afterHuionSysfs = after.huion_sysfs as HuionSysfsState | undefined;
  const physicalAcceptanceOk = !syntheticResult?.ok && event3.line_count > 0;
  const syntheticDiagnosticOk = !!syntheticResult?.ok && event3.line_count > 0;
  const reportPath = join(OUTPUT_ROOT, `m103-input-health-${runId}.json`);
  const report = {
    ok: physicalAcceptanceOk || syntheticDiagnosticOk,
    physical_acceptance_ok: physicalAcceptanceOk,
    synthetic_diagnostic_ok: syntheticDiagnosticOk,
    reason: physicalAcceptanceOk
      ? 'observed_real_huion_event3_input'
      : syntheticDiagnosticOk
        ? 'observed_synthetic_huion_event3_input'
        : 'no_real_huion_event3_input',
    latency_ms: Date.now() - started,
    device: { serial, huion_event_path: huionEventPath },
    gate: { wait_ms: WAIT_MS, requires_real_physical_stylus: true },
    synthetic_injection: syntheticResult,
    diagnosis: {
      huion_event3_line_count: event3.line_count,
      gsensor_event2_line_count: event2.line_count,
      hgtxx_interrupt_delta: hgtxxDelta,
      fe5a_i2c_interrupt_delta: fe5aI2cDelta,
      hgtxx_gpio_before: beforeHgtxxDebug?.gpio_debug_line || '',
      hgtxx_gpio_after: afterHgtxxDebug?.gpio_debug_line || '',
      hgtxx_pinconf_after: afterHgtxxDebug?.pinconf_line || '',
      hgtxx_pinmux_after: afterHgtxxDebug?.pinmux_line || '',
      hgtxx_irq_spurious_after: afterHgtxxDebug?.irq_spurious || '',
      huion_detect_status_before: beforeHuionSysfs?.huion_detect_status || '',
      huion_detect_status_after: afterHuionSysfs?.huion_detect_status || '',
      wacom_cast_open_before: beforeHuionSysfs?.wacom_cast_open || '',
      wacom_cast_open_after: afterHuionSysfs?.wacom_cast_open || '',
      work_area_enable_before: beforeHuionSysfs?.work_area_enable || '',
      work_area_enable_after: afterHuionSysfs?.work_area_enable || '',
      work_area_bounds_after: {
        x_min: afterHuionSysfs?.work_area_x_min || '',
        x_max: afterHuionSysfs?.work_area_x_max || '',
        y_min: afterHuionSysfs?.work_area_y_min || '',
        y_max: afterHuionSysfs?.work_area_y_max || '',
      },
      huion_power_after: {
        control: afterHuionSysfs?.power_control || '',
        wakeup: afterHuionSysfs?.power_wakeup || '',
        wakeup_event_count: afterHuionSysfs?.wakeup_event_count || '',
        wakeup_active_count: afterHuionSysfs?.wakeup_active_count || '',
      },
      next_action: physicalAcceptanceOk
        ? 'Run smoke:m103-physical-pen-capture with a real stroke to verify app bridge and RawPenFrame export.'
        : syntheticDiagnosticOk
          ? 'Synthetic injection proves event3/user-space listener path; rerun smoke:m103-input-health with a real physical stylus and check hgtxx interrupt delta.'
          : 'No real huion-ts event3 input was observed; verify the physical M103 stylus hardware, digitizer wake state, and hgtxx interrupt line.',
    },
    before,
    after,
    interrupt_deltas: deltas,
    event_captures: { event3, event2 },
    capture_logcat_relevant_lines: logcat.split('\n').map((line) => line.trim()).filter(Boolean),
    output: { report_path: reportPath },
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || !physicalAcceptanceOk) process.exitCode = syntheticDiagnosticOk ? 0 : 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
