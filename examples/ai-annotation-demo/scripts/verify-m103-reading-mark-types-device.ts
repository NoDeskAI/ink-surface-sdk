import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

const execFileAsync = promisify(execFile);

const ADB = process.env.ADB || `${process.env.HOME || ''}/Library/Android/sdk/platform-tools/adb`;
const PACKAGE_NAME = process.env.INKLOOP_ANDROID_PACKAGE || 'com.inkloop.app';
const ACTIVITY = process.env.INKLOOP_ANDROID_ACTIVITY || 'com.inkloop.app/.MainActivity';
const CLOUD_HUB_BASE = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const DEVICE_ID = process.env.INKLOOP_DEVICE_ID || 'paper-reading-mark-types';
const DEVICE_LABEL = process.env.INKLOOP_DEVICE_LABEL || 'Paper reading mark type verification';
const TARGET_DOCUMENT_QUERY = process.env.INKLOOP_TARGET_DOCUMENT_QUERY || 'AI时代的UX范式';
const REQUIRE_TARGET_DOCUMENT = process.env.INKLOOP_REQUIRE_TARGET_DOCUMENT === '1';
const CLEANUP_BEFORE = process.env.INKLOOP_CLEANUP_BEFORE === '1';
const CLEANUP_AFTER = process.env.INKLOOP_CLEANUP_AFTER === '1';
const OUTPUT_ROOT = resolve(process.cwd(), process.env.PAPER_READING_MARK_TYPES_OUTPUT_DIR || 'test-results/paper-reading-mark-types');

type ReadingMarkKind = 'underline' | 'highlight' | 'circle' | 'handwriting' | 'ai_pen' | 'review_later';

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
  poll_token: string;
  qr_payload: string;
}

interface MarkResult {
  ok?: boolean;
  kind?: ReadingMarkKind;
  mark_id?: string;
  document_id?: string;
  page_id?: string;
  page_index?: number;
  folded_count?: number;
  error?: string;
}

interface DeviceEvidence {
  boot: { hasInkLoop?: boolean; keys?: string[] };
  prepared: {
    ok?: boolean;
    error?: string;
    document_id?: string;
    filename?: string;
    target_query?: string;
    target_matched?: boolean;
    candidates?: string[];
    active?: { documentId?: string; pageIndex?: number; pageId?: string; surfaceType?: string };
  };
  before_count: number;
  created: MarkResult[];
  reopened: {
    ok?: boolean;
    after_count?: number;
    marks?: Array<{
      mark_id?: string;
      kind?: string;
      feature_type?: string;
      scored_type?: string;
      origin?: string;
      tool?: string;
      visual_tools?: string[];
      marked_text?: string;
      strokes?: number;
      page_index?: number;
    }>;
  };
  sync: unknown;
  cleanup_before?: unknown;
  cleanup_after?: unknown;
  cloud_cleanup_before?: unknown;
}

function fail(message: string): never {
  throw new Error(message);
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

async function ensureDevice(): Promise<{ serial: string; pid: string; model?: string; manufacturer?: string; android_version?: string }> {
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
  const [model, manufacturer, androidVersion] = await Promise.all([
    adb(['shell', 'getprop', 'ro.product.model'], { optional: true }),
    adb(['shell', 'getprop', 'ro.product.manufacturer'], { optional: true }),
    adb(['shell', 'getprop', 'ro.build.version.release'], { optional: true }),
  ]);
  return { serial, pid: pid.split(/\s+/)[0], model, manufacturer, android_version: androidVersion };
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
  return extra;
}

async function authorizeLocalCloudHubDevice(): Promise<DeviceSession> {
  const create = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: DEVICE_ID,
      device_label: DEVICE_LABEL,
      platform: 'android-webview',
      requested_scopes: ['device_session'],
    }),
  });
  const flow = await create.json() as LocalAuthFlow;
  if (!create.ok || !flow.flow_id || !flow.poll_token || !flow.qr_payload) fail(`Cloud Hub local auth create failed HTTP ${create.status}: ${JSON.stringify(flow)}`);
  const scan = await fetch(flow.qr_payload);
  if (!scan.ok) fail(`Cloud Hub local auth scan failed HTTP ${scan.status}: ${await scan.text()}`);
  const status = await fetch(`${CLOUD_HUB_BASE}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/status?poll_token=${encodeURIComponent(flow.poll_token)}`);
  const payload = await status.json() as { status?: string; session?: DeviceSession };
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

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${CLOUD_HUB_BASE}${path}`, { headers: headers() });
  const text = await response.text();
  if (!response.ok) fail(`GET ${path} HTTP ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function safeSegment(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim() || fallback;
  return encodeURIComponent(raw).replace(/%/g, '_');
}

