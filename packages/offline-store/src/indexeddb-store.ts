import type {
  AddRuntimeAnnotationInput,
  RuntimeAnnotation,
  RuntimeDocumentSnapshot,
  RuntimeMutationResult,
  RuntimeSurfaceBlock,
  RuntimeSyncEvent,
  UpdateRuntimeAnnotationInput,
  UpdateRuntimeBlockContentInput,
} from '../../runtime-schema/src/index.js';
import type { OfflineDocumentCacheRecord, OfflineRuntimeStorePort } from './index.js';

type IndexedDbStoreName = 'documents' | 'cache_records' | 'outbox';
type StoredRuntimeSyncEvent = RuntimeSyncEvent & { indexeddb_sequence?: number };

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
}

export class IndexedDbOfflineRuntimeStore implements OfflineRuntimeStorePort {
  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly now: () => string;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(private readonly config: IndexedDbOfflineRuntimeStoreConfig = {}) {
    this.dbName = config.dbName ?? 'inksurface-offline-runtime';
    this.dbVersion = config.dbVersion ?? 1;
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
