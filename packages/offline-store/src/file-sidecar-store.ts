import { appendFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AddRuntimeAnnotationInput,
  RuntimeAnnotation,
  RuntimeCommitTarget,
  RuntimeDocumentRecord,
  RuntimeDocumentSnapshot,
  RuntimeMutationResult,
  RuntimeSourceRef,
  RuntimeSurfaceBlock,
  RuntimeSyncEvent,
  UpdateRuntimeAnnotationInput,
  UpdateRuntimeBlockContentInput,
} from '../../runtime-schema/src/index.js';
import type { OfflineDocumentCacheRecord, OfflineRuntimeStorePort } from './index.js';

export interface SidecarRuntimeStoreConfig {
  vaultRoot: string;
  baseDir?: string;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.inkloop.tmp`;
  const bak = `${filePath}.inkloop.bak`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, filePath);
  } catch (error) {
    const current = await readTextIfExists(filePath);
    if (current !== null) await writeFile(bak, current, 'utf8');
    try {
      await unlink(filePath);
    } catch {
      // File may not exist on first write.
    }
    try {
      await rename(tmp, filePath);
      await rm(bak, { force: true });
    } catch (innerError) {
      if (current !== null) await writeFile(filePath, current, 'utf8');
      throw innerError instanceof Error ? innerError : error;
    }
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const text = await readTextIfExists(filePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  const text = await readTextIfExists(filePath);
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function writeJsonLines(filePath: string, values: unknown[]): Promise<void> {
  await atomicWrite(filePath, values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : ''));
}

function normalizeMarkdownText(input: string): string {
  return input
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function blockId(block: RuntimeSurfaceBlock): string {
  return block.projection?.block_id || block.object_id;
}

function cleanPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function eventDedupeKey(event: Omit<RuntimeSyncEvent, 'dedupe_key'>): string {
  return `${event.operation}:${event.doc_id}:${event.target.id ?? event.target.block_id ?? 'document'}:${event.updated_at}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function sha256Tagged(input: string): Promise<string> {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function koId(): string {
  return `ko_${randomUUID().replace(/-/g, '')}`;
}

function resolveVaultRelative(vaultRoot: string, vaultPath: string): string {
  const cleanPath = vaultPath.trim();
  if (!cleanPath || path.isAbsolute(cleanPath)) throw new Error('InkLoop source path must be vault-relative.');
  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, cleanPath);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`InkLoop source path escapes the vault: ${vaultPath}`);
  }
  return resolvedPath;
}

export class SidecarRuntimeStore implements OfflineRuntimeStorePort {
  private readonly vaultRoot: string;
  private readonly baseDir: string;

  constructor(config: SidecarRuntimeStoreConfig) {
    this.vaultRoot = config.vaultRoot;
    this.baseDir = config.baseDir ?? '.inkloop';
  }

  sidecarPath(...parts: string[]): string {
    return path.join(this.vaultRoot, this.baseDir, ...parts);
  }

  docDir(docId: string): string {
    return this.sidecarPath('docs', docId);
  }

  outboxPath(): string {
    return this.sidecarPath('outbox', 'runtime-events.jsonl');
  }

  cacheRecordPath(docId: string): string {
    return path.join(this.docDir(docId), 'cache.json');
  }

  sourceAbsolutePath(source: RuntimeSourceRef): string | undefined {
    return source.vault_file?.path ? resolveVaultRelative(this.vaultRoot, source.vault_file.path) : undefined;
  }

  async loadDocument(docId: string): Promise<RuntimeDocumentSnapshot | null> {
    const docDir = this.docDir(docId);
    const document = await readJsonFile<RuntimeDocumentRecord | null>(path.join(docDir, 'document.json'), null);
    const source = await readJsonFile<RuntimeSourceRef | null>(path.join(docDir, 'source.json'), null);
    if (!document || !source) return null;

    const blocksPath = document.source_type === 'markdown'
      ? path.join(docDir, 'surfaces', 'markdown.blocks.jsonl')
      : path.join(docDir, 'surfaces', 'pdf.pages.jsonl');

    return {
      doc_id: docId,
      doc_dir: docDir,
      document,
      source,
      blocks: await readJsonLines<RuntimeSurfaceBlock>(blocksPath),
      nodes: await readJsonLines<Record<string, unknown>>(path.join(docDir, 'canvas', 'nodes.jsonl')),
    };
  }