async function cleanupCloudKnowledgeDocument(documentId: string, runId: string): Promise<{
  ok: boolean;
  index_path?: string;
  backup_path?: string;
  ai_turns_removed: number;
  knowledge_objects_removed: number;
  document_projections_removed: number;
  error?: string;
}> {
  try {
    const health = await fetchJson<{ stores?: { knowledge?: string } }>('/healthz');
    const knowledgeRoot = health.stores?.knowledge;
    if (!knowledgeRoot || !cloudSession) throw new Error('missing_cloud_knowledge_store_or_session');
    const indexPath = join(knowledgeRoot, safeSegment(cloudSession.tenant_id, 'local'), safeSegment(cloudSession.user_id, 'local_demo'), 'index.json');
    const beforeText = await readFile(indexPath, 'utf8').catch(() => '');
    if (!beforeText) {
      return { ok: true, index_path: indexPath, ai_turns_removed: 0, knowledge_objects_removed: 0, document_projections_removed: 0 };
    }
    const backupDir = join(OUTPUT_ROOT, 'cloud-knowledge-backups');
    await mkdir(backupDir, { recursive: true });
    const backupPath = join(backupDir, `${safeSegment(documentId, 'doc')}-${runId}.json`);
    await writeFile(backupPath, beforeText, 'utf8');
    const index = JSON.parse(beforeText) as {
      ai_turns?: Array<{ document_id?: string }>;
      knowledge_objects?: Array<{ source?: { document_id?: string } }>;
      document_projections?: Array<{ document_id?: string }>;
    };
    const beforeAiTurns = index.ai_turns?.length ?? 0;
    const beforeObjects = index.knowledge_objects?.length ?? 0;
    const beforeProjections = index.document_projections?.length ?? 0;
    const next = {
      ...index,
      updated_at: new Date().toISOString(),
      ai_turns: (index.ai_turns || []).filter((item) => item.document_id !== documentId),
      knowledge_objects: (index.knowledge_objects || []).filter((item) => item.source?.document_id !== documentId),
      document_projections: (index.document_projections || []).filter((item) => item.document_id !== documentId),
    };
    await writeFile(indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      index_path: indexPath,
      backup_path: backupPath,
      ai_turns_removed: beforeAiTurns - next.ai_turns.length,
      knowledge_objects_removed: beforeObjects - next.knowledge_objects.length,
      document_projections_removed: beforeProjections - next.document_projections.length,
    };
  } catch (error) {
    return {
      ok: false,
      ai_turns_removed: 0,
      knowledge_objects_removed: 0,
      document_projections_removed: 0,
      error: String((error as Error)?.message || error),
    };
  }
}

