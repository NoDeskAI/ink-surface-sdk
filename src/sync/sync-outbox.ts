import type { ExternalEdit } from '../knowledge/external-edit';

export interface SyncOutboxItem {
  outbox_id: string;
  kind: 'external_edit';
  status: 'pending' | 'sent' | 'failed';
  document_id: string;
  payload: ExternalEdit;
  created_at: string;
  updated_at: string;
}

export function externalEditToOutboxItem(edit: ExternalEdit): SyncOutboxItem {
  return {
    outbox_id: `outbox_${edit.edit_id}`,
    kind: 'external_edit',
    status: 'pending',
    document_id: edit.document_id,
    payload: edit,
    created_at: edit.created_at,
    updated_at: edit.updated_at,
  };
}
