import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const WAIT_MS = Number(process.env.M103_PEN_CAPTURE_TIMEOUT_MS || 20_000);
const MIN_FRAMES = Number(process.env.M103_PEN_CAPTURE_MIN_FRAMES || 2);
const BOOT_WAIT_MS = Number(process.env.M103_PEN_BOOT_WAIT_MS || 12_000);
const LOW_LEVEL_INPUT_DEVICE = process.env.M103_PEN_LOW_LEVEL_INPUT_DEVICE || 'all';
const RUN_INPUT_DISPATCH_PROBE = process.env.M103_INPUT_DISPATCH_PROBE === '1';
const INJECT_SYNTHETIC_STYLUS = process.env.M103_PEN_INJECT_SYNTHETIC === '1';
const SYNTHETIC_INJECT_DELAY_MS = Number(process.env.M103_PEN_INJECT_DELAY_MS || 1_000);
const OUTPUT_ROOT = resolve(process.cwd(), process.env.M103_PEN_CAPTURE_OUTPUT_DIR || 'test-results/m103-physical-pen-capture');

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface RuntimeEvalResult {
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
}

interface CaptureSummary {
  batch_count?: number;
  frame_count?: number;
  last_batch_count?: number;
  first_ts_device_ms?: number;
  last_ts_device_ms?: number;
  last_received_at_ms?: number;
}

interface BootEvidence {
  href?: string;
  title?: string;
  hasInkLoop?: boolean;
  hasCaptureBridge?: boolean;
  bridgeKeys?: string[];
  summary?: CaptureSummary;
  pre_reset_jsonl?: string;
  pre_reset_last_jsonl?: string;
}

interface ActiveDocumentEvidence {
  document_id?: string;
  filename?: string;
  surface_type?: string;
  page_index?: number;
  page_count?: number;
  opened_from_shelf?: boolean;
  local_available?: boolean;
  error?: string;
}

interface HqHwReadinessEvidence {
  ready?: boolean;
  reason?: string;
  href?: string;
  title?: string;
  body_classes?: string[];
  body_dataset?: Record<string, string>;
  has_hqhw_area?: boolean;
  has_input_source?: boolean;
  osd_armed?: boolean;
  blocking_overlays?: string[];
  device_profile?: unknown;
  hq_debug_status?: unknown;
  input_debug_status?: unknown;
  active?: ActiveDocumentEvidence;
  canvases?: Array<{
    selector: string;
    visible: boolean;
    width: number;
    height: number;
    left: number;
    top: number;
    display: string;
    visibility: string;
    pointer_events: string;
  }>;
  bridge_summary?: CaptureSummary;
}

interface CaptureEvidence {
  timed_out?: boolean;
  summary?: CaptureSummary;
  jsonl?: string;
  last_jsonl?: string;
  active?: ActiveDocumentEvidence;
}