  async writeRuntimeBlocks(runtime: RuntimeDocumentSnapshot, blocks: RuntimeSurfaceBlock[]): Promise<void> {
    const blocksPath = runtime.document.source_type === 'markdown'
      ? path.join(runtime.doc_dir, 'surfaces', 'markdown.blocks.jsonl')
      : path.join(runtime.doc_dir, 'surfaces', 'pdf.pages.jsonl');
    await writeJsonLines(blocksPath, blocks);
  }

  async listOutboxEvents(): Promise<RuntimeSyncEvent[]> {
    return readJsonLines<RuntimeSyncEvent>(this.outboxPath());
  }

  async writeOutboxEvents(events: RuntimeSyncEvent[]): Promise<void> {
    await writeJsonLines(this.outboxPath(), events);
  }

  async appendSyncEvent(event: RuntimeSyncEvent): Promise<void> {
    await ensureDir(path.dirname(this.outboxPath()));
    await appendFile(this.outboxPath(), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async getCacheRecord(docId: string): Promise<OfflineDocumentCacheRecord | null> {
    return readJsonFile<OfflineDocumentCacheRecord | null>(this.cacheRecordPath(docId), null);
  }

  async writeCacheRecord(record: OfflineDocumentCacheRecord): Promise<void> {
    await writeJsonFile(this.cacheRecordPath(record.doc_id), record);
  }

  async listPendingEvents(docId?: string): Promise<RuntimeSyncEvent[]> {
    return (await this.listOutboxEvents()).filter((event) => event.status !== 'sent' && (!docId || event.doc_id === docId));
  }

  async updateBlockContent(input: UpdateRuntimeBlockContentInput): Promise<RuntimeMutationResult> {
    const runtime = await this.requireDocument(input.doc_id);
    const index = runtime.blocks.findIndex((block) => blockId(block) === input.block_id);
    if (index === -1) throw new Error(`InkLoop block was not found: ${input.block_id}`);

    const now = nowIso();
    const commitTarget = input.commit_target ?? { type: 'sidecar_only' };
    const block = runtime.blocks[index];
    const nextLines = String(input.content ?? '').trimEnd().split('\n');
    const quote = normalizeMarkdownText(input.content);
    const nextBlocks = [...runtime.blocks];
    let sourcePath: string | undefined;
    let sourceContentHash: string | undefined;

    if (commitTarget.type === 'markdown_source_patch') {
      const patch = await this.patchMarkdownSource({ runtime, block, content: input.content, commitTarget });
      sourcePath = patch.sourcePath;
      sourceContentHash = patch.sourceContentHash;
      this.shiftBlockRanges(nextBlocks, index, patch.lineDelta);
    }

    const range = block.source_anchor?.range;
    const nextRange = range
      ? {
          ...range,
          end_line: range.start_line + nextLines.length - 1,
          end_col: nextLines[nextLines.length - 1]?.length ?? 0,
        }
      : undefined;

    nextBlocks[index] = {
      ...block,
      text: quote,
      source_anchor: {
        ...(block.source_anchor || {}),
        quote,
        ...(nextRange ? { range: nextRange } : {}),
      },
      fingerprint: {
        ...(block.fingerprint || {}),
        text_hash: await sha256Tagged(quote),
      },
    };

    await this.writeRuntimeBlocks(runtime, nextBlocks);
    await this.touchDocument(runtime, now);

    const event = this.makeEvent({
      source: input.source,
      doc_id: input.doc_id,
      operation: 'block.update',
      target: { type: 'block', id: input.block_id, block_id: input.block_id },
      payload: {
        block_id: input.block_id,
        quote,
        content_md: input.content,
        commit_target: commitTarget,
        source_path: sourcePath,
        source_content_hash: sourceContentHash,
        range: nextRange,
      },
      now,
    });
    await this.appendSyncEvent(event);

    return { doc_id: input.doc_id, source_path: sourcePath, block_id: input.block_id, sync_event: event, updated_at: now };
  }

  async updateAnnotation(input: UpdateRuntimeAnnotationInput): Promise<RuntimeMutationResult> {
    const runtime = await this.requireDocument(input.doc_id);
    const now = nowIso();
    const patch = cleanPatch(input.patch);
    let didUpdate = false;
    let targetBlockId: string | undefined;

    const blocks = runtime.blocks.map((block) => {
      const annotations = (block.annotations || []).map((annotation) => {
        if (annotation.ko_id !== input.ko_id) return annotation;
        didUpdate = true;
        targetBlockId = blockId(block);
        return { ...annotation, ...patch, updated_at: now };
      });
      return { ...block, annotations };
    });

    if (!didUpdate) throw new Error(`InkLoop annotation was not found: ${input.ko_id}`);
    await this.writeRuntimeBlocks(runtime, blocks);
    await this.touchDocument(runtime, now);

    const event = this.makeEvent({
      source: input.source,
      doc_id: input.doc_id,
      operation: 'annotation.update',
      target: { type: 'annotation', id: input.ko_id, block_id: targetBlockId },
      payload: { ko_id: input.ko_id, block_id: targetBlockId, patch },
      now,
    });
    await this.appendSyncEvent(event);

    return { doc_id: input.doc_id, source_path: this.sourceAbsolutePath(runtime.source), ko_id: input.ko_id, sync_event: event, updated_at: now };
  }

  async addAnnotation(input: AddRuntimeAnnotationInput): Promise<RuntimeMutationResult> {
    const runtime = await this.requireDocument(input.doc_id);
    const index = runtime.blocks.findIndex((block) => blockId(block) === input.block_id);
    if (index === -1) throw new Error(`InkLoop block was not found: ${input.block_id}`);

    const now = nowIso();
    const annotation = this.buildAnnotation(input, now);
    const blocks = [...runtime.blocks];
    const block = blocks[index];
    blocks[index] = {
      ...block,
      annotations: [...(block.annotations || []), annotation],
      projection: {
        ...(block.projection || {}),
        knowledge_object_ids: [...new Set([...(block.projection?.knowledge_object_ids || []), annotation.ko_id])],
      },
    };

    await this.writeRuntimeBlocks(runtime, blocks);
    await this.touchDocument(runtime, now);

    const event = this.makeEvent({
      source: input.source,
      doc_id: input.doc_id,
      operation: 'annotation.add',
      target: { type: 'annotation', id: annotation.ko_id, block_id: input.block_id },
      payload: { block_id: input.block_id, annotation },
      now,
    });
    await this.appendSyncEvent(event);

    return {
      doc_id: input.doc_id,
      source_path: this.sourceAbsolutePath(runtime.source),
      block_id: input.block_id,
      ko_id: annotation.ko_id,
      annotation,
      sync_event: event,
      updated_at: now,
    };
  }

  private async requireDocument(docId: string): Promise<RuntimeDocumentSnapshot> {
    const runtime = await this.loadDocument(docId);
    if (!runtime) throw new Error(`InkLoop runtime document is missing: ${docId}`);
    return runtime;
  }

  private async patchMarkdownSource(input: {
    runtime: RuntimeDocumentSnapshot;
    block: RuntimeSurfaceBlock;
    content: string;
    commitTarget: RuntimeCommitTarget;
  }): Promise<{ sourcePath: string; sourceContentHash: string; lineDelta: number }> {
    if (input.commitTarget.type !== 'markdown_source_patch') throw new Error('Unsupported source patch target.');
    const sourcePath = this.sourceAbsolutePath(input.runtime.source);
    if (!sourcePath) throw new Error('InkLoop source is missing.');
    const range = input.block.source_anchor?.range;
    if (!range) throw new Error(`InkLoop block has no editable source range: ${blockId(input.block)}`);

    const markdown = await readFile(sourcePath, 'utf8');
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const nextLines = input.content.trimEnd().split('\n');
    const oldLineCount = range.end_line - range.start_line + 1;
    lines.splice(range.start_line - 1, oldLineCount, ...nextLines);
    const nextMarkdown = lines.join('\n');
    await atomicWrite(sourcePath, nextMarkdown);

    const sourceContentHash = await sha256Tagged(nextMarkdown);
    input.runtime.source.identity = {
      ...(input.runtime.source.identity || {}),
      current_content_hash: sourceContentHash,
      size: Buffer.byteLength(nextMarkdown, 'utf8'),
    };
    await writeJsonFile(path.join(input.runtime.doc_dir, 'source.json'), input.runtime.source);

    return { sourcePath, sourceContentHash, lineDelta: nextLines.length - oldLineCount };
  }

  private shiftBlockRanges(blocks: RuntimeSurfaceBlock[], changedIndex: number, lineDelta: number): void {
    if (lineDelta === 0) return;
    const changedRange = blocks[changedIndex]?.source_anchor?.range;
    if (!changedRange) return;
    for (let index = 0; index < blocks.length; index += 1) {
      if (index === changedIndex) continue;
      const range = blocks[index]?.source_anchor?.range;
      if (!range || range.start_line <= changedRange.end_line) continue;
      blocks[index] = {
        ...blocks[index],
        source_anchor: {
          ...(blocks[index].source_anchor || {}),
          range: {
            ...range,
            start_line: range.start_line + lineDelta,
            end_line: range.end_line + lineDelta,
          },
        },
      };
    }
  }

  private buildAnnotation(input: AddRuntimeAnnotationInput, now: string): RuntimeAnnotation {
    const annotation = input.annotation ?? {};
    return {
      ...annotation,
      ko_id: annotation.ko_id ?? koId(),
      kind: annotation.kind ?? input.kind ?? 'annotation',
      title: annotation.title ?? input.title ?? `Hand mark ${now.slice(11, 19)}`,
      body_md: annotation.body_md ?? input.body_md ?? '',
      status: annotation.status ?? 'edited',
      render_mode: annotation.render_mode ?? input.render_mode,
      visual_bbox: annotation.visual_bbox ?? input.visual_bbox,
      visual_strokes: annotation.visual_strokes ?? input.visual_strokes,
      created_at: typeof annotation.created_at === 'string' ? annotation.created_at : now,
      updated_at: now,
    };
  }

  private async touchDocument(runtime: RuntimeDocumentSnapshot, now: string): Promise<void> {
    const document = { ...runtime.document, updated_at: now };
    await writeJsonFile(path.join(runtime.doc_dir, 'document.json'), document);
  }

  private makeEvent(input: {
    source: RuntimeSyncEvent['source'];
    doc_id: string;
    operation: RuntimeSyncEvent['operation'];
    target: RuntimeSyncEvent['target'];
    payload: Record<string, unknown>;
    now: string;
  }): RuntimeSyncEvent {
    const eventWithoutDedupe: Omit<RuntimeSyncEvent, 'dedupe_key'> = {
      schema_version: 'inkloop.runtime_sync_event.v1',
      event_id: `evt_${randomUUID()}`,
      source: input.source,
      doc_id: input.doc_id,
      operation: input.operation,
      target: input.target,
      payload: input.payload,
      status: 'pending',
      created_at: input.now,
      updated_at: input.now,
    };
    return { ...eventWithoutDedupe, dedupe_key: eventDedupeKey(eventWithoutDedupe) };
  }
}
