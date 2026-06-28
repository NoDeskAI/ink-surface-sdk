import { describe, expect, it } from 'vitest';
import {
  OFFLINE_STORE_SCHEMA_VERSION,
  resolveOfflineOpenState,
  selectEvictableDocuments,
  type OfflineDocumentCacheRecord,
} from './index';

const SUPPORTED_RUNTIME = 'inkloop.runtime_sync_event.v1';

function record(input: Partial<OfflineDocumentCacheRecord> = {}): OfflineDocumentCacheRecord {
  return {
    schema_version: OFFLINE_STORE_SCHEMA_VERSION,
    doc_id: 'doc_offline',
    runtime_schema_version: SUPPORTED_RUNTIME,
    metadata_cached: true,
    surface_cached: true,
    assets: [],
    ...input,
  };
}

describe('offline store contract', () => {
  it('opens a fully cached document without network', () => {
    expect(resolveOfflineOpenState(record(), SUPPORTED_RUNTIME)).toMatchObject({
      state: 'ready',
      can_read: true,
      can_mutate: true,
      missing_assets: [],
    });
  });

  it('keeps the app usable when a cached document is missing a large asset', () => {
    const result = resolveOfflineOpenState(record({
      assets: [{ asset_id: 'pdf_page_1', kind: 'page_image', cache_state: 'missing', required_for_open: true }],
    }), SUPPORTED_RUNTIME);

    expect(result).toMatchObject({
      state: 'partial',
      can_read: true,
      can_mutate: true,
    });
    expect(result.missing_assets).toHaveLength(1);
  });

  it('blocks opening when the surface itself is not cached', () => {
    expect(resolveOfflineOpenState(record({ surface_cached: false }), SUPPORTED_RUNTIME)).toMatchObject({
      state: 'download_required',
      can_read: false,
      can_mutate: false,
    });
  });

  it('requires migration before applying mutations for newer cached schemas', () => {
    expect(resolveOfflineOpenState(record({ runtime_schema_version: 'future.runtime.v9' }), SUPPORTED_RUNTIME)).toMatchObject({
      state: 'migration_required',
      can_read: false,
      can_mutate: false,
    });
  });

  it('never selects pinned documents or documents with pending mutations for eviction', () => {
    expect(selectEvictableDocuments([
      { doc_id: 'pinned', pinned: true, size_bytes: 100, last_accessed_at: '2026-06-27T00:00:00.000Z' },
      { doc_id: 'pending', pending_event_count: 1, size_bytes: 100, last_accessed_at: '2026-06-27T00:00:00.000Z' },
      { doc_id: 'old', size_bytes: 100, last_accessed_at: '2026-06-26T00:00:00.000Z' },
      { doc_id: 'new', size_bytes: 200, last_accessed_at: '2026-06-28T00:00:00.000Z' },
    ]).map((candidate) => candidate.doc_id)).toEqual(['old', 'new']);
  });
});
