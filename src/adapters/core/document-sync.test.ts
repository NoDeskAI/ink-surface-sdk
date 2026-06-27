import { describe, expect, it } from 'vitest';
import type { ExternalEdit } from '../../knowledge/external-edit';
import { MemoryAdapterStorage } from './memory-storage';
import { externalEditStorageKey, isPendingDocumentEdit } from './document-sync';

const edit: ExternalEdit = {
  schema_version: 'inkloop.external_edit.v1',
  edit_id: 'edit_doc_sync_001',
  document_id: 'doc_sync',
  projection_id: 'dp_doc_sync_v1',
  block_id: 'blk_p001_para',
  adapter: {
    adapter_id: 'obsidian-fs',
    remote_path: 'InkLoop/Doc.md',
  },
  kind: 'document_body',
  operation: 'update',
  status: 'pending',
  payload: {
    before_md: 'before',
    after_md: 'after',
  },
  observed_at: '2026-06-26T09:00:00.000Z',
  created_at: '2026-06-26T09:00:00.000Z',
  updated_at: '2026-06-26T09:00:00.000Z',
  content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('document sync storage helpers', () => {
  it('stores external edits idempotently by edit id', async () => {
    const storage = new MemoryAdapterStorage();
    await storage.upsertExternalEdit(edit);
    await storage.upsertExternalEdit({ ...edit, status: 'accepted' });

    expect(externalEditStorageKey(edit)).toBe(edit.edit_id);
    expect(await storage.listExternalEdits({ document_id: 'doc_sync' })).toHaveLength(1);
    expect((await storage.listExternalEdits({ edit_id: edit.edit_id }))[0].status).toBe('accepted');
  });

  it('identifies pending document body edits', () => {
    expect(isPendingDocumentEdit(edit)).toBe(true);
    expect(isPendingDocumentEdit({ ...edit, status: 'conflict' })).toBe(false);
  });
});