interface InputDispatchProbe {
  ok: boolean;
  before?: unknown;
  after?: unknown;
  tap?: { x: number; y: number };
  error?: string;
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
  stderr_lines?: string[];
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

interface PhysicalPenEvidence {
  boot: BootEvidence;
  active: ActiveDocumentEvidence;
  penSystemBefore?: PenSystemState;
  penSystemAfter?: PenSystemState;
  penSystemDelta?: PenSystemDelta;
  diagnosticReset?: {
    hq_debug_status?: unknown;
    input_debug_status?: unknown;
    bridge_summary?: CaptureSummary;
  };
  readiness?: HqHwReadinessEvidence;
  inputDispatchProbe?: InputDispatchProbe;
  syntheticInjection?: { ok: boolean; delay_ms: number; error?: string } | null;
  lowLevelInput?: MultiDeviceInputCaptureEvidence;
  capture: CaptureEvidence;
}

interface PenSystemState {
  observed_at: string;
  foreground: string;
  properties: Record<string, string>;
  services: string;
  huion_sysfs: Record<string, string>;
  interrupts: Record<string, number>;
  gpio_debug_line: string;
  pinconf_line: string;
  pinmux_line: string;
  irq86_spurious: string;
}

interface PenSystemDelta {
  hgtxx_interrupt_delta: number;
  fe5a_i2c_interrupt_delta: number;
  fts_ts_interrupt_delta: number;
  sys_is_openhw_before?: string;
  sys_is_openhw_after?: string;
  sys_hw_process_before?: string;
  sys_hw_process_after?: string;
  haoqing_run_app_before?: string;
  haoqing_run_app_after?: string;
}

interface PhysicalPenDiagnosis {
  stage: 'captured' | 'readiness' | 'low_level_input' | 'app_bridge';
  reason:
    | 'captured_physical_pen_frames'
    | 'captured_synthetic_pen_frames'
    | 'no_writable_canvas'
    | 'hqhw_not_armed'
    | 'no_low_level_stylus_event'
    | 'stylus_event_not_bridged'
    | 'needs_physical_stroke';
  low_level_event_seen: boolean;
  app_bridge_event_seen: boolean;
}

function fail(message: string): never {
  throw new Error(message);
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

function parseInterruptTotals(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([^:]+):\s+(.+)$/);
    if (!match) continue;
    const parts = match[2].trim().split(/\s+/);
    let total = 0;
    let labelStart = 0;
    for (; labelStart < parts.length; labelStart += 1) {
      if (!/^\d+$/.test(parts[labelStart])) break;
      total += Number(parts[labelStart]);
    }
    const label = parts.slice(labelStart).join(' ');
    if (/hgtxx/i.test(label)) out.hgtxx = total;
    if (/fe5a0000\.i2c/i.test(label)) out.fe5a_i2c = total;
    if (/fts_ts/i.test(label)) out.fts_ts = total;
  }
  return out;
}

