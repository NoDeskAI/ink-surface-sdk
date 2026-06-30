import { computeExternalEditHash, type ExternalEdit, type ExternalEditWithoutHash } from '../../knowledge/external-edit';
import type { DocumentProjection } from '../../knowledge/document-projection';
import { sha256Hex } from '../../knowledge/hash';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { renderProjectionBlockContent } from './render-document-projection';

interface ParsedBlockSection {
  block_id: string;
  attrs: Record<string, string>;
  body: string;
  start: number;
  end: number;
}

interface ParsedAnnotationJson extends Pick<KnowledgeObject, 'ko_id' | 'kind' | 'title' | 'body_md' | 'status'> {
  render_mode?: 'stroke_only' | 'margin_note';
  visual_bbox?: [number, number, number, number];
  visual_strokes?: unknown[];
  capture_surface?: unknown;
  surface_coord_space?: unknown;
  surface_bbox?: unknown;
  surface_strokes?: unknown[];
}

export interface ParsedDocumentExternalEdits {
  external_edits: ExternalEdit[];
  warnings: Array<{
    code: 'missing_block' | 'duplicate_block' | 'generated_block_modified';
    block_id: string;
    detail: string;
  }>;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.trim().split(/\s+/)) {
    const [key, value] = part.split('=');
    if (key && value) out[key] = value;
  }
  return out;
}

export function findDocumentBlockSections(markdown: string): ParsedBlockSection[] {
  const sections: ParsedBlockSection[] = [];
  const beginPattern = /<!--\s*inkloop:block-begin\s+([^>]+?)\s*-->/g;
  for (let match = beginPattern.exec(markdown); match; match = beginPattern.exec(markdown)) {
    const parsed = parseAttrs(match[1]);
    const blockId = parsed.id;
    if (!blockId) continue;
    const endPattern = new RegExp(`<!--\\s*inkloop:block-end\\s+id=${blockId}\\s*-->`, 'g');
    endPattern.lastIndex = beginPattern.lastIndex;
    const endMatch = endPattern.exec(markdown);
    if (!endMatch) continue;

    const bodyStart = match.index + match[0].length;
    sections.push({
      block_id: blockId,
      attrs: parsed,
      body: markdown.slice(bodyStart, endMatch.index),
      start: match.index,
      end: endMatch.index + endMatch[0].length,
    });
  }
  return sections;
}

function normalizeBlockBody(input: string): string {
  return input.trim().replace(/\r\n/g, '\n');
}

async function editIdFor(input: { projectionId: string; blockId: string; before: string; after: string }): Promise<string> {
  const fingerprint = await sha256Hex(`${input.before}\n---inkloop-edit---\n${input.after}`);
  return `edit_${input.projectionId}_${input.blockId}_${fingerprint.slice(0, 20)}`;
}

async function koEditIdFor(input: { projectionId: string; koId: string; payload: unknown }): Promise<string> {
  const fingerprint = await sha256Hex(JSON.stringify(input.payload));
  return `edit_${input.projectionId}_${input.koId}_${fingerprint.slice(0, 20)}`;
}

function parseAnnotationJson(markdown: string): ParsedAnnotationJson[] {
  const annotations: ParsedAnnotationJson[] = [];
  for (const match of markdown.matchAll(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g)) {
    try {
      const parsed = JSON.parse(decodeURIComponent(match[1].trim())) as ParsedAnnotationJson;
      if (parsed.ko_id) annotations.push(parsed);
    } catch {
      // Malformed visual metadata is ignored here; block-level parsing still reports structural warnings.
    }
  }
  return annotations;
}

