import { readdir, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const ACTIVE_OBSIDIAN_VAULT_ROOT = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const TEST_RESULTS_ROOT = resolve(PACKAGE_ROOT, 'test-results');
const OUTPUT_ROOT = resolve(TEST_RESULTS_ROOT, 'v1-product-acceptance');

type GateStatus = 'pass' | 'fail' | 'warn';

interface JsonObject {
  [key: string]: unknown;
}

interface EvidenceFile {
  path: string;
  mtime_ms: number;
  json: JsonObject;
}

interface AcceptanceGate {
  id: string;
  title: string;
  status: GateStatus;
  evidence_path?: string;
  detail: string;
  next_action?: string;
}

interface AcceptedPhysicalBuffer {
  evidence: EvidenceFile;
  frame_count: number;
  batch_count: number;
  socket_packet_count: number;
  socket_delivered_stroke_count: number;
  motion_packet_count: number;
  completed_stroke_count: number;
  input_last_kind: string;
  raw_jsonl_path: string;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function boolField(record: JsonObject, field: string): boolean {
  return record[field] === true;
}

function stringField(record: JsonObject, field: string): string {
  return typeof record[field] === 'string' ? record[field] as string : '';
}

function nestedObject(record: JsonObject, field: string): JsonObject {
  return asObject(record[field]);
}

async function readJsonFile(path: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as JsonObject;
  } catch {
    return null;
  }
}

async function listEvidenceFiles(dir: string, prefix: string): Promise<EvidenceFile[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map(async (name) => {
      const path = join(dir, name);
      const [stats, json] = await Promise.all([stat(path), readJsonFile(path)]);
      if (!json) return null;
      return { path, mtime_ms: stats.mtimeMs, json };
    }));
  return files.filter((file): file is EvidenceFile => !!file).sort((a, b) => b.mtime_ms - a.mtime_ms);
}

function isSyntheticDiagnostic(report: JsonObject): boolean {
  const diagnosis = nestedObject(report, 'diagnosis');
  const gate = nestedObject(report, 'gate');
  const reason = stringField(report, 'reason') || stringField(diagnosis, 'reason');
  return boolField(report, 'synthetic_diagnostic_ok')
    || boolField(diagnosis, 'injected_synthetic_stylus')
    || boolField(gate, 'synthetic_injection')
    || reason.includes('synthetic');
}

function latestRealReport(files: EvidenceFile[]): EvidenceFile | undefined {
  return files.find((file) => !isSyntheticDiagnostic(file.json));
}

function latestSyntheticReport(files: EvidenceFile[]): EvidenceFile | undefined {
  return files.find((file) => isSyntheticDiagnostic(file.json));
}

function acceptedPhysicalBuffer(files: EvidenceFile[]): AcceptedPhysicalBuffer | undefined {
  for (const evidence of files) {
    const bridge = nestedObject(evidence.json, 'bridge_summary');
    const hq = nestedObject(evidence.json, 'hq_debug_status');
    const input = nestedObject(evidence.json, 'input_debug_status');
    const output = nestedObject(evidence.json, 'output');
    const frameCount = numberField(bridge, 'frame_count') || 0;
    const batchCount = numberField(bridge, 'batch_count') || 0;
    const socketPacketCount = numberField(hq, 'socket_packet_count') || 0;
    const socketDeliveredStrokeCount = numberField(hq, 'socket_delivered_stroke_count') || 0;
    const motionPacketCount = numberField(input, 'motion_packet_count') || 0;
    const completedStrokeCount = numberField(input, 'completed_stroke_count') || 0;
    const inputLastKind = stringField(input, 'last_kind');
    const rawJsonlPath = stringField(output, 'raw_jsonl_path');
    const hasRealPenPath = socketPacketCount > 0
      || socketDeliveredStrokeCount > 0
      || inputLastKind === 'pen'
      || motionPacketCount > 0
      || completedStrokeCount > 0;
    if (frameCount >= 2 && batchCount >= 1 && hasRealPenPath && rawJsonlPath) {
      return {
        evidence,
        frame_count: frameCount,
        batch_count: batchCount,
        socket_packet_count: socketPacketCount,
        socket_delivered_stroke_count: socketDeliveredStrokeCount,
        motion_packet_count: motionPacketCount,
        completed_stroke_count: completedStrokeCount,
        input_last_kind: inputLastKind,
        raw_jsonl_path: rawJsonlPath,
      };
    }
  }
  return undefined;
}

