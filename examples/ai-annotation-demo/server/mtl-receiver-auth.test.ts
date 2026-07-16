import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentMtlToken,
  listMtlTokens,
  mintMtlToken,
  mtlReceiverBaseUrl,
  resolveMtlToken,
  revokeMtlToken,
  type MtlReceiverAuthEnv,
} from './mtl-receiver-auth';

describe('MTL receiver auth', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function env(): MtlReceiverAuthEnv {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-mtl-auth-'));
    roots.push(root);
    return {
      MTL_TOKEN_STORE: join(root, 'mtl-tokens.json'),
      PUBLIC_HUB_BASE: 'https://hub.example.test/',
    };
  }

  it('mints one active 32-hex token per user and resolves only active identities', () => {
    const runtimeEnv = env();
    const alice = { tenant_id: 'tenant-a', user_id: 'alice' };
    const bob = { tenant_id: 'tenant-a', user_id: 'bob' };
    const first = mintMtlToken(alice, runtimeEnv, Date.parse('2026-07-15T01:00:00.000Z'));
    const repeated = mintMtlToken(alice, runtimeEnv, Date.parse('2026-07-15T01:01:00.000Z'));
    const other = mintMtlToken(bob, runtimeEnv);

    expect(first.token).toMatch(/^[a-f0-9]{32}$/);
    expect(repeated).toMatchObject({ token: first.token, created: false });
    expect(other.token).not.toBe(first.token);
    expect(resolveMtlToken(first.token, runtimeEnv)).toEqual(alice);
    expect(currentMtlToken(alice, runtimeEnv)?.token).toBe(first.token);
    expect(mtlReceiverBaseUrl(first.token, runtimeEnv)).toBe(`https://hub.example.test/api/mtl/${first.token}`);

    expect(revokeMtlToken(first.token, bob, runtimeEnv)).toBe(false);
    expect(revokeMtlToken(first.token, alice, runtimeEnv, Date.parse('2026-07-15T02:00:00.000Z'))).toBe(true);
    expect(resolveMtlToken(first.token, runtimeEnv)).toBeNull();
    expect(currentMtlToken(alice, runtimeEnv)).toBeNull();
    expect(listMtlTokens(alice, runtimeEnv)[0].record).toMatchObject({ revoked: true });

    const replacement = mintMtlToken(alice, runtimeEnv);
    expect(replacement).toMatchObject({ created: true });
    expect(replacement.token).not.toBe(first.token);
  });
});
