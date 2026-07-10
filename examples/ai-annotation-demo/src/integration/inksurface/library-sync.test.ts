import { describe, expect, it } from 'vitest';
import { libraryItemAction, libraryStatusLabel } from './library-sync';

describe('libraryStatusLabel', () => {
  it('uses reader-facing sync labels for import states', () => {
    expect(libraryStatusLabel({ sync_status: 'syncing', local_available: false, cloud_available: false })).toBe('上传中');
    expect(libraryStatusLabel({ sync_status: 'cloud_only', local_available: false, cloud_available: true })).toBe('云端可用');
    expect(libraryStatusLabel({ sync_status: 'local', local_available: true, cloud_available: true })).toBe('已同步');
    expect(libraryStatusLabel({ sync_status: 'local', local_available: true, cloud_available: false })).toBe('本地可读');
    expect(libraryStatusLabel({ sync_status: 'failed', local_available: false, cloud_available: false })).toBe('失败重试');
  });

  it('returns explicit click actions for non-local library items', () => {
    expect(libraryItemAction({ sync_status: 'synced', local_available: true, cloud_available: true })).toMatchObject({ kind: 'open', label: '打开' });
    expect(libraryItemAction({ sync_status: 'syncing', local_available: true, cloud_available: false })).toMatchObject({ kind: 'open', label: '打开' });
    expect(libraryItemAction({ sync_status: 'cloud_only', local_available: false, cloud_available: true })).toMatchObject({ kind: 'download', label: '下载' });
    expect(libraryItemAction({ sync_status: 'syncing', local_available: false, cloud_available: false })).toMatchObject({ kind: 'wait', label: '上传中' });
    expect(libraryItemAction({ sync_status: 'failed', local_available: false, cloud_available: false })).toMatchObject({ kind: 'reimport', label: '重新导入' });
  });
});
