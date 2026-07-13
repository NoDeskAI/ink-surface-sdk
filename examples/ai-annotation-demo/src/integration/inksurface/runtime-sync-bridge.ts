import {
  RUNTIME_SYNC_EVENT_SCHEMA_VERSION,
  type RuntimeAnnotation,
  type RuntimeDocumentSnapshot,
  type RuntimeSurfaceBlock,
  type RuntimeSyncEvent,
} from 'ink-surface-sdk/runtime-schema';
import { OFFLINE_STORE_SCHEMA_VERSION, type OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import type { DocumentProjectionBlock as ProjectionBlock } from 'ink-surface-sdk/knowledge-schema';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import type { PersistedMark } from '../../core/store-format';
import { getLatestMarkRevisions } from '../../local/store';
import { buildRuntimeAndVisual } from './runtime-surface';
import { resolveRuntimeDocumentIdentity, type RuntimeIdentityInput } from './runtime-identity';

export interface RuntimeBridgeWatermark {
  doc_id: string;
  last_mark_seq: number;
  updated_at: string;
}

export interface RuntimeBridgeWatermarkStore {
  read(docId: string): Promise<RuntimeBridgeWatermark | null>;
  write(watermark: RuntimeBridgeWatermark): Promise<void>;
}

export interface RuntimeSnapshotBuildInput extends RuntimeIdentityInput {
  documentId: string;
  documentTitle: string;
  projectionBlocks: ProjectionBlock[];
  knowledgeObjects: KnowledgeObject[];
}

export interface RuntimeSyncBridgeInput {
  documentId: string;
  documentTitle: string;
  projectionBlocks?: ProjectionBlock[];
  knowledgeObjects?: KnowledgeObject[];
  runtimeStore: OfflineRuntimeStorePort;
  watermarkStore?: RuntimeBridgeWatermarkStore;
  originDeviceId?: string;
  /** 已存在于 canonical runtime 的 mark_id 集合：用于判定该 mark 的新 revision 应发 update 而非 add。 */
  knownMarkIds?: ReadonlySet<string>;
  loadMarks?: (documentId: string) => Promise<PersistedMark[]>;
  buildSnapshot?: () => Promise<RuntimeDocumentSnapshot>;
  now?: () => string;
  sourceKind?: RuntimeIdentityInput['sourceKind'];
  sourcePath?: string;
  fileHash?: string;
  contentHash?: string;
}

export interface RuntimeSyncBridgeResult {
  doc_id: string;
  scanned: number;
  bridged: number;
  skipped: number;
  last_mark_seq: number;
  event_ids: string[];
}

export function createMemoryRuntimeBridgeWatermarks(): RuntimeBridgeWatermarkStore {
  const map = new Map<string, RuntimeBridgeWatermark>();
  return {
    async read(docId) {
      return map.get(docId) ?? null;
    },
    async write(watermark) {
      map.set(watermark.doc_id, { ...watermark });
    },
  };
}

function cleanNamespaceSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function runtimeBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((part) => Number(part));
  return nums.every(Number.isFinite) ? nums as [number, number, number, number] : null;
}

export function isRuntimeSilentMark(mark: PersistedMark): boolean {
  if (isRuntimeReceivedMark(mark)) return true;
  const kind = `${mark.kind ?? ''} ${mark.scored_type ?? ''}`.toLowerCase();
  const noVisibleInk = !(mark.strokes ?? []).some((stroke) => stroke.points?.length);
  return kind.includes('review_later') || (mark.ai_eligible === false && noVisibleInk && (mark.marked_text ?? '').trim() === '稍后处理');
}

function isRuntimeReceivedMark(mark: PersistedMark): boolean {
  const kindSource = mark.kind_source || '';
  return mark.pointer_type === 'remote'
    || mark.device_id === 'runtime-sync'
    || kindSource === 'runtime-sync'
    || kindSource.startsWith('runtime-sync-');
}

