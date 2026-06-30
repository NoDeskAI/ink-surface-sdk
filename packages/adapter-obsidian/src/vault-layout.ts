import type { EntityMode } from '../../export-core/src/index.js';

export interface VaultFolder {
  base_dir: string;
  documents_dir: string;
}

export interface VaultEntity {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  date?: string;
}

export const VAULT_ROOT_DIR = 'InkLoop';
export const MODE_DIR: Record<EntityMode, string> = {
  reading: 'Reading',
  diary: 'Diary',
  meeting: 'Meetings',
};

/** = SDK sanitizeFileName: NFKC, drop illegal chars, squeeze whitespace, trim, drop trailing dot/space, fallback Untitled. */
export function sanitizeName(input: string): string {
  return (
    (input ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '') || 'Untitled'
  );
}

/** Source-note / document-projection file base name (no .md) = the `[[basename]]` link target.
 *  Includes the document_id so the basename stays globally unique across folders. */
export function sourceNoteBaseName(documentTitle: string, documentId: string): string {
  return `${sanitizeName(documentTitle).slice(0, 100)} - ${sanitizeName(documentId)}`;
}

export function folderSlug(input: string): string {
  return sanitizeName(input).slice(0, 80);
}

export function folderForMode(mode: EntityMode, slug: string): VaultFolder {
  const dir = `${VAULT_ROOT_DIR}/${MODE_DIR[mode]}/${slug}`;
  return { base_dir: dir, documents_dir: dir };
}

/** Entity -> visible folder: diary by date, meeting by `<date> <title>`, reading by title. */
export function vaultFolderForEntity(entity: VaultEntity): VaultFolder {
  let slug: string;

  if (entity.mode === 'diary') slug = entity.date || '未注明日期';
  else if (entity.mode === 'meeting') slug = folderSlug(entity.date ? `${entity.date} ${entity.documentTitle}` : entity.documentTitle);
  else slug = folderSlug(entity.documentTitle);

  return folderForMode(entity.mode, slug);
}

export function vaultRootFolder(): VaultFolder {
  return { base_dir: VAULT_ROOT_DIR, documents_dir: VAULT_ROOT_DIR };
}
