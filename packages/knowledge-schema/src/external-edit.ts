import { z, type SafeParseReturnType } from 'zod';
import { canonicalize } from './canonical-json.js';
import { sha256Tagged } from './hash.js';
import { KoIdSchema, Sha256Schema, type Sha256 } from './knowledge-object.js';
import { ProjectionBlockIdSchema, ProjectionIdSchema } from './document-projection.js';

export const ExternalEditKinds = [
  'document_body',
  'user_note',
  'metadata',
  'task_status',
  'file_renamed',
  'file_deleted',
  'controlled_section',
] as const;

export const ExternalEditOperations = ['create', 'update', 'delete', 'rename', 'move', 'complete', 'reopen'] as const;
export const ExternalEditStatuses = ['pending', 'accepted', 'rejected', 'conflict'] as const;

export const ExternalEditSchema = z
  .object({
    schema_version: z.literal('inkloop.external_edit.v1'),
    edit_id: z.string().regex(/^edit_[A-Za-z0-9_-]+$/),
    document_id: z.string().min(1),
    projection_id: ProjectionIdSchema.optional(),
    ko_id: KoIdSchema.optional(),
    block_id: ProjectionBlockIdSchema.optional(),
    adapter: z.object({
      adapter_id: z.string().min(1),
      target_id: z.string().min(1).optional(),
      remote_id: z.string().min(1).optional(),
      remote_path: z.string().min(1).optional(),
      remote_revision: z.string().min(1).optional(),
    }),
    kind: z.enum(ExternalEditKinds),
    operation: z.enum(ExternalEditOperations),
    status: z.enum(ExternalEditStatuses),
    payload: z.record(z.unknown()).default({}),
    observed_at: z.string().datetime(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    content_hash: Sha256Schema,
  })
  .superRefine((edit, ctx) => {
    if (!edit.projection_id && !edit.ko_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projection_id'],
        message: 'external edits must target a projection_id or ko_id',
      });
    }

    if (edit.kind === 'document_body' && !edit.block_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['block_id'],
        message: 'document_body edits must include block_id',
      });
    }
  });

export type ExternalEdit = z.infer<typeof ExternalEditSchema>;
export type ExternalEditWithoutHash = Omit<ExternalEdit, 'content_hash'>;

export function parseExternalEdit(input: unknown): ExternalEdit {
  return ExternalEditSchema.parse(input);
}

export function safeParseExternalEdit(input: unknown): SafeParseReturnType<unknown, ExternalEdit> {
  return ExternalEditSchema.safeParse(input);
}

export async function computeExternalEditHash(edit: ExternalEditWithoutHash): Promise<Sha256> {
  return sha256Tagged(canonicalize(edit));
}

export async function recomputeExternalEditHash(edit: ExternalEdit): Promise<Sha256> {
  const { content_hash: _contentHash, ...withoutHash } = edit;
  return computeExternalEditHash(withoutHash);
}