async function parseAnnotationExternalEdits(input: {
  markdown: string;
  projection: DocumentProjection;
  knowledgeObjects?: KnowledgeObject[];
  observed_at: string;
  remote_path?: string;
  remote_revision?: string;
}): Promise<ExternalEdit[]> {
  if (!input.knowledgeObjects?.length) return [];
  const objectsById = new Map(
    input.knowledgeObjects
      .filter((object) => object.source.document_id === input.projection.document_id)
      .map((object) => [object.ko_id, object]),
  );
  const edits: ExternalEdit[] = [];
  for (const annotation of parseAnnotationJson(input.markdown)) {
    const original = objectsById.get(annotation.ko_id);
    if (!original) {
      const after = {
        kind: annotation.kind ?? 'annotation',
        title: annotation.title ?? 'Untitled annotation',
        body_md: annotation.body_md ?? '',
        status: annotation.status ?? 'edited',
        render_mode: annotation.render_mode,
        visual_bbox: annotation.visual_bbox,
        visual_strokes: annotation.visual_strokes,
        capture_surface: annotation.capture_surface,
        surface_coord_space: annotation.surface_coord_space,
        surface_bbox: annotation.surface_bbox,
        surface_strokes: annotation.surface_strokes,
      };
      const withoutHash: ExternalEditWithoutHash = {
        schema_version: 'inkloop.external_edit.v1',
        edit_id: await koEditIdFor({ projectionId: input.projection.projection_id, koId: annotation.ko_id, payload: { operation: 'create', after } }),
        document_id: input.projection.document_id,
        projection_id: input.projection.projection_id,
        ko_id: annotation.ko_id,
        adapter: {
          adapter_id: 'obsidian-fs',
          remote_path: input.remote_path,
          remote_revision: input.remote_revision,
        },
        kind: 'user_note',
        operation: 'create',
        status: 'pending',
        payload: {
          after,
          source: 'source_annotation_json',
        },
        observed_at: input.observed_at,
        created_at: input.observed_at,
        updated_at: input.observed_at,
      };
      edits.push({ ...withoutHash, content_hash: await computeExternalEditHash(withoutHash) });
      continue;
    }
    const before = {
      kind: original.kind,
      title: original.title,
      body_md: original.body_md,
      status: original.status,
    };
    const after = {
      kind: annotation.kind ?? original.kind,
      title: annotation.title ?? original.title,
      body_md: annotation.body_md ?? '',
      status: annotation.status ?? original.status,
      render_mode: annotation.render_mode,
      visual_bbox: annotation.visual_bbox,
      visual_strokes: annotation.visual_strokes,
      capture_surface: annotation.capture_surface,
      surface_coord_space: annotation.surface_coord_space,
      surface_bbox: annotation.surface_bbox,
      surface_strokes: annotation.surface_strokes,
    };
    if (
      before.kind === after.kind
      && before.title === after.title
      && before.body_md === after.body_md
      && before.status === after.status
      && after.render_mode === undefined
      && after.visual_bbox === undefined
      && after.visual_strokes === undefined
      && after.capture_surface === undefined
      && after.surface_coord_space === undefined
      && after.surface_bbox === undefined
      && after.surface_strokes === undefined
    ) {
      continue;
    }
    const withoutHash: ExternalEditWithoutHash = {
      schema_version: 'inkloop.external_edit.v1',
      edit_id: await koEditIdFor({ projectionId: input.projection.projection_id, koId: annotation.ko_id, payload: { operation: 'update', before, after } }),
      document_id: input.projection.document_id,
      projection_id: input.projection.projection_id,
      ko_id: annotation.ko_id,
      adapter: {
        adapter_id: 'obsidian-fs',
        remote_path: input.remote_path,
        remote_revision: input.remote_revision,
      },
      kind: 'user_note',
      operation: 'update',
      status: 'pending',
      payload: {
        before,
        after,
        source: 'source_annotation_json',
      },
      observed_at: input.observed_at,
      created_at: input.observed_at,
      updated_at: input.observed_at,
    };
    edits.push({ ...withoutHash, content_hash: await computeExternalEditHash(withoutHash) });
  }
  return edits;
}

export async function parseDocumentExternalEdits(input: {
  markdown: string;
  projection: DocumentProjection;
  knowledgeObjects?: KnowledgeObject[];
  observed_at: string;
  remote_path?: string;
  remote_revision?: string;
}): Promise<ParsedDocumentExternalEdits> {
  const warnings: ParsedDocumentExternalEdits['warnings'] = [];
  const externalEdits: ExternalEdit[] = [];
  const sectionsByBlockId = new Map<string, ParsedBlockSection[]>();
  for (const section of findDocumentBlockSections(input.markdown)) {
    const existing = sectionsByBlockId.get(section.block_id) ?? [];
    existing.push(section);
    sectionsByBlockId.set(section.block_id, existing);
  }

  for (const block of input.projection.blocks) {
    const sections = sectionsByBlockId.get(block.block_id) ?? [];
    if (sections.length === 0) {
      warnings.push({ code: 'missing_block', block_id: block.block_id, detail: 'Remote Markdown is missing the InkLoop block marker.' });
      continue;
    }
    if (sections.length > 1) {
      warnings.push({ code: 'duplicate_block', block_id: block.block_id, detail: 'Remote Markdown contains duplicate active InkLoop block markers.' });
      continue;
    }

    const expected = normalizeBlockBody(renderProjectionBlockContent(block));
    const actual = normalizeBlockBody(sections[0].body);
    if (actual === expected) continue;

    if (block.region === 'generated') {
      warnings.push({ code: 'generated_block_modified', block_id: block.block_id, detail: 'Generated block was modified externally.' });
      continue;
    }

    const withoutHash: ExternalEditWithoutHash = {
      schema_version: 'inkloop.external_edit.v1',
      edit_id: await editIdFor({ projectionId: input.projection.projection_id, blockId: block.block_id, before: expected, after: actual }),
      document_id: input.projection.document_id,
      projection_id: input.projection.projection_id,
      block_id: block.block_id,
      adapter: {
        adapter_id: 'obsidian-fs',
        remote_path: input.remote_path,
        remote_revision: input.remote_revision,
      },
      kind: 'document_body',
      operation: 'update',
      status: 'pending',
      payload: {
        before_md: expected,
        after_md: actual,
      },
      observed_at: input.observed_at,
      created_at: input.observed_at,
      updated_at: input.observed_at,
    };
    externalEdits.push({ ...withoutHash, content_hash: await computeExternalEditHash(withoutHash) });
  }

  externalEdits.push(...await parseAnnotationExternalEdits(input));

  return { external_edits: externalEdits, warnings };
}
