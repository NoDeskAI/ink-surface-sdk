import { describe, expect, it } from 'vitest';
import type { ConflictRecord } from '../core/types';
import type { DocumentProjection } from '../../knowledge/document-projection';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { buildExportPreview } from './export-preview';

const projection: DocumentProjection = {
  schema_version: 'inkloop.document_projection.v1',
  projection_id: 'dp_preview_v1',
  document_id: 'doc_preview',
  document_title: 'Preview',
  document_uri: 'inkloop://doc/doc_preview',
  revision_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  generated_at: '2026-06-26T10:00:00.000Z',
  source: { app: 'inkloop' },
  privacy: 'export_allowed',
  export_policy: { include_full_text: true, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
  blocks: [
    { block_id: 'blk_1', kind: 'paragraph', text_md: '正文一', region: 'editable', knowledge_object_ids: [] },
    { block_id: 'blk_2', kind: 'paragraph', text_md: '正文二', region: 'editable', knowledge_object_ids: [] },
  ],
  body_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  content_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  created_at: '2026-06-26T10:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
};

const object: KnowledgeObject = {
  schema_version: 'inkloop.knowledge_object.v1',
  ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9PREVW1',
  kind: 'ai_note',
  title: 'Preview note',
  body_md: 'Note body',
  source: { document_id: 'doc_preview', document_title: 'Preview', object_refs: [], inkloop_uri: 'inkloop://doc/doc_preview' },
  provenance: { created_from: 'manual' },
  tags: ['inkloop'],
  status: 'export_ready',
  privacy: 'export_allowed',
  content_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  created_at: '2026-06-26T10:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
};

const conflict: ConflictRecord = {
  conflict_id: 'conflict_preview',
  provider: 'obsidian_fs',
  target_id: 'target_preview',
  ko_id: 'dp_preview_v1',
  code: 'controlled_section_modified',
  severity: 'medium',
  resolution_status: 'open',
  detail: 'Generated block changed.',
  created_at: '2026-06-26T10:00:00.000Z',
  updated_at: '2026-06-26T10:00:00.000Z',
};

describe('buildExportPreview', () => {
  it('summarizes document full-text scope, KO counts, privacy blocks, and open conflicts', () => {
    const preview = buildExportPreview({
      projections: [projection, { ...projection, projection_id: 'dp_local_v1', privacy: 'local_only' }],
      knowledgeObjects: [object, { ...object, ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9LOCAL1', privacy: 'local_only' }],
      target: { provider: 'obsidian_fs', target_id: 'target_preview', vault_root: '/vault', base_dir: 'InkLoop' },
      conflicts: [conflict, { ...conflict, conflict_id: 'conflict_resolved', resolution_status: 'resolved' }],
    });

    expect(preview).toMatchObject({
      document_count: 2,
      full_text_document_count: 2,
      document_block_count: 4,
      exported_text_chars: 12,
      knowledge_object_count: 2,
      exportable_knowledge_object_count: 1,
      local_only_count: 2,
      requires_full_text_gate: true,
      conflict_count: 1,
      pending_conflict_ids: ['conflict_preview'],
    });
    expect(preview.privacy_blocked.map((item) => item.id)).toEqual(['dp_local_v1', 'ko_01JZ7D5E7WJK4F5NTAT9LOCAL1']);
  });
});
