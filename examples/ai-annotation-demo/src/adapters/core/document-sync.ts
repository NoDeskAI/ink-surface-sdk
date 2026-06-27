import type { ExternalEdit } from '../../knowledge/external-edit';
import type { AdapterManifest } from './types';

export interface AdapterCapabilityCheck {
  ok: boolean;
  code?: 'ADAPTER_PULL_UNSUPPORTED';
  message?: string;
}

export function externalEditStorageKey(edit: Pick<ExternalEdit, 'edit_id'>): string {
  return edit.edit_id;
}

export function isPendingDocumentEdit(edit: ExternalEdit): boolean {
  return edit.kind === 'document_body' && edit.status === 'pending';
}

export function checkExternalEditPullCapability(manifest: Pick<AdapterManifest, 'direction' | 'capabilities'>): AdapterCapabilityCheck {
  if (manifest.direction !== 'bidirectional' || !manifest.capabilities.read) {
    return {
      ok: false,
      code: 'ADAPTER_PULL_UNSUPPORTED',
      message: 'Adapter must be bidirectional and readable to pull external edits.',
    };
  }
  return { ok: true };
}
