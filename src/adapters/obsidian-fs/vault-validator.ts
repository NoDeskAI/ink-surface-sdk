import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ValidationResult } from '../core/types';

export async function validateVaultRoot(vaultRoot: string): Promise<ValidationResult> {
  const issues: ValidationResult['issues'] = [];
  const warnings: ValidationResult['issues'] = [];
  const resolved = path.resolve(vaultRoot);

  if (resolved === path.parse(resolved).root) {
    issues.push({ code: 'VAULT_NOT_WRITABLE', message: 'Refusing to use filesystem root as an Obsidian vault.' });
    return { ok: false, issues, warnings };
  }

  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) issues.push({ code: 'VAULT_NOT_FOUND', message: 'Vault path exists but is not a directory.' });
  } catch {
    issues.push({ code: 'VAULT_NOT_FOUND', message: 'Vault path does not exist.' });
    return { ok: false, issues, warnings };
  }

  try {
    await access(resolved, constants.R_OK | constants.W_OK);
  } catch {
    issues.push({ code: 'VAULT_NOT_WRITABLE', message: 'Vault path is not readable and writable.' });
  }

  try {
    const obsidian = await stat(path.join(resolved, '.obsidian'));
    if (!obsidian.isDirectory()) warnings.push({ code: 'VAULT_NO_OBSIDIAN_DIR', message: '.obsidian exists but is not a directory.' });
  } catch {
    warnings.push({ code: 'VAULT_NO_OBSIDIAN_DIR', message: 'Vault has no .obsidian directory; treating it as a folder target.' });
  }

  return { ok: issues.length === 0, issues, warnings };
}
