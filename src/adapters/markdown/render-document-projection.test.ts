import { describe, expect, it } from 'vitest';
import type { DocumentProjection } from '../../knowledge/document-projection';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { appendInkLoopAnnotation, updateInkLoopAnnotation } from '../../inkloop-surface-sdk';
import { parseDocumentExternalEdits } from './parse-document-edits';
import { renderDocumentProjectionMarkdown } from './render-document-projection';

const projection: DocumentProjection = {
  schema_version: 'inkloop.document_projection.v1',
  projection_id: 'dp_doc_render_v1',
  document_id: 'doc_render',
  document_title: '渲染测试文档',
  document_uri: 'inkloop://doc/doc_render',
  revision_id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  generated_at: '2026-06-26T08:35:00.000Z',
  source: { app: 'inkloop', app_version: '0.1.0' },
  privacy: 'export_allowed',
  export_policy: {
    include_full_text: true,
    include_pdf_asset: false,
    include_raw_strokes: false,
    include_debug_evidence: false,
  },
  blocks: [
    {
      block_id: 'blk_p001_title',
      kind: 'heading',
      heading_level: 1,
      text_md: '第一章',
      region: 'generated',
      source: { page_id: 'pg_render_0', page_index: 0, object_refs: ['run_1'] },
      knowledge_object_ids: [],
    },
    {
      block_id: 'blk_p001_para',
      kind: 'paragraph',
      text_md: '这一段可以在 Obsidian 里修改。',
      region: 'editable',
      source: { page_id: 'pg_render_0', page_index: 0, object_refs: ['run_2'], anchor_bbox: [0.12, 0.22, 0.72, 0.08] },
      knowledge_object_ids: ['ko_01JZ7D5E7WJK4F5NTAT9RENDER'],
    },
  ],
  body_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  content_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  created_at: '2026-06-26T08:35:00.000Z',
  updated_at: '2026-06-26T08:35:00.000Z',
};

const ko: KnowledgeObject = {
  schema_version: 'inkloop.knowledge_object.v1',
  ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9RENDER',
  kind: 'ai_note',
  title: '段落旁注',
  body_md: '这个概念需要回看。',
  source: {
    document_id: 'doc_render',
    document_title: '渲染测试文档',
    page_index: 0,
    object_refs: ['run_2'],
    inkloop_uri: 'inkloop://doc/doc_render/page/0?anchor=run_2',
  },
  provenance: { created_from: 'ai_turn', ai_turn_ids: ['turn_render'] },
  tags: ['inkloop'],
  status: 'export_ready',
  privacy: 'export_allowed',
  content_hash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  created_at: '2026-06-26T08:35:00.000Z',
  updated_at: '2026-06-26T08:35:00.000Z',
};

