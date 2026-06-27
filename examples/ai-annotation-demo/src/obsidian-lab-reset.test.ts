import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetObsidianLabVault } from './obsidian-lab-reset';

const tempRoots: string[] = [];

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, 'utf8');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resetObsidianLabVault', () => {
  it('removes generated InkLoop state but keeps the plugin communication files alive', async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'inkloop-lab-reset-'));
    tempRoots.push(vaultRoot);

    await writeText(path.join(vaultRoot, 'InkLoop', 'Demo.md'), '# Demo\n');
    await writeText(path.join(vaultRoot, '.inkloop', 'docs', 'doc_1', 'document.json'), '{}\n');
    await writeText(path.join(vaultRoot, '.inkloop', 'Notes', 'Note.md'), '# Note\n');
    await writeText(path.join(vaultRoot, '.inkloop', 'indexes', 'path-index.json'), '{}\n');
    await writeText(path.join(vaultRoot, '.inkloop', '.inkloop-adapter-state.json'), '{}\n');
    await writeText(path.join(vaultRoot, '.inkloop', '.obsidian-plugin-status.json'), '{"status":"sync_completed"}\n');
    await writeText(path.join(vaultRoot, '.inkloop', 'manifest.json'), '{"plugin_version":"0.1.0"}\n');
    await writeText(path.join(vaultRoot, '.inkloop', 'outbox', 'runtime-events.jsonl'), '{"event_id":"evt_old"}\n');

    const result = await resetObsidianLabVault({
      vaultRoot,
      documentsDir: 'InkLoop',
      baseDir: '.inkloop',
    });

    expect(result.removed_paths).toContain('InkLoop');
    expect(result.removed_paths).toContain('.inkloop/docs');
    expect(result.removed_paths).toContain('.inkloop/Notes');
    expect(result.removed_paths).toContain('.inkloop/.inkloop-adapter-state.json');
    expect(result.preserved_paths).toContain('.inkloop/.obsidian-plugin-status.json');
    expect(result.preserved_paths).toContain('.inkloop/manifest.json');
    expect(result.preserved_paths).toContain('.inkloop/outbox/runtime-events.jsonl');

    await expect(stat(path.join(vaultRoot, 'InkLoop'))).rejects.toThrow();
    await expect(stat(path.join(vaultRoot, '.inkloop', 'docs'))).rejects.toThrow();
    await expect(stat(path.join(vaultRoot, '.inkloop', 'Notes'))).rejects.toThrow();
    expect(await exists(path.join(vaultRoot, '.inkloop', '.obsidian-plugin-status.json'))).toBe(true);
    expect(await exists(path.join(vaultRoot, '.inkloop', 'manifest.json'))).toBe(true);
    expect(await readFile(path.join(vaultRoot, '.inkloop', 'outbox', 'runtime-events.jsonl'), 'utf8')).toBe('');
  });
});
