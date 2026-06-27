import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromVaultRelative, resolveObsidianFsTarget } from './target';

describe('Obsidian FS target path policy', () => {
  it('keeps remote paths inside the vault root', () => {
    expect(fromVaultRelative('/tmp/inkloop-vault', '.inkloop/Sources/Doc.md')).toBe(path.join('/tmp/inkloop-vault', '.inkloop', 'Sources', 'Doc.md'));
    expect(() => fromVaultRelative('/tmp/inkloop-vault', '../outside.md')).toThrow('inside the vault root');
    expect(() => fromVaultRelative('/tmp/inkloop-vault', '/tmp/outside.md')).toThrow('relative to the vault root');
  });

  it('normalizes safe base_dir values and rejects traversal', async () => {
    const defaultTarget = await resolveObsidianFsTarget({ vault_root: '/tmp/inkloop-vault' });
    expect(defaultTarget.base_dir).toBe('.inkloop');
    expect(defaultTarget.documents_dir).toBe('InkLoop');
    expect(defaultTarget.sources_dir).toBe(path.join('/tmp/inkloop-vault', 'InkLoop'));

    const target = await resolveObsidianFsTarget({ vault_root: '/tmp/inkloop-vault', base_dir: '.inkloop/data/', documents_dir: 'Readable Docs/' });
    expect(target.base_dir).toBe('.inkloop/data');
    expect(target.documents_dir).toBe('Readable Docs');
    expect(target.sources_dir).toBe(path.join('/tmp/inkloop-vault', 'Readable Docs'));

    await expect(resolveObsidianFsTarget({ vault_root: '/tmp/inkloop-vault', base_dir: '../outside' })).rejects.toThrow('inside the vault root');
    await expect(resolveObsidianFsTarget({ vault_root: '/tmp/inkloop-vault', base_dir: '/tmp/outside' })).rejects.toThrow('relative to the vault root');
    await expect(resolveObsidianFsTarget({ vault_root: '/tmp/inkloop-vault', documents_dir: '../outside' })).rejects.toThrow('inside the vault root');
  });
});
