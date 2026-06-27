import { z, type SafeParseReturnType } from 'zod';

export type ISODateTime = string;
export type Sha256 = `sha256:${string}`;
export type NormBBox = [number, number, number, number];

export type KnowledgeKind =
  | 'source_document'
  | 'excerpt'
  | 'annotation'
  | 'ai_note'
  | 'qa'
  | 'summary'
  | 'task'
  | 'concept';

export type KnowledgeStatus =
  | 'inbox'
  | 'accepted'
  | 'edited'
  | 'dismissed'
  | 'export_ready'
  | 'exported'
  | 'archived';

export type Privacy = 'local_only' | 'export_allowed';

export const KoIdSchema = z.string().regex(/^ko_[0-9A-HJKMNP-TV-Z]{26}$/);
export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/) as z.ZodType<Sha256>;

export const KnowledgeKinds = [
  'source_document',
  'excerpt',
  'annotation',
  'ai_note',
  'qa',
  'summary',
  'task',
  'concept',
] as const;

export const KnowledgeStatuses = [
  'inbox',
  'accepted',
  'edited',
  'dismissed',
  'export_ready',
  'exported',
  'archived',
] as const;

export const NormBBoxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([x, y, w, h]) => x >= 0 && y >= 0 && w >= 0 && h >= 0 && x + w <= 1.000001 && y + h <= 1.000001, {
    message: 'bbox must be normalized [x,y,w,h]',
  });

export const KnowledgeObjectSchema = z.object({
  schema_version: z.literal('inkloop.knowledge_object.v1'),
  ko_id: KoIdSchema,
  kind: z.enum(KnowledgeKinds),
  title: z.string().min(1).max(200),
  body_md: z.string().max(100_000),
  source: z.object({
    document_id: z.string().min(1),
    document_title: z.string().min(1),
    page_id: z.string().optional(),
    page_index: z.number().int().nonnegative().optional(),
    object_refs: z.array(z.string()).default([]),
    anchor_bbox: NormBBoxSchema.optional(),
    quote: z.string().max(20_000).optional(),
    inkloop_uri: z.string().regex(/^inkloop:\/\//),
  }),
  provenance: z.object({
    created_from: z.enum(['mark', 'ai_turn', 'session', 'manual']),
    mark_ids: z.array(z.string()).optional(),
    ai_turn_ids: z.array(z.string()).optional(),
  }),
  tags: z.array(z.string()).default([]),
  status: z.enum(KnowledgeStatuses),
  privacy: z.enum(['local_only', 'export_allowed']),
  render_hints: z
    .object({
      markdown_callout: z.enum(['note', 'quote', 'question', 'todo', 'summary', 'tip']).optional(),
    })
    .optional(),
  content_hash: Sha256Schema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type KnowledgeObject = z.infer<typeof KnowledgeObjectSchema>;
export type KnowledgeObjectWithoutHash = Omit<KnowledgeObject, 'content_hash'>;

export interface KnowledgeObjectExportEnvelope {
  schema_version: 'inkloop.knowledge_export.v1';
  export_id: string;
  generated_at: string;
  source: {
    app: 'inkloop';
    app_version?: string;
    document_id?: string;
  };
  objects: KnowledgeObject[];
}

export function parseKnowledgeObject(input: unknown): KnowledgeObject {
  return KnowledgeObjectSchema.parse(input);
}

export function safeParseKnowledgeObject(input: unknown): SafeParseReturnType<unknown, KnowledgeObject> {
  return KnowledgeObjectSchema.safeParse(input);
}

export function isExportableKnowledgeObject(ko: KnowledgeObject): boolean {
  return ko.privacy === 'export_allowed' && ['export_ready', 'accepted', 'edited'].includes(ko.status) && ko.body_md.trim().length > 0;
}
