import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const TENANT_ID = process.env.INKLOOP_TENANT_ID || 'local';
const USER_ID = process.env.INKLOOP_USER_ID || 'local_demo';
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'm103-web-import-formats-e2e';
const PACKAGE_ROOT = resolve(process.cwd());

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
  device_id: string;
  poll_token: string;
  qr_payload: string;
  user_code: string;
  expires_at: number;
}

interface FormatFixture {
  kind: 'markdown' | 'pdf' | 'epub';
  filename: string;
  mime_type: string;
  bytes: Buffer;
  page_count: number;
}

interface UploadedFixture extends FormatFixture {
  document_id: string;
  file_hash: string;
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
      device_label: 'M103 web import format coverage E2E',
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

function minimalPdfBytes(): Buffer {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 44 >> stream',
    'BT /F1 18 Tf 36 96 Td (InkLoop PDF import) Tj ET',
    'endstream endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.from(pdf);
}

function minimalEpubBytes(): Buffer {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OPS/package.opf': strToU8('<?xml version="1.0"?><package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">inkloop-format-e2e</dc:identifier><dc:title>InkLoop EPUB Import</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
    'OPS/nav.xhtml': strToU8('<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>'),
    'OPS/chapter.xhtml': strToU8('<!doctype html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>InkLoop EPUB Import</h1><p>EPUB Cloud Hub first import fixture.</p></body></html>'),
  };
  return Buffer.from(zipSync(files));
}

function buildFixtures(runAt: string): UploadedFixture[] {
  const fixtures: FormatFixture[] = [
    {
      kind: 'markdown',
      filename: `InkLoop Web Import Markdown ${runAt.replace(/[:.]/g, '-')}.md`,
      mime_type: 'text/markdown',
      bytes: Buffer.from(`# InkLoop Markdown import\n\nRun: ${runAt}\n\nCloud Hub first import fixture.\n`),
      page_count: 1,
    },
    {
      kind: 'pdf',
      filename: `InkLoop Web Import PDF ${runAt.replace(/[:.]/g, '-')}.pdf`,
      mime_type: 'application/pdf',
      bytes: minimalPdfBytes(),
      page_count: 1,
    },
    {
      kind: 'epub',
      filename: `InkLoop Web Import EPUB ${runAt.replace(/[:.]/g, '-')}.epub`,
      mime_type: 'application/epub+zip',
      bytes: minimalEpubBytes(),
      page_count: 1,
    },
  ];
  return fixtures.map((fixture) => {
    const fileHash = sha256(fixture.bytes);
    const runScopedId = sha256(`${runAt}:${fixture.kind}:${fileHash}`).slice(0, 12);
    return {
      ...fixture,
      file_hash: fileHash,
      document_id: `doc_fmt_${fixture.kind}_${runScopedId}`,
    };
  });
}

