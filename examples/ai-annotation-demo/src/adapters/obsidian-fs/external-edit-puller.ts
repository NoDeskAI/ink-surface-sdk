import type { DocumentProjection } from '../../knowledge/document-projection';
import { computeExternalEditHash, type ExternalEdit, type ExternalEditWithoutHash } from '../../knowledge/external-edit';
import { sha256Hex } from '../../knowledge/hash';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { adapterId } from '../core/ids';
import type { AdapterStoragePort, ConflictCode, ConflictRecord, ExternalBinding, ValidationIssue } from '../core/types';
import { parseDocumentExternalEdits, renderProjectionBlockContent } from '../markdown';
import type { ObsidianFsTarget } from './config';
import { readTextIfExists } from './fs-writer';
import { fromVaultRelative } from './target';
import { markdownProjectionChunks } from './sidecar-runtime';

export interface PullDocumentExternalEditsResult {
  external_edits: ExternalEdit[];
  conflicts: ConflictRecord[];
  warnings: ValidationIssue[];
}

function conflictCodeForWarning(code: string): ConflictCode {
  switch (code) {
    case 'missing_block':
      return 'missing_controlled_section';
    case 'duplicate_block':
      return 'duplicate_controlled_sections';
    case 'generated_block_modified':
      return 'controlled_section_modified';
    default:
      return 'schema_version_unsupported';
  }
}

function normalizeBlockBody(input: string): string {
  return input.trim().replace(/\r\n/g, '\n');
}

async function editIdFor(input: { projectionId: string; blockId: string; before: string; after: string }): Promise<string> {
  const fingerprint = await sha256Hex(`${input.before}\n---inkloop-edit---\n${input.after}`);
  return `edit_${input.projectionId}_${input.blockId}_${fingerprint.slice(0, 20)}`;
}

async function parseNativeDocumentExternalEdits(input: {
  markdown: string;
  projection: DocumentProjection;
  observed_at: string;
  remote_path?: string;
  remote_revision?: string;
}): Promise<{
  external_edits: ExternalEdit[];
  warnings: Array<{ code: 'missing_block' | 'duplicate_block' | 'generated_block_modified'; block_id: string; detail: string }>;
}> {
  const chunks = markdownProjectionChunks(input.markdown, input.projection);
  const warnings: Array<{ code: 'missing_block' | 'duplicate_block' | 'generated_block_modified'; block_id: string; detail: string }> = [];
  const externalEdits: ExternalEdit[] = [];

  for (const [index, block] of input.projection.blocks.entries()) {
    const chunk = chunks[index];
    if (!chunk) {
      warnings.push({ code: 'missing_block', block_id: block.block_id, detail: 'Native Markdown no longer has a matching block at the expected reading order.' });
      continue;
    }

    const expected = normalizeBlockBody(renderProjectionBlockContent(block));
    const actual = normalizeBlockBody(chunk);
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

  return { external_edits: externalEdits, warnings };
}

async function createDocumentConflict(input: {
  storage: AdapterStoragePort;
  target: ObsidianFsTarget;
  binding?: ExternalBinding;
  projection: DocumentProjection;
  code: ConflictCode;
  remotePath?: string;
  detail: string;
  now: string;
}): Promise<ConflictRecord> {
  const conflict: ConflictRecord = {
    conflict_id: adapterId('conflict'),
    provider: 'obsidian_fs',
    target_id: input.target.target_id,
    ko_id: input.projection.projection_id,
    binding_id: input.binding?.binding_id,
    code: input.code,
    severity: input.code === 'controlled_section_modified' ? 'medium' : 'high',
    remote_path: input.remotePath,
    local_content_hash: input.projection.content_hash,
    resolution_status: 'open',
    resolution_strategy: input.code === 'controlled_section_modified' ? 'append_new_version' : 'create_new_file',
    detail: input.detail,
    created_at: input.now,
    updated_at: input.now,
  };
  await input.storage.createConflict(conflict);
  await input.storage.appendSyncEvent({
    event_id: adapterId('evt'),
    binding_id: input.binding?.binding_id,
    ko_id: input.projection.projection_id,
    provider: 'obsidian_fs',
    level: 'warn',
    type: 'conflict.detected',
    message: input.detail,
    data: { code: input.code, remote_path: input.remotePath },
    created_at: input.now,
  });
  return conflict;
}

export async function pullObsidianDocumentExternalEdits(input: {
  target: ObsidianFsTarget;
  projections: DocumentProjection[];
  storage: AdapterStoragePort;
  bindings?: ExternalBinding[];
  knowledgeObjects?: KnowledgeObject[];
  observed_at?: string;
}): Promise<PullDocumentExternalEditsResult> {
  const externalEdits: ExternalEdit[] = [];
  const conflicts: ConflictRecord[] = [];
  const warnings: ValidationIssue[] = [];
  const observedAt = input.observed_at ?? new Date().toISOString();

  for (const projection of input.projections) {
    let binding = input.bindings?.find((candidate) => candidate.ko_id === projection.projection_id)
      ?? (await input.storage.getBinding(input.target.target_id, projection.projection_id));
    if (!binding) {
      warnings.push({ code: 'BINDING_MISSING', message: `No binding for ${projection.projection_id}` });
      continue;
    }

    let remotePath = binding.remote_path;
    let markdown = await readTextIfExists(fromVaultRelative(input.target.vault_root, remotePath));

    if (!markdown) {
      warnings.push({ code: 'REMOTE_FILE_MISSING', message: `Remote source document missing for ${projection.projection_id}` });
      conflicts.push(await createDocumentConflict({
        storage: input.storage,
        target: input.target,
        binding,
        projection,
        code: 'remote_file_missing',
        remotePath,
        detail: `Remote source document missing for ${projection.projection_id}`,
        now: observedAt,
      }));
      continue;
    }

    const parsed = markdown.includes('inkloop:block-begin')
      ? await parseDocumentExternalEdits({
        markdown,
        projection,
        knowledgeObjects: input.knowledgeObjects,
        observed_at: observedAt,
        remote_path: remotePath,
        remote_revision: binding.remote_rev,
      })
      : await parseNativeDocumentExternalEdits({
        markdown,
        projection,
        observed_at: observedAt,
        remote_path: remotePath,
        remote_revision: binding.remote_rev,
      });
    for (const warning of parsed.warnings) {
      warnings.push({ code: warning.code, message: warning.detail, path: warning.block_id });
      conflicts.push(await createDocumentConflict({
        storage: input.storage,
        target: input.target,
        binding,
        projection,
        code: conflictCodeForWarning(warning.code),
        remotePath,
        detail: warning.detail,
        now: observedAt,
      }));
    }
    for (const edit of parsed.external_edits) {
      await input.storage.upsertExternalEdit(edit);
      await input.storage.appendSyncEvent({
        event_id: adapterId('evt'),
        binding_id: binding.binding_id,
        ko_id: projection.projection_id,
        provider: 'obsidian_fs',
        level: 'info',
        type: 'external_edit.detected',
        message: `Detected external edit ${edit.edit_id}`,
        data: { block_id: edit.block_id, remote_path: remotePath },
        created_at: observedAt,
      });
      externalEdits.push(edit);
    }
  }

  return { external_edits: externalEdits, conflicts, warnings };
}
