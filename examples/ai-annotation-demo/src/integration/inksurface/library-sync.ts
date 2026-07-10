import { apiUrlWithLocalHttpFallback, authFetch, getJson, postJson } from '../../core/api';
import { authHeaders, getSession, onAuthChange } from '../../core/auth';
import { sha256Hex } from '../../core/ids';
import type { ReadingExperience } from '../../core/reading-experience';
import type { PersistedLibrarySource, PersistedLibrarySync } from '../../core/store-format';
import {
  getLibrarySyncRecord,
  deleteLibraryItem,
  deleteLocalLibraryItem,
  listLibrarySyncRecords,
  loadPdfBlob,
  markLibrarySyncStatus,
  pruneLibraryItems,
  upsertLibrarySyncRecord,
  type LibraryShelfItem,
} from '../../local/store';
import { importFileToLibrary, inspectFileForLibraryUpload, type LoadedDocument } from '../../surface/renderer';
export { libraryItemAction, libraryStatusLabel } from '../../library/shelf-model';
export type { LibraryItemAction, LibraryItemActionKind } from '../../library/shelf-model';

export interface CloudLibraryDocument {
  schema_version: 'inkloop.cloud_library.document.v1';
  document_id: string;
  source_file_id: string;
  file_hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  cover_image_data_url?: string;
  source: PersistedLibrarySource;
  updated_at: string;
  text_layer?: CloudLibraryTextLayer;
  reading_experience?: ReadingExperience;
  page_map?: { status: 'pending' | 'ready'; page_count: number };
  blob: { path: string; sha256: string; size_bytes: number };
}

export interface CloudLibraryTextLayer {
  status: 'pending' | 'ready';
  source?: 'pdfjs' | 'epub' | 'markdown' | 'client';
  page_count?: number;
  sampled_page_count?: number;
  text_block_count?: number;
  updated_at?: string;
}

export interface CloudLibraryManifest {
  schema_version: 'inkloop.cloud_library.manifest.v1';
  generated_at: string;
  documents: CloudLibraryDocument[];
}

type LibraryUploadMetadata = Omit<PersistedLibrarySync, 'updated_at'> & {
  text_layer?: CloudLibraryTextLayer;
  reading_experience?: ReadingExperience;
};
export type LibraryImportProgressPhase = 'hashing' | 'queued' | 'encoding' | 'uploading' | 'cloud_ready' | 'downloading' | 'waiting' | 'local_opening' | 'local_ready' | 'failed';
export interface LibraryImportProgress {
  phase: LibraryImportProgressPhase;
  filename: string;
  documentId?: string;
  percent: number;
  indeterminate?: boolean;
  detail?: string;
}
export type LibraryImportProgressHandler = (progress: LibraryImportProgress) => void;
export interface LibraryImportProgressOptions {
  onProgress?: LibraryImportProgressHandler;
}

const LOOP_MS = 8000;
const STREAM_RECONNECT_MS = 5000;
const CLOUD_DELETE_TIMEOUT_MS = 6000;

function nowIso(): string {
  return new Date().toISOString();
}

function sourceFromLoaded(source: PersistedLibrarySource): PersistedLibrarySource {
  return source === 'paper_wifi' || source === 'paper_file' || source === 'cloud' ? source : 'web';
}

function mimeTypeForFile(file: File | Blob): string {
  const named = file as File;
  if (file.type) return file.type;
  if (/\.(md|markdown)$/i.test(named.name || '')) return 'text/markdown';
  if (/\.epub$/i.test(named.name || '')) return 'application/epub+zip';
  if (/\.pdf$/i.test(named.name || '')) return 'application/pdf';
  return 'application/octet-stream';
}

function filenameForFile(file: File | Blob): string {
  return ((file as File).name || 'untitled').trim() || 'untitled';
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message || error);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sourceIdentity(file: File | Blob): Promise<{ documentId: string; fileHash: string }> {
  const fileHash = await sha256Hex(await file.arrayBuffer());
  return { documentId: `doc_${fileHash.slice(0, 12)}`, fileHash };
}

