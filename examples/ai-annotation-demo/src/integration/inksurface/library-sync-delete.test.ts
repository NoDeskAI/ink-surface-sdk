import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  deleteLibraryItem: vi.fn(),
  deleteLocalLibraryItem: vi.fn(),
}));

vi.mock('../../core/api', () => ({
  apiUrl: (path: string) => path,
  authFetch: mocks.authFetch,
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock('../../core/auth', () => ({
  authHeaders: () => ({}),
  getSession: () => null,
  onAuthChange: () => () => {},
}));

vi.mock('../../local/store', () => ({
  deleteLibraryItem: mocks.deleteLibraryItem,
  deleteLocalLibraryItem: mocks.deleteLocalLibraryItem,
  getLibrarySyncRecord: vi.fn(),
  listLibrarySyncRecords: vi.fn(async () => []),
  loadPdfBlob: vi.fn(),
  markLibrarySyncStatus: vi.fn(),
  pruneLibraryItems: vi.fn(),
  upsertLibrarySyncRecord: vi.fn(),
}));

vi.mock('../../surface/renderer', () => ({
  importFileToLibrary: vi.fn(),
  inspectFileForLibraryUpload: vi.fn(),
}));

import { deleteCloudLibraryItem } from './library-sync';

describe('deleteCloudLibraryItem', () => {
  beforeEach(() => {
    mocks.authFetch.mockReset();
    mocks.deleteLibraryItem.mockReset();
    mocks.deleteLocalLibraryItem.mockReset();
    mocks.deleteLibraryItem.mockResolvedValue(undefined);
    mocks.deleteLocalLibraryItem.mockResolvedValue(undefined);
  });

  it('deletes the local shelf item only after the Cloud Hub source is removed', async () => {
    mocks.authFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await deleteCloudLibraryItem({
      document_id: 'doc_delete_me',
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_delete_me/blob',
      source_file_id: 'src_delete_me',
    });

    expect(mocks.authFetch).toHaveBeenCalledWith('/v1/library/source-files/doc_delete_me', expect.objectContaining({ method: 'DELETE' }));
    expect(mocks.deleteLibraryItem).toHaveBeenCalledWith('doc_delete_me');
    expect(mocks.authFetch.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteLibraryItem.mock.invocationCallOrder[0]);
    expect(result).toEqual({
      localDeleted: true,
      cloudDeleteAttempted: true,
      cloudDeleted: true,
    });
  });

  it('keeps the local shelf item when the Cloud Hub delete is blocked or offline', async () => {
    mocks.authFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await deleteCloudLibraryItem({
      document_id: 'doc_local_cleanup',
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_local_cleanup/blob',
      source_file_id: 'src_local_cleanup',
    });

    expect(mocks.deleteLibraryItem).not.toHaveBeenCalled();
    expect(mocks.deleteLocalLibraryItem).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      localDeleted: false,
      cloudDeleteAttempted: true,
      cloudDeleted: false,
      cloudError: 'Failed to fetch',
    });
  });

  it('keeps the local shelf item when the Cloud Hub delete request stalls', async () => {
    vi.useFakeTimers();
    mocks.authFetch.mockReturnValue(new Promise(() => undefined));

    const pending = deleteCloudLibraryItem({
      document_id: 'doc_slow_cloud',
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_slow_cloud/blob',
      source_file_id: 'src_slow_cloud',
    });
    await Promise.resolve();

    expect(mocks.deleteLibraryItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);

    await expect(pending).resolves.toMatchObject({
      localDeleted: false,
      cloudDeleteAttempted: true,
      cloudDeleted: false,
      cloudError: 'delete_source_timeout',
    });
    expect(mocks.deleteLibraryItem).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not call Cloud Hub for a purely local library item', async () => {
    const result = await deleteCloudLibraryItem({
      document_id: 'doc_local_only',
      cloud_available: false,
      cloud_blob_path: undefined,
      source_file_id: undefined,
    });

    expect(mocks.authFetch).not.toHaveBeenCalled();
    expect(mocks.deleteLocalLibraryItem).toHaveBeenCalledWith('doc_local_only');
    expect(result).toEqual({
      localDeleted: true,
      cloudDeleteAttempted: false,
      cloudDeleted: true,
    });
  });

  it('can delete only the local copy while keeping a Cloud Hub source available', async () => {
    const result = await deleteCloudLibraryItem({
      document_id: 'doc_keep_cloud',
      cloud_available: true,
      cloud_blob_path: '/v1/library/source-files/doc_keep_cloud/blob',
      source_file_id: 'src_keep_cloud',
    }, { deleteCloud: false });

    expect(mocks.authFetch).not.toHaveBeenCalled();
    expect(mocks.deleteLibraryItem).not.toHaveBeenCalled();
    expect(mocks.deleteLocalLibraryItem).toHaveBeenCalledWith('doc_keep_cloud');
    expect(result).toEqual({
      localDeleted: true,
      cloudDeleteAttempted: false,
      cloudDeleted: false,
    });
  });
});
