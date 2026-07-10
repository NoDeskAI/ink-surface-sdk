import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const WAIT_MS = Number(process.env.M103_STYLUS_INPUT_TIMEOUT_MS || 20_000);
const TARGET_DEVICE = process.env.M103_STYLUS_INPUT_DEVICE || 'all';
const INJECT_SYNTHETIC_STYLUS = process.env.M103_STYLUS_INJECT_SYNTHETIC === '1';
const SYNTHETIC_INJECT_DELAY_MS = Number(process.env.M103_STYLUS_INJECT_DELAY_MS || 1_000);
const OUTPUT_ROOT = resolve(process.cwd(), process.env.M103_STYLUS_INPUT_OUTPUT_DIR || 'test-results/m103-stylus-input');

interface InputDeviceSummary {
  path: string;
  name: string;
  capabilities: string[];
}

interface LowLevelInputCaptureEvidence {
  path?: string;
  device_name?: string;
  started_at?: string;
  stopped_at?: string;
  line_count: number;
  abs_x_count: number;
  abs_y_count: number;
  abs_pressure_count: number;
  btn_touch_count: number;
  syn_report_count: number;
  last_lines: string[];
  stderr_lines: string[];
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: string;
}

interface MultiDeviceInputCaptureEvidence {
  mode: 'all' | 'target';
  target_device: string;
  started_at: string;
  stopped_at?: string;
  line_count: number;
  devices: LowLevelInputCaptureEvidence[];
  active_devices: Array<{
    path?: string;
    device_name?: string;
    line_count: number;
    abs_x_count: number;
    abs_y_count: number;
    abs_pressure_count: number;
    btn_touch_count: number;
    syn_report_count: number;
  }>;
}

interface SystemInputState {
  adb_identity: string;
  selinux: string;
  event3_permissions: string;
  sysfs_event3_snapshot: string;
  proc_huion_block: string;
  dumpsys_relevant_lines: string[];
  kernel_relevant_lines: string[];
  logcat_relevant_lines: string[];
}

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

interface HardwareInputState {
  observed_at: string;
  relevant_interrupts: InterruptRow[];
  relevant_settings: Record<string, string>;
  relevant_properties: string;
  relevant_services: string;
  huion_sysfs: Record<string, string>;
  hgtxx_debug: {
    gpio_debug_line: string;
    pinconf_line: string;
    pinmux_line: string;
    irq_spurious: string;
  };
}

type StylusInputReason =
  | 'observed_low_level_stylus_event'
  | 'observed_synthetic_low_level_stylus_event'
  | 'observed_non_stylus_input_only'
  | 'no_low_level_input_event'
  | 'no_matching_input_device'
  | 'no_huion_input_device';

interface StylusInputDiagnosis {
  reason: StylusInputReason;
  stylus_event_seen: boolean;
  any_event_seen: boolean;
  active_device_count: number;
  capture_window_ms: number;
  huion_device_path?: string;
  huion_line_count: number;
  non_stylus_active_devices: string[];
  injected_synthetic_stylus: boolean;
  hardware_hgtxx_interrupt_delta?: number;
  hardware_fe5a_i2c_interrupt_delta?: number;
  hardware_huion_detect_status?: string;
  hardware_wacom_cast_open?: string;
  hardware_work_area_enable?: string;
  next_action: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adb(args: string[], options: { optional?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ADB, args, { timeout: 15_000 });
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

async function readInputDeviceSummary(): Promise<InputDeviceSummary[]> {
  const text = await adb(['shell', 'getevent', '-lp'], { optional: true });
  if (!text) return [];
  return text
    .split(/\n(?=add device \d+:)/)
    .map((block) => {
      const path = block.match(/add device \d+:\s+(\S+)/)?.[1] || '';
      const name = block.match(/name:\s+"([^"]+)"/)?.[1] || '';
      const capabilities = [
        ['BTN_TOUCH', 'touch'],
        ['BTN_STYLUS', 'stylus_button'],
        ['BTN_TOOL_RUBBER', 'eraser'],
        ['ABS_X', 'abs_x'],
        ['ABS_Y', 'abs_y'],
        ['ABS_PRESSURE', 'pressure'],
      ].filter(([raw]) => block.includes(raw)).map(([, label]) => label);
      return { path, name, capabilities };
    })
    .filter((item) => item.path && item.name);
}

function findProcInputBlock(text: string, deviceName: string): string {
  return text
    .split(/\n\s*\n/)
    .find((block) => block.includes(`Name="${deviceName}"`) || block.includes(deviceName))
    ?.trim() || '';
}

function relevantDumpsysLines(text: string): string[] {
  const patterns = [/huion/i, /event3/i, /stylus/i, /BTN_STYLUS/i, /ABS_PRESSURE/i];
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(0, 120);
}

function boundedRelevantLines(text: string, patterns: RegExp[], limit = 120): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(-limit);
}

