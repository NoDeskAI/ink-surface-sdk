import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
let CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || '').replace(/\/+$/, '');
const RUN_ID = `iso_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const TENANT_ID = `tenant_${RUN_ID}`;
const USER_A = 'user_a';
const USER_B = 'user_b';
const USER_C = 'user_c';
const USERS = [USER_A, USER_B, USER_C] as const;
const SHARED_DOC_ID = `doc_${RUN_ID}`;
const SHARED_EVENT_ID = `evt_${RUN_ID}`;
const SHARED_KO_ID = `ko_${RUN_ID}`;
const SHARED_TURN_ID = `turn_${RUN_ID}`;
const SHARED_PROJECTION_ID = `dp_${RUN_ID}`;
const SHARED_SECRET = `secret_${RUN_ID}`;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface SseWaiter {
  event: string;
  resolve: (event: SseEvent | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

const sessionsByUser = new Map<string, DeviceSession>();
const sessionsByToken = new Map<string, DeviceSession>();

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

function buildSession(userId: string): DeviceSession {
  return {
    active: true,
    session_id: `sid_${RUN_ID}_${userId}`,
    session_token: `sess_${RUN_ID}_${userId}`,
    tenant_id: TENANT_ID,
    user_id: userId,
    device_id: `device_${userId}`,
    expires_at: Date.now() + 3_600_000,
    feishu_open_id: `ou_${RUN_ID}_${userId}`,
  };
}

function installMockSessions(): void {
  for (const userId of USERS) {
    const session = buildSession(userId);
    sessionsByUser.set(userId, session);
    sessionsByToken.set(session.session_token, session);
  }
}

function namespaceHeaders(userId: string): Record<string, string> {
  const session = sessionsByUser.get(userId);
  if (session) {
    return {
      authorization: `Bearer ${session.session_token}`,
      'x-inkloop-tenant-id': session.tenant_id,
      'x-inkloop-user-id': session.user_id,
      'x-inkloop-device-id': session.device_id,
    };
  }
  return {
    'x-inkloop-tenant-id': TENANT_ID,
    'x-inkloop-user-id': userId,
  };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function fetchJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${CLOUD_HUB_BASE}${path}`, options);
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) fail(`${path} HTTP ${response.status}: ${text}`);
  return data as T;
}

async function fetchStatus(path: string, headers: Record<string, string>): Promise<number> {
  const response = await fetch(`${CLOUD_HUB_BASE}${path}`, { headers });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startMockPanel(): Promise<{ baseUrl: string; server: Server }> {
  const port = await freePort();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/api/internal/inkloop/sessions/introspect') {
      if (String(req.headers['x-inkloop-secret'] || '') !== SHARED_SECRET) return sendJson(res, 401, { active: false, error: 'bad_secret' });
      const body = JSON.parse(await readBody(req) || '{}') as { session_token?: string };
      const session = body.session_token ? sessionsByToken.get(body.session_token) : null;
      if (!session) return sendJson(res, 401, { active: false, error: 'reauth_required' });
      return sendJson(res, 200, session);
    }
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${port}`, server };
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

async function startSessionScopedCloudHub(panelBaseUrl: string, rootDir: string): Promise<{ baseUrl: string; child: ChildProcess }> {
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
      INKLOOP_LOCAL_DEVICE_AUTH: '0',
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

async function postSource(userId: string, content: string): Promise<{
  document: { document_id: string; file_hash: string; blob?: { sha256?: string } };
}> {
  const bytes = Buffer.from(content, 'utf8');
  const fileHash = sha256(bytes);
  return await fetchJson('/v1/library/source-files', {
    method: 'POST',
    headers: {
      ...namespaceHeaders(userId),
      'content-type': 'application/json',
      'x-inkloop-device-id': `device_${userId}`,
    },
    body: JSON.stringify({
      document_id: SHARED_DOC_ID,
      filename: `Multi User Isolation ${RUN_ID}.md`,
      file_hash: fileHash,
      mime_type: 'text/markdown',
      size_bytes: bytes.length,
      page_count: 1,
      source: 'web',
      content_base64: bytes.toString('base64'),
    }),
  });
}

async function readBlob(userId: string): Promise<string> {
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/source-files/${encodeURIComponent(SHARED_DOC_ID)}/blob`, {
    headers: namespaceHeaders(userId),
  });
  if (!response.ok) fail(`blob ${userId} HTTP ${response.status}: ${await response.text()}`);
  return await response.text();
}

