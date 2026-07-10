import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import type { RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const RUN_ID = `local_auth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface LocalAuthFlow {
  flow_id: string;
  device_id: string;
  poll_token: string;
  qr_payload: string;
  user_code: string;
  expires_at: number;
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

interface RuntimeAck {
  event_id: string;
  ok: boolean;
  server_sequence?: number;
  error?: string;
}

interface CloudAiTurnRecord {
  ai_turn_id: string;
  document_id: string;
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
      const response = await fetch(`${baseUrl}/healthz`);
      last = `${response.status} ${await response.text()}`;
      if (response.ok) return;
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
      INKLOOP_LIBRARY_REQUIRE_SESSION: '1',
      INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION: '1',
      INKLOOP_KNOWLEDGE_REQUIRE_SESSION: '1',
      INKLOOP_TENANT_ID: 'local',
      INKLOOP_USER_ID: `user_${RUN_ID}`,
      INKLOOP_LOCAL_AUTH_STORE: join(rootDir, 'auth-sessions.json'),
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

async function fetchJson<T>(baseUrlOrUrl: string, pathOrOptions?: string | RequestInit, maybeOptions: RequestInit = {}): Promise<{ status: number; body: T; text: string }> {
  const url = typeof pathOrOptions === 'string' ? `${baseUrlOrUrl}${pathOrOptions}` : baseUrlOrUrl;
  const options = typeof pathOrOptions === 'string' ? maybeOptions : pathOrOptions || {};
  const response = await fetch(url, options);
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
    'x-inkloop-device-id': 'spoofed-device',
    ...extra,
  };
}

async function authorizeLocalDevice(baseUrl: string): Promise<DeviceSession> {
  const flow = await fetchJson<LocalAuthFlow>(baseUrl, '/api/inkloop/auth/device-authorizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ install_id: `paper_${RUN_ID}`, device_label: 'InkLoop local Cloud Hub smoke' }),
  });
  if (flow.status !== 200 || !flow.body.flow_id || !flow.body.poll_token || !flow.body.qr_payload) {
    fail(`local auth create failed: ${flow.status} ${flow.text}`);
  }

  const pending = await fetchJson<{ status?: string }>(baseUrl, `/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.body.flow_id)}/status?poll_token=${encodeURIComponent(flow.body.poll_token)}`);
  if (pending.status !== 200 || pending.body.status !== 'pending') fail(`local auth should start pending: ${pending.status} ${pending.text}`);

  const scan = await fetch(flow.body.qr_payload);
  if (!scan.ok) fail(`local auth scan failed: ${scan.status} ${await scan.text()}`);

  const status = await fetchJson<{ status?: string; session?: DeviceSession }>(baseUrl, `/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.body.flow_id)}/status?poll_token=${encodeURIComponent(flow.body.poll_token)}`);
  if (status.status !== 200 || status.body.status !== 'authorized' || !status.body.session?.session_token) {
    fail(`local auth status did not return session: ${status.status} ${status.text}`);
  }

  const ack = await fetchJson(baseUrl, `/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.body.flow_id)}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poll_token: flow.body.poll_token }),
  });
  if (ack.status !== 200) fail(`local auth ack failed: ${ack.status} ${ack.text}`);
  return status.body.session;
}

async function waitForStreamManifest(baseUrl: string, session: DeviceSession): Promise<{ promise: Promise<number>; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/library/stream`, {
    headers: authHeaders(session),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) fail(`library stream failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) fail('library stream closed before ready');
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.indexOf('\n\n');
    if (boundary < 0) continue;
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (frame.includes('event: ready')) break;
  }
  return {
    promise: (async () => {
      const started = Date.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) fail('library stream closed before manifest update');
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          if (frame.includes('event: manifest')) return Date.now() - started;
        }
      }
    })().finally(() => reader.cancel().catch(() => undefined)),
    close: () => controller.abort(),
  };
}

function annotationEvent(documentId: string, eventId: string): RuntimeSyncEvent {
  const now = new Date().toISOString();
  const markId = `mark_${RUN_ID}`;
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: eventId,
    source: 'inkloop_device',
    doc_id: documentId,
    operation: 'annotation.add',
    target: { type: 'annotation', id: `ko_${RUN_ID}`, block_id: 'blk_local_auth_smoke' },
    payload: {
      block_id: 'blk_local_auth_smoke',
      mark_id: markId,
      marked_text: 'Cloud Hub local device auth E2E mark',
      annotation: {
        ko_id: `ko_${RUN_ID}`,
        title: '本地 Cloud Hub 标记闭环',
        body_md: '验证外部导入、墨水屏标记、Cloud Hub 后处理和 Obsidian 投影使用同一个 document_id。',
        visual_strokes: [{
          tool: 'pen',
          color: '#111111',
          points: [{ x: 0.1, y: 0.2 }, { x: 0.35, y: 0.22 }, { x: 0.55, y: 0.24 }],
        }],
      },
    },
    origin: { device_id: 'paper-local-auth-smoke' },
    status: 'pending',
    dedupe_key: `${documentId}:${markId}`,
    created_at: now,
    updated_at: now,
  };
}

