import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { runReflow, runReflowAi, reflowAiStream, chatStream, runOcrVlm, runExplainImage, runInterpret, runClassifyContext, runReflowVlm } from './server/infer';
import { debugEvent, debugSnapshot } from './server/debug.mjs';
import { runOcrLayout } from './server/ocr-layout-dev.mjs'; // dev-only：扫描页带坐标 OCR（mac_runner），不进生产代理
import { runInterpretHwr } from './server/hwr-dev.mjs';     // dev-only：英文手写识别（OpenVINO 徐方案模型），不进生产代理
import { parseDocumentProjection } from './src/knowledge/document-projection';
import { parseKnowledgeObject } from './src/knowledge/knowledge-object';
import { koId } from './src/knowledge/ulid';
import { RuntimeSyncRunner, SidecarRuntimeStore, type RuntimeSyncTransportPort, type RuntimeSyncEvent } from './src/runtime';
import {
  JsonAdapterStorage,
  JsonlWatchOutbox,
  obsidianFsAdapter,
  obsidianFsDocumentAdapter,
  scanObsidianFsChanges,
  watchOutboxPath,
} from './src/adapters/obsidian-fs';

const LAB_RUN_DIR = path.resolve(process.env.INKLOOP_LAB_RUN_DIR ?? path.join(process.cwd(), '.inkloop-smoke-runs', '20260626-real-flow'));

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function listMarkdownFiles(dir: string, root = dir): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(absolute, root);
      if (entry.isFile() && entry.name.endsWith('.md')) return [path.relative(root, absolute).split(path.sep).join('/')];
      return [];
    }));
    return nested.flat().sort();
  } catch {
    return [];
  }
}

async function labContext() {
  const vaultRoot = path.join(LAB_RUN_DIR, 'obsidian-vault');
  const target = await obsidianFsAdapter.resolveTarget({ vault_root: vaultRoot });
  const storage = JsonAdapterStorage.forVault(target.vault_root, target.base_dir);
  const sourceFiles = await listMarkdownFiles(target.sources_dir, target.sources_dir);
  const sourcePath = sourceFiles[0] ? path.join(target.sources_dir, sourceFiles[0]) : null;
  const exportPath = path.join(LAB_RUN_DIR, 'scenario-export.json');
  const raw = await readJsonFile<{ objects?: unknown[]; document_projections?: unknown[] }>(exportPath, {});
  const objects = (raw.objects ?? []).map(parseKnowledgeObject);
  const projections = (raw.document_projections ?? []).map(parseDocumentProjection);
  return { vaultRoot, target, storage, sourcePath, objects, projections };
}

