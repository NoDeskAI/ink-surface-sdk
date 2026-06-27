import path from 'node:path';
import { sha256Hex } from '../../knowledge/hash';
import type { ObsidianFsConfig, ObsidianFsTarget } from './config';

export const DEFAULT_OBSIDIAN_BASE_DIR = '.inkloop';
export const DEFAULT_OBSIDIAN_DOCUMENTS_DIR = 'InkLoop';

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizeVaultSubdir(input = DEFAULT_OBSIDIAN_BASE_DIR): string {
  if (path.isAbsolute(input)) throw new Error('Obsidian base_dir must be relative to the vault root.');
  const parts = input.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Obsidian base_dir must stay inside the vault root.');
  }
  return parts.join('/');
}

export function toVaultRelative(vaultRoot: string, absolutePath: string): string {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join('/');
}

export function fromVaultRelative(vaultRoot: string, remotePath: string): string {
  if (path.isAbsolute(remotePath)) throw new Error('Remote path must be relative to the vault root.');
  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedPath = path.resolve(resolvedRoot, ...remotePath.split('/'));
  if (!isInside(resolvedRoot, resolvedPath)) throw new Error('Remote path must stay inside the vault root.');
  return resolvedPath;
}

export async function resolveObsidianFsTarget(config: ObsidianFsConfig): Promise<ObsidianFsTarget> {
  const vaultRoot = path.resolve(config.vault_root);
  const baseDir = normalizeVaultSubdir(config.base_dir);
  const documentsDir = normalizeVaultSubdir(config.documents_dir ?? DEFAULT_OBSIDIAN_DOCUMENTS_DIR);
  const targetHash = (await sha256Hex(`${vaultRoot}:${baseDir}:${documentsDir}`)).slice(0, 16);
  const base = fromVaultRelative(vaultRoot, baseDir);
  const documents = fromVaultRelative(vaultRoot, documentsDir);

  return {
    target_id: `target_${targetHash}`,
    vault_root: vaultRoot,
    base_dir: baseDir,
    documents_dir: documentsDir,
    notes_dir: path.join(base, 'Notes'),
    sources_dir: documents,
    tasks_dir: path.join(base, 'Tasks'),
    summaries_dir: path.join(base, 'Summaries'),
    concepts_dir: path.join(base, 'Concepts'),
    assets_dir: path.join(base, '_assets'),
    vault_name_or_id: config.vault_name_or_id,
    create_source_notes: config.create_source_notes ?? true,
  };
}
