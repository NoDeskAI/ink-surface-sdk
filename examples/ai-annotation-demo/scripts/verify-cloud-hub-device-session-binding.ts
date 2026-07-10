import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const SHARED_SECRET = `secret_${Date.now().toString(36)}`;
const RUN_ID = `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const TENANT_ID = `tenant_${RUN_ID}`;
const USER_ID = `user_${RUN_ID}`;
const DEVICE_ID = `paper_${RUN_ID}`;
const SESSION_TOKEN = `sess_${RUN_ID}`;
const FLOW_ID = `flow_${RUN_ID}`;
const POLL_TOKEN = `poll_${RUN_ID}`;
const SPOOF_TENANT_ID = `tenant_spoof_${RUN_ID}`;
const SPOOF_USER_ID = `user_spoof_${RUN_ID}`;

interface DeviceSession {
  active: boolean;
  session_id: string;
  session_token: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  expires_at: number;
  feishu_open_id?: string | null;
}

interface PanelState {
  createCalls: number;
  statusCalls: number;
  ackCalls: number;
  introspectCalls: number;
  secrets: string[];
  session: DeviceSession;
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function secretOk(req: IncomingMessage, state: PanelState): boolean {
  const secret = String(req.headers['x-inkloop-secret'] || '');
  state.secrets.push(secret);
  return secret === SHARED_SECRET;
}

async function startMockPanel(): Promise<{ baseUrl: string; server: Server; state: PanelState }> {
  const port = await freePort();
  const state: PanelState = {
    createCalls: 0,
    statusCalls: 0,
    ackCalls: 0,
    introspectCalls: 0,
    secrets: [],
    session: {
      active: true,
      session_id: `sid_${RUN_ID}`,
      session_token: SESSION_TOKEN,
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      device_id: DEVICE_ID,
      expires_at: Date.now() + 3_600_000,
      feishu_open_id: `ou_${RUN_ID}`,
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/api/inkloop/auth/device-authorizations') {
      state.createCalls += 1;
      if (!secretOk(req, state)) return sendJson(res, 401, { error: 'bad_secret' });
      await readBody(req);
      return sendJson(res, 200, {
        flow_id: FLOW_ID,
        device_id: DEVICE_ID,
        poll_token: POLL_TOKEN,
        user_code: 'IL-0001',
        qr_payload: `inkloop://auth/device?flow_id=${FLOW_ID}`,
        expires_at: Date.now() + 300_000,
      });
    }

    if (req.method === 'GET' && url.pathname === `/api/inkloop/auth/device-authorizations/${FLOW_ID}/status`) {
      state.statusCalls += 1;
      if (!secretOk(req, state)) return sendJson(res, 401, { error: 'bad_secret' });
      if (url.searchParams.get('poll_token') !== POLL_TOKEN) return sendJson(res, 401, { error: 'bad_poll_token' });
      return sendJson(res, 200, {
        status: 'authorized',
        session: state.session,
      });
    }

    if (req.method === 'POST' && url.pathname === `/api/inkloop/auth/device-authorizations/${FLOW_ID}/ack`) {
      state.ackCalls += 1;
      if (!secretOk(req, state)) return sendJson(res, 401, { error: 'bad_secret' });
      await readBody(req);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/internal/inkloop/sessions/introspect') {
      state.introspectCalls += 1;
      if (!secretOk(req, state)) return sendJson(res, 401, { active: false, error: 'bad_secret' });
      const body = JSON.parse(await readBody(req) || '{}') as { session_token?: string };
      if (body.session_token !== SESSION_TOKEN) return sendJson(res, 401, { active: false, error: 'reauth_required' });
      return sendJson(res, 200, state.session);
    }

    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${port}`, server, state };
}

async function waitForCloudHub(baseUrl: string, child: ChildProcess): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) fail(`Cloud Hub exited early with code ${child.exitCode}: ${last}`);
    try {
      const response = await fetch(`${baseUrl}/v1/library/manifest`);
      last = `${response.status} ${await response.text()}`;
      if (response.status === 401) return;
    } catch (error) {
      last = String((error as Error)?.message || error);
    }
    await sleep(100);
  }
  fail(`Cloud Hub did not become ready: ${last}`);
}

async function startCloudHub(panelBaseUrl: string, rootDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const port = await freePort();
  const tsxCli = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [tsxCli, join(PACKAGE_ROOT, 'server/standalone.ts')], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      INKLOOP_HTTPS_PORT: '0',
      PANEL_AUTH_BASE: panelBaseUrl,
      INKLOOP_SHARED_SECRET: SHARED_SECRET,
      INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION: '1',
      INKLOOP_LIBRARY_REQUIRE_SESSION: '1',
      INKLOOP_KNOWLEDGE_REQUIRE_SESSION: '1',
      INKLOOP_RUNTIME_SYNC_STORE: join(rootDir, 'runtime-events.jsonl'),
      INKLOOP_LIBRARY_STORE: join(rootDir, 'library'),
      INKLOOP_KNOWLEDGE_STORE: join(rootDir, 'knowledge'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  child.once('exit', () => {
    if (logs.trim()) console.error(logs.trim());
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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${SESSION_TOKEN}`,
    'x-inkloop-tenant-id': SPOOF_TENANT_ID,
    'x-inkloop-user-id': SPOOF_USER_ID,
    'x-inkloop-device-id': 'spoofed-device',
    ...extra,
  };
}

