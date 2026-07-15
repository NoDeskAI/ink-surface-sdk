import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginLarkOAuthLogin,
  completeLarkOAuthCallback,
  resolveLarkOAuthPublicStatus,
  resolveUserOAuthToken,
} from './lark-oauth-state';

describe('lark oauth state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('single-flights concurrent refreshes of the same state path (rolling refresh_token 只消耗一次)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-refresh-race-'));
    const authPath = join(tempDir, 'lark-auth.json');
    const obtainedAt = Date.now() - 3 * 60 * 60 * 1000; // access token 已过期（2h）·refresh 仍有效
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'stale_token',
        refresh_token: 'refresh_1',
        expires_in: 7200,
        refresh_expires_in: 30 * 24 * 60 * 60,
        obtained_at_ms: obtainedAt,
        scope: 'vc:meeting.search:read',
      },
      user: { data: { open_id: 'ou_user_a' } },
    }));
    const env = { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath };
    let refreshCalls = 0;
    const refreshOAuthToken = vi.fn(async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { access_token: 'fresh_token', refresh_token: 'refresh_2', expires_in: 7200, refresh_expires_in: 30 * 24 * 60 * 60, scope: 'vc:meeting.search:read' };
    });
    const createClient = () => ({ refreshOAuthToken });
    try {
      const [a, b, c] = await Promise.all([
        resolveUserOAuthToken(env, Date.now(), { createClient }),
        resolveUserOAuthToken(env, Date.now(), { createClient }),
        resolveUserOAuthToken(env, Date.now(), { createClient }),
      ]);
      expect(refreshCalls).toBe(1);
      expect(a.usable && b.usable && c.usable).toBe(true);
      expect([a.token, b.token, c.token]).toEqual(['fresh_token', 'fresh_token', 'fresh_token']);
      const persisted = JSON.parse(readFileSync(authPath, 'utf8')) as { token: { refresh_token: string } };
      expect(persisted.token.refresh_token).toBe('refresh_2');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts and completes Cloud Hub-owned OAuth without depending on the SDK daemon', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-cloud-hub-oauth-'));
    const authPath = join(tempDir, 'lark-auth.json');
    const env = {
      LARK_APP_ID: 'cli_test',
      LARK_APP_SECRET: 'secret',
      LARK_MEETING_AUTH_STATE_PATH: authPath,
    };
    const exchangeOAuthCode = vi.fn(async () => ({
      access_token: 'user_token',
      refresh_token: 'refresh_token',
      expires_in: 7200,
      refresh_expires_in: 30 * 24 * 60 * 60,
      scope: 'vc:meeting.search:read vc:note:read',
    }));
    const fetchUserInfo = vi.fn(async () => ({ data: { open_id: 'ou_user_a' } }));
    const createClient = vi.fn(() => ({ exchangeOAuthCode, fetchUserInfo }));

    try {
      const login = beginLarkOAuthLogin(env, {
        redirectUri: 'http://localhost:8731/api/feishu-svc/api/feishu/oauth/callback',
        scope: 'vc:meeting.search:read vc:note:read',
        state: 'state_test',
        nowMs: Date.parse('2026-07-08T10:00:00+08:00'),
        createClient,
      });

      const authUrl = new URL(login.auth_url);
      expect(authUrl.origin + authUrl.pathname).toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
      expect(authUrl.searchParams.get('client_id')).toBe('cli_test');
      expect(authUrl.searchParams.get('state')).toBe('state_test');

      const completed = await completeLarkOAuthCallback(env, {
        code: 'oauth_code',
        state: 'state_test',
        redirectUri: 'http://localhost:8731/api/feishu-svc/api/feishu/oauth/callback',
        nowMs: Date.parse('2026-07-08T10:01:00+08:00'),
        createClient,
      });
      expect(exchangeOAuthCode).toHaveBeenCalledWith('oauth_code');
      expect(fetchUserInfo).toHaveBeenCalledWith('user_token');
      expect(completed.status.auth_mode).toBe('shared_user_oauth');
      expect(completed.status.data_isolation).toBe('inkloop_session_namespace');
      expect(JSON.parse(readFileSync(authPath, 'utf8')).token).toMatchObject({
        access_token: 'user_token',
        refresh_token: 'refresh_token',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports missing required scopes while keeping user data isolation explicit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-cloud-hub-oauth-status-'));
    const authPath = join(tempDir, 'lark-auth.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: Date.parse('2026-07-08T10:00:00+08:00'),
        scope: 'vc:meeting.search:read',
      },
      user: { data: { open_id: 'ou_user_a' } },
    }));

    try {
      const status = await resolveLarkOAuthPublicStatus({
        LARK_APP_ID: 'cli_test',
        LARK_APP_SECRET: 'secret',
        LARK_MEETING_AUTH_STATE_PATH: authPath,
      }, 'vc:meeting.search:read vc:note:read', Date.parse('2026-07-08T10:05:00+08:00'));

      expect(status.authenticated).toBe(true);
      expect(status.connected).toBe(false);
      expect(status.missing_scopes).toEqual(['vc:note:read']);
      expect(status.permission_url).toContain('vc%3Anote%3Aread');
      expect(status.data_isolation).toBe('inkloop_session_namespace');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