describe('DocumentProjection Markdown rendering and edit parsing', () => {
  it('renders a source document with projection frontmatter, page markers, block markers, and generated KO links', async () => {
    const rendered = await renderDocumentProjectionMarkdown({ projection, knowledgeObjects: [ko] });

    expect(rendered.markdown).toContain('inkloop_projection_id: "dp_doc_render_v1"');
    expect(rendered.markdown).toContain('# 渲染测试文档');
    expect(rendered.markdown).toContain('<!-- inkloop:page id=pg_render_0 index=0 -->');
    expect(rendered.markdown).toContain('<!-- inkloop:block-begin id=blk_p001_para');
    expect(rendered.markdown).toContain('bbox=');
    expect(rendered.markdown).toContain('这一段可以在 Obsidian 里修改。');
    expect(rendered.markdown).toContain('<!-- inkloop:annotations-begin block=blk_p001_para');
    expect(rendered.markdown).toContain('<!-- inkloop:annotation-json ');
    expect(rendered.markdown).toContain('<li>段落旁注</li>');
    expect(rendered.rendered_blocks.map((block) => block.block_id)).toEqual(['blk_p001_title', 'blk_p001_para']);
  });

  it('parses editable block changes as ExternalEdit records', async () => {
    const rendered = await renderDocumentProjectionMarkdown({ projection, knowledgeObjects: [ko] });
    const edited = rendered.markdown.replace('这一段可以在 Obsidian 里修改。', '这一段已经被 Obsidian 用户修改。');

    const parsed = await parseDocumentExternalEdits({
      markdown: edited,
      projection,
      observed_at: '2026-06-26T09:00:00.000Z',
      remote_path: 'InkLoop/渲染测试文档.md',
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.external_edits).toHaveLength(1);
    expect(parsed.external_edits[0]).toMatchObject({
      document_id: 'doc_render',
      projection_id: 'dp_doc_render_v1',
      block_id: 'blk_p001_para',
      kind: 'document_body',
      operation: 'update',
      status: 'pending',
      payload: {
        before_md: '这一段可以在 Obsidian 里修改。',
        after_md: '这一段已经被 Obsidian 用户修改。',
      },
    });
    expect(parsed.external_edits[0].content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('parses source annotation metadata changes as user_note ExternalEdit records', async () => {
    const rendered = await renderDocumentProjectionMarkdown({ projection, knowledgeObjects: [ko] });
    const edited = updateInkLoopAnnotation(rendered.markdown, ko.ko_id, {
      title: '用户改过的旁注',
      body_md: '这条旁注是在 Obsidian/Web 预览里改的。',
    });

    const parsed = await parseDocumentExternalEdits({
      markdown: edited,
      projection,
      knowledgeObjects: [ko],
      observed_at: '2026-06-26T09:00:00.000Z',
      remote_path: 'InkLoop/渲染测试文档.md',
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.external_edits).toHaveLength(1);
    expect(parsed.external_edits[0]).toMatchObject({
      document_id: 'doc_render',
      projection_id: 'dp_doc_render_v1',
      ko_id: ko.ko_id,
      kind: 'user_note',
      operation: 'update',
      status: 'pending',
      payload: {
        before: {
          kind: 'ai_note',
          title: '段落旁注',
          body_md: '这个概念需要回看。',
          status: 'export_ready',
        },
        after: {
          kind: 'ai_note',
          title: '用户改过的旁注',
          body_md: '这条旁注是在 Obsidian/Web 预览里改的。',
          status: 'export_ready',
        },
        source: 'source_annotation_json',
      },
    });
    expect(parsed.external_edits[0].content_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('parses newly drawn source annotations as user_note create ExternalEdit records', async () => {
    const rendered = await renderDocumentProjectionMarkdown({ projection, knowledgeObjects: [ko] });
    const edited = appendInkLoopAnnotation(rendered.markdown, 'blk_p001_para', {
      ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9DRAWA1',
      kind: 'annotation',
      title: '新画的框选',
      body_md: '从 Mark 模式新增。',
      status: 'edited',
      visual_strokes: [{ tool: 'pen', points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.2 }] }],
    });

    const parsed = await parseDocumentExternalEdits({
      markdown: edited,
      projection,
      knowledgeObjects: [ko],
      observed_at: '2026-06-26T09:00:00.000Z',
      remote_path: 'InkLoop/渲染测试文档.md',
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.external_edits).toHaveLength(1);
    expect(parsed.external_edits[0]).toMatchObject({
      document_id: 'doc_render',
      projection_id: 'dp_doc_render_v1',
      ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9DRAWA1',
      kind: 'user_note',
      operation: 'create',
      status: 'pending',
      payload: {
        after: {
          kind: 'annotation',
          title: '新画的框选',
          body_md: '从 Mark 模式新增。',
          status: 'edited',
        },
        source: 'source_annotation_json',
      },
    });
  });

  it('reports generated block modifications as warnings instead of external edits', async () => {
    const rendered = await renderDocumentProjectionMarkdown({ projection });
    const edited = rendered.markdown.replace('# 第一章', '# 第一章（用户改过）');

    const parsed = await parseDocumentExternalEdits({
      markdown: edited,
      projection,
      observed_at: '2026-06-26T09:00:00.000Z',
    });

    expect(parsed.external_edits).toEqual([]);
    expect(parsed.warnings).toEqual([
      {
        code: 'generated_block_modified',
        block_id: 'blk_p001_title',
        detail: 'Generated block was modified externally.',
      },
    ]);
  });
});