function isClearlyInvalidPageNormBbox(bbox: readonly number[] | undefined): boolean {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [x, y, w, h] = bbox.map((value) => Number(value));
  if (![x, y, w, h].every(Number.isFinite)) return true;
  if (w <= 0 || h <= 0) return true;
  if (x < -0.05 || y < -0.05) return true;
  if (w > 1.1 || h > 1.1) return true;
  if (x + w > 1.05 || y + h > 1.05) return true;
  return false;
}

export function isRuntimeInvalidPageNormMark(mark: PersistedMark): boolean {
  if (mark.coord_space === 'reader_px' || mark.surface_coord_space === 'reader_px') return false;
  return isClearlyInvalidPageNormBbox(mark.bbox);
}

/** revision 级事件身份：同一 mark 的每个 seq 一个独立事件（旧格式 `evt_bridge_<mark>` 无 seq，继续可读不冲突）。 */
export function runtimeSyncEventIdForMarkId(markId: string, seq: number): string {
  return `evt_bridge_${markId}:${seq}`;
}

export function localStorageRuntimeBridgeWatermarks(
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
  namespace = '',
): RuntimeBridgeWatermarkStore {
  const prefix = namespace
    .split('/')
    .map((part) => cleanNamespaceSegment(part))
    .filter(Boolean)
    .join('.');
  const key = (docId: string): string => `inkloop.runtime-bridge.watermark.${prefix ? `${prefix}.` : ''}${docId}`;
  return {
    async read(docId) {
      const text = storage.getItem(key(docId));
      return text ? JSON.parse(text) as RuntimeBridgeWatermark : null;
    },
    async write(watermark) {
      storage.setItem(key(watermark.doc_id), JSON.stringify(watermark));
    },
  };
}

export async function buildRuntimeSnapshotFromProjection(input: RuntimeSnapshotBuildInput): Promise<RuntimeDocumentSnapshot> {
  const runtime = await buildRuntimeAndVisual(input.documentId, input.documentTitle, input.projectionBlocks, input.knowledgeObjects);
  const { identity, sourceRevision } = resolveRuntimeDocumentIdentity({
    ...input,
    documentId: input.documentId,
    title: input.documentTitle,
    sourceKind: input.sourceKind ?? 'imported_pdf',
  });
  return {
    doc_id: identity.doc_id,
    doc_dir: `indexeddb://${identity.doc_id}`,
    document: {
      doc_id: identity.doc_id,
      title: input.documentTitle,
      source_type: identity.source_kind === 'imported_pdf' ? 'pdf' : 'markdown',
      updated_at: input.updatedAt ?? new Date().toISOString(),
    },
    identity,
    source: {
      doc_id: identity.doc_id,
      kind: identity.source_kind,
      ...(identity.source_path ? { vault_file: { path: identity.source_path } } : {}),
      identity: {
        stable_key: identity.stable_key,
        file_hash: identity.file_hash,
        current_content_hash: sourceRevision.content_hash,
      },
    },
    source_revision: sourceRevision,
    blocks: runtime.surfaceBlocks,
    nodes: [],
  };
}

