import { IndexedDbOfflineRuntimeStore, type OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import { HttpRuntimeSyncTransport, isRuntimeDeadLetter, rearmDeadLettersOnce, RuntimeSyncRunner } from 'ink-surface-sdk/sync-client';
import type { RuntimeAnnotation, RuntimeDocumentSnapshot, RuntimeDocumentSourceKind, RuntimeStrokePoint, RuntimeSurfaceBlock, RuntimeVisualStroke } from 'ink-surface-sdk/runtime-schema';
import { apiBase, apiUrlWithLocalHttpFallback } from '../../core/api';
import { authHeaders, getSession, onAuthChange, runtimeTenantId, runtimeUserId } from '../../core/auth';
import { appendMarkEntry, getDoc, getFoldedMarks, getLatestMarkRevisions, getLatestMarkRevisionsByContext, getMeeting, setAiTurnAppendHook, setRuntimeLedgerAppendHook } from '../../local/store';
import type { PersistedDoc, PersistedMark } from '../../core/store-format';
import { bus, getActiveContext, state, strokeMarkIds, type Stroke, type Tool } from '../../app/state';
import { pageIdFor } from '../../core/ids';
import { restoreLedgerState } from '../../controllers/ledger-restore';
import { redrawInk } from '../../capture/ink';
import { buildL1Export } from './index';
import { buildMeetingL1Export } from './meeting-export';
import { meetingContextId, meetingIdFromRuntimeDocumentId, runtimeDocumentIdForLedgerMark, runtimeDocumentIdForSyncRequest } from './runtime-meeting-routing';
import { buildRuntimeSnapshotFromProjection, bridgeRuntimeLedgerToStore, buildRuntimeSyncEventForMark, isRuntimeInvalidPageNormMark, localStorageRuntimeBridgeWatermarks } from './runtime-sync-bridge';
import { requeueVisibleRuntimeMarksForCloudAlignment, visibleRuntimeMarkSignature } from './runtime-sync-alignment';
import { RuntimeStoreInbox } from './runtime-inbox';
import { RUNTIME_SYNC_RETRY_DEAD_LETTERS_EVENT, type RuntimeSyncStatusDetail, type RuntimeSyncUiState } from '../../components/runtime-sync-status';

// ── 高频书写面（会议画板）同步挂起：落账本只进 pending 集不推送、周期任务全停；解除时补一轮 ──
// 「落账本即 120ms 推送」在 BOOX WebView 上意味着书写停顿间隙不断有 IDB+网络+横幅 DOM 活动打进笔画，
// 画板打开期间整体挂起、退出画板一次性同步（用户 2026-07-16 指定方案）。事件都在 outbox/账本里，不丢。
let syncHeld = false;
const syncHeldReleases = new Set<() => void>();
export function setRuntimeSyncHeld(on: boolean): void {
  if (syncHeld === on) return;
  syncHeld = on;
  if (!on) for (const release of [...syncHeldReleases]) release();
}

const MAGIC_SYNC_DEBOUNCE_MS = 120;
const MAGIC_SYNC_POLL_MS = 500;
const MAGIC_SYNC_RECONCILE_MS = 3_000;
const MAGIC_SYNC_RECONCILE_STALE_MS = 15_000;
const MAGIC_SYNC_OUTBOX_DRAIN_MS = 15_000;

export interface WebRuntimeSyncHostOptions {
  deviceId?: string;
  pushEndpoint?: string;
  pullEndpoint?: string;
  batchSize?: number;
  debounceMs?: number;
  pollMs?: number;
  reconcileMs?: number;
  reconcileStaleMs?: number;
  outboxDrainMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  runtimeStore?: OfflineRuntimeStorePort;
  logger?: (event: string, details?: unknown) => void;
  onRemoteApplied?: (input: { docIds: string[]; store: OfflineRuntimeStorePort }) => void | Promise<void>;
}

export interface WebRuntimeSyncHost {
  deviceId: string;
  store: OfflineRuntimeStorePort;
  syncDocument(documentId: string, reason?: string): Promise<void>;
  pullNow(reason?: string): Promise<void>;
  reconcileNow(documentId?: string, reason?: string): Promise<void>;
  dispose(): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableDeviceId(): string {
  const key = 'inkloop.runtime-sync.device-id';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = `web_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return 'web_runtime';
  }
}

function runtimeCursorKey(deviceId: string): string {
  return `${runtimeTenantId()}/${runtimeUserId()}/${deviceId}`;
}

function runtimeSyncUrl(path: string): string {
  return apiUrlWithLocalHttpFallback(path);
}

function sourceKindForDoc(doc: PersistedDoc | null): RuntimeDocumentSourceKind {
  const name = doc?.filename || '';
  if (/\.pdf$/i.test(name)) return 'imported_pdf';
  if (/\.md$/i.test(name)) return 'native_markdown';
  return 'inkloop_created';
}

export function runtimeSourceContentHash(projection: { body_hash?: string; content_hash?: string } | undefined): string | undefined {
  return projection?.body_hash || projection?.content_hash;
}

const hydratedRuntimeStrokeKeys = new WeakMap<Stroke, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function runtimeBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((part) => Number(part));
  return nums.every(Number.isFinite) ? nums as [number, number, number, number] : null;
}

function isClearlyInvalidPageNormBbox(bbox: [number, number, number, number]): boolean {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0) return true;
  if (x < -0.05 || y < -0.05) return true;
  if (w > 1.1 || h > 1.1) return true;
  if (x + w > 1.05 || y + h > 1.05) return true;
  return false;
}

function runtimeTool(tool: unknown): Tool {
  if (tool === 'aipen' || tool === 'ai_pen') return 'aipen';
  if (tool === 'underline') return 'underline';
  return tool === 'highlighter' ? 'highlighter' : 'pen';
}

function runtimePersistedStrokeTool(tool: unknown): PersistedMark['strokes'][number]['tool'] {
  if (tool === 'aipen' || tool === 'ai_pen') return 'aipen';
  if (tool === 'underline') return 'underline';
  return tool === 'highlighter' ? 'highlighter' : 'pen';
}

function runtimeOrigin(origin: string, tool: PersistedMark['tool'], isAiPen: boolean): PersistedMark['origin'] {
  if (isAiPen) return 'ai_pen';
  if (origin === 'pen' || origin === 'highlighter' || origin === 'underline' || origin === 'auto') return origin;
  return tool;
}

function persistedStrokeToCanvasStroke(stroke: PersistedMark['strokes'][number]): Stroke | null {
  const points = stroke.points
    .map((point, index) => ({ x: Number(point.x), y: Number(point.y), t: typeof point.t === 'number' ? point.t : index, pressure: typeof point.pressure === 'number' ? point.pressure : 0.5 }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return null;
  return { tool: runtimeTool(stroke.tool), points };
}

function runtimePointsToPersisted(points: RuntimeStrokePoint[] = []): PersistedMark['strokes'][number]['points'] {
  return points
    .map((point, index) => ({
      x: Number(point.x),
      y: Number(point.y),
      t: typeof point.t === 'number' ? point.t : index,
      pressure: typeof point.pressure === 'number' ? point.pressure : 0.5,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function visualStrokeBbox(strokes: RuntimeVisualStroke[] = []): [number, number, number, number] | null {
  const points = strokes.flatMap((stroke) => stroke.points ?? []);
  if (!points.length) return null;
  const xs = points.map((point) => Number(point.x)).filter(Number.isFinite);
  const ys = points.map((point) => Number(point.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return [x0, y0, Math.max(0.001, x1 - x0), Math.max(0.001, y1 - y0)];
}

function pointIsPageNorm(point: RuntimeStrokePoint | { x: number; y: number }): boolean {
  const x = Number(point.x);
  const y = Number(point.y);
  return Number.isFinite(x) && Number.isFinite(y) && x >= -0.05 && y >= -0.05 && x <= 1.05 && y <= 1.05;
}

function visualStrokeIsPageNorm(stroke: RuntimeVisualStroke): boolean {
  if (stroke.coord_space && stroke.coord_space !== 'page_norm' && stroke.coord_space !== 'page') return false;
  const points = stroke.points ?? [];
  return points.length > 0 && points.every(pointIsPageNorm);
}

function persistedStrokeIsPageNorm(stroke: PersistedMark['strokes'][number]): boolean {
  const points = stroke.points ?? [];
  return points.length > 0 && points.every(pointIsPageNorm);
}

function markHasDrawablePageNormStrokes(mark: PersistedMark): boolean {
  return mark.strokes.some(persistedStrokeIsPageNorm);
}

function roundedCoord(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(4) : 'nan';
}

function bboxSignature(bbox: readonly number[] | undefined): string {
  if (!Array.isArray(bbox)) return '';
  return bbox.map(roundedCoord).join(',');
}

function hasMeaningfulPageNormBbox(mark: PersistedMark): boolean {
  if (!Array.isArray(mark.bbox) || mark.bbox.length !== 4) return false;
  const [, , width, height] = mark.bbox.map(Number);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0.002 && height > 0.002;
}

function markStrokeSignature(mark: PersistedMark): string {
  return mark.strokes
    .map((stroke) => {
      const points = stroke.points ?? [];
      const first = points[0];
      const last = points[points.length - 1];
      return [
        stroke.tool,
        stroke.coord_space ?? mark.coord_space ?? 'page_norm',
        stroke.capture_surface ?? mark.capture_surface ?? 'page',
        points.length,
        first ? `${roundedCoord(first.x)},${roundedCoord(first.y)}` : '',
        last ? `${roundedCoord(last.x)},${roundedCoord(last.y)}` : '',
      ].join(':');
    })
    .join('|');
}

function syntheticStrokeForBbox(
  bbox: [number, number, number, number],
  tool: PersistedMark['strokes'][number]['tool'],
): PersistedMark['strokes'][number] {
  const [x, y, w, h] = bbox;
  const yLine = Math.min(0.99, Math.max(0.01, y + Math.max(h * 0.75, 0.006)));
  const x0 = Math.min(0.99, Math.max(0.01, x));
  const x1 = Math.min(0.99, Math.max(0.01, x + w));
  const mid = (x0 + x1) / 2;
  const bend = tool === 'aipen' ? Math.min(0.008, Math.max(0.002, h * 0.35)) : 0;
  return {
    tool,
    coord_space: 'page_norm',
    capture_surface: 'page',
    points: [
      { x: x0, y: yLine, t: 0, pressure: 0.5 },
      { x: mid, y: Math.min(0.99, yLine + bend), t: 16, pressure: 0.52 },
      { x: x1, y: yLine, t: 32, pressure: 0.5 },
    ],
  };
}

function markIdFromRuntimeAnnotation(annotation: RuntimeAnnotation, meta: Record<string, unknown>): string {
  const explicit = stringValue(meta.mark_id);
  if (explicit) return explicit;
  if (annotation.ko_id.startsWith('mark_')) return annotation.ko_id;
  if (annotation.ko_id.startsWith('ko_mark_')) return annotation.ko_id.slice(3);
  if (annotation.ko_id.startsWith('ko_')) return `mark_${annotation.ko_id.slice(3)}`;
  return `mark_${annotation.ko_id}`;
}

export function runtimeAnnotationToMark(docId: string, block: RuntimeSurfaceBlock, annotation: RuntimeAnnotation): PersistedMark | null {
  if (annotation.status === 'deleted') return null;
  const meta = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {};
  const pageIndex = finiteNumber(meta.page_index)
    ?? finiteNumber(block.projection?.page_index)
    ?? 0;
  const pageId = stringValue(meta.page_id) || pageIdFor(docId, pageIndex);
  const visualStrokes = annotation.visual_strokes ?? [];
  const rawTool = stringValue(meta.tool) || visualStrokes.find((stroke) => stroke.tool)?.tool || '';
  const rawOrigin = stringValue(meta.origin);
  const isAiPen = rawOrigin === 'ai_pen' || rawTool === 'aipen' || rawTool === 'ai_pen';
  const tool: PersistedMark['tool'] = rawTool === 'highlighter' ? 'highlighter' : rawTool === 'underline' ? 'underline' : 'pen';
  const featureType: PersistedMark['feature_type'] =
    meta.feature_type === 'markup' || tool === 'highlighter' || tool === 'underline'
      ? 'markup'
      : meta.feature_type === 'drawing'
        ? 'drawing'
        : 'handwriting';
  const createdAt = stringValue(meta.created_at) || annotation.created_at || new Date().toISOString();
  const markId = markIdFromRuntimeAnnotation(annotation, meta);
  const bbox = runtimeBbox(meta.bbox) || runtimeBbox(annotation.visual_bbox) || visualStrokeBbox(visualStrokes) || [0, 0, 0.001, 0.001];
  if (isClearlyInvalidPageNormBbox(bbox)) return null;
  const strokeTool = isAiPen ? 'aipen' : runtimePersistedStrokeTool(rawTool || visualStrokes.find((stroke) => stroke.tool)?.tool);
  const strokes: PersistedMark['strokes'] = visualStrokes
    .filter(visualStrokeIsPageNorm)
    .map((stroke) => ({
      tool: isAiPen ? 'aipen' : runtimePersistedStrokeTool(stroke.tool),
      points: runtimePointsToPersisted(stroke.points),
      coord_space: 'page_norm' as const,
      capture_surface: 'page' as const,
    }))
    .filter((stroke) => stroke.points.length > 0);
  if (!strokes.length) strokes.push(syntheticStrokeForBbox(bbox, strokeTool));
  const color = stringValue(visualStrokes[0]?.color) || (tool === 'highlighter' ? '#facc15' : '#111111');
  return {
    entry_id: `remote_${markId}`,
    document_id: docId,
    page_id: pageId,
    page_index: pageIndex,
    seq: Date.parse(createdAt) || 0,
    created_at: createdAt,
    mark_id: markId,
    strokes,
    bbox,
    coord_space: 'page_norm',
    capture_surface: 'page',
    tool,
    color,
    pointer_type: 'remote',
    device_id: stringValue(meta.source_device_id) || 'runtime-sync',
    abs_timestamp: Date.parse(createdAt) || Date.now(),
    pen_down_at: finiteNumber(meta.pen_down_at) ?? undefined,
    feature_type: featureType,
    feature_confidence: 1,
    kind: stringValue(meta.kind) || annotation.kind || featureType,
    kind_source: 'runtime-sync',
    scored_type: stringValue(meta.scored_type) || featureType,
    scored_score: 1,
    hmp: null,
    marked_text: stringValue(meta.marked_text) || stringValue(annotation.body_md) || stringValue(annotation.title) || '',
    ai_eligible: false,
    origin: runtimeOrigin(rawOrigin, tool, isAiPen),
    is_tombstone: false,
  };
}

export function shouldAdoptRemoteMarkRevision(local: PersistedMark | undefined, remote: PersistedMark | null): local is PersistedMark {
  if (!local || !remote || local.is_tombstone || remote.is_tombstone) return false;
  const remoteText = (remote.marked_text || '').trim();
  if (remoteText && remoteText !== (local.marked_text || '').trim()) return true;
  if (!markHasDrawablePageNormStrokes(local) && markHasDrawablePageNormStrokes(remote)) return true;
  if (markHasDrawablePageNormStrokes(remote) && markStrokeSignature(local) !== markStrokeSignature(remote)) return true;
  if (hasMeaningfulPageNormBbox(remote) && bboxSignature(local.bbox) !== bboxSignature(remote.bbox)) return true;
  if ((local.origin || '') !== (remote.origin || '') && remote.origin === 'ai_pen') return true;
  return false;
}

async function appendRemoteMarkRevision(local: PersistedMark, remote: PersistedMark): Promise<void> {
  const { entry_id: _entryId, seq: _seq, created_at: _createdAt, ...rest } = local;
  await appendMarkEntry({
    ...rest,
    strokes: remote.strokes.length ? remote.strokes : local.strokes,
    coord_space: remote.coord_space ?? local.coord_space,
    capture_surface: remote.capture_surface ?? local.capture_surface,
    surface_bbox: remote.surface_bbox ?? local.surface_bbox,
    surface_coord_space: remote.surface_coord_space ?? local.surface_coord_space,
    reader_layout_id: remote.reader_layout_id ?? local.reader_layout_id,
    pen_down_at: remote.pen_down_at ?? local.pen_down_at,
    tool: remote.tool || local.tool,
    color: remote.color || local.color,
    bbox: remote.bbox,
    feature_type: remote.feature_type,
    feature_confidence: Math.max(local.feature_confidence || 0, remote.feature_confidence || 0, 1),
    kind: remote.kind || local.kind,
    kind_source: 'runtime-sync',
    scored_type: remote.scored_type || local.scored_type,
    scored_score: Math.max(local.scored_score || 0, remote.scored_score || 0, 1),
    hmp: local.hmp,
    marked_text: remote.marked_text || local.marked_text,
    ai_eligible: false,
    origin: remote.origin || local.origin,
    source_created_at: local.source_created_at ?? local.created_at,
  }, { notifyRuntime: false });
}

function remoteMarkEntryDraft(mark: PersistedMark): Parameters<typeof appendMarkEntry>[0] {
  const {
    entry_id: _entryId,
    seq: _seq,
    created_at,
    schema_version: _schemaVersion,
    ...draft
  } = mark;
  return {
    ...draft,
    kind_source: draft.kind_source || 'runtime-sync',
    source_created_at: draft.source_created_at ?? created_at,
  };
}

function canonicalRuntimeMarkIds(runtime: RuntimeDocumentSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const block of runtime.blocks) {
    for (const annotation of block.annotations ?? []) {
      if (annotation.status === 'deleted') continue;
      const meta = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {};
      ids.add(markIdFromRuntimeAnnotation(annotation, meta));
    }
  }
  return ids;
}

function isRuntimeManagedLocalMark(mark: PersistedMark): boolean {
  const kindSource = mark.kind_source || '';
  return mark.pointer_type === 'remote'
    || mark.device_id === 'runtime-sync'
    || kindSource === 'runtime-sync'
    || kindSource.startsWith('runtime-sync-');
}

export function staleRuntimeManagedMarksForCanonicalRemote(
  localMarks: PersistedMark[],
  canonicalMarkIds: Set<string>,
): PersistedMark[] {
  if (!canonicalMarkIds.size) return [];
  return localMarks.filter((mark) => isRuntimeManagedLocalMark(mark) && !canonicalMarkIds.has(mark.mark_id));
}

function canonicalDeletedRuntimeMarkIds(runtime: RuntimeDocumentSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const block of runtime.blocks) {
    for (const annotation of block.annotations ?? []) {
      if (annotation.status !== 'deleted') continue;
      const meta = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {};
      ids.add(markIdFromRuntimeAnnotation(annotation, meta));
    }
  }
  return ids;
}

/** 远端删除要落回本地账本：canonical 里显式 status=deleted 的 annotation（B 删了 A 的本地 origin mark，
 *  annotation.delete 事件把 A 端 canonical 标 deleted）+ 从 canonical 消失的 runtime-managed mark，
 *  两类都 tombstone 本地账本——否则 A 端 mark 永久可见、两端分叉。 */
export function runtimeMarksToTombstoneForCanonicalRemote(
  localMarks: PersistedMark[],
  runtime: RuntimeDocumentSnapshot,
): PersistedMark[] {
  const activeIds = canonicalRuntimeMarkIds(runtime);
  const explicitDeletedIds = canonicalDeletedRuntimeMarkIds(runtime);
  const absentManaged = staleRuntimeManagedMarksForCanonicalRemote(localMarks, activeIds);
  const tombstoneIds = new Set([
    ...explicitDeletedIds,
    ...absentManaged.map((mark) => mark.mark_id),
  ]);
  return localMarks.filter((mark) => tombstoneIds.has(mark.mark_id));
}

/** 出站过滤只按 origin 信号防回环（remote/runtime-sync 来源不回推）。
 *  不再按 canonicalMarkIds 整体排除——那会吞掉本地对 canonical mark 的后续 revision/tombstone；
 *  canonical 集合改经 knownMarkIds 传给 bridge 用于 add/update 判定。 */
export function outboundRuntimeMarksForCloudPush(
  localMarks: PersistedMark[],
  _canonicalMarkIds: Set<string>,
): PersistedMark[] {
  return localMarks.filter((mark) => !isRuntimeManagedLocalMark(mark));
}

export function visibleRuntimeMarksForCloudAlignment(localMarks: PersistedMark[]): PersistedMark[] {
  return localMarks.filter((mark) => !mark.is_tombstone);
}

function runtimeReconcileTombstoneDraft(mark: PersistedMark): Parameters<typeof appendMarkEntry>[0] {
  const {
    entry_id: _entryId,
    seq: _seq,
    created_at,
    schema_version: _schemaVersion,
    ...draft
  } = mark;
  return {
    ...draft,
    strokes: [],
    hmp: null,
    marked_text: '',
    ai_eligible: false,
    kind_source: 'runtime-sync-reconcile',
    source_created_at: draft.source_created_at ?? created_at,
    is_tombstone: true,
  };
}

function clearHydratedRuntimeStrokes(docId: string): void {
  const prefix = `${docId}:`;
  const ctx = getActiveContext();
  for (const [pageId, strokes] of ctx.strokesByPage.entries()) {
    const kept = strokes.filter((stroke) => !hydratedRuntimeStrokeKeys.get(stroke)?.startsWith(prefix));
    if (kept.length === strokes.length) continue;
    ctx.strokesByPage.set(pageId, kept);
  }
}

export async function hydrateRuntimeAnnotationsToActiveCanvas(store: OfflineRuntimeStorePort, docId: string): Promise<void> {
  if (state.documentId !== docId) return;
  const runtime = await store.loadDocument(docId);
  if (!runtime) return;

  await restoreLedgerState(docId);
  clearHydratedRuntimeStrokes(docId);

  let localMarks = (await getFoldedMarks(docId)).filter((mark) => !isRuntimeInvalidPageNormMark(mark));
  const staleRuntimeMarks = runtimeMarksToTombstoneForCanonicalRemote(localMarks, runtime);
  if (staleRuntimeMarks.length) {
    for (const staleMark of staleRuntimeMarks) {
      await appendMarkEntry(runtimeReconcileTombstoneDraft(staleMark), { notifyRuntime: false });
    }
    const staleMarkIds = new Set(staleRuntimeMarks.map((mark) => mark.mark_id));
    localMarks = localMarks.filter((mark) => !staleMarkIds.has(mark.mark_id));
  }
  const localMarkById = new Map(localMarks.map((mark) => [mark.mark_id, mark] as const));
  const localAnnotationIds = new Set(localMarks.flatMap((mark) => [
    mark.mark_id,
    `ko_${mark.mark_id}`,
    `ko_${mark.mark_id.replace(/^mark_/, '')}`,
    mark.created_at ? `created:${mark.created_at}` : '',
  ]));
  const localMarkIds = new Set(localMarks.map((mark) => mark.mark_id));
  const remoteMarks: PersistedMark[] = [];
  const remoteRevisions: Array<{ local: PersistedMark; remote: PersistedMark }> = [];
  const ctx = getActiveContext();
  for (const block of runtime.blocks) {
    const pageIndex = typeof block.projection?.page_index === 'number' ? block.projection.page_index : 0;
    const pageId = pageIdFor(docId, pageIndex);
    const pageStrokes = ctx.strokesByPage.get(pageId) ?? [];
    for (const annotation of block.annotations ?? []) {
      const remoteMark = runtimeAnnotationToMark(docId, block, annotation);
      const isLocalAnnotation = localAnnotationIds.has(annotation.ko_id)
        || (remoteMark ? localMarkIds.has(remoteMark.mark_id) : false)
        || (annotation.created_at ? localAnnotationIds.has(`created:${annotation.created_at}`) : false);
      const localMark = remoteMark ? localMarkById.get(remoteMark.mark_id) : undefined;
      if (remoteMark && shouldAdoptRemoteMarkRevision(localMark, remoteMark)) remoteRevisions.push({ local: localMark, remote: remoteMark });
      if (remoteMark && !isLocalAnnotation) remoteMarks.push(remoteMark);
      if (!remoteMark?.strokes.length || isLocalAnnotation) continue;
      remoteMark.strokes.forEach((stroke, index) => {
        const canvasStroke = persistedStrokeToCanvasStroke(stroke);
        if (!canvasStroke) return;
        hydratedRuntimeStrokeKeys.set(canvasStroke, `${docId}:${annotation.ko_id}:${index}`);
        strokeMarkIds.set(canvasStroke, annotation.ko_id);
        pageStrokes.push(canvasStroke);
      });
    }
    ctx.strokesByPage.set(pageId, pageStrokes);
  }
  if (remoteRevisions.length || remoteMarks.length || staleRuntimeMarks.length) {
    for (const revision of remoteRevisions) await appendRemoteMarkRevision(revision.local, revision.remote);
    for (const remoteMark of remoteMarks) await appendMarkEntry(remoteMarkEntryDraft(remoteMark), { notifyRuntime: false });
    await restoreLedgerState(docId);
    const restoredMarks = [...remoteRevisions.map((revision) => revision.remote), ...remoteMarks];
    bus.emit('marks:restored', restoredMarks);
    if (staleRuntimeMarks.length) {
      bus.emit('runtime-sync:local-cache-reconciled', {
        doc_id: docId,
        tombstoned_mark_ids: staleRuntimeMarks.map((mark) => mark.mark_id),
      });
    }
    redrawInk();
    return;
  }
  redrawInk();
}

async function buildSnapshot(documentId: string, generatedAt = nowIso()): Promise<RuntimeDocumentSnapshot> {
  const meetingId = meetingIdFromRuntimeDocumentId(documentId);
  if (meetingId) return buildMeetingSnapshot(meetingId, generatedAt);
  const doc = await getDoc(documentId);
  const exported = await buildL1Export(documentId, { generatedAt });
  const projection = exported.documentProjections.document_projections[0];
  return buildRuntimeSnapshotFromProjection({
    documentId,
    documentTitle: doc?.filename || exported.visualModel.documentTitle || '(untitled)',
    projectionBlocks: projection?.blocks ?? [],
    knowledgeObjects: exported.knowledgeExport.objects,
    sourceKind: sourceKindForDoc(doc),
    sourcePath: doc?.filename,
    fileHash: doc?.file_hash,
    contentHash: runtimeSourceContentHash(projection),
    updatedAt: generatedAt,
  });
}

async function buildMeetingSnapshot(meetingId: string, generatedAt = nowIso()): Promise<RuntimeDocumentSnapshot> {
  const exported = await buildMeetingL1Export(meetingId, { generatedAt });
  const projection = exported.documentProjections.document_projections[0];
  return buildRuntimeSnapshotFromProjection({
    documentId: exported.documentId,
    documentTitle: exported.documentTitle,
    projectionBlocks: projection?.blocks ?? [],
    knowledgeObjects: exported.knowledgeExport.objects,
    sourceKind: 'inkloop_created',
    sourcePath: `Meetings/${exported.documentTitle}.md`,
    contentHash: runtimeSourceContentHash(projection),
    updatedAt: generatedAt,
  });
}

async function loadRuntimeMarks(documentId: string): Promise<PersistedMark[]> {
  const meetingId = meetingIdFromRuntimeDocumentId(documentId);
  // 用含 tombstone 的 revision 视图：同步链必须看到删除，否则 delete 事件永远发不出去。
  return meetingId
    ? getLatestMarkRevisionsByContext(meetingContextId(meetingId))
    : getLatestMarkRevisions(documentId);
}

async function canonicalRuntimeMarkIdsFromStore(store: OfflineRuntimeStorePort, documentId: string): Promise<Set<string>> {
  try {
    const runtime = await store.loadDocument(documentId);
    return runtime ? canonicalRuntimeMarkIds(runtime) : new Set();
  } catch {
    return new Set();
  }
}

async function runtimeDocumentTitle(documentId: string): Promise<string> {
  const meetingId = meetingIdFromRuntimeDocumentId(documentId);
  if (meetingId) return (await getMeeting(meetingId))?.title || '会议';
  return (await getDoc(documentId))?.filename || '(untitled)';
}

export function installWebRuntimeSyncHost(options: WebRuntimeSyncHostOptions = {}): WebRuntimeSyncHost {
  const deviceId = options.deviceId || getSession()?.deviceId || stableDeviceId();
  const store = options.runtimeStore || new IndexedDbOfflineRuntimeStore({ dbName: 'inkloop-runtime-store' });
  const maxAttempts = Math.max(1, options.maxAttempts ?? 25);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
  const createRunner = (): RuntimeSyncRunner => {
    const transport = new HttpRuntimeSyncTransport({
      endpoint: options.pushEndpoint || runtimeSyncUrl('/v1/runtime/events:push'),
      pullEndpoint: options.pullEndpoint || runtimeSyncUrl('/v1/runtime/events:pull'),
      deviceId,
      headers: authHeaders,
    });
    return new RuntimeSyncRunner(store, transport, {
      deviceId,
      cursorKey: runtimeCursorKey(deviceId),
      inbox: new RuntimeStoreInbox(store, { deviceId, advanceCursorOnRecoverableConflicts: true }),
      batchSize: Math.max(1, options.batchSize ?? 25),
      maxAttempts,
      retryDelayMs,
      pullLimit: 100,
    });
  };
  // watermark 按 (tenant/user) 命名空间隔离。身份升级（设备授权 local_user → 飞书 feishu_ou_*）时
  // 必须重建，否则继续读写旧命名空间的 watermark（cursorKey 每次 createRunner 现取、已自动隔离，无需迁移旧 cursor）。
  let runtimeNamespace = `${runtimeTenantId()}/${runtimeUserId()}`;
  let watermarks = typeof window !== 'undefined'
    ? localStorageRuntimeBridgeWatermarks(window.localStorage, runtimeNamespace)
    : undefined;
  const pendingDocs = new Set<string>();
  const pendingReasons = new Map<string, string>();
  // 待推文档脏集持久化（localStorage·按命名空间）：挂起期强杀后 pendingDocs 内存即失，
  // 而 reconcile 只看当前打开文档——不回灌的话账本里的 mark 要等用户重开那本书才会被桥接推送（review P0）。
  const dirtyDocsKey = (): string => `inkloop.runtime-sync.dirty-docs::${runtimeNamespace}`;
  const readDirtyDocs = (): string[] => {
    if (typeof window === 'undefined') return [];
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(dirtyDocsKey()) || '[]');
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  };
  const persistDirtyDoc = (documentId: string): void => {
    if (typeof window === 'undefined') return;
    try {
      const current = readDirtyDocs();
      if (current.includes(documentId)) return;
      window.localStorage.setItem(dirtyDocsKey(), JSON.stringify([...current, documentId]));
    } catch { /* 满/隐私模式：脏集只是保险，丢了退回旧行为 */ }
  };
  const clearDirtyDoc = (documentId: string): void => {
    if (typeof window === 'undefined') return;
    try {
      const current = readDirtyDocs();
      const next = current.filter((d) => d !== documentId);
      if (next.length !== current.length) window.localStorage.setItem(dirtyDocsKey(), JSON.stringify(next));
    } catch { /* no-op */ }
  };
  const pendingBootstrapDocs = new Set<string>();
  const bootstrappedDocs = new Set<string>();
  const debounceMs = Math.max(100, options.debounceMs ?? MAGIC_SYNC_DEBOUNCE_MS);
  const pollMs = Math.max(0, options.pollMs ?? MAGIC_SYNC_POLL_MS);
  const reconcileMs = Math.max(0, options.reconcileMs ?? MAGIC_SYNC_RECONCILE_MS);
  const reconcileStaleMs = Math.max(1_000, options.reconcileStaleMs ?? MAGIC_SYNC_RECONCILE_STALE_MS);
  const outboxDrainMs = Math.max(0, options.outboxDrainMs ?? MAGIC_SYNC_OUTBOX_DRAIN_MS);
  let timer: number | null = null;
  let pollTimer: number | null = null;
  let reconcileTimer: number | null = null;
  let outboxDrainTimer: number | null = null;
  let disposed = false;
  let syncQueue: Promise<void> = Promise.resolve();
  let pullInFlight: Promise<void> | null = null;
  let drainInFlight: Promise<void> | null = null;
  const visibleAlignmentChecks = new Map<string, { signature: string; checked_at: number }>();

  const log = (event: string, details?: unknown): void => options.logger?.(event, details);

  function errorMessage(error: unknown): string {
    return String((error as Error)?.message || error || 'unknown error');
  }

  // 最近一次对外发布的状态：静默轮询成功默认不发布（避免刷屏），但若横幅正挂着 failed，
  // 必须发一次 synced 清场——否则服务端瞬断（如 hub 重启）后的单次失败会永远挂在 UI 上。
  let lastPublishedState: RuntimeSyncStatusDetail['state'] | '' = '';

  function publishStatus(detail: Omit<RuntimeSyncStatusDetail, 'at' | 'device_id'>): void {
    const payload: RuntimeSyncStatusDetail = {
      ...detail,
      at: nowIso(),
      device_id: deviceId,
      api_base: apiBase() || (typeof location !== 'undefined' ? location.origin : ''),
    };
    lastPublishedState = payload.state;
    bus.emit('runtime-sync:status', payload);
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('inkloop:runtime-sync-status', { detail: payload }));
    }
  }

  interface OutboxCounts {
    retryable: number;
    dead: number;
  }

  async function outboxCounts(docId?: string): Promise<OutboxCounts> {
    try {
      const events = await store.listPendingEvents(docId);
      return events.reduce<OutboxCounts>((counts, event) => {
        if (isRuntimeDeadLetter(event, maxAttempts)) counts.dead += 1;
        else if (event.status !== 'sent') counts.retryable += 1;
        return counts;
      }, { retryable: 0, dead: 0 });
    } catch {
      return { retryable: 0, dead: 0 };
    }
  }

  async function publishDocStatus(stateName: RuntimeSyncUiState, docId: string, reason: string, extra: Partial<RuntimeSyncStatusDetail> = {}): Promise<void> {
    const counts = await outboxCounts();
    publishStatus({
      state: stateName,
      reason,
      doc_id: docId,
      pending_event_count: counts.retryable,
      dead_letter_count: counts.dead,
      ...extra,
    });
  }

  async function latestOutboxError(docId: string | undefined, eventIds: string[] = []): Promise<string | undefined> {
    try {
      const ids = new Set(eventIds);
      const failed = (await store.listPendingEvents(docId))
        .filter((event) => event.status === 'failed' && (!ids.size || ids.has(event.event_id)))
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
        .map((event) => String(event.last_error || '').trim())
        .filter(Boolean);
      return failed[0];
    } catch {
      return undefined;
    }
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = syncQueue.then(task, task);
    syncQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function publishOutboxStatus(
    counts: OutboxCounts,
    reason: string,
    result?: { sent: number; failed: number; attempted_event_ids: string[] },
    error?: string,
  ): Promise<void> {
    const latestError = error || (result?.failed
      ? await latestOutboxError(undefined, result.attempted_event_ids)
      : counts.dead > 0 ? await latestOutboxError(undefined) : undefined);
    publishStatus({
      state: result?.failed && counts.retryable > 0
        ? 'failed'
        : counts.retryable > 0
          ? 'queued'
          : counts.dead > 0 ? 'dead_letter' : 'synced',
      reason,
      pending_event_count: counts.retryable,
      dead_letter_count: counts.dead,
      pushed: result?.sent,
      error: latestError,
    });
  }

  function drainOutbox(reason: string): Promise<void> {
    if (disposed || syncHeld) return Promise.resolve();
    if (drainInFlight) return drainInFlight;
    const run = enqueue(async () => {
      if (disposed || syncHeld) return;
      const before = await outboxCounts();
      if (before.retryable === 0 && reason !== 'boot-outbox-drain') return;
      if (before.retryable > 0) {
        publishStatus({
          state: 'syncing',
          reason,
          pending_event_count: before.retryable,
          dead_letter_count: before.dead,
        });
      }
      if (disposed || syncHeld) return;
      const result = await createRunner().runOnce();
      await publishOutboxStatus(await outboxCounts(), reason, result);
      log('runtime-sync:outbox-drain', { reason, result });
    }).catch(async (error) => {
      const message = errorMessage(error);
      const counts = await outboxCounts();
      publishStatus({
        state: 'failed',
        reason,
        pending_event_count: counts.retryable,
        dead_letter_count: counts.dead,
        error: message,
      });
      log('runtime-sync:outbox-drain-error', { reason, error: message });
    }).finally(() => {
      drainInFlight = null;
    });
    drainInFlight = run;
    return run;
  }

  function retryDeadLettersOnce(reason = 'manual-dead-letter-retry'): Promise<void> {
    if (disposed || syncHeld) return Promise.resolve();
    return enqueue(async () => {
      if (disposed || syncHeld) return;
      const events = await store.listOutboxEvents();
      const rearmedEvents = rearmDeadLettersOnce(events, maxAttempts, nowIso());
      const updates = rearmedEvents.filter((event, index) => event !== events[index]);
      if (updates.length) {
        if (store.updateOutboxEvents) await store.updateOutboxEvents(updates);
        else await store.writeOutboxEvents(rearmedEvents);
      }
      const before = await outboxCounts();
      if (updates.length) {
        publishStatus({
          state: 'syncing',
          reason,
          pending_event_count: before.retryable,
          dead_letter_count: before.dead,
        });
      }
      if (disposed || syncHeld) return;
      const result = await createRunner().runOnce();
      await publishOutboxStatus(await outboxCounts(), reason, result);
      log('runtime-sync:dead-letters-rearmed', { reason, rearmed: updates.length, result });
    }).catch(async (error) => {
      const message = errorMessage(error);
      const counts = await outboxCounts();
      publishStatus({
        state: 'failed',
        reason,
        pending_event_count: counts.retryable,
        dead_letter_count: counts.dead,
        error: message,
      });
      log('runtime-sync:dead-letter-retry-error', { reason, error: message });
    });
  }

  function shouldAlignVisibleMarks(reason: string): boolean {
    return reason.includes('visible')
      || reason.includes('reconcile')
      || reason === 'document-bootstrap'
      || reason === 'manual-debug'
      || reason === 'online';
  }

  async function applyPulledRemoteDocs(result: { applied_doc_ids?: string[] }, reason: string): Promise<void> {
    const appliedDocIds = [...new Set(result.applied_doc_ids ?? [])];
    if (!appliedDocIds.length) return;
    if (options.onRemoteApplied) {
      await options.onRemoteApplied({ docIds: appliedDocIds, store });
    } else {
      for (const docId of appliedDocIds) await hydrateRuntimeAnnotationsToActiveCanvas(store, docId);
    }
    bus.emit('runtime-sync:remote-applied', { doc_ids: appliedDocIds, reason, result });
  }

  async function syncDocumentNow(documentId: string, reason = 'mark-ledger'): Promise<void> {
    if (disposed) return;
    if (syncHeld) { pendingDocs.add(documentId); pendingReasons.set(documentId, reason); return; } // 硬门：直呼路径也拦，放回 pending 等 release
    const runtimeDocumentId = runtimeDocumentIdForSyncRequest(documentId);
    await publishDocStatus('syncing', runtimeDocumentId, reason);
    const generatedAt = nowIso();
    const runtimeMarks = await loadRuntimeMarks(runtimeDocumentId);
    const canonicalMarkIds = await canonicalRuntimeMarkIdsFromStore(store, runtimeDocumentId);
    const outboundRuntimeMarks = outboundRuntimeMarksForCloudPush(
      runtimeMarks,
      canonicalMarkIds,
    );
    // alignment 只看出站集合：pulled remote mark 若进 alignment，会因本机新 seq 生成新事件形成回环。
    const alignmentRuntimeMarks = visibleRuntimeMarksForCloudAlignment(outboundRuntimeMarks);
    let snapshotPromise: Promise<RuntimeDocumentSnapshot> | null = null;
    const snapshotForSync = (): Promise<RuntimeDocumentSnapshot> => {
      snapshotPromise ||= buildSnapshot(runtimeDocumentId, generatedAt);
      return snapshotPromise;
    };
    const result = await bridgeRuntimeLedgerToStore({
      documentId: runtimeDocumentId,
      documentTitle: await runtimeDocumentTitle(runtimeDocumentId),
      runtimeStore: store,
      watermarkStore: watermarks,
      originDeviceId: deviceId,
      knownMarkIds: canonicalMarkIds,
      loadMarks: async () => outboundRuntimeMarks,
      buildSnapshot: snapshotForSync,
      now: () => generatedAt,
    });
    if (disposed) return;
    if (syncHeld) {
      pendingDocs.add(documentId);
      pendingReasons.set(documentId, reason);
      return;
    }
    const alignment = shouldAlignVisibleMarks(reason)
      ? await requeueVisibleRuntimeMarksForCloudAlignment({
          docId: runtimeDocumentId,
          marks: alignmentRuntimeMarks,
          runtimeStore: store,
          buildEvents: async () => {
            const snapshot = await snapshotForSync();
            return alignmentRuntimeMarks.map((mark) => buildRuntimeSyncEventForMark(snapshot, mark, generatedAt, deviceId));
          },
          now: () => generatedAt,
        })
      : undefined;
    if (disposed) return;
    if (syncHeld) {
      pendingDocs.add(documentId);
      pendingReasons.set(documentId, reason);
      return;
    }
    const sync = await createRunner().syncOnce();
    if (sync.pull) await applyPulledRemoteDocs(sync.pull, reason);
    const counts = await outboxCounts();
    const pushError = sync.push.failed > 0
      ? await latestOutboxError(result.doc_id, sync.push.attempted_event_ids)
      : undefined;
    publishStatus({
      state: sync.push.failed > 0 && counts.retryable > 0
        ? 'failed'
        : counts.retryable > 0 ? 'queued' : counts.dead > 0 ? 'dead_letter' : 'synced',
      reason,
      doc_id: result.doc_id,
      pending_event_count: counts.retryable,
      dead_letter_count: counts.dead,
      pushed: sync.push.sent,
      pulled: sync.pull?.applied,
      error: sync.push.failed > 0 ? pushError || `${sync.push.failed} event(s) failed` : undefined,
    });
    if (alignment && (alignment.created_event_ids.length > 0 || alignment.missing_event_ids.length > 0)) {
      bus.emit('runtime-sync:local-visible-aligned', { reason, alignment });
      log('runtime-sync:local-visible-aligned', { reason, alignment });
    }
    log('runtime-sync:document', { reason, bridge: result, alignment, sync });
    // 同步期间同一文档可能又落了新账；只有没有下一轮 pending 时才能撤掉崩溃保险。
    if (!pendingDocs.has(documentId)) clearDirtyDoc(documentId);
  }

  async function syncDocument(documentId: string, reason = 'mark-ledger'): Promise<void> {
    return enqueue(() => syncDocumentNow(documentId, reason));
  }

  async function flush(reason = 'scheduled'): Promise<void> {
    if (disposed) return;
    if (syncHeld) return; // 硬门：挂起前已排的 debounce/visible flush 也不放行，docs 留在 pendingDocs 等 release
    const docs = [...pendingDocs];
    pendingDocs.clear();
    for (const docId of docs) {
      const docReason = pendingReasons.get(docId) || reason;
      pendingReasons.delete(docId);
      try {
        await syncDocument(docId, docReason);
      } catch (error) {
        pendingDocs.add(docId);
        pendingReasons.set(docId, docReason);
        if (!disposed && !syncHeld && timer === null) {
          timer = window.setTimeout(() => {
            timer = null;
            void flush('sync-retry');
          }, retryDelayMs);
        }
        const message = errorMessage(error);
        const counts = await outboxCounts();
        publishStatus({
          state: 'failed',
          reason,
          doc_id: docId,
          pending_event_count: counts.retryable,
          dead_letter_count: counts.dead,
          error: message,
        });
        log('runtime-sync:error', { reason, doc_id: docId, error: message });
      }
    }
  }

  function schedule(documentId: string, reason = 'mark-ledger'): void {
    if (disposed) return;
    pendingDocs.add(documentId);
    pendingReasons.set(documentId, reason);
    persistDirtyDoc(documentId); // 崩溃保险：成功推完由 syncDocumentNow 清除
    if (syncHeld) return; // 画板挂起：进 pending 集即可，推送等 setRuntimeSyncHeld(false) 统一补
    void publishDocStatus('queued', runtimeDocumentIdForSyncRequest(documentId), reason);
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  async function pullNowInternal(reason: string): Promise<void> {
    if (disposed || syncHeld) return;
    const visibleStatus = reason !== 'poll';
    if (visibleStatus) {
      const counts = await outboxCounts();
      publishStatus({
        state: 'pulling',
        reason,
        pending_event_count: counts.retryable,
        dead_letter_count: counts.dead,
      });
    }
    if (disposed || syncHeld) return;
    try {
      const result = await createRunner().pullOnce();
      await applyPulledRemoteDocs(result, reason);
      const counts = await outboxCounts();
      if (visibleStatus || result.applied > 0) {
        publishStatus({
          state: counts.retryable > 0 ? 'queued' : counts.dead > 0 ? 'dead_letter' : 'synced',
          reason,
          pending_event_count: counts.retryable,
          dead_letter_count: counts.dead,
          pulled: result.applied,
        });
      } else if (lastPublishedState === 'failed' && counts.retryable === 0) {
        // 服务端瞬断（如 hub 重启）的单次失败会把横幅打成 failed；静默轮询恢复且本地无积压时清场，
        // 否则假失败会一直挂到下次显式同步。真有积压/失败事件时不清，交给 flush/reconcile 重试路径。
        publishStatus({
          state: counts.dead > 0 ? 'dead_letter' : 'synced',
          reason,
          pending_event_count: counts.retryable,
          dead_letter_count: counts.dead,
          pulled: result.applied,
        });
      }
      if (result.received > 0 || result.applied > 0 || result.conflicted > 0) log('runtime-sync:pull', { reason, result });
    } catch (error) {
      const message = errorMessage(error);
      const counts = await outboxCounts();
      publishStatus({
        state: 'failed',
        reason,
        pending_event_count: counts.retryable,
        dead_letter_count: counts.dead,
        error: message,
      });
      log('runtime-sync:pull-error', { reason, error: message });
    }
  }

  function pullNow(reason = 'poll'): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pullInFlight) return pullInFlight;
    const run = enqueue(() => pullNowInternal(reason)).finally(() => {
      pullInFlight = null;
    });
    pullInFlight = run;
    return run;
  }

  async function reconcileNow(documentId = state.documentId || '', reason = 'local-visible-reconcile'): Promise<void> {
    if (disposed || syncHeld || !documentId) return;
    try {
      const runtimeDocumentId = runtimeDocumentIdForSyncRequest(documentId);
      const runtimeMarks = await loadRuntimeMarks(runtimeDocumentId);
      const outboundRuntimeMarks = outboundRuntimeMarksForCloudPush(
        runtimeMarks,
        await canonicalRuntimeMarkIdsFromStore(store, runtimeDocumentId),
      );
      const signature = visibleRuntimeMarkSignature(outboundRuntimeMarks);
      const now = Date.now();
      const previous = visibleAlignmentChecks.get(runtimeDocumentId);
      if (previous && previous.signature === signature && now - previous.checked_at < reconcileStaleMs) return;
      visibleAlignmentChecks.set(runtimeDocumentId, { signature, checked_at: now });
      await syncDocument(documentId, reason);
    } catch (error) {
      const message = errorMessage(error);
      const counts = await outboxCounts();
      publishStatus({
        state: 'failed',
        reason,
        doc_id: documentId,
        pending_event_count: counts.retryable,
        dead_letter_count: counts.dead,
        error: message,
      });
      log('runtime-sync:reconcile-error', { reason, document_id: documentId, error: message });
    }
  }

  setRuntimeLedgerAppendHook((mark) => schedule(runtimeDocumentIdForLedgerMark(mark), 'mark-ledger'));
  setAiTurnAppendHook((turn) => schedule(turn.document_id, 'ai-turn-ledger'));
  bus.on('aiturn:appended', (documentId) => {
    if (typeof documentId === 'string' && documentId) schedule(documentId, 'ai-turn-ledger');
  });
  bus.on('document:loaded', () => {
    if (!state.documentId || bootstrappedDocs.has(state.documentId)) return;
    pendingBootstrapDocs.add(state.documentId);
  });
  bus.on('page:rendered', () => {
    const docId = state.documentId;
    if (!docId || !pendingBootstrapDocs.has(docId)) return;
    pendingBootstrapDocs.delete(docId);
    bootstrappedDocs.add(docId);
    schedule(docId, 'document-bootstrap');
    void reconcileNow(docId, 'document-visible-reconcile');
  });
  // 落笔期间跳过周期性同步（500ms pull / 3s reconcile 在书写中造成规律性掉帧·电纸屏 WebView 尤显，
  // codex cx_webview_feel P0）。capture 阶段被动观察 pointer 事件、不侵入 ink.ts；只错峰、不改同步语义——
  // 抬笔/取消/切后台即恢复。按 pointerId 记账：手指 pointerup 不会误清还压着的笔；
  // pen-up 丢失（驱动抖动）由 buttons=0 move / lost capture / hidden / blur 兜底清空。
  const activePenPointers = new Set<number>();
  const penStrokeActiveNow = (): boolean => activePenPointers.size > 0;
  const onHostPenDown = (e: PointerEvent): void => { if (e.pointerType === 'pen') activePenPointers.add(e.pointerId); };
  const onHostPenUp = (e: PointerEvent): void => { activePenPointers.delete(e.pointerId); };
  const onHostPenMove = (e: PointerEvent): void => { if (e.pointerType === 'pen' && e.buttons === 0) activePenPointers.delete(e.pointerId); };
  const onHostPenReset = (): void => { activePenPointers.clear(); };
  const onHostPenVisibilityChange = (): void => { if (document.visibilityState === 'hidden') onHostPenReset(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onHostPenDown, { capture: true, passive: true });
    window.addEventListener('pointerup', onHostPenUp, { capture: true, passive: true });
    window.addEventListener('pointercancel', onHostPenUp, { capture: true, passive: true });
    window.addEventListener('pointermove', onHostPenMove, { capture: true, passive: true });
    window.addEventListener('lostpointercapture', onHostPenUp, { capture: true, passive: true });
    window.addEventListener('blur', onHostPenReset);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onHostPenVisibilityChange);
    }
  }
  if (pollMs > 0 && typeof window !== 'undefined') {
    pollTimer = window.setInterval(() => { if (!penStrokeActiveNow() && !syncHeld) void pullNow(); }, pollMs);
  }
  if (reconcileMs > 0 && typeof window !== 'undefined') {
    reconcileTimer = window.setInterval(() => { if (!penStrokeActiveNow() && !syncHeld) void reconcileNow(); }, reconcileMs);
  }
  if (outboxDrainMs > 0 && typeof window !== 'undefined') {
    outboxDrainTimer = window.setInterval(() => { if (!penStrokeActiveNow() && !syncHeld) void drainOutbox('outbox-retry'); }, outboxDrainMs);
  }
  // 画板挂起解除：把挂起期攒的 pending 文档补推 + 排空 outbox + 拉一轮远端
  const onSyncHeldRelease = (): void => {
    void flush('held-release');
    void drainOutbox('held-release-outbox-drain');
    void pullNow('held-release');
  };
  syncHeldReleases.add(onSyncHeldRelease);
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') return;
    void drainOutbox('visible-outbox-drain');
    void flush('visible');
    void reconcileNow(state.documentId || '', 'visible-reconcile');
    void pullNow('visible');
  };
  const onOnline = (): void => {
    void drainOutbox('online-outbox-drain');
    void flush('online');
    void reconcileNow(state.documentId || '', 'online');
    void pullNow('online');
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  const onDeadLetterRetry = (): void => {
    void retryDeadLettersOnce();
  };
  if (typeof document !== 'undefined') document.addEventListener(RUNTIME_SYNC_RETRY_DEAD_LETTERS_EVENT, onDeadLetterRetry);

  // 身份升级（core session 从 local_user 校准成 feishu_ou_*，见 session-reconcile）→ 重建 watermark 命名空间、
  // 清 bootstrap/对齐缓存，并在新命名空间下重新 pull + 重灌当前文档。cursorKey 每次现取已自动切新桶、旧 cursor 不迁移。
  const authStop = onAuthChange((event) => {
    if (event.kind !== 'login' || disposed || typeof window === 'undefined') return;
    const next = `${runtimeTenantId()}/${runtimeUserId()}`;
    if (next === runtimeNamespace) return;
    runtimeNamespace = next;
    watermarks = localStorageRuntimeBridgeWatermarks(window.localStorage, next);
    visibleAlignmentChecks.clear();
    bootstrappedDocs.clear();
    log('identity-upgrade', { namespace: next });
    if (state.documentId) void syncDocument(state.documentId, 'identity-upgrade');
    void drainOutbox('identity-upgrade-outbox-drain');
    void pullNow('identity-upgrade');
  });

  void drainOutbox('boot-outbox-drain');
  // 挂起期强杀恢复：上次没推完的文档从持久化脏集回灌（此刻未挂起，schedule 正常走 debounce→flush→桥接）
  for (const dirtyDoc of readDirtyDocs()) schedule(dirtyDoc, 'boot-dirty-doc');

  return {
    deviceId,
    store,
    syncDocument,
    pullNow,
    reconcileNow,
    dispose() {
      disposed = true;
      syncHeldReleases.delete(onSyncHeldRelease);
      authStop();
      setRuntimeLedgerAppendHook(null);
      setAiTurnAppendHook(null);
      if (timer !== null) window.clearTimeout(timer);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (reconcileTimer !== null) window.clearInterval(reconcileTimer);
      if (outboxDrainTimer !== null) window.clearInterval(outboxDrainTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHostPenVisibilityChange);
      if (typeof document !== 'undefined') document.removeEventListener(RUNTIME_SYNC_RETRY_DEAD_LETTERS_EVENT, onDeadLetterRetry);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pointerdown', onHostPenDown, { capture: true } as EventListenerOptions);
        window.removeEventListener('pointerup', onHostPenUp, { capture: true } as EventListenerOptions);
        window.removeEventListener('pointercancel', onHostPenUp, { capture: true } as EventListenerOptions);
        window.removeEventListener('pointermove', onHostPenMove, { capture: true } as EventListenerOptions);
        window.removeEventListener('lostpointercapture', onHostPenUp, { capture: true } as EventListenerOptions);
        window.removeEventListener('blur', onHostPenReset);
      }
      activePenPointers.clear();
    },
  };
}
