import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { InkLoopVisualModel } from 'ink-surface-sdk/surface-model';
import type { DocumentProjection, KnowledgeObject } from 'ink-surface-sdk/knowledge-schema';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'm103-meeting-device-e2e';
const MEETING_TITLE = process.env.INKLOOP_M103_MEETING_TITLE || 'InkLoop V1 Meeting E2E Test';
const PACKAGE_ROOT = resolve(process.cwd());
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const VAULT_ROOT = resolve(process.env.INKLOOP_M103_MEETING_E2E_VAULT || join(REPO_ROOT, 'test-results/m103-meeting-device-e2e-vault'));
const ACTIVE_OBSIDIAN_VAULT_ROOT = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const MIRROR_ACTIVE_VAULT = process.env.INKLOOP_MIRROR_M103_MEETING_TO_ACTIVE === '1';

type MeetingEventKind = 'decision' | 'action' | 'risk' | 'question' | 'note';

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface RuntimeEvalResult {
  result?: {
    result?: { value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
}

interface DeviceSession {
  active: boolean;
  session_id: string;
  session_token: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  expires_at: number;
}

interface LocalAuthFlow {
  flow_id: string;
  poll_token: string;
  qr_payload: string;
}

interface CloudAiTurnRecord {
  schema_version: 'inkloop.cloud_hub.ai_turn.v1';
  ai_turn_id: string;
  document_id: string;
  mark_ids?: string[];
  prompt_md: string;
  response_md: string;
  status: 'accepted' | 'edited' | 'dismissed' | 'inbox';
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface MeetingMarkResult {
  ok?: boolean;
  kind?: MeetingEventKind;
  meeting_id?: string;
  runtime_document_id?: string;
  document_id?: string;
  context_id?: string;
  mark_id?: string;
  axis_count?: number;
  exported_kinds?: string[];
  error?: string;
}

interface MeetingExportResult {
  documentId: string;
  documentTitle: string;
  knowledgeExport: { objects: KnowledgeObject[] };
  documentProjections: { document_projections: DocumentProjection[] };
  visualModel: InkLoopVisualModel;
  warnings?: string[];
}

interface DeviceEvidence {
  boot: { hasInkLoop?: boolean; keys?: string[]; bodyMode?: string; bodyMtg?: string };
  created: MeetingMarkResult[];
  meeting_export: {
    document_id?: string;
    document_title?: string;
    knowledge_kinds?: string[];
    object_ids?: string[];
    projection_ids?: string[];
    visual_annotation_count?: number;
    warnings?: string[];
  };
  export_full: MeetingExportResult;
  sync: unknown;
}

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cloudSession: DeviceSession | null = null;

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') fail('failed to allocate a local TCP port');
  return address.port;
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
    for (let i = 0; i < 30; i += 1) {
      pid = await adb(['shell', 'pidof', PACKAGE_NAME], { optional: true });
      if (pid) break;
      await sleep(500);
    }
  }
  if (!pid) fail(`Android package did not start: ${PACKAGE_NAME}`);
  return { serial, pid: pid.split(/\s+/)[0] };
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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  if (cloudSession?.session_token) {
    return {
      authorization: `Bearer ${cloudSession.session_token}`,
      'x-inkloop-tenant-id': cloudSession.tenant_id,
      'x-inkloop-user-id': cloudSession.user_id,
      'x-inkloop-device-id': cloudSession.device_id,
      ...extra,
    };
  }
  return extra;
}

async function authorizeLocalCloudHubDevice(): Promise<DeviceSession> {
  const create = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: 'M103 meeting device verification',
      platform: 'android-webview',
      requested_scopes: ['device_session'],
    }),
  });
  const flow = await create.json() as LocalAuthFlow;
  if (!create.ok || !flow.flow_id || !flow.poll_token || !flow.qr_payload) fail(`Cloud Hub local auth create failed HTTP ${create.status}: ${JSON.stringify(flow)}`);
  const scan = await fetch(flow.qr_payload);
  if (!scan.ok) fail(`Cloud Hub local auth scan failed HTTP ${scan.status}: ${await scan.text()}`);
  const status = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/status?poll_token=${encodeURIComponent(flow.poll_token)}`);
  const payload = await status.json() as { status?: string; session?: DeviceSession };
  if (!status.ok || payload.status !== 'authorized' || !payload.session?.session_token) fail(`Cloud Hub local auth status failed HTTP ${status.status}: ${JSON.stringify(payload)}`);
  await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poll_token: flow.poll_token }),
  });
  return payload.session;
}

function browserSessionLiteral(session: DeviceSession): string {
  return JSON.stringify({
    sessionId: session.session_id,
    sessionToken: session.session_token,
    tenantId: session.tenant_id,
    userId: session.user_id,
    deviceId: session.device_id,
    expiresAt: session.expires_at,
  });
}

async function fetchJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${CLOUD_HUB_BASE}${path}`, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  if (!response.ok) fail(`${options.method || 'GET'} ${path} HTTP ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function upsertCloudKnowledge(exported: MeetingExportResult): Promise<void> {
  const projection = exported.documentProjections.document_projections[0];
  for (const object of exported.knowledgeExport.objects) {
    await fetchJson<{ ok: boolean; object: KnowledgeObject }>('/v1/knowledge/objects', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ object }),
    });
  }
  if (projection) {
    await fetchJson<{ ok: boolean; document_projection: DocumentProjection }>('/v1/knowledge/document-projections', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ document_projection: projection }),
    });
  }
}

async function waitForRuntimeMarks(documentId: string, markIds: string[]): Promise<RuntimeSyncEvent[]> {
  const wanted = new Set(markIds);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = new Map<string, RuntimeSyncEvent>();
    let cursor = '0';
    let guard = 0;
    while (guard < 40) {
      guard += 1;
      const pulled = await fetchJson<{ events: RuntimeSyncEvent[]; next_cursor?: string; has_more?: boolean }>(`/v1/runtime/events:pull?device_id=${encodeURIComponent(DEVICE_ID)}&cursor=${encodeURIComponent(cursor)}&limit=100`);
      for (const event of pulled.events) {
        const markId = (event.payload as { mark_id?: string } | undefined)?.mark_id;
        if (event.doc_id === documentId && event.operation === 'annotation.add' && markId && wanted.has(markId)) found.set(markId, event);
      }
      if (!pulled.has_more || !pulled.next_cursor || pulled.next_cursor === cursor) break;
      cursor = pulled.next_cursor;
    }
    if (found.size === wanted.size) return [...found.values()];
    await sleep(500);
  }
  fail(`Runtime Sync did not expose all meeting marks: document_id=${documentId}, mark_ids=${markIds.join(',')}`);
}

async function waitForPostprocess(documentId: string, runtimeEvents: RuntimeSyncEvent[]): Promise<{
  aiTurns: CloudAiTurnRecord[];
  knowledgeObjects: KnowledgeObject[];
  projections: DocumentProjection[];
}> {
  const eventIds = new Set(runtimeEvents.map((event) => event.event_id));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const [aiTurns, knowledge, projections] = await Promise.all([
      fetchJson<{ ai_turns: CloudAiTurnRecord[] }>(`/v1/knowledge/ai-turns?document_id=${encodeURIComponent(documentId)}`),
      fetchJson<{ objects: KnowledgeObject[] }>(`/v1/knowledge/objects?document_id=${encodeURIComponent(documentId)}`),
      fetchJson<{ document_projections: DocumentProjection[] }>(`/v1/knowledge/document-projections?document_id=${encodeURIComponent(documentId)}`),
    ]);
    const matchedAiTurns = aiTurns.ai_turns.filter((turn) => eventIds.has(String(turn.metadata?.runtime_event_id || '')));
    const aiTurnIds = new Set(matchedAiTurns.map((turn) => turn.ai_turn_id));
    const matchedObjects = knowledge.objects.filter((object) => (object.provenance.ai_turn_ids || []).some((id) => aiTurnIds.has(id)));
    const objectIds = new Set(matchedObjects.map((object) => object.ko_id));
    const matchedProjections = projections.document_projections.filter((projection) => projection.blocks.some((block) => block.knowledge_object_ids.some((id) => objectIds.has(id))));
    if (matchedAiTurns.length === eventIds.size && matchedObjects.length >= eventIds.size && matchedProjections.length >= eventIds.size) {
      return { aiTurns: matchedAiTurns, knowledgeObjects: matchedObjects, projections: matchedProjections };
    }
    await sleep(500);
  }
  fail(`Cloud Hub did not auto-persist all meeting post-processing output: document_id=${documentId}, runtime_event_ids=${[...eventIds].join(',')}`);
}

async function writeRenderedVault(files: Array<{ path: string; markdown: string }>): Promise<void> {
  await rm(VAULT_ROOT, { recursive: true, force: true });
  for (const file of files) {
    const target = join(VAULT_ROOT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
  }
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const frontmatter = text.slice(4, end).trim();
  const out: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}

function stripFrontmatter(markdown: string): string {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return text.trim();
  const end = text.indexOf('\n---', 4);
  return end < 0 ? text.trim() : text.slice(end + '\n---'.length).trim();
}

function stripLinkedNotesSection(markdown: string): string {
  return String(markdown || '').replace(/\n## 笔记\n[\s\S]*$/u, '').trimEnd();
}

function activeMeetingHubPath(path: string): string {
  const parts = path.split('/');
  if (parts.length >= 4 && parts[0] === 'InkLoop' && parts[1] === 'Meetings') {
    const title = parts[2].replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
    return ['InkLoop', 'Meetings', title, ...parts.slice(3)].join('/');
  }
  return path;
}

function collapseMeetingProjectionFiles(files: Array<{ path: string; markdown: string }>): Array<{ path: string; markdown: string }> {
  const meetingFiles = files.filter((file) => file.path.startsWith('InkLoop/Meetings/'));
  const hub = meetingFiles.find((file) => parseFrontmatter(file.markdown).inkloop_projection_role === 'source_file_unit') ?? meetingFiles[0];
  if (!hub) return [];
  const knowledgeNotes = meetingFiles.filter((file) => file.path !== hub.path);
  const sections = knowledgeNotes.map((file) => {
    const front = parseFrontmatter(file.markdown);
    const body = stripFrontmatter(file.markdown)
      .replace(/^# .+\n+/u, '')
      .replace(/\n## Controlled Fields/g, '\n#### Controlled Fields')
      .trim();
    return [
      `<!-- inkloop:begin-ko document_id="${escapeHtml(front.inkloop_document_id || '')}" document_uri="${escapeHtml(front.inkloop_document_uri || '')}" ko_id="${escapeHtml(front.inkloop_knowledge_object_id || '')}" kind="${escapeHtml(front.inkloop_knowledge_kind || '')}" -->`,
      body,
      '<!-- inkloop:end-ko -->',
    ].filter(Boolean).join('\n\n');
  });
  const markdown = [
    stripLinkedNotesSection(hub.markdown),
    sections.length ? '## 笔记' : '',
    sections.join('\n\n---\n\n'),
  ].filter(Boolean).join('\n\n').trimEnd();
  return [{ path: activeMeetingHubPath(hub.path), markdown: `${markdown}\n` }];
}

async function resetManagedActiveMeetingArea(): Promise<void> {
  if (ACTIVE_OBSIDIAN_VAULT_ROOT.split('/').at(-1) !== 'InkLoop-Obsidian-Test-Vault') return;
  await rm(join(ACTIVE_OBSIDIAN_VAULT_ROOT, 'InkLoop/Meetings'), { recursive: true, force: true });
}

async function mirrorRenderedFilesToActiveVault(files: Array<{ path: string; markdown: string }>): Promise<{ vault_root: string; rendered_file_count: number; files: string[] } | null> {
  if (!MIRROR_ACTIVE_VAULT) return null;
  try {
    await access(ACTIVE_OBSIDIAN_VAULT_ROOT);
  } catch {
    return null;
  }
  await resetManagedActiveMeetingArea();
  const collapsed = collapseMeetingProjectionFiles(files);
  const written: string[] = [];
  for (const file of collapsed) {
    const target = join(ACTIVE_OBSIDIAN_VAULT_ROOT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
    written.push(target);
  }
  return { vault_root: ACTIVE_OBSIDIAN_VAULT_ROOT, rendered_file_count: written.length, files: written };
}

async function installObsidianPlugin(vaultRoot: string, deviceId: string): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [join(REPO_ROOT, 'scripts/install-obsidian-plugin.mjs'), '--vault', vaultRoot], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...(cloudSession ? {
        INKLOOP_TENANT_ID: cloudSession.tenant_id,
        INKLOOP_USER_ID: cloudSession.user_id,
        INKLOOP_SESSION_TOKEN: cloudSession.session_token,
        INKLOOP_OBSIDIAN_DEVICE_ID: deviceId,
      } : {}),
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function main(): Promise<void> {
  const started = Date.now();
  const runAt = new Date().toISOString();
  const session = await authorizeLocalCloudHubDevice();
  cloudSession = session;
  const { serial, pid } = await ensureDevice();
  const { port, websocketUrl, pageTitle } = await openDevtools(pid);
  const kinds: MeetingEventKind[] = ['decision', 'action', 'risk', 'question', 'note'];

  const evidence = await withCdp(websocketUrl, async ({ evaluate }) => {
    await evaluate(`(() => {
      localStorage.setItem('inkloop.device.session.v1', ${JSON.stringify(browserSessionLiteral(session))});
      if (window.__inkloop?.setApiRoute) window.__inkloop.setApiRoute(${JSON.stringify(CLOUD_HUB_BASE)});
      document.body.classList.remove('auth-open');
      const gate = document.getElementById('auth-gate');
      if (gate) gate.hidden = true;
      return true;
    })()`);
    const boot = await evaluate(`(() => ({
      hasInkLoop: !!window.__inkloop,
      keys: Object.keys(window.__inkloop || {}).sort(),
      bodyMode: document.body.dataset.mode,
      bodyMtg: document.body.dataset.mtg
    }))()`) as DeviceEvidence['boot'];
    if (!boot.hasInkLoop || !boot.keys?.includes('createSyntheticMeetingEventMark')) {
      fail(`InkLoop Paper runtime is missing createSyntheticMeetingEventMark; rebuild and reinstall the APK: ${JSON.stringify(boot.keys)}`);
    }

    const created = await evaluate(`(async () => {
      const api = window.__inkloop;
      const kinds = ${JSON.stringify(kinds)};
      const title = ${JSON.stringify(MEETING_TITLE)};
      const results = [];
      for (let i = 0; i < kinds.length; i += 1) {
        const result = await api.createSyntheticMeetingEventMark(kinds[i], { newMeeting: i === 0, title, index: i });
        results.push(result);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return results;
    })()`) as MeetingMarkResult[];
    const failed = created.filter((item) => !item.ok || !item.mark_id || !item.meeting_id || !item.runtime_document_id);
    if (failed.length) fail(`meeting mark creation failed: ${JSON.stringify(failed)}`);
    const meetingId = created[0]?.meeting_id;
    const runtimeDocumentId = created[0]?.runtime_document_id;
    if (!meetingId || !runtimeDocumentId) fail(`meeting result missing identifiers: ${JSON.stringify(created[0])}`);

    const sync = await evaluate(`(async () => {
      const api = window.__inkloop;
      await api.runtimeSyncHost.syncDocument(${JSON.stringify(runtimeDocumentId)}, 'm103-meeting-device-e2e');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        ok: true,
        runtime_document_id: ${JSON.stringify(runtimeDocumentId)},
        bodyMode: document.body.dataset.mode,
        bodyMtg: document.body.dataset.mtg,
        active: api.getActiveContext?.() && {
          documentId: api.getActiveContext().documentId,
          pageIndex: api.getActiveContext().pageIndex,
          surfaceType: api.getActiveContext().surfaceType
        }
      };
    })()`);

    const exportFull = await evaluate(`(async () => window.__inkloop.exportMeeting(${JSON.stringify(meetingId)}))()`) as MeetingExportResult;
    const exportSummary = {
      document_id: exportFull.documentId,
      document_title: exportFull.documentTitle,
      knowledge_kinds: [...new Set(exportFull.knowledgeExport.objects.map((object) => object.kind))].sort(),
      object_ids: exportFull.knowledgeExport.objects.map((object) => object.ko_id),
      projection_ids: exportFull.documentProjections.document_projections.map((projection) => projection.projection_id),
      visual_annotation_count: exportFull.visualModel.blocks.flatMap((block) => block.annotations || []).length,
      warnings: exportFull.warnings || [],
    };
    return { boot, created, meeting_export: exportSummary, export_full: exportFull, sync };
  }) as DeviceEvidence;

  const runtimeDocumentId = evidence.created[0]?.runtime_document_id;
  if (!runtimeDocumentId) fail(`meeting runtime document id missing: ${JSON.stringify(evidence.created[0])}`);
  const markIds = evidence.created.map((item) => item.mark_id).filter(Boolean) as string[];
  const exportedKinds = new Set(evidence.meeting_export.knowledge_kinds || []);
  for (const expected of ['meeting_decision', 'meeting_action', 'meeting_risk', 'qa', 'annotation']) {
    if (!exportedKinds.has(expected)) fail(`meeting L1 export missing ${expected}: ${JSON.stringify(evidence.meeting_export)}`);
  }
  if ((evidence.meeting_export.visual_annotation_count || 0) < markIds.length) {
    fail(`meeting visual model did not preserve all mark annotations: ${JSON.stringify(evidence.meeting_export)}`);
  }

  await upsertCloudKnowledge(evidence.export_full);
  const runtimeEvents = await waitForRuntimeMarks(runtimeDocumentId, markIds);
  const postprocess = await waitForPostprocess(runtimeDocumentId, runtimeEvents);
  const llmErrors = postprocess.aiTurns.filter((turn) => turn.metadata?.llm_error);
  if (llmErrors.length) fail(`Cloud Hub LLM gateway failed for meeting marks: ${JSON.stringify(llmErrors.map((turn) => ({ ai_turn_id: turn.ai_turn_id, error: turn.metadata?.llm_error })))}`);

  const renderedFiles = renderVaultMarkdown({
    entities: [{
      documentId: evidence.export_full.documentId,
      documentTitle: evidence.export_full.documentTitle,
      mode: 'meeting',
      dates: [runAt.slice(0, 10)],
      knowledgeObjects: [...evidence.export_full.knowledgeExport.objects, ...postprocess.knowledgeObjects],
      documentProjections: [...evidence.export_full.documentProjections.document_projections, ...postprocess.projections],
      visualModel: evidence.export_full.visualModel,
    }],
  });
  await writeRenderedVault(renderedFiles);
  const activeVaultMirror = await mirrorRenderedFilesToActiveVault(renderedFiles);
  const obsidianInstall = await installObsidianPlugin(VAULT_ROOT, 'obsidian-m103-meeting-device-e2e');
  const activeObsidianInstall = activeVaultMirror
    ? await installObsidianPlugin(ACTIVE_OBSIDIAN_VAULT_ROOT, `obsidian_${ACTIVE_OBSIDIAN_VAULT_ROOT.split('/').at(-1) || 'active-vault'}`)
    : null;
  const hubFile = renderedFiles.find((file) => file.path.endsWith(`${evidence.export_full.documentTitle}.md`))?.path ?? renderedFiles[0]?.path ?? '';
  const decisionFile = renderedFiles.find((file) => file.markdown.includes('inkloop_knowledge_kind: "meeting_decision"'))?.path ?? '';
  const postprocessFile = renderedFiles.find((file) => postprocess.knowledgeObjects.some((object) => file.markdown.includes(object.ko_id)))?.path ?? '';
  if (!hubFile || !decisionFile || !postprocessFile) fail('Obsidian renderer did not create meeting hub, decision, and post-process notes');
  const activeMeetingMarkdown = activeVaultMirror?.files[0] ? await readFile(activeVaultMirror.files[0], 'utf8') : '';
  if (activeVaultMirror && !activeMeetingMarkdown.includes('kind="meeting_decision"')) {
    fail('Active Obsidian vault does not contain rendered meeting decision Markdown');
  }

  console.log(JSON.stringify({
    ok: true,
    latency_ms: Date.now() - started,
    device: { serial, pid, cdp_port: port, page_title: pageTitle },
    cloud_hub: {
      base_url: CLOUD_HUB_BASE,
      tenant_id: cloudSession?.tenant_id,
      user_id: cloudSession?.user_id,
      device_id: cloudSession?.device_id,
      runtime_event_count: runtimeEvents.length,
      ai_turn_count: postprocess.aiTurns.length,
      postprocess_knowledge_object_count: postprocess.knowledgeObjects.length,
      document_projection_count: postprocess.projections.length,
      llm_gateway_ok: llmErrors.length === 0,
    },
    meeting: {
      meeting_id: evidence.created[0]?.meeting_id,
      runtime_document_id: runtimeDocumentId,
      mark_ids: markIds,
      created: evidence.created,
      export: evidence.meeting_export,
      runtime_events: runtimeEvents.map((event) => ({
        event_id: event.event_id,
        mark_id: (event.payload as { mark_id?: string }).mark_id,
        doc_id: event.doc_id,
        kind: (event.payload as { annotation?: { kind?: string } }).annotation?.kind,
      })),
      postprocess: {
        ai_turn_ids: postprocess.aiTurns.map((turn) => turn.ai_turn_id),
        knowledge_object_ids: postprocess.knowledgeObjects.map((object) => object.ko_id),
        knowledge_kinds: postprocess.knowledgeObjects.map((object) => object.kind),
        projection_ids: postprocess.projections.map((projection) => projection.projection_id),
      },
    },
    obsidian: {
      vault_root: VAULT_ROOT,
      rendered_file_count: renderedFiles.length,
      hub_file: hubFile ? join(VAULT_ROOT, hubFile) : null,
      decision_file: decisionFile ? join(VAULT_ROOT, decisionFile) : null,
      postprocess_file: postprocessFile ? join(VAULT_ROOT, postprocessFile) : null,
      active_vault_mirror: activeVaultMirror,
      active_vault_hub_file: activeVaultMirror?.files[0] ?? null,
      active_vault_decision_file: activeVaultMirror?.files[0] ?? null,
      active_vault_postprocess_file: activeVaultMirror?.files[0] ?? null,
      plugin_install: obsidianInstall,
      active_plugin_install: activeObsidianInstall,
    },
    evidence: {
      boot: evidence.boot,
      sync: evidence.sync,
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