async function readPenSystemState(): Promise<PenSystemState> {
  const [
    foreground,
    properties,
    services,
    huionSysfs,
    interrupts,
    gpioDebug,
    pinconf,
    pinmux,
    irq86Spurious,
  ] = await Promise.all([
    adb(['shell', 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -4'], { optional: true }),
    adb(['shell', [
      'printf "sys.is.openhw="; getprop sys.is.openhw; echo',
      'printf "sys.hw.process="; getprop sys.hw.process; echo',
      'printf "sys.hq.HaoQingRunApp="; getprop sys.hq.HaoQingRunApp; echo',
      'printf "sys.hq.isread="; getprop sys.hq.isread; echo',
      'printf "sys.hq.fastdraw="; getprop sys.hq.fastdraw; echo',
      'printf "sys.eink.mode="; getprop sys.eink.mode; echo',
      'printf "system.device_with_handwrite="; settings get system device_with_handwrite 2>/dev/null; echo',
    ].join('; ')], { optional: true }),
    adb(['shell', 'ps -A | grep -Ei "haoqingdrawserver|system_server|inkloop|input"'], { optional: true }),
    adb(['shell', [
      'D=/sys/devices/platform/fe5a0000.i2c/i2c-1/1-0008',
      'for f in huion_detect_status wacom_cast_open wacom_cast_orientation work_area_enable work_area_x_min work_area_x_max work_area_y_min work_area_y_max power/control power/runtime_status power/wakeup wakeup/wakeup13/event_count wakeup/wakeup13/active_count; do key=$(echo "$f" | tr "/" "_"); printf "%s=" "$key"; cat "$D/$f" 2>/dev/null || true; echo; done',
    ].join('; ')], { optional: true }),
    adb(['shell', 'cat /proc/interrupts'], { optional: true }),
    adb(['shell', 'cat /sys/kernel/debug/gpio 2>/dev/null | grep -Ei "HW_EMR_INT_IRQ|hgtxx|huion|gpio-14" || true'], { optional: true }),
    adb(['shell', 'grep -E "pin 14 \\(gpio0-14\\)|huion" /sys/kernel/debug/pinctrl/pinctrl-rockchip-pinctrl/pinconf-pins 2>/dev/null || true'], { optional: true }),
    adb(['shell', 'grep -E "pin 14 \\(gpio0-14\\)|huion" /sys/kernel/debug/pinctrl/pinctrl-rockchip-pinctrl/pinmux-pins 2>/dev/null || true'], { optional: true }),
    adb(['shell', 'cat /proc/irq/86/spurious 2>/dev/null || true'], { optional: true }),
  ]);
  return {
    observed_at: new Date().toISOString(),
    foreground,
    properties: parseKeyValueLines(properties),
    services,
    huion_sysfs: parseKeyValueLines(huionSysfs),
    interrupts: parseInterruptTotals(interrupts),
    gpio_debug_line: gpioDebug,
    pinconf_line: pinconf,
    pinmux_line: pinmux,
    irq86_spurious: irq86Spurious,
  };
}

function penSystemDelta(before: PenSystemState, after: PenSystemState): PenSystemDelta {
  return {
    hgtxx_interrupt_delta: (after.interrupts.hgtxx || 0) - (before.interrupts.hgtxx || 0),
    fe5a_i2c_interrupt_delta: (after.interrupts.fe5a_i2c || 0) - (before.interrupts.fe5a_i2c || 0),
    fts_ts_interrupt_delta: (after.interrupts.fts_ts || 0) - (before.interrupts.fts_ts || 0),
    sys_is_openhw_before: before.properties['sys.is.openhw'],
    sys_is_openhw_after: after.properties['sys.is.openhw'],
    sys_hw_process_before: before.properties['sys.hw.process'],
    sys_hw_process_after: after.properties['sys.hw.process'],
    haoqing_run_app_before: before.properties['sys.hq.HaoQingRunApp'],
    haoqing_run_app_after: after.properties['sys.hq.HaoQingRunApp'],
  };
}

function numericField(value: unknown, field: string): number {
  if (!value || typeof value !== 'object') return 0;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'number' ? raw : Number(raw || 0) || 0;
}

function diagnosePhysicalPenCapture(evidence: PhysicalPenEvidence, minFrames: number): PhysicalPenDiagnosis {
  const frameCount = evidence.capture.summary?.frame_count || 0;
  const batchCount = evidence.capture.summary?.batch_count || 0;
  const stylusDevice = evidence.lowLevelInput?.devices.find((device) => device.device_name === 'huion-ts')
    ?? evidence.lowLevelInput?.devices.find((device) => (device.abs_pressure_count > 0 || device.device_name?.includes('huion')));
  const lowLevelEventSeen = (stylusDevice?.line_count || 0) > 0;
  const appBridgeEventSeen = frameCount >= minFrames && batchCount >= 1;
  if (appBridgeEventSeen) {
    return {
      stage: 'captured',
      reason: INJECT_SYNTHETIC_STYLUS ? 'captured_synthetic_pen_frames' : 'captured_physical_pen_frames',
      low_level_event_seen: lowLevelEventSeen,
      app_bridge_event_seen: true,
    };
  }
  if (evidence.readiness?.reason && evidence.readiness.reason !== 'ready') {
    const readinessReason = evidence.readiness.reason === 'no_writable_canvas' || evidence.readiness.reason === 'hqhw_not_armed'
      ? evidence.readiness.reason
      : 'needs_physical_stroke';
    return {
      stage: 'readiness',
      reason: readinessReason,
      low_level_event_seen: lowLevelEventSeen,
      app_bridge_event_seen: false,
    };
  }
  if (!lowLevelEventSeen) {
    return {
      stage: 'low_level_input',
      reason: 'no_low_level_stylus_event',
      low_level_event_seen: false,
      app_bridge_event_seen: false,
    };
  }
  return {
    stage: 'app_bridge',
    reason: 'stylus_event_not_bridged',
    low_level_event_seen: true,
    app_bridge_event_seen: false,
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

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') fail('failed to allocate local TCP port');
  return address.port;
}

async function ensureDevice(): Promise<{ serial: string; pid: string }> {
  const devices = await adb(['devices', '-l']);
  const rows = devices.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  const active = rows.find((line) => /\bdevice\b/.test(line));
  if (!active) fail(`no Android device is connected:\n${devices}`);
  const serial = active.split(/\s+/)[0];
  await adb(['reverse', 'tcp:8731', 'tcp:8731'], { optional: true });
  let pid = await adb(['shell', 'pidof', PACKAGE_NAME], { optional: true });
  if (!pid) {
    await adb(['shell', 'am', 'start', '-n', ACTIVITY]);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      pid = await adb(['shell', 'pidof', PACKAGE_NAME], { optional: true });
      if (pid) break;
      await sleep(500);
    }
  }
  if (!pid) fail(`Android package did not start: ${PACKAGE_NAME}`);
  return { serial, pid: pid.split(/\s+/)[0] };
}

async function readInputDeviceSummary(): Promise<Array<{ path: string; name: string; capabilities: string[] }>> {
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

function startSingleInputCapture(target: { path: string; name: string; capabilities: string[] } | undefined): { stop: () => Promise<LowLevelInputCaptureEvidence> } {
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
    if (evidence.last_lines.length > 80) evidence.last_lines.shift();
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
      evidence.stderr_lines?.push(trimmed);
      if ((evidence.stderr_lines?.length || 0) > 20) evidence.stderr_lines?.shift();
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
        evidence.stderr_lines?.push(stderrRemainder.trim());
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

function captureTargets(inputDevices: Array<{ path: string; name: string; capabilities: string[] }>, targetDevice: string): Array<{ path: string; name: string; capabilities: string[] }> {
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

function startLowLevelInputCapture(inputDevices: Array<{ path: string; name: string; capabilities: string[] }>, targetDevice: string): { stop: () => Promise<MultiDeviceInputCaptureEvidence> } {
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
  const captures = targets.map((target) => startSingleInputCapture(target));
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

async function openDevtools(pid: string): Promise<{ port: number; websocketUrl: string; pageTitle: string }> {
  const port = await freePort();
  await adb(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  const deadline = Date.now() + 8_000;
  let lastText = '';
  while (Date.now() < deadline) {
    try {
      lastText = await (await fetch(`http://127.0.0.1:${port}/json/list`)).text();
      const pages = JSON.parse(lastText) as Array<{ title?: string; webSocketDebuggerUrl?: string }>;
      const page = pages.find((item) => item.webSocketDebuggerUrl && /InkLoop|Runtime|Paper/i.test(item.title || '')) ?? pages.find((item) => item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return { port, websocketUrl: page.webSocketDebuggerUrl, pageTitle: page.title || '' };
    } catch {
      // WebView devtools socket can take a moment after app start.
    }
    await sleep(250);
  }
  fail(`WebView devtools page was not available on tcp:${port}: ${lastText}`);
}

async function withCdp<T>(websocketUrl: string, run: (client: { evaluate: (expression: string) => Promise<unknown> }) => Promise<T>): Promise<T> {
  const ws = new WebSocket(websocketUrl);
  const pending = new Map<number, (message: CdpMessage) => void>();
  let nextId = 0;
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP WebSocket connection failed'));
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };
  await send('Runtime.enable');
  const evaluate = async (expression: string): Promise<unknown> => {
    const message = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as RuntimeEvalResult;
    if (message.error) fail(`CDP evaluate failed: ${message.error.message || JSON.stringify(message.error)}`);
    if (message.result?.exceptionDetails) {
      const description = message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text || 'Runtime.evaluate exception';
      fail(description);
    }
    return message.result?.result?.value;
  };
  try {
    return await run({ evaluate });
  } finally {
    ws.close();
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const { serial, pid } = await ensureDevice();
  const inputDevices = await readInputDeviceSummary();
  const penSystemBefore = await readPenSystemState();
  const { port, websocketUrl, pageTitle } = await openDevtools(pid);

  try {
	    const evidence = await withCdp<PhysicalPenEvidence>(websocketUrl, async ({ evaluate }) => {
	      const readBoot = async (): Promise<BootEvidence> => await evaluate(`(() => {
        const bridge = window.InkLoopM103RawPenCapture;
        const summary = bridge?.getSummary?.();
        return {
          href: location.href,
          title: document.title,
          hasInkLoop: !!window.__inkloop,
          hasCaptureBridge: !!bridge,
          bridgeKeys: Object.keys(bridge || {}).sort(),
          summary,
          pre_reset_jsonl: summary?.frame_count ? bridge?.exportAllJsonl?.() : '',
          pre_reset_last_jsonl: summary?.last_batch_count ? bridge?.exportJsonl?.() : ''
        };
	      })()`) as BootEvidence;
	      let boot = await readBoot();
	      const bootDeadline = Date.now() + BOOT_WAIT_MS;
	      while (Date.now() < bootDeadline && (!boot.hasInkLoop || !boot.hasCaptureBridge)) {
	        await sleep(250);
	        boot = await readBoot();
	      }
	      const required = ['clear', 'exportAllJsonl', 'exportJsonl', 'getAllFrames', 'getLastBatch', 'getSummary'];
	      const missing = required.filter((key) => !boot.bridgeKeys?.includes(key));
      if (!boot.hasInkLoop || !boot.hasCaptureBridge || missing.length > 0) {
        fail(`M103 raw pen capture bridge is not ready; rebuild/reinstall the APK. boot=${JSON.stringify(boot)} missing=${missing.join(',')}`);
      }

	      const active = await evaluate(`(async () => {
	        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	        const closeTransientReadingOverlays = () => {
	          document.body.classList.remove('files-open', 'mtg-note-open', 'side-open', 'insight-open', 'tools-open');
	          document.body.dataset.mode = 'read';
	          const stageWrap = document.getElementById('stage-wrap');
	          const readHost = document.getElementById('rv-new');
	          const whisper = document.getElementById('whisper-layer');
	          if (stageWrap && readHost && stageWrap.parentElement?.id === 'mtg-stage-host') {
	            readHost.insertBefore(stageWrap, whisper || null);
	          }
	        };
	        const enterReadingShell = async () => {
	          document.querySelector('.nav [data-mode="read"]')?.click();
	          closeTransientReadingOverlays();
	          await sleep(350);
	        };
	        const api = window.__inkloop;
	        await enterReadingShell();
	        const items = await api.listLibraryItems();
	        const current = api?.getActiveContext?.();
	        let target = current?.documentId ? items.find((item) => item.document_id === current.documentId) : null;
	        target = target || items.find((item) => item.local_available) || items[0];
	        if (!target) return { error: 'no_library_item' };
	        if (!target.local_available && api.downloadCloudLibraryItem) {
	          await api.downloadCloudLibraryItem(target);
	          await sleep(500);
	        }
	        const latest = (await api.listLibraryItems()).find((item) => item.document_id === target.document_id) || target;
	        closeTransientReadingOverlays();
	        await api.openBook(latest.doc || latest);
	        await sleep(1200);
	        closeTransientReadingOverlays();
	        window.dispatchEvent(new Event('resize'));
	        window.__inkloop?.bus?.emit?.('page:rendered');
	        await sleep(500);
	        const ctx = api.getActiveContext?.();
	        return {
	          document_id: ctx?.documentId,
	          filename: latest.filename,
	          surface_type: ctx?.surfaceType,
	          page_index: ctx?.pageIndex,
	          page_count: ctx?.pageCount,
	          local_available: latest.local_available,
	          opened_from_shelf: current?.documentId !== latest.document_id
	        };
	      })()`) as ActiveDocumentEvidence;
	      if (!active.document_id) fail(`no readable document is open for physical pen capture: ${JSON.stringify(active)}`);

	      const diagnosticReset = await evaluate(`(() => {
	        window.InkLoopM103RawPenCapture?.clear?.();
	        window.InkLoopHqHw?.resetDiagnostics?.();
	        window.InkLoopInputSource?.resetDiagnostics?.();
	        const readHqDebugStatus = () => {
	          try {
	            const raw = window.InkLoopHqHw?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        };
	        const readInputDebugStatus = () => {
	          try {
	            const raw = window.InkLoopInputSource?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        };
	        return {
	          hq_debug_status: readHqDebugStatus(),
	          input_debug_status: readInputDebugStatus(),
	          bridge_summary: window.InkLoopM103RawPenCapture?.getSummary?.()
	        };
	      })()`) as PhysicalPenEvidence['diagnosticReset'];

	      const readiness = await evaluate(`(async () => {
	        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	        const closeTransientReadingOverlays = () => {
	          document.body.classList.remove('files-open', 'mtg-note-open', 'side-open', 'insight-open', 'tools-open');
	          document.body.dataset.mode = 'read';
	          const stageWrap = document.getElementById('stage-wrap');
	          const readHost = document.getElementById('rv-new');
	          const whisper = document.getElementById('whisper-layer');
	          if (stageWrap && readHost && stageWrap.parentElement?.id === 'mtg-stage-host') {
	            readHost.insertBefore(stageWrap, whisper || null);
	          }
	        };
	        const readHqDebugStatus = () => {
	          try {
	            const raw = window.InkLoopHqHw?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        };
	        const readInputDebugStatus = () => {
	          try {
	            const raw = window.InkLoopInputSource?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        };
	        const sample = () => {
	          const canvases = [...document.querySelectorAll('#ink-layer, .reader-ink')].map((el) => {
	            const r = el.getBoundingClientRect();
	            const style = getComputedStyle(el);
	            return {
	              selector: el.matches('#ink-layer') ? '#ink-layer' : '.reader-ink',
	              visible: el.offsetParent !== null && r.width > 10 && r.height > 10 && style.visibility !== 'hidden' && style.display !== 'none',
	              width: Math.round(r.width),
	              height: Math.round(r.height),
	              left: Math.round(r.left),
	              top: Math.round(r.top),
	              display: style.display,
	              visibility: style.visibility,
	              pointer_events: style.pointerEvents
	            };
	          });
	          const active = window.__inkloop?.getActiveContext?.();
	          const hasWritableCanvas = canvases.some((canvas) => canvas.visible);
	          const osdArmed = !!window.InkLoopInputSource?.isOsdArmed?.();
	          const blockingOverlays = ['files-open', 'mtg-note-open', 'side-open', 'insight-open', 'tools-open']
	            .filter((name) => document.body.classList.contains(name));
	          return {
	            ready: hasWritableCanvas && osdArmed,
	            reason: !hasWritableCanvas ? 'no_writable_canvas' : !osdArmed ? 'hqhw_not_armed' : 'ready',
	            href: location.href,
	            title: document.title,
	            body_classes: [...document.body.classList].sort(),
	            body_dataset: { ...document.body.dataset },
	            has_hqhw_area: !!window.InkLoopHqHwArea,
	            has_input_source: !!window.InkLoopInputSource,
	            osd_armed: osdArmed,
	            blocking_overlays: blockingOverlays,
	            device_profile: window.__inkloopDeviceProfile || null,
	            hq_debug_status: readHqDebugStatus(),
	            input_debug_status: readInputDebugStatus(),
	            active: {
	              document_id: active?.documentId,
	              surface_type: active?.surfaceType,
	              page_index: active?.pageIndex,
	              page_count: active?.pageCount
	            },
	            canvases,
	            bridge_summary: window.InkLoopM103RawPenCapture?.getSummary?.()
	          };
	        };
	        let last = sample();
	        for (let i = 0; i < 32 && !last.ready; i += 1) {
	          closeTransientReadingOverlays();
	          window.dispatchEvent(new Event('resize'));
	          window.__inkloop?.bus?.emit?.('page:rendered');
	          await sleep(250);
	          last = sample();
	        }
	        return last;
	      })()`) as HqHwReadinessEvidence;
	      if (!readiness.ready) {
	        return { boot, active, readiness, capture: { timed_out: true, summary: boot.summary, active } };
	      }

	      let inputDispatchProbe: InputDispatchProbe | undefined;
	      const probePoint = RUN_INPUT_DISPATCH_PROBE ? readiness.canvases?.find((canvas) => canvas.visible) : null;
	      if (RUN_INPUT_DISPATCH_PROBE && probePoint) {
	        const tap = {
	          x: Math.max(1, Math.round(probePoint.left + Math.min(24, probePoint.width / 4))),
	          y: Math.max(1, Math.round(probePoint.top + Math.min(24, probePoint.height / 4))),
	        };
	        const before = await evaluate(`(() => {
	          try {
	            const raw = window.InkLoopInputSource?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        })()`);
	        await adb(['shell', 'input', 'tap', String(tap.x), String(tap.y)]);
	        await sleep(350);
	        const after = await evaluate(`(() => {
	          try {
	            const raw = window.InkLoopInputSource?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        })()`);
	        const beforeTotal = numericField(before, 'touch_event_count') + numericField(before, 'motion_packet_count') + numericField(before, 'dropped_non_pen_count');
	        const afterTotal = numericField(after, 'touch_event_count') + numericField(after, 'motion_packet_count') + numericField(after, 'dropped_non_pen_count');
	        inputDispatchProbe = {
	          ok: afterTotal > beforeTotal || JSON.stringify(after) !== JSON.stringify(before),
	          before,
	          after,
	          tap,
	        };
	      } else if (RUN_INPUT_DISPATCH_PROBE) {
	        inputDispatchProbe = { ok: false, error: 'no_visible_canvas_for_probe' };
	      }

	      await evaluate(`(() => {
	        window.InkLoopM103RawPenCapture.clear();
	        window.InkLoopInputSource?.clearPhysicalPenStrokes?.();
	        return true;
	      })()`);
	      console.error(`[m103-physical-pen] Please draw one real stylus stroke on the M103 within ${WAIT_MS}ms. active_doc=${active.document_id}`);
	      const lowLevelCapture = startLowLevelInputCapture(inputDevices, LOW_LEVEL_INPUT_DEVICE);
	      const syntheticInjection = INJECT_SYNTHETIC_STYLUS ? injectSyntheticStylusStroke(SYNTHETIC_INJECT_DELAY_MS) : Promise.resolve(null);
	      let lowLevelInput: MultiDeviceInputCaptureEvidence;
	      let capture: CaptureEvidence;
	      let syntheticInjectionResult: Awaited<ReturnType<typeof injectSyntheticStylusStroke>> | null = null;
	      let penSystemAfter: PenSystemState = penSystemBefore;
	      try {
	        capture = await evaluate(`(async () => {
	        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	        const readHqDebugStatus = () => {
	          try {
	            const raw = window.InkLoopHqHw?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        };
	        const readInputDebugStatus = () => {
	          try {
	            const raw = window.InkLoopInputSource?.debugStatus?.();
	            return raw ? JSON.parse(raw) : null;
	          } catch (error) {
	            return { error: String(error) };
	          }
	        };
	        const bridge = window.InkLoopM103RawPenCapture;
        const started = Date.now();
        while (Date.now() - started < ${JSON.stringify(WAIT_MS)}) {
          const summary = bridge.getSummary();
          if ((summary.frame_count || 0) >= ${JSON.stringify(MIN_FRAMES)} && (summary.batch_count || 0) >= 1) break;
          await sleep(250);
        }
        const summary = bridge.getSummary();
        return {
          timed_out: (summary.frame_count || 0) < ${JSON.stringify(MIN_FRAMES)},
          summary,
	          jsonl: bridge.exportAllJsonl(),
	          last_jsonl: bridge.exportJsonl(),
	          hq_debug_status: readHqDebugStatus(),
	          input_debug_status: readInputDebugStatus(),
	          active: {
            document_id: window.__inkloop?.getActiveContext?.()?.documentId,
            surface_type: window.__inkloop?.getActiveContext?.()?.surfaceType,
            page_index: window.__inkloop?.getActiveContext?.()?.pageIndex,
            page_count: window.__inkloop?.getActiveContext?.()?.pageCount
          }
        };
      })()`) as CaptureEvidence;
	      } finally {
	        syntheticInjectionResult = await syntheticInjection;
	        lowLevelInput = await lowLevelCapture.stop();
	        penSystemAfter = await readPenSystemState();
	      }
	      return {
	        boot,
	        active,
	        penSystemBefore,
	        penSystemAfter,
	        penSystemDelta: penSystemDelta(penSystemBefore, penSystemAfter),
	        diagnosticReset,
	        readiness,
	        inputDispatchProbe,
	        syntheticInjection: syntheticInjectionResult,
	        lowLevelInput,
	        capture,
	      };
	    });

	    await mkdir(OUTPUT_ROOT, { recursive: true });
    const jsonlPath = join(OUTPUT_ROOT, `m103-raw-pen-${runId}.jsonl`);
    const preResetJsonlPath = join(OUTPUT_ROOT, `m103-raw-pen-pre-reset-${runId}.jsonl`);
    const reportPath = join(OUTPUT_ROOT, `m103-physical-pen-capture-${runId}.json`);
    if (evidence.capture.jsonl) await writeFile(jsonlPath, `${evidence.capture.jsonl.trim()}\n`, 'utf8');
    if (evidence.boot.pre_reset_jsonl) await writeFile(preResetJsonlPath, `${evidence.boot.pre_reset_jsonl.trim()}\n`, 'utf8');
	    const diagnosis = diagnosePhysicalPenCapture(evidence, MIN_FRAMES);
	    const ok = diagnosis.reason === 'captured_physical_pen_frames' || diagnosis.reason === 'captured_synthetic_pen_frames';
	    const report = {
	      ok,
	      physical_acceptance_ok: diagnosis.reason === 'captured_physical_pen_frames',
	      synthetic_diagnostic_ok: diagnosis.reason === 'captured_synthetic_pen_frames',
	      reason: diagnosis.reason,
	      diagnosis,
	      latency_ms: Date.now() - started,
      device: { serial, pid, cdp_port: port, page_title: pageTitle, input_devices: inputDevices },
      gate: {
        wait_ms: WAIT_MS,
        min_frames: MIN_FRAMES,
        boot_wait_ms: BOOT_WAIT_MS,
        input_dispatch_probe: RUN_INPUT_DISPATCH_PROBE,
        low_level_input_device: LOW_LEVEL_INPUT_DEVICE,
        synthetic_injection: INJECT_SYNTHETIC_STYLUS,
        synthetic_injection_delay_ms: SYNTHETIC_INJECT_DELAY_MS,
      },
      output: {
        report_path: reportPath,
        raw_jsonl_path: evidence.capture.jsonl ? jsonlPath : null,
        pre_reset_raw_jsonl_path: evidence.boot.pre_reset_jsonl ? preResetJsonlPath : null,
      },
      ...evidence,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    await adb(['forward', '--remove', `tcp:${port}`], { optional: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
