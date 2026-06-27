import { sha256Tagged } from '../../knowledge/hash';
import type { DocumentProjection, DocumentProjectionBlock } from '../../knowledge/document-projection';
import type { ExternalEdit } from '../../knowledge/external-edit';
import type { KnowledgeObject, Sha256 } from '../../knowledge/knowledge-object';
import { OBSIDIAN_MAPPING_VERSION } from './controlled-section';
import { renderFrontmatterObject } from './frontmatter';

export interface RenderedDocumentBlock {
  block_id: string;
  markdown: string;
  render_hash: Sha256;
}

export interface RenderedDocumentProjectionMarkdown {
  projection_id: string;
  markdown: string;
  frontmatter: string;
  rendered_blocks: RenderedDocumentBlock[];
}

function attrs(input: Record<string, string | number | undefined>): string {
  return Object.entries(input)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function bboxAttr(bbox: [number, number, number, number] | undefined): string | undefined {
  return bbox?.map((value) => Number(value).toFixed(4).replace(/0+$/g, '').replace(/\.$/, '')).join(',');
}

function encodeCommentJson(input: unknown): string {
  return encodeURIComponent(JSON.stringify(input));
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageHeading(pageIndex: number): string {
  return `## Page ${pageIndex + 1}`;
}

export function renderProjectionBlockContent(block: DocumentProjectionBlock): string {
  if (block.kind === 'heading') {
    const level = Math.min(6, Math.max(1, block.heading_level ?? 2));
    return `${'#'.repeat(level)} ${block.text_md.trim()}`;
  }
  return block.text_md.trimEnd();
}

async function renderProjectionBlock(block: DocumentProjectionBlock): Promise<RenderedDocumentBlock> {
  const markdown = renderProjectionBlockContent(block);
  return {
    block_id: block.block_id,
    markdown,
    render_hash: await sha256Tagged(markdown.trim()),
  };
}

function renderKnowledgeLinks(input: {
  block: DocumentProjectionBlock;
  knowledgeObjectsById: Map<string, KnowledgeObject>;
}): string {
  const objects = input.block.knowledge_object_ids
    .map((id) => input.knowledgeObjectsById.get(id))
    .filter((object): object is KnowledgeObject => !!object);
  if (!objects.length) return '';

  const metadata = objects.map((object) => `<!-- inkloop:annotation-json ${encodeCommentJson({
      ko_id: object.ko_id,
      kind: object.kind,
      title: object.title,
      body_md: object.body_md,
      status: object.status,
      anchor_bbox: object.source.anchor_bbox,
      page_index: object.source.page_index,
    })} -->`);
  const items = objects.map((object) => `<li>${escapeHtml(object.title)}</li>`);
  return [
    `<!-- inkloop:annotations-begin block=${input.block.block_id} mapping=${OBSIDIAN_MAPPING_VERSION} -->`,
    `<div class="inkloop-annotation-fallback" data-inkloop-block="${escapeHtml(input.block.block_id)}">`,
    ...metadata,
    '<strong>InkLoop annotations</strong>',
    '<ul>',
    ...items,
    '</ul>',
    '</div>',
    `<!-- inkloop:annotations-end block=${input.block.block_id} -->`,
  ].join('\n');
}

function frontmatterForDocumentProjection(projection: DocumentProjection): string {
  return renderFrontmatterObject({
    inkloop_projection_id: projection.projection_id,
    inkloop_schema: projection.schema_version,
    inkloop_document_id: projection.document_id,
    inkloop_revision_id: projection.revision_id,
    inkloop_body_hash: projection.body_hash,
    inkloop_content_hash: projection.content_hash,
    inkloop_uri: projection.document_uri,
    document_title: projection.document_title,
    created: projection.created_at,
    updated: projection.updated_at,
    tags: ['inkloop', 'inkloop/source'],
  });
}

export async function renderDocumentProjectionMarkdown(input: {
  projection: DocumentProjection;
  knowledgeObjects?: KnowledgeObject[];
}): Promise<RenderedDocumentProjectionMarkdown> {
  const knowledgeObjectsById = new Map((input.knowledgeObjects ?? []).map((object) => [object.ko_id, object]));
  const renderedBlocks: RenderedDocumentBlock[] = [];
  const body: string[] = [
    `# ${input.projection.document_title}`,
    '',
    `<!-- inkloop:document-uri ${input.projection.document_uri} -->`,
    '',
    `<!-- inkloop:document-begin projection=${input.projection.projection_id} body_hash=${input.projection.body_hash} mapping=${OBSIDIAN_MAPPING_VERSION} -->`,
  ];

  let lastPageIndex: number | undefined;
  for (const block of input.projection.blocks) {
    const pageIndex = block.source?.page_index;
    if (pageIndex !== undefined && pageIndex !== lastPageIndex) {
      body.push('', `<!-- inkloop:page id=${block.source?.page_id ?? ''} index=${pageIndex} -->`, '', pageHeading(pageIndex), '');
      lastPageIndex = pageIndex;
    }

    const rendered = await renderProjectionBlock(block);
    renderedBlocks.push(rendered);
    body.push(
      `<!-- inkloop:block-begin ${attrs({
        id: block.block_id,
        hash: rendered.render_hash,
        region: block.region,
        page: pageIndex,
        bbox: bboxAttr(block.source?.anchor_bbox),
        kind: block.kind,
        mapping: OBSIDIAN_MAPPING_VERSION,
      })} -->`,
      '',
      rendered.markdown,
      '',
      `<!-- inkloop:block-end id=${block.block_id} -->`,
    );

    const annotations = renderKnowledgeLinks({ block, knowledgeObjectsById });
    if (annotations) body.push('', annotations);
  }

  body.push('', `<!-- inkloop:document-end projection=${input.projection.projection_id} -->`, '', '## My notes', '');

  const frontmatter = frontmatterForDocumentProjection(input.projection);
  return {
    projection_id: input.projection.projection_id,
    frontmatter,
    rendered_blocks: renderedBlocks,
    markdown: [frontmatter.trimEnd(), '', ...body].join('\n'),
  };
}

export function externalEditAdapterPayload(input: {
  remotePath?: string;
  remoteRevision?: string;
}): ExternalEdit['adapter'] {
  return {
    adapter_id: 'obsidian-fs',
    remote_path: input.remotePath,
    remote_revision: input.remoteRevision,
  };
}