function blobToBase64(blob: Blob, onProgress?: (ratio: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read_blob_failed'));
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.max(0, Math.min(1, event.loaded / event.total)));
    };
    reader.onload = () => {
      const text = String(reader.result || '');
      onProgress?.(1);
      resolve(text.includes(',') ? text.slice(text.indexOf(',') + 1) : text);
    };
    reader.readAsDataURL(blob);
  });
}

function metadataFromLoaded(file: File | Blob, loaded: LoadedDocument, source: PersistedLibrarySource): LibraryUploadMetadata {
  return {
    document_id: loaded.documentId,
    file_hash: loaded.fileHash,
    filename: loaded.filename,
    mime_type: loaded.mimeType || mimeTypeForFile(file),
    size_bytes: file.size,
    page_count: loaded.pageCount,
    cover_image_data_url: loaded.coverImageDataUrl,
    source: sourceFromLoaded(source),
    sync_status: 'syncing',
    local_available: true,
    cloud_available: false,
    queued_at: nowIso(),
    text_layer: loaded.textLayer,
    reading_experience: loaded.readingExperience,
  };
}

export async function recordLocalImportedSource(file: File, loaded: LoadedDocument | null, source: PersistedLibrarySource): Promise<void> {
  if (!loaded) return;
  const existing = await getLibrarySyncRecord(loaded.documentId);
  await upsertLibrarySyncRecord({
    ...metadataFromLoaded(file, loaded, source),
    source_file_id: existing?.source_file_id,
    cover_image_data_url: loaded.coverImageDataUrl ?? existing?.cover_image_data_url,
    sync_status: 'local',
    local_available: true,
    cloud_available: existing?.cloud_available ?? false,
    cloud_blob_path: existing?.cloud_blob_path,
    cloud_revision: existing?.cloud_revision,
    synced_at: existing?.synced_at,
    error: undefined,
  });
}

async function metadataFromExternalFile(file: File): Promise<LibraryUploadMetadata> {
  let inspected: LoadedDocument | null = null;
  try {
    inspected = await inspectFileForLibraryUpload(file);
  } catch {
    inspected = null;
  }
  const fallback = inspected ? null : await sourceIdentity(file);
  const documentId = inspected?.documentId ?? fallback!.documentId;
  const fileHash = inspected?.fileHash ?? fallback!.fileHash;
  return {
    document_id: documentId,
    file_hash: fileHash,
    filename: filenameForFile(file),
    mime_type: inspected?.mimeType || mimeTypeForFile(file),
    size_bytes: file.size,
    page_count: inspected?.pageCount ?? 1,
    cover_image_data_url: inspected?.coverImageDataUrl,
    source: 'web',
    sync_status: 'syncing',
    local_available: false,
    cloud_available: false,
    queued_at: nowIso(),
    text_layer: inspected?.textLayer,
    reading_experience: inspected?.readingExperience,
  };
}

async function postLibrarySourceFile(
  body: unknown,
  onUploadProgress?: (ratio: number) => void,
): Promise<CloudLibraryDocument> {
  if (typeof XMLHttpRequest === 'undefined') {
    const response = await postJson<{ ok: boolean; document: CloudLibraryDocument }>('/v1/library/source-files', body, { auth: true });
    onUploadProgress?.(1);
    return response.document;
  }
  const payload = JSON.stringify(body);
  return await new Promise<CloudLibraryDocument>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrlWithLocalHttpFallback('/v1/library/source-files'));
    xhr.setRequestHeader('content-type', 'application/json');
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onUploadProgress?.(Math.max(0, Math.min(1, event.loaded / event.total)));
    };
    xhr.onerror = () => reject(new Error('/v1/library/source-files network_error'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`/v1/library/source-files ${xhr.status}`));
        return;
      }
      try {
        const parsed = JSON.parse(xhr.responseText || '{}') as { document?: CloudLibraryDocument };
        if (!parsed.document) throw new Error('missing_document');
        onUploadProgress?.(1);
        resolve(parsed.document);
      } catch (error) {
        reject(error);
      }
    };
    xhr.send(payload);
  });
}

