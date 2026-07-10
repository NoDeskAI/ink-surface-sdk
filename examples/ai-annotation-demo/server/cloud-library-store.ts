import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ReadingExperience } from '../src/core/reading-experience';
import { extractCloudLibraryCoverImageDataUrl } from './cloud-library-cover';

export type CloudLibrarySource = 'web' | 'paper_wifi' | 'paper_file' | 'cloud';

export interface CloudLibraryNamespace {
  tenant_id?: string;
  user_id?: string;
}

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
  source: CloudLibrarySource;
  imported_at: string;
  updated_at: string;
  uploaded_by_device_id?: string;
  text_layer: CloudLibraryTextLayer;
  reading_experience?: ReadingExperience;
  page_map: { status: 'pending' | 'ready'; page_count: number };
  blob: { sha256: string; size_bytes: number; path: string };
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
  tenant_id?: string;
  user_id?: string;
  generated_at: string;
  documents: CloudLibraryDocument[];
}

export interface PutCloudLibrarySourceInput {
  document_id?: string;
  filename: string;
  file_hash?: string;
  mime_type?: string;
  page_count?: number;
  cover_image_data_url?: string;
  source?: CloudLibrarySource;
  uploaded_by_device_id?: string;
  text_layer?: CloudLibraryTextLayer;
  reading_experience?: ReadingExperience;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSegment(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim() || fallback;
  return encodeURIComponent(raw).replace(/%/g, '_');
}

function safeDocumentId(documentId: string): string {
  return documentId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'doc';
}

function emptyManifest(namespace: CloudLibraryNamespace): CloudLibraryManifest {
  return {
    schema_version: 'inkloop.cloud_library.manifest.v1',
    tenant_id: namespace.tenant_id,
    user_id: namespace.user_id,
    generated_at: new Date().toISOString(),
    documents: [],
  };
}

function normalizeTextLayer(
  input: CloudLibraryTextLayer | undefined,
  existing: CloudLibraryDocument | undefined,
  pageCount: number,
  now: string,
): CloudLibraryTextLayer {
  if (input?.status === 'ready') {
    return {
      status: 'ready',
      source: input.source || 'client',
      page_count: Math.max(1, Number(input.page_count || pageCount || 1)),
      sampled_page_count: Math.max(0, Number(input.sampled_page_count || 0)),
      text_block_count: Math.max(0, Number(input.text_block_count || 0)),
      updated_at: input.updated_at || now,
    };
  }
  if (existing?.text_layer?.status === 'ready') return existing.text_layer;
  return {
    status: 'pending',
    page_count: Math.max(1, Number(input?.page_count || existing?.page_count || pageCount || 1)),
    updated_at: input?.updated_at || existing?.text_layer?.updated_at || now,
  };
}

export class JsonCloudLibraryStore {
  constructor(private readonly rootDir: string) {}

  private namespaceDir(namespace: CloudLibraryNamespace): string {
    return join(this.rootDir, safeSegment(namespace.tenant_id, 'local'), safeSegment(namespace.user_id, 'local_demo'));
  }

  private manifestPath(namespace: CloudLibraryNamespace): string {
    return join(this.namespaceDir(namespace), 'manifest.json');
  }

  private blobPath(namespace: CloudLibraryNamespace, documentId: string): string {
    return join(this.namespaceDir(namespace), 'blobs', `${safeDocumentId(documentId)}.bin`);
  }

