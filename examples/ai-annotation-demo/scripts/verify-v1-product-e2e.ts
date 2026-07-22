import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInkloopDocUri,
  type DocumentProjection,
  type KnowledgeObject,
} from 'ink-surface-sdk/knowledge-schema';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const TENANT_ID = process.env.INKLOOP_TENANT_ID || 'local';
const USER_ID = process.env.INKLOOP_USER_ID || 'local_demo';
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'v1-product-e2e';
const VAULT_ROOT = resolve(process.env.INKLOOP_V1_E2E_VAULT || join(REPO_ROOT, 'test-results/v1-product-e2e-vault'));
const ACTIVE_OBSIDIAN_VAULT_ROOT = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const LOCAL_AUTH_STORE = resolve(process.env.INKLOOP_LOCAL_AUTH_STORE || join(PACKAGE_ROOT, '.inkloop/auth-sessions.json'));
const MIRROR_ACTIVE_VAULT = process.env.INKLOOP_MIRROR_V1_PRODUCT_E2E_TO_ACTIVE === '1';
const MARK_AS_TEST_RUN = process.env.INKLOOP_MARK_V1_PRODUCT_E2E_AS_TEST_RUN !== '0';

interface CloudLibraryDocument {
  document_id: string;
  source_file_id: string;
  file_hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  source: string;
  updated_at: string;
  blob: { path: string; sha256: string; size_bytes: number };
}

interface RuntimeAck {
  event_id: string;
  ok: boolean;
  server_sequence?: number;
  error?: string;
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

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const sessionToken = process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN || '';
  return {
    'x-inkloop-tenant-id': TENANT_ID,
    'x-inkloop-user-id': USER_ID,
    'x-inkloop-device-id': DEVICE_ID,
    ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    ...extra,
  };
}

