import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import type { KnowledgeObject } from '../../../packages/knowledge-schema/src/index';
import type { RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const RUN_ID = `controlled_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const TENANT_ID = `tenant_${RUN_ID}`;
const USER_ID = `user_${RUN_ID}`;
const DEVICE_ID = `obsidian_${RUN_ID}`;
const DOC_ID = `doc_${RUN_ID}`;
const KO_ID = `ko_${RUN_ID}`;
const EVENT_ID = `evt_${RUN_ID}`;

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
  if (!address || typeof address === 'string') fail('failed to allocate local port');
  return address.port;
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

async function startCloudHub(rootDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
  const port = await freePort();
  const tsxCli = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const child = spawn(process.execPath, [tsxCli, join(PACKAGE_ROOT, 'server/standalone.ts')], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      INKLOOP_HTTPS_PORT: '0',
      INKLOOP_LOCAL_DEVICE_AUTH: '1',
      INKLOOP_LOCAL_AUTH_STORE: join(rootDir, 'auth-sessions.json'),
      INKLOOP_LOCAL_AUTH_TENANT_ID: TENANT_ID,
      INKLOOP_LOCAL_AUTH_USER_ID: USER_ID,
      INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION: '1',
      INKLOOP_LIBRARY_REQUIRE_SESSION: '1',
      INKLOOP_KNOWLEDGE_REQUIRE_SESSION: '1',
      INKLOOP_RUNTIME_SYNC_STORE: join(rootDir, 'runtime-events.jsonl'),
      INKLOOP_LIBRARY_STORE: join(rootDir, 'library'),
      INKLOOP_KNOWLEDGE_STORE: join(rootDir, 'knowledge'),
      INKLOOP_DEVICE_STORE: join(rootDir, 'devices'),
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

function authHeaders(session: DeviceSession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${session.session_token}`,
    'x-inkloop-tenant-id': session.tenant_id,
    'x-inkloop-user-id': session.user_id,
    'x-inkloop-device-id': session.device_id,
    ...extra,
  };
}

async function authorize(baseUrl: string): Promise<DeviceSession> {
  const create = await fetch(`${baseUrl}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: 'Obsidian controlled writeback smoke',
      platform: 'obsidian',
      requested_scopes: ['device_session'],
    }),
  });
  const flow = await create.json() as LocalAuthFlow;
  if (!create.ok || !flow.flow_id || !flow.poll_token || !flow.qr_payload) fail(`local auth create failed HTTP ${create.status}: ${JSON.stringify(flow)}`);
  const scan = await fetch(flow.qr_payload);
  if (!scan.ok) fail(`local auth scan failed HTTP ${scan.status}: ${await scan.text()}`);
  const status = await fetch(`${baseUrl}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/status?poll_token=${encodeURIComponent(flow.poll_token)}`);
  const payload = await status.json() as { status?: string; session?: DeviceSession; error?: string };
  if (!status.ok || payload.status !== 'authorized' || !payload.session?.session_token) fail(`local auth status failed HTTP ${status.status}: ${JSON.stringify(payload)}`);
  await fetch(`${baseUrl}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poll_token: flow.poll_token }),
  });
  return payload.session;
}

function knowledgeObject(now: string): KnowledgeObject {
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: KO_ID,
    kind: 'meeting_risk',
    title: 'Controlled writeback risk',
    body_md: 'Initial risk body.',
    source: {
      document_id: DOC_ID,
      document_title: 'Controlled Writeback Source',
      page_id: `pg_${RUN_ID}_1`,
      page_index: 0,
      object_refs: [`mark_${RUN_ID}`],
      inkloop_uri: `inkloop://doc/${DOC_ID}?anchor=mark_${RUN_ID}`,
    },
    provenance: { created_from: 'ai_turn', mark_ids: [`mark_${RUN_ID}`], ai_turn_ids: [`turn_${RUN_ID}`] },
    tags: ['inkloop', 'inkloop/meeting_risk'],
    status: 'accepted',
    privacy: 'export_allowed',
    render_hints: { markdown_callout: 'warning' },
    content_hash: `sha256:${sha256(`ko:${RUN_ID}`)}`,
    created_at: now,
    updated_at: now,
  };
}

