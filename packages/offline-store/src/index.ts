import type {
  RuntimeConflictRecord,
  RuntimeDocumentSnapshot,
  RuntimeStorePort,
  RuntimeSyncEvent,
} from '../../runtime-schema/src/index.js';

export const OFFLINE_STORE_SCHEMA_VERSION = 'inksurface.offline_store.v1' as const;

export type OfflineAssetKind =
  | 'source_pdf'
  | 'page_image'
  | 'ocr_text'
  | 'thumbnail'
  | 'embedding'
  | 'other';

export type OfflineAssetCacheState = 'cached' | 'missing' | 'stale' | 'fetching';

export interface OfflineAssetRef {
  asset_id: string;
  kind: OfflineAssetKind;
  cache_state: OfflineAssetCacheState;
  required_for_open?: boolean;
  size_bytes?: number;
  updated_at?: string;
}

export interface OfflineDocumentCacheRecord {
  schema_version: typeof OFFLINE_STORE_SCHEMA_VERSION;
  doc_id: string;
  runtime_schema_version: string;
  metadata_cached: boolean;
  surface_cached: boolean;
  pinned?: boolean;
  recent?: boolean;
  pending_event_count?: number;
  assets?: OfflineAssetRef[];
  last_accessed_at?: string;
  updated_at?: string;
}

export type OfflineDocumentOpenState =
  | 'ready'
  | 'partial'
  | 'download_required'
  | 'migration_required';

export interface OfflineDocumentOpenResult {
  state: OfflineDocumentOpenState;
  can_read: boolean;
  can_mutate: boolean;
  missing_assets: OfflineAssetRef[];
  reason?: string;
}

export interface OfflineEvictionCandidate {
  doc_id: string;
  size_bytes?: number;
  pinned?: boolean;
  pending_event_count?: number;
  last_accessed_at?: string;
}

export interface OfflineDeviceCursor {
  device_id: string;
  cursor: string;
  updated_at: string;
}

export interface OfflineRemoteEventApplyResult {
  event_id: string;
  status: 'applied' | 'skipped' | 'conflicted';
  conflict?: RuntimeConflictRecord;
}

export interface OfflineRuntimeStorePort extends RuntimeStorePort {
  updateOutboxEvents?(updates: RuntimeSyncEvent[]): Promise<void>;
  writeDocumentSnapshot(snapshot: RuntimeDocumentSnapshot): Promise<void>;
  getCacheRecord(docId: string): Promise<OfflineDocumentCacheRecord | null>;
  writeCacheRecord(record: OfflineDocumentCacheRecord): Promise<void>;
  listPendingEvents(docId?: string): Promise<RuntimeSyncEvent[]>;
  listAppliedEventIds(docId?: string): Promise<string[]>;
  applyRemoteEvent(event: RuntimeSyncEvent): Promise<OfflineRemoteEventApplyResult>;
  getDeviceCursor(deviceId: string): Promise<OfflineDeviceCursor | null>;
  writeDeviceCursor(cursor: OfflineDeviceCursor): Promise<void>;
  listConflicts(docId?: string): Promise<RuntimeConflictRecord[]>;
  recordConflict(conflict: RuntimeConflictRecord): Promise<void>;
}

export function resolveOfflineOpenState(
  record: OfflineDocumentCacheRecord | null,
  supportedRuntimeSchemaVersion: string,
): OfflineDocumentOpenResult {
  if (!record) {
    return {
      state: 'download_required',
      can_read: false,
      can_mutate: false,
      missing_assets: [],
      reason: 'document is not cached locally',
    };
  }

  if (record.runtime_schema_version !== supportedRuntimeSchemaVersion) {
    return {
      state: 'migration_required',
      can_read: false,
      can_mutate: false,
      missing_assets: [],
      reason: `cached runtime schema ${record.runtime_schema_version} is not supported by ${supportedRuntimeSchemaVersion}`,
    };
  }

  if (!record.metadata_cached || !record.surface_cached) {
    return {
      state: 'download_required',
      can_read: false,
      can_mutate: false,
      missing_assets: record.assets?.filter((asset) => asset.cache_state === 'missing') ?? [],
      reason: 'document metadata or surface model is not cached',
    };
  }

  const missingAssets = (record.assets ?? []).filter((asset) => asset.cache_state === 'missing' || asset.cache_state === 'stale');
  const missingRequiredAssets = missingAssets.filter((asset) => asset.required_for_open);
  if (missingRequiredAssets.length > 0) {
    return {
      state: 'partial',
      can_read: true,
      can_mutate: true,
      missing_assets: missingRequiredAssets,
      reason: 'document surface is cached but one or more required assets are unavailable',
    };
  }

  return {
    state: missingAssets.length > 0 ? 'partial' : 'ready',
    can_read: true,
    can_mutate: true,
    missing_assets: missingAssets,
    reason: missingAssets.length > 0 ? 'document surface is cached with optional assets missing' : undefined,
  };
}

export function selectEvictableDocuments(candidates: OfflineEvictionCandidate[]): OfflineEvictionCandidate[] {
  return candidates
    .filter((candidate) => !candidate.pinned && (candidate.pending_event_count ?? 0) === 0)
    .sort((a, b) => {
      const timeCompare = String(a.last_accessed_at ?? '').localeCompare(String(b.last_accessed_at ?? ''));
      if (timeCompare !== 0) return timeCompare;
      return (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
    });
}

export { IndexedDbOfflineRuntimeStore } from './indexeddb-store.js';
export type { IndexedDbOfflineRuntimeStoreConfig } from './indexeddb-store.js';
