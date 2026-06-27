import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentProjection } from '../../knowledge/document-projection';
import { parseKnowledgeObject, type KnowledgeObject, type Sha256 } from '../../knowledge/knowledge-object';
import { sha256Hex } from '../../knowledge/hash';
import { adapterId } from '../core/ids';
import type {
  AdapterStoragePort,
  ApplyResult,
  ConflictCode,
  ConflictRecord,
  ExportPlan,
  ExportPlanItem,
  ExternalBinding,
  SyncPolicy,
  ValidationResult,
} from '../core/types';
import { DefaultObsidianFsPolicy } from '../core/types';
import {
  findInkloopSections,
  frontmatterForKnowledgeObject,
  parseFrontmatter,
  renderKnowledgeObjectMarkdown,
  replaceControlledSection,
  replaceFrontmatter,
  snapshotAndReplaceControlledSection,
  type RenderedKnowledgeMarkdown,
} from '../markdown';
import { ObsidianFsManifest } from './manifest';
import type { ObsidianFsConfig, ObsidianFsTarget } from './config';
import { atomicWrite, ensureDir, readTextIfExists } from './fs-writer';
import { pathForKnowledgeObject, pathForSourceNote } from './path-policy';
import { findNotesByInkloopId, pathExists } from './scanner';
import { fromVaultRelative, normalizeVaultSubdir, resolveObsidianFsTarget, toVaultRelative } from './target';
import { validateVaultRoot } from './vault-validator';
import { renderSourceNote } from '../markdown/source-note';
import { pullObsidianMetadata } from './metadata-puller';
import { normalizeKnowledgeObjectsForProjectionTitles } from './normalize';

export interface ObsidianFsPayload extends RenderedKnowledgeMarkdown {
  remote_path: string;
  absolute_path: string;
}

export interface ExportRunResult {
  plan: ExportPlan;
  results: ApplyResult[];
}

interface ExportObjectsInput {
  objects: KnowledgeObject[];
  target: ObsidianFsTarget;
  storage: AdapterStoragePort;
  policy?: SyncPolicy;
  documentProjections?: DocumentProjection[];
}

export class ObsidianFsAdapter {
  readonly manifest = ObsidianFsManifest;

  async validateConfig(config: ObsidianFsConfig): Promise<ValidationResult> {
    const validation = await validateVaultRoot(config.vault_root);
    try {
      normalizeVaultSubdir(config.base_dir);
    } catch (error) {
      validation.issues.push({
        code: 'BASE_DIR_OUTSIDE_VAULT',
        message: error instanceof Error ? error.message : 'Obsidian base_dir must stay inside the vault root.',
      });
    }
    try {
      normalizeVaultSubdir(config.documents_dir ?? 'InkLoop');
    } catch (error) {
      validation.issues.push({
        code: 'DOCUMENTS_DIR_OUTSIDE_VAULT',
        message: error instanceof Error ? error.message : 'Obsidian documents_dir must stay inside the vault root.',
      });
    }
    return { ...validation, ok: validation.issues.length === 0 };
  }

  async resolveTarget(config: ObsidianFsConfig): Promise<ObsidianFsTarget> {
    return resolveObsidianFsTarget(config);
  }

  async render(input: { object: KnowledgeObject; target: ObsidianFsTarget }): Promise<ObsidianFsPayload> {
    const rendered = await renderKnowledgeObjectMarkdown(input.object);
    const targetPath = pathForKnowledgeObject(input.target, input.object);
    return {
      ...rendered,
      absolute_path: targetPath.absolutePath,
      remote_path: targetPath.remotePath,
    };
  }