const LOGCAT_RELEVANT_PATTERNS = [/huion/i, /event3/i, /stylus/i, /InputReader/i, /InputDispatcher/i, /HqHwBridge/i, /InkLoopInputSource/i];

async function readRelevantLogcatLines(): Promise<string[]> {
  const logcat = await adb(['shell', 'logcat -d -t 500 | grep -Ei "huion|event3|stylus|InputReader|InputDispatcher|HqHwBridge|InkLoopInputSource" | tail -n 120'], { optional: true });
  return boundedRelevantLines(logcat, LOGCAT_RELEVANT_PATTERNS);
}

async function readSystemInputState(): Promise<SystemInputState> {
  const [adbIdentity, selinux, event3Permissions, sysfsEvent3, procInput, dumpsysInput, kernelLog, logcatLines] = await Promise.all([
    adb(['shell', 'id'], { optional: true }),
    adb(['shell', 'getenforce'], { optional: true }),
    adb(['shell', 'ls', '-l', '/dev/input/event3'], { optional: true }),
    adb(['shell', 'for f in name phys uniq properties uevent capabilities/ev capabilities/key capabilities/abs capabilities/prop power/runtime_status; do if [ -f /sys/class/input/event3/device/$f ]; then echo ---$f---; cat /sys/class/input/event3/device/$f; fi; done'], { optional: true }),
    adb(['shell', 'cat', '/proc/bus/input/devices'], { optional: true }),
    adb(['shell', 'dumpsys', 'input'], { optional: true }),
    adb(['shell', 'dmesg | grep -Ei "huion|event3|stylus|input" | tail -n 120'], { optional: true }),
    readRelevantLogcatLines(),
  ]);
  const linePatterns = [/huion/i, /event3/i, /stylus/i, /input/i, /HqHwBridge/i, /InkLoopInputSource/i];
  return {
    adb_identity: adbIdentity,
    selinux,
    event3_permissions: event3Permissions,
    sysfs_event3_snapshot: sysfsEvent3,
    proc_huion_block: findProcInputBlock(procInput, 'huion-ts'),
    dumpsys_relevant_lines: relevantDumpsysLines(dumpsysInput),
    kernel_relevant_lines: boundedRelevantLines(kernelLog, linePatterns),
    logcat_relevant_lines: logcatLines,
  };
}

function parseInterrupts(text: string): InterruptRow[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const match = line.match(/^([^:]+):\s+(.+)$/);
    if (!match) return [];
    const irq = match[1].trim();
    const parts = match[2].trim().split(/\s+/);
    let total = 0;
    let labelStart = 0;
    for (; labelStart < parts.length; labelStart += 1) {
      if (!/^\d+$/.test(parts[labelStart])) break;
      total += Number(parts[labelStart]);
    }
    const label = parts.slice(labelStart).join(' ');
    return [{ irq, total, label, raw: line }];
  });
}

function relevantInterrupts(rows: InterruptRow[]): InterruptRow[] {
  return rows.filter((row) => /huion|hgtxx|fts_ts|touch|stylus|pen|i2c|gpio0\s+14|gpio0\s+6/i.test(`${row.irq} ${row.label}`));
}

function interruptDeltas(before: InterruptRow[], after: InterruptRow[]): InterruptDelta[] {
  const beforeByKey = new Map(before.map((row) => [`${row.irq}|${row.label}`, row]));
  return after.map((row) => {
    const previous = beforeByKey.get(`${row.irq}|${row.label}`);
    return {
      irq: row.irq,
      label: row.label,
      before_total: previous?.total || 0,
      after_total: row.total,
      delta: row.total - (previous?.total || 0),
    };
  }).filter((row) => row.delta !== 0 || /hgtxx|fts_ts|i2c|gpio/i.test(row.label));
}