  private async readManifest(namespace: CloudLibraryNamespace): Promise<CloudLibraryManifest> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath(namespace), 'utf8')) as CloudLibraryManifest;
      if (parsed?.schema_version === 'inkloop.cloud_library.manifest.v1' && Array.isArray(parsed.documents)) {
        return { ...parsed, tenant_id: namespace.tenant_id, user_id: namespace.user_id };
      }
    } catch {
      // Missing or corrupt manifests should not block local reading; rebuild from uploads as they arrive.
    }
    return emptyManifest(namespace);
  }

  private async writeManifest(namespace: CloudLibraryNamespace, manifest: CloudLibraryManifest): Promise<void> {
    await mkdir(this.namespaceDir(namespace), { recursive: true });
    await writeFile(this.manifestPath(namespace), JSON.stringify(manifest, null, 2), 'utf8');
  }

  async list(namespace: CloudLibraryNamespace): Promise<CloudLibraryManifest> {
    const manifest = await this.readManifest(namespace);
    return {
      ...manifest,
      generated_at: new Date().toISOString(),
      documents: [...manifest.documents].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    };
  }

  async get(namespace: CloudLibraryNamespace, documentId: string): Promise<CloudLibraryDocument | null> {
    const manifest = await this.readManifest(namespace);
    return manifest.documents.find((doc) => doc.document_id === documentId) ?? null;
  }

  async readBlob(namespace: CloudLibraryNamespace, documentId: string): Promise<{ document: CloudLibraryDocument; bytes: Buffer } | null> {
    const document = await this.get(namespace, documentId);
    if (!document) return null;
    try {
      return { document, bytes: await readFile(this.blobPath(namespace, document.document_id)) };
    } catch {
      return null;
    }
  }

  async getBlobFile(namespace: CloudLibraryNamespace, documentId: string): Promise<{ document: CloudLibraryDocument; path: string } | null> {
    const document = await this.get(namespace, documentId);
    if (!document) return null;
    const path = this.blobPath(namespace, document.document_id);
    try {
      await access(path);
      return { document, path };
    } catch {
      return null;
    }
  }

  async putSourceFile(namespace: CloudLibraryNamespace, input: PutCloudLibrarySourceInput, bytes: Buffer): Promise<CloudLibraryDocument> {
    if (!bytes.length) throw Object.assign(new Error('empty_source_file'), { status: 400 });
    const hash = sha256(bytes);
    if (input.file_hash && input.file_hash !== hash) {
      throw Object.assign(new Error('file_hash_mismatch'), { status: 409 });
    }
    const documentId = input.document_id || `doc_${hash.slice(0, 12)}`;
    const now = new Date().toISOString();
    const manifest = await this.readManifest(namespace);
    const existing = manifest.documents.find((doc) => doc.document_id === documentId);
    const blobPath = this.blobPath(namespace, documentId);
    await mkdir(join(this.namespaceDir(namespace), 'blobs'), { recursive: true });
    await writeFile(blobPath, bytes);

    const pageCount = Math.max(1, Number(input.page_count || existing?.page_count || 1));
    const coverImageDataUrl = input.cover_image_data_url
      || existing?.cover_image_data_url
      || extractCloudLibraryCoverImageDataUrl(bytes, input.filename || existing?.filename || documentId, input.mime_type || existing?.mime_type);
    const document: CloudLibraryDocument = {
      schema_version: 'inkloop.cloud_library.document.v1',
      document_id: documentId,
      source_file_id: `src_${hash.slice(0, 16)}`,
      file_hash: hash,
      filename: input.filename || existing?.filename || documentId,
      mime_type: input.mime_type || existing?.mime_type || 'application/octet-stream',
      size_bytes: bytes.length,
      page_count: pageCount,
      cover_image_data_url: coverImageDataUrl,
      source: input.source || existing?.source || 'web',
      imported_at: existing?.imported_at || now,
      updated_at: now,
      uploaded_by_device_id: input.uploaded_by_device_id || existing?.uploaded_by_device_id,
      text_layer: normalizeTextLayer(input.text_layer, existing, pageCount, now),
      reading_experience: input.reading_experience || existing?.reading_experience,
      page_map: { status: 'ready', page_count: pageCount },
      blob: { sha256: hash, size_bytes: bytes.length, path: `/v1/library/source-files/${encodeURIComponent(documentId)}/blob` },
    };

    const nextDocs = manifest.documents.filter((doc) => doc.document_id !== documentId);
    nextDocs.push(document);
    await this.writeManifest(namespace, { ...manifest, generated_at: now, documents: nextDocs });
    return document;
  }

  async deleteSourceFile(namespace: CloudLibraryNamespace, documentId: string): Promise<boolean> {
    const manifest = await this.readManifest(namespace);
    const existing = manifest.documents.find((doc) => doc.document_id === documentId);
    if (!existing) return false;
    const now = new Date().toISOString();
    await this.writeManifest(namespace, {
      ...manifest,
      generated_at: now,
      documents: manifest.documents.filter((doc) => doc.document_id !== documentId),
    });
    try {
      await unlink(this.blobPath(namespace, documentId));
    } catch {
      // Blob cleanup is best-effort; the manifest is the source of truth.
    }
    return true;
  }

  async copyMissingDocuments(from: CloudLibraryNamespace, to: CloudLibraryNamespace): Promise<{ copied: string[]; skipped: string[] }> {
    if ((from.tenant_id || '') === (to.tenant_id || '') && (from.user_id || '') === (to.user_id || '')) {
      return { copied: [], skipped: [] };
    }
    const sourceManifest = await this.readManifest(from);
    const targetManifest = await this.readManifest(to);
    const targetIds = new Set(targetManifest.documents.map((doc) => doc.document_id));
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const doc of sourceManifest.documents) {
      if (targetIds.has(doc.document_id)) {
        skipped.push(doc.document_id);
        continue;
      }
      const blob = await this.readBlob(from, doc.document_id);
      if (!blob) {
        skipped.push(doc.document_id);
        continue;
      }
      await this.putSourceFile(to, {
        document_id: doc.document_id,
        filename: doc.filename,
        file_hash: doc.file_hash,
        mime_type: doc.mime_type,
        page_count: doc.page_count,
        cover_image_data_url: doc.cover_image_data_url,
        source: doc.source,
        uploaded_by_device_id: doc.uploaded_by_device_id,
        text_layer: doc.text_layer,
        reading_experience: doc.reading_experience,
      }, blob.bytes);
      targetIds.add(doc.document_id);
      copied.push(doc.document_id);
    }
    return { copied, skipped };
  }
}