export async function bridgeRuntimeLedgerToStore(input: RuntimeSyncBridgeInput): Promise<RuntimeSyncBridgeResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const watermarkStore = input.watermarkStore ?? createMemoryRuntimeBridgeWatermarks();
  const watermark = await watermarkStore.read(input.documentId);
  const marks = (await (input.loadMarks ?? getLatestMarkRevisions)(input.documentId)).sort((a, b) => a.seq - b.seq);
  const existingOutbox = await input.runtimeStore.listOutboxEvents();
  const existingByMark = runtimeEventsByMark(existingOutbox);
  const markEvents = (mark: PersistedMark) => existingByMark.get(runtimeMarkEventKey(input.documentId, mark.mark_id)) ?? [];
  const existingDedupe = new Set(existingOutbox.map((event) => event.dedupe_key));
  const lastWatermarkSeq = watermark?.last_mark_seq ?? -1;
  const pendingAllMarks = marks.filter((mark) => !isRuntimeReceivedMark(mark) && mark.seq > lastWatermarkSeq);
  const pendingMarks = marks.filter((mark) => {
    if (isRuntimeSilentMark(mark)) return false;
    if (!mark.is_tombstone && isRuntimeInvalidPageNormMark(mark)) return false; // tombstone 常见 bbox=[0,0,0,0]，删除事件必须放行
    const operation = runtimeOperationForMark(input.documentId, mark, markEvents(mark), input.knownMarkIds);
    return mark.seq > lastWatermarkSeq || !existingDedupe.has(runtimeMarkDedupeKey(input.documentId, mark, operation));
  });
  const snapshot = input.buildSnapshot
    ? await input.buildSnapshot()
    : await buildRuntimeSnapshotFromProjection({
        documentId: input.documentId,
        documentTitle: input.documentTitle,
        projectionBlocks: input.projectionBlocks ?? [],
        knowledgeObjects: input.knowledgeObjects ?? [],
        sourceKind: input.sourceKind ?? 'imported_pdf',
        sourcePath: input.sourcePath,
        fileHash: input.fileHash,
        contentHash: input.contentHash,
        updatedAt: now(),
      });
  const documentSnapshot = snapshotWithoutEmbeddedAnnotations(snapshot);
  const existingSnapshot = typeof input.runtimeStore.loadDocument === 'function'
    ? await input.runtimeStore.loadDocument(documentSnapshot.doc_id)
    : null;
  await input.runtimeStore.writeDocumentSnapshot(snapshotWithPreservedRuntimeAnnotations(documentSnapshot, existingSnapshot));

  const eventIds: string[] = [];
  const bootstrapEvent = runtimeBootstrapEvent(documentSnapshot, now(), input.originDeviceId);
  if (!existingDedupe.has(bootstrapEvent.dedupe_key)) {
    await input.runtimeStore.appendSyncEvent(bootstrapEvent);
    existingDedupe.add(bootstrapEvent.dedupe_key);
    eventIds.push(bootstrapEvent.event_id);
  }
  let bridged = 0;
  for (const mark of pendingMarks) {
    const operation = runtimeOperationForMark(input.documentId, mark, markEvents(mark), input.knownMarkIds);
    const event = runtimeEventForMark(snapshot, mark, operation, now(), input.originDeviceId);
    if (existingDedupe.has(event.dedupe_key)) continue;
    await input.runtimeStore.appendSyncEvent(event);
    // 本地 materialization：本机 runtime canonical cache 同步应用自己的 revision——
    // 否则删除/移动别机 mark 后，自己 pull 因同 device echo 被跳过，hydrate 会把旧版本恢复回来。
    await input.runtimeStore.applyRemoteEvent(event);
    existingOutbox.push(event);
    const markKey = runtimeMarkEventKey(input.documentId, mark.mark_id);
    existingByMark.set(markKey, [...(existingByMark.get(markKey) ?? []), event]);
    existingDedupe.add(event.dedupe_key);
    eventIds.push(event.event_id);
    bridged += 1;
  }

  const lastSeq = pendingAllMarks.at(-1)?.seq ?? watermark?.last_mark_seq ?? -1;
  await watermarkStore.write({ doc_id: input.documentId, last_mark_seq: lastSeq, updated_at: now() });
  await input.runtimeStore.writeCacheRecord({
    schema_version: OFFLINE_STORE_SCHEMA_VERSION,
    doc_id: snapshot.doc_id,
    runtime_schema_version: RUNTIME_SYNC_EVENT_SCHEMA_VERSION,
    metadata_cached: true,
    surface_cached: true,
    pending_event_count: (await input.runtimeStore.listPendingEvents(snapshot.doc_id)).length,
    updated_at: now(),
  });

  return {
    doc_id: snapshot.doc_id,
    scanned: marks.length,
    bridged,
    skipped: Math.max(0, pendingAllMarks.length - bridged),
    last_mark_seq: lastSeq,
    event_ids: eventIds,
  };
}

