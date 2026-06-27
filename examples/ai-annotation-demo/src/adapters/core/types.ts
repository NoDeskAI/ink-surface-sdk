import type { ExternalEdit } from '../../knowledge/external-edit';
import type { KnowledgeObject, KnowledgeStatus, Privacy, Sha256 } from '../../knowledge/knowledge-object';

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  warnings?: ValidationIssue[];
}

export interface AdapterManifest {
  provider: 'obsidian_fs' | 'obsidian_plugin' | 'markdown' | 'notion' | string;
  display_name: string;
  version: string;
  direction: 'push' | 'pull' | 'bidirectional';
  auth: 'none' | 'local_fs' | 'plugin_token' | 'oauth' | 'api_key';
  capabilities: {
    create: boolean;
    update: boolean;
    append: boolean;
    delete: boolean;
    read: boolean;
    pull_metadata: boolean;
    deep_link: boolean;
    attachments: boolean;
    controlled_sections: boolean;
    frontmatter: boolean;
  };
}

export interface ExportPlan {
  plan_id: string;
  provider: string;
  target_id: string;
  created_at: string;
  items: ExportPlanItem[];
  summary: {
    create_count: number;
    update_count: number;
    skip_count: number;
    conflict_count: number;
  };
}

export interface ExportPlanItem {
  ko_id: string;
  action:
    | 'create'
    | 'update'
    | 'skip_unchanged'
    | 'skip_privacy'
    | 'skip_status'
    | 'conflict'
    | 'relink_then_update';
  reason?: string;
  binding_id?: string;
  remote_path?: string;
  preview_markdown?: string;
  conflict_code?: ConflictCode;
}

