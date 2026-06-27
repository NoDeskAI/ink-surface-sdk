import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { DocumentProjection, DocumentProjectionBlock } from '../../knowledge/document-projection';
import { sha256Tagged } from '../../knowledge/hash';
import type { KnowledgeObject, Sha256 } from '../../knowledge/knowledge-object';
import { atomicWriteJson, appendJsonLine, ensureDir, readJsonIfExists } from './fs-writer';
import type { ObsidianFsTarget } from './config';
import { fromVaultRelative } from './target';
import { renderProjectionBlockContent, type RenderedDocumentBlock } from '../markdown';

export interface NativeDocumentBlock extends RenderedDocumentBlock {
  kind: DocumentProjectionBlock['kind'];
  region: DocumentProjectionBlock['region'];
  markdown: string;
  plain_text: string;
  heading_level?: number;
  page_index?: number;
  page_id?: string;
  anchor_bbox?: [number, number, number, number];
  object_refs: string[];
  knowledge_object_ids: string[];
  range: {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
  };
}

export interface NativeDocumentProjectionMarkdown {
  projection_id: string;
  markdown: string;
  rendered_blocks: NativeDocumentBlock[];
}

interface SidecarPathIndex {
  schema_version: 'inkloop.path_index.v1';
  updated_at: string;
  items: Record<string, {
    path: string;
    doc_id: string;
    source_ref_id: string;
    last_seen_content_hash?: Sha256;
    last_seen_at: string;
  }>;
}

interface SidecarDocIndex {
  schema_version: 'inkloop.doc_index.v1';
  updated_at: string;
  items: Record<string, {
    doc_id: string;
    title: string;
    source_type: 'markdown' | 'pdf' | 'image' | 'scan' | 'epub' | 'ink_canvas' | 'obsidian_canvas';
    source_ref_id: string;
    current_path?: string;
    updated_at: string;
  }>;
}

function normalizeMarkdownText(input: string): string {
  return input
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function remoteProjectionBlockText(blockMarkdown: string, blockKind: DocumentProjectionBlock['kind']): string {
  const normalized = blockMarkdown.trim().replace(/\r\n/g, '\n');
  if (blockKind === 'heading') return normalized.replace(/^#{1,6}\s+/, '');
  return normalized;
}

export function markdownProjectionChunks(markdown: string, projection: DocumentProjection): string[] {
  const rawChunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const value = current.join('\n').trim();
    if (value) rawChunks.push(value);
    current = [];
  };

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line) && current.length) flush();
    current.push(line);
  }
  flush();

  const firstBlock = projection.blocks[0];
  const shouldSkipDocTitle = firstBlock?.kind !== 'heading'
    || remoteProjectionBlockText(renderProjectionBlockContent(firstBlock), 'heading') !== projection.document_title;

  const chunks = rawChunks.filter((chunk, index) => {
    const title = remoteProjectionBlockText(chunk, 'heading');
    if (shouldSkipDocTitle && index === 0 && title === projection.document_title) return false;
    if (/^#{1,6}\s+Page\s+\d+\s*$/i.test(chunk)) return false;
    return true;
  });

  const matchesBlock = (chunk: string, block: DocumentProjectionBlock): boolean =>
    normalizeMarkdownText(chunk) === normalizeMarkdownText(renderProjectionBlockContent(block));

  if (chunks.length < projection.blocks.length) {
    const aligned: string[] = [];
    let chunkIndex = 0;
    for (const [blockIndex, block] of projection.blocks.entries()) {
      const chunk = chunks[chunkIndex];
      if (!chunk) {
        aligned.push(renderProjectionBlockContent(block));
        continue;
      }
      if (matchesBlock(chunk, block)) {
        aligned.push(chunk);
        chunkIndex += 1;
        continue;
      }
      const belongsToLaterBlock = projection.blocks.slice(blockIndex + 1).some((laterBlock) => matchesBlock(chunk, laterBlock));
      if (belongsToLaterBlock) {
        aligned.push(renderProjectionBlockContent(block));
        continue;
      }
      aligned.push(chunk);
      chunkIndex += 1;
    }
    return aligned;
  }

  if (chunks.length === projection.blocks.length) return chunks;

  const aligned: string[] = [];
  let chunkIndex = 0;
  for (const [blockIndex, block] of projection.blocks.entries()) {
    if (chunkIndex >= chunks.length) break;
    let chunk = chunks[chunkIndex++];

    while (chunkIndex < chunks.length) {
      const nextBlock = projection.blocks[blockIndex + 1];
      if (nextBlock && matchesBlock(chunks[chunkIndex] ?? '', nextBlock)) break;

      // A note inserted below a heading should attach to the following body block,
      // not mutate the heading text itself.
      if (block.kind === 'heading' && nextBlock) break;

      chunk = `${chunk}\n\n${chunks[chunkIndex++]}`;
    }

    aligned.push(chunk);
  }

  return aligned;
}