function parseKeyValueLines(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [key, rest.join('=').trim()];
      }),
  );
}

async function readHardwareInputState(): Promise<HardwareInputState> {
  const [
    interrupts,
    settings,
    properties,
    services,
    huionSysfs,
    gpioDebug,
    pinconf,
    pinmux,
    irqSpurious,
  ] = await Promise.all([
    adb(['shell', 'cat /proc/interrupts'], { optional: true }),
    adb(['shell', [
      'printf "system.device_with_handwrite="; settings get system device_with_handwrite 2>/dev/null; echo',
      'printf "global.haoqing_gesture_open="; settings get global haoqing_gesture_open 2>/dev/null; echo',
      'printf "secure.haoqing_dream_state="; settings get secure haoqing_dream_state 2>/dev/null; echo',
      'printf "secure.hq_wifi_idle="; settings get secure hq_wifi_idle 2>/dev/null; echo',
    ].join('; ')], { optional: true }),
    adb(['shell', 'getprop | grep -Ei "haoqing|hq|hw|eink|stylus|pen|input|touch|sys.is.openhw|sys.hw.process" | head -200'], { optional: true }),
    adb(['shell', 'ps -A | grep -Ei "haoqingdrawserver|system_server|inkloop|input"'], { optional: true }),
    adb(['shell', [
      'D=/sys/devices/platform/fe5a0000.i2c/i2c-1/1-0008',
      'for f in huion_detect_status wacom_cast_open wacom_cast_orientation work_area_enable work_area_x_min work_area_x_max work_area_y_min work_area_y_max power/control power/wakeup; do key=$(echo "$f" | tr "/" "_"); printf "%s=" "$key"; cat "$D/$f" 2>/dev/null || true; echo; done',
      'printf "wakeup_event_count="; cat "$D/wakeup/wakeup13/event_count" 2>/dev/null || true; echo',
      'printf "wakeup_active_count="; cat "$D/wakeup/wakeup13/active_count" 2>/dev/null || true; echo',
    ].join('; ')], { optional: true }),
    adb(['shell', 'cat /sys/kernel/debug/gpio 2>/dev/null | grep -Ei "HW_EMR_INT_IRQ|hgtxx|huion|gpio-14" || true'], { optional: true }),
    adb(['shell', 'grep -E "pin 14 \\(gpio0-14\\)|huion" /sys/kernel/debug/pinctrl/pinctrl-rockchip-pinctrl/pinconf-pins 2>/dev/null || true'], { optional: true }),
    adb(['shell', 'grep -E "pin 14 \\(gpio0-14\\)|huion" /sys/kernel/debug/pinctrl/pinctrl-rockchip-pinctrl/pinmux-pins 2>/dev/null || true'], { optional: true }),
    adb(['shell', 'cat /proc/irq/86/spurious 2>/dev/null || true'], { optional: true }),
  ]);
  return {
    observed_at: new Date().toISOString(),
    relevant_interrupts: relevantInterrupts(parseInterrupts(interrupts)),
    relevant_settings: parseKeyValueLines(settings),
    relevant_properties: properties,
    relevant_services: services,
    huion_sysfs: parseKeyValueLines(huionSysfs),
    hgtxx_debug: {
      gpio_debug_line: gpioDebug,
      pinconf_line: pinconf,
      pinmux_line: pinmux,
      irq_spurious: irqSpurious,
    },
  };
}

