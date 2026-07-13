import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultRelease } from './vault-release';
import { fetchLatestRelease, publishVaultRelease } from './vault-publish';

const release: VaultRelease = {
  manifest: { schema_version: 'inkloop.vault_release.v1', generated_at: 'x', app_version: 'd', release_hash: 'sha256:ab', files: [{ path: 'InkLoop/a.md', content_hash: 'sha256:cd', bytes: 3 }] },
  files: [{ path: 'InkLoop/a.md', markdown: 'abc' }],
};

afterEach(() => vi.restoreAllMocks());

describe('vault-publish client', () => {
  it('publishVaultRelease → POST per-user releases·带 manifest/files/device_id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, release_id: 'r1', file_count: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await publishVaultRelease(release, { deviceId: 'mac' });
    expect(r.release_id).toBe('r1');
    // 路径不再带 userId——后端按 token 权威身份填桶（不锁整串·测试对 base 中立）。
    expect(calls[0].url.endsWith('/api/panel-vault/releases')).toBe(true);
    expect(calls[0].url.includes('/users/')).toBe(false);
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.manifest.release_hash).toBe('sha256:ab');
    expect(body.files).toHaveLength(1);
    expect(body.device_id).toBe('mac');
  });

  it('publish 路径不含客户端 userId（防越桶/local_user 冒充）', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await publishVaultRelease(release, {});
    expect(calls[0].endsWith('/api/panel-vault/releases')).toBe(true);
  });

  it('fetchLatestRelease → GET latest', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ release: {}, manifest: {}, assets: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await fetchLatestRelease('u_demo');
    expect(calls[0].endsWith('/api/panel-vault/users/u_demo/releases/latest')).toBe(true);
  });

  it('非 2xx → 抛（postJson 行为）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(publishVaultRelease(release, {})).rejects.toThrow();
  });
});