function markdownExtension(remotePath: string): string {
  return path.extname(remotePath).toLowerCase() || '.md';
}

function sourceRefId(documentId: string): string {
  return `src_${documentId.replace(/^doc_/, '')}`;
}

function blockQuote(markdown: string): string {
  return normalizeMarkdownText(markdown).slice(0, 20_000);
}

function contextHash(block: DocumentProjectionBlock, index: number, blocks: readonly DocumentProjectionBlock[]): string {
  const before = blocks[index - 1]?.text_md ?? '';
  const after = blocks[index + 1]?.text_md ?? '';
  return `${normalizeMarkdownText(before)}\n${normalizeMarkdownText(block.text_md)}\n${normalizeMarkdownText(after)}`;
}

async function nativeBlock(input: {
  block: DocumentProjectionBlock;
  markdown: string;
  range: NativeDocumentBlock['range'];
  index: number;
  blocks: readonly DocumentProjectionBlock[];
}): Promise<NativeDocumentBlock> {
  return {
    block_id: input.block.block_id,
    kind: input.block.kind,
    region: input.block.region,
    markdown: input.markdown,
    plain_text: normalizeMarkdownText(input.markdown),
    heading_level: input.block.heading_level,
    page_index: input.block.source?.page_index,
    page_id: input.block.source?.page_id,
    anchor_bbox: input.block.source?.anchor_bbox,
    object_refs: input.block.source?.object_refs ?? [],
    knowledge_object_ids: input.block.knowledge_object_ids,
    range: input.range,
    render_hash: await sha256Tagged(input.markdown.trim()),
  };
}

function shouldRenderDocumentTitle(projection: DocumentProjection): boolean {
  const first = projection.blocks[0];
  if (!first || first.kind !== 'heading') return true;
  return normalizeMarkdownText(first.text_md) !== normalizeMarkdownText(projection.document_title);
}

export async function renderNativeDocumentProjectionMarkdown(input: {
  projection: DocumentProjection;
}): Promise<NativeDocumentProjectionMarkdown> {
  const lines: string[] = [];
  const renderedBlocks: NativeDocumentBlock[] = [];
  const pushBlank = () => {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  };
  const pushLine = (line: string) => {
    lines.push(line);
  };

  if (shouldRenderDocumentTitle(input.projection)) {
    pushLine(`# ${input.projection.document_title}`);
    pushBlank();
  }

  for (const [index, block] of input.projection.blocks.entries()) {
    const markdown = renderProjectionBlockContent(block);
    const blockLines = markdown.split('\n');
    const startLine = lines.length + 1;
    for (const line of blockLines) pushLine(line);
    const endLine = lines.length;
    renderedBlocks.push(await nativeBlock({
      block,
      markdown,
      range: {
        start_line: startLine,
        start_col: 0,
        end_line: endLine,
        end_col: blockLines[blockLines.length - 1]?.length ?? 0,
      },
      index,
      blocks: input.projection.blocks,
    }));
    pushBlank();
  }

  return {
    projection_id: input.projection.projection_id,
    rendered_blocks: renderedBlocks,
    markdown: `${lines.join('\n').trimEnd()}\n`,
  };
}

function annotationFromKnowledgeObject(object: KnowledgeObject): Record<string, unknown> {
  return {
    ko_id: object.ko_id,
    kind: object.kind,
    title: object.title,
    body_md: object.body_md,
    status: object.status,
    anchor_bbox: object.source.anchor_bbox,
    page_index: object.source.page_index,
    object_refs: object.source.object_refs,
    inkloop_uri: object.source.inkloop_uri,
  };
}

function docDir(target: ObsidianFsTarget, docId: string): string {
  return fromVaultRelative(target.vault_root, `${target.base_dir}/docs/${docId}`);
}

async function updatePathIndex(input: {
  target: ObsidianFsTarget;
  remotePath: string;
  projection: DocumentProjection;
  sourceRefId: string;
  contentHash: Sha256;
  now: string;
}): Promise<void> {
  const indexPath = fromVaultRelative(input.target.vault_root, `${input.target.base_dir}/indexes/path-index.json`);
  const index = await readJsonIfExists<SidecarPathIndex>(indexPath, {
    schema_version: 'inkloop.path_index.v1',
    updated_at: input.now,
    items: {},
  });
  index.updated_at = input.now;
  index.items[input.remotePath] = {
    path: input.remotePath,
    doc_id: input.projection.document_id,
    source_ref_id: input.sourceRefId,
    last_seen_content_hash: input.contentHash,
    last_seen_at: input.now,
  };
  await atomicWriteJson(indexPath, index);
}