export interface ExternalBinding {
  binding_id: string;
  provider: 'obsidian_fs' | 'obsidian_plugin' | string;
  target_id: string;
  ko_id: string;
  ko_content_hash: Sha256;
  render_body_hash: Sha256;
  remote_id: string;
  remote_path: string;
  remote_url?: string;
  remote_rev?: string;
  mapping_version: 'inkloop.obsidian.mapping.v1';
  sync_state:
    | 'active'
    | 'queued'
    | 'remote_changed'
    | 'remote_missing'
    | 'duplicate_remote'
    | 'conflict'
    | 'error'
    | 'archived';
  last_exported_at: string;
  last_seen_remote_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface SyncJob {
  job_id: string;
  provider: string;
  target_id: string;
  direction: 'push' | 'pull_metadata';
  ko_ids: string[];
  status: 'queued' | 'running' | 'succeeded' | 'partial_succeeded' | 'failed' | 'blocked';
  priority: 'interactive' | 'background';
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  last_error?: string;
  plan_id?: string;
}

export interface SyncEvent {
  event_id: string;
  job_id?: string;
  binding_id?: string;
  ko_id?: string;
  provider: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  type:
    | 'plan.created'
    | 'file.created'
    | 'file.updated'
    | 'file.skipped_unchanged'
    | 'binding.created'
    | 'binding.updated'
    | 'conflict.detected'
    | 'external_edit.detected'
    | 'remote_missing'
    | 'duplicate_remote'
    | 'job.completed'
    | 'job.failed'
    | 'file.recreated_after_missing';
  message: string;
  data?: Record<string, unknown>;
  created_at: string;
}

export type ConflictCode =
  | 'controlled_section_modified'
  | 'missing_controlled_section'
  | 'duplicate_controlled_sections'
  | 'frontmatter_identity_missing'
  | 'frontmatter_identity_mismatch'
  | 'remote_file_missing'
  | 'duplicate_remote_files'
  | 'write_permission_denied'
  | 'invalid_vault'
  | 'schema_version_unsupported';

export interface ConflictRecord {
  conflict_id: string;
  provider: string;
  target_id: string;
  ko_id: string;
  binding_id?: string;
  code: ConflictCode;
  severity: 'low' | 'medium' | 'high';
  remote_path?: string;
  local_content_hash?: Sha256;
  remote_render_body_hash?: Sha256;
  resolution_status: 'open' | 'resolved' | 'ignored';
  resolution_strategy?: 'append_new_version' | 'overwrite_controlled_section' | 'create_new_file' | 'relink_existing_file' | 'ignore_remote';
  detail: string;
  created_at: string;
  updated_at: string;
}

export interface SyncPolicy {
  content_authority: 'inkloop' | 'manual';
  metadata_authority: 'inkloop' | 'remote' | 'merge';
  conflict_strategy: 'skip' | 'append_new_version' | 'ask_user' | 'inkloop_wins';
  privacy_filter: Privacy[];
  delete_policy: 'never_delete_remote' | 'trash_remote_on_archive';
  allowed_statuses: KnowledgeStatus[];
}

export const DefaultObsidianFsPolicy: SyncPolicy = {
  content_authority: 'inkloop',
  metadata_authority: 'merge',
  conflict_strategy: 'append_new_version',
  privacy_filter: ['export_allowed'],
  delete_policy: 'never_delete_remote',
  allowed_statuses: ['export_ready', 'accepted', 'edited'],
};

export interface BindingQuery {
  provider?: string;
  target_id?: string;
  ko_id?: string;
  sync_state?: ExternalBinding['sync_state'];
}

export interface ConflictQuery {
  provider?: string;
  target_id?: string;
  ko_id?: string;
  resolution_status?: ConflictRecord['resolution_status'];
}

export interface ExternalEditQuery {
  edit_id?: string;
  document_id?: string;
  projection_id?: string;
  ko_id?: string;
  kind?: ExternalEdit['kind'];
  status?: ExternalEdit['status'];
}

export interface AdapterStoragePort {
  getBinding(targetId: string, koId: string): Promise<ExternalBinding | null>;
  upsertBinding(binding: ExternalBinding): Promise<void>;
  listBindings(query: BindingQuery): Promise<ExternalBinding[]>;
  createSyncJob(job: SyncJob): Promise<void>;
  updateSyncJob(job: SyncJob): Promise<void>;
  getSyncJob(jobId: string): Promise<SyncJob | null>;
  appendSyncEvent(event: SyncEvent): Promise<void>;
  createConflict(conflict: ConflictRecord): Promise<void>;
  updateConflict(conflict: ConflictRecord): Promise<void>;
  listConflicts(query: ConflictQuery): Promise<ConflictRecord[]>;
  upsertExternalEdit(edit: ExternalEdit): Promise<void>;
  listExternalEdits(query: ExternalEditQuery): Promise<ExternalEdit[]>;
}

export interface ApplyResult {
  action: ExportPlanItem['action'] | 'created' | 'updated';
  binding?: ExternalBinding;
  remote_path?: string;
  conflict?: ConflictRecord;
}

export interface PullMetadataResult {
  updates: Array<{
    ko_id: string;
    remote_path: string;
    metadata: {
      status?: KnowledgeStatus;
      tags?: string[];
      completed?: boolean;
    };
  }>;
  warnings: ValidationIssue[];
}

export interface ExportAdapter<Config, Target, Payload> {
  manifest: AdapterManifest;
  validateConfig(config: Config): Promise<ValidationResult>;
  resolveTarget(config: Config): Promise<Target>;
  plan(input: {
    objects: KnowledgeObject[];
    target: Target;
    storage: AdapterStoragePort;
    policy: SyncPolicy;
  }): Promise<ExportPlan>;
  render(input: {
    object: KnowledgeObject;
    target: Target;
    binding?: ExternalBinding;
  }): Promise<Payload>;
  apply(input: {
    object: KnowledgeObject;
    target: Target;
    payload: Payload;
    binding?: ExternalBinding;
    policy: SyncPolicy;
    storage: AdapterStoragePort;
  }): Promise<ApplyResult>;
  pullMetadata?(input: {
    target: Target;
    bindings: ExternalBinding[];
  }): Promise<PullMetadataResult>;
}

export type AdapterErrorCode =
  | 'KO_SCHEMA_INVALID'
  | 'KO_PRIVACY_BLOCKED'
  | 'KO_STATUS_NOT_EXPORTABLE'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_NOT_WRITABLE'
  | 'FILE_WRITE_FAILED'
  | 'FILE_READ_FAILED'
  | 'FRONTMATTER_PARSE_FAILED'
  | 'CONTROLLED_SECTION_MISSING'
  | 'CONTROLLED_SECTION_MODIFIED'
  | 'DUPLICATE_CONTROLLED_SECTIONS'
  | 'REMOTE_FILE_MISSING'
  | 'DUPLICATE_REMOTE_FILES'
  | 'IDENTITY_MISMATCH'
  | 'UNKNOWN';
