import { describe, expect, it } from 'vitest';
import type { DocumentProjection } from '../knowledge/document-projection';
import type { KnowledgeObject } from '../knowledge/knowledge-object';
import { DocumentProjectionBuilder } from './document-projection-builder';
import type { DocumentProjectionBuilderStorePort, InkLoopDoc, InkLoopDocumentPage, KnowledgeQuery } from './types';

class ProjectionFixtureStore implements DocumentProjectionBuilderStorePort {
  projections: DocumentProjection[] = [];

  constructor(
    private readonly docs: InkLoopDoc[],
    private readonly pages: Record<string, InkLoopDocumentPage[]>,
    private readonly objects: KnowledgeObject[] = [],
  ) {}

  async getDoc(documentId: string): Promise<InkLoopDoc | null> {
    return this.docs.find((doc) => doc.document_id === documentId) ?? null;
  }

  async listDocs(): Promise<InkLoopDoc[]> {
    return this.docs;
  }

  async getDocumentProjectionPages(documentId: string): Promise<InkLoopDocumentPage[]> {
    return this.pages[documentId] ?? [];
  }

  async listKnowledgeObjects(query: KnowledgeQuery): Promise<KnowledgeObject[]> {
    return this.objects.filter((object) => !query.document_id || object.source.document_id === query.document_id);
  }

  async upsertDocumentProjection(projection: DocumentProjection): Promise<void> {
    this.projections = this.projections.filter((item) => item.projection_id !== projection.projection_id).concat(projection);
  }
}

const doc: InkLoopDoc = { document_id: 'doc_builder_projection', filename: 'Builder 投影文档', page_count: 2 };

const linkedObject: KnowledgeObject = {
  schema_version: 'inkloop.knowledge_object.v1',
  ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9LINK01',
  kind: 'ai_note',
  title: '关联旁注',
  body_md: '这条旁注应当挂到正文 block。',
  source: {
    document_id: doc.document_id,
    document_title: doc.filename ?? '',
    page_index: 0,
    object_refs: ['run_2'],
    anchor_bbox: [0.1, 0.2, 0.5, 0.04],
    inkloop_uri: `inkloop://doc/${doc.document_id}/page/0?anchor=run_2`,
  },
  provenance: { created_from: 'ai_turn', ai_turn_ids: ['turn_linked'] },
  tags: ['inkloop', 'inkloop/ai-note'],
  status: 'export_ready',
  privacy: 'export_allowed',
  content_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  created_at: '2026-06-26T08:35:00.000Z',
  updated_at: '2026-06-26T08:35:00.000Z',
};

describe('DocumentProjectionBuilder', () => {
  it('builds a stable document projection from reflow blocks and links KOs to anchors', async () => {
    const pages: InkLoopDocumentPage[] = [
      {
        page_id: 'pg_builder_0',
        page_index: 0,
        reflow_engine: 'local',
        status: 'reflowed',
        reflow: [
          {
            id: 'rfl_title',
            type: 'heading',
            level: 1,
            text: '第一章',
            source: [0.1, 0.1, 0.4, 0.04],
            sourceRunIds: ['run_1'],
          },
          {
            id: 'rfl_para',
            type: 'para',
            level: 0,
            text: '这一段包含一个被 InkLoop 标注的概念。',
            source: [0.1, 0.2, 0.5, 0.04],
            sourceRunIds: ['run_2'],
          },
        ],
      },
    ];
    const store = new ProjectionFixtureStore([doc], { [doc.document_id]: pages }, [linkedObject]);
    const builder = new DocumentProjectionBuilder(store);

    const first = await builder.build({ document_id: doc.document_id, now: '2026-06-26T08:35:00.000Z', app_version: '0.1.0' });
    const second = await builder.build({ document_id: doc.document_id, now: '2026-06-26T09:00:00.000Z', app_version: '0.1.0' });

    expect(first.projections).toHaveLength(1);
    expect(store.projections).toHaveLength(1);
    const projection = first.projections[0];
    expect(projection.projection_id).toBe('dp_doc_builder_projection_v1');
    expect(projection.document_uri).toBe('inkloop://doc/doc_builder_projection');
    expect(projection.blocks.map((block) => block.block_id)).toEqual(['blk_p001_rfl_title', 'blk_p001_rfl_para']);
    expect(projection.blocks[1].knowledge_object_ids).toEqual([linkedObject.ko_id]);
    expect(projection.blocks[1].region).toBe('editable');
    expect(first.warnings).toEqual([]);
    expect(second.projections[0].body_hash).toBe(projection.body_hash);
    expect(second.projections[0].content_hash).toBe(projection.content_hash);
  });

  it('falls back to generated page placeholders when no text cache exists', async () => {
    const store = new ProjectionFixtureStore([doc], {});
    const builder = new DocumentProjectionBuilder(store);

    const result = await builder.build({ document_id: doc.document_id, now: '2026-06-26T08:35:00.000Z' });

    expect(result.projections).toHaveLength(1);
    expect(result.projections[0].blocks).toHaveLength(2);
    expect(result.projections[0].blocks[0]).toMatchObject({
      block_id: 'blk_p001_placeholder',
      kind: 'unknown',
      region: 'generated',
      source: { page_index: 0 },
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['missing_page_text', 'missing_page_text']);
  });

  it('skips missing documents and local-only full text exports', async () => {
    const store = new ProjectionFixtureStore([doc], {});
    const builder = new DocumentProjectionBuilder(store);

    await expect(builder.build({ document_id: 'missing_doc' })).resolves.toMatchObject({
      projections: [],
      skipped: [{ reason: 'missing_source', source_id: 'missing_doc' }],
    });

    await expect(builder.build({ document_id: doc.document_id, privacy: 'local_only', include_full_text: true })).resolves.toMatchObject({
      projections: [],
      skipped: [{ reason: 'privacy_local_only', source_id: doc.document_id }],
    });
  });
});
