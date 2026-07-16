import type {
  AddRuntimeAnnotationInput,
  RuntimeConflictRecord,
  RuntimeAnnotation,
  RuntimeDocumentSnapshot,
  RuntimeReadingProgress,
  RuntimeMutationResult,
  RuntimeSurfaceBlock,
  RuntimeSyncEvent,
  UpdateRuntimeAnnotationInput,
  UpdateRuntimeBlockContentInput,
} from '../../runtime-schema/src/index.js';
import { assertRuntimeSyncEvent } from '../../runtime-schema/src/index.js';
import type { OfflineDeviceCursor, OfflineDocumentCacheRecord, OfflineRemoteEventApplyResult, OfflineRuntimeStorePort } from './index.js';

type IndexedDbStoreName = 'documents' | 'cache_records' | 'outbox' | 'applied_events' | 'cursors' | 'conflicts';
type StoredRuntimeSyncEvent = RuntimeSyncEvent & { indexeddb_sequence?: number };
type StoredAppliedEvent = { event_id: string; doc_id: string; applied_at: string };

export interface IndexedDbOfflineRuntimeStoreConfig {
  dbName?: string;
  dbVersion?: number;
  factory?: IDBFactory;
  now?: () => string;
}

function nowIso(): string {
  return new Date().toISOString();
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

function randomToken(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function koId(): string {
  return `ko_${randomToken()}`;
}

function eventDedupeKey(event: Omit<RuntimeSyncEvent, 'dedupe_key'>): string {
  return `${event.operation}:${event.doc_id}:${event.target.id ?? event.target.block_id ?? 'document'}:${event.updated_at}`;
}

function stripIndexedDbSequence(event: StoredRuntimeSyncEvent): RuntimeSyncEvent {
  const { indexeddb_sequence: _indexedDbSequence, ...runtimeEvent } = event;
  return runtimeEvent;
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

function remoteDeleteBlockIndex(blocks: RuntimeSurfaceBlock[], event: RuntimeSyncEvent): number {
  const targetBlockId = String(event.payload.block_id || event.target.block_id || '');
  const targetIndex = targetBlockId ? blocks.findIndex((block) => blockId(block) === targetBlockId) : -1;
  return targetIndex >= 0 ? targetIndex : (blocks.length ? 0 : -1);
}

function remoteDeletedAt(event: RuntimeSyncEvent): string {
  const payloadDeletedAt = typeof event.payload.deleted_at === 'string' ? event.payload.deleted_at.trim() : '';
  return payloadDeletedAt || event.updated_at;
}

function remoteDeletedAnnotationStub(event: RuntimeSyncEvent, koIdValue: string, markId: string): RuntimeAnnotation {
  return {
    ko_id: koIdValue,
    status: 'deleted',
    deleted_at: remoteDeletedAt(event),
    ...(markId ? { inkloop_mark: { mark_id: markId } } : {}),
  };
}

async function sha256Tagged(input: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) return `sha256:fallback-${input.length.toString(16)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function ensureSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'doc_id' });
  if (!db.objectStoreNames.contains('cache_records')) db.createObjectStore('cache_records', { keyPath: 'doc_id' });
  if (!db.objectStoreNames.contains('outbox')) {
    const outbox = db.createObjectStore('outbox', { keyPath: 'event_id' });
    outbox.createIndex('doc_id', 'doc_id', { unique: false });
    outbox.createIndex('status', 'status', { unique: false });
  }
  if (!db.objectStoreNames.contains('applied_events')) {
    const applied = db.createObjectStore('applied_events', { keyPath: 'event_id' });
    applied.createIndex('doc_id', 'doc_id', { unique: false });
  }
  if (!db.objectStoreNames.contains('cursors')) db.createObjectStore('cursors', { keyPath: 'device_id' });
  if (!db.objectStoreNames.contains('conflicts')) {
    const conflicts = db.createObjectStore('conflicts', { keyPath: 'conflict_id' });
    conflicts.createIndex('doc_id', 'doc_id', { unique: false });
  }
}

export class IndexedDbOfflineRuntimeStore implements OfflineRuntimeStorePort {
  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly now: () => string;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(private readonly config: IndexedDbOfflineRuntimeStoreConfig = {}) {
    this.dbName = config.dbName ?? 'inksurface-offline-runtime';
    this.dbVersion = config.dbVersion ?? 2;
    this.now = config.now ?? nowIso;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = undefined;
  }

  async writeDocumentSnapshot(snapshot: RuntimeDocumentSnapshot): Promise<void> {
    await this.put('documents', snapshot);
  }

  async loadDocument(docId: string): Promise<RuntimeDocumentSnapshot | null> {
    return (await this.get<RuntimeDocumentSnapshot>('documents', docId)) ?? null;
  }

  async listOutboxEvents(): Promise<RuntimeSyncEvent[]> {
    return (await this.getAll<StoredRuntimeSyncEvent>('outbox'))
      .sort((a, b) => (a.indexeddb_sequence ?? 0) - (b.indexeddb_sequence ?? 0))
      .map(stripIndexedDbSequence);
  }

  async writeOutboxEvents(events: RuntimeSyncEvent[]): Promise<void> {
    await this.replaceAll('outbox', events.map((event, index) => ({ ...event, indexeddb_sequence: index + 1 })));
  }

  async updateOutboxEvents(updates: RuntimeSyncEvent[]): Promise<void> {
    if (!updates.length) return;
    const db = await this.open();
    const transaction = db.transaction('outbox', 'readwrite');
    const store = transaction.objectStore('outbox');
    const done = transactionDone(transaction);
    // put 必须在 get 的 onsuccess 回调里同步排队：Safari/部分老 WebView 会在 promise
    // continuation 前把事务置 inactive，事务里 await 后再 put 会抛 TransactionInactiveError。
    for (const update of updates) {
      const request = store.get(update.event_id) as IDBRequest<StoredRuntimeSyncEvent | undefined>;
      request.onsuccess = () => {
        const existing = request.result;
        store.put({
          ...update,
          ...(existing?.indexeddb_sequence !== undefined
            ? { indexeddb_sequence: existing.indexeddb_sequence }
            : {}),
        });
      };
    }
    await done;
  }

  async appendSyncEvent(event: RuntimeSyncEvent): Promise<void> {
    const events = await this.getAll<StoredRuntimeSyncEvent>('outbox');
    const nextSequence = Math.max(0, ...events.map((item) => item.indexeddb_sequence ?? 0)) + 1;
    await this.put('outbox', { ...event, indexeddb_sequence: nextSequence });
  }

  async getCacheRecord(docId: string): Promise<OfflineDocumentCacheRecord | null> {
    return (await this.get<OfflineDocumentCacheRecord>('cache_records', docId)) ?? null;
  }

  async writeCacheRecord(record: OfflineDocumentCacheRecord): Promise<void> {
    await this.put('cache_records', record);
  }

  async listPendingEvents(docId?: string): Promise<RuntimeSyncEvent[]> {
    return (await this.listOutboxEvents()).filter((event) => event.status !== 'sent' && (!docId || event.doc_id === docId));
  }

  async listAppliedEventIds(docId?: string): Promise<string[]> {
    return (await this.getAll<StoredAppliedEvent>('applied_events'))
      .filter((event) => !docId || event.doc_id === docId)
      .map((event) => event.event_id);
  }

  async getDeviceCursor(deviceId: string): Promise<OfflineDeviceCursor | null> {
    return (await this.get<OfflineDeviceCursor>('cursors', deviceId)) ?? null;
  }

  async writeDeviceCursor(cursor: OfflineDeviceCursor): Promise<void> {
    await this.put('cursors', cursor);
  }

  async listConflicts(docId?: string): Promise<RuntimeConflictRecord[]> {
    return (await this.getAll<RuntimeConflictRecord>('conflicts')).filter((conflict) => !docId || conflict.doc_id === docId);
  }

  async recordConflict(conflict: RuntimeConflictRecord): Promise<void> {
    await this.put('conflicts', conflict);
  }

  async applyRemoteEvent(event: RuntimeSyncEvent): Promise<OfflineRemoteEventApplyResult> {
    assertRuntimeSyncEvent(event);
    const applied = await this.get<StoredAppliedEvent>('applied_events', event.event_id);
    if (applied) return { event_id: event.event_id, status: 'skipped' };
    try {
      await this.applyRemoteEventUnchecked(event);
      await this.put('applied_events', { event_id: event.event_id, doc_id: event.doc_id, applied_at: this.now() });
      return { event_id: event.event_id, status: 'applied' };
    } catch (error) {
      const conflict = this.conflictFromError(event, error);
      await this.recordConflict(conflict);
      return { event_id: event.event_id, status: 'conflicted', conflict };
    }
  }

  async updateBlockContent(input: UpdateRuntimeBlockContentInput): Promise<RuntimeMutationResult> {
    if (input.commit_target?.type === 'markdown_source_patch') {
      throw new Error('IndexedDB runtime store cannot patch source files; use the file-sidecar store for markdown_source_patch.');
    }

    const runtime = await this.requireDocument(input.doc_id);
    const index = runtime.blocks.findIndex((block) => blockId(block) === input.block_id);
    if (index === -1) throw new Error(`InkLoop block was not found: ${input.block_id}`);

    const now = this.now();
    const block = runtime.blocks[index];
    const quote = normalizeMarkdownText(input.content);
    const nextLines = String(input.content ?? '').trimEnd().split('\n');
    const range = block.source_anchor?.range;
    const nextRange = range
      ? {
          ...range,
          end_line: range.start_line + nextLines.length - 1,
          end_col: nextLines[nextLines.length - 1]?.length ?? 0,
        }
      : undefined;
    const nextBlocks = [...runtime.blocks];
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

    const nextSnapshot = {
      ...runtime,
      document: { ...runtime.document, updated_at: now },
      blocks: nextBlocks,
    };

    const event = this.makeEvent({
      source: input.source,
      doc_id: input.doc_id,
      operation: 'block.update',
      target: { type: 'block', id: input.block_id, block_id: input.block_id },
      payload: {
        block_id: input.block_id,
        quote,
        content_md: input.content,
        commit_target: input.commit_target ?? { type: 'sidecar_only' },
        range: nextRange,
      },
      now,
    });
    await this.writeDocumentSnapshotAndAppendEvent(nextSnapshot, event);

    return { doc_id: input.doc_id, block_id: input.block_id, sync_event: event, updated_at: now };
  }

  async updateAnnotation(input: UpdateRuntimeAnnotationInput): Promise<RuntimeMutationResult> {
    const runtime = await this.requireDocument(input.doc_id);
    const now = this.now();
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
    const nextSnapshot = { ...runtime, document: { ...runtime.document, updated_at: now }, blocks };

    const event = this.makeEvent({
      source: input.source,
      doc_id: input.doc_id,
      operation: 'annotation.update',
      target: { type: 'annotation', id: input.ko_id, block_id: targetBlockId },
      payload: { ko_id: input.ko_id, block_id: targetBlockId, patch },
      now,
    });
    await this.writeDocumentSnapshotAndAppendEvent(nextSnapshot, event);

    return { doc_id: input.doc_id, ko_id: input.ko_id, sync_event: event, updated_at: now };
  }

  async addAnnotation(input: AddRuntimeAnnotationInput): Promise<RuntimeMutationResult> {
    const runtime = await this.requireDocument(input.doc_id);
    const index = runtime.blocks.findIndex((block) => blockId(block) === input.block_id);
    if (index === -1) throw new Error(`InkLoop block was not found: ${input.block_id}`);

    const now = this.now();
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

    const nextSnapshot = { ...runtime, document: { ...runtime.document, updated_at: now }, blocks };

    const event = this.makeEvent({
      source: input.source,
      doc_id: input.doc_id,
      operation: 'annotation.add',
      target: { type: 'annotation', id: annotation.ko_id, block_id: input.block_id },
      payload: { block_id: input.block_id, annotation },
      now,
    });
    await this.writeDocumentSnapshotAndAppendEvent(nextSnapshot, event);

    return {
      doc_id: input.doc_id,
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
      await this.writeDocumentSnapshot({ ...runtime, document: { ...runtime.document, updated_at: this.now() }, blocks });
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
      await this.writeDocumentSnapshot({ ...runtime, document: { ...runtime.document, updated_at: this.now() }, blocks });
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
        const annotations = (block.annotations || []).map((annotation) => {
          const matchesKo = annotation.ko_id === ko;
          const matchesMark = !!markId && runtimeAnnotationMarkId(annotation) === markId;
          if (!matchesKo && !matchesMark) return annotation;
          didUpdate = true;
          if (event.operation === 'annotation.delete') return { ...annotation, status: 'deleted', deleted_at: remoteDeletedAt(event) };
          return { ...annotation, ...patch, updated_at: event.updated_at };
        });
        return { ...block, annotations };
      });
      if (!didUpdate && event.operation === 'annotation.delete') {
        const targetIndex = remoteDeleteBlockIndex(blocks, event);
        // A blockless snapshot has nowhere to retain a tombstone; delete remains idempotent.
        if (targetIndex === -1) return;
        const targetBlock = blocks[targetIndex];
        blocks[targetIndex] = {
          ...targetBlock,
          annotations: [...(targetBlock.annotations || []), remoteDeletedAnnotationStub(event, ko, markId)],
        };
        await this.writeDocumentSnapshot({ ...runtime, document: { ...runtime.document, updated_at: this.now() }, blocks });
        return;
      }
      if (!didUpdate) throw new Error(`Remote annotation was not found: ${ko}`);
      await this.writeDocumentSnapshot({ ...runtime, document: { ...runtime.document, updated_at: this.now() }, blocks });
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
      await this.writeDocumentSnapshot({ ...runtime, document: { ...runtime.document, updated_at: this.now() }, blocks });
      void didUpdate;
      return;
    }

    if (event.operation === 'progress.update') {
      const progress = event.payload.progress as RuntimeReadingProgress | undefined;
      if (!progress) throw new Error('Remote progress.update is missing progress payload.');
      await this.writeDocumentSnapshot({ ...runtime, reading_progress: progress });
      return;
    }

    if (event.operation === 'source.rename') {
      const sourcePath = String(event.payload.source_path || '');
      if (!sourcePath) throw new Error('Remote source.rename is missing source_path.');
      await this.writeDocumentSnapshot({
        ...runtime,
        source: {
          ...runtime.source,
          vault_file: runtime.source.vault_file ? { ...runtime.source.vault_file, path: sourcePath } : { path: sourcePath },
          identity: { ...(runtime.source.identity || {}), source_path: sourcePath },
        },
        source_revision: { ...(runtime.source_revision || {}), source_path: sourcePath, updated_at: event.updated_at },
      });
      return;
    }

    if (event.operation === 'canvas.node.add' || event.operation === 'canvas.node.delete') {
      const nodeId = String(event.payload.node_id || event.target.id || '');
      const nodes = runtime.nodes.filter((node) => String(node.id || node.node_id || '') !== nodeId);
      await this.writeDocumentSnapshot({ ...runtime, nodes: event.operation === 'canvas.node.add' ? [...nodes, event.payload.node as Record<string, unknown>] : nodes });
      return;
    }
  }

  private conflictFromError(event: RuntimeSyncEvent, error: unknown): RuntimeConflictRecord {
    return {
      conflict_id: `conflict_${event.event_id}_${Math.abs(String((error as Error)?.message || error).length)}`,
      event_id: event.event_id,
      doc_id: event.doc_id,
      reason: String((error as Error)?.message || error),
      created_at: this.now(),
      remote_revision: event.source_revision,
    };
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
      event_id: `evt_${randomToken()}`,
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

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const factory = this.config.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB is not available in this runtime.');

    this.dbPromise = new Promise((resolve, reject) => {
      const request = factory.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = () => ensureSchema(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB open request is blocked by another connection.'));
    });
    return this.dbPromise;
  }

  private async get<T>(storeName: IndexedDbStoreName, key: IDBValidKey): Promise<T | undefined> {
    const db = await this.open();
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>;
    const result = await requestToPromise(request);
    await transactionDone(transaction);
    return result;
  }

  private async getAll<T>(storeName: IndexedDbStoreName): Promise<T[]> {
    const db = await this.open();
    const transaction = db.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).getAll() as IDBRequest<T[]>;
    const result = await requestToPromise(request);
    await transactionDone(transaction);
    return result;
  }

  private async put(storeName: IndexedDbStoreName, value: unknown): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }

  private async replaceAll(storeName: IndexedDbStoreName, values: unknown[]): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    store.clear();
    for (const value of values) store.put(value);
    await transactionDone(transaction);
  }

  private async writeDocumentSnapshotAndAppendEvent(snapshot: RuntimeDocumentSnapshot, event: RuntimeSyncEvent): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(['documents', 'outbox'], 'readwrite');
    const outboxStore = transaction.objectStore('outbox');
    const events = await requestToPromise(outboxStore.getAll() as IDBRequest<StoredRuntimeSyncEvent[]>);
    const nextSequence = Math.max(0, ...events.map((item) => item.indexeddb_sequence ?? 0)) + 1;
    transaction.objectStore('documents').put(snapshot);
    outboxStore.put({ ...event, indexeddb_sequence: nextSequence });
    await transactionDone(transaction);
  }
}