async function waitForPostprocess(baseUrl: string, session: DeviceSession, documentId: string, runtimeEventId: string): Promise<{
  aiTurn: CloudAiTurnRecord;
  koId: string;
  projectionId: string;
  gatewayError: string | null;
}> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [aiTurns, objects, projections] = await Promise.all([
      fetchJson<{ ai_turns?: CloudAiTurnRecord[] }>(baseUrl, `/v1/knowledge/ai-turns?document_id=${encodeURIComponent(documentId)}`, { headers: authHeaders(session) }),
      fetchJson<{ objects?: Array<{ ko_id: string; source?: { document_id?: string }; provenance?: { ai_turn_ids?: string[] } }> }>(baseUrl, `/v1/knowledge/objects?document_id=${encodeURIComponent(documentId)}`, { headers: authHeaders(session) }),
      fetchJson<{ document_projections?: Array<{ projection_id: string; document_id: string; blocks?: Array<{ knowledge_object_ids?: string[] }> }> }>(baseUrl, `/v1/knowledge/document-projections?document_id=${encodeURIComponent(documentId)}`, { headers: authHeaders(session) }),
    ]);
    const aiTurn = aiTurns.body.ai_turns?.find((item) => item.metadata?.runtime_event_id === runtimeEventId);
    const ko = objects.body.objects?.find((item) => item.source?.document_id === documentId && item.provenance?.ai_turn_ids?.includes(aiTurn?.ai_turn_id || ''));
    const projection = projections.body.document_projections?.find((item) =>
      item.document_id === documentId && item.blocks?.some((block) => block.knowledge_object_ids?.includes(ko?.ko_id || '')));
    if (aiTurn && ko && projection) {
      return {
        aiTurn,
        koId: ko.ko_id,
        projectionId: projection.projection_id,
        gatewayError: typeof aiTurn.metadata?.llm_error === 'string' ? aiTurn.metadata.llm_error : null,
      };
    }
    await sleep(500);
  }
  fail(`postprocess output was not persisted for ${documentId}/${runtimeEventId}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  const rootDir = await mkdtemp(join(tmpdir(), 'inkloop-local-device-auth-'));
  let cloud: Awaited<ReturnType<typeof startCloudHub>> | null = null;
  try {
    await mkdir(rootDir, { recursive: true });
    cloud = await startCloudHub(rootDir);

    const health = await fetchJson<{ ok?: boolean; require_session?: Record<string, boolean> }>(cloud.baseUrl, '/healthz');
    if (!health.body.ok || !health.body.require_session?.library || !health.body.require_session.runtime_sync || !health.body.require_session.knowledge) {
      fail(`healthz did not expose session-required product mode: ${health.text}`);
    }

    const unauthManifest = await fetchJson(cloud.baseUrl, '/v1/library/manifest');
    const unauthRuntime = await fetchJson(cloud.baseUrl, '/v1/runtime/events:pull?device_id=paper&cursor=0');
    const unauthKnowledge = await fetchJson(cloud.baseUrl, '/v1/knowledge/ai-turns');
    if (unauthManifest.status !== 401 || unauthRuntime.status !== 401 || unauthKnowledge.status !== 401) {
      fail(`unauthenticated requests should be rejected: library=${unauthManifest.status} runtime=${unauthRuntime.status} knowledge=${unauthKnowledge.status}`);
    }

    const session = await authorizeLocalDevice(cloud.baseUrl);
    const stream = await waitForStreamManifest(cloud.baseUrl, session);
    const content = Buffer.from(`# InkLoop local Cloud Hub E2E\n\n${RUN_ID}\n`, 'utf8');
    const documentId = `doc_${sha256(content).slice(0, 12)}`;
    const uploadStarted = Date.now();
    const upload = await fetchJson<{ ok?: boolean; document?: { document_id?: string; uploaded_by_device_id?: string } }>(cloud.baseUrl, '/v1/library/source-files', {
      method: 'POST',
      headers: authHeaders(session, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        document_id: documentId,
        filename: `InkLoop Local Cloud Hub E2E ${RUN_ID}.md`,
        file_hash: sha256(content),
        mime_type: 'text/markdown',
        size_bytes: content.length,
        page_count: 1,
        source: 'web',
        content_base64: content.toString('base64'),
      }),
    });
    const uploadLatency = Date.now() - uploadStarted;
    const manifestLatency = await stream.promise;
    stream.close();
    if (upload.status !== 200 || upload.body.document?.document_id !== documentId) fail(`source upload failed: ${upload.status} ${upload.text}`);
    if (upload.body.document.uploaded_by_device_id !== session.device_id) fail('session device_id did not override spoofed upload header');

    const runtimeEventId = `evt_${RUN_ID}`;
    const runtimePushStarted = Date.now();
    const runtimePush = await fetchJson<{ acks?: RuntimeAck[] }>(cloud.baseUrl, '/v1/runtime/events:push', {
      method: 'POST',
      headers: authHeaders(session, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: session.device_id,
        events: [annotationEvent(documentId, runtimeEventId)],
      }),
    });
    const runtimePushLatency = Date.now() - runtimePushStarted;
    const ack = runtimePush.body.acks?.[0];
    if (runtimePush.status !== 200 || !ack?.ok || !ack.server_sequence) fail(`runtime push failed: ${runtimePush.status} ${runtimePush.text}`);

    const runtimePull = await fetchJson<{ events?: RuntimeSyncEvent[]; next_cursor?: string }>(cloud.baseUrl, '/v1/runtime/events:pull?device_id=obsidian-local-auth-smoke&cursor=0', {
      headers: authHeaders(session),
    });
    if (!runtimePull.body.events?.some((item) => item.event_id === runtimeEventId && item.doc_id === documentId)) {
      fail('runtime pull did not preserve the Cloud Library document_id');
    }

    const postprocess = await waitForPostprocess(cloud.baseUrl, session, documentId, runtimeEventId);
    if (postprocess.aiTurn.document_id !== documentId) fail('ai_turn document_id diverged from Cloud Library document_id');
    if (postprocess.gatewayError) fail(`LLM gateway postprocess failed: ${postprocess.gatewayError}`);

    await stopChild(cloud.child);
    cloud = await startCloudHub(rootDir);
    const afterRestartManifest = await fetchJson<{ documents?: Array<{ document_id: string }> }>(cloud.baseUrl, '/v1/library/manifest', {
      headers: authHeaders(session),
    });
    const afterRestartRuntime = await fetchJson<{ events?: RuntimeSyncEvent[] }>(cloud.baseUrl, '/v1/runtime/events:pull?device_id=obsidian-local-auth-smoke&cursor=0', {
      headers: authHeaders(session),
    });
    const afterRestartKnowledge = await fetchJson<{ ai_turns?: CloudAiTurnRecord[] }>(cloud.baseUrl, `/v1/knowledge/ai-turns?document_id=${encodeURIComponent(documentId)}`, {
      headers: authHeaders(session),
    });
    if (!afterRestartManifest.body.documents?.some((item) => item.document_id === documentId)) fail('library document missing after restart');
    if (!afterRestartRuntime.body.events?.some((item) => item.event_id === runtimeEventId)) fail('runtime event missing after restart');
    if (!afterRestartKnowledge.body.ai_turns?.some((item) => item.ai_turn_id === postprocess.aiTurn.ai_turn_id)) fail('ai_turn missing after restart');

    console.log(JSON.stringify({
      ok: true,
      run_id: RUN_ID,
      latency_ms: Date.now() - started,
      cloud_hub: {
        base_url: cloud.baseUrl,
        store_root: rootDir,
        local_device_auth: true,
        session_required: true,
      },
      auth: {
        tenant_id: session.tenant_id,
        user_id: session.user_id,
        device_id: session.device_id,
        session_persisted_after_restart: true,
      },
      library: {
        document_id: documentId,
        upload_latency_ms: uploadLatency,
        manifest_sse_latency_ms: manifestLatency,
      },
      runtime_sync: {
        event_id: runtimeEventId,
        server_sequence: ack.server_sequence,
        push_latency_ms: runtimePushLatency,
        cursor_after_pull: runtimePull.body.next_cursor,
        doc_id_matches_library: true,
      },
      postprocess: {
        ai_turn_id: postprocess.aiTurn.ai_turn_id,
        ko_id: postprocess.koId,
        projection_id: postprocess.projectionId,
        gateway_error: postprocess.gatewayError,
        persisted_after_restart: true,
      },
    }, null, 2));
  } finally {
    await stopChild(cloud?.child || null);
    await rm(rootDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
