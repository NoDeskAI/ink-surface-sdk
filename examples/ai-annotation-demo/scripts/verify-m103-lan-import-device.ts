import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const TENANT_ID = process.env.INKLOOP_TENANT_ID || 'local';
const USER_ID = process.env.INKLOOP_USER_ID || 'local_demo';
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'm103-lan-import-e2e';

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

interface LanImportState {
  running?: boolean;
  port?: number;
  ip?: string | null;
  url?: string | null;
  token?: string | null;
  inbox?: Array<{ name: string; path: string; size?: number; uploadedAt?: number }>;
  error?: string;
}

interface LibraryItemEvidence {
  document_id: string;
  filename: string;
  source: string;
  sync_status: string;
  local_available: boolean;
  cloud_available: boolean;
  cloud_blob_path?: string;
  page_count?: number;
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

let cloudSession: DeviceSession | null = null;

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
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

async function postMultipart(url: string, filename: string, content: string, mimeType: string): Promise<{ status: number; text: string }> {
  const form = new FormData();
  form.set('file', new File([content], filename, { type: mimeType }));
  const response = await fetchWithTimeout(url, { method: 'POST', body: form }, 8_000);
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

async function cloudManifestHas(documentId: string): Promise<boolean> {
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/manifest`, { headers: headers() });
  if (!response.ok) fail(`Cloud Hub manifest failed HTTP ${response.status}: ${await response.text()}`);
  const manifest = await response.json() as { documents?: Array<{ document_id?: string }> };
  return !!manifest.documents?.some((item) => item.document_id === documentId);
}

async function authorizeLocalCloudHubDevice(): Promise<DeviceSession> {
  const create = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: 'M103 LAN import E2E',
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

async function main(): Promise<void> {
  const started = Date.now();
  const runAt = new Date().toISOString();
  const content = [
    '# M103 LAN Import E2E',
    '',
    `Run: ${runAt}`,
    '',
    'This Markdown file was uploaded through InkLoop Paper Wi-Fi LAN import and should become local-first before Cloud Hub sync.',
  ].join('\n');
  const fileHash = sha256(content);
  const documentId = `doc_${fileHash.slice(0, 12)}`;
  const filename = `M103 LAN Import E2E ${runAt.replace(/[:.]/g, '-')}.md`;

  const session = await authorizeLocalCloudHubDevice();
  cloudSession = session;
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
            title: document.querySelector('#files .fh .ti')?.textContent || '',
            urlText: document.querySelector('.lanurl')?.textContent || '',
            hasQr: !!document.querySelector('.lanqr img')
          }
        };
      })()`) as { lan?: LanImportState; ui?: Record<string, unknown> };
      if (!state.lan?.running || state.lan.port !== 8787 || (!state.lan.url && !state.lan.token)) {
        fail(`LAN import server did not start on fixed port 8787: ${JSON.stringify(state)}`);
      }

      const uploadBase = await chooseUploadBase(state.lan);
      forwardPort = uploadBase.forwardPort;

      const noToken = await fetchWithTimeout(`${uploadBase.base}/state`, {}, 5_000);
      const wrongToken = await fetchWithTimeout(`${uploadBase.base}/state?token=wrong-token`, {}, 5_000);
      const unsupported = await postMultipart(`${uploadBase.base}/upload?token=${encodeURIComponent(uploadBase.token)}`, 'unsupported.txt', 'not allowed', 'text/plain');
      const uploaded = await postMultipart(`${uploadBase.base}/upload?token=${encodeURIComponent(uploadBase.token)}`, filename, content, 'text/markdown');
      if (noToken.status !== 403 || wrongToken.status !== 403 || unsupported.status !== 415 || uploaded.status !== 200) {
        fail(`LAN import token/type checks failed: ${JSON.stringify({ noToken: noToken.status, wrongToken: wrongToken.status, unsupported: unsupported.status, uploaded: uploaded.status })}`);
      }
      if (!uploaded.text.includes('/?token=')) fail('LAN upload success page does not preserve token on the upload-another link');

      const imported = await evaluate(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const documentId = ${JSON.stringify(documentId)};
        let last = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await window.__inkloop.openFileBrowser();
          await sleep(250);
          const items = await window.__inkloop.listLibraryItems();
          const target = items.find((item) => item.document_id === documentId);
	          if (target?.local_available && target.source === 'paper_wifi') {
	            return {
	              target: {
                document_id: target.document_id,
                filename: target.filename,
                source: target.source,
                sync_status: target.sync_status,
                local_available: target.local_available,
                cloud_available: target.cloud_available,
                cloud_blob_path: target.cloud_blob_path,
                page_count: target.page_count
              },
              state: window.__inkloop.readLanImportState()
            };
          }
          last = items.slice(-8).map((item) => ({ document_id: item.document_id, source: item.source, sync_status: item.sync_status, local_available: item.local_available, cloud_available: item.cloud_available }));
          await sleep(500);
        }
        return { target: null, last, state: window.__inkloop.readLanImportState() };
      })()`) as { target?: LibraryItemEvidence | null; last?: unknown; state?: LanImportState };
      if (!imported.target) fail(`LAN upload did not become local-readable in Paper Library: ${JSON.stringify(imported)}`);
      if (imported.target.source !== 'paper_wifi' || imported.target.local_available !== true) {
        fail(`LAN import did not preserve local-first paper_wifi state: ${JSON.stringify(imported.target)}`);
      }

      const synced = await evaluate(`(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const documentId = ${JSON.stringify(documentId)};
        let last = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const items = await window.__inkloop.listLibraryItems();
          const target = items.find((item) => item.document_id === documentId);
          if (target?.sync_status === 'synced' && target?.cloud_available === true) {
            return {
              document_id: target.document_id,
              filename: target.filename,
              source: target.source,
              sync_status: target.sync_status,
              local_available: target.local_available,
              cloud_available: target.cloud_available,
              cloud_blob_path: target.cloud_blob_path,
              page_count: target.page_count
            };
          }
          last = target && {
            document_id: target.document_id,
            source: target.source,
            sync_status: target.sync_status,
            local_available: target.local_available,
            cloud_available: target.cloud_available,
            error: target.error
          };
          await sleep(500);
        }
        return last;
      })()`) as LibraryItemEvidence | null;
      if (!synced || synced.sync_status !== 'synced' || synced.cloud_available !== true || synced.local_available !== true) {
        fail(`LAN import did not background-sync to Cloud Hub: ${JSON.stringify(synced)}`);
      }

      const opened = await evaluate(`(async () => {
        const documentId = ${JSON.stringify(documentId)};
        const items = await window.__inkloop.listLibraryItems();
        const target = items.find((item) => item.document_id === documentId);
        await window.__inkloop.openBook(target.doc || target);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const context = window.__inkloop.getActiveContext?.();
        return {
          documentId: context?.documentId,
          pageCount: context?.pageCount,
          surfaceType: context?.surfaceType,
          syntheticKind: context?.syntheticDoc?.kind,
          title: context?.syntheticDoc?.title || context?.docMeta?.Title,
          text: (context?.syntheticDoc?.blocks || []).map((block) => block.text).join('\\n').slice(0, 600)
        };
      })()`) as { documentId?: string; syntheticKind?: string; text?: string };
      if (opened.documentId !== documentId || opened.syntheticKind !== 'markdown' || !opened.text?.includes('local-first before Cloud Hub sync')) {
        fail(`LAN-imported source did not open as Markdown article: ${JSON.stringify(opened)}`);
      }

      return { boot, lan_start: state, upload: { ...uploadBase, token: '[redacted]' }, token_checks: { no_token: noToken.status, wrong_token: wrongToken.status, unsupported_type: unsupported.status, upload: uploaded.status }, imported, synced, opened };
    });

    const manifestContainsDocument = await cloudManifestHas(documentId);
    if (!manifestContainsDocument) fail(`Cloud Hub manifest does not contain LAN-imported document: ${documentId}`);

    console.log(JSON.stringify({
	      ok: true,
	      latency_ms: Date.now() - started,
	      device: { serial, pid, cdp_port: port, page_title: pageTitle },
	      cloud_hub: {
	        base_url: CLOUD_HUB_BASE,
	        tenant_id: cloudSession?.tenant_id || TENANT_ID,
	        user_id: cloudSession?.user_id || USER_ID,
	        device_id: cloudSession?.device_id || DEVICE_ID,
	        manifest_contains_document: manifestContainsDocument,
	      },
      document: { document_id: documentId, filename, file_hash: fileHash },
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