class SseClient {
  private readonly decoder = new TextDecoder();
  private readonly queue: SseEvent[] = [];
  private readonly waiters: SseWaiter[] = [];
  private buffer = '';

  private constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly controller: AbortController,
  ) {
    void this.pump();
  }

  static async open(userId: string): Promise<SseClient> {
    const controller = new AbortController();
    const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/stream`, {
      headers: namespaceHeaders(userId),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) fail(`stream ${userId} HTTP ${response.status}: ${await response.text()}`);
    return new SseClient(response.body.getReader(), controller);
  }

  waitFor(eventName: string, timeoutMs: number): Promise<SseEvent | null> {
    const queuedIndex = this.queue.findIndex((item) => item.event === eventName);
    if (queuedIndex >= 0) return Promise.resolve(this.queue.splice(queuedIndex, 1)[0]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({ event: eventName, resolve, timer });
    });
  }

  close(): void {
    this.controller.abort();
    void this.reader.cancel().catch(() => undefined);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  protected dispatch(event: SseEvent): void {
    const waiterIndex = this.waiters.findIndex((item) => item.event === event.event);
    if (waiterIndex >= 0) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.queue.push(event);
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        this.buffer += this.decoder.decode(value, { stream: true });
        let boundary = this.buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = this.buffer.slice(0, boundary);
          this.buffer = this.buffer.slice(boundary + 2);
          this.parseFrame(frame);
          boundary = this.buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Closing the AbortController is the normal shutdown path for this smoke.
    }
  }

  private parseFrame(frame: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(data.join('\n')) as Record<string, unknown>;
    } catch {
      parsed = { raw: data.join('\n') };
    }
    this.dispatch({ event, data: parsed });
  }
}

function runtimeEvent(userId: string): RuntimeSyncEvent {
  const now = new Date().toISOString();
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: SHARED_EVENT_ID,
    source: 'inkloop_device',
    doc_id: SHARED_DOC_ID,
    operation: 'annotation.add',
    target: { type: 'annotation', id: `${SHARED_KO_ID}_${userId}`, block_id: `blk_${RUN_ID}` },
    payload: {
      mark_id: `${SHARED_EVENT_ID}_${userId}`,
      page_id: `pg_${RUN_ID}_1`,
      page_index: 0,
      annotation: {
        ko_id: `${SHARED_KO_ID}_${userId}`,
        title: `Runtime mark ${userId}`,
        render_mode: 'stroke_only',
        visual_strokes: [{ tool: 'pen', color: '#111827', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }] }],
      },
    },
    origin: { device_id: `device_${userId}` },
    status: 'pending',
    dedupe_key: `${SHARED_EVENT_ID}_${userId}`,
    created_at: now,
    updated_at: now,
  };
}

async function pushRuntime(userId: string): Promise<{ acks: Array<{ event_id: string; ok: boolean; server_sequence?: number }> }> {
  return await fetchJson('/v1/runtime/events:push', {
    method: 'POST',
    headers: { ...namespaceHeaders(userId), 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'inkloop.runtime_sync_batch.v1',
      device_id: `device_${userId}`,
      events: [runtimeEvent(userId)],
    }),
  });
}

async function pullRuntime(userId: string): Promise<{ events: RuntimeSyncEvent[]; next_cursor: string }> {
  return await fetchJson(`/v1/runtime/events:pull?device_id=device_${userId}&cursor=0&limit=50`, {
    headers: namespaceHeaders(userId),
  });
}

function aiTurn(userId: string) {
  const now = new Date().toISOString();
  return {
    schema_version: 'inkloop.cloud_hub.ai_turn.v1',
    ai_turn_id: SHARED_TURN_ID,
    document_id: SHARED_DOC_ID,
    mark_ids: [`mark_${userId}`],
    prompt_md: `Prompt ${userId}`,
    response_md: `Response ${userId}`,
    status: 'accepted',
    created_at: now,
    updated_at: now,
    metadata: { userId },
  };
}

function knowledgeObject(userId: string) {
  const now = new Date().toISOString();
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: SHARED_KO_ID,
    kind: 'reading_note',
    title: `Knowledge ${userId}`,
    body_md: `Knowledge body ${userId}`,
    source: {
      document_id: SHARED_DOC_ID,
      document_title: `Document ${userId}`,
      object_refs: [`mark_${userId}`],
      inkloop_uri: `inkloop://doc/${SHARED_DOC_ID}?anchor=mark_${userId}`,
    },
    provenance: { created_from: 'ai_turn', mark_ids: [`mark_${userId}`], ai_turn_ids: [SHARED_TURN_ID] },
    tags: ['inkloop', `inkloop/${userId}`],
    status: 'accepted',
    privacy: 'export_allowed',
    content_hash: `sha256:${sha256(`ko:${RUN_ID}:${userId}`)}`,
    created_at: now,
    updated_at: now,
  };
}

