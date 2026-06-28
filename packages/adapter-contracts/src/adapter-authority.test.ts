import { describe, expect, it } from 'vitest';
import {
  NOTION_API_ADAPTER_AUTHORITY,
  OBSIDIAN_FS_ADAPTER_AUTHORITY,
  assertAdapterOperationAllowed,
  canRunAdapterOperation,
  validateAdapterAuthorityDescriptor,
} from './index';

describe('adapter authority contracts', () => {
  it('classifies Obsidian FS as client-local and blocks backend execution', () => {
    expect(validateAdapterAuthorityDescriptor(OBSIDIAN_FS_ADAPTER_AUTHORITY)).toEqual([]);
    expect(canRunAdapterOperation(OBSIDIAN_FS_ADAPTER_AUTHORITY, 'client', 'export_document')).toBe(true);
    expect(canRunAdapterOperation(OBSIDIAN_FS_ADAPTER_AUTHORITY, 'backend', 'export_document')).toBe(false);
    expect(() => assertAdapterOperationAllowed(OBSIDIAN_FS_ADAPTER_AUTHORITY, 'backend', 'export_document')).toThrow(/cannot run/);
  });

  it('classifies Notion-like API adapters as backend-capable cloud adapters', () => {
    expect(validateAdapterAuthorityDescriptor(NOTION_API_ADAPTER_AUTHORITY)).toEqual([]);
    expect(canRunAdapterOperation(NOTION_API_ADAPTER_AUTHORITY, 'backend', 'sync_cloud_api')).toBe(true);
    expect(canRunAdapterOperation(NOTION_API_ADAPTER_AUTHORITY, 'client', 'sync_cloud_api')).toBe(false);
  });

  it('allows hybrid adapters to split operation placement explicitly', () => {
    const descriptor = {
      adapter_id: 'icloud-drive',
      authority: 'hybrid' as const,
      client_operations: ['read_asset' as const, 'write_asset' as const, 'watch_local_changes' as const],
      backend_operations: ['resolve_conflict' as const],
    };

    expect(validateAdapterAuthorityDescriptor(descriptor)).toEqual([]);
    expect(canRunAdapterOperation(descriptor, 'client', 'read_asset')).toBe(true);
    expect(canRunAdapterOperation(descriptor, 'backend', 'resolve_conflict')).toBe(true);
  });

  it('rejects descriptors that blur client-local and backend authority', () => {
    expect(validateAdapterAuthorityDescriptor({
      adapter_id: 'bad-local',
      authority: 'client_local',
      client_operations: ['watch_local_changes'],
      backend_operations: ['export_document'],
    }).map((issue) => issue.path)).toContain('backend_operations');
  });
});