function createSingleDeviceCapture(target: InputDeviceSummary | undefined): { stop: () => Promise<LowLevelInputCaptureEvidence> } {
  const evidence: LowLevelInputCaptureEvidence = {
    path: target?.path,
    device_name: target?.name,
    started_at: new Date().toISOString(),
    line_count: 0,
    abs_x_count: 0,
    abs_y_count: 0,
    abs_pressure_count: 0,
    btn_touch_count: 0,
    syn_report_count: 0,
    last_lines: [],
    stderr_lines: [],
  };
  if (!target?.path) {
    evidence.error = 'no_stylus_input_device';
    evidence.stopped_at = new Date().toISOString();
    return { stop: async () => evidence };
  }

  const child = spawn(ADB, ['shell', 'getevent', '-lt', target.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdoutRemainder = '';
  let stderrRemainder = '';
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
    if (evidence.last_lines.length > 120) evidence.last_lines.shift();
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutRemainder += chunk.toString('utf8');
    const lines = stdoutRemainder.split('\n');
    stdoutRemainder = lines.pop() || '';
    lines.forEach(rememberLine);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrRemainder += chunk.toString('utf8');
    const lines = stderrRemainder.split('\n');
    stderrRemainder = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      evidence.stderr_lines.push(trimmed);
      if (evidence.stderr_lines.length > 40) evidence.stderr_lines.shift();
    }
  });
  child.once('error', (error) => {
    evidence.error = error.message;
  });

  return {
    stop: async () => {
      rememberLine(stdoutRemainder);
      stdoutRemainder = '';
      if (stderrRemainder.trim()) {
        evidence.stderr_lines.push(stderrRemainder.trim());
        stderrRemainder = '';
      }
      if (!closed) child.kill('SIGTERM');
      await Promise.race([
        closedPromise,
        sleep(800).then(() => {
          if (!closed) child.kill('SIGKILL');
        }),
      ]);
      evidence.stopped_at = new Date().toISOString();
      return evidence;
    },
  };
}

function captureTargets(inputDevices: InputDeviceSummary[], targetDevice: string): InputDeviceSummary[] {
  if (targetDevice === 'all') return inputDevices;
  const byName = inputDevices.filter((item) => item.name === targetDevice);
  if (byName.length > 0) return byName;
  const byPath = inputDevices.filter((item) => item.path === targetDevice);
  if (byPath.length > 0) return byPath;
  if (targetDevice === 'stylus') {
    return inputDevices.filter((item) => item.name === 'huion-ts' || (item.capabilities.includes('pressure') && item.capabilities.includes('abs_x')));
  }
  return [];
}

function createCapture(inputDevices: InputDeviceSummary[], targetDevice: string): { stop: () => Promise<MultiDeviceInputCaptureEvidence> } {
  const targets = captureTargets(inputDevices, targetDevice);
  const mode = targetDevice === 'all' ? 'all' : 'target';
  const startedAt = new Date().toISOString();
  if (targets.length === 0) {
    return {
      stop: async () => ({
        mode,
        target_device: targetDevice,
        started_at: startedAt,
        stopped_at: new Date().toISOString(),
        line_count: 0,
        devices: [{
          started_at: startedAt,
          stopped_at: new Date().toISOString(),
          line_count: 0,
          abs_x_count: 0,
          abs_y_count: 0,
          abs_pressure_count: 0,
          btn_touch_count: 0,
          syn_report_count: 0,
          last_lines: [],
          stderr_lines: [],
          error: 'no_matching_input_device',
        }],
        active_devices: [],
      }),
    };
  }
  const captures = targets.map((target) => createSingleDeviceCapture(target));
  return {
    stop: async () => {
      const devices = await Promise.all(captures.map((capture) => capture.stop()));
      const activeDevices = devices
        .filter((device) => device.line_count > 0)
        .map((device) => ({
          path: device.path,
          device_name: device.device_name,
          line_count: device.line_count,
          abs_x_count: device.abs_x_count,
          abs_y_count: device.abs_y_count,
          abs_pressure_count: device.abs_pressure_count,
          btn_touch_count: device.btn_touch_count,
          syn_report_count: device.syn_report_count,
        }));
      return {
        mode,
        target_device: targetDevice,
        started_at: startedAt,
        stopped_at: new Date().toISOString(),
        line_count: devices.reduce((sum, device) => sum + device.line_count, 0),
        devices,
        active_devices: activeDevices,
      };
    },
  };
}