async function discoverLocalSessionToken(): Promise<string> {
  if (process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
    return process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN || '';
  }
  try {
    const parsed = JSON.parse(await readFile(LOCAL_AUTH_STORE, 'utf8')) as { sessions?: Record<string, { tenant_id?: string; user_id?: string; expires_at?: number; updated_at?: number; created_at?: number }> };
    const sessions = Object.entries(parsed.sessions || {})
      .filter(([, session]) => session.tenant_id === TENANT_ID && session.user_id === USER_ID && Number(session.expires_at || 0) > Date.now())
      .sort(([, left], [, right]) => Number(right.updated_at || right.created_at || 0) - Number(left.updated_at || left.created_at || 0));
    return String(sessions[0]?.[0] || '');
  } catch {
    return '';
  }
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

async function fetchText(pathOrUrl: string, options: RequestInit = {}): Promise<string> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${CLOUD_HUB_BASE}${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  if (!response.ok) fail(`${options.method || 'GET'} ${url} HTTP ${response.status}: ${text}`);
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForStreamReady(timeoutMs = 4_000): Promise<{ event: Promise<{ latency_ms: number }>; close: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unrefTimer = (timer as { unref?: () => void }).unref;
  if (typeof unrefTimer === 'function') unrefTimer.call(timer);
  const response = await fetch(`${CLOUD_HUB_BASE}/v1/library/stream`, {
    headers: headers(),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) fail(`GET /v1/library/stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) fail('library stream ended before ready');
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.indexOf('\n\n');
    if (boundary < 0) continue;
    const frame = buffer.slice(0, boundary);
    if (frame.includes('event: ready')) break;
  }
  clearTimeout(timer);
  return {
    event: (async () => {
      const startedEvent = Date.now();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            if (frame.includes('event: manifest')) return { latency_ms: Date.now() - startedEvent };
          }
        }
        fail('library stream ended before manifest event');
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    })(),
    close: () => controller.abort(),
  };
}

function runtimeEvent(input: { eventId: string; docId: string; createdAt: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.eventId,
    source: 'inkloop_device',
    doc_id: input.docId,
    operation: 'annotation.add',
    target: { type: 'annotation', id: `ko_${input.eventId}`, block_id: 'blk_v1_product_1' },
    payload: {
      ...(MARK_AS_TEST_RUN ? { inkloop_test_run: true } : {}),
      block_id: 'blk_v1_product_1',
      annotation: {
        ko_id: `ko_${input.eventId}`,
        title: '这个 V1 Cloud Hub 标记是否需要进入后处理？',
        body_md: '请确认 Web 导入、墨水屏标记、Cloud Hub 后处理和 Obsidian 投影是否已经形成闭环。',
        ai_eligible: true,
        render_mode: 'stroke_only',
        visual_strokes: [{
          tool: 'pen',
          color: '#111827',
          opacity: 0.92,
          points: [{ x: 0.12, y: 0.18 }, { x: 0.32, y: 0.2 }, { x: 0.42, y: 0.24 }],
        }],
      },
    },
    origin: { device_id: 'paper-v1-product-e2e' },
    status: 'pending',
    dedupe_key: input.eventId,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

async function writeRenderedVault(files: Array<{ path: string; markdown: string }>): Promise<void> {
  await rm(VAULT_ROOT, { recursive: true, force: true });
  for (const file of files) {
    const target = join(VAULT_ROOT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
  }
}

async function mirrorRenderedFilesToActiveVault(files: Array<{ path: string; markdown: string }>): Promise<{ vault_root: string; rendered_file_count: number; files: string[] } | null> {
  if (!MIRROR_ACTIVE_VAULT) return null;
  try {
    await access(ACTIVE_OBSIDIAN_VAULT_ROOT);
  } catch {
    return null;
  }
  const written: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith('InkLoop/Reading/')) continue;
    const target = join(ACTIVE_OBSIDIAN_VAULT_ROOT, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
    written.push(target);
  }
  return { vault_root: ACTIVE_OBSIDIAN_VAULT_ROOT, rendered_file_count: written.length, files: written };
}

function parseJsonFromOutput(output: string): unknown {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) fail(`could not parse JSON from child output:\n${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

async function runTsxScript(scriptName: string): Promise<unknown> {
  const tsxCli = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const script = join(PACKAGE_ROOT, 'scripts', scriptName);
  const child = spawn(process.execPath, [tsxCli, script], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit') as [number | null];
  if (code !== 0) fail(`${scriptName} failed:\n${output}`);
  const parsed = parseJsonFromOutput(output) as { ok?: boolean };
  if (!parsed.ok) fail(`${scriptName} returned ok=false:\n${output}`);
  return parsed;
}

async function runNodeJsonScript(scriptPath: string, args: string[] = [], extraEnv: Record<string, string> = {}): Promise<unknown> {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit') as [number | null];
  if (code !== 0) fail(`${scriptPath} failed:\n${output}`);
  const parsed = parseJsonFromOutput(output) as { ok?: boolean };
  if (!parsed.ok) fail(`${scriptPath} returned ok=false:\n${output}`);
  return parsed;
}

async function installObsidianPlugin(vaultRoot: string, deviceId: string): Promise<unknown> {
  return runNodeJsonScript(join(REPO_ROOT, 'scripts/install-obsidian-plugin.mjs'), ['--vault', vaultRoot], {
    INKLOOP_TENANT_ID: TENANT_ID,
    INKLOOP_USER_ID: USER_ID,
    INKLOOP_OBSIDIAN_DEVICE_ID: deviceId,
    ...(process.env.INKLOOP_SESSION_TOKEN ? { INKLOOP_SESSION_TOKEN: process.env.INKLOOP_SESSION_TOKEN } : {}),
  });
}

function runMeetingE2e(): Promise<unknown> {
  return runTsxScript('verify-meeting-v1-e2e.ts');
}

function runAiGraphWorkerSmoke(): Promise<unknown> {
  return runTsxScript('smoke-ai-graph-worker.ts');
}

async function main(): Promise<void> {
  const sessionToken = await discoverLocalSessionToken();
  if (sessionToken && !process.env.INKLOOP_SESSION_TOKEN && !process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
    process.env.INKLOOP_SESSION_TOKEN = sessionToken;
  }
  const started = Date.now();
  const createdAt = new Date().toISOString();
  const content = [
    '# InkLoop V1 Product E2E',
    '',
    'Cloud Hub first import',
    '',
    `Run: ${createdAt}`,
    '',
    '- Web/电脑端外部导入先进入 Cloud Hub',
    '- Paper Library 通过 manifest/SSE 发现新文件',
    '- Runtime sync 只同步标注事件，不传源文件字节',
    '- Obsidian 只接收 reviewed Markdown projection',
  ].join('\n');
  const bytes = Buffer.from(content, 'utf8');
  const fileHash = sha256(bytes);
  const documentId = `doc_v1_${fileHash.slice(0, 12)}`;
  const filename = `InkLoop V1 Product E2E ${createdAt.replace(/[:.]/g, '-')}.md`;
  const eventId = `evt_v1_${fileHash.slice(0, 10)}`;

  const stream = await waitForStreamReady();
  const uploaded = await fetchJson<{ ok: boolean; document: CloudLibraryDocument }>('/v1/library/source-files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document_id: documentId,
      filename,
      file_hash: fileHash,
      mime_type: 'text/markdown',
      size_bytes: bytes.length,
      page_count: 1,
      source: 'web',
      content_base64: bytes.toString('base64'),
    }),
  });
  if (!uploaded.ok || uploaded.document.document_id !== documentId) fail('Cloud Hub upload did not return the expected SourceFile identity');
  const streamEvent = await stream.event;
  stream.close();

  const manifest = await fetchJson<{ documents: CloudLibraryDocument[] }>('/v1/library/manifest');
  const manifestDoc = manifest.documents.find((doc) => doc.document_id === documentId);
  if (!manifestDoc) fail('Cloud Hub manifest did not include uploaded document');
  if (manifestDoc.source !== 'web') fail(`Web import source should be web, got ${manifestDoc.source}`);
  const downloaded = await fetchText(`/v1/library/source-files/${encodeURIComponent(documentId)}/blob`);
  if (downloaded !== content) fail('Cloud Hub blob download did not match original source bytes');

  const push = await fetchJson<{ acks: RuntimeAck[] }>('/v1/runtime/events:push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'inkloop.runtime_sync_batch.v1',
      device_id: 'paper-v1-product-e2e',
      reason: 'v1-product-e2e-reading-mark',
      events: [runtimeEvent({ eventId, docId: documentId, createdAt })],
    }),
  });
  const ack = push.acks.find((item) => item.event_id === eventId);
  if (!ack?.ok || !ack.server_sequence) fail(`Runtime sync did not ack reading mark: ${JSON.stringify(push)}`);
  const pullCursor = Math.max(0, ack.server_sequence - 1);
  const pulled = await fetchJson<{ events: RuntimeSyncEvent[]; next_cursor: string }>(`/v1/runtime/events:pull?device_id=obsidian-v1-product-e2e&cursor=${pullCursor}&limit=20`);
  if (!pulled.events.some((event) => event.event_id === eventId && event.doc_id === documentId)) {
    fail('Runtime sync pull did not return the pushed reading mark for Obsidian');
  }

  const postprocess = await waitForPostprocess(documentId, eventId);
  const persistedAiTurn = postprocess.aiTurn;
  const persistedKo = postprocess.knowledgeObject;
  const persistedProjection = postprocess.projection;
  if (persistedAiTurn.metadata?.classifier_respond !== true) {
    fail(`Cloud Hub automatic post-processing did not accept the V1 reading mark: ${JSON.stringify(persistedAiTurn)}`);
  }
  if (persistedAiTurn.metadata?.llm_error) {
    fail(`Cloud Hub LLM gateway was not actually used for post-processing: ${String(persistedAiTurn.metadata.llm_error)}`);
  }
  const renderedFiles = renderVaultMarkdown({
    entities: [{
      documentId,
      documentTitle: filename,
      mode: 'reading',
      dates: [createdAt.slice(0, 10)],
      knowledgeObjects: [persistedKo],
      documentProjections: [persistedProjection],
      visualModel: {
        documentTitle: filename,
        blocks: [{
          id: 'blk_v1_product_1',
          kind: 'paragraph',
          region: 'editable',
          content: persistedProjection.blocks[0].text_md,
          annotations: [{
            ko_id: persistedKo.ko_id,
            kind: persistedKo.kind,
            title: persistedKo.title,
            render_mode: 'stroke_only',
            visual_strokes: [{
              tool: 'pen',
              color: '#111827',
              opacity: 0.92,
              points: [{ x: 0.12, y: 0.18 }, { x: 0.32, y: 0.2 }, { x: 0.42, y: 0.24 }],
            }],
          }],
        }],
      },
    }],
  });
  await writeRenderedVault(renderedFiles);
  const activeVaultMirror = await mirrorRenderedFilesToActiveVault(renderedFiles);
  const obsidianInstall = await installObsidianPlugin(VAULT_ROOT, 'obsidian-v1-product-e2e');
  const activeObsidianInstall = activeVaultMirror
    ? await installObsidianPlugin(ACTIVE_OBSIDIAN_VAULT_ROOT, `obsidian_${ACTIVE_OBSIDIAN_VAULT_ROOT.split('/').at(-1) || 'active-vault'}`)
    : null;
  const sourceTitle = filename.replace(/\s*\.(?:md|markdown|pdf|epub)$/i, '');
  const hubFile = renderedFiles.find((file) => file.path === `InkLoop/Reading/${sourceTitle}/${sourceTitle}.md`) ?? renderedFiles[0];
  const koFile = renderedFiles.find((file) => file.markdown.includes(`inkloop_knowledge_object_id: "${persistedKo.ko_id}"`));
  if (!hubFile || !koFile) fail('Obsidian renderer did not create reading hub and KO notes');
  const hubMarkdown = await readFile(join(VAULT_ROOT, hubFile.path), 'utf8');
  const koMarkdown = await readFile(join(VAULT_ROOT, koFile.path), 'utf8');
  if (!hubMarkdown.includes(buildInkloopDocUri(documentId))) fail('Obsidian hub markdown is missing inkloop:// source backlink');
  if (!koMarkdown.includes(`inkloop_knowledge_kind: "${persistedKo.kind}"`) || !koMarkdown.includes(persistedKo.title) || !koMarkdown.includes('Backlink: inkloop://doc/')) {
    fail('Obsidian KO markdown did not render visible projection content');
  }

  const postprocessWorker = await runAiGraphWorkerSmoke();
  const meeting = await runMeetingE2e();

  console.log(JSON.stringify({
    ok: true,
    latency_ms: Date.now() - started,
    cloud_hub: {
      base_url: CLOUD_HUB_BASE,
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      session_authenticated: !!sessionToken,
      uploaded_document_id: documentId,
      source: manifestDoc.source,
      manifest_contains_document: true,
      sse_manifest_latency_ms: streamEvent.latency_ms,
      blob_roundtrip_sha256: sha256(downloaded),
    },
    reading_runtime: {
      event_id: eventId,
      server_sequence: ack.server_sequence,
      pulled_by_obsidian_device: pulled.events.some((event) => event.event_id === eventId),
      next_cursor: pulled.next_cursor,
    },
    llm_gateway: {
      classify_context_respond: persistedAiTurn.metadata?.classifier_respond,
      gateway_error: persistedAiTurn.metadata?.llm_error || null,
      reason: persistedAiTurn.response_md,
    },
    cloud_knowledge: {
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
      hub_file: join(VAULT_ROOT, hubFile.path),
      ko_file: join(VAULT_ROOT, koFile.path),
      contains_backlink: hubMarkdown.includes(buildInkloopDocUri(documentId)),
      contains_visible_ko_content: koMarkdown.includes(persistedKo.title),
      active_vault_mirror: activeVaultMirror,
      active_vault_plugin_installed: !!(activeObsidianInstall as { ok?: boolean } | null)?.ok,
      active_vault_hub_file: activeVaultMirror ? join(ACTIVE_OBSIDIAN_VAULT_ROOT, hubFile.path) : null,
      active_vault_ko_file: activeVaultMirror ? join(ACTIVE_OBSIDIAN_VAULT_ROOT, koFile.path) : null,
    },
    postprocess_worker: postprocessWorker,
    meeting,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
