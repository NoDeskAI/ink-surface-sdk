import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import net from 'node:net';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const RUN_ID = `device_status_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const DEVICE_ID = `paper_${RUN_ID}`;
const SPOOF_DEVICE_ID = `spoof_${RUN_ID}`;

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
  user_code: string;
  expires_at: number;
}

interface CloudDeviceRecord {
  device_id: string;
  tenant_id?: string;
  user_id?: string;
  platform?: string;
  status?: string;
  lan_import?: Record<string, unknown>;
  last_seen_at?: string;
}

function fail(message: string): never {
  throw new Error(message);
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

async function waitForCloudHub(baseUrl: string, child: ChildProcess): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) fail(`Cloud Hub exited early with code ${child.exitCode}: ${last}`);
    try {
      const response = await fetch(`${baseUrl}/v1/devices/manifest`);
      last = `${response.status} ${await response.text()}`;
      if (response.status === 401) return;
    } catch (error) {
      last = String((error as Error)?.message || error);
    }
    await sleep(100);
  }
  fail(`Cloud Hub did not become ready: ${last}`);
}

async function startCloudHub(rootDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const port = await freePort();
  const tsxCli = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [tsxCli, join(PACKAGE_ROOT, 'scripts/start-local-cloud-hub-product.ts')], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      INKLOOP_HTTPS_PORT: '0',
      INKLOOP_LOCAL_DEVICE_AUTH: '1',
      INKLOOP_LOCAL_DEVICE_AUTH_AUTO_APPROVE: '1',
      INKLOOP_LIBRARY_REQUIRE_SESSION: '1',
      INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION: '1',
      INKLOOP_KNOWLEDGE_REQUIRE_SESSION: '1',
      INKLOOP_DEVICE_REQUIRE_SESSION: '1',
      INKLOOP_LOCAL_AUTH_STORE: join(rootDir, 'auth-sessions.json'),
      INKLOOP_LIBRARY_STORE: join(rootDir, 'library'),
      INKLOOP_RUNTIME_SYNC_STORE: join(rootDir, 'runtime-events.jsonl'),
      INKLOOP_KNOWLEDGE_STORE: join(rootDir, 'knowledge'),
      INKLOOP_DEVICE_STORE: join(rootDir, 'devices'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  child.once('exit', () => {
    if (child.exitCode && logs.trim()) console.error(logs.trim());
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForCloudHub(baseUrl, child);
  return { baseUrl, child };
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try {
    await once(child, 'exit');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(baseUrl: string, path: string, options: RequestInit = {}): Promise<{ status: number; body: T; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body: body as T, text };
}

function authHeaders(session: DeviceSession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${session.session_token}`,
    'x-inkloop-tenant-id': `spoof_tenant_${RUN_ID}`,
    'x-inkloop-user-id': `spoof_user_${RUN_ID}`,
    'x-inkloop-device-id': SPOOF_DEVICE_ID,
    ...extra,
  };
}