function diagnosticReason(report?: EvidenceFile): string {
  if (!report) return 'missing_report';
  const diagnosis = nestedObject(report.json, 'diagnosis');
  return stringField(report.json, 'reason') || stringField(diagnosis, 'reason') || 'unknown';
}

function nextAction(report?: EvidenceFile): string | undefined {
  if (!report) return undefined;
  const diagnosis = nestedObject(report.json, 'diagnosis');
  return stringField(diagnosis, 'next_action') || undefined;
}

function numberField(record: JsonObject, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

function lowLevelStylusSummary(report?: EvidenceFile): string {
  if (!report) return 'no real low-level report';
  const diagnosis = nestedObject(report.json, 'diagnosis');
  return [
    `huion_line_count=${numberField(diagnosis, 'huion_line_count') ?? 'unknown'}`,
    `hgtxx_delta=${numberField(diagnosis, 'hardware_hgtxx_interrupt_delta') ?? 'unknown'}`,
    `active_non_stylus=${Array.isArray(diagnosis.non_stylus_active_devices) ? diagnosis.non_stylus_active_devices.join(',') || 'none' : 'unknown'}`,
  ].join(', ');
}

function hqBridgeSummary(report?: EvidenceFile): string {
  if (!report) return 'no real app bridge report';
  const readiness = nestedObject(report.json, 'readiness');
  const hq = nestedObject(readiness, 'hq_debug_status');
  return [
    `draw_enable_reply=${numberField(hq, 'last_draw_enable_reply') ?? 'unknown'}`,
    `pen_down_enable=${boolField(hq, 'last_pen_down_enable_ok')}`,
    `socket_events_enable=${boolField(hq, 'last_socket_events_enable_ok')}`,
    `socket_connected=${boolField(hq, 'socket_connected')}`,
    `socket_packets=${numberField(hq, 'socket_packet_count') ?? 'unknown'}`,
    `native_area=${stringField(hq, 'last_native_area') || 'unknown'}`,
  ].join(', ');
}

function physicalBufferSummary(buffer: AcceptedPhysicalBuffer): string {
  return [
    `frames=${buffer.frame_count}`,
    `batches=${buffer.batch_count}`,
    `socket_packets=${buffer.socket_packet_count}`,
    `socket_delivered_strokes=${buffer.socket_delivered_stroke_count}`,
    `motion_packets=${buffer.motion_packet_count}`,
    `completed_strokes=${buffer.completed_stroke_count}`,
    `input_last_kind=${buffer.input_last_kind || 'unknown'}`,
  ].join(', ');
}

function latestReport(files: EvidenceFile[]): EvidenceFile | undefined {
  return files[0];
}

function checkPaperReadingMarks(report?: EvidenceFile): AcceptanceGate {
  if (!report) {
    return {
      id: 'paper-reading-mark-types',
      title: 'Current Paper device persists reading mark types',
      status: 'fail',
      detail: 'No paper reading mark type device report found.',
      next_action: 'Run `INKLOOP_REQUIRE_TARGET_DOCUMENT=1 INKLOOP_CLEANUP_BEFORE=1 INKLOOP_CLEANUP_AFTER=1 npm --prefix examples/ai-annotation-demo run smoke:paper-reading-mark-types-device`.',
    };
  }
  const reading = asObject(report.json.reading_mark_types);
  const created = Array.isArray(reading.created) ? reading.created as JsonObject[] : [];
  const reopened = asObject(reading.reopened);
  const runtimeEvents = Array.isArray(reading.runtime_events) ? reading.runtime_events as JsonObject[] : [];
  const device = asObject(report.json.device);
  const document = asObject(report.json.document);
  const kinds = new Set(created.map((item) => stringField(item, 'kind')).filter(Boolean));
  const requiredKinds = ['underline', 'circle', 'handwriting', 'review_later'];
  const hasAllKinds = requiredKinds.every((kind) => kinds.has(kind));
  const ok = report.json.ok === true
    && hasAllKinds
    && boolField(reopened, 'ok')
    && runtimeEvents.length >= 3
    && stringField(document, 'filename').includes('AI时代的UX范式');
  return {
    id: 'paper-reading-mark-types',
    title: 'Current Paper device persists reading mark types',
    status: ok ? 'pass' : 'fail',
    evidence_path: report.path,
    detail: ok
      ? `T10/Paper report passed on ${stringField(device, 'manufacturer')} ${stringField(device, 'model')}: ${stringField(document, 'filename')}, kinds=${requiredKinds.join(',')}, runtime_events=${runtimeEvents.length}.`
      : `Unexpected paper mark report: ok=${report.json.ok === true}, has_all_kinds=${hasAllKinds}, reopened_ok=${boolField(reopened, 'ok')}, runtime_events=${runtimeEvents.length}, filename=${stringField(document, 'filename') || 'missing'}.`,
    next_action: ok ? undefined : 'Rerun the Paper reading mark smoke against the target demo PDF and inspect the report.',
  };
}

function checkPaperStylusInput(latest?: EvidenceFile, real?: EvidenceFile): AcceptanceGate {
  const accepted = real && boolField(real.json, 'physical_acceptance_ok');
  if (accepted) {
    const device = asObject(real.json.device);
    const capture = asObject(real.json.capture);
    return {
      id: 'paper-stylus-input',
      title: 'Current Paper device emits physical stylus input',
      status: 'pass',
      evidence_path: real.path,
      detail: `Physical stylus input observed on ${stringField(device, 'manufacturer')} ${stringField(device, 'model')}: line_count=${numberField(capture, 'line_count') ?? 'unknown'}.`,
    };
  }
  if (!latest) {
    return {
      id: 'paper-stylus-input',
      title: 'Current Paper device emits physical stylus input',
      status: 'warn',
      detail: 'No Paper/T10 stylus input diagnostic report found yet.',
      next_action: 'Run `npm --prefix examples/ai-annotation-demo run smoke:paper-stylus-input:live` while drawing one real physical stylus stroke.',
    };
  }
  const diagnosis = asObject(latest.json.diagnosis);
  const target = asObject(latest.json.target);
  return {
    id: 'paper-stylus-input',
    title: 'Current Paper device emits physical stylus input',
    status: 'warn',
    evidence_path: latest.path,
    detail: `Latest Paper/T10 stylus report is diagnostic-only: reason=${stringField(latest.json, 'reason') || stringField(diagnosis, 'reason') || 'unknown'}, target=${stringField(target, 'path') || 'unknown'} ${stringField(target, 'name') || ''}, line_count=${numberField(diagnosis, 'line_count') ?? 'unknown'}, synthetic_available=${diagnosis.synthetic_injection_available !== false}.`,
    next_action: stringField(diagnosis, 'next_action') || 'Run the Paper stylus live smoke while drawing one real physical stroke.',
  };
}

async function checkCloudHub(): Promise<AcceptanceGate> {
  try {
    const response = await fetch(`${CLOUD_HUB_BASE}/healthz`);
    const json = await response.json() as JsonObject;
    const requireSession = nestedObject(json, 'require_session');
    const protectedServices = ['library', 'runtime_sync', 'knowledge', 'devices'].every((field) => requireSession[field] === true);
    if (response.ok && json.ok === true && json.service === 'inkloop-cloud-hub' && json.port === 8731 && protectedServices) {
      return {
        id: 'cloud-hub-fixed-runtime',
        title: 'Cloud Hub fixed runtime and session protection',
        status: 'pass',
        detail: `${CLOUD_HUB_BASE}/healthz reports port=8731 and session protection for Library/Runtime/Knowledge/Devices.`,
      };
    }
    return {
      id: 'cloud-hub-fixed-runtime',
      title: 'Cloud Hub fixed runtime and session protection',
      status: 'fail',
      detail: `Unexpected Cloud Hub health response: ${JSON.stringify(json)}`,
      next_action: 'Start the local Cloud Hub product runtime on fixed port 8731 and require session auth for Library/Runtime/Knowledge/Devices.',
    };
  } catch (error) {
    return {
      id: 'cloud-hub-fixed-runtime',
      title: 'Cloud Hub fixed runtime and session protection',
      status: 'fail',
      detail: `Unable to read ${CLOUD_HUB_BASE}/healthz: ${error instanceof Error ? error.message : String(error)}`,
      next_action: 'Start the local Cloud Hub product runtime before running the V1 acceptance audit.',
    };
  }
}

async function checkObsidianVault(): Promise<AcceptanceGate> {
  const pluginRoot = join(ACTIVE_OBSIDIAN_VAULT_ROOT, '.obsidian/plugins/inkloop-sync');
  const enabledPath = join(ACTIVE_OBSIDIAN_VAULT_ROOT, '.obsidian/community-plugins.json');
  const settingsPath = join(ACTIVE_OBSIDIAN_VAULT_ROOT, '.obsidian/plugins/inkloop-sync/data.json');
  try {
    const [mainJs, enabledRaw, settingsRaw] = await Promise.all([
      readFile(join(pluginRoot, 'main.js'), 'utf8'),
      readFile(enabledPath, 'utf8'),
      readFile(settingsPath, 'utf8'),
    ]);
    const enabled = JSON.parse(enabledRaw) as unknown;
    const settings = JSON.parse(settingsRaw) as JsonObject;
    const runtimePush = stringField(settings, 'runtimePushEndpoint');
    const runtimePull = stringField(settings, 'runtimePullEndpoint');
    const knowledgeBase = stringField(settings, 'knowledgeBaseEndpoint');
    const enabledOk = Array.isArray(enabled) && enabled.includes('inkloop-sync');
    const codeOk = mainJs.includes('inkloop://doc') && mainJs.includes('controlled-fields');
    const endpointOk = runtimePush.startsWith(CLOUD_HUB_BASE)
      && runtimePull.startsWith(CLOUD_HUB_BASE)
      && knowledgeBase.startsWith(CLOUD_HUB_BASE);
    if (enabledOk && codeOk && endpointOk) {
      return {
        id: 'obsidian-active-vault',
        title: 'Active Obsidian vault uses InkLoop projection plugin',
        status: 'pass',
        evidence_path: pluginRoot,
        detail: `inkloop-sync is enabled in ${ACTIVE_OBSIDIAN_VAULT_ROOT} and points Runtime/Knowledge endpoints at ${CLOUD_HUB_BASE}.`,
      };
    }
    return {
      id: 'obsidian-active-vault',
      title: 'Active Obsidian vault uses InkLoop projection plugin',
      status: 'fail',
      evidence_path: pluginRoot,
      detail: `enabled=${enabledOk} code=${codeOk} endpoint=${endpointOk} runtime_push=${runtimePush || 'missing'} runtime_pull=${runtimePull || 'missing'} knowledge=${knowledgeBase || 'missing'}`,
      next_action: 'Install/enable the InkLoop Obsidian plugin into the active vault and point Runtime/Knowledge settings at the fixed Cloud Hub.',
    };
  } catch (error) {
    return {
      id: 'obsidian-active-vault',
      title: 'Active Obsidian vault uses InkLoop projection plugin',
      status: 'fail',
      evidence_path: pluginRoot,
      detail: `Unable to verify active Obsidian vault: ${error instanceof Error ? error.message : String(error)}`,
      next_action: 'Install the InkLoop Obsidian plugin into the active vault before claiming the V1 Obsidian loop.',
    };
  }
}

function checkLowLevelPhysicalStylus(real?: EvidenceFile, synthetic?: EvidenceFile, buffer?: AcceptedPhysicalBuffer): AcceptanceGate {
  const realOk = real ? boolField(real.json, 'physical_acceptance_ok') : false;
  if (realOk) {
    return {
      id: 'm103-low-level-physical-stylus',
      title: 'M103 physical stylus emits low-level huion-ts input',
      status: 'pass',
      evidence_path: real?.path,
      detail: `physical_acceptance_ok=true, reason=${diagnosticReason(real)}`,
    };
  }
  if (buffer) {
    return {
      id: 'm103-low-level-physical-stylus',
      title: 'M103 physical stylus emits low-latency vendor pen stream',
      status: 'pass',
      evidence_path: buffer.evidence.path,
      detail: `Accepted current app buffer from real physical drawing: ${physicalBufferSummary(buffer)}. RawPenFrame JSONL=${buffer.raw_jsonl_path}`,
    };
  }
  return {
    id: 'm103-low-level-physical-stylus',
    title: 'M103 physical stylus emits low-level huion-ts input',
    status: 'fail',
    evidence_path: real?.path || synthetic?.path,
    detail: real
      ? `Latest real report has physical_acceptance_ok=false, reason=${diagnosticReason(real)}, ${lowLevelStylusSummary(real)}. Synthetic diagnostic available=${!!synthetic && boolField(synthetic.json, 'synthetic_diagnostic_ok')}.`
      : `No non-synthetic stylus input report found. Synthetic diagnostic available=${!!synthetic && boolField(synthetic.json, 'synthetic_diagnostic_ok')}.`,
    next_action: nextAction(real) || 'Run `npm --workspace ./examples/ai-annotation-demo run smoke:m103-stylus-input:live` while drawing one long real M103 stylus stroke.',
  };
}

function checkAppPhysicalPenBridge(real?: EvidenceFile, synthetic?: EvidenceFile, buffer?: AcceptedPhysicalBuffer): AcceptanceGate {
  const realOk = real ? boolField(real.json, 'physical_acceptance_ok') : false;
  if (realOk) {
    return {
      id: 'm103-physical-pen-app-bridge',
      title: 'M103 physical pen reaches app RawPenFrame bridge',
      status: 'pass',
      evidence_path: real?.path,
      detail: `physical_acceptance_ok=true, reason=${diagnosticReason(real)}`,
    };
  }
  if (buffer) {
    return {
      id: 'm103-physical-pen-app-bridge',
      title: 'M103 physical pen reaches app RawPenFrame bridge',
      status: 'pass',
      evidence_path: buffer.evidence.path,
      detail: `Accepted current app RawPenFrame buffer from real physical drawing: ${physicalBufferSummary(buffer)}. RawPenFrame JSONL=${buffer.raw_jsonl_path}`,
    };
  }
  return {
    id: 'm103-physical-pen-app-bridge',
    title: 'M103 physical pen reaches app RawPenFrame bridge',
    status: 'fail',
    evidence_path: real?.path || synthetic?.path,
    detail: real
      ? `Latest real report has physical_acceptance_ok=false, reason=${diagnosticReason(real)}, ${hqBridgeSummary(real)}. Synthetic diagnostic available=${!!synthetic && boolField(synthetic.json, 'synthetic_diagnostic_ok')}.`
      : `No non-synthetic physical pen bridge report found. Synthetic diagnostic available=${!!synthetic && boolField(synthetic.json, 'synthetic_diagnostic_ok')}.`,
    next_action: real && diagnosticReason(real) === 'no_low_level_stylus_event'
      ? 'Pass the low-level stylus input gate first, then rerun `smoke:m103-physical-pen-capture` with a real stroke.'
      : 'Run `npm --workspace ./examples/ai-annotation-demo run smoke:m103-physical-pen-capture` while drawing one real M103 stylus stroke.',
  };
}

function checkSyntheticIsDiagnosticOnly(stylusSynthetic?: EvidenceFile, bridgeSynthetic?: EvidenceFile): AcceptanceGate {
  const syntheticOk = (stylusSynthetic && boolField(stylusSynthetic.json, 'synthetic_diagnostic_ok'))
    || (bridgeSynthetic && boolField(bridgeSynthetic.json, 'synthetic_diagnostic_ok'));
  return {
    id: 'synthetic-pen-not-acceptance',
    title: 'Synthetic pen diagnostics are not counted as physical acceptance',
    status: syntheticOk ? 'pass' : 'warn',
    evidence_path: bridgeSynthetic?.path || stylusSynthetic?.path,
    detail: syntheticOk
      ? 'A synthetic diagnostic proves the downstream listener/bridge can work, but this audit still requires separate physical_acceptance_ok=true reports.'
      : 'No synthetic diagnostic report was found; this does not block product acceptance, but it makes debugging the physical path slower.',
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const [stylusReports, bridgeReports] = await Promise.all([
    listEvidenceFiles(join(TEST_RESULTS_ROOT, 'm103-stylus-input'), 'm103-stylus-input-'),
    listEvidenceFiles(join(TEST_RESULTS_ROOT, 'm103-physical-pen-capture'), 'm103-physical-pen-capture-'),
  ]);
  const [paperReadingReports, paperStylusReports] = await Promise.all([
    listEvidenceFiles(join(TEST_RESULTS_ROOT, 'paper-reading-mark-types'), 'paper-reading-mark-types-'),
    listEvidenceFiles(join(TEST_RESULTS_ROOT, 'paper-stylus-input'), 'paper-stylus-input-'),
  ]);
  const currentBufferReports = await listEvidenceFiles(join(TEST_RESULTS_ROOT, 'm103-physical-pen-capture'), 'm103-current-buffer-');
  const stylusReal = latestRealReport(stylusReports);
  const stylusSynthetic = latestSyntheticReport(stylusReports);
  const bridgeReal = latestRealReport(bridgeReports);
  const bridgeSynthetic = latestSyntheticReport(bridgeReports);
  const physicalBuffer = acceptedPhysicalBuffer(currentBufferReports);
  const latestPaperStylus = latestReport(paperStylusReports);
  const realPaperStylus = paperStylusReports.find((file) => file.json.injected_synthetic_stylus !== true);

  const gates: AcceptanceGate[] = [
    await checkCloudHub(),
    await checkObsidianVault(),
    checkPaperReadingMarks(latestReport(paperReadingReports)),
    checkPaperStylusInput(latestPaperStylus, realPaperStylus),
    checkLowLevelPhysicalStylus(stylusReal, stylusSynthetic, physicalBuffer),
    checkAppPhysicalPenBridge(bridgeReal, bridgeSynthetic, physicalBuffer),
    checkSyntheticIsDiagnosticOnly(stylusSynthetic, bridgeSynthetic),
  ];

  const failed = gates.filter((gate) => gate.status === 'fail');
  const warnings = gates.filter((gate) => gate.status === 'warn');
  const overallStatus = failed.length === 0 ? 'pass' : 'fail';
  const reportPath = join(OUTPUT_ROOT, `v1-product-acceptance-${runId}.json`);
  const report = {
    ok: failed.length === 0,
    overall_status: overallStatus,
    started_at: startedAt,
    summary: {
      pass: gates.filter((gate) => gate.status === 'pass').length,
      fail: failed.length,
      warn: warnings.length,
    },
    gates,
    evidence: {
      cloud_hub_base: CLOUD_HUB_BASE,
      active_obsidian_vault: ACTIVE_OBSIDIAN_VAULT_ROOT,
      latest_real_stylus_input_report: stylusReal?.path || null,
      latest_synthetic_stylus_input_report: stylusSynthetic?.path || null,
      latest_real_physical_pen_report: bridgeReal?.path || null,
      latest_synthetic_physical_pen_report: bridgeSynthetic?.path || null,
      latest_accepted_physical_pen_buffer: physicalBuffer?.evidence.path || null,
      latest_accepted_physical_pen_jsonl: physicalBuffer?.raw_jsonl_path || null,
      latest_paper_reading_mark_report: paperReadingReports[0]?.path || null,
      latest_paper_stylus_input_report: latestPaperStylus?.path || null,
      latest_real_paper_stylus_input_report: realPaperStylus?.path || null,
    },
    output: { report_path: reportPath },
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
