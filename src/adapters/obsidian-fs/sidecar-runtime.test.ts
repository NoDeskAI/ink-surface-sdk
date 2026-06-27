import { describe, expect, it } from 'vitest';
import type { DocumentProjection } from '../../knowledge/document-projection';
import { markdownProjectionChunks } from './sidecar-runtime';

function projection(): DocumentProjection {
  return {
    schema_version: 'inkloop.document_projection.v1',
    projection_id: 'dp_sidecar_runtime',
    document_id: 'doc_sidecar_runtime',
    document_title: 'Runtime Projection',
    document_uri: 'inkloop://document/doc_sidecar_runtime',
    revision_id: 'rev_sidecar_runtime',
    generated_at: '2026-06-27T00:00:00.000Z',
    source: { app: 'inkloop' },
    privacy: 'export_allowed',
    export_policy: {
      include_full_text: true,
      include_pdf_asset: false,
      include_raw_strokes: false,
      include_debug_evidence: false,
    },
    blocks: [
      {
        block_id: 'blk_first',
        kind: 'paragraph',
        text_md: 'First paragraph.',
        region: 'editable',
        knowledge_object_ids: [],
      },
      {
        block_id: 'blk_second',
        kind: 'paragraph',
        text_md: 'Second paragraph.',
        region: 'editable',
        knowledge_object_ids: [],
      },
    ],
    body_hash: 'sha256:body',
    content_hash: 'sha256:content',
    created_at: '2026-06-27T00:00:00.000Z',
    updated_at: '2026-06-27T00:00:00.000Z',
  };
}

describe('markdownProjectionChunks', () => {
  it('does not shift a later block into a deleted earlier block', () => {
    const chunks = markdownProjectionChunks('# Runtime Projection\n\nSecond paragraph.\n', projection());

    expect(chunks).toEqual(['First paragraph.', 'Second paragraph.']);
  });
});
