import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../markdown/frontmatter';
import { readTextIfExists } from './fs-writer';
import type { ObsidianFsTarget } from './config';
import { toVaultRelative } from './target';

export interface InkloopNoteMatch {
  absolutePath: string;
  remotePath: string;
  frontmatter: Record<string, unknown>;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdownFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function listMarkdownFilesUnique(dirs: string[]): Promise<string[]> {
  return [...new Set((await Promise.all(dirs.map((dir) => listMarkdownFiles(dir)))).flat())].sort();
}

export async function findNotesByInkloopId(target: ObsidianFsTarget, koId: string): Promise<InkloopNoteMatch[]> {
  const basePath = path.join(target.vault_root, target.base_dir);
  const files = await listMarkdownFilesUnique([basePath, target.sources_dir]);
  const matches: InkloopNoteMatch[] = [];

  for (const file of files) {
    const markdown = await readTextIfExists(file);
    if (!markdown) continue;
    const parsed = parseFrontmatter(markdown);
    if (parsed?.frontmatter.inkloop_id === koId) {
      matches.push({
        absolutePath: file,
        remotePath: toVaultRelative(target.vault_root, file),
        frontmatter: parsed.frontmatter,
      });
    }
  }

  return matches;
}

export async function findDocumentsByProjectionId(target: ObsidianFsTarget, projectionId: string): Promise<InkloopNoteMatch[]> {
  const files = await listMarkdownFiles(target.sources_dir);
  const matches: InkloopNoteMatch[] = [];

  for (const file of files) {
    const markdown = await readTextIfExists(file);
    if (!markdown) continue;
    const parsed = parseFrontmatter(markdown);
    if (parsed?.frontmatter.inkloop_projection_id === projectionId) {
      matches.push({
        absolutePath: file,
        remotePath: toVaultRelative(target.vault_root, file),
        frontmatter: parsed.frontmatter,
      });
    }
  }

  return matches;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
