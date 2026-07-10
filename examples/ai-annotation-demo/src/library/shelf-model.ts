import type { PersistedLibrarySync } from '../core/store-format';

export type LibraryItemActionKind = 'open' | 'download' | 'wait' | 'reimport';

export interface LibraryItemAction {
  kind: LibraryItemActionKind;
  label: string;
  hint: string;
}

export function libraryStatusLabel(item: Pick<PersistedLibrarySync, 'sync_status' | 'local_available' | 'cloud_available'>): string {
  if (item.sync_status === 'failed') return '失败重试';
  if (item.sync_status === 'syncing') return item.cloud_available ? '同步中' : '上传中';
  if (item.local_available && item.cloud_available) return '已同步';
  if (item.local_available) return '本地可读';
  if (item.cloud_available) return '云端可用';
  return '等待同步';
}

export function libraryItemAction(item: Pick<PersistedLibrarySync, 'sync_status' | 'local_available' | 'cloud_available'>): LibraryItemAction {
  if (item.local_available) {
    return { kind: 'open', label: '打开', hint: '打开本机已缓存的文档' };
  }
  if (item.cloud_available) {
    return { kind: 'download', label: '下载', hint: '从 Cloud Hub 下载到本机后打开' };
  }
  if (item.sync_status === 'failed') {
    return { kind: 'reimport', label: '重新导入', hint: '本机没有可打开的源文件，请重新导入这个文档' };
  }
  return { kind: 'wait', label: item.sync_status === 'syncing' ? '上传中' : '等待', hint: '文件还没有云端副本，上传完成后会自动变成可下载' };
}
