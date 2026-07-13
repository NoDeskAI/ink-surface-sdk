import { appendFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AddRuntimeAnnotationInput,
  RuntimeConflictRecord,
  RuntimeAnnotation,
  RuntimeCommitTarget,
  RuntimeDocumentRecord,
  RuntimeDocumentSnapshot,
  RuntimeReadingProgress,
  RuntimeMutationResult,
  RuntimeSourceRef,
  RuntimeSurfaceBlock,
  RuntimeSyncEvent,
  UpdateRuntimeAnnotationInput,
  UpdateRuntimeBlockContentInput,
} from '../../runtime-schema/src/index.js';
import { assertRuntimeSyncEvent } from '../../runtime-schema/src/index.js';
import type { OfflineDeviceCursor, OfflineDocumentCacheRecord, OfflineRemoteEventApplyResult, OfflineRuntimeStorePort } from './index.js';

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

function mergeBootstrapSnapshot(existing: RuntimeDocumentSnapshot | null, incoming: RuntimeDocumentSnapshot): RuntimeDocumentSnapshot {
  if (!existing) return incoming;
  const existingBlocks = new Map(existing.blocks.map((block) => [blockId(block), block] as const));
  const blocks = incoming.blocks.map((block) => {
    const previous = existingBlocks.get(blockId(block));
    const previousAnnotations = previous?.annotations ?? [];
    if (!previousAnnotations.length) return block;
    const incomingAnnotations = block.annotations ?? [];
    if (!incomingAnnotations.length) return block;
    const incomingIds = new Set(incomingAnnotations.map((annotation) => annotation.ko_id));
    const carriedAnnotations = previousAnnotations.filter((annotation) => annotation.ko_id && !incomingIds.has(annotation.ko_id));
    if (!carriedAnnotations.length) return block;
    const carriedIds = carriedAnnotations.map((annotation) => annotation.ko_id);
    return {
      ...block,
      annotations: [...incomingAnnotations, ...carriedAnnotations],
      projection: {
        ...(block.projection || {}),
        knowledge_object_ids: [...new Set([...(block.projection?.knowledge_object_ids || []), ...carriedIds])],
      },
    };
  });
  return { ...incoming, blocks };
}

function cleanPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normBbox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const values = value.map((part) => Number(part));
  return values.every(Number.isFinite) ? values as [number, number, number, number] : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enrichedRemoteAnnotation(event: RuntimeSyncEvent, annotation: RuntimeAnnotation): RuntimeAnnotation {
  const existingMeta = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {};
  const bbox = normBbox(event.payload.bbox) ?? normBbox(existingMeta.bbox) ?? normBbox(annotation.visual_bbox);
  const metaEntries = Object.entries({
    mark_id: event.payload.mark_id,
    mark_seq: event.payload.mark_seq,
    marked_text: event.payload.marked_text,
    kind: event.payload.kind,
    feature_type: event.payload.feature_type,
    tool: event.payload.tool,
    origin: event.payload.origin,
    scored_type: event.payload.scored_type,
    hmp_action: event.payload.hmp_action,
    page_id: event.payload.page_id,
    page_index: event.payload.page_index,
    bbox,
    created_at: event.created_at,
    updated_at: event.updated_at,
    source_device_id: event.origin?.device_id,
  }).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return {
    ...annotation,
    ...(bbox ? { visual_bbox: bbox } : {}),
    inkloop_mark: {
      ...existingMeta,
      ...Object.fromEntries(metaEntries),
    },
  };
}

function runtimeAnnotationMarkId(annotation: RuntimeAnnotation): string {
  const meta = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {};
  return typeof meta.mark_id === 'string' ? meta.mark_id : '';
}