async function waitForRuntimeMarks(documentId: string, markIds: string[]): Promise<RuntimeSyncEvent[]> {
  const wanted = new Set(markIds);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = new Map<string, RuntimeSyncEvent>();
    let cursor = '0';
    let guard = 0;
    while (guard < 30) {
      guard += 1;
      const pulled = await fetchJson<{ events: RuntimeSyncEvent[]; next_cursor?: string; has_more?: boolean }>(`/v1/runtime/events:pull?device_id=${encodeURIComponent(DEVICE_ID)}&cursor=${encodeURIComponent(cursor)}&limit=100`);
      for (const event of pulled.events) {
        const markId = (event.payload as { mark_id?: string } | undefined)?.mark_id;
        if (event.doc_id === documentId && event.operation === 'annotation.add' && markId && wanted.has(markId)) found.set(markId, event);
      }
      if (!pulled.has_more || !pulled.next_cursor || pulled.next_cursor === cursor) break;
      cursor = pulled.next_cursor;
    }
    if (found.size === wanted.size) return [...found.values()];
    await sleep(500);
  }
  fail(`Runtime Sync did not expose all reading mark types: document_id=${documentId}, mark_ids=${markIds.join(',')}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-');
  const session = await authorizeLocalCloudHubDevice();
  cloudSession = session;
  const { serial, pid, model, manufacturer, android_version } = await ensureDevice();
  const { port, websocketUrl, pageTitle } = await openDevtools(pid);
  const kinds: ReadingMarkKind[] = ['highlight', 'underline', 'circle', 'handwriting', 'ai_pen', 'review_later'];

  const evidence = await withCdp(websocketUrl, async ({ evaluate }) => {
    await evaluate(`(() => {
      localStorage.setItem('inkloop.device.session.v1', ${JSON.stringify(browserSessionLiteral(session))});
      document.body.classList.remove('auth-open');
      const gate = document.getElementById('auth-gate');
      if (gate) gate.hidden = true;
      return true;
    })()`);
    const boot = await evaluate(`(() => ({
      hasInkLoop: !!window.__inkloop,
      keys: Object.keys(window.__inkloop || {}).sort()
    }))()`) as DeviceEvidence['boot'];
    if (!boot.hasInkLoop || !boot.keys?.includes('createSyntheticReadingMark')) {
      fail(`InkLoop Paper runtime is missing createSyntheticReadingMark; rebuild and reinstall the APK: ${JSON.stringify(boot.keys)}`);
    }

    const prepared = await evaluate(`(async () => {
      const api = window.__inkloop;
      const targetQuery = ${JSON.stringify(TARGET_DOCUMENT_QUERY)};
      const requireTarget = ${JSON.stringify(REQUIRE_TARGET_DOCUMENT)};
      const itemName = (item) => String(item.filename || item.title || item.doc?.filename || item.doc?.title || item.document_id || '');
      const matchesTarget = (item) => !targetQuery || itemName(item).toLowerCase().includes(targetQuery.toLowerCase());
      const candidateNames = (items) => items.map((item) => itemName(item)).filter(Boolean).slice(0, 12);
      await api.pullCloudLibraryManifest?.();
      let items = await api.listLibraryItems();
      let target = items.find((item) => item.local_available && matchesTarget(item) && (item.doc || item.document_id));
      if (!target) {
        target = items.find((item) => item.cloud_available && matchesTarget(item) && (item.doc || item.document_id));
        if (target) await api.downloadCloudLibraryItem(target);
        items = await api.listLibraryItems();
        target = items.find((item) => item.document_id === target?.document_id) || target;
      }
      if (!target && requireTarget) {
        return { ok: false, error: 'target_document_not_found', target_query: targetQuery, candidates: candidateNames(items) };
      }
      if (!target) target = items.find((item) => item.local_available && (item.doc || item.document_id));
      if (!target) {
        target = items.find((item) => item.cloud_available && (item.doc || item.document_id));
        if (target) await api.downloadCloudLibraryItem(target);
        items = await api.listLibraryItems();
        target = items.find((item) => item.document_id === target?.document_id) || target;
      }
      if (!target) return { ok: false, error: 'no_library_item_available' };
      await api.openBook(target.doc || target);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const active = api.getActiveContext?.();
      return {
        ok: active?.documentId === target.document_id,
        document_id: target.document_id,
        filename: target.filename || target.doc?.filename,
        target_query: targetQuery,
        target_matched: matchesTarget(target),
        candidates: candidateNames(items),
        active: active && {
          documentId: active.documentId,
          pageIndex: active.pageIndex,
          pageId: active.pageId,
          surfaceType: active.surfaceType
        }
      };
    })()`) as DeviceEvidence['prepared'];
    if (!prepared.ok || !prepared.document_id) fail(`could not prepare a local readable book on paper device: ${JSON.stringify(prepared)}`);

    const cloudCleanupBefore = CLEANUP_BEFORE
      ? await cleanupCloudKnowledgeDocument(prepared.document_id, runId)
      : null;
    if (cloudCleanupBefore && cloudCleanupBefore.ok !== true) fail(`Cloud Knowledge cleanup failed: ${JSON.stringify(cloudCleanupBefore)}`);

    const cleanupBefore = CLEANUP_BEFORE
      ? await evaluate(`(async () => {
          const api = window.__inkloop;
          const documentId = ${JSON.stringify(prepared.document_id)};
          const result = { document_id: documentId, local_marks_removed: 0, local_ai_turns_removed: 0, runtime_events_removed: 0, runtime_documents_removed: 0, local_storage_keys_removed: 0 };
          const req = (request) => new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
          });
          const txDone = (tx) => new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error('indexeddb_tx_failed'));
            tx.onabort = () => reject(tx.error || new Error('indexeddb_tx_aborted'));
          });
          const open = (name) => new Promise((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
          });
          const deleteByDocIndex = async (dbName, storeNames) => {
            const db = await open(dbName);
            try {
              const existing = storeNames.filter((name) => db.objectStoreNames.contains(name));
              if (!existing.length) return;
              const tx = db.transaction(existing, 'readwrite');
              await Promise.all(existing.map(async (name) => {
                const store = tx.objectStore(name);
                if (!store.indexNames.contains('by_doc')) return;
                const keys = await req(store.index('by_doc').getAllKeys(IDBKeyRange.only(documentId)));
                for (const key of keys || []) store.delete(key);
                if (name === 'marks') result.local_marks_removed += (keys || []).length;
                if (name === 'ai_turns') result.local_ai_turns_removed += (keys || []).length;
              }));
              await txDone(tx);
            } finally {
              db.close();
            }
          };
          const clearRuntimeStore = async () => {
            const db = await open('inkloop-runtime-store');
            try {
              const stores = ['documents', 'cache_records', 'outbox', 'applied_events', 'conflicts'].filter((name) => db.objectStoreNames.contains(name));
              if (!stores.length) return;
              const tx = db.transaction(stores, 'readwrite');
              if (stores.includes('documents')) {
                tx.objectStore('documents').delete(documentId);
                result.runtime_documents_removed += 1;
              }
              if (stores.includes('cache_records')) tx.objectStore('cache_records').delete(documentId);
              for (const name of ['outbox', 'applied_events', 'conflicts']) {
                if (!stores.includes(name)) continue;
                const store = tx.objectStore(name);
                const rows = await req(store.getAll());
                for (const row of rows || []) {
                  if (row?.doc_id === documentId || row?.document_id === documentId || row?.payload?.snapshot?.doc_id === documentId) {
                    const key = row.event_id || row.conflict_id || row.doc_id;
                    if (key) {
                      store.delete(key);
                      result.runtime_events_removed += 1;
                    }
                  }
                }
              }
              await txDone(tx);
            } finally {
              db.close();
            }
          };
          await deleteByDocIndex('inkloop', ['marks', 'ai_turns', 'ink_segments', 'ink_samples']);
          await clearRuntimeStore();
          for (const key of Object.keys(localStorage)) {
            if (key.includes(documentId) || key.includes('runtime-bridge.watermark')) {
              localStorage.removeItem(key);
              result.local_storage_keys_removed += 1;
            }
          }
          const target = (await api.listLibraryItems()).find((item) => item.document_id === documentId);
          if (target) {
            await api.openBook(target.doc || target);
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          return { ok: true, ...result };
        })()`)
      : null;

    const created = await evaluate(`(async () => {
      const api = window.__inkloop;
      const kinds = ${JSON.stringify(kinds)};
      const results = [];
      for (const kind of kinds) {
        const result = await api.createSyntheticReadingMark(kind);
        results.push(result);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return results;
    })()`) as MarkResult[];
    const failed = created.filter((item) => !item.ok || !item.mark_id);
    if (failed.length) fail(`reading mark creation failed: ${JSON.stringify(failed)}`);

    const beforeCount = created[0]?.folded_count ? created[0].folded_count - 1 : 0;
    const sync = await evaluate(`(async () => {
      await window.__inkloop.syncActiveRuntime();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { ok: true, active_document_id: window.__inkloop.getActiveContext?.()?.documentId };
    })()`);

    const markIds = created.map((item) => item.mark_id);
    const reopened = await evaluate(`(async () => {
      const api = window.__inkloop;
      const documentId = ${JSON.stringify(prepared.document_id)};
      const markIds = ${JSON.stringify(markIds)};
      const target = (await api.listLibraryItems()).find((item) => item.document_id === documentId);
      await api.openBook(target.doc || target);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const marks = await api.getFoldedMarks(documentId);
      const selected = marks
        .filter((mark) => markIds.includes(mark.mark_id))
        .map((mark) => ({
          mark_id: mark.mark_id,
          kind: mark.kind,
          feature_type: mark.feature_type,
          scored_type: mark.scored_type,
          origin: mark.origin,
          tool: mark.tool,
          visual_tools: (mark.strokes || []).map((stroke) => stroke.tool),
          marked_text: mark.marked_text,
          strokes: mark.strokes?.length || 0,
          page_index: mark.page_index
        }));
      return { ok: selected.length === markIds.length, after_count: marks.length, marks: selected };
    })()`) as DeviceEvidence['reopened'];
    if (!reopened.ok) fail(`reading marks did not survive reopen: ${JSON.stringify(reopened)}`);

    return { boot, prepared, before_count: beforeCount, created, reopened, sync, cleanup_before: cleanupBefore, cloud_cleanup_before: cloudCleanupBefore };
  }) as DeviceEvidence;

  const documentId = evidence.prepared.document_id;
  if (!documentId) fail(`prepared document id missing: ${JSON.stringify(evidence.prepared)}`);
  const runtimeEligibleKinds = new Set<ReadingMarkKind>(['highlight', 'underline', 'circle', 'handwriting', 'ai_pen']);
  const createdRuntimeMarkIds = evidence.created
    .filter((item) => item.kind && runtimeEligibleKinds.has(item.kind))
    .map((item) => item.mark_id)
    .filter(Boolean) as string[];
  const runtimeEvents = await waitForRuntimeMarks(documentId, createdRuntimeMarkIds);
  const runtimeKinds = runtimeEvents.map((event) => ({
    event_id: event.event_id,
    mark_id: (event.payload as { mark_id?: string }).mark_id,
    kind: (event.payload as { annotation?: { kind?: string } }).annotation?.kind,
    doc_id: event.doc_id,
  }));
  const expectedScoredTypes = new Set(['highlight', 'underline', 'circle', 'margin_note', 'review_later']);
  const actualScoredTypes = new Set(evidence.reopened.marks?.map((mark) => mark.scored_type));
  for (const expected of expectedScoredTypes) {
    if (!actualScoredTypes.has(expected)) fail(`missing reopened reading mark type ${expected}: ${JSON.stringify(evidence.reopened.marks)}`);
  }
  const reviewLater = evidence.reopened.marks?.find((mark) => mark.scored_type === 'review_later');
  if (!reviewLater || reviewLater.strokes !== 0) fail(`review_later should persist as a silent local reading state without visible ink: ${JSON.stringify(reviewLater)}`);
  const highlight = evidence.reopened.marks?.find((mark) => mark.scored_type === 'highlight');
  if (!highlight?.visual_tools?.includes('highlighter')) fail(`highlight should persist as highlighter ink: ${JSON.stringify(highlight)}`);
  const underline = evidence.reopened.marks?.find((mark) => mark.scored_type === 'underline');
  if (!underline?.visual_tools?.includes('underline')) fail(`underline should persist as underline ink: ${JSON.stringify(underline)}`);
  const aiPen = evidence.reopened.marks?.find((mark) => mark.kind === 'ai_pen' || mark.origin === 'ai_pen' || mark.visual_tools?.includes('aipen'));
  if (!aiPen?.visual_tools?.includes('aipen') || aiPen.origin !== 'ai_pen') fail(`AI pen should persist as aipen ink with ai_pen origin: ${JSON.stringify(aiPen)}`);

  if (CLEANUP_AFTER) {
    evidence.cleanup_after = await withCdp(websocketUrl, async ({ evaluate }) => evaluate(`(async () => window.__inkloop.clearCurrentBookAnnotationsForDebug?.(true) || { ok: false, error: 'missing_cleanup_bridge' })()`));
  }

  const reportPath = join(OUTPUT_ROOT, `paper-reading-mark-types-${runId}.json`);
  const report = {
    ok: true,
    latency_ms: Date.now() - started,
    started_at: startedAt,
    device: { serial, pid, model, manufacturer, android_version, cdp_port: port, page_title: pageTitle },
    cloud_hub: {
      base_url: CLOUD_HUB_BASE,
      tenant_id: cloudSession?.tenant_id,
      user_id: cloudSession?.user_id,
      device_id: cloudSession?.device_id,
    },
    document: {
      document_id: documentId,
      filename: evidence.prepared.filename,
    },
    reading_mark_types: {
      created: evidence.created,
      reopened: evidence.reopened,
      runtime_events: runtimeKinds,
    },
    evidence,
    output: { report_path: reportPath },
  };
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
