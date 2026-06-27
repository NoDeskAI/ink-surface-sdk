import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryAdapterStorage } from '../core/memory-storage';
import type { ExternalEdit } from '../../knowledge/external-edit';
import type { ConflictRecord, ExternalBinding, SyncEvent, SyncJob } from '../core/types';
import { DEFAULT_OBSIDIAN_BASE_DIR } from './target';
import { atomicWrite } from './fs-writer';

interface AdapterStateFile {
  bindings: ExternalBinding[];
  jobs: SyncJob[];
  events: SyncEvent[];
  conflicts: ConflictRecord[];
  externalEdits?: ExternalEdit[];
}

export class JsonAdapterStorage extends MemoryAdapterStorage {
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly readOnly = false,
  ) {
    super();
  }

  static forVault(vaultRoot: string, baseDir = DEFAULT_OBSIDIAN_BASE_DIR, options: { readOnly?: boolean } = {}): JsonAdapterStorage {
    return new JsonAdapterStorage(path.join(vaultRoot, baseDir, '.inkloop-adapter-state.json'), options.readOnly ?? false);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const state = JSON.parse(await readFile(this.filePath, 'utf8')) as AdapterStateFile;
      for (const binding of state.bindings ?? []) this.bindings.set(binding.binding_id, binding);
      for (const job of state.jobs ?? []) this.jobs.set(job.job_id, job);
      for (const event of state.events ?? []) this.events.push(event);
      for (const conflict of state.conflicts ?? []) this.conflicts.set(conflict.conflict_id, conflict);
      for (const edit of state.externalEdits ?? []) this.externalEdits.set(edit.edit_id, edit);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined;
      if (code === 'ENOENT') return;
      throw error;
    }
  }

  private async save(): Promise<void> {
    if (this.readOnly) return;
    const state: AdapterStateFile = {
      bindings: [...this.bindings.values()],
      jobs: [...this.jobs.values()],
      events: this.events,
      conflicts: [...this.conflicts.values()],
      externalEdits: [...this.externalEdits.values()],
    };
    await atomicWrite(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  override async getBinding(targetId: string, koId: string) {
    await this.load();
    return super.getBinding(targetId, koId);
  }

  override async upsertBinding(binding: ExternalBinding): Promise<void> {
    await this.load();
    await super.upsertBinding(binding);
    await this.save();
  }

  override async listBindings(query: Parameters<MemoryAdapterStorage['listBindings']>[0]) {
    await this.load();
    return super.listBindings(query);
  }

  override async createSyncJob(job: SyncJob): Promise<void> {
    await this.load();
    await super.createSyncJob(job);
    await this.save();
  }

  override async updateSyncJob(job: SyncJob): Promise<void> {
    await this.load();
    await super.updateSyncJob(job);
    await this.save();
  }

  override async getSyncJob(jobId: string) {
    await this.load();
    return super.getSyncJob(jobId);
  }

  override async appendSyncEvent(event: SyncEvent): Promise<void> {
    await this.load();
    await super.appendSyncEvent(event);
    await this.save();
  }

  override async createConflict(conflict: ConflictRecord): Promise<void> {
    await this.load();
    await super.createConflict(conflict);
    await this.save();
  }

  override async updateConflict(conflict: ConflictRecord): Promise<void> {
    await this.load();
    await super.updateConflict(conflict);
    await this.save();
  }

  override async listConflicts(query: Parameters<MemoryAdapterStorage['listConflicts']>[0]) {
    await this.load();
    return super.listConflicts(query);
  }

  override async upsertExternalEdit(edit: ExternalEdit): Promise<void> {
    await this.load();
    await super.upsertExternalEdit(edit);
    await this.save();
  }

  override async listExternalEdits(query: Parameters<MemoryAdapterStorage['listExternalEdits']>[0]) {
    await this.load();
    return super.listExternalEdits(query);
  }
}