function fallbackAnnotationBlockIndex(blocks: RuntimeSurfaceBlock[], event: RuntimeSyncEvent): number {
  const pageIndex = numberValue(event.payload.page_index)
    ?? numberValue(isRecord(event.payload.annotation) && isRecord(event.payload.annotation.inkloop_mark) ? event.payload.annotation.inkloop_mark.page_index : undefined);
  if (typeof pageIndex === 'number') {
    const pageMatch = blocks.findIndex((block) => block.projection?.page_index === pageIndex);
    if (pageMatch >= 0) return pageMatch;
  }
  return blocks.length ? 0 : -1;
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

  appliedEventsPath(docId: string): string {
    return path.join(this.docDir(docId), 'applied-events.jsonl');
  }

  progressPath(docId: string): string {
    return path.join(this.docDir(docId), 'progress.json');
  }

  sourceRevisionPath(docId: string): string {
    return path.join(this.docDir(docId), 'source-revision.json');
  }

  identityPath(docId: string): string {
    return path.join(this.docDir(docId), 'identity.json');
  }

  cursorsPath(deviceId: string): string {
    return this.sidecarPath('cursors', `${deviceId}.json`);
  }

  conflictsPath(): string {
    return this.sidecarPath('conflicts', 'runtime-conflicts.jsonl');
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
      identity: await readJsonFile(path.join(docDir, 'identity.json'), undefined),
      source,
      source_revision: await readJsonFile(path.join(docDir, 'source-revision.json'), undefined),
      reading_progress: await readJsonFile(path.join(docDir, 'progress.json'), undefined),
      conflicts: (await this.listConflicts(docId)),
      blocks: await readJsonLines<RuntimeSurfaceBlock>(blocksPath),
      nodes: await readJsonLines<Record<string, unknown>>(path.join(docDir, 'canvas', 'nodes.jsonl')),
    };
  }

  async writeDocumentSnapshot(snapshot: RuntimeDocumentSnapshot): Promise<void> {
    const docDir = this.docDir(snapshot.doc_id);
    await writeJsonFile(path.join(docDir, 'document.json'), snapshot.document);
    await writeJsonFile(path.join(docDir, 'source.json'), snapshot.source);
    if (snapshot.identity) await writeJsonFile(this.identityPath(snapshot.doc_id), snapshot.identity);
    if (snapshot.source_revision) await writeJsonFile(this.sourceRevisionPath(snapshot.doc_id), snapshot.source_revision);
    if (snapshot.reading_progress) await writeJsonFile(this.progressPath(snapshot.doc_id), snapshot.reading_progress);
    await this.writeRuntimeBlocks({ ...snapshot, doc_dir: docDir }, snapshot.blocks);
    await writeJsonLines(path.join(docDir, 'canvas', 'nodes.jsonl'), snapshot.nodes ?? []);
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

  async listAppliedEventIds(docId?: string): Promise<string[]> {
    if (docId) return (await readJsonLines<{ event_id: string }>(this.appliedEventsPath(docId))).map((item) => item.event_id);
    const events = await readJsonLines<{ event_id: string; doc_id?: string }>(this.sidecarPath('applied-events.jsonl'));
    return events.map((item) => item.event_id);
  }

  async getDeviceCursor(deviceId: string): Promise<OfflineDeviceCursor | null> {
    return readJsonFile<OfflineDeviceCursor | null>(this.cursorsPath(deviceId), null);
  }

  async writeDeviceCursor(cursor: OfflineDeviceCursor): Promise<void> {
    await writeJsonFile(this.cursorsPath(cursor.device_id), cursor);
  }

  async listConflicts(docId?: string): Promise<RuntimeConflictRecord[]> {
    return (await readJsonLines<RuntimeConflictRecord>(this.conflictsPath())).filter((conflict) => !docId || conflict.doc_id === docId);
  }

  async recordConflict(conflict: RuntimeConflictRecord): Promise<void> {
    await ensureDir(path.dirname(this.conflictsPath()));
    await appendFile(this.conflictsPath(), `${JSON.stringify(conflict)}\n`, 'utf8');
  }

  async applyRemoteEvent(event: RuntimeSyncEvent): Promise<OfflineRemoteEventApplyResult> {
    assertRuntimeSyncEvent(event);
    const applied = new Set(await readJsonLines<{ event_id: string }>(this.appliedEventsPath(event.doc_id)).then((items) => items.map((item) => item.event_id)));
    if (applied.has(event.event_id)) return { event_id: event.event_id, status: 'skipped' };
    try {
      await this.applyRemoteEventUnchecked(event);
      const appliedRecord = { event_id: event.event_id, doc_id: event.doc_id, applied_at: nowIso() };
      await ensureDir(path.dirname(this.appliedEventsPath(event.doc_id)));
      await appendFile(this.appliedEventsPath(event.doc_id), `${JSON.stringify(appliedRecord)}\n`, 'utf8');
      await ensureDir(path.dirname(this.sidecarPath('applied-events.jsonl')));
      await appendFile(this.sidecarPath('applied-events.jsonl'), `${JSON.stringify(appliedRecord)}\n`, 'utf8');
      return { event_id: event.event_id, status: 'applied' };
    } catch (error) {
      const conflict = this.conflictFromError(event, error);
      await this.recordConflict(conflict);
      return { event_id: event.event_id, status: 'conflicted', conflict };
    }
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

  private async applyRemoteEventUnchecked(event: RuntimeSyncEvent): Promise<void> {
    if (event.operation === 'runtime.bootstrap') {
      const snapshot = event.payload.snapshot as RuntimeDocumentSnapshot | undefined;
      if (!snapshot || snapshot.doc_id !== event.doc_id) throw new Error('Remote bootstrap snapshot is missing or mismatched.');
      await this.writeDocumentSnapshot(mergeBootstrapSnapshot(await this.loadDocument(event.doc_id), snapshot));
      return;
    }

    const runtime = await this.requireDocument(event.doc_id);
    if (event.operation === 'block.update') {
      const blockIdValue = String(event.payload.block_id || event.target.block_id || event.target.id || '');
      const index = runtime.blocks.findIndex((block) => blockId(block) === blockIdValue);
      if (index === -1) throw new Error(`Remote block was not found: ${blockIdValue}`);
      const quote = normalizeMarkdownText(String(event.payload.content_md ?? event.payload.quote ?? ''));
      const blocks = [...runtime.blocks];
      const block = blocks[index];
      blocks[index] = {
        ...block,
        text: quote,
        source_anchor: { ...(block.source_anchor || {}), quote, ...(isRecord(event.payload.range) ? { range: event.payload.range as never } : {}) },
      };
      await this.writeRuntimeBlocks(runtime, blocks);
      await this.touchDocument(runtime, nowIso());
      return;
    }

    if (event.operation === 'annotation.add') {
      const blockIdValue = String(event.payload.block_id || event.target.block_id || '');
      const annotationPayload = event.payload.annotation as RuntimeAnnotation | undefined;
      const annotation = annotationPayload?.ko_id ? enrichedRemoteAnnotation(event, annotationPayload) : undefined;
      if (!annotation?.ko_id) throw new Error('Remote annotation.add is missing annotation payload.');
      const index = blockIdValue
        ? runtime.blocks.findIndex((block) => blockId(block) === blockIdValue)
        : fallbackAnnotationBlockIndex(runtime.blocks, event);
      if (index === -1) throw new Error(`Remote annotation block was not found: ${blockIdValue}`);
      const blocks = [...runtime.blocks];
      const block = blocks[index];
      const incomingMarkId = runtimeAnnotationMarkId(annotation);
      const annotations = (block.annotations || []).filter((item) => {
        const existingMarkId = runtimeAnnotationMarkId(item);
        if (incomingMarkId && existingMarkId) return existingMarkId !== incomingMarkId;
        return item.ko_id !== annotation.ko_id;
      });
      blocks[index] = {
        ...block,
        annotations: [...annotations, annotation],
        projection: {
          ...(block.projection || {}),
          knowledge_object_ids: [...new Set([...(block.projection?.knowledge_object_ids || []), annotation.ko_id])],
        },
      };
      await this.writeRuntimeBlocks(runtime, blocks);
      await this.touchDocument(runtime, nowIso());
      return;
    }

    if (event.operation === 'annotation.update' || event.operation === 'annotation.delete') {
      const ko = String(event.payload.ko_id || event.target.id || '');
      if (!ko) throw new Error('Remote annotation event is missing ko_id.');
      // ko_id 不等于 mark_id，tombstone 构造时常拿不到原 KO —— 允许按 mark_id 兜底定位。
      const markId = String(event.payload.mark_id || '');
      const rawPatch = isRecord(event.payload.patch) ? event.payload.patch : {};
      const enrichedPatch = event.operation === 'annotation.update' && typeof rawPatch.ko_id === 'string'
        ? enrichedRemoteAnnotation(event, rawPatch as RuntimeAnnotation)
        : rawPatch;
      const { ko_id: _patchKoId, ...patch } = enrichedPatch as Record<string, unknown>;
      let didUpdate = false;
      const blocks = runtime.blocks.map((block) => {
        const annotations = (block.annotations || []).flatMap((annotation) => {
          const matchesKo = annotation.ko_id === ko;
          const matchesMark = !!markId && runtimeAnnotationMarkId(annotation) === markId;
          if (!matchesKo && !matchesMark) return [annotation];
          didUpdate = true;
          if (event.operation === 'annotation.delete') return [{ ...annotation, status: 'deleted', deleted_at: event.updated_at }];
          return [{ ...annotation, ...patch, updated_at: event.updated_at }];
        });
        return { ...block, annotations };
      });
      // delete 幂等：目标不存在（如快速 add→delete 被 fold 成 delete-only）不算冲突，跳过即可。
      if (!didUpdate && event.operation === 'annotation.delete') return;
      if (!didUpdate) throw new Error(`Remote annotation was not found: ${ko}`);
      await this.writeRuntimeBlocks(runtime, blocks);
      await this.touchDocument(runtime, nowIso());
      return;
    }

    if (event.operation === 'knowledge.update') {
      const ko = String(event.payload.ko_id || event.target.id || '');
      if (!ko) throw new Error('Remote knowledge.update event is missing ko_id.');
      const patch = isRecord(event.payload.patch) ? event.payload.patch : {};
      let didUpdate = false;
      const blocks = runtime.blocks.map((block) => {
        const annotations = (block.annotations || []).map((annotation) => {
          if (annotation.ko_id !== ko) return annotation;
          didUpdate = true;
          return {
            ...annotation,
            ...(typeof patch.status === 'string' ? { status: patch.status } : {}),
            ...(Array.isArray(patch.tags) ? { tags: patch.tags } : {}),
            controlled_fields: { ...(annotation.controlled_fields as Record<string, unknown> | undefined || {}), ...patch },
            updated_at: event.updated_at,
          };
        });
        return { ...block, annotations };
      });
      if (didUpdate) await this.writeRuntimeBlocks(runtime, blocks);
      await this.touchDocument(runtime, nowIso());
      return;
    }

    if (event.operation === 'progress.update') {
      const progress = event.payload.progress as RuntimeReadingProgress | undefined;
      if (!progress) throw new Error('Remote progress.update is missing progress payload.');
      await writeJsonFile(this.progressPath(event.doc_id), progress);
      return;
    }

    if (event.operation === 'source.rename') {
      const sourcePath = String(event.payload.source_path || '');
      if (!sourcePath) throw new Error('Remote source.rename is missing source_path.');
      const source = {
        ...runtime.source,
        vault_file: runtime.source.vault_file ? { ...runtime.source.vault_file, path: sourcePath } : { path: sourcePath },
        identity: { ...(runtime.source.identity || {}), source_path: sourcePath },
      };
      await writeJsonFile(path.join(runtime.doc_dir, 'source.json'), source);
      await writeJsonFile(this.sourceRevisionPath(event.doc_id), { ...(runtime.source_revision || {}), source_path: sourcePath, updated_at: event.updated_at });
      return;
    }

    if (event.operation === 'canvas.node.add' || event.operation === 'canvas.node.delete') {
      const nodeId = String(event.payload.node_id || event.target.id || '');
      const nodes = runtime.nodes.filter((node) => String(node.id || node.node_id || '') !== nodeId);
      const nextNodes = event.operation === 'canvas.node.add' ? [...nodes, event.payload.node as Record<string, unknown>] : nodes;
      await writeJsonLines(path.join(runtime.doc_dir, 'canvas', 'nodes.jsonl'), nextNodes.filter(Boolean));
      return;
    }
  }

  private conflictFromError(event: RuntimeSyncEvent, error: unknown): RuntimeConflictRecord {
    return {
      conflict_id: `conflict_${createHash('sha256').update(`${event.event_id}:${String((error as Error)?.message || error)}`).digest('hex').slice(0, 16)}`,
      event_id: event.event_id,
      doc_id: event.doc_id,
      reason: String((error as Error)?.message || error),
      created_at: nowIso(),
      remote_revision: event.source_revision,
    };
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