function updateEvent(now: string): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: EVENT_ID,
    source: 'obsidian_plugin',
    doc_id: DOC_ID,
    operation: 'knowledge.update',
    target: { type: 'knowledge_object', id: KO_ID },
    payload: {
      ko_id: KO_ID,
      patch: {
        status: 'edited',
        tags: ['inkloop', 'inkloop/meeting_risk', 'customer-confirmed'],
        task_done: true,
        risk_status: 'mitigated',
        risk_note: 'Supplier has a backup part.',
        comment_md: 'Verified from Obsidian controlled field edit.',
      },
      source: 'obsidian_controlled_fields',
    },
    origin: { device_id: DEVICE_ID },
    status: 'pending',
    dedupe_key: EVENT_ID,
    created_at: now,
    updated_at: now,
  };
}

async function postJson<T>(baseUrl: string, path: string, session: DeviceSession, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(session, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`${path} HTTP ${response.status}: ${text}`);
  return data as T;
}

async function listObjects(baseUrl: string, session: DeviceSession): Promise<KnowledgeObject[]> {
  const response = await fetch(`${baseUrl}/v1/knowledge/objects?document_id=${encodeURIComponent(DOC_ID)}`, {
    headers: authHeaders(session),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`/v1/knowledge/objects HTTP ${response.status}: ${text}`);
  return Array.isArray(data.objects) ? data.objects as KnowledgeObject[] : [];
}

function assertPatched(object: KnowledgeObject | undefined, label: string): KnowledgeObject {
  if (!object) fail(`${label}: missing KnowledgeObject ${KO_ID}`);
  if (object.status !== 'edited') fail(`${label}: status was not patched: ${object.status}`);
  if (!object.tags.includes('customer-confirmed')) fail(`${label}: tags were not patched: ${JSON.stringify(object.tags)}`);
  if (object.controlled_fields?.task_done !== true) fail(`${label}: task_done was not patched`);
  if (object.controlled_fields?.risk_status !== 'mitigated') fail(`${label}: risk_status was not patched`);
  if (object.controlled_fields?.risk_note !== 'Supplier has a backup part.') fail(`${label}: risk_note was not patched`);
  if (object.controlled_fields?.comment_md !== 'Verified from Obsidian controlled field edit.') fail(`${label}: comment_md was not patched`);
  return object;
}

async function waitForPatchedObject(baseUrl: string, session: DeviceSession): Promise<KnowledgeObject> {
  let last: KnowledgeObject | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    last = (await listObjects(baseUrl, session)).find((item) => item.ko_id === KO_ID);
    if (last?.controlled_fields?.risk_status === 'mitigated') return assertPatched(last, 'after runtime update');
    await sleep(100);
  }
  fail(`controlled fields were not persisted: ${JSON.stringify(last)}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), 'inkloop-controlled-writeback-'));
  let cloud: { baseUrl: string; child: ChildProcess } | null = null;
  try {
    cloud = await startCloudHub(root);
    const session = await authorize(cloud.baseUrl);
    const now = new Date().toISOString();
    await postJson(cloud.baseUrl, '/v1/knowledge/objects', session, { object: knowledgeObject(now) });
    const push = await postJson<{ acks?: Array<{ event_id?: string; ok?: boolean; server_sequence?: number }> }>(cloud.baseUrl, '/v1/runtime/events:push', session, {
      schema_version: 'inkloop.runtime_sync_batch.v1',
      device_id: DEVICE_ID,
      events: [updateEvent(now)],
    });
    if (push.acks?.[0]?.ok !== true) fail(`runtime push failed: ${JSON.stringify(push)}`);
    const patched = await waitForPatchedObject(cloud.baseUrl, session);

    await stopChild(cloud.child);
    cloud = await startCloudHub(root);
    const afterRestart = assertPatched((await listObjects(cloud.baseUrl, session)).find((item) => item.ko_id === KO_ID), 'after restart');

    console.log(JSON.stringify({
      ok: true,
      latency_ms: Date.now() - started,
      cloud_hub: {
        auth_mode: 'session',
        tenant_id: session.tenant_id,
        user_id: session.user_id,
        device_id: session.device_id,
      },
      runtime: {
        event_id: EVENT_ID,
        server_sequence: push.acks?.[0]?.server_sequence,
      },
      knowledge: {
        document_id: DOC_ID,
        ko_id: KO_ID,
        status: patched.status,
        controlled_fields: patched.controlled_fields,
        persisted_after_restart: afterRestart.controlled_fields,
      },
    }, null, 2));
  } finally {
    await stopChild(cloud?.child ?? null);
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