  async plan(input: ExportObjectsInput): Promise<ExportPlan> {
    const policy = input.policy ?? DefaultObsidianFsPolicy;
    const items: ExportPlanItem[] = [];
    const now = new Date().toISOString();
    const objects = (await normalizeKnowledgeObjectsForProjectionTitles(input.objects, input.documentProjections)) ?? [];

    for (const raw of objects) {
      const object = parseKnowledgeObject(raw);

      if (!policy.privacy_filter.includes(object.privacy)) {
        items.push({ ko_id: object.ko_id, action: 'skip_privacy', reason: `privacy=${object.privacy}` });
        continue;
      }

      if (!policy.allowed_statuses.includes(object.status)) {
        items.push({ ko_id: object.ko_id, action: 'skip_status', reason: `status=${object.status}` });
        continue;
      }

      const binding = await input.storage.getBinding(input.target.target_id, object.ko_id);
      const payload = await this.render({ object, target: input.target });
      const planned = await this.planObject({ object, target: input.target, storage: input.storage, binding, payload });
      items.push(planned);
    }

    const plan: ExportPlan = {
      plan_id: adapterId('plan'),
      provider: this.manifest.provider,
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
      provider: this.manifest.provider,
      level: 'info',
      type: 'plan.created',
      message: `Created Obsidian FS export plan with ${items.length} items.`,
      data: { summary: plan.summary },
      created_at: now,
    });
    return plan;
  }

  private async planObject(input: {
    object: KnowledgeObject;
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    binding: ExternalBinding | null;
    payload: ObsidianFsPayload;
  }): Promise<ExportPlanItem> {
    const { object, target, binding, payload } = input;
    const existingById = await findNotesByInkloopId(target, object.ko_id);
    if (existingById.length > 1) {
      return { ko_id: object.ko_id, action: 'conflict', binding_id: binding?.binding_id, conflict_code: 'duplicate_remote_files', reason: 'Multiple files have the same inkloop_id.' };
    }

    if (!binding) {
      if (existingById.length === 1) {
        return {
          ko_id: object.ko_id,
          action: 'relink_then_update',
          remote_path: existingById[0].remotePath,
          preview_markdown: payload.markdown,
          reason: 'Found existing file by frontmatter inkloop_id.',
        };
      }
      return { ko_id: object.ko_id, action: 'create', remote_path: payload.remote_path, preview_markdown: payload.markdown };
    }

    const boundPath = fromVaultRelative(target.vault_root, binding.remote_path);
    if (await pathExists(boundPath)) {
      if (binding.ko_content_hash === object.content_hash) {
        return { ko_id: object.ko_id, action: 'skip_unchanged', binding_id: binding.binding_id, remote_path: binding.remote_path };
      }

      const markdown = await readTextIfExists(boundPath);
      const frontmatter = markdown ? parseFrontmatter(markdown) : null;
      if (!frontmatter) {
        return { ko_id: object.ko_id, action: 'conflict', binding_id: binding.binding_id, remote_path: binding.remote_path, conflict_code: 'frontmatter_identity_missing' };
      }
      if (frontmatter.frontmatter.inkloop_id !== object.ko_id) {
        return { ko_id: object.ko_id, action: 'conflict', binding_id: binding.binding_id, remote_path: binding.remote_path, conflict_code: 'frontmatter_identity_mismatch' };
      }
      return { ko_id: object.ko_id, action: 'update', binding_id: binding.binding_id, remote_path: binding.remote_path, preview_markdown: payload.markdown };
    }

    if (existingById.length === 1) {
      return {
        ko_id: object.ko_id,
        action: 'relink_then_update',
        binding_id: binding.binding_id,
        remote_path: existingById[0].remotePath,
        preview_markdown: payload.markdown,
        reason: 'Binding path missing; relinking by frontmatter inkloop_id.',
      };
    }
    return {
      ko_id: object.ko_id,
      action: 'create',
      binding_id: binding.binding_id,
      remote_path: payload.remote_path,
      preview_markdown: payload.markdown,
      reason: 'Previous remote file missing; creating a new projection.',
    };
  }

  async exportObjects(input: ExportObjectsInput): Promise<ExportRunResult> {
    const policy = input.policy ?? DefaultObsidianFsPolicy;
    const objects = (await normalizeKnowledgeObjectsForProjectionTitles(input.objects, input.documentProjections)) ?? [];
    const plan = await this.plan({ ...input, objects, policy });
    const results: ApplyResult[] = [];

    for (const item of plan.items) {
      if (item.action.startsWith('skip_')) {
        await input.storage.appendSyncEvent({
          event_id: adapterId('evt'),
          provider: this.manifest.provider,
          ko_id: item.ko_id,
          level: 'info',
          type: 'file.skipped_unchanged',
          message: item.reason ?? item.action,
          created_at: new Date().toISOString(),
        });
        results.push({ action: item.action, remote_path: item.remote_path });
        continue;
      }
      if (item.action === 'conflict') {
        const conflict = await this.recordConflict({
          target: input.target,
          storage: input.storage,
          object: objects.find((object) => object.ko_id === item.ko_id)!,
          binding: item.binding_id ? (await input.storage.listBindings({ target_id: input.target.target_id })).find((binding) => binding.binding_id === item.binding_id) : undefined,
          code: item.conflict_code ?? 'schema_version_unsupported',
          remotePath: item.remote_path,
          detail: item.reason ?? 'Export plan detected a conflict.',
        });
        results.push({ action: 'conflict', conflict });
        continue;
      }

      const object = objects.find((candidate) => candidate.ko_id === item.ko_id);
      if (!object) continue;
      const binding = await input.storage.getBinding(input.target.target_id, object.ko_id);
      const payload = await this.render({ object, target: input.target });
      results.push(await this.apply({ object, target: input.target, payload, binding, policy, storage: input.storage, plannedRemotePath: item.remote_path }));
    }

    return { plan, results };
  }

  async apply(input: {
    object: KnowledgeObject;
    target: ObsidianFsTarget;
    payload: ObsidianFsPayload;
    binding?: ExternalBinding | null;
    policy?: SyncPolicy;
    storage: AdapterStoragePort;
    plannedRemotePath?: string;
  }): Promise<ApplyResult> {
    const policy = input.policy ?? DefaultObsidianFsPolicy;
    const existingBinding = input.binding ?? (await input.storage.getBinding(input.target.target_id, input.object.ko_id));
    const now = new Date().toISOString();

    await this.ensureTargetDirs(input.target);
    if (input.target.create_source_notes) await this.writeSourceNote(input.target, input.object, now);

    if (!existingBinding && input.plannedRemotePath) {
      const relinkBinding = await this.bindingFromExistingFile({
        target: input.target,
        object: input.object,
        remotePath: input.plannedRemotePath,
        payload: input.payload,
        now,
      });
      if (relinkBinding) {
        return this.apply({ ...input, binding: relinkBinding, plannedRemotePath: input.plannedRemotePath });
      }
    }

    if (!existingBinding) return this.createFile({ ...input, now, binding: null });

    const relinkPath = input.plannedRemotePath && input.plannedRemotePath !== existingBinding.remote_path ? input.plannedRemotePath : existingBinding.remote_path;
    const absolutePath = fromVaultRelative(input.target.vault_root, relinkPath);
    const existingMarkdown = await readTextIfExists(absolutePath);

    if (!existingMarkdown) {
      await this.recordConflict({
        target: input.target,
        storage: input.storage,
        object: input.object,
        binding: existingBinding,
        code: 'remote_file_missing',
        remotePath: existingBinding.remote_path,
        detail: 'Previously exported Obsidian file is missing; creating a new projection.',
      });
      return this.createFile({ ...input, now, binding: existingBinding });
    }

    const parsed = parseFrontmatter(existingMarkdown);
    if (!parsed) {
      await this.recordConflict({
        target: input.target,
        storage: input.storage,
        object: input.object,
        binding: existingBinding,
        code: 'frontmatter_identity_missing',
        remotePath: relinkPath,
        detail: 'Remote file has no InkLoop frontmatter identity; creating a new projection.',
      });
      return this.createFile({ ...input, now, binding: existingBinding });
    }

    if (parsed.frontmatter.inkloop_id !== input.object.ko_id) {
      await this.recordConflict({
        target: input.target,
        storage: input.storage,
        object: input.object,
        binding: existingBinding,
        code: 'frontmatter_identity_mismatch',
        remotePath: relinkPath,
        detail: 'Remote file frontmatter identity does not match the binding.',
      });
      return this.createFile({ ...input, now, binding: existingBinding });
    }

    const replace = await replaceControlledSection({
      existingMarkdown,
      koId: input.object.ko_id,
      oldRenderBodyHash: existingBinding.render_body_hash,
      newSection: input.payload.controlled_section,
    });

    let nextMarkdown: string;
    if (replace.type === 'replaced') {
      nextMarkdown = replace.markdown;
    } else if (replace.type === 'controlled_section_modified' && policy.conflict_strategy === 'append_new_version') {
      const [section] = findInkloopSections(existingMarkdown, input.object.ko_id);
      nextMarkdown = snapshotAndReplaceControlledSection({
        existingMarkdown,
        section,
        newSection: input.payload.controlled_section,
        detectedAt: now,
      });
      await this.recordConflict({
        target: input.target,
        storage: input.storage,
        object: input.object,
        binding: existingBinding,
        code: 'controlled_section_modified',
        remotePath: relinkPath,
        localContentHash: input.object.content_hash,
        remoteRenderBodyHash: replace.currentSectionHash,
        detail: 'Controlled section was edited in Obsidian; old section was snapshotted and a new controlled section was appended.',
      });
    } else {
      const code: ConflictCode = replace.type === 'missing_section' ? 'missing_controlled_section' : 'duplicate_controlled_sections';
      const conflict = await this.recordConflict({
        target: input.target,
        storage: input.storage,
        object: input.object,
        binding: existingBinding,
        code,
        remotePath: relinkPath,
        detail: `Could not safely replace controlled section: ${replace.type}.`,
      });
      return { action: 'conflict', conflict, remote_path: relinkPath };
    }

    nextMarkdown = replaceFrontmatter(nextMarkdown, frontmatterForKnowledgeObject(input.object, input.payload.render_body_hash));
    await atomicWrite(absolutePath, nextMarkdown);
    const binding = await this.upsertBinding({
      target: input.target,
      object: input.object,
      storage: input.storage,
      existing: existingBinding,
      remotePath: relinkPath,
      renderBodyHash: input.payload.render_body_hash,
      now,
    });

    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      binding_id: binding.binding_id,
      ko_id: input.object.ko_id,
      provider: this.manifest.provider,
      level: 'info',
      type: 'file.updated',
      message: `Updated ${relinkPath}`,
      created_at: now,
    });
    return { action: 'updated', binding, remote_path: relinkPath };
  }

  private async createFile(input: {
    object: KnowledgeObject;
    target: ObsidianFsTarget;
    payload: ObsidianFsPayload;
    storage: AdapterStoragePort;
    binding: ExternalBinding | null;
    now: string;
  }): Promise<ApplyResult> {
    const pathInfo = await this.availablePath(input.target, input.payload.remote_path);
    await atomicWrite(pathInfo.absolutePath, input.payload.markdown);
    const binding = await this.upsertBinding({
      target: input.target,
      object: input.object,
      storage: input.storage,
      existing: input.binding,
      remotePath: pathInfo.remotePath,
      renderBodyHash: input.payload.render_body_hash,
      now: input.now,
    });
    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      binding_id: binding.binding_id,
      ko_id: input.object.ko_id,
      provider: this.manifest.provider,
      level: 'info',
      type: input.binding ? 'file.recreated_after_missing' : 'file.created',
      message: `Created ${pathInfo.remotePath}`,
      created_at: input.now,
    });
    return { action: 'created', binding, remote_path: pathInfo.remotePath };
  }

  private async bindingFromExistingFile(input: {
    target: ObsidianFsTarget;
    object: KnowledgeObject;
    remotePath: string;
    payload: ObsidianFsPayload;
    now: string;
  }): Promise<ExternalBinding | null> {
    const absolutePath = fromVaultRelative(input.target.vault_root, input.remotePath);
    const markdown = await readTextIfExists(absolutePath);
    if (!markdown) return null;
    const parsed = parseFrontmatter(markdown);
    if (parsed?.frontmatter.inkloop_id !== input.object.ko_id) return null;

    return {
      binding_id: adapterId('bind'),
      provider: this.manifest.provider,
      target_id: input.target.target_id,
      ko_id: input.object.ko_id,
      ko_content_hash: typeof parsed.frontmatter.inkloop_content_hash === 'string' ? (parsed.frontmatter.inkloop_content_hash as Sha256) : input.object.content_hash,
      render_body_hash: typeof parsed.frontmatter.inkloop_render_body_hash === 'string' ? (parsed.frontmatter.inkloop_render_body_hash as Sha256) : input.payload.render_body_hash,
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
      if (!(await pathExists(candidate))) {
        return { absolutePath: candidate, remotePath: toVaultRelative(target.vault_root, candidate) };
      }
    }
    throw new Error(`Unable to find available path for ${remotePath}`);
  }

  private async upsertBinding(input: {
    target: ObsidianFsTarget;
    object: KnowledgeObject;
    storage: AdapterStoragePort;
    existing: ExternalBinding | null;
    remotePath: string;
    renderBodyHash: Sha256;
    now: string;
  }): Promise<ExternalBinding> {
    const binding: ExternalBinding = {
      binding_id: input.existing?.binding_id ?? adapterId('bind'),
      provider: this.manifest.provider,
      target_id: input.target.target_id,
      ko_id: input.object.ko_id,
      ko_content_hash: input.object.content_hash,
      render_body_hash: input.renderBodyHash,
      remote_id: `remote_${(await sha256Hex(`${input.target.vault_root}:${input.remotePath}`)).slice(0, 24)}`,
      remote_path: input.remotePath,
      remote_url: undefined,
      remote_rev: undefined,
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
      ko_id: input.object.ko_id,
      provider: this.manifest.provider,
      level: 'info',
      type: input.existing ? 'binding.updated' : 'binding.created',
      message: input.existing ? 'Updated ExternalBinding.' : 'Created ExternalBinding.',
      created_at: input.now,
    });
    return binding;
  }

  private async recordConflict(input: {
    target: ObsidianFsTarget;
    storage: AdapterStoragePort;
    object: KnowledgeObject;
    binding?: ExternalBinding | null;
    code: ConflictCode;
    remotePath?: string;
    localContentHash?: Sha256;
    remoteRenderBodyHash?: Sha256;
    detail: string;
  }): Promise<ConflictRecord> {
    const now = new Date().toISOString();
    const conflict: ConflictRecord = {
      conflict_id: adapterId('conflict'),
      provider: this.manifest.provider,
      target_id: input.target.target_id,
      ko_id: input.object.ko_id,
      binding_id: input.binding?.binding_id,
      code: input.code,
      severity: input.code === 'controlled_section_modified' ? 'medium' : 'high',
      remote_path: input.remotePath,
      local_content_hash: input.localContentHash,
      remote_render_body_hash: input.remoteRenderBodyHash,
      resolution_status: 'open',
      resolution_strategy: input.code === 'controlled_section_modified' ? 'append_new_version' : 'create_new_file',
      detail: input.detail,
      created_at: now,
      updated_at: now,
    };
    await input.storage.createConflict(conflict);
    await input.storage.appendSyncEvent({
      event_id: adapterId('evt'),
      binding_id: input.binding?.binding_id,
      ko_id: input.object.ko_id,
      provider: this.manifest.provider,
      level: 'warn',
      type: 'conflict.detected',
      message: input.detail,
      data: { code: input.code, remote_path: input.remotePath },
      created_at: now,
    });
    return conflict;
  }

  private async ensureTargetDirs(target: ObsidianFsTarget): Promise<void> {
    await Promise.all([
      ensureDir(target.notes_dir),
      ensureDir(target.sources_dir),
      ensureDir(target.tasks_dir),
      ensureDir(target.summaries_dir),
      ensureDir(target.concepts_dir),
      ensureDir(target.assets_dir),
    ]);
  }

  private async writeSourceNote(target: ObsidianFsTarget, ko: KnowledgeObject, now: string): Promise<void> {
    const sourcePath = pathForSourceNote(target, ko.source.document_title, ko.source.document_id);
    if (await pathExists(sourcePath.absolutePath)) return;
    await mkdir(path.dirname(sourcePath.absolutePath), { recursive: true });
    await atomicWrite(
      sourcePath.absolutePath,
      renderSourceNote({
        documentId: ko.source.document_id,
        documentTitle: ko.source.document_title,
        now,
      }),
    );
  }

  async pullMetadata(input: { target: ObsidianFsTarget; bindings: ExternalBinding[] }) {
    return pullObsidianMetadata(input);
  }
}

export const obsidianFsAdapter = new ObsidianFsAdapter();