async function updateDocIndex(input: {
  target: ObsidianFsTarget;
  remotePath: string;
  projection: DocumentProjection;
  sourceRefId: string;
  now: string;
}): Promise<void> {
  const indexPath = fromVaultRelative(input.target.vault_root, `${input.target.base_dir}/indexes/doc-index.json`);
  const index = await readJsonIfExists<SidecarDocIndex>(indexPath, {
    schema_version: 'inkloop.doc_index.v1',
    updated_at: input.now,
    items: {},
  });
  index.updated_at = input.now;
  index.items[input.projection.document_id] = {
    doc_id: input.projection.document_id,
    title: input.projection.document_title,
    source_type: 'markdown',
    source_ref_id: input.sourceRefId,
    current_path: input.remotePath,
    updated_at: input.now,
  };
  await atomicWriteJson(indexPath, index);
}

export async function writeDocumentProjectionSidecar(input: {
  target: ObsidianFsTarget;
  projection: DocumentProjection;
  remotePath: string;
  native: NativeDocumentProjectionMarkdown;
  knowledgeObjects?: KnowledgeObject[];
  now?: string;
}): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  const basePath = fromVaultRelative(input.target.vault_root, input.target.base_dir);
  const sourceId = sourceRefId(input.projection.document_id);
  const sourceHash = await sha256Tagged(input.native.markdown);
  const root = docDir(input.target, input.projection.document_id);
  const knowledgeObjects = (input.knowledgeObjects ?? []).filter((object) => object.source.document_id === input.projection.document_id);
  const knowledgeById = new Map(knowledgeObjects.map((object) => [object.ko_id, object]));

  await Promise.all([
    ensureDir(path.join(basePath, 'indexes')),
    ensureDir(path.join(root, 'surfaces')),
    ensureDir(path.join(root, 'canvas')),
    ensureDir(path.join(root, 'marks')),
    ensureDir(path.join(root, 'overlays')),
    ensureDir(path.join(root, 'knowledge')),
    ensureDir(path.join(root, 'assets')),
  ]);

  const manifestPath = path.join(basePath, 'manifest.json');
  const manifest = await readJsonIfExists<Record<string, unknown>>(manifestPath, {});
  await atomicWriteJson(manifestPath, {
    schema_version: 'inkloop.vault_manifest.v1',
    vault_id: input.target.vault_name_or_id ?? input.target.target_id,
    created_at: typeof manifest.created_at === 'string' ? manifest.created_at : now,
    updated_at: now,
    sidecar_location: 'vault_hidden',
    plugin_version: '0.1.0',
    inkloop_runtime_version: 'sidecar-runtime.v1',
    indexes: {},
  });

  await updatePathIndex({ target: input.target, remotePath: input.remotePath, projection: input.projection, sourceRefId: sourceId, contentHash: sourceHash, now });
  await updateDocIndex({ target: input.target, remotePath: input.remotePath, projection: input.projection, sourceRefId: sourceId, now });

  await atomicWriteJson(path.join(root, 'document.json'), {
    schema_version: 'inkloop.document.v1',
    doc_id: input.projection.document_id,
    title: input.projection.document_title,
    source_type: 'markdown',
    source_ref_id: sourceId,
    created_at: input.projection.created_at,
    updated_at: now,
    default_view: 'preview',
    capabilities: {
      native_text_editable: true,
      paginated: input.projection.blocks.some((block) => block.source?.page_index !== undefined),
      infinite_canvas: true,
      supports_handwriting: true,
      supports_ai_overlay: true,
    },
  });

  await atomicWriteJson(path.join(root, 'source.json'), {
    schema_version: 'inkloop.source_ref.v1',
    source_ref_id: sourceId,
    doc_id: input.projection.document_id,
    kind: 'obsidian_vault_file',
    vault_file: {
      vault_id: input.target.vault_name_or_id ?? input.target.target_id,
      path: input.remotePath,
      extension: markdownExtension(input.remotePath),
    },
    identity: {
      original_path: input.remotePath,
      current_path: input.remotePath,
      initial_content_hash: sourceHash,
      current_content_hash: sourceHash,
      size: Buffer.byteLength(input.native.markdown, 'utf8'),
      fingerprint: sourceHash,
    },
    status: 'active',
  });

  await appendJsonLine(path.join(root, 'revisions.jsonl'), {
    schema_version: 'inkloop.source_revision.v1',
    rev_id: input.projection.revision_id,
    doc_id: input.projection.document_id,
    source_ref_id: sourceId,
    content_hash: sourceHash,
    created_at: now,
    parser: { adapter: 'markdown', version: 'sidecar-runtime.v1' },
    surface_manifest_hash: input.projection.content_hash,
  });

  await atomicWriteJson(path.join(root, 'surfaces/surface-manifest.json'), {
    schema_version: 'inkloop.surface_manifest.v1',
    doc_id: input.projection.document_id,
    source_revision_id: input.projection.revision_id,
    source_type: 'markdown',
    object_count: input.native.rendered_blocks.length,
    blocks_path: 'surfaces/markdown.blocks.jsonl',
    updated_at: now,
  });

  const surfaceLines = [];
  for (const [index, block] of input.native.rendered_blocks.entries()) {
    const projectionBlock = input.projection.blocks.find((candidate) => candidate.block_id === block.block_id);
    const annotations = block.knowledge_object_ids
      .map((id) => knowledgeById.get(id))
      .filter((object): object is KnowledgeObject => !!object)
      .map(annotationFromKnowledgeObject);
    surfaceLines.push(JSON.stringify({
      schema_version: 'inkloop.surface_object.v1',
      object_id: block.block_id,
      doc_id: input.projection.document_id,
      source_revision_id: input.projection.revision_id,
      kind: 'md_block',
      text: block.plain_text,
      source_anchor: {
        type: 'markdown',
        file_path: input.remotePath,
        block_id: block.block_id,
        heading_path: [],
        range: block.range,
        quote: blockQuote(block.markdown),
        context_before: projectionBlock ? normalizeMarkdownText(input.projection.blocks[index - 1]?.text_md ?? '') : undefined,
        context_after: projectionBlock ? normalizeMarkdownText(input.projection.blocks[index + 1]?.text_md ?? '') : undefined,
      },
      reading_order: index,
      fingerprint: {
        text_hash: await sha256Tagged(block.plain_text),
        context_hash: await sha256Tagged(projectionBlock ? contextHash(projectionBlock, index, input.projection.blocks) : block.plain_text),
      },
      projection: {
        block_id: block.block_id,
        kind: block.kind,
        heading_level: block.heading_level,
        region: block.region,
        page_id: block.page_id,
        page_index: block.page_index,
        anchor_bbox: block.anchor_bbox,
        object_refs: block.object_refs,
        knowledge_object_ids: block.knowledge_object_ids,
        render_hash: block.render_hash,
      },
      annotations,
    }));
  }
  await atomicWriteJson(path.join(root, 'surfaces/markdown.lines.json'), {
    schema_version: 'inkloop.markdown_lines.v1',
    doc_id: input.projection.document_id,
    source_revision_id: input.projection.revision_id,
    lines: input.native.markdown.split('\n').map((text, index) => ({ line: index + 1, text })),
  });
  await writeFile(path.join(root, 'surfaces/markdown.blocks.jsonl'), `${surfaceLines.join('\n')}\n`, 'utf8');

  await atomicWriteJson(path.join(root, 'canvas/canvas.json'), {
    schema_version: 'inkloop.canvas.v1',
    doc_id: input.projection.document_id,
    canvas_id: `canvas_${input.projection.document_id.replace(/^doc_/, '')}`,
    coordinate_space: { unit: 'world_px', origin: 'top_left', scale_base: 1 },
    mode_defaults: { preview_layout: 'source_first', edit_layout: 'free_canvas' },
    layers: [
      { layer_id: 'layer_source', kind: 'source_render', visible: true, locked: true, z_index: 0 },
      { layer_id: 'layer_ink', kind: 'ink', visible: true, locked: false, z_index: 10 },
      { layer_id: 'layer_typed_text', kind: 'typed_text', visible: true, locked: false, z_index: 20 },
      { layer_id: 'layer_ai_overlay', kind: 'ai_overlay', visible: true, locked: false, z_index: 30 },
    ],
    updated_at: now,
  });

  await atomicWriteJson(path.join(root, 'knowledge/ko-index.json'), {
    schema_version: 'inkloop.ko_index.v1',
    doc_id: input.projection.document_id,
    ko_ids: knowledgeObjects.map((object) => object.ko_id),
    updated_at: now,
  });
  for (const object of knowledgeObjects) {
    await atomicWriteJson(path.join(root, `knowledge/${object.ko_id}.json`), object);
  }
}
