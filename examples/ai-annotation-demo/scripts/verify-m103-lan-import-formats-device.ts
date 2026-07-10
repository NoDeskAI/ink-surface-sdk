import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const TENANT_ID = process.env.INKLOOP_TENANT_ID || 'local';
const USER_ID = process.env.INKLOOP_USER_ID || 'local_demo';
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'm103-lan-import-formats-e2e';

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

interface LanImportState {
  running?: boolean;
  port?: number;
  ip?: string | null;
  url?: string | null;
  token?: string | null;
  wifi_lock_held?: boolean;
  inbox?: Array<{ name: string; path: string; size?: number; uploadedAt?: number }>;
  error?: string;
}

interface FormatFixture {
  kind: 'markdown' | 'pdf' | 'epub';
  filename: string;
  mime_type: string;
  bytes: Buffer;
  page_count: number;
  document_id: string;
  file_hash: string;
}

interface DeviceFormatItem {
  kind?: string;
  document_id?: string;
  filename?: string;
  source?: string;
  sync_status?: string;
  local_available?: boolean;
  cloud_available?: boolean;
  cloud_blob_path?: string;
  mime_type?: string;
  page_count?: number;
  error?: string;
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

async function adb(args: string[], options: { optional?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ADB, args, { timeout: 15_000 });
    return String(stdout || '').trim();
  } catch (error) {
    if (options.optional) return '';
    throw error;
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

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postMultipart(url: string, filename: string, content: Buffer, mimeType: string): Promise<{ status: number; text: string }> {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(content)], filename, { type: mimeType }));
  const response = await fetchWithTimeout(url, { method: 'POST', body: form }, 10_000);
  return { status: response.status, text: await response.text() };
}

async function chooseUploadBase(state: LanImportState): Promise<{ base: string; token: string; transport: 'direct_lan' | 'adb_forward'; forwardPort?: number }> {
  const parsed = state.url ? new URL(state.url) : null;
  const token = parsed?.searchParams.get('token') || state.token || '';
  if (!token) fail(`LAN import URL is missing token: ${state.url}`);
  if (parsed) {
    const directBase = parsed.origin;
    try {
      const response = await fetchWithTimeout(`${directBase}/state?token=${encodeURIComponent(token)}`, {}, 2_000);
      if (response.ok) {
        const body = await response.json() as LanImportState;
        if (body.running) return { base: directBase, token, transport: 'direct_lan' };
      }
    } catch {
      // Fallback below still verifies the on-device HTTP server and token contract.
    }
  }
  const forwardPort = await freePort();
  await adb(['forward', `tcp:${forwardPort}`, 'tcp:8787']);
  return { base: `http://127.0.0.1:${forwardPort}`, token, transport: 'adb_forward', forwardPort };
}

function headers(session: DeviceSession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${session.session_token}`,
    'x-inkloop-tenant-id': session.tenant_id,
    'x-inkloop-user-id': session.user_id,
    'x-inkloop-device-id': session.device_id,
    ...extra,
  };
}

async function authorizeLocalCloudHubDevice(): Promise<DeviceSession> {
  const create = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: 'M103 LAN import format coverage E2E',
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

function minimalPdfBytes(runAt: string): Buffer {
  const stream = `BT /F1 18 Tf 36 96 Td (InkLoop LAN PDF ${runAt}) Tj ET`;
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream`,
    stream,
    'endstream endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n'));
}

function minimalEpubBytes(runAt: string): Buffer {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OPS/package.opf': strToU8(`<?xml version="1.0"?><package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">inkloop-lan-format-e2e-${runAt}</dc:identifier><dc:title>InkLoop LAN EPUB</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    'OPS/nav.xhtml': strToU8('<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>'),
    'OPS/chapter.xhtml': strToU8(`<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>InkLoop LAN EPUB</h1><p>EPUB local-first LAN import fixture.</p><p>Run: ${runAt}</p></body></html>`),
  };
  return Buffer.from(zipSync(files));
}