function documentProjection(userId: string) {
  const now = new Date().toISOString();
  return {
    schema_version: 'inkloop.document_projection.v1',
    projection_id: SHARED_PROJECTION_ID,
    document_id: SHARED_DOC_ID,
    document_title: `Document ${userId}`,
    document_uri: `inkloop://doc/${SHARED_DOC_ID}`,
    revision_id: `rev_${RUN_ID}_${userId}`,
    generated_at: now,
    source: { app: 'inkloop-cloud-hub-isolation-smoke', app_version: '0.1.0' },
    privacy: 'export_allowed',
    export_policy: { include_full_text: false, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
    blocks: [{
      block_id: `blk_${RUN_ID}_${userId}`,
      kind: 'paragraph',
      text_md: `Projection ${userId}`,
      region: 'generated',
      source: { page_id: `pg_${RUN_ID}_1`, page_index: 0, object_refs: [`mark_${userId}`] },
      knowledge_object_ids: [SHARED_KO_ID],
    }],
    body_hash: `sha256:${sha256(`body:${RUN_ID}:${userId}`)}`,
    content_hash: `sha256:${sha256(`projection:${RUN_ID}:${userId}`)}`,
    created_at: now,
    updated_at: now,
  };
}

async function writeKnowledge(userId: string): Promise<void> {
  await fetchJson('/v1/knowledge/ai-turns', {
    method: 'POST',
    headers: { ...namespaceHeaders(userId), 'content-type': 'application/json' },
    body: JSON.stringify({ ai_turn: aiTurn(userId) }),
  });
  await fetchJson('/v1/knowledge/objects', {
    method: 'POST',
    headers: { ...namespaceHeaders(userId), 'content-type': 'application/json' },
    body: JSON.stringify({ object: knowledgeObject(userId) }),
  });
  await fetchJson('/v1/knowledge/document-projections', {
    method: 'POST',
    headers: { ...namespaceHeaders(userId), 'content-type': 'application/json' },
    body: JSON.stringify({ document_projection: documentProjection(userId) }),
  });
}

async function readKnowledge(userId: string): Promise<{
  ai_turns: Array<{ ai_turn_id: string; response_md?: string }>;
  objects: Array<{ ko_id: string; title?: string }>;
  document_projections: Array<{ projection_id: string; document_title?: string }>;
}> {
  const [turns, objects, projections] = await Promise.all([
    fetchJson<{ ai_turns: Array<{ ai_turn_id: string; response_md?: string }> }>(`/v1/knowledge/ai-turns?document_id=${encodeURIComponent(SHARED_DOC_ID)}`, { headers: namespaceHeaders(userId) }),
    fetchJson<{ objects: Array<{ ko_id: string; title?: string }> }>(`/v1/knowledge/objects?document_id=${encodeURIComponent(SHARED_DOC_ID)}`, { headers: namespaceHeaders(userId) }),
    fetchJson<{ document_projections: Array<{ projection_id: string; document_title?: string }> }>(`/v1/knowledge/document-projections?document_id=${encodeURIComponent(SHARED_DOC_ID)}`, { headers: namespaceHeaders(userId) }),
  ]);
  return { ai_turns: turns.ai_turns, objects: objects.objects, document_projections: projections.document_projections };
}

async function verifyLibrary(): Promise<Record<string, unknown>> {
  const streamA = await SseClient.open(USER_A);
  const streamB = await SseClient.open(USER_B);
  try {
    expect(await streamA.waitFor('ready', 1_000), 'user A stream did not become ready');
    expect(await streamB.waitFor('ready', 1_000), 'user B stream did not become ready');

    const userAContent = `# Multi-user A\n\n${RUN_ID}\n`;
    const userBContent = `# Multi-user B\n\n${RUN_ID}\n`;
    const pendingA = streamA.waitFor('manifest', 1_500);
    const pendingLeakToB = streamB.waitFor('manifest', 350);
    const postedA = await postSource(USER_A, userAContent);
    const eventA = await pendingA;
    const leakedToB = await pendingLeakToB;

    expect(postedA.document.document_id === SHARED_DOC_ID, 'user A source upload returned wrong document_id');
    expect(eventA?.data.document_id === SHARED_DOC_ID, 'user A stream did not receive its manifest update');
    expect(leakedToB === null, 'user B stream received user A manifest update');

    const manifestA = await fetchJson<{ documents: Array<{ document_id: string; file_hash: string }> }>('/v1/library/manifest', { headers: namespaceHeaders(USER_A) });
    const manifestBBefore = await fetchJson<{ documents: Array<{ document_id: string }> }>('/v1/library/manifest', { headers: namespaceHeaders(USER_B) });
    expect(manifestA.documents.some((item) => item.document_id === SHARED_DOC_ID), 'user A manifest missing uploaded document');
    expect(!manifestBBefore.documents.some((item) => item.document_id === SHARED_DOC_ID), 'user B manifest leaked user A document');
    expect(await readBlob(USER_A) === userAContent, 'user A blob content mismatch');
    expect(await fetchStatus(`/v1/library/source-files/${encodeURIComponent(SHARED_DOC_ID)}/blob`, namespaceHeaders(USER_B)) === 404, 'user B could read user A blob before uploading its own document');

    const pendingB = streamB.waitFor('manifest', 1_500);
    const postedB = await postSource(USER_B, userBContent);
    const eventB = await pendingB;
    expect(postedB.document.document_id === SHARED_DOC_ID, 'user B source upload returned wrong document_id');
    expect(eventB?.data.document_id === SHARED_DOC_ID, 'user B stream did not receive its manifest update');
    expect(await readBlob(USER_A) === userAContent, 'user A blob was overwritten by user B');
    expect(await readBlob(USER_B) === userBContent, 'user B blob content mismatch');

    return {
      same_document_id: SHARED_DOC_ID,
      user_a_hash: postedA.document.file_hash,
      user_b_hash: postedB.document.file_hash,
      user_a_stream_event: eventA.data.document_id,
      user_b_stream_event: eventB.data.document_id,
      cross_stream_leak: false,
      cross_blob_leak: false,
    };
  } finally {
    streamA.close();
    streamB.close();
  }
}

async function verifyRuntime(): Promise<Record<string, unknown>> {
  const [pushA, pushB] = await Promise.all([pushRuntime(USER_A), pushRuntime(USER_B)]);
  expect(pushA.acks?.[0]?.ok === true, `user A runtime push failed: ${JSON.stringify(pushA)}`);
  expect(pushB.acks?.[0]?.ok === true, `user B runtime push failed: ${JSON.stringify(pushB)}`);
  const [pullA, pullB, pullC] = await Promise.all([pullRuntime(USER_A), pullRuntime(USER_B), pullRuntime(USER_C)]);
  expect(pullA.events.map((item) => item.event_id).includes(SHARED_EVENT_ID), 'user A runtime pull missing its event');
  expect(pullB.events.map((item) => item.event_id).includes(SHARED_EVENT_ID), 'user B runtime pull missing its event');
  expect(pullA.events.every((item) => item.origin?.device_id === `device_${USER_A}`), 'user A runtime pull included another user event');
  expect(pullB.events.every((item) => item.origin?.device_id === `device_${USER_B}`), 'user B runtime pull included another user event');
  expect(pullC.events.length === 0, 'user C runtime pull leaked another user event');
  return {
    same_event_id: SHARED_EVENT_ID,
    user_a_sequence: pushA.acks[0].server_sequence,
    user_b_sequence: pushB.acks[0].server_sequence,
    user_a_events: pullA.events.length,
    user_b_events: pullB.events.length,
    user_c_events: pullC.events.length,
  };
}

async function verifyKnowledge(): Promise<Record<string, unknown>> {
  await Promise.all([writeKnowledge(USER_A), writeKnowledge(USER_B)]);
  const [knowledgeA, knowledgeB, knowledgeC] = await Promise.all([readKnowledge(USER_A), readKnowledge(USER_B), readKnowledge(USER_C)]);
  expect(knowledgeA.ai_turns.some((item) => item.ai_turn_id === SHARED_TURN_ID && item.response_md === `Response ${USER_A}`), 'user A ai_turn missing or mixed');
  expect(knowledgeB.ai_turns.some((item) => item.ai_turn_id === SHARED_TURN_ID && item.response_md === `Response ${USER_B}`), 'user B ai_turn missing or mixed');
  expect(knowledgeA.objects.some((item) => item.ko_id === SHARED_KO_ID && item.title === `Knowledge ${USER_A}`), 'user A KnowledgeObject missing or mixed');
  expect(knowledgeB.objects.some((item) => item.ko_id === SHARED_KO_ID && item.title === `Knowledge ${USER_B}`), 'user B KnowledgeObject missing or mixed');
  expect(knowledgeA.document_projections.some((item) => item.projection_id === SHARED_PROJECTION_ID && item.document_title === `Document ${USER_A}`), 'user A DocumentProjection missing or mixed');
  expect(knowledgeB.document_projections.some((item) => item.projection_id === SHARED_PROJECTION_ID && item.document_title === `Document ${USER_B}`), 'user B DocumentProjection missing or mixed');
  expect(knowledgeC.ai_turns.length === 0 && knowledgeC.objects.length === 0 && knowledgeC.document_projections.length === 0, 'user C Cloud Knowledge leaked another user record');
  return {
    same_ai_turn_id: SHARED_TURN_ID,
    same_ko_id: SHARED_KO_ID,
    same_projection_id: SHARED_PROJECTION_ID,
    user_a: { ai_turns: knowledgeA.ai_turns.length, objects: knowledgeA.objects.length, projections: knowledgeA.document_projections.length },
    user_b: { ai_turns: knowledgeB.ai_turns.length, objects: knowledgeB.objects.length, projections: knowledgeB.document_projections.length },
    user_c: { ai_turns: knowledgeC.ai_turns.length, objects: knowledgeC.objects.length, projections: knowledgeC.document_projections.length },
  };
}

async function main(): Promise<void> {
  let panel: { baseUrl: string; server: Server } | null = null;
  let cloud: { baseUrl: string; child: ChildProcess } | null = null;
  let tempRoot = '';
  const started = Date.now();
  try {
    if (!CLOUD_HUB_BASE) {
      installMockSessions();
      tempRoot = await mkdtemp(join(tmpdir(), 'inkloop-multi-user-isolation-'));
      panel = await startMockPanel();
      cloud = await startSessionScopedCloudHub(panel.baseUrl, tempRoot);
      CLOUD_HUB_BASE = cloud.baseUrl;
    }
    await fetchJson('/v1/library/manifest', { headers: namespaceHeaders(USER_A) });
    const [library, runtime, knowledge] = await Promise.all([
      verifyLibrary(),
      verifyRuntime(),
      verifyKnowledge(),
    ]);
    console.log(JSON.stringify({
      ok: true,
      latency_ms: Date.now() - started,
      cloud_hub: CLOUD_HUB_BASE,
      auth_mode: sessionsByUser.size ? 'session' : 'header_namespace',
      namespace: { tenant_id: TENANT_ID, users: [USER_A, USER_B, USER_C] },
      library,
      runtime,
      knowledge,
    }, null, 2));
  } finally {
    await stopChild(cloud?.child ?? null);
    await closeServer(panel?.server ?? null);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
