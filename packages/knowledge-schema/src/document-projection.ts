import { z, type SafeParseReturnType } from 'zod';
import { canonicalize } from './canonical-json.js';
import { sha256Tagged } from './hash.js';
import { KoIdSchema, NormBBoxSchema, Sha256Schema, type Sha256 } from './knowledge-object.js';

export const ProjectionBlockKinds = ['heading', 'paragraph', 'quote', 'list', 'table', 'image', 'page_break', 'unknown'] as const;
export const ProjectionRegions = ['generated', 'editable', 'external'] as const;

export const ProjectionIdSchema = z.string().regex(/^dp_[A-Za-z0-9_-]+$/);
export const ProjectionBlockIdSchema = z.string().regex(/^blk_[A-Za-z0-9_-]+$/);

const CharacterRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((range) => range.end >= range.start, { message: 'source range end must be >= start' });

export const DocumentProjectionBlockSchema = z.object({
  block_id: ProjectionBlockIdSchema,
  kind: z.enum(ProjectionBlockKinds),
  heading_level: z.number().int().min(1).max(6).optional(),
  text_md: z.string().max(100_000),
  region: z.enum(ProjectionRegions).default('editable'),
  source: z
    .object({
      page_id: z.string().min(1).optional(),
      page_index: z.number().int().nonnegative().optional(),
      object_refs: z.array(z.string()).default([]),
      source_range: CharacterRangeSchema.optional(),
      anchor_bbox: NormBBoxSchema.optional(),
    })
    .optional(),
  knowledge_object_ids: z.array(KoIdSchema).default([]),
});

export const DocumentProjectionSchema = z
  .object({
    schema_version: z.literal('inkloop.document_projection.v1'),
    projection_id: ProjectionIdSchema,
    document_id: z.string().min(1),
    document_title: z.string().min(1).max(300),
    document_uri: z.string().regex(/^inkloop:\/\//),
    revision_id: z.string().min(1),
    generated_at: z.string().datetime(),
    source: z.object({
      app: z.literal('inkloop'),
      app_version: z.string().optional(),
    }),
    privacy: z.enum(['local_only', 'export_allowed']),
    export_policy: z.object({
      include_full_text: z.boolean(),
      include_pdf_asset: z.boolean().default(false),
      include_raw_strokes: z.boolean().default(false),
      include_debug_evidence: z.boolean().default(false),
    }),
    blocks: z.array(DocumentProjectionBlockSchema).min(1),
    body_hash: Sha256Schema,
    content_hash: Sha256Schema,
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .superRefine((projection, ctx) => {
    const seen = new Set<string>();
    for (const [index, block] of projection.blocks.entries()) {
      if (seen.has(block.block_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', index, 'block_id'],
          message: `duplicate block_id ${block.block_id}`,
        });
      }
      seen.add(block.block_id);
    }

    if (projection.privacy === 'local_only' && projection.export_policy.include_full_text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['export_policy', 'include_full_text'],
        message: 'local_only document projections cannot include full text',
      });
    }
  });

export type DocumentProjectionBlock = z.infer<typeof DocumentProjectionBlockSchema>;
export type DocumentProjection = z.infer<typeof DocumentProjectionSchema>;
export type DocumentProjectionWithoutHash = Omit<DocumentProjection, 'content_hash'>;

export const DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION = 'inkloop.document_projection_export.v1' as const;

export interface DocumentProjectionExportEnvelope {
  schema_version: typeof DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION;
  export_id: string;
  generated_at: string;
  source: {
    app: 'inkloop';
    app_version?: string;
    document_id?: string;
  };
  document_projections: DocumentProjection[];
  external_edits: unknown[];
}

export function parseDocumentProjection(input: unknown): DocumentProjection {
  return DocumentProjectionSchema.parse(input);
}

export function safeParseDocumentProjection(input: unknown): SafeParseReturnType<unknown, DocumentProjection> {
  return DocumentProjectionSchema.safeParse(input);
}

export async function computeDocumentProjectionBodyHash(blocks: readonly DocumentProjectionBlock[]): Promise<Sha256> {
  return sha256Tagged(canonicalize(blocks.map((block) => ({ block_id: block.block_id, kind: block.kind, text_md: block.text_md }))));
}

export async function computeDocumentProjectionHash(projection: DocumentProjectionWithoutHash): Promise<Sha256> {
  const { generated_at: _generatedAt, created_at: _createdAt, updated_at: _updatedAt, ...stableProjection } = projection;
  return sha256Tagged(canonicalize(stableProjection));
}

export async function recomputeDocumentProjectionHash(projection: DocumentProjection): Promise<Sha256> {
  const { content_hash: _contentHash, ...withoutHash } = projection;
  return computeDocumentProjectionHash(withoutHash);
}

export function isExportableDocumentProjection(projection: DocumentProjection): boolean {
  return projection.privacy === 'export_allowed' && projection.export_policy.include_full_text && projection.blocks.length > 0;
}