async function injectSyntheticStylusStroke(delayMs: number): Promise<{ ok: boolean; delay_ms: number; error?: string }> {
  await sleep(delayMs);
  const command = [
    'sendevent /dev/input/event3 1 330 1',
    'sendevent /dev/input/event3 1 320 1',
    'sendevent /dev/input/event3 3 0 21000',
    'sendevent /dev/input/event3 3 1 16000',
    'sendevent /dev/input/event3 3 24 1200',
    'sendevent /dev/input/event3 0 0 0',
    'sleep 0.1',
    'sendevent /dev/input/event3 3 0 23000',
    'sendevent /dev/input/event3 3 1 18000',
    'sendevent /dev/input/event3 3 24 1000',
    'sendevent /dev/input/event3 0 0 0',
    'sleep 0.1',
    'sendevent /dev/input/event3 3 24 0',
    'sendevent /dev/input/event3 1 330 0',
    'sendevent /dev/input/event3 1 320 0',
    'sendevent /dev/input/event3 0 0 0',
  ].join('; ');
  try {
    await execFileAsync(ADB, ['shell', command], { timeout: 10_000 });
    return { ok: true, delay_ms: delayMs };
  } catch (error) {
    return { ok: false, delay_ms: delayMs, error: error instanceof Error ? error.message : String(error) };
  }
}

