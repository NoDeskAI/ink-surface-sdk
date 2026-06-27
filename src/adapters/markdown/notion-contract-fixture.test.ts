import { describe, expect, it } from 'vitest';
import { parseDocumentProjection, type DocumentProjection } from '../../knowledge/document-projection';
import { parseExternalEdit, type ExternalEdit } from '../../knowledge/external-edit';

const projection: DocumentProjection = {
  schema_version: 'inkloop.document_projection.v1',
  projection_id: 'dp_notion_contract_v1',
  document_id: 'doc_notion_contract',
  document_title: 'Notion Contract',
  document_uri: 'inkloop://doc/doc_notion_contract',
  revision_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  generated_at: '2026-06-26T10:00:00.000Z',
  source: { app: 'inkloop' },
  privacy: 'export_allowed',
  export_policy: { include_full_text: true, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
  blocks: [
    {
      block_id: 'blk_notion_contract',
      kind: 'paragraph',
      text_md: 'This projection can map to a Notion block without a filesystem path.',
      region: 'editable',
      knowledge_object_ids: [],
    },
  ],
  body_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  content_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  created_at: '2026-06-26T10:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
};

const edit: ExternalEdit = {
  schema_version: 'inkloop.external_edit.v1',
  edit_id: 'edit_notion_contract_001',
  document_id: 'doc_notion_contract',
  projection_id: 'dp_notion_contract_v1',
  block_id: 'blk_notion_contract',
  adapter: {
    adapter_id: 'notion',
    target_id: 'notion_workspace',
    remote_id: 'notion_page_123',
    remote_revision: 'notion_block_rev_1',
  },
  kind: 'document_body',
  operation: 'update',
  status: 'pending',
  payload: {
    before_md: 'Before',
    after_md: 'After',
  },
  observed_at: '2026-06-26T10:05:00.000Z',
  created_at: '2026-06-26T10:05:00.000Z',
  updated_at: '2026-06-26T10:05:00.000Z',
  content_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
};

describe('adapter-neutral document projection contract', () => {
  it('validates Notion-shaped projection and edit records without filesystem paths', () => {
    expect(parseDocumentProjection(projection).projection_id).toBe('dp_notion_contract_v1');
    expect(parseExternalEdit(edit).adapter.remote_id).toBe('notion_page_123');
    expect(parseExternalEdit(edit).adapter.remote_path).toBeUndefined();
  });
});
