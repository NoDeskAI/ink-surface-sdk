import path from 'node:path';
import { isExportableDocumentProjection, type DocumentProjection } from '../../knowledge/document-projection';
import { sha256Hex } from '../../knowledge/hash';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import { adapterId } from '../core/ids';
import type { AdapterStoragePort, ExternalBinding } from '../core/types';
import { renderProjectionBlockContent } from '../markdown';
import type { ObsidianFsTarget } from './config';
import { atomicWrite, ensureDir, readTextIfExists } from './fs-writer';
import { pathForDocumentProjection } from './path-policy';
import { pathExists } from './scanner';
import { fromVaultRelative, toVaultRelative } from './target';
import { pullObsidianDocumentExternalEdits, type PullDocumentExternalEditsResult } from './external-edit-puller';
import { normalizeKnowledgeObjectsForProjectionTitles } from './normalize';
import {
  markdownProjectionChunks,
  remoteProjectionBlockText,
  renderNativeDocumentProjectionMarkdown,
  writeDocumentProjectionSidecar,
  type NativeDocumentProjectionMarkdown,
} from './sidecar-runtime';

export interface ObsidianFsDocumentPayload extends NativeDocumentProjectionMarkdown {
  remote_path: string;
  absolute_path: string;
}

export interface DocumentExportPlanItem {
  projection_id: string;
  action: 'create' | 'update' | 'skip_unchanged' | 'skip_export_blocked' | 'conflict' | 'relink_then_update';
  reason?: string;
  binding_id?: string;
  remote_path?: string;
  preview_markdown?: string;
  conflict_code?: string;
}

export interface DocumentExportPlan {
  plan_id: string;
  provider: 'obsidian_fs';
  target_id: string;
  created_at: string;
  items: DocumentExportPlanItem[];
  summary: {
    create_count: number;
    update_count: number;
    skip_count: number;
    conflict_count: number;
  };
}

export interface DocumentExportRunResult {
  plan: DocumentExportPlan;
  results: Array<{
    action: DocumentExportPlanItem['action'] | 'created' | 'updated';
    binding?: ExternalBinding;
    remote_path?: string;
  }>;
}

function projectionWithRemoteNativeEditableBlocks(input: {
  projection: DocumentProjection;
  existingMarkdown: string;
}): DocumentProjection {
  const chunks = markdownProjectionChunks(input.existingMarkdown, input.projection);
  return {
    ...input.projection,
    blocks: input.projection.blocks.map((block, index) => {
      if (block.region !== 'editable') return block;
      const actualMarkdown = chunks[index]?.trim();
      if (!actualMarkdown || actualMarkdown === renderProjectionBlockContent(block).trim()) return block;
      return { ...block, text_md: remoteProjectionBlockText(actualMarkdown, block.kind) };
    }),
  };
}

export class ObsidianFsDocumentAdapter {
  readonly provider = 'obsidian_fs' as const;

  async render(input: {
    projection: DocumentProjection;
    target: ObsidianFsTarget;
    knowledgeObjects?: KnowledgeObject[];
  }): Promise<ObsidianFsDocumentPayload> {
    const rendered = await renderNativeDocumentProjectionMarkdown({ projection: input.projection });
    const targetPath = pathForDocumentProjection(input.target, input.projection);
    return {
      ...rendered,
      absolute_path: targetPath.absolutePath,
      remote_path: targetPath.remotePath,
    };
  }