interface UploadProgressRange {
  encodeStart: number;
  encodeSpan: number;
  uploadStart: number;
  uploadSpan: number;
}

const DEFAULT_UPLOAD_PROGRESS: UploadProgressRange = {
  encodeStart: 12,
  encodeSpan: 16,
  uploadStart: 30,
  uploadSpan: 55,
};

async function uploadBlob(
  metadata: LibraryUploadMetadata,
  blob: Blob,
  onProgress?: LibraryImportProgressHandler,
  progressRange: UploadProgressRange = DEFAULT_UPLOAD_PROGRESS,
): Promise<CloudLibraryDocument> {
  const upload = metadata;
  const filename = metadata.filename;
  onProgress?.({ phase: 'encoding', filename, documentId: metadata.document_id, percent: progressRange.encodeStart, detail: '读取文件内容' });
  const contentBase64 = await blobToBase64(blob, (ratio) => {
    onProgress?.({ phase: 'encoding', filename, documentId: metadata.document_id, percent: progressRange.encodeStart + Math.round(ratio * progressRange.encodeSpan), detail: '读取文件内容' });
  });
  onProgress?.({ phase: 'uploading', filename, documentId: metadata.document_id, percent: progressRange.uploadStart, detail: '上传到 Cloud Hub' });
  return await postLibrarySourceFile({
    document_id: metadata.document_id,
    filename: metadata.filename,
    file_hash: metadata.file_hash,
    mime_type: metadata.mime_type,
    size_bytes: blob.size,
    page_count: metadata.page_count,
    cover_image_data_url: upload.cover_image_data_url,
    source: metadata.source,
    text_layer: upload.text_layer,
    reading_experience: upload.reading_experience,
    content_base64: contentBase64,
  }, (ratio) => {
    onProgress?.({ phase: 'uploading', filename, documentId: metadata.document_id, percent: progressRange.uploadStart + Math.round(ratio * progressRange.uploadSpan), detail: '上传到 Cloud Hub' });
  });
}

async function markSyncedFromCloud(document: CloudLibraryDocument, localAvailable: boolean): Promise<void> {
  const existing = await getLibrarySyncRecord(document.document_id);
  await upsertLibrarySyncRecord({
    document_id: document.document_id,
    source_file_id: document.source_file_id,
    file_hash: document.file_hash,
    filename: document.filename,
    mime_type: document.mime_type,
    size_bytes: document.size_bytes,
    page_count: document.page_count,
    cover_image_data_url: document.cover_image_data_url ?? existing?.cover_image_data_url,
    source: document.source || 'cloud',
    sync_status: localAvailable ? 'synced' : 'cloud_only',
    local_available: localAvailable,
    cloud_available: true,
    cloud_blob_path: document.blob.path,
    cloud_revision: document.updated_at,
    synced_at: localAvailable ? nowIso() : undefined,
  });
}

