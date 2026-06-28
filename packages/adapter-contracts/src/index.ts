export type AdapterAuthority = 'client_local' | 'cloud_api' | 'hybrid';
export type AdapterExecutionContext = 'client' | 'backend';

export type AdapterOperation =
  | 'export_document'
  | 'pull_external_edits'
  | 'watch_local_changes'
  | 'sync_cloud_api'
  | 'resolve_conflict'
  | 'read_asset'
  | 'write_asset';

export interface AdapterAuthorityDescriptor {
  adapter_id: string;
  authority: AdapterAuthority;
  client_operations: AdapterOperation[];
  backend_operations: AdapterOperation[];
  notes?: string;
}

export interface AdapterAuthorityIssue {
  path: string;
  message: string;
}

export const OBSIDIAN_FS_ADAPTER_AUTHORITY: AdapterAuthorityDescriptor = {
  adapter_id: 'obsidian-fs',
  authority: 'client_local',
  client_operations: ['export_document', 'pull_external_edits', 'watch_local_changes', 'resolve_conflict', 'read_asset', 'write_asset'],
  backend_operations: [],
  notes: 'Requires access to a user-controlled local Obsidian vault.',
};

export const NOTION_API_ADAPTER_AUTHORITY: AdapterAuthorityDescriptor = {
  adapter_id: 'notion-api',
  authority: 'cloud_api',
  client_operations: [],
  backend_operations: ['export_document', 'pull_external_edits', 'sync_cloud_api', 'resolve_conflict'],
  notes: 'Uses cloud API credentials and scheduled backend sync jobs.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validOperation(value: unknown): value is AdapterOperation {
  return typeof value === 'string' && [
    'export_document',
    'pull_external_edits',
    'watch_local_changes',
    'sync_cloud_api',
    'resolve_conflict',
    'read_asset',
    'write_asset',
  ].includes(value);
}

export function validateAdapterAuthorityDescriptor(value: unknown): AdapterAuthorityIssue[] {
  const issues: AdapterAuthorityIssue[] = [];
  if (!isRecord(value)) return [{ path: '', message: 'must be an object' }];
  if (typeof value.adapter_id !== 'string' || value.adapter_id === '') issues.push({ path: 'adapter_id', message: 'must be a non-empty string' });
  if (!['client_local', 'cloud_api', 'hybrid'].includes(String(value.authority))) issues.push({ path: 'authority', message: 'must be client_local, cloud_api, or hybrid' });
  if (!Array.isArray(value.client_operations) || !value.client_operations.every(validOperation)) issues.push({ path: 'client_operations', message: 'must be supported adapter operations' });
  if (!Array.isArray(value.backend_operations) || !value.backend_operations.every(validOperation)) issues.push({ path: 'backend_operations', message: 'must be supported adapter operations' });

  if (value.authority === 'client_local' && Array.isArray(value.backend_operations) && value.backend_operations.length > 0) {
    issues.push({ path: 'backend_operations', message: 'client-local adapters cannot declare backend operations' });
  }
  if (value.authority === 'cloud_api' && Array.isArray(value.client_operations) && value.client_operations.length > 0) {
    issues.push({ path: 'client_operations', message: 'cloud API adapters should not require client-only operations' });
  }
  return issues;
}

export function canRunAdapterOperation(
  descriptor: AdapterAuthorityDescriptor,
  context: AdapterExecutionContext,
  operation: AdapterOperation,
): boolean {
  return context === 'client'
    ? descriptor.client_operations.includes(operation)
    : descriptor.backend_operations.includes(operation);
}

export function assertAdapterOperationAllowed(
  descriptor: AdapterAuthorityDescriptor,
  context: AdapterExecutionContext,
  operation: AdapterOperation,
): void {
  const issues = validateAdapterAuthorityDescriptor(descriptor);
  if (issues.length > 0) throw new Error(`Invalid adapter authority descriptor: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  if (!canRunAdapterOperation(descriptor, context, operation)) {
    throw new Error(`Adapter ${descriptor.adapter_id} cannot run ${operation} in ${context} context.`);
  }
}