  async plan(input: {
    projections: DocumentProjection[];
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    knowledgeObjects?: KnowledgeObject[];
  }): Promise<DocumentExportPlan> {
    const items: DocumentExportPlanItem[] = [];
    const now = new Date().toISOString();

    for (const projection of input.projections) {
      if (!isExportableDocumentProjection(projection)) {
        items.push({
          projection_id: projection.projection_id,
          action: 'skip_export_blocked',
          reason: projection.privacy === 'local_only' ? 'privacy=local_only' : 'full text export is not enabled',
        });
        continue;
      }
      const binding = await input.storage.getBinding(input.target.target_id, projection.projection_id);
      const payload = await this.render({ projection, target: input.target, knowledgeObjects: input.knowledgeObjects });
      items.push(await this.planProjection({ projection, target: input.target, binding, payload }));
    }

    const plan: DocumentExportPlan = {
      plan_id: adapterId('plan'),
      provider: this.provider,
      target_id: input.target.target_id,
      created_at: now,
      items,
      summary: {
        create_count: items.filter((item) => item.action === 'create').length,
        update_count: items.filter((item) => item.action === 'update' || item.action === 'relink_then_update').length,
        skip_count: items.filter((item) => item.action.startsWith('skip_')).length,
        conflict_count: items.filter((item) => item.action === 'conflict').length,
      },
    };

    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      provider: this.provider,
      level: 'info',
      type: 'plan.created',
      message: `Created Obsidian FS document export plan with ${items.length} items.`,
      data: { summary: plan.summary },
      created_at: now,
    });
    return plan;
  }

  private async planProjection(input: {
    projection: DocumentProjection;
    target: ObsidianFsTarget;
    binding: ExternalBinding | null;
    payload: ObsidianFsDocumentPayload;
  }): Promise<DocumentExportPlanItem> {
    if (!input.binding) {
      return { projection_id: input.projection.projection_id, action: 'create', remote_path: input.payload.remote_path, preview_markdown: input.payload.markdown };
    }

    const boundPath = fromVaultRelative(input.target.vault_root, input.binding.remote_path);
    if (await pathExists(boundPath)) {
      if (input.binding.ko_content_hash === input.projection.content_hash) {
        return { projection_id: input.projection.projection_id, action: 'skip_unchanged', binding_id: input.binding.binding_id, remote_path: input.binding.remote_path };
      }
      return { projection_id: input.projection.projection_id, action: 'update', binding_id: input.binding.binding_id, remote_path: input.binding.remote_path, preview_markdown: input.payload.markdown };
    }

    return {
      projection_id: input.projection.projection_id,
      action: 'create',
      binding_id: input.binding.binding_id,
      remote_path: input.payload.remote_path,
      preview_markdown: input.payload.markdown,
      reason: 'Previous source document missing; creating a new projection.',
    };
  }

  async exportDocuments(input: {
    projections: DocumentProjection[];
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    knowledgeObjects?: KnowledgeObject[];
  }): Promise<DocumentExportRunResult> {
    const plan = await this.plan(input);
    const results: DocumentExportRunResult['results'] = [];
    for (const item of plan.items) {
      if (item.action.startsWith('skip_')) {
        await input.storage.appendSyncEvent({
          event_id: adapterId('evt'),
          provider: this.provider,
          ko_id: item.projection_id,
          level: 'info',
          type: 'file.skipped_unchanged',
          message: item.reason ?? item.action,
          created_at: new Date().toISOString(),
        });
        results.push({ action: item.action, remote_path: item.remote_path });
        continue;
      }
      if (item.action === 'conflict') {
        results.push({ action: item.action, remote_path: item.remote_path });
        continue;
      }

      const projection = input.projections.find((candidate) => candidate.projection_id === item.projection_id);
      if (!projection) continue;
      const binding = await input.storage.getBinding(input.target.target_id, projection.projection_id);
      results.push(await this.apply({ projection, target: input.target, storage: input.storage, binding, knowledgeObjects: input.knowledgeObjects, plannedRemotePath: item.remote_path }));
    }
    return { plan, results };
  }

  async pullExternalEdits(input: {
    projections: DocumentProjection[];
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    bindings?: ExternalBinding[];
    knowledgeObjects?: KnowledgeObject[];
    observed_at?: string;
  }): Promise<PullDocumentExternalEditsResult> {
    return pullObsidianDocumentExternalEdits(input);
  }

  private async apply(input: {
    projection: DocumentProjection;
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    binding?: ExternalBinding | null;
    knowledgeObjects?: KnowledgeObject[];
    plannedRemotePath?: string;
  }): Promise<DocumentExportRunResult['results'][number]> {
    const existingBinding = input.binding ?? (await input.storage.getBinding(input.target.target_id, input.projection.projection_id));
    const now = new Date().toISOString();
    await this.ensureTargetDirs(input.target);

    if (!existingBinding) {
      if (input.plannedRemotePath) {
        const relinkBinding = await this.bindingFromExistingFile({ target: input.target, projection: input.projection, remotePath: input.plannedRemotePath, now });
        if (relinkBinding) return this.apply({ ...input, binding: relinkBinding, plannedRemotePath: input.plannedRemotePath });
      }
      return this.createFile({ ...input, now, binding: null });
    }

    const relinkPath = input.plannedRemotePath && input.plannedRemotePath !== existingBinding.remote_path ? input.plannedRemotePath : existingBinding.remote_path;
    const absolutePath = fromVaultRelative(input.target.vault_root, relinkPath);
    const existingMarkdown = await readTextIfExists(absolutePath);
    if (!existingMarkdown) return this.createFile({ ...input, now, binding: existingBinding });

    const projectionToRender = projectionWithRemoteNativeEditableBlocks({ projection: input.projection, existingMarkdown });
    const payload = await this.render({ projection: projectionToRender, target: input.target, knowledgeObjects: input.knowledgeObjects });
    const knowledgeObjects = await normalizeKnowledgeObjectsForProjectionTitles(input.knowledgeObjects, [projectionToRender]);
    await atomicWrite(absolutePath, payload.markdown);
    await writeDocumentProjectionSidecar({
      target: input.target,
      projection: projectionToRender,
      remotePath: relinkPath,
      native: payload,
      knowledgeObjects,
      now,
    });
    const binding = await this.upsertBinding({
      target: input.target,
      projection: input.projection,
      storage: input.storage,
      existing: existingBinding,
      remotePath: relinkPath,
      now,
    });
    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      binding_id: binding.binding_id,
      ko_id: input.projection.projection_id,
      provider: this.provider,
      level: 'info',
      type: 'file.updated',
      message: `Updated ${relinkPath}`,
      created_at: now,
    });
    return { action: 'updated', binding, remote_path: relinkPath };
  }

  private async createFile(input: {
    projection: DocumentProjection;
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    binding: ExternalBinding | null;
    knowledgeObjects?: KnowledgeObject[];
    now: string;
  }): Promise<DocumentExportRunResult['results'][number]> {
    const payload = await this.render({ projection: input.projection, target: input.target, knowledgeObjects: input.knowledgeObjects });
    const pathInfo = await this.availablePath(input.target, payload.remote_path);
    const knowledgeObjects = await normalizeKnowledgeObjectsForProjectionTitles(input.knowledgeObjects, [input.projection]);
    await atomicWrite(pathInfo.absolutePath, payload.markdown);
    await writeDocumentProjectionSidecar({
      target: input.target,
      projection: input.projection,
      remotePath: pathInfo.remotePath,
      native: payload,
      knowledgeObjects,
      now: input.now,
    });
    const binding = await this.upsertBinding({
      target: input.target,
      projection: input.projection,
      storage: input.storage,
      existing: input.binding,
      remotePath: pathInfo.remotePath,
      now: input.now,
    });
    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      binding_id: binding.binding_id,
      ko_id: input.projection.projection_id,
      provider: this.provider,
      level: 'info',
      type: input.binding ? 'file.recreated_after_missing' : 'file.created',
      message: `Created ${pathInfo.remotePath}`,
      created_at: input.now,
    });
    return { action: 'created', binding, remote_path: pathInfo.remotePath };
  }

  private async bindingFromExistingFile(input: {
    target: ObsidianFsTarget;
    projection: DocumentProjection;
    remotePath: string;
    now: string;
  }): Promise<ExternalBinding | null> {
    return {
      binding_id: adapterId('bind'),
      provider: this.provider,
      target_id: input.target.target_id,
      ko_id: input.projection.projection_id,
      ko_content_hash: input.projection.content_hash,
      render_body_hash: input.projection.body_hash,
      remote_id: `remote_${(await sha256Hex(`${input.target.vault_root}:${input.remotePath}`)).slice(0, 24)}`,
      remote_path: input.remotePath,
      mapping_version: 'inkloop.obsidian.mapping.v1',
      sync_state: 'active',
      last_exported_at: input.now,
      last_seen_remote_at: input.now,
      created_at: input.now,
      updated_at: input.now,
    };
  }

  private async availablePath(target: ObsidianFsTarget, remotePath: string): Promise<{ absolutePath: string; remotePath: string }> {
    let absolutePath = fromVaultRelative(target.vault_root, remotePath);
    if (!(await pathExists(absolutePath))) return { absolutePath, remotePath };

    const ext = path.extname(absolutePath);
    const base = absolutePath.slice(0, -ext.length);
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} ${i}${ext}`;
      if (!(await pathExists(candidate))) return { absolutePath: candidate, remotePath: toVaultRelative(target.vault_root, candidate) };
    }
    throw new Error(`Unable to find available path for ${remotePath}`);
  }

  private async upsertBinding(input: {
    target: ObsidianFsTarget;
    projection: DocumentProjection;
    storage: AdapterStoragePort;
    existing: ExternalBinding | null;
    remotePath: string;
    now: string;
  }): Promise<ExternalBinding> {
    const binding: ExternalBinding = {
      binding_id: input.existing?.binding_id ?? adapterId('bind'),
      provider: this.provider,
      target_id: input.target.target_id,
      ko_id: input.projection.projection_id,
      ko_content_hash: input.projection.content_hash,
      render_body_hash: input.projection.body_hash,
      remote_id: `remote_${(await sha256Hex(`${input.target.vault_root}:${input.remotePath}`)).slice(0, 24)}`,
      remote_path: input.remotePath,
      mapping_version: 'inkloop.obsidian.mapping.v1',
      sync_state: 'active',
      last_exported_at: input.now,
      last_seen_remote_at: input.now,
      created_at: input.existing?.created_at ?? input.now,
      updated_at: input.now,
    };
    await input.storage.upsertBinding(binding);
    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      binding_id: binding.binding_id,
      ko_id: input.projection.projection_id,
      provider: this.provider,
      level: 'info',
      type: input.existing ? 'binding.updated' : 'binding.created',
      message: input.existing ? 'Updated document ExternalBinding.' : 'Created document ExternalBinding.',
      created_at: input.now,
    });
    return binding;
  }

  private async ensureTargetDirs(target: ObsidianFsTarget): Promise<void> {
    await Promise.all([
      ensureDir(target.sources_dir),
      ensureDir(target.notes_dir),
      ensureDir(target.tasks_dir),
      ensureDir(target.summaries_dir),
      ensureDir(target.concepts_dir),
      ensureDir(target.assets_dir),
    ]);
  }
}

export const obsidianFsDocumentAdapter = new ObsidianFsDocumentAdapter();