function diagnoseStylusInput(
  lowLevelInput: MultiDeviceInputCaptureEvidence,
  waitMs: number,
  syntheticInjected: boolean,
  hardware: { before: HardwareInputState; after: HardwareInputState; interrupt_deltas: InterruptDelta[] },
): StylusInputDiagnosis {
  const huionInput = lowLevelInput.devices.find((device) => device.device_name === 'huion-ts')
    ?? lowLevelInput.devices.find((device) => (device.abs_pressure_count > 0 || device.device_name?.includes('huion')));
  const huionLineCount = huionInput?.line_count || 0;
  const hgtxxDelta = hardware.interrupt_deltas.find((row) => /hgtxx/i.test(row.label))?.delta || 0;
  const fe5aI2cDelta = hardware.interrupt_deltas.find((row) => /fe5a0000\.i2c/i.test(row.label))?.delta || 0;
  const huionDetectStatus = hardware.after.huion_sysfs.huion_detect_status || '';
  const wacomCastOpen = hardware.after.huion_sysfs.wacom_cast_open || '';
  const workAreaEnable = hardware.after.huion_sysfs.work_area_enable || '';
  const stylusEventSeen = huionLineCount > 0;
  const anyEventSeen = lowLevelInput.line_count > 0;
  const activeDevices = lowLevelInput.active_devices.map((device) => device.device_name || device.path || 'unknown');
  const nonStylusActiveDevices = lowLevelInput.active_devices
    .filter((device) => device.device_name !== huionInput?.device_name && device.path !== huionInput?.path)
    .map((device) => device.device_name || device.path || 'unknown');
  const errorReason = lowLevelInput.devices.find((device) => device.error)?.error;
  let reason: StylusInputReason;
  let nextAction: string;

  if (stylusEventSeen) {
    reason = syntheticInjected ? 'observed_synthetic_low_level_stylus_event' : 'observed_low_level_stylus_event';
    nextAction = syntheticInjected
      ? 'Synthetic event injection proves the low-level listener works; rerun smoke:m103-stylus-input:live with a real physical stylus stroke for acceptance.'
      : 'Run smoke:m103-physical-pen-capture with a real M103 stylus stroke to verify WebView bridge and RawPenFrame export.';
  } else if (!huionInput && errorReason === 'no_matching_input_device') {
    reason = 'no_matching_input_device';
    nextAction = 'Check M103 device connection and target selector; default target=all should include /dev/input/event3.';
  } else if (!huionInput) {
    reason = 'no_huion_input_device';
    nextAction = 'Check whether the M103 kernel exposes huion-ts in getevent -lp before testing app-level capture.';
  } else if (anyEventSeen) {
    reason = 'observed_non_stylus_input_only';
    nextAction = hgtxxDelta > 0
      ? `Only ${activeDevices.join(', ')} emitted getevent lines, but hgtxx interrupt delta=${hgtxxDelta}; next inspect Huion driver -> input event delivery and HqHw socket routing.`
      : huionDetectStatus === '1'
        ? `Only ${activeDevices.join(', ')} emitted events and hgtxx interrupt delta=0 while huion_detect_status=1; this is before InkLoop/Runtime Sync. Verify the physical M103/Huion stylus is compatible and waking the EMR layer, then compare in the native Reader or stylus adjustment screen.`
        : `Only ${activeDevices.join(', ')} emitted events and hgtxx interrupt delta=0; check Huion detect status, physical stylus compatibility, and EMR hardware before app-level debugging.`;
  } else {
    reason = 'no_low_level_input_event';
    nextAction = hgtxxDelta > 0
      ? `No getevent lines were emitted, but hgtxx interrupt delta=${hgtxxDelta}; next inspect Huion driver event reporting and input device registration.`
      : huionDetectStatus === '1'
        ? 'No input device emitted events and hgtxx interrupt delta=0 while huion_detect_status=1; verify the physical M103/Huion stylus can trigger the native Reader or stylus adjustment screen before debugging InkLoop.'
        : 'No input device emitted events and hgtxx interrupt delta=0; check Huion detect status, physical stylus compatibility, and EMR hardware before app-level debugging.';
  }

  return {
    reason,
    stylus_event_seen: stylusEventSeen,
    any_event_seen: anyEventSeen,
    active_device_count: lowLevelInput.active_devices.length,
    capture_window_ms: waitMs,
    huion_device_path: huionInput?.path,
    huion_line_count: huionLineCount,
    non_stylus_active_devices: nonStylusActiveDevices,
    injected_synthetic_stylus: syntheticInjected,
    hardware_hgtxx_interrupt_delta: hgtxxDelta,
    hardware_fe5a_i2c_interrupt_delta: fe5aI2cDelta,
    hardware_huion_detect_status: huionDetectStatus,
    hardware_wacom_cast_open: wacomCastOpen,
    hardware_work_area_enable: workAreaEnable,
    next_action: nextAction,
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const { serial } = await ensureDevice();
  const inputDevices = await readInputDeviceSummary();
  await adb(['shell', 'logcat', '-c'], { optional: true });
  const systemInputState = await readSystemInputState();
  const hardwareBefore = await readHardwareInputState();
  const capture = createCapture(inputDevices, TARGET_DEVICE);
  const syntheticInjection = INJECT_SYNTHETIC_STYLUS ? injectSyntheticStylusStroke(SYNTHETIC_INJECT_DELAY_MS) : Promise.resolve(null);
  console.error(`[m103-stylus-input] Draw one long real M103 stylus stroke within ${WAIT_MS}ms. target=${TARGET_DEVICE} synthetic=${INJECT_SYNTHETIC_STYLUS ? 'on' : 'off'}`);
  await sleep(WAIT_MS);
  const syntheticInjectionResult = await syntheticInjection;
  const [lowLevelInput, hardwareAfter, captureLogcatRelevantLines] = await Promise.all([
    capture.stop(),
    readHardwareInputState(),
    readRelevantLogcatLines(),
  ]);
  const hardwareEvidence = {
    before: hardwareBefore,
    after: hardwareAfter,
    interrupt_deltas: interruptDeltas(hardwareBefore.relevant_interrupts, hardwareAfter.relevant_interrupts),
  };
  const diagnosis = diagnoseStylusInput(lowLevelInput, WAIT_MS, !!syntheticInjectionResult?.ok, hardwareEvidence);
  const ok = diagnosis.stylus_event_seen;
  const reportPath = join(OUTPUT_ROOT, `m103-stylus-input-${runId}.json`);
  const report = {
    ok,
    physical_acceptance_ok: ok && !diagnosis.injected_synthetic_stylus,
    synthetic_diagnostic_ok: ok && diagnosis.injected_synthetic_stylus,
    reason: diagnosis.reason,
    latency_ms: Date.now() - started,
    device: { serial, input_devices: inputDevices },
    system_input_state: systemInputState,
    hardware_input_state: hardwareEvidence,
    capture_logcat_relevant_lines: captureLogcatRelevantLines,
    instructions: {
      operator_action: 'Keep the M103 awake and draw one continuous physical stylus stroke on the screen while this script is waiting.',
      acceptance: 'This preflight passes only when huion-ts emits low-level events; finger, sensor, and synthetic events do not count as physical stylus acceptance.',
      next_after_pass: 'Run smoke:m103-physical-pen-capture to verify app bridge, RawPenFrame export, and latency.',
    },
    gate: { wait_ms: WAIT_MS, target_device: TARGET_DEVICE, requires_real_physical_stylus: true },
    syntheticInjection: syntheticInjectionResult,
    capture_window: {
      started_at: lowLevelInput.started_at,
      stopped_at: lowLevelInput.stopped_at,
      wait_ms: WAIT_MS,
      target_device: TARGET_DEVICE,
    },
    output: { report_path: reportPath },
    diagnosis,
    lowLevelInput,
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
