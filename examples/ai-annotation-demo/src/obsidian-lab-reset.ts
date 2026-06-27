import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ResetObsidianLabVaultInput {
  vaultRoot: string;
  documentsDir: string;
  baseDir: string;
}

export interface ResetObsidianLabVaultResult {
  removed_paths: string[];
  preserved_paths: string[];
}

const PRESERVED_SIDECAR_ENTRIES = new Set([
  '.obsidian-plugin-status.json',
  'manifest.json',
]);

const PRESERVED_OUTBOX_PATH = ['outbox', 'runtime-events.jsonl'];

function vaultPath(root: string, vaultRelativePath: string): string {
  return path.join(root, vaultRelativePath);
}

export async function resetObsidianLabVault(input: ResetObsidianLabVaultInput): Promise<ResetObsidianLabVaultResult> {
  const removedPaths: string[] = [];
  const preservedPaths: string[] = [];
  const documentsPath = vaultPath(input.vaultRoot, input.documentsDir);
  const sidecarPath = vaultPath(input.vaultRoot, input.baseDir);

  await rm(documentsPath, { recursive: true, force: true });
  removedPaths.push(input.documentsDir);

  await mkdir(sidecarPath, { recursive: true });
  const entries = await readdir(sidecarPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(sidecarPath, entry.name);
    const relativePath = `${input.baseDir}/${entry.name}`;
    if (PRESERVED_SIDECAR_ENTRIES.has(entry.name)) {
      preservedPaths.push(relativePath);
      continue;
    }
    if (entry.name === PRESERVED_OUTBOX_PATH[0]) {
      preservedPaths.push(`${input.baseDir}/${PRESERVED_OUTBOX_PATH.join('/')}`);
      continue;
    }

    await rm(entryPath, { recursive: true, force: true });
    removedPaths.push(relativePath);
  }

  const outboxPath = path.join(sidecarPath, ...PRESERVED_OUTBOX_PATH);
  await mkdir(path.dirname(outboxPath), { recursive: true });
  await writeFile(outboxPath, '', 'utf8');

  return {
    removed_paths: removedPaths.sort(),
    preserved_paths: preservedPaths.sort(),
  };
}
