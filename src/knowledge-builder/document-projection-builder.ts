import { pageIdFor } from '../core/ids';
import type { NormBBox } from '../core/contracts';
import {
  computeDocumentProjectionBodyHash,
  computeDocumentProjectionHash,
  type DocumentProjection,
  type DocumentProjectionBlock,
  type DocumentProjectionWithoutHash,
} from '../knowledge/document-projection';
import type { KnowledgeObject, Privacy } from '../knowledge/knowledge-object';
import { buildInkloopDocUri } from '../knowledge/uri';
import { documentDisplayTitle } from './document-title';
import type {
  BuildDocumentProjectionsInput,
  BuildDocumentProjectionsResult,
  DocumentProjectionBuilderStorePort,
  InkLoopDoc,
  InkLoopDocumentBlock,
  InkLoopDocumentPage,
} from './types';

function stableToken(input: string): string {
  const safe = input.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  if (safe) return safe.slice(0, 80);

  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function documentProjectionIdFor(documentId: string): string {
  return `dp_${stableToken(documentId)}_v1`;
}

function projectionBlockIdFor(pageIndex: number, block: Pick<InkLoopDocumentBlock, 'id' | 'text'>, fallbackIndex: number): string {
  const sourceId = block.id || `${fallbackIndex}_${block.text}`;
  return `blk_p${String(pageIndex + 1).padStart(3, '0')}_${stableToken(sourceId)}`;
}

function mapBlockKind(block: InkLoopDocumentBlock): DocumentProjectionBlock['kind'] {
  switch (block.type) {
    case 'heading':
      return 'heading';
    case 'para':
      return 'paragraph';
    case 'list':
      return 'list';
    default:
      return 'unknown';
  }
}

function renderBlockMarkdown(block: InkLoopDocumentBlock): string {
  if (block.type !== 'list' || !block.items?.length) return block.text;
  return block.items.map((item, index) => (block.ordered ? `${index + 1}. ${item}` : `- ${item}`)).join('\n');
}

function overlap(a: NormBBox | undefined, b: NormBBox | undefined): number {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / (Math.min(a[2] * a[3], b[2] * b[3]) || 1);
}

function knowledgeObjectsForBlock(input: {
  knowledgeObjects: KnowledgeObject[];
  pageIndex: number;
  block: InkLoopDocumentBlock;
}): string[] {
  const refs = new Set(input.block.sourceRunIds ?? []);
  return input.knowledgeObjects
    .filter((object) => {
      if (object.source.page_index !== undefined && object.source.page_index !== input.pageIndex) return false;
      if (object.source.object_refs.some((ref) => refs.has(ref))) return true;
      return overlap(object.source.anchor_bbox, input.block.source) > 0.15;
    })
    .map((object) => object.ko_id)
    .sort();
}

function fallbackPages(doc: InkLoopDoc): InkLoopDocumentPage[] {
  const count = Math.max(1, doc.page_count ?? 1);
  return Array.from({ length: count }, (_, pageIndex) => ({
    page_id: pageIdFor(doc.document_id, pageIndex),
    page_index: pageIndex,
    reflow: null,
    status: 'pending',
  }));
}

function titleFor(doc: InkLoopDoc): string {
  return documentDisplayTitle(doc);
}

export class DocumentProjectionBuilder {
  constructor(private readonly store: DocumentProjectionBuilderStorePort) {}

  async build(input: BuildDocumentProjectionsInput = {}): Promise<BuildDocumentProjectionsResult> {
    const now = input.now ?? new Date().toISOString();
    const privacy: Privacy = input.privacy ?? 'export_allowed';
    const includeFullText = input.include_full_text ?? true;
    const docs = input.document_id ? [await this.store.getDoc(input.document_id)] : await this.store.listDocs();
    const result: BuildDocumentProjectionsResult = { projections: [], skipped: [], warnings: [] };

    for (const doc of docs) {
      if (!doc) {
        result.skipped.push({ reason: 'missing_source', source_id: input.document_id ?? 'unknown' });
        continue;
      }
      if (privacy === 'local_only' && includeFullText) {
        result.skipped.push({ reason: 'privacy_local_only', source_id: doc.document_id, detail: 'full text export requested for local-only document' });
        continue;
      }

      const pages = await this.pagesFor(doc, input.reflow_engine);
      const knowledgeObjects = await this.store.listKnowledgeObjects?.({ document_id: doc.document_id, privacy: ['export_allowed'] }) ?? [];
      const blocks = this.blocksFor({ doc, pages, knowledgeObjects, result });
      if (!blocks.length) {
        result.skipped.push({ reason: 'empty_document', source_id: doc.document_id });
        continue;
      }

      const bodyHash = await computeDocumentProjectionBodyHash(blocks);
      const projectionWithoutHash: DocumentProjectionWithoutHash = {
        schema_version: 'inkloop.document_projection.v1',
        projection_id: documentProjectionIdFor(doc.document_id),
        document_id: doc.document_id,
        document_title: titleFor(doc),
        document_uri: buildInkloopDocUri(doc.document_id),
        revision_id: bodyHash,
        generated_at: now,
        source: {
          app: 'inkloop',
          app_version: input.app_version,
        },
        privacy,
        export_policy: {
          include_full_text: includeFullText,
          include_pdf_asset: false,
          include_raw_strokes: false,
          include_debug_evidence: false,
        },
        blocks,
        body_hash: bodyHash,
        created_at: now,
        updated_at: now,
      };
      const projection: DocumentProjection = { ...projectionWithoutHash, content_hash: await computeDocumentProjectionHash(projectionWithoutHash) };
      result.projections.push(projection);
      await this.store.upsertDocumentProjection?.(projection);
    }

    return result;
  }

  private async pagesFor(doc: InkLoopDoc, reflowEngine: string | undefined): Promise<InkLoopDocumentPage[]> {
    const pages = await this.store.getDocumentProjectionPages(doc.document_id, { reflow_engine: reflowEngine });
    if (pages.length > 0) return [...pages].sort((a, b) => a.page_index - b.page_index);
    return fallbackPages(doc);
  }

  private blocksFor(input: {
    doc: InkLoopDoc;
    pages: InkLoopDocumentPage[];
    knowledgeObjects: KnowledgeObject[];
    result: BuildDocumentProjectionsResult;
  }): DocumentProjectionBlock[] {
    const blocks: DocumentProjectionBlock[] = [];
    for (const page of input.pages) {
      const pageId = page.page_id ?? pageIdFor(input.doc.document_id, page.page_index);
      if (!page.reflow?.length) {
        input.result.warnings.push({
          code: 'missing_page_text',
          detail: `No reflow/text cache for page ${page.page_index + 1}; emitting placeholder block.`,
          page_index: page.page_index,
        });
        blocks.push({
          block_id: `blk_p${String(page.page_index + 1).padStart(3, '0')}_placeholder`,
          kind: 'unknown',
          text_md: `（第 ${page.page_index + 1} 页暂无可导出的文本层）`,
          region: 'generated',
          source: { page_id: pageId, page_index: page.page_index, object_refs: [] },
          knowledge_object_ids: [],
        });
        continue;
      }

      for (const [index, block] of page.reflow.entries()) {
        if (block.anchorUnsafe) {
          input.result.warnings.push({
            code: 'anchor_unstable',
            detail: `Page ${page.page_index + 1} block ${block.id} has unstable anchors.`,
            page_index: page.page_index,
          });
        }
        blocks.push({
          block_id: projectionBlockIdFor(page.page_index, block, index),
          kind: mapBlockKind(block),
          heading_level: block.type === 'heading' ? Math.min(6, Math.max(1, block.level ?? 1)) : undefined,
          text_md: renderBlockMarkdown(block),
          region: block.anchorUnsafe ? 'generated' : 'editable',
          source: {
            page_id: pageId,
            page_index: page.page_index,
            object_refs: block.sourceRunIds ?? [],
            anchor_bbox: block.source,
          },
          knowledge_object_ids: knowledgeObjectsForBlock({
            knowledgeObjects: input.knowledgeObjects,
            pageIndex: page.page_index,
            block,
          }),
        });
      }
    }
    return blocks;
  }
}
