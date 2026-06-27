import type {
  AdapterStoragePort,
  BindingQuery,
  ConflictQuery,
  ConflictRecord,
  ExternalEditQuery,
  ExternalBinding,
  SyncEvent,
  SyncJob,
} from './types';
import type { ExternalEdit } from '../../knowledge/external-edit';

function matches(item: Record<string, unknown>, query: object): boolean {
  return Object.entries(query as Record<string, unknown>).every(([key, value]) => value === undefined || item[key] === value);
}

export class MemoryAdapterStorage implements AdapterStoragePort {
  readonly bindings = new Map<string, ExternalBinding>();
  readonly jobs = new Map<string, SyncJob>();
  readonly events: SyncEvent[] = [];
  readonly conflicts = new Map<string, ConflictRecord>();
  readonly externalEdits = new Map<string, ExternalEdit>();

  async getBinding(targetId: string, koId: string): Promise<ExternalBinding | null> {
    return [...this.bindings.values()].find((binding) => binding.target_id === targetId && binding.ko_id === koId) ?? null;
  }

  async upsertBinding(binding: ExternalBinding): Promise<void> {
    this.bindings.set(binding.binding_id, binding);
  }

  async listBindings(query: BindingQuery): Promise<ExternalBinding[]> {
    return [...this.bindings.values()].filter((binding) => matches(binding as unknown as Record<string, unknown>, query));
  }

  async createSyncJob(job: SyncJob): Promise<void> {
    this.jobs.set(job.job_id, job);
  }

  async updateSyncJob(job: SyncJob): Promise<void> {
    this.jobs.set(job.job_id, job);
  }

  async getSyncJob(jobId: string): Promise<SyncJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async appendSyncEvent(event: SyncEvent): Promise<void> {
    this.events.push(event);
  }

  async createConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.set(conflict.conflict_id, conflict);
  }

  async updateConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.set(conflict.conflict_id, conflict);
  }

  async listConflicts(query: ConflictQuery): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()].filter((conflict) => matches(conflict as unknown as Record<string, unknown>, query));
  }

  async upsertExternalEdit(edit: ExternalEdit): Promise<void> {
    this.externalEdits.set(edit.edit_id, edit);
  }

  async listExternalEdits(query: ExternalEditQuery): Promise<ExternalEdit[]> {
    return [...this.externalEdits.values()].filter((edit) => matches(edit as unknown as Record<string, unknown>, query));
  }
}