function progressEvent(documentId: string): RuntimeSyncEvent {
  const now = new Date().toISOString();
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: `evt_${RUN_ID}`,
    source: 'inkloop_device',
    doc_id: documentId,
    operation: 'progress.update',
    target: { type: 'progress', id: `progress_${documentId}` },
    payload: {
      progress: {
        page_index: 0,
        updated_at: now,
      },
    },
    origin: { device_id: DEVICE_ID },
    status: 'pending',
    dedupe_key: `progress:${documentId}:${RUN_ID}`,
    created_at: now,
    updated_at: now,
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const rootDir = await mkdtemp(join(tmpdir(), 'inkloop-device-session-binding-'));
  let panel: Awaited<ReturnType<typeof startMockPanel>> | null = null;
  let cloud: Awaited<ReturnType<typeof startCloudHub>> | null = null;

  try {
    await mkdir(rootDir, { recursive: true });
    panel = await startMockPanel();
    cloud = await startCloudHub(panel.baseUrl, rootDir);

    const unauthorizedLibrary = await fetchJson(cloud.baseUrl, '/v1/library/manifest');
    if (unauthorizedLibrary.status !== 401) fail(`unauthenticated library manifest should be 401, got ${unauthorizedLibrary.status}`);

    const flow = await fetchJson<{ flow_id?: string; poll_token?: string; device_id?: string }>(cloud.baseUrl, '/api/inkloop/auth/device-authorizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_label: 'M103 local smoke' }),
    });
    if (flow.status !== 200 || flow.body.flow_id !== FLOW_ID || flow.body.poll_token !== POLL_TOKEN) fail(`device auth create failed: ${flow.status} ${flow.text}`);

    const status = await fetchJson<{ status?: string; session?: DeviceSession }>(cloud.baseUrl, `/api/inkloop/auth/device-authorizations/${FLOW_ID}/status?poll_token=${POLL_TOKEN}`);
    if (status.status !== 200 || status.body.status !== 'authorized' || status.body.session?.session_token !== SESSION_TOKEN) {
      fail(`device auth status did not return the session: ${status.status} ${status.text}`);
    }

    const ack = await fetchJson(cloud.baseUrl, `/api/inkloop/auth/device-authorizations/${FLOW_ID}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivered: true }),
    });
    if (ack.status !== 200) fail(`device auth ack failed: ${ack.status} ${ack.text}`);

    const content = Buffer.from(`# Device session binding\n\n${RUN_ID}\n`, 'utf8');
    const documentId = `doc_${sha256(content).slice(0, 12)}`;
    const upload = await fetchJson<{ ok?: boolean; document?: { document_id?: string; uploaded_by_device_id?: string } }>(cloud.baseUrl, '/v1/library/source-files', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        document_id: documentId,
        filename: `Device Session Binding ${RUN_ID}.md`,
        file_hash: sha256(content),
        mime_type: 'text/markdown',
        size_bytes: content.length,
        page_count: 1,
        source: 'web',
        content_base64: content.toString('base64'),
      }),
    });
    if (upload.status !== 200 || upload.body.document?.document_id !== documentId) fail(`session upload failed: ${upload.status} ${upload.text}`);
    if (upload.body.document.uploaded_by_device_id !== DEVICE_ID) fail('session device_id did not override spoofed device header');

    const realManifest = await fetchJson<{ documents: Array<{ document_id: string }> }>(cloud.baseUrl, '/v1/library/manifest', { headers: authHeaders() });
    if (!realManifest.body.documents.some((item) => item.document_id === documentId)) fail('session user manifest is missing uploaded document');
    const spoofManifest = await fetchJson<{ documents: Array<{ document_id: string }> }>(cloud.baseUrl, '/v1/library/manifest', {
      headers: {
        'x-inkloop-tenant-id': SPOOF_TENANT_ID,
        'x-inkloop-user-id': SPOOF_USER_ID,
      },
    });
    if (spoofManifest.status !== 401) fail(`header-only spoof manifest should be 401 when session is required, got ${spoofManifest.status}`);

    const runtimePush = await fetchJson<{ acks?: Array<{ event_id: string; ok: boolean; server_sequence?: number; error?: string }> }>(cloud.baseUrl, '/v1/runtime/events:push', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: DEVICE_ID,
        events: [progressEvent(documentId)],
      }),
    });
    const runtimeAck = runtimePush.body.acks?.[0];
    if (runtimePush.status !== 200 || !runtimeAck?.ok || !runtimeAck.server_sequence) fail(`runtime push failed: ${runtimePush.status} ${runtimePush.text}`);

    const runtimePull = await fetchJson<{ events?: RuntimeSyncEvent[]; next_cursor?: string }>(cloud.baseUrl, '/v1/runtime/events:pull?device_id=obsidian-session-smoke&cursor=0', {
      headers: authHeaders(),
    });
    if (!runtimePull.body.events?.some((item) => item.event_id === runtimeAck.event_id)) fail('session user runtime pull is missing pushed event');
    const invalidRuntime = await fetchJson(cloud.baseUrl, '/v1/runtime/events:pull?device_id=bad&cursor=0', {
      headers: { authorization: 'Bearer invalid_token' },
    });
    if (invalidRuntime.status !== 401) fail(`invalid runtime session should be 401, got ${invalidRuntime.status}`);

    const aiTurnId = `turn_${RUN_ID}`;
    const knowledgeWrite = await fetchJson<{ ok?: boolean; ai_turn?: { ai_turn_id?: string } }>(cloud.baseUrl, '/v1/knowledge/ai-turns', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        ai_turn: {
          schema_version: 'inkloop.cloud_hub.ai_turn.v1',
          ai_turn_id: aiTurnId,
          document_id: documentId,
          mark_ids: [`mark_${RUN_ID}`],
          prompt_md: 'Device session binding smoke',
          response_md: 'Session-scoped postprocess output',
          status: 'accepted',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: { run_id: RUN_ID },
        },
      }),
    });
    if (knowledgeWrite.status !== 200 || knowledgeWrite.body.ai_turn?.ai_turn_id !== aiTurnId) fail(`knowledge write failed: ${knowledgeWrite.status} ${knowledgeWrite.text}`);

    const knowledgeRead = await fetchJson<{ ai_turns?: Array<{ ai_turn_id: string }> }>(cloud.baseUrl, `/v1/knowledge/ai-turns?document_id=${encodeURIComponent(documentId)}`, {
      headers: authHeaders(),
    });
    if (!knowledgeRead.body.ai_turns?.some((item) => item.ai_turn_id === aiTurnId)) fail('session user knowledge read is missing ai_turn');

    const realBlob = await fetch(`${cloud.baseUrl}/v1/library/source-files/${encodeURIComponent(documentId)}/blob`, {
      headers: authHeaders(),
    });
    const realBlobText = await realBlob.text();
    if (!realBlob.ok || realBlobText !== content.toString('utf8')) fail(`session user blob read failed: ${realBlob.status} ${realBlobText}`);

    const persistedAfterRestart = {
      runtime_event_id: runtimeAck.event_id,
      runtime_cursor: runtimePull.body.next_cursor,
    };
    await stopChild(cloud.child);
    cloud = await startCloudHub(panel.baseUrl, rootDir);
    const manifestAfterRestart = await fetchJson<{ documents: Array<{ document_id: string }> }>(cloud.baseUrl, '/v1/library/manifest', { headers: authHeaders() });
    const runtimeAfterRestart = await fetchJson<{ events?: RuntimeSyncEvent[]; next_cursor?: string }>(cloud.baseUrl, '/v1/runtime/events:pull?device_id=obsidian-session-smoke&cursor=0', {
      headers: authHeaders(),
    });
    const knowledgeAfterRestart = await fetchJson<{ ai_turns?: Array<{ ai_turn_id: string }> }>(cloud.baseUrl, `/v1/knowledge/ai-turns?document_id=${encodeURIComponent(documentId)}`, {
      headers: authHeaders(),
    });
    if (!manifestAfterRestart.body.documents.some((item) => item.document_id === documentId)) fail('library document was not persistent across Cloud Hub restart');
    if (!runtimeAfterRestart.body.events?.some((item) => item.event_id === runtimeAck.event_id)) fail('runtime event was not persistent across Cloud Hub restart');
    if (!knowledgeAfterRestart.body.ai_turns?.some((item) => item.ai_turn_id === aiTurnId)) fail('knowledge ai_turn was not persistent across Cloud Hub restart');

    console.log(JSON.stringify({
      ok: true,
      latency_ms: Date.now() - started,
      cloud_hub: {
        require_session: {
          library: true,
          runtime_sync: true,
          knowledge: true,
        },
        base_url: cloud.baseUrl,
        store_root: rootDir,
      },
      auth_proxy: {
        panel_base_url: panel.baseUrl,
        flow_id: FLOW_ID,
        session_tenant_id: TENANT_ID,
        session_user_id: USER_ID,
        session_device_id: DEVICE_ID,
        create_calls: panel.state.createCalls,
        status_calls: panel.state.statusCalls,
        ack_calls: panel.state.ackCalls,
        introspect_calls: panel.state.introspectCalls,
        all_proxy_calls_used_shared_secret: panel.state.secrets.every((item) => item === SHARED_SECRET),
      },
      namespace_binding: {
        spoofed_header_tenant_id: SPOOF_TENANT_ID,
        spoofed_header_user_id: SPOOF_USER_ID,
        source_file_visible_to_session_user: true,
        header_only_spoof_rejected: true,
        uploaded_by_device_id: upload.body.document.uploaded_by_device_id,
      },
      persisted_after_restart: {
        document_id: documentId,
        ai_turn_id: aiTurnId,
        ...persistedAfterRestart,
        runtime_events_after_restart: runtimeAfterRestart.body.events?.length || 0,
      },
    }, null, 2));
  } finally {
    await stopChild(cloud?.child || null);
    await closeServer(panel?.server || null);
    await rm(rootDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