export async function uploadLoadedDocumentSource(
  file: File,
  loaded: LoadedDocument | null,
  source: PersistedLibrarySource,
  opts?: LibraryImportProgressOptions,
): Promise<boolean> {
  if (!loaded) return false;
  const existing = await getLibrarySyncRecord(loaded.documentId);
  const metadata = {
    ...metadataFromLoaded(file, loaded, source),
    source_file_id: existing?.source_file_id,
    cloud_available: existing?.cloud_available ?? false,
    cover_image_data_url: existing?.cover_image_data_url ?? loaded.coverImageDataUrl,
    cloud_blob_path: existing?.cloud_blob_path,
    cloud_revision: existing?.cloud_revision,
  };
  await upsertLibrarySyncRecord(metadata);
  opts?.onProgress?.({ phase: 'queued', filename: metadata.filename, documentId: metadata.document_id, percent: 58, detail: '本机已可读，后台同步 Cloud Hub' });
  try {
    const document = await uploadBlob(metadata, file, opts?.onProgress, {
      encodeStart: 60,
      encodeSpan: 10,
      uploadStart: 72,
      uploadSpan: 24,
    });
    await markSyncedFromCloud(document, true);
    opts?.onProgress?.({ phase: 'cloud_ready', filename: metadata.filename, documentId: metadata.document_id, percent: 100, detail: 'Cloud Hub 已同步' });
    return true;
  } catch (error) {
    await markLibrarySyncStatus(loaded.documentId, 'failed', {
      ...metadata,
      local_available: true,
      cloud_available: (await getLibrarySyncRecord(loaded.documentId))?.cloud_available ?? false,
      error: messageOf(error),
    });
    opts?.onProgress?.({ phase: 'failed', filename: metadata.filename, documentId: metadata.document_id, percent: 100, detail: `后台同步失败：${messageOf(error)}` });
    return false;
  }
}

export async function uploadExternalSourceFile(file: File, opts?: LibraryImportProgressOptions): Promise<CloudLibraryDocument> {
  opts?.onProgress?.({ phase: 'hashing', filename: filenameForFile(file), percent: 5, detail: '计算文件指纹' });
  const metadata = await metadataFromExternalFile(file);
  await upsertLibrarySyncRecord(metadata);
  opts?.onProgress?.({ phase: 'queued', filename: metadata.filename, documentId: metadata.document_id, percent: 10, detail: '已加入 Cloud Hub 上传队列' });
  try {
    const document = await uploadBlob(metadata, file, opts?.onProgress);
    await markSyncedFromCloud(document, false);
    opts?.onProgress?.({ phase: 'cloud_ready', filename: metadata.filename, documentId: metadata.document_id, percent: 88, detail: 'Cloud Hub 已保存' });
    return document;
  } catch (error) {
    await markLibrarySyncStatus(metadata.document_id, 'failed', {
      ...metadata,
      local_available: false,
      cloud_available: false,
      error: messageOf(error),
    });
    opts?.onProgress?.({ phase: 'failed', filename: metadata.filename, documentId: metadata.document_id, percent: 100, detail: messageOf(error) });
    throw error;
  }
}

export async function pullCloudLibraryManifest(): Promise<void> {
  const manifest = await getJson<CloudLibraryManifest>('/v1/library/manifest', { auth: true });
  await Promise.all((manifest.documents || []).map(async (document) => {
    const localBlob = await loadPdfBlob(document.document_id);
    await markSyncedFromCloud(document, !!localBlob);
  }));
  await pruneLibraryItems((manifest.documents || []).map((document) => document.document_id));
}

export async function retryPendingLibraryUploads(): Promise<void> {
  const records = await listLibrarySyncRecords();
  for (const record of records) {
    if (!record.local_available) continue;
    if (record.sync_status !== 'local' && record.sync_status !== 'failed' && record.sync_status !== 'syncing') continue;
    const blob = await loadPdfBlob(record.document_id);
    if (!blob) continue;
    await markLibrarySyncStatus(record.document_id, 'syncing', { ...record, queued_at: nowIso(), error: undefined });
    try {
      const document = await uploadBlob(record, blob);
      await markSyncedFromCloud(document, true);
    } catch (error) {
      await markLibrarySyncStatus(record.document_id, 'failed', {
        ...record,
        local_available: true,
        error: messageOf(error),
      });
    }
  }
}

