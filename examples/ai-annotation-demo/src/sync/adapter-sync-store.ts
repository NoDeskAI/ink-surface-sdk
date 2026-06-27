import type { ConflictRecord } from '../adapters/core/types';
import type { DocumentProjection } from '../knowledge/document-projection';
import type { ExternalEdit } from '../knowledge/external-edit';

export interface AdapterSyncCursor {
  cursor_id: string;
  provider: string;
  target_id: string;
  document_id: string;
  remote_path?: string;
  remote_revision?: string;
  last_pulled_at?: string;
  last_pushed_at?: string;
  updated_at: string;
}

export interface AdapterSyncStorePort {
  upsertDocumentProjection(projection: DocumentProjection): Promise<void>;
  listDocumentProjections(query?: { document_id?: string; projection_id?: string }): Promise<DocumentProjection[]>;
  upsertExternalEdit(edit: ExternalEdit): Promise<void>;
  listExternalEdits(query?: { document_id?: string; projection_id?: string; status?: ExternalEdit['status'] }): Promise<ExternalEdit[]>;
  upsertConflict(conflict: ConflictRecord): Promise<void>;
  listConflicts(query?: { ko_id?: string; resolution_status?: ConflictRecord['resolution_status'] }): Promise<ConflictRecord[]>;
  upsertCursor(cursor: AdapterSyncCursor): Promise<void>;
  listCursors(query?: { document_id?: string; target_id?: string; provider?: string }): Promise<AdapterSyncCursor[]>;
}

function matches(item: Record<string, unknown>, query: object = {}): boolean {
  return Object.entries(query as Record<string, unknown>).every(([key, value]) => value === undefined || item[key] === value);
}

export class MemoryAdapterSyncStore implements AdapterSyncStorePort {
  private readonly projections = new Map<string, DocumentProjection>();
  private readonly externalEdits = new Map<string, ExternalEdit>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  private readonly cursors = new Map<string, AdapterSyncCursor>();

  async upsertDocumentProjection(projection: DocumentProjection): Promise<void> {
    this.projections.set(projection.projection_id, projection);
  }

  async listDocumentProjections(query: { document_id?: string; projection_id?: string } = {}): Promise<DocumentProjection[]> {
    return [...this.projections.values()].filter((projection) => matches(projection as unknown as Record<string, unknown>, query));
  }

  async upsertExternalEdit(edit: ExternalEdit): Promise<void> {
    this.externalEdits.set(edit.edit_id, edit);
  }

  async listExternalEdits(query: { document_id?: string; projection_id?: string; status?: ExternalEdit['status'] } = {}): Promise<ExternalEdit[]> {
    return [...this.externalEdits.values()].filter((edit) => matches(edit as unknown as Record<string, unknown>, query));
  }

  async upsertConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.set(conflict.conflict_id, conflict);
  }

  async listConflicts(query: { ko_id?: string; resolution_status?: ConflictRecord['resolution_status'] } = {}): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()].filter((conflict) => matches(conflict as unknown as Record<string, unknown>, query));
  }

  async upsertCursor(cursor: AdapterSyncCursor): Promise<void> {
    this.cursors.set(cursor.cursor_id, cursor);
  }

  async listCursors(query: { document_id?: string; target_id?: string; provider?: string } = {}): Promise<AdapterSyncCursor[]> {
    return [...this.cursors.values()].filter((cursor) => matches(cursor as unknown as Record<string, unknown>, query));
  }
}

export function syncCursorId(input: { provider: string; target_id: string; document_id: string }): string {
  return `${input.provider}:${input.target_id}:${input.document_id}`;
}
