import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import {
  type DocumentProjection,
  type KnowledgeObject,
} from 'ink-surface-sdk/knowledge-schema';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { InkLoopVisualStroke } from 'ink-surface-sdk/surface-model';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const TENANT_ID = process.env.INKLOOP_TENANT_ID || 'local';
const USER_ID = process.env.INKLOOP_USER_ID || 'local_demo';
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'm103-real-device-e2e';
const PACKAGE_ROOT = resolve(process.cwd());
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const VAULT_ROOT = resolve(process.env.INKLOOP_M103_E2E_VAULT || join(REPO_ROOT, 'test-results/m103-real-device-e2e-vault'));
const ACTIVE_OBSIDIAN_VAULT_ROOT = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const MIRROR_ACTIVE_VAULT = process.env.INKLOOP_MIRROR_M103_CLOUD_LIBRARY_TO_ACTIVE === '1';
const UPLOAD_DEMO_SOURCE = process.env.INKLOOP_M103_UPLOAD_DEMO_SOURCE === '1';
const DEMO_DOCUMENT_ID = process.env.INKLOOP_M103_DEMO_DOCUMENT_ID || (UPLOAD_DEMO_SOURCE ? 'doc_inkloop_v1_demo' : 'doc_3cfa06ac81d6');
const DEMO_FILENAME = process.env.INKLOOP_M103_DEMO_FILENAME || (UPLOAD_DEMO_SOURCE ? 'InkLoop V1 Demo.md' : 'AI时代的UX范式.pdf');
const DEMO_TITLE = DEMO_FILENAME.replace(/\.(md|markdown|pdf|epub)$/i, '');
const MANAGED_TEST_VAULT_NAME = 'InkLoop-Obsidian-Test-Vault';

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
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
  device_id: string;
  poll_token: string;
  qr_payload: string;
  user_code: string;
  expires_at: number;
}

interface MarkPersistenceEvidence {
  ok?: boolean;
  error?: string;
  mark_id?: string;
  before_count?: number;
  after_write_count?: number;
  after_reopen_count?: number;
  write_latency_ms?: number;
  active_document_id?: string;
  mark?: {
    mark_id?: string;
    page_id?: string;
    page_index?: number;
    feature_type?: string;
    marked_text?: string;
    bbox?: [number, number, number, number];
    created_at?: string;
  };
  restored_stroke_pages?: Array<{ page_id: string; strokes: number }>;
}