async function authorizeDevice(baseUrl: string): Promise<DeviceSession> {
  const created = await fetchJson<LocalAuthFlow>(baseUrl, '/api/inkloop/auth/device-authorizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: 'InkLoop Paper DeviceStatus Smoke',
      platform: 'android-webview',
      requested_scopes: ['device_session', 'device_status'],
    }),
  });
  if (created.status !== 200 || !created.body.flow_id || !created.body.poll_token || !created.body.qr_payload) {
    fail(`create local device auth failed HTTP ${created.status}: ${created.text}`);
  }
  const scan = await fetch(created.body.qr_payload);
  if (!scan.ok) fail(`local auth scan failed HTTP ${scan.status}: ${await scan.text()}`);
  const status = await fetchJson<{ status?: string; session?: DeviceSession; error?: string }>(
    baseUrl,
    `/api/inkloop/auth/device-authorizations/${encodeURIComponent(created.body.flow_id)}/status?poll_token=${encodeURIComponent(created.body.poll_token)}`,
  );
  if (status.status !== 200 || status.body.status !== 'authorized' || !status.body.session?.session_token) {
    fail(`local auth status failed HTTP ${status.status}: ${status.text}`);
  }
  return status.body.session;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'inkloop-device-status-'));
  let first: { baseUrl: string; child: ChildProcess } | null = null;
  let second: { baseUrl: string; child: ChildProcess } | null = null;
  try {
    await mkdir(root, { recursive: true });
    first = await startCloudHub(root);

    const unauth = await fetchJson(first.baseUrl, '/v1/devices/manifest');
    expect(unauth.status === 401, `unauthenticated devices manifest should be 401, got ${unauth.status}`);

    const session = await authorizeDevice(first.baseUrl);
    const heartbeat = await fetchJson<{ ok?: boolean; device?: CloudDeviceRecord }>(first.baseUrl, '/v1/devices/heartbeat', {
      method: 'POST',
      headers: authHeaders(session, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        device_id: SPOOF_DEVICE_ID,
        platform: 'android-webview',
        app_surface: 'paper-runtime-host',
        status: 'syncing',
        api_base: first.baseUrl,
        lan_import: { running: true, port: 8787, wifi_lock_held: true },
        runtime_sync: { cursor: '266' },
        library: { cloud_only: 1, synced: 3 },
      }),
    });
    expect(heartbeat.status === 200 && heartbeat.body.ok, `heartbeat failed HTTP ${heartbeat.status}: ${heartbeat.text}`);
    expect(heartbeat.body.device?.device_id === session.device_id, 'heartbeat must use session device_id over spoofed headers/body');
    expect(heartbeat.body.device?.tenant_id === session.tenant_id, 'heartbeat must use session tenant_id');
    expect(heartbeat.body.device?.user_id === session.user_id, 'heartbeat must use session user_id');
    expect(heartbeat.body.device?.lan_import?.port === 8787, 'heartbeat did not persist LAN import status');

    const manifest = await fetchJson<{ devices: CloudDeviceRecord[] }>(first.baseUrl, '/v1/devices/manifest', {
      headers: authHeaders(session),
    });
    expect(manifest.status === 200, `manifest failed HTTP ${manifest.status}: ${manifest.text}`);
    expect(manifest.body.devices.length === 1, `expected one device, got ${manifest.body.devices.length}`);
    expect(manifest.body.devices[0].device_id === session.device_id, 'manifest returned the wrong device');

    const firstBaseUrl = first.baseUrl;
    await stopChild(first.child);
    first = null;
    second = await startCloudHub(root);
    const afterRestart = await fetchJson<{ devices: CloudDeviceRecord[] }>(second.baseUrl, '/v1/devices/manifest', {
      headers: authHeaders(session),
    });
    expect(afterRestart.status === 200, `manifest after restart failed HTTP ${afterRestart.status}: ${afterRestart.text}`);
    const restored = afterRestart.body.devices.find((device) => device.device_id === session.device_id);
    expect(restored, 'device status was not restored after Cloud Hub restart');
    expect(restored?.lan_import?.port === 8787, 'restored device lost LAN import status');

    console.log(JSON.stringify({
      ok: true,
      schema_version: 'inkloop.cloud_device_status_smoke.v1',
      cloud_hub: {
        require_session: true,
        first_base_url: firstBaseUrl,
        second_base_url: second.baseUrl,
        store_root: root,
      },
      auth: {
        session_authenticated: true,
        tenant_id: session.tenant_id,
        user_id: session.user_id,
        device_id: session.device_id,
        spoofed_device_id: SPOOF_DEVICE_ID,
      },
      heartbeat: {
        status: heartbeat.status,
        persisted_device_id: heartbeat.body.device?.device_id,
        platform: heartbeat.body.device?.platform,
        device_status: heartbeat.body.device?.status,
        lan_import: heartbeat.body.device?.lan_import,
      },
      persisted_after_restart: {
        device_count: afterRestart.body.devices.length,
        restored_device_id: restored?.device_id,
        restored_last_seen_at: restored?.last_seen_at,
        restored_lan_import: restored?.lan_import,
      },
    }, null, 2));
  } finally {
    await stopChild(first?.child || null);
    await stopChild(second?.child || null);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