export async function downloadCloudLibraryItem(item: LibraryShelfItem, opts?: LibraryImportProgressOptions): Promise<void> {
  const path = item.cloud_blob_path || `/v1/library/source-files/${encodeURIComponent(item.document_id)}/blob`;
  await markLibrarySyncStatus(item.document_id, 'syncing', {
    file_hash: item.file_hash,
    filename: item.filename,
    mime_type: item.mime_type,
    size_bytes: item.size_bytes,
    page_count: item.page_count,
    source: item.source,
    local_available: item.local_available,
    cloud_available: true,
    cloud_blob_path: item.cloud_blob_path,
    cloud_revision: item.cloud_revision,
    error: undefined,
  });
  try {
    opts?.onProgress?.({ phase: 'downloading', filename: item.filename, documentId: item.document_id, percent: 0, indeterminate: true, detail: '连接 Cloud Hub' });
    const response = await authFetch(path, { method: 'GET' });
    if (!response.ok) throw new Error(`download_source_${response.status}`);
    const blob = await readDownloadBlob(response, item, opts?.onProgress);
    opts?.onProgress?.({ phase: 'local_opening', filename: item.filename, documentId: item.document_id, percent: 88, detail: '写入本机 Library' });
    const file = new File([blob], item.filename, { type: item.mime_type || blob.type || 'application/octet-stream' });
    const loaded = await importFileToLibrary(file, item.document_id);
    if (!loaded) throw new Error('downloaded_source_not_loaded');
    await upsertLibrarySyncRecord({
      document_id: item.document_id,
      source_file_id: item.source_file_id,
      file_hash: loaded.fileHash,
      filename: item.filename,
      page_count: loaded.pageCount,
      cover_image_data_url: loaded.coverImageDataUrl ?? item.cover_image_data_url,
      mime_type: loaded.mimeType,
      size_bytes: blob.size,
      source: item.source,
      sync_status: 'synced',
      local_available: true,
      cloud_available: true,
      cloud_blob_path: item.cloud_blob_path,
      cloud_revision: item.cloud_revision,
      synced_at: nowIso(),
    });
    opts?.onProgress?.({ phase: 'local_ready', filename: item.filename, documentId: item.document_id, percent: 100, detail: '已下载到本机 Library' });
  } catch (error) {
    await markLibrarySyncStatus(item.document_id, 'failed', {
      file_hash: item.file_hash,
      filename: item.filename,
      mime_type: item.mime_type,
      size_bytes: item.size_bytes,
      page_count: item.page_count,
      source: item.source,
      local_available: false,
      cloud_available: true,
      cloud_blob_path: item.cloud_blob_path,
      cloud_revision: item.cloud_revision,
      error: messageOf(error),
    });
    throw error;
  }
}

export interface DeleteCloudLibraryItemResult {
  localDeleted: boolean;
  cloudDeleteAttempted: boolean;
  cloudDeleted: boolean;
  cloudError?: string;
}

export interface DeleteCloudLibraryItemOptions {
  deleteCloud?: boolean;
}

export function hasCloudLibraryItem(item: Pick<LibraryShelfItem, 'cloud_available' | 'cloud_blob_path' | 'source_file_id'>): boolean {
  return !!(item.cloud_available || item.cloud_blob_path || item.source_file_id);
}

