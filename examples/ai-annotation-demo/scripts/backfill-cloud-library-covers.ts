import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractCloudLibraryCoverImageDataUrl } from '../server/cloud-library-cover';

interface CloudLibraryDocument {
  document_id: string;
  filename: string;
  mime_type?: string;
  cover_image_data_url?: string;
  updated_at?: string;
}

interface CloudLibraryManifest {
  schema_version: string;
  generated_at?: string;
  documents: CloudLibraryDocument[];
}

const repoRoot = resolve(new URL('../../..', import.meta.url).pathname);
const libraryRoot = process.env.INKLOOP_CLOUD_LIBRARY_ROOT
  ? resolve(process.env.INKLOOP_CLOUD_LIBRARY_ROOT)
  : join(repoRoot, 'examples/ai-annotation-demo/.inkloop/library/local/local_demo');
const manifestPath = join(libraryRoot, 'manifest.json');
const blobsDir = join(libraryRoot, 'blobs');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CloudLibraryManifest;
let changed = 0;
const updated: Array<{ document_id: string; filename: string; cover_bytes: number }> = [];

for (const document of manifest.documents || []) {
  if (document.cover_image_data_url) continue;
  const blobPath = join(blobsDir, `${document.document_id}.bin`);
  let bytes: Buffer;
  try {
    bytes = await readFile(blobPath);
  } catch {
    continue;
  }
  const cover = extractCloudLibraryCoverImageDataUrl(bytes, document.filename, document.mime_type);
  if (!cover) continue;
  document.cover_image_data_url = cover;
  document.updated_at = document.updated_at || new Date().toISOString();
  changed += 1;
  updated.push({ document_id: document.document_id, filename: document.filename, cover_bytes: Buffer.byteLength(cover, 'utf8') });
}

if (changed) {
  manifest.generated_at = new Date().toISOString();
  const backupPath = `${manifestPath}.backup-cover-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(manifestPath, backupPath);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, changed, backupPath, updated }, null, 2));
} else {
  console.log(JSON.stringify({ ok: true, changed, updated }, null, 2));
}