function writeJsonResponse(res: { setHeader(name: string, value: string): void; end(data?: string): void; statusCode: number }, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

function readRequestJson<T>(req: { on(event: string, callback: (chunk?: Buffer | string) => void): void }): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk || ''); });
    req.on('end', () => {
      try {
        resolve((body ? JSON.parse(body) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

type LabMutationRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null };
};

type LabResponse = {
  setHeader(name: string, value: string): void;
  end(data?: string): void;
  statusCode: number;
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(address?: string | null): boolean {
  const clean = String(address || '').replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

function urlHost(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function isSameOriginRequest(req: LabMutationRequest): boolean {
  const host = firstHeader(req.headers.host)?.toLowerCase();
  if (!host) return false;
  const originHost = urlHost(firstHeader(req.headers.origin));
  if (originHost) return originHost === host;
  const refererHost = urlHost(firstHeader(req.headers.referer));
  return refererHost === host;
}

function hasValidLabToken(req: LabMutationRequest): boolean {
  const expected = process.env.INKLOOP_LAB_WRITE_TOKEN?.trim();
  if (!expected) return false;
  return firstHeader(req.headers['x-inkloop-lab-token']) === expected;
}

function requireLabMutation(req: LabMutationRequest, res: LabResponse): boolean {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('POST only');
    return false;
  }
  if (isLoopbackAddress(req.socket?.remoteAddress) || isSameOriginRequest(req) || hasValidLabToken(req)) return true;
  writeJsonResponse(res, {
    ok: false,
    error: 'Forbidden Obsidian Lab mutation. Open the Web Lab from the same origin, use loopback, or send x-inkloop-lab-token.',
  }, 403);
  return false;
}

async function readWatchEvents(filePath: string): Promise<unknown[]> {
  try {
    return (await readFile(filePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    return (await readFile(filePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

interface SidecarSurfaceBlock {
  object_id: string;
  text?: string;
  source_anchor?: {
    quote?: string;
    range?: { start_line: number; start_col: number; end_line: number; end_col: number };
  };
  projection?: {
    block_id?: string;
    kind?: string;
    region?: string;
    page_index?: number;
    knowledge_object_ids?: string[];
  };
  annotations?: unknown[];
}

async function labSidecarPaths() {
  const context = await labContext();
  const projection = context.projections[0];
  if (!projection) throw new Error('No document projection found. Run scripts/smoke-real-obsidian-flow.ts first.');
  const docDir = path.join(context.vaultRoot, context.target.base_dir, 'docs', projection.document_id);
  return {
    ...context,
    projection,
    docDir,
    blocksPath: path.join(docDir, 'surfaces', 'markdown.blocks.jsonl'),
    documentPath: path.join(docDir, 'document.json'),
  };
}

async function labRuntimeStore() {
  const context = await labSidecarPaths();
  return {
    ...context,
    runtimeStore: new SidecarRuntimeStore({ vaultRoot: context.vaultRoot, baseDir: context.target.base_dir }),
  };
}

async function readLabVisualModel() {
  const { documentPath, blocksPath } = await labSidecarPaths();
  const documentRecord = await readJsonFile<{ title?: string }>(documentPath, {});
  const blocks = await readJsonLines<SidecarSurfaceBlock>(blocksPath);
  return {
    documentTitle: documentRecord.title || 'InkLoop document',
    blocks: blocks.map((block) => ({
      id: block.projection?.block_id || block.object_id,
      kind: block.projection?.kind || 'paragraph',
      region: block.projection?.region || 'editable',
      page: block.projection?.page_index === undefined ? undefined : String(block.projection.page_index),
      content: block.source_anchor?.quote || block.text || '',
      annotations: block.annotations || [],
    })),
  };
}

class LabRuntimeCloudTransport implements RuntimeSyncTransportPort {
  constructor(private readonly inboxPath: string) {}

  async send(events: RuntimeSyncEvent[]) {
    await Promise.all(events.map((event) => appendJsonLine(this.inboxPath, {
      schema_version: 'inkloop.runtime_cloud_received_event.v1',
      received_at: new Date().toISOString(),
      event,
    })));
    return events.map((event) => ({ event_id: event.event_id, ok: true, ack_id: `local_ack_${event.event_id}` }));
  }
}

async function runLabRuntimeSync() {
  const { runtimeStore } = await labRuntimeStore();
  const runner = new RuntimeSyncRunner(
    runtimeStore,
    new LabRuntimeCloudTransport(path.join(LAB_RUN_DIR, 'runtime-cloud-inbox.jsonl')),
    { retryDelayMs: 500 },
  );
  return runner.runOnce();
}

/** dev-only AI 代理：浏览器 POST /api/* → 网关 → 各识别/重排/对话端点。Key 留服务端。 */
function inferenceProxy(env: Record<string, string>): Plugin {
  return {
    name: 'inkloop-inference-proxy',
    configureServer(server) {
      for (const k of ['LLM_GATEWAY_URL', 'LLM_GATEWAY_KEY', 'LLM_MODEL']) {
        if (env[k] && !process.env[k]) process.env[k] = env[k];
      }
      const post = (path: string, fn: (body: unknown) => Promise<unknown>) =>
        server.middlewares.use(path, (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            res.setHeader('content-type', 'application/json');
            try {
              res.end(JSON.stringify(await fn(JSON.parse(body))));
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: String((e as Error)?.message || e) }));
            }
          });
        });
      // dev-only 调试通道：客户端镜像 inspect → JSONL + 内存环；GET 快照供外部读。
      post('/api/__debug/event', async (b) => debugEvent(b));
      server.middlewares.use('/api/__debug/snapshot', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
        res.setHeader('content-type', 'application/json');
        try {
          const n = new URL(req.url || '/', 'http://localhost').searchParams.get('n');
          res.end(JSON.stringify(debugSnapshot(n ? Number(n) : 20)));
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
      });

      server.middlewares.use('/api/obsidian-lab/state', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
        try {
          const { vaultRoot, target, storage, sourcePath } = await labContext();
          const runtimeEvents = await labRuntimeStore()
            .then(({ runtimeStore }) => runtimeStore.listOutboxEvents())
            .catch(() => []);
          const bindings = await storage.listBindings({ target_id: target.target_id });
          const externalEdits = await storage.listExternalEdits({});
          const documentFiles = await listMarkdownFiles(target.sources_dir, vaultRoot);
          const dataFiles = await listMarkdownFiles(path.join(vaultRoot, target.base_dir), vaultRoot);
          const sourceMarkdown = sourcePath ? await readFile(sourcePath, 'utf8') : '';
          const visualModel = await readLabVisualModel().catch(() => null);
          const watchEvents = [
            ...await readWatchEvents(path.join(LAB_RUN_DIR, 'watch-events.jsonl')),
            ...await readWatchEvents(watchOutboxPath(target)),
            ...runtimeEvents,
          ];
          writeJsonResponse(res, {
            ok: true,
            run_dir: LAB_RUN_DIR,
            vault_root: vaultRoot,
            base_dir: target.base_dir,
            documents_dir: target.documents_dir,
            source_path: sourcePath,
            source_markdown: sourceMarkdown,
            visual_model: visualModel,
            files: [...documentFiles, ...dataFiles].sort(),
            bindings,
            external_edits: externalEdits,
            runtime_sync_events: runtimeEvents,
            watch_events: watchEvents,
            updated_at: new Date().toISOString(),
          });
        } catch (error) {
          writeJsonResponse(res, { ok: false, error: String((error as Error)?.message || error), run_dir: LAB_RUN_DIR }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/write-test-edit', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        try {
          const { sourcePath } = await labContext();
          if (!sourcePath) throw new Error('No source document found. Run scripts/smoke-real-obsidian-flow.ts first.');
          const markdown = await readFile(sourcePath, 'utf8');
          const marker = '<!-- inkloop:block-end id=blk_p001_code_paragraph -->';
          const stamp = `Web lab edit: ${new Date().toISOString()}`;
          const next = markdown.includes(marker)
            ? markdown.replace(marker, `${stamp}\n\n${marker}`)
            : `${markdown.trimEnd()}\n\n${stamp}\n`;
          await writeFile(sourcePath, next, 'utf8');
          writeJsonResponse(res, { ok: true, source_path: sourcePath, inserted: stamp });
        } catch (error) {
          writeJsonResponse(res, { ok: false, error: String((error as Error)?.message || error) }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/update-block', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        try {
          const body = await readRequestJson<{ block_id?: string; content?: string }>(req);
          if (!body.block_id) throw new Error('block_id is required');
          const { projection, runtimeStore } = await labRuntimeStore();
          const result = await runtimeStore.updateBlockContent({
            doc_id: projection.document_id,
            block_id: body.block_id,
            content: String(body.content ?? ''),
            source: 'web_lab',
            commit_target: { type: 'markdown_source_patch' },
          });
          writeJsonResponse(res, { ok: true, source_path: result.source_path, block_id: body.block_id, sync_event: result.sync_event, updated_at: result.updated_at });
        } catch (error) {
          writeJsonResponse(res, { ok: false, error: String((error as Error)?.message || error) }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/update-annotation', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        try {
          const body = await readRequestJson<{ ko_id?: string; patch?: Record<string, unknown> }>(req);
          if (!body.ko_id) throw new Error('ko_id is required');
          const { projection, runtimeStore } = await labRuntimeStore();
          const result = await runtimeStore.updateAnnotation({
            doc_id: projection.document_id,
            ko_id: body.ko_id,
            patch: body.patch ?? {},
            source: 'web_lab',
          });
          writeJsonResponse(res, { ok: true, source_path: result.source_path, ko_id: body.ko_id, sync_event: result.sync_event, updated_at: result.updated_at });
        } catch (error) {
          writeJsonResponse(res, { ok: false, error: String((error as Error)?.message || error) }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/add-annotation', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        try {
          const body = await readRequestJson<{
            block_id?: string;
            kind?: string;
            title?: string;
            body_md?: string;
            render_mode?: 'stroke_only' | 'margin_note';
            visual_bbox?: [number, number, number, number];
            visual_strokes?: Array<{ tool?: 'pen' | 'highlighter'; color?: string; opacity?: number; points: Array<{ x: number; y: number; t?: number; pressure?: number }> }>;
          }>(req);
          if (!body.block_id) throw new Error('block_id is required');
          const now = new Date().toISOString();
          const isStrokeOnly = body.render_mode === 'stroke_only' || (body.visual_strokes?.length ? !body.body_md : false);
          const { projection, runtimeStore } = await labRuntimeStore();
          const result = await runtimeStore.addAnnotation({
            doc_id: projection.document_id,
            block_id: body.block_id,
            source: 'web_lab',
            annotation: {
              ko_id: koId(),
              kind: body.kind || 'annotation',
              title: body.title || `Hand mark ${now.slice(11, 19)}`,
              body_md: body.body_md ?? '',
              status: 'edited',
              render_mode: isStrokeOnly ? 'stroke_only' : body.render_mode,
              visual_bbox: body.visual_bbox,
              visual_strokes: body.visual_strokes,
            },
          });
          writeJsonResponse(res, { ok: true, source_path: result.source_path, block_id: body.block_id, annotation: result.annotation, sync_event: result.sync_event, updated_at: result.updated_at });
        } catch (error) {
          writeJsonResponse(res, { ok: false, error: String((error as Error)?.message || error) }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/sync-runtime', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        const started = performance.now();
        try {
          const runtimeSync = await runLabRuntimeSync();
          writeJsonResponse(res, {
            ok: true,
            latency_ms: Math.round(performance.now() - started),
            runtime_sync: runtimeSync,
          });
        } catch (error) {
          writeJsonResponse(res, {
            ok: false,
            latency_ms: Math.round(performance.now() - started),
            error: String((error as Error)?.message || error),
          }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/reset', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        try {
          const { vaultRoot, target, objects, projections } = await labContext();
          await Promise.all([
            rm(target.sources_dir, { recursive: true, force: true }),
            rm(path.join(vaultRoot, target.base_dir), { recursive: true, force: true }),
          ]);

          const resetTarget = await obsidianFsAdapter.resolveTarget({ vault_root: vaultRoot });
          const resetStorage = JsonAdapterStorage.forVault(resetTarget.vault_root, resetTarget.base_dir);
          const documentResult = projections.length
            ? await obsidianFsDocumentAdapter.exportDocuments({ projections, target: resetTarget, storage: resetStorage, knowledgeObjects: objects })
            : undefined;
          const objectResult = objects.length
            ? await obsidianFsAdapter.exportObjects({ objects, target: resetTarget, storage: resetStorage, documentProjections: projections })
            : undefined;

          await writeFile(path.join(LAB_RUN_DIR, 'lab-watch-snapshot.json'), '{}\n', 'utf8');
          await writeFile(path.join(LAB_RUN_DIR, 'watch-events.jsonl'), '', 'utf8');
          writeJsonResponse(res, {
            ok: true,
            vault_root: vaultRoot,
            documents_dir: resetTarget.documents_dir,
            base_dir: resetTarget.base_dir,
            document_results: documentResult?.results ?? [],
            object_results: objectResult?.results ?? [],
            updated_at: new Date().toISOString(),
          });
        } catch (error) {
          writeJsonResponse(res, { ok: false, error: String((error as Error)?.message || error) }, 500);
        }
      });

      server.middlewares.use('/api/obsidian-lab/pull', async (req, res) => {
        if (!requireLabMutation(req, res)) return;
        const started = performance.now();
        try {
          const { target, storage, objects, projections } = await labContext();
          const bindings = await storage.listBindings({ target_id: target.target_id });
          const snapshotPath = path.join(LAB_RUN_DIR, 'lab-watch-snapshot.json');
          const previous = await readJsonFile(snapshotPath, {});
          const watch = await scanObsidianFsChanges({
            target,
            bindings,
            previous,
            outbox: new JsonlWatchOutbox(watchOutboxPath(target)),
          });
          await writeFile(snapshotPath, `${JSON.stringify(watch.snapshot, null, 2)}\n`, 'utf8');
          const documentResult = projections.length
            ? await obsidianFsDocumentAdapter.pullExternalEdits({ projections, target, storage, bindings, knowledgeObjects: objects })
            : { external_edits: [], conflicts: [], warnings: [] };
          const metadataResult = objects.length
            ? await obsidianFsAdapter.pullMetadata({ target, bindings: bindings.filter((binding) => objects.some((object) => object.ko_id === binding.ko_id)) })
            : { updates: [], warnings: [] };
          const externalEdits = await storage.listExternalEdits({});
          const runtimeSync = await runLabRuntimeSync().catch((error) => ({
            ok: false,
            error: String((error as Error)?.message || error),
          }));
          writeJsonResponse(res, {
            ok: true,
            latency_ms: Math.round(performance.now() - started),
            watch_events: watch.events,
            document_external_edits: documentResult.external_edits,
            document_conflicts: documentResult.conflicts,
            document_warnings: documentResult.warnings,
            task_metadata_updates: metadataResult.updates,
            task_metadata_warnings: metadataResult.warnings,
            external_edit_count: externalEdits.length,
            runtime_sync: runtimeSync,
          });
        } catch (error) {
          writeJsonResponse(res, { ok: false, latency_ms: Math.round(performance.now() - started), error: String((error as Error)?.message || error) }, 500);
        }
      });

      post('/api/reflow', runReflow);
      post('/api/reflow-ai', runReflowAi);
      // 流式重排：NDJSON chunked——边收模型分组边写回，前端按段渲染。非流式端点(/api/reflow-ai)留给预热/兜底。
      server.middlewares.use('/api/reflow-ai-stream', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('x-accel-buffering', 'no'); // 禁中间层缓冲，保证逐块到达
          try {
            for await (const group of reflowAiStream(JSON.parse(body))) {
              res.write(JSON.stringify(group) + '\n');
            }
            res.end();
          } catch (e) {
            if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
            else res.end();
          }
        });
      });
      post('/api/ocr-vlm', runOcrVlm);
      post('/api/ocr-layout', runOcrLayout); // dev-only：扫描页带坐标 OCR → 位置文本层（Phase 2）
      post('/api/interpret-hwr', runInterpretHwr); // dev-only：英文手写识别（OpenVINO 徐方案模型）
      post('/api/explain-image', runExplainImage);
      post('/api/interpret', runInterpret);
      post('/api/classify-context', runClassifyContext);
      post('/api/reflow-vlm', runReflowVlm);

      // 网页对话式聊天（流式·替代退役的 Agent SDK 会话）：客户端持每本书 buffer、整串 messages 传入，
      // 服务端无状态、逐段 text/plain 增量写回。chat/ 面板（P4）消费它。
      server.middlewares.use('/api/chat', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('x-accel-buffering', 'no');
          try {
            for await (const delta of chatStream(JSON.parse(body))) res.write(delta);
            res.end();
          } catch (e) {
            if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
            else res.end();
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    // 相对基址：安卓 WebViewAssetLoader 从本地 assets 加载 index.html，绝对 /assets/ 路径会错。
    // dev 下相对基址同样工作；public 资产仍服务于根，配合 renderer 的 BASE_URL 相对解析。
    base: './',
    resolve: {
      alias: {
        'ink-surface-sdk': path.resolve(import.meta.dirname, '../../src/index.ts'),
      },
    },
    server: {
      port: 8765,
      strictPort: true,
      watch: {
        ignored: [
          '**/.inkloop-smoke-runs/**',
          '**/.inkloop/**',
          '**/.obsidian/**',
        ],
      },
    },
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          // pdfjs-dist 本体(~数百KB)拆出主包，否则 index.js 触发 >500KB 警告。
          // worker(.mjs)本就独立加载，这里拆的是主线程那半。
          manualChunks(id) {
            if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs';
          },
        },
      },
    },
    plugins: [inferenceProxy(env)],
  };
});