function runtimeBootstrapEvent(snapshot: RuntimeDocumentSnapshot, now: string, originDeviceId?: string): RuntimeSyncEvent {
  const revisionKey = runtimeBootstrapRevisionKey(snapshot);
  const revisionPrefix = String(revisionKey).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'snapshot';
  const stableRevision = `${revisionPrefix}_${stableRuntimeHash(String(revisionKey))}`;
  const event: Omit<RuntimeSyncEvent, 'dedupe_key'> = {
    schema_version: RUNTIME_SYNC_EVENT_SCHEMA_VERSION,
    event_id: `evt_bootstrap_${snapshot.doc_id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${stableRevision.slice(0, 40)}`,
    source: 'inkloop_device',
    doc_id: snapshot.doc_id,
    operation: 'runtime.bootstrap',
    target: { type: 'document', id: snapshot.doc_id },
    payload: { snapshot },
    origin: { device_id: originDeviceId || 'inkloop_device' },
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
  return { ...event, dedupe_key: `${snapshot.doc_id}:runtime.bootstrap:${stableRevision}` };
}

function runtimeBlockId(block: RuntimeSurfaceBlock): string {
  return block.projection?.block_id || block.object_id;
}

function snapshotWithoutEmbeddedAnnotations(snapshot: RuntimeDocumentSnapshot): RuntimeDocumentSnapshot {
  return {
    ...snapshot,
    blocks: snapshot.blocks.map((block) => {
      const { annotations: _annotations, ...rest } = block;
      return {
        ...rest,
        projection: block.projection
          ? {
              ...block.projection,
              knowledge_object_ids: [],
            }
          : block.projection,
      };
    }),
  };
}

function annotationBbox(annotation: RuntimeAnnotation): readonly number[] | undefined {
  const meta = annotation.inkloop_mark;
  if (meta && typeof meta === 'object' && Array.isArray((meta as { bbox?: unknown }).bbox)) return (meta as { bbox: number[] }).bbox;
  return annotation.visual_bbox;
}

function isPreservableRuntimeAnnotation(annotation: RuntimeAnnotation): boolean {
  const bbox = annotationBbox(annotation);
  return Array.isArray(bbox) && !isClearlyInvalidPageNormBbox(bbox);
}

function snapshotWithPreservedRuntimeAnnotations(incoming: RuntimeDocumentSnapshot, existing: RuntimeDocumentSnapshot | null): RuntimeDocumentSnapshot {
  if (!existing) return incoming;
  const existingBlocks = new Map(existing.blocks.map((block) => [runtimeBlockId(block), block] as const));
  return {
    ...incoming,
    blocks: incoming.blocks.map((block) => {
      const incomingAnnotations = block.annotations ?? [];
      const preservedAnnotations = (existingBlocks.get(runtimeBlockId(block))?.annotations ?? []).filter(isPreservableRuntimeAnnotation);
      if (!preservedAnnotations.length) return block;
      const incomingIds = new Set(incomingAnnotations.map((annotation) => annotation.ko_id));
      const annotations = [
        ...incomingAnnotations,
        ...preservedAnnotations.filter((annotation) => !incomingIds.has(annotation.ko_id)),
      ];
      return {
        ...block,
        annotations,
        projection: {
          ...(block.projection || {}),
          knowledge_object_ids: [
            ...new Set([
              ...(block.projection?.knowledge_object_ids || []),
              ...annotations.map((annotation) => annotation.ko_id).filter(Boolean),
            ]),
          ],
        },
      };
    }),
  };
}

function stableRuntimeHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function runtimeAnnotationSignature(annotation: RuntimeAnnotation): Record<string, unknown> {
  const markMeta = (annotation as { inkloop_mark?: Record<string, unknown> }).inkloop_mark;
  return {
    ko_id: annotation.ko_id,
    kind: annotation.kind,
    status: annotation.status,
    render_mode: annotation.render_mode,
    title: annotation.title,
    body_md: annotation.body_md,
    visual_bbox: annotation.visual_bbox,
    visual_strokes: annotation.visual_strokes?.map((stroke) => ({
      tool: stroke.tool,
      color: stroke.color,
      point_count: stroke.points?.length ?? 0,
    })),
    mark_id: typeof markMeta?.mark_id === 'string' ? markMeta.mark_id : undefined,
  };
}

function runtimeBootstrapRevisionKey(snapshot: RuntimeDocumentSnapshot): string {
  const sourceKey = snapshot.source_revision?.content_hash
    || snapshot.identity?.file_hash
    || snapshot.document.updated_at
    || snapshot.doc_id;
  const annotationKey = snapshot.blocks.map((block) => ({
    block_id: runtimeBlockId(block),
    annotations: (block.annotations ?? []).map(runtimeAnnotationSignature),
  }));
  return `${sourceKey}:annotations:${stableRuntimeHash(JSON.stringify(annotationKey))}`;
}

type RuntimeMarkOperation = 'annotation.add' | 'annotation.update' | 'annotation.delete';

function runtimeEventMarkId(event: RuntimeSyncEvent): string {
  return typeof event.payload.mark_id === 'string' ? event.payload.mark_id : '';
}

function runtimeMarkEventKey(docId: string, markId: string): string {
  return `${docId} ${markId}`;
}

/** (doc_id, mark_id) → 该 mark 的 outbox 事件：operation 推断从 O(m·n) 全扫降为索引查。 */
function runtimeEventsByMark(events: RuntimeSyncEvent[]): Map<string, RuntimeSyncEvent[]> {
  const index = new Map<string, RuntimeSyncEvent[]>();
  for (const event of events) {
    const markId = runtimeEventMarkId(event);
    if (!markId) continue;
    const key = runtimeMarkEventKey(event.doc_id, markId);
    const revisions = index.get(key) ?? [];
    revisions.push(event);
    index.set(key, revisions);
  }
  return index;
}

export function runtimeMarkDedupeKey(docId: string, mark: PersistedMark, operation: RuntimeMarkOperation): string {
  return `${docId}:${operation}:${mark.mark_id}:${mark.seq}`;
}

function eventCoversMarkRevision(event: RuntimeSyncEvent, docId: string, mark: PersistedMark): boolean {
  if (event.doc_id !== docId || runtimeEventMarkId(event) !== mark.mark_id) return false;
  if (event.payload.mark_seq === mark.seq) return true;
  return (['annotation.add', 'annotation.update', 'annotation.delete'] as const)
    .some((operation) => event.dedupe_key === runtimeMarkDedupeKey(docId, mark, operation));
}

/** 推断该 revision 该发 add / update / delete：
 *  - tombstone → delete；
 *  - 同 revision 已有事件 → 沿用其 operation（幂等重扫不抖动）；
 *  - 该 mark 有过任何早先事件、或已在 canonical runtime（knownMarkIds）→ update（覆盖撤销复活场景）；
 *  - 否则首次出现 → add。
 *  注意不能用 `seq > 1` 判 revision——seq 从 Date.now() 起跳。 */
function runtimeOperationForMark(
  docId: string,
  mark: PersistedMark,
  existingEvents: RuntimeSyncEvent[],
  knownMarkIds?: ReadonlySet<string>,
): RuntimeMarkOperation {
  if (mark.is_tombstone) return 'annotation.delete';

  const sameRevision = existingEvents.find((event) => eventCoversMarkRevision(event, docId, mark));
  if (sameRevision?.operation === 'annotation.add' || sameRevision?.operation === 'annotation.update') {
    return sameRevision.operation;
  }

  const hasPriorRevision = !!knownMarkIds?.has(mark.mark_id)
    || existingEvents.some((event) =>
      event.doc_id === docId
      && runtimeEventMarkId(event) === mark.mark_id
      && (event.operation === 'annotation.add'
        || event.operation === 'annotation.update'
        || event.operation === 'annotation.delete'));

  return hasPriorRevision ? 'annotation.update' : 'annotation.add';
}

function runtimeEventForMark(
  snapshot: RuntimeDocumentSnapshot,
  mark: PersistedMark,
  operation: RuntimeMarkOperation,
  now: string,
  originDeviceId?: string,
): RuntimeSyncEvent {
  const binding = annotationForMark(snapshot.blocks, mark);
  const annotation = binding?.annotation ?? fallbackAnnotation(mark, now);
  const target = { type: 'annotation' as const, id: annotation.ko_id, block_id: binding?.blockId };
  const captureDeviceId = mark.device_id || 'inkloop_device';
  const sourceDeviceId = originDeviceId || captureDeviceId;
  const annotationWithMarkMeta: RuntimeAnnotation = {
    ...annotation,
    inkloop_mark: {
      ...(isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {}),
      mark_id: mark.mark_id,
      mark_seq: mark.seq,
      marked_text: mark.marked_text,
      kind: mark.kind || mark.feature_type,
      feature_type: mark.feature_type,
      tool: mark.tool,
      origin: mark.origin,
      scored_type: mark.scored_type,
      page_id: mark.page_id,
      page_index: mark.page_index,
      bbox: mark.bbox,
      source_device_id: sourceDeviceId,
    },
  };
  const markPayload = {
    block_id: binding?.blockId,
    mark_id: mark.mark_id,
    mark_seq: mark.seq,
    marked_text: mark.marked_text,
    ai_eligible: mark.ai_eligible,
    kind: mark.kind || mark.feature_type,
    feature_type: mark.feature_type,
    tool: mark.tool,
    origin: mark.origin,
    scored_type: mark.scored_type,
    hmp_action: mark.hmp?.action,
    page_id: mark.page_id,
    page_index: mark.page_index,
    bbox: mark.bbox,
  };
  const event: Omit<RuntimeSyncEvent, 'dedupe_key'> = {
    schema_version: RUNTIME_SYNC_EVENT_SCHEMA_VERSION,
    event_id: runtimeSyncEventIdForMarkId(mark.mark_id, mark.seq),
    source: mark.device_id === 'obsidian' ? 'obsidian_plugin' : 'inkloop_device',
    doc_id: snapshot.doc_id,
    operation,
    target,
    payload: operation === 'annotation.delete'
      ? { ko_id: annotation.ko_id, mark_id: mark.mark_id, mark_seq: mark.seq, tombstone: true }
      : operation === 'annotation.update'
        ? { ...markPayload, ko_id: annotation.ko_id, patch: annotationWithMarkMeta }
        : { ...markPayload, annotation: annotationWithMarkMeta },
    origin: { device_id: sourceDeviceId, capture_device_id: captureDeviceId },
    status: 'pending',
    created_at: mark.created_at || now,
    updated_at: now,
  };
  return { ...event, dedupe_key: runtimeMarkDedupeKey(snapshot.doc_id, mark, operation) };
}

export function buildRuntimeSyncEventForMark(
  snapshot: RuntimeDocumentSnapshot,
  mark: PersistedMark,
  now: string,
  originDeviceId?: string,
  operation?: RuntimeMarkOperation,
): RuntimeSyncEvent {
  const op = operation ?? (mark.is_tombstone ? 'annotation.delete' : 'annotation.add');
  return runtimeEventForMark(snapshot, mark, op, now, originDeviceId);
}

function annotationForMark(blocks: RuntimeSurfaceBlock[], mark: PersistedMark): { blockId: string; annotation: RuntimeAnnotation } | null {
  const candidates: { blockId: string; annotation: RuntimeAnnotation; score: number }[] = [];
  for (const block of blocks) {
    const blockId = block.projection?.block_id || block.object_id;
    for (const annotation of block.annotations ?? []) {
      const meta = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {};
      const explicitMarkId = stringValue(meta.mark_id);
      let score = 0;
      if (explicitMarkId && explicitMarkId === mark.mark_id) score += 1000;
      if (annotation.ko_id === mark.mark_id || annotation.ko_id.endsWith(mark.mark_id.replace(/^mark_/, ''))) score += 600;
      const annotationBbox = runtimeBbox(meta.bbox) || runtimeBbox(annotation.visual_bbox);
      if (annotationBbox) score += Math.max(0, 220 - bboxDistance(mark.bbox, annotationBbox) * 1400);
      if (annotation.created_at && annotation.created_at === mark.created_at) score += 80;
      if (score > 0) candidates.push({ blockId, annotation, score });
    }
  }
  if (!candidates.length) return null;
  const best = [...candidates].sort((a, b) => (b.score - a.score) || (annotationSignalScore(b.annotation) - annotationSignalScore(a.annotation)))[0];
  const related = candidates.filter((candidate) => candidate.blockId === best.blockId && candidate.annotation.ko_id === best.annotation.ko_id);
  return { blockId: best.blockId, annotation: mergeRuntimeAnnotations(best.annotation, related.map((candidate) => candidate.annotation)) };
}

function bboxDistance(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax = a[0] + a[2] / 2;
  const ay = a[1] + a[3] / 2;
  const bx = b[0] + b[2] / 2;
  const by = b[1] + b[3] / 2;
  return Math.hypot(ax - bx, ay - by);
}

function annotationText(value: unknown): string {
  return String(value || '').trim();
}

function annotationSignalScore(annotation: RuntimeAnnotation): number {
  let score = 0;
  if (annotationText(annotation.body_md)) score += 8;
  if (annotationText(annotation.title)) score += 2;
  if (annotation.render_mode === 'margin_note') score += 3;
  if (Array.isArray(annotation.visual_strokes) && annotation.visual_strokes.length) score += 1;
  if (Array.isArray(annotation.surface_strokes) && annotation.surface_strokes.length) score += 1;
  return score;
}

function mergeRuntimeAnnotations(primary: RuntimeAnnotation, candidates: RuntimeAnnotation[]): RuntimeAnnotation {
  const withVisual = candidates.find((annotation) => Array.isArray(annotation.visual_strokes) && annotation.visual_strokes.length);
  const withSurface = candidates.find((annotation) => Array.isArray(annotation.surface_strokes) && annotation.surface_strokes.length);
  const withBox = candidates.find((annotation) => Array.isArray(annotation.visual_bbox) && annotation.visual_bbox.length === 4);
  const withBody = candidates.find((annotation) => annotationText(annotation.body_md));
  return {
    ...primary,
    ...(withBody?.body_md && !annotationText(primary.body_md) ? { body_md: withBody.body_md } : {}),
    ...(withVisual?.visual_strokes && !primary.visual_strokes?.length ? { visual_strokes: withVisual.visual_strokes } : {}),
    ...(withSurface?.surface_strokes && !primary.surface_strokes?.length ? { surface_strokes: withSurface.surface_strokes } : {}),
    ...(withBox?.visual_bbox && !primary.visual_bbox ? { visual_bbox: withBox.visual_bbox } : {}),
  };
}

function runtimeVisualTool(tool: unknown): 'pen' | 'aipen' | 'highlighter' | 'underline' {
  if (tool === 'aipen' || tool === 'ai_pen') return 'aipen';
  if (tool === 'highlighter') return 'highlighter';
  if (tool === 'underline') return 'underline';
  return 'pen';
}

function fallbackAnnotation(mark: PersistedMark, now: string): RuntimeAnnotation {
  return {
    ko_id: `ko_${mark.mark_id.replace(/^mark_/, '')}`,
    kind: mark.kind || mark.feature_type || 'stroke',
    title: mark.marked_text?.trim() || 'Ink mark',
    status: mark.is_tombstone ? 'deleted' : 'edited',
    render_mode: 'stroke_only',
    visual_bbox: mark.bbox,
    visual_strokes: mark.strokes
      .filter((stroke) => stroke.tool === 'pen' || stroke.tool === 'aipen' || stroke.tool === 'highlighter' || stroke.tool === 'underline')
      .map((stroke) => ({
        tool: runtimeVisualTool(stroke.tool),
        color: mark.color,
        points: stroke.points,
      })),
    created_at: mark.created_at || now,
    updated_at: now,
  };
}