async function deleteCloudSourceFile(documentId: string): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = authFetch(`/v1/library/source-files/${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
    signal: controller.signal,
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('delete_source_timeout'));
    }, CLOUD_DELETE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function deleteCloudLibraryItem(
  item: Pick<LibraryShelfItem, 'document_id' | 'cloud_available' | 'cloud_blob_path' | 'source_file_id'>,
  options: DeleteCloudLibraryItemOptions = {},
): Promise<DeleteCloudLibraryItemResult> {
  const hasCloudCopy = hasCloudLibraryItem(item);
  const shouldDeleteCloud = options.deleteCloud !== false && hasCloudCopy;
  let localDeleted = false;
  let cloudDeleted = !hasCloudCopy;
  let cloudError: string | undefined;
  if (shouldDeleteCloud) {
    try {
      const response = await deleteCloudSourceFile(item.document_id);
      if (response.ok || response.status === 404) cloudDeleted = true;
      else cloudError = `delete_source_${response.status}`;
    } catch (error) {
      cloudError = messageOf(error);
    }
    if (cloudDeleted) {
      await deleteLibraryItem(item.document_id);
      localDeleted = true;
    }
  } else {
    await deleteLocalLibraryItem(item.document_id);
    localDeleted = true;
  }
  return {
    localDeleted,
    cloudDeleteAttempted: shouldDeleteCloud,
    cloudDeleted,
    ...(cloudError ? { cloudError } : {}),
  };
}

async function readDownloadBlob(
  response: Response,
  item: LibraryShelfItem,
  onProgress?: LibraryImportProgressHandler,
): Promise<Blob> {
  const total = Number(response.headers.get('content-length') || item.size_bytes || 0);
  const contentType = response.headers.get('content-type') || item.mime_type || 'application/octet-stream';
  if (!response.body) {
    onProgress?.({
      phase: 'downloading',
      filename: item.filename,
      documentId: item.document_id,
      percent: 0,
      indeterminate: true,
      detail: '浏览器没有提供实时下载进度，正在接收文件',
    });
    const blob = await response.blob();
    onProgress?.({
      phase: 'downloading',
      filename: item.filename,
      documentId: item.document_id,
      percent: 84,
      detail: `已接收 ${formatBytes(blob.size)}`,
    });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  let lastPercent = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy.buffer);
    received += value.length;
    const ratio = total > 0 ? Math.min(1, received / total) : 0;
    const percent = total > 0 ? Math.round(ratio * 100) : 0;
    if (percent !== lastPercent) {
      lastPercent = percent;
      onProgress?.({
        phase: 'downloading',
        filename: item.filename,
        documentId: item.document_id,
        percent,
        indeterminate: total <= 0,
        detail: total > 0
          ? `下载 ${formatBytes(received)} / ${formatBytes(total)}`
          : `下载 ${formatBytes(received)}`,
      });
    }
  }
  return new Blob(chunks, { type: contentType });
}

function startLibraryManifestStream(onChange?: () => void): () => void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return () => {};
  let disposed = false;
  let controller: AbortController | null = null;
  let reconnectTimer: number | null = null;

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, STREAM_RECONNECT_MS);
  };
  const handleFrame = (frame: string): void => {
    let event = 'message';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    }
    if (event === 'ready' || event === 'manifest') onChange?.();
  };
  const connect = async (): Promise<void> => {
    if (disposed) return;
    controller = new AbortController();
    try {
      const response = await authFetch('/v1/library/stream', { method: 'GET', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`library_stream_${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || disposed) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.trim()) handleFrame(frame);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (!disposed) scheduleReconnect();
      return;
    }
    if (!disposed) scheduleReconnect();
  };

  void connect();
  return () => {
    disposed = true;
    clearReconnect();
    controller?.abort();
  };
}

export function startLibrarySyncLoop(onChange?: () => void, intervalMs = LOOP_MS): () => void {
  let disposed = false;
  let timer: number | null = null;
  let streamStop: (() => void) | null = null;
  let authStop: (() => void) | null = null;
  const visibleTick = (): void => { if (!document.hidden) void tick(); };
  const onlineTick = (): void => { void tick(); };
  const tick = async (): Promise<void> => {
    if (disposed) return;
    try {
      await pullCloudLibraryManifest();
      await retryPendingLibraryUploads();
      onChange?.();
    } catch {
      // Cloud Hub 离线时保持本地阅读，不打断用户。
    }
  };
  void tick();
  if (typeof window !== 'undefined' && intervalMs > 0) {
    timer = window.setInterval(() => void tick(), intervalMs);
    document.addEventListener('visibilitychange', visibleTick);
    window.addEventListener('online', onlineTick);
    streamStop = startLibraryManifestStream(() => void tick());
    authStop = onAuthChange((event) => {
      if (event.kind === 'login') void tick();
    });
  }
  const session = getSession();
  if (session) void tick();
  return () => {
    disposed = true;
    streamStop?.();
    authStop?.();
    if (timer !== null) window.clearInterval(timer);
    document.removeEventListener('visibilitychange', visibleTick);
    window.removeEventListener('online', onlineTick);
  };
}