async function uploadSource(session: DeviceSession, fixture: UploadedFixture): Promise<void> {
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/source-files`, {
    method: 'POST',
    headers: headers(session, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      document_id: fixture.document_id,
      filename: fixture.filename,
      file_hash: fixture.file_hash,
      mime_type: fixture.mime_type,
      size_bytes: fixture.bytes.length,
      page_count: fixture.page_count,
      source: 'web',
      content_base64: fixture.bytes.toString('base64'),
    }),
  });
  if (!response.ok) fail(`Cloud Hub upload failed for ${fixture.kind} HTTP ${response.status}: ${await response.text()}`);
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

  for (const fixture of fixtures) await uploadSource(session, fixture);
  const manifest = await fetchManifest(session) as { documents?: Array<{ document_id?: string; mime_type?: string; source?: string; blob?: { sha256?: string } }> };
  const manifestDocs = fixtures.map((fixture) => manifest.documents?.find((doc) => doc.document_id === fixture.document_id));
  for (let i = 0; i < fixtures.length; i += 1) {
    const fixture = fixtures[i];
    const doc = manifestDocs[i];
    if (!doc || doc.mime_type !== fixture.mime_type || doc.source !== 'web' || doc.blob?.sha256 !== fixture.file_hash) {
      fail(`Cloud Hub manifest did not preserve ${fixture.kind} source metadata: ${JSON.stringify({ fixture, doc })}`);
    }
  }

  const expectedDeviceItems = fixtures.map((fixture) => ({
    kind: fixture.kind,
    document_id: fixture.document_id,
    filename: fixture.filename,
    mime_type: fixture.mime_type,
    file_hash: fixture.file_hash,
  }));
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
      keys: Object.keys(window.__inkloop || {}).sort()
    }))()`) as { hasInkLoop?: boolean; keys?: string[] };
    if (!boot.hasInkLoop || !boot.keys?.includes('listLibraryItems') || !boot.keys?.includes('downloadCloudLibraryItem')) {
      fail(`InkLoop Paper Library bridge is not complete in WebView: ${JSON.stringify(boot)}`);
    }

    return await evaluate(`(async () => {
      const expected = ${JSON.stringify(expectedDeviceItems)};
      const appeared = await (async () => {
        const started = Date.now();
        let last = [];
        while (Date.now() - started < 15000) {
          const items = await window.__inkloop.listLibraryItems();
          const byId = new Map(items.map((item) => [item.document_id, item]));
          const hits = expected.map((item) => {
            const hit = byId.get(item.document_id);
            return hit && {
              kind: item.kind,
              document_id: hit.document_id,
              filename: hit.filename,
              source: hit.source,
              sync_status: hit.sync_status,
              local_available: hit.local_available,
              cloud_available: hit.cloud_available,
              cloud_blob_path: hit.cloud_blob_path,
              mime_type: hit.mime_type,
            };
          });
          if (hits.every(Boolean)) return { latency_ms: Date.now() - started, items: hits };
          last = items.slice(-8).map((item) => ({ document_id: item.document_id, sync_status: item.sync_status, source: item.source }));
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return { latency_ms: null, items: [], last };
      })();
      if (!appeared.items.length) return { boot: ${JSON.stringify(boot)}, appeared, downloaded: [] };

      const downloaded = [];
      for (const item of expected) {
        let items = await window.__inkloop.listLibraryItems();
        let target = items.find((candidate) => candidate.document_id === item.document_id);
        await window.__inkloop.downloadCloudLibraryItem(target);
        items = await window.__inkloop.listLibraryItems();
        target = items.find((candidate) => candidate.document_id === item.document_id);
        downloaded.push({
          kind: item.kind,
          document_id: target?.document_id,
          filename: target?.filename,
          source: target?.source,
          sync_status: target?.sync_status,
          local_available: target?.local_available,
          cloud_available: target?.cloud_available,
          page_count: target?.page_count,
        });
      }
      return { boot: ${JSON.stringify(boot)}, appeared, downloaded };
    })()`);
  }) as {
    boot: unknown;
    appeared: { latency_ms?: number | null; items?: Array<{ kind?: string; source?: string; sync_status?: string; local_available?: boolean; cloud_available?: boolean }>; last?: unknown };
    downloaded: Array<{ kind?: string; document_id?: string; source?: string; sync_status?: string; local_available?: boolean; cloud_available?: boolean; page_count?: number }>;
  };

  if (!evidence.appeared.items?.length) fail(`device Library did not auto-appear for PDF/EPUB/Markdown within 15s: ${JSON.stringify(evidence.appeared.last)}`);
  for (const item of evidence.appeared.items) {
    if (item.source !== 'web' || item.sync_status !== 'cloud_only' || item.local_available !== false || item.cloud_available !== true) {
      fail(`unexpected Library auto-appeared format state: ${JSON.stringify(item)}`);
    }
  }
  for (const item of evidence.downloaded) {
    if (item.source !== 'web' || item.sync_status !== 'synced' || item.local_available !== true || item.cloud_available !== true) {
      fail(`format source did not download to local synced state: ${JSON.stringify(item)}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    latency_ms: Date.now() - started,
    package_root: PACKAGE_ROOT,
    device: { serial, pid, cdp_port: port, page_title: pageTitle },
    cloud_hub: {
      base_url: CLOUD_HUB_BASE,
      tenant_id: session.tenant_id || TENANT_ID,
      user_id: session.user_id || USER_ID,
      device_id: session.device_id || DEVICE_ID,
      manifest_document_count: manifestDocs.length,
    },
    uploaded_formats: fixtures.map((fixture) => ({
      kind: fixture.kind,
      document_id: fixture.document_id,
      filename: fixture.filename,
      mime_type: fixture.mime_type,
      file_hash: fixture.file_hash,
      size_bytes: fixture.bytes.length,
    })),
    evidence,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
