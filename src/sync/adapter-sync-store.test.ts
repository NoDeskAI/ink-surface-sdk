import { describe, expect, it } from 'vitest';
import type { ConflictRecord } from '../adapters/core/types';
import type { DocumentProjection } from '../knowledge/document-projection';
import type { ExternalEdit } from '../knowledge/external-edit';
import { MemoryAdapterSyncStore, syncCursorId } from './adapter-sync-store';
import { externalEditToOutboxItem } from './sync-outbox';

const projection: DocumentProjection = {
  schema_version: 'inkloop.document_projection.v1',
  projection_id: 'dp_sync_doc_v1',
  document_id: 'doc_sync',
  document_title: 'Sync Doc',
  document_uri: 'inkloop://doc/doc_sync',
  revision_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  generated_at: '2026-06-26T10:00:00.000Z',
  source: { app: 'inkloop' },
  privacy: 'export_allowed',
  export_policy: { include_full_text: true, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
  blocks: [{ block_id: 'blk_sync', kind: 'paragraph', text_md: 'Body', region: 'editable', knowledge_object_ids: [] }],
  body_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  content_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  created_at: '2026-06-26T10:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
};

const edit: ExternalEdit = {
  schema_version: 'inkloop.external_edit.v1',
  edit_id: 'edit_sync_doc_001',
  document_id: 'doc_sync',
  projection_id: 'dp_sync_doc_v1',
  block_id: 'blk_sync',
  adapter: { adapter_id: 'obsidian-fs', remote_path: 'InkLoop/Sync Doc.md' },
  kind: 'document_body',
  operation: 'update',
  status: 'pending',
  payload: { before_md: 'Body', after_md: 'Edited body' },
  observed_at: '2026-06-26T10:05:00.000Z',
  created_at: '2026-06-26T10:05:00.000Z',
  updated_at: '2026-06-26T10:05:00.000Z',
  content_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
};

const conflict: ConflictRecord = {
  conflict_id: 'conflict_sync_doc_001',
  provider: 'obsidian_fs',
  target_id: 'target_sync',
  ko_id: 'dp_sync_doc_v1',
  code: 'controlled_section_modified',
  severity: 'medium',
  remote_path: 'InkLoop/Sync Doc.md',
  local_content_hash: projection.content_hash,
  resolution_status: 'open',
  resolution_strategy: 'append_new_version',
  detail: 'Generated block changed.',
  created_at: '2026-06-26T10:05:00.000Z',
  updated_at: '2026-06-26T10:05:00.000Z',
};

describe('adapter sync store', () => {
  it('persists projections, external edits, conflicts, cursors, and outbox items', async () => {
    const store = new MemoryAdapterSyncStore();
    await store.upsertDocumentProjection(projection);
    await store.upsertExternalEdit(edit);
    await store.upsertConflict(conflict);
    await store.upsertCursor({
      cursor_id: syncCursorId({ provider: 'obsidian_fs', target_id: 'target_sync', document_id: 'doc_sync' }),
      provider: 'obsidian_fs',
      target_id: 'target_sync',
      document_id: 'doc_sync',
      last_pulled_at: '2026-06-26T10:05:00.000Z',
      updated_at: '2026-06-26T10:05:00.000Z',
    });

    expect(await store.listDocumentProjections({ document_id: 'doc_sync' })).toEqual([projection]);
    expect(await store.listExternalEdits({ projection_id: 'dp_sync_doc_v1', status: 'pending' })).toEqual([edit]);
    expect(await store.listConflicts({ ko_id: 'dp_sync_doc_v1', resolution_status: 'open' })).toEqual([conflict]);
    expect(await store.listCursors({ document_id: 'doc_sync' })).toHaveLength(1);
    expect(externalEditToOutboxItem(edit)).toMatchObject({
      outbox_id: 'outbox_edit_sync_doc_001',
      kind: 'external_edit',
      status: 'pending',
      document_id: 'doc_sync',
      payload: edit,
    });
  });
});