function buildFixtures(runAt: string): FormatFixture[] {
  const stamp = runAt.replace(/[:.]/g, '-');
  const base: Array<Omit<FormatFixture, 'document_id' | 'file_hash'>> = [
    {
      kind: 'markdown',
      filename: `InkLoop LAN Markdown ${stamp}.md`,
      mime_type: 'text/markdown',
      bytes: Buffer.from(`# InkLoop LAN Markdown\n\nRun: ${runAt}\n\nLocal-first LAN import fixture.\n`),
      page_count: 1,
    },
    {
      kind: 'pdf',
      filename: `InkLoop LAN PDF ${stamp}.pdf`,
      mime_type: 'application/pdf',
      bytes: minimalPdfBytes(runAt),
      page_count: 1,
    },
    {
      kind: 'epub',
      filename: `InkLoop LAN EPUB ${stamp}.epub`,
      mime_type: 'application/epub+zip',
      bytes: minimalEpubBytes(runAt),
      page_count: 1,
    },
  ];
  return base.map((fixture) => {
    const fileHash = sha256(fixture.bytes);
    return { ...fixture, file_hash: fileHash, document_id: `doc_${fileHash.slice(0, 12)}` };
  });
}

async function fetchManifest(session: DeviceSession): Promise<Record<string, unknown>> {
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/manifest`, { headers: headers(session) });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) fail(`Cloud Hub manifest failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
  const started = Date.now();
  const runAt = new Date().toISOString();
  const fixtures = buildFixtures(runAt);
  const session = await authorizeLocalCloudHubDevice();
  const { serial, pid } = await ensureDevice();
  const { port, websocketUrl, pageTitle } = await openDevtools(pid);
  let forwardPort: number | undefined;

  try {
    const evidence = await withCdp(websocketUrl, async ({ evaluate }) => {
      await evaluate(`(() => {
        localStorage.setItem('inkloop.device.session.v1', ${JSON.stringify(browserSessionLiteral(session))});
        document.body.classList.remove('auth-open');
        const gate = document.getElementById('auth-gate');
        if (gate) gate.hidden = true;
        return true;
      })()`);
      const boot = await evaluate(`(() => ({
        href: location.href,
        title: document.title,
        hasInkLoop: !!window.__inkloop,
        hasLanBridge: !!window.InkLoopLanImport,
        keys: Object.keys(window.__inkloop || {}).sort()
      }))()`) as { hasInkLoop?: boolean; hasLanBridge?: boolean; keys?: string[] };
      if (!boot.hasInkLoop || !boot.hasLanBridge || !boot.keys?.includes('openFileBrowser') || !boot.keys?.includes('readLanImportState')) {
        fail(`InkLoop Paper LAN import hooks are not exposed: ${JSON.stringify(boot)}`);
      }

      const state = await evaluate(`(async () => {
        const start = JSON.parse(window.InkLoopLanImport.start());
        for (const entry of (start.inbox || [])) {
          try { window.InkLoopLanImport.delete(entry.path); } catch {}
        }
        await window.__inkloop.openFileBrowser();
        await new Promise((resolve) => setTimeout(resolve, 800));
        return {
          lan: window.__inkloop.readLanImportState(),
          ui: {
            filesOpen: document.body.classList.contains('files-open'),
            urlText: document.querySelector('.lanurl')?.textContent || '',
            hasQr: !!document.querySelector('.lanqr img')
          }
        };
      })()`) as { lan?: LanImportState; ui?: Record<string, unknown> };
      if (!state.lan?.running || state.lan.port !== 8787 || (!state.lan.url && !state.lan.token) || state.lan.wifi_lock_held !== true) {
        fail(`LAN import server did not start on fixed port 8787 with Wi-Fi lock: ${JSON.stringify(state)}`);
      }

      const uploadBase = await chooseUploadBase(state.lan);
      forwardPort = uploadBase.forwardPort;
      const noToken = await fetchWithTimeout(`${uploadBase.base}/state`, {}, 5_000);
      const wrongToken = await fetchWithTimeout(`${uploadBase.base}/state?token=wrong-token`, {}, 5_000);
      const unsupported = await postMultipart(`${uploadBase.base}/upload?token=${encodeURIComponent(uploadBase.token)}`, 'unsupported.txt', Buffer.from('not allowed'), 'text/plain');
      if (noToken.status !== 403 || wrongToken.status !== 403 || unsupported.status !== 415) {
        fail(`LAN import token/type checks failed: ${JSON.stringify({ noToken: noToken.status, wrongToken: wrongToken.status, unsupported: unsupported.status })}`);
      }

      const uploaded = [];
      for (const fixture of fixtures) {
        const result = await postMultipart(`${uploadBase.base}/upload?token=${encodeURIComponent(uploadBase.token)}`, fixture.filename, fixture.bytes, fixture.mime_type);
        uploaded.push({ kind: fixture.kind, status: result.status, contains_token_link: result.text.includes('/?token=') });
        if (result.status !== 200 || !result.text.includes('/?token=')) {
          fail(`LAN ${fixture.kind} upload failed: ${JSON.stringify(result)}`);
        }
      }

      const deviceEvidence = await evaluate(`(async () => {
        const expected = ${JSON.stringify(fixtures.map((fixture) => ({
          kind: fixture.kind,
          document_id: fixture.document_id,
          filename: fixture.filename,
          mime_type: fixture.mime_type,
          file_hash: fixture.file_hash,
        })))};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const summarize = (item, kind) => item && {
          kind,
          document_id: item.document_id,
          filename: item.filename,
          source: item.source,
          sync_status: item.sync_status,
          local_available: item.local_available,
          cloud_available: item.cloud_available,
          cloud_blob_path: item.cloud_blob_path,
          mime_type: item.mime_type,
          page_count: item.page_count,
          error: item.error,
        };
        const waitFor = async (predicate, timeoutMs) => {
          const started = Date.now();
          let last = null;
          while (Date.now() - started < timeoutMs) {
            await window.__inkloop.openFileBrowser();
            await sleep(300);
            const items = await window.__inkloop.listLibraryItems();
            const byId = new Map(items.map((item) => [item.document_id, item]));
            const hits = expected.map((item) => summarize(byId.get(item.document_id), item.kind));
            if (hits.every(Boolean) && hits.every(predicate)) return { latency_ms: Date.now() - started, items: hits };
            last = hits;
            await sleep(500);
          }
          return { latency_ms: null, items: [], last };
        };
        const localFirst = await waitFor((item) => item.source === 'paper_wifi' && item.local_available === true, 25000);
        const synced = await waitFor((item) => item.source === 'paper_wifi' && item.local_available === true && item.cloud_available === true && item.sync_status === 'synced', 35000);
        return { localFirst, synced, lanState: window.__inkloop.readLanImportState() };
      })()`) as {
        localFirst?: { latency_ms?: number | null; items?: DeviceFormatItem[]; last?: unknown };
        synced?: { latency_ms?: number | null; items?: DeviceFormatItem[]; last?: unknown };
        lanState?: LanImportState;
      };
      return { boot, lan_start: state, upload: { ...uploadBase, token: '[redacted]' }, token_checks: { no_token: noToken.status, wrong_token: wrongToken.status, unsupported_type: unsupported.status }, uploaded, ...deviceEvidence };
    });

    if (!evidence.localFirst?.items?.length) fail(`LAN format import did not become local-first: ${JSON.stringify(evidence.localFirst?.last)}`);
    for (const item of evidence.localFirst.items) {
      if (item.source !== 'paper_wifi' || item.local_available !== true) fail(`LAN format did not preserve local-first paper_wifi state: ${JSON.stringify(item)}`);
    }
    if (!evidence.synced?.items?.length) fail(`LAN format import did not sync to Cloud Hub: ${JSON.stringify(evidence.synced?.last)}`);
    for (const item of evidence.synced.items) {
      if (item.source !== 'paper_wifi' || item.sync_status !== 'synced' || item.local_available !== true || item.cloud_available !== true) {
        fail(`LAN format did not reach synced state: ${JSON.stringify(item)}`);
      }
    }

    const manifest = await fetchManifest(session) as { documents?: Array<{ document_id?: string; mime_type?: string; source?: string; blob?: { sha256?: string } }> };
    const manifestDocs = fixtures.map((fixture) => manifest.documents?.find((doc) => doc.document_id === fixture.document_id));
    for (let i = 0; i < fixtures.length; i += 1) {
      const fixture = fixtures[i];
      const doc = manifestDocs[i];
      if (!doc || doc.mime_type !== fixture.mime_type || doc.source !== 'paper_wifi' || doc.blob?.sha256 !== fixture.file_hash) {
        fail(`Cloud Hub manifest did not preserve LAN ${fixture.kind} metadata: ${JSON.stringify({ fixture, doc })}`);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      latency_ms: Date.now() - started,
      device: { serial, pid, cdp_port: port, page_title: pageTitle },
      cloud_hub: {
        base_url: CLOUD_HUB_BASE,
        tenant_id: session.tenant_id || TENANT_ID,
        user_id: session.user_id || USER_ID,
        device_id: session.device_id || DEVICE_ID,
        manifest_document_count: manifestDocs.length,
      },
      imported_formats: fixtures.map((fixture) => ({
        kind: fixture.kind,
        document_id: fixture.document_id,
        filename: fixture.filename,
        mime_type: fixture.mime_type,
        file_hash: fixture.file_hash,
        size_bytes: fixture.bytes.length,
      })),
      evidence,
    }, null, 2));
  } finally {
    if (forwardPort) await adb(['forward', '--remove', `tcp:${forwardPort}`], { optional: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