interface DeviceEvidence {
  boot: unknown;
  before: unknown;
  autoAppeared: unknown;
  opened: unknown;
  markPersistence: MarkPersistenceEvidence;
  sourceOpen?: unknown;
  syncActiveRuntime?: unknown;
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

function fail(message: string): never {
  throw new Error(message);
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
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
      if (page?.webSocketDebuggerUrl) {
        return { port, websocketUrl: page.webSocketDebuggerUrl, pageTitle: page.title || '' };
      }
    } catch {
      // WebView devtools socket can take a moment after am start.
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

async function uploadSource(documentId: string, filename: string, content: string, fileHash: string): Promise<void> {
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/source-files`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      document_id: documentId,
      filename,
      file_hash: fileHash,
      mime_type: 'text/markdown',
      size_bytes: Buffer.byteLength(content),
      page_count: 1,
      source: 'web',
      content_base64: Buffer.from(content).toString('base64'),
    }),
  });
  if (!response.ok) fail(`Cloud Hub upload failed HTTP ${response.status}: ${await response.text()}`);
}

async function ensureExistingCloudSource(documentId: string): Promise<{ file_hash?: string; filename?: string; mime_type?: string }> {
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/source-files/${encodeURIComponent(documentId)}`, {
    headers: headers(),
  });
  if (!response.ok) {
    fail(`Cloud Hub demo source is missing; set INKLOOP_M103_UPLOAD_DEMO_SOURCE=1 to create an isolated test document. document_id=${documentId}, HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as { file_hash?: string; filename?: string; mime_type?: string };
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
  return {
    'x-inkloop-tenant-id': TENANT_ID,
    'x-inkloop-user-id': USER_ID,
    'x-inkloop-device-id': DEVICE_ID,
    ...extra,
  };
}

async function authorizeLocalCloudHubDevice(): Promise<DeviceSession> {
  const create = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: 'M103 real-device E2E',
      platform: 'android-webview',
      requested_scopes: ['device_session'],
    }),
  });
  const flow = await create.json() as LocalAuthFlow;
  if (!create.ok || !flow.flow_id || !flow.poll_token || !flow.qr_payload) fail(`Cloud Hub local auth create failed HTTP ${create.status}: ${JSON.stringify(flow)}`);
  const scan = await fetch(flow.qr_payload);
  if (!scan.ok) fail(`Cloud Hub local auth scan failed HTTP ${scan.status}: ${await scan.text()}`);
  const status = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/status?poll_token=${encodeURIComponent(flow.poll_token)}`);
  const payload = await status.json() as { status?: string; session?: DeviceSession; error?: string };
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

async function fetchJson<T>(pathOrUrl: string, options: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${CLOUD_HUB_BASE}${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`${options.method || 'GET'} ${url} HTTP ${response.status}: ${text}`);
  return body as T;
}

async function waitForPostprocess(documentId: string, runtimeEventId: string): Promise<{
  aiTurn: CloudAiTurnRecord;
  knowledgeObject: KnowledgeObject;
  projection: DocumentProjection;
  aiTurns: CloudAiTurnRecord[];
  knowledgeObjects: KnowledgeObject[];
  projections: DocumentProjection[];
}> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [aiTurns, knowledge, projections] = await Promise.all([
      fetchJson<{ ai_turns: CloudAiTurnRecord[] }>(`/v1/knowledge/ai-turns?document_id=${encodeURIComponent(documentId)}`),
      fetchJson<{ objects: KnowledgeObject[] }>(`/v1/knowledge/objects?document_id=${encodeURIComponent(documentId)}`),
      fetchJson<{ document_projections: DocumentProjection[] }>(`/v1/knowledge/document-projections?document_id=${encodeURIComponent(documentId)}`),
    ]);
    const aiTurn = aiTurns.ai_turns.find((item) => item.metadata?.runtime_event_id === runtimeEventId);
    const knowledgeObject = knowledge.objects.find((item) => item.provenance.ai_turn_ids?.includes(aiTurn?.ai_turn_id || ''));
    const projection = projections.document_projections.find((item) => knowledgeObject && item.blocks.some((block) => block.knowledge_object_ids.includes(knowledgeObject.ko_id)));
    if (aiTurn && knowledgeObject && projection) {
      return {
        aiTurn,
        knowledgeObject,
        projection,
        aiTurns: aiTurns.ai_turns,
        knowledgeObjects: knowledge.objects,
        projections: projections.document_projections,
      };
    }
    await sleep(500);
  }
  fail(`Cloud Hub did not auto-persist post-processing output: document_id=${documentId}, runtime_event_id=${runtimeEventId}`);
}

async function waitForRuntimeMark(documentId: string, markId: string): Promise<RuntimeSyncEvent> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let cursor = '0';
    let guard = 0;
    while (guard < 20) {
      guard += 1;
      const pulled = await fetchJson<{ events: RuntimeSyncEvent[]; next_cursor?: string; has_more?: boolean }>(`/v1/runtime/events:pull?device_id=m103-real-device-obsidian-e2e&cursor=${encodeURIComponent(cursor)}&limit=100`);
      const event = pulled.events.find((item) => item.doc_id === documentId && item.operation === 'annotation.add'
        && (item.payload as { mark_id?: string } | undefined)?.mark_id === markId);
      if (event) return event;
      if (!pulled.has_more || !pulled.next_cursor || pulled.next_cursor === cursor) break;
      cursor = pulled.next_cursor;
    }
    await sleep(500);
  }
  fail(`Runtime sync did not expose the real device mark: document_id=${documentId}, mark_id=${markId}`);
}

async function writeRenderedVault(files: Array<{ path: string; markdown: string }>): Promise<void> {
  await rm(VAULT_ROOT, { recursive: true, force: true });
  for (const file of files) {
    const target = join(VAULT_ROOT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
  }
}

function isManagedActiveVault(): boolean {
  return process.env.INKLOOP_RESET_ACTIVE_OBSIDIAN_VAULT === '1'
    || basename(ACTIVE_OBSIDIAN_VAULT_ROOT) === MANAGED_TEST_VAULT_NAME;
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown.trim();
  const end = markdown.indexOf('\n---\n', 4);
  if (end < 0) return markdown.trim();
  return markdown.slice(end + '\n---\n'.length).trim();
}

function singleDemoNoteForActiveVault(files: Array<{ path: string; markdown: string }>): Array<{ path: string; markdown: string }> {
  const demoBaseDir = `InkLoop/Reading/${DEMO_TITLE}`;
  const hubPath = `${demoBaseDir}/${DEMO_TITLE}.md`;
  const hub = files.find((file) => file.path === hubPath);
  if (!hub) return files.filter((file) => file.path.startsWith('InkLoop/Reading/'));

  const noteBodies = files
    .filter((file) => file.path.startsWith(`${demoBaseDir}/`) && file.path !== hubPath)
    .map((file) => stripFrontmatter(file.markdown))
    .filter(Boolean);

  const hubWithoutGeneratedNoteLinks = hub.markdown.replace(/\n## 笔记\n[\s\S]*$/u, '').trim();
  const markdown = [
    hubWithoutGeneratedNoteLinks,
    '## 笔记',
    noteBodies.length ? noteBodies.join('\n\n---\n\n') : '暂无',
    '',
  ].join('\n\n');
  return [{ path: hubPath, markdown }];
}

async function mirrorRenderedFilesToActiveVault(files: Array<{ path: string; markdown: string }>): Promise<{ vault_root: string; rendered_file_count: number; files: string[] } | null> {
  if (!MIRROR_ACTIVE_VAULT) return null;
  try {
    await access(ACTIVE_OBSIDIAN_VAULT_ROOT);
  } catch {
    return null;
  }
  const managed = isManagedActiveVault();
  if (managed) {
    await rm(join(ACTIVE_OBSIDIAN_VAULT_ROOT, 'InkLoop'), { recursive: true, force: true });
    await rm(join(ACTIVE_OBSIDIAN_VAULT_ROOT, '.inkloop'), { recursive: true, force: true });
  }
  const filesToMirror = managed ? singleDemoNoteForActiveVault(files) : files.filter((file) => file.path.startsWith('InkLoop/Reading/'));
  if (!managed) {
    const folders = new Set(filesToMirror.map((file) => dirname(join(ACTIVE_OBSIDIAN_VAULT_ROOT, file.path))));
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  }
  const written: string[] = [];
  for (const file of filesToMirror) {
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
  const content = [
    `# ${DEMO_TITLE}`,
    '',
    `Last verified: ${runAt}`,
    '',
    'This is the single stable InkLoop V1 demo source file.',
    '',
    'Flow: Web import -> Cloud Hub -> Paper Library -> mark -> postprocess -> Obsidian projection.',
  ].join('\n');
  let fileHash = UPLOAD_DEMO_SOURCE ? sha256(content) : '';
  const documentId = DEMO_DOCUMENT_ID;
  const filename = DEMO_FILENAME;
  const session = await authorizeLocalCloudHubDevice();
  cloudSession = session;
  if (!UPLOAD_DEMO_SOURCE) {
    const existing = await ensureExistingCloudSource(documentId);
    fileHash = existing.file_hash || fileHash;
  }
  const { serial, pid } = await ensureDevice();
  const { port, websocketUrl, pageTitle } = await openDevtools(pid);

  const evidence = await withCdp(websocketUrl, async ({ evaluate }) => {
    await evaluate(`(() => {
      const session = ${browserSessionLiteral(session)};
      if (typeof window.__inkloop?.setApiRoute === 'function') {
        window.__inkloop.setApiRoute(${JSON.stringify(CLOUD_HUB_BASE)});
      } else {
        localStorage.setItem('inkloop.apiRoute', ${JSON.stringify(CLOUD_HUB_BASE)});
      }
      if (typeof window.__inkloop?.setDeviceSession === 'function') {
        window.__inkloop.setDeviceSession(session);
      } else {
        localStorage.setItem('inkloop.device.session.v1', JSON.stringify(session));
      }
      document.body.classList.remove('auth-open');
      const gate = document.getElementById('auth-gate');
      if (gate) gate.hidden = true;
      return true;
    })()`);
    const boot = await evaluate(`(() => ({
      href: location.href,
      title: document.title,
      hasInkLoop: !!window.__inkloop,
      keys: Object.keys(window.__inkloop || {}).sort()
    }))()`) as { hasInkLoop?: boolean; keys?: string[] };
    if (!boot.hasInkLoop || !boot.keys?.includes('listLibraryItems')) fail('InkLoop Paper runtime bridge is not exposed in WebView');
    await evaluate(`(async () => {
      document.querySelector('.nav [data-mode="read"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        mode: document.body.dataset.mode,
        read: document.body.dataset.read,
        writable: document.body.classList.contains('writable'),
        stageParent: document.getElementById('stage-wrap')?.parentElement?.id || ''
      };
    })()`);

    const before = await evaluate(`(async () => {
      const items = await window.__inkloop.listLibraryItems();
      return {
        count: items.length,
        target: items.find((item) => item.document_id === ${JSON.stringify(documentId)}) || null
      };
    })()`);

    if (UPLOAD_DEMO_SOURCE) {
      await uploadSource(documentId, filename, content, fileHash);
    }

    const autoAppeared = await evaluate(`(async () => {
      const started = Date.now();
      let last = null;
      while (Date.now() - started < 12000) {
        const items = await window.__inkloop.listLibraryItems();
        const target = items.find((item) => item.document_id === ${JSON.stringify(documentId)});
        if (target) {
          return {
            latency_ms: Date.now() - started,
            target: {
              document_id: target.document_id,
              filename: target.filename,
              source: target.source,
              sync_status: target.sync_status,
              local_available: target.local_available,
              cloud_available: target.cloud_available,
              cloud_blob_path: target.cloud_blob_path
            }
          };
        }
        last = items.slice(-5).map((item) => ({ document_id: item.document_id, sync_status: item.sync_status }));
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { latency_ms: null, target: null, last };
    })()`) as { latency_ms?: number | null; target?: { sync_status?: string; local_available?: boolean; cloud_available?: boolean; source?: string } | null; last?: unknown };
    if (!autoAppeared.target) fail(`device Library did not auto-appear within 12s: ${JSON.stringify(autoAppeared.last)}`);
    const autoStatusOk = autoAppeared.target.sync_status === 'cloud_only' || autoAppeared.target.sync_status === 'syncing' || autoAppeared.target.sync_status === 'synced';
    const sourceOk = UPLOAD_DEMO_SOURCE ? autoAppeared.target.source === 'web' : !!autoAppeared.target.source;
    if (!sourceOk || !autoStatusOk || autoAppeared.target.cloud_available !== true) {
      fail(`unexpected auto-appeared Library state: ${JSON.stringify(autoAppeared.target)}`);
    }

    const opened = await evaluate(`(async () => {
      let items = await window.__inkloop.listLibraryItems();
      let target = items.find((item) => item.document_id === ${JSON.stringify(documentId)});
      await window.__inkloop.downloadCloudLibraryItem(target);
      items = await window.__inkloop.listLibraryItems();
      target = items.find((item) => item.document_id === ${JSON.stringify(documentId)});
      const afterDownload = {
        document_id: target.document_id,
        filename: target.filename,
        source: target.source,
        sync_status: target.sync_status,
        local_available: target.local_available,
        cloud_available: target.cloud_available,
        page_count: target.page_count
      };
      await window.__inkloop.openBook(target.doc || target);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const context = window.__inkloop.getActiveContext?.();
      return {
        afterDownload,
        active: context && {
          documentId: context.documentId,
          pageCount: context.pageCount,
          surfaceType: context.surfaceType,
          syntheticKind: context.syntheticDoc?.kind,
          title: context.syntheticDoc?.title || context.docMeta?.Title,
          text: (context.syntheticDoc?.blocks || []).map((block) => block.text).join('\\n').slice(0, 500)
        }
      };
    })()`) as { afterDownload?: { sync_status?: string; local_available?: boolean; cloud_available?: boolean }; active?: { documentId?: string; syntheticKind?: string; text?: string } };
    if (opened.afterDownload?.sync_status !== 'synced' || opened.afterDownload.local_available !== true || opened.afterDownload.cloud_available !== true) {
      fail(`device download did not become local synced: ${JSON.stringify(opened.afterDownload)}`);
    }
    const expectedMarkdown = /\.(md|markdown)$/i.test(filename);
    if (opened.active?.documentId !== documentId || (expectedMarkdown && (opened.active.syntheticKind !== 'markdown' || !opened.active.text?.includes('single stable InkLoop V1 demo source file')))) {
      fail(`device did not open the downloaded source: ${JSON.stringify(opened.active)}`);
    }

    const markPersistence = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.__inkloop;
      if (!api || typeof api.createSyntheticReadingMark !== 'function') {
        return { ok: false, error: 'missing_createSyntheticReadingMark', keys: Object.keys(api || {}).sort() };
      }
      const before = await api.getFoldedMarks(${JSON.stringify(documentId)});
      const startedAt = performance.now();
      const synthetic = await api.createSyntheticReadingMark('handwriting');
      if (!synthetic?.ok || synthetic.document_id !== ${JSON.stringify(documentId)}) {
        return { ok: false, error: 'synthetic reading mark failed', synthetic };
      }
      let afterWrite = [];
      let created = null;
      let writeLatencyMs = null;
      for (let i = 0; i < 20; i += 1) {
        afterWrite = await api.getFoldedMarks(${JSON.stringify(documentId)});
        created = afterWrite.find((mark) => !before.some((old) => old.mark_id === mark.mark_id));
        if (created) {
          writeLatencyMs = Math.round(performance.now() - startedAt);
          break;
        }
        await sleep(150);
      }
      if (!created) return { ok: false, error: 'synthetic pen stroke did not persist to marks', before_count: before.length, after_count: afterWrite.length };
      await api.openBook((await api.listLibraryItems()).find((item) => item.document_id === ${JSON.stringify(documentId)}));
      await sleep(500);
      const afterReopen = await api.getFoldedMarks(${JSON.stringify(documentId)});
      const reopened = afterReopen.find((mark) => mark.mark_id === created.mark_id);
      return {
        ok: !!reopened,
        mark_id: created.mark_id,
        mark: {
          mark_id: created.mark_id,
          page_id: created.page_id,
          page_index: created.page_index,
          feature_type: created.feature_type,
          marked_text: created.marked_text,
          bbox: created.bbox,
          created_at: created.created_at
        },
        before_count: before.length,
        after_write_count: afterWrite.length,
        after_reopen_count: afterReopen.length,
        write_latency_ms: writeLatencyMs,
        active_document_id: api.getActiveContext?.()?.documentId,
        restored_stroke_pages: [...(api.getActiveContext?.()?.strokesByPage || new Map()).entries()].map(([pageId, strokes]) => ({ page_id: pageId, strokes: strokes.length })),
      };
    })()`) as MarkPersistenceEvidence;
    if (!markPersistence.ok) fail(`device mark did not persist across reopen: ${JSON.stringify(markPersistence)}`);
    const markId = markPersistence.mark_id || markPersistence.mark?.mark_id;
    if (!markId) fail(`device mark id is missing before source-open verification: ${JSON.stringify(markPersistence)}`);

    const sourceOpen = await evaluate(`(async () => {
      const api = window.__inkloop;
      if (!api || typeof api.openInkLoopUri !== 'function') {
        return { ok: false, error: 'missing_openInkLoopUri', keys: Object.keys(api || {}).sort() };
      }
      const uri = 'inkloop://doc/${documentId}?anchor=${encodeURIComponent(markId)}';
      const result = await api.openInkLoopUri(uri);
      return {
        ...result,
        active_document_id: api.getActiveContext?.()?.documentId,
        active_page_index: api.state?.pageIndex,
      };
    })()`) as {
      ok?: boolean;
      error?: string;
      document_id?: string;
      active_document_id?: string;
      anchor?: string;
      anchor_found?: boolean;
    };
    if (!sourceOpen.ok || sourceOpen.document_id !== documentId || sourceOpen.active_document_id !== documentId || sourceOpen.anchor !== markId || sourceOpen.anchor_found !== true) {
      fail(`source link did not reopen the marked document on device: ${JSON.stringify(sourceOpen)}`);
    }

    const syncActiveRuntime = await evaluate(`(async () => {
      await window.__inkloop.syncActiveRuntime();
      return { ok: true, active_document_id: window.__inkloop.getActiveContext?.()?.documentId };
    })()`);

    return { boot, before, autoAppeared, opened, markPersistence, sourceOpen, syncActiveRuntime };
  }) as DeviceEvidence;

  const markId = evidence.markPersistence.mark_id || evidence.markPersistence.mark?.mark_id;
  if (!markId) fail(`real device mark id is missing: ${JSON.stringify(evidence.markPersistence)}`);
  const runtimeEvent = await waitForRuntimeMark(documentId, markId);
  const postprocess = await waitForPostprocess(documentId, runtimeEvent.event_id);
  const persistedAiTurn = postprocess.aiTurn;
  const persistedKo = postprocess.knowledgeObject;
  const persistedProjection = postprocess.projection;
  if (!['accepted', 'inbox'].includes(persistedAiTurn.status) || !['accepted', 'inbox'].includes(persistedKo.status)) {
    fail(`Cloud Hub automatic post-processing did not persist a usable real-device mark candidate: ${JSON.stringify({ persistedAiTurn, persistedKo })}`);
  }
  if (persistedAiTurn.metadata?.llm_error) {
    fail(`Cloud Hub LLM gateway was not actually used for real-device post-processing: ${String(persistedAiTurn.metadata.llm_error)}`);
  }

  const runtimeAnnotation = (runtimeEvent.payload as { annotation?: { visual_strokes?: InkLoopVisualStroke[] } }).annotation;
  const renderedFiles = renderVaultMarkdown({
    entities: [{
      documentId,
      documentTitle: filename,
      mode: 'reading',
      dates: [runAt.slice(0, 10)],
      knowledgeObjects: [persistedKo],
      documentProjections: [persistedProjection],
      visualModel: {
        documentTitle: filename,
        blocks: [{
          id: 'blk_m103_real_device_1',
          kind: 'paragraph',
          region: 'editable',
          content: persistedProjection.blocks[0].text_md,
          annotations: [{
            ko_id: persistedKo.ko_id,
            kind: persistedKo.kind,
            title: persistedKo.title,
            body_md: persistedKo.body_md,
            render_mode: 'stroke_only',
            visual_strokes: runtimeAnnotation?.visual_strokes ?? [],
          }],
        }],
      },
    }],
  });
  await writeRenderedVault(renderedFiles);
  const activeVaultMirror = await mirrorRenderedFilesToActiveVault(renderedFiles);
  const obsidianInstall = await installObsidianPlugin(VAULT_ROOT, 'obsidian-m103-real-device-e2e');
  const activeObsidianInstall = activeVaultMirror
    ? await installObsidianPlugin(ACTIVE_OBSIDIAN_VAULT_ROOT, `obsidian_${ACTIVE_OBSIDIAN_VAULT_ROOT.split('/').at(-1) || 'active-vault'}`)
    : null;
  const hubFile = renderedFiles.find((file) => file.markdown.includes(`inkloop_document_id: "${documentId}"`) && file.path.includes('/Reading/'));
  const koFile = renderedFiles.find((file) => file.markdown.includes(`inkloop_knowledge_object_id: "${persistedKo.ko_id}"`));
  if (!hubFile || !koFile) fail('Obsidian renderer did not create real-device hub and KO notes');
  const koMarkdown = await readFile(join(VAULT_ROOT, koFile.path), 'utf8');
  if (!koMarkdown.includes(persistedKo.title) || !koMarkdown.includes('Backlink: inkloop://doc/')) {
    fail('Obsidian real-device KO markdown is not visibly rendered');
  }
  const activeVaultKoPath = activeVaultMirror && koFile
    ? join(ACTIVE_OBSIDIAN_VAULT_ROOT, koFile.path)
    : null;
  const activeVaultHubPath = activeVaultMirror && hubFile
    ? join(ACTIVE_OBSIDIAN_VAULT_ROOT, hubFile.path)
    : null;
  const activeVaultKoFile = activeVaultKoPath && activeVaultMirror?.files.includes(activeVaultKoPath)
    ? activeVaultKoPath
    : null;

  console.log(JSON.stringify({
    ok: true,
    latency_ms: Date.now() - started,
    device: { serial, pid, cdp_port: port, page_title: pageTitle },
    cloud_hub: { base_url: CLOUD_HUB_BASE, tenant_id: cloudSession?.tenant_id || TENANT_ID, user_id: cloudSession?.user_id || USER_ID, device_id: cloudSession?.device_id || DEVICE_ID },
    document: { document_id: documentId, filename, file_hash: fileHash },
    runtime_sync: {
      event_id: runtimeEvent.event_id,
      operation: runtimeEvent.operation,
      mark_id: (runtimeEvent.payload as { mark_id?: string }).mark_id,
      doc_id: runtimeEvent.doc_id,
    },
    postprocess: {
      llm_respond: persistedAiTurn.metadata?.classifier_respond,
      gateway_error: persistedAiTurn.metadata?.llm_error || null,
      reason: persistedAiTurn.response_md,
      ai_turn_id: persistedAiTurn.ai_turn_id,
      knowledge_object_id: persistedKo.ko_id,
      projection_id: persistedProjection.projection_id,
      persisted_ai_turns_for_document: postprocess.aiTurns.length,
      persisted_knowledge_objects_for_document: postprocess.knowledgeObjects.length,
      persisted_document_projections_for_document: postprocess.projections.length,
    },
    obsidian_projection: {
      vault_root: VAULT_ROOT,
      plugin_installed: !!(obsidianInstall as { ok?: boolean }).ok,
      rendered_file_count: renderedFiles.length,
      hub_file: hubFile ? join(VAULT_ROOT, hubFile.path) : null,
      ko_file: koFile ? join(VAULT_ROOT, koFile.path) : null,
      contains_visible_ko_content: koMarkdown.includes(persistedKo.title),
      active_vault_mirror: activeVaultMirror,
      active_vault_plugin_installed: !!(activeObsidianInstall as { ok?: boolean } | null)?.ok,
      active_vault_hub_file: activeVaultHubPath,
      active_vault_ko_file: activeVaultKoFile,
    },
    evidence,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
