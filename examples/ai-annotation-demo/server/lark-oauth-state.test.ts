import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginLarkOAuthLogin,
  completeLarkOAuthCallback,
  resolveLarkOAuthPublicStatus,
} from './lark-oauth-state';

describe('lark oauth state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts and completes Cloud Hub-owned OAuth without depending on the SDK daemon', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-cloud-hub-oauth-'));
    const authPath = join(tempDir, 'lark-auth.json');
    const env = {
      LARK_APP_ID: 'cli_test',
      LARK_APP_SECRET: 'secret',
      LARK_MEETING_AUTH_STATE_PATH: authPath,
    };
    const createAuthorizeUrl = vi.fn((state: string) => `https://accounts.feishu.cn/auth?state=${state}`);
    const exchangeOAuthCode = vi.fn(async () => ({
      access_token: 'user_token',
      refresh_token: 'refresh_token',
      expires_in: 7200,
      refresh_expires_in: 30 * 24 * 60 * 60,
      scope: 'vc:meeting.search:read vc:note:read',
    }));
    const fetchUserInfo = vi.fn(async () => ({ data: { open_id: 'ou_user_a' } }));
    const createClient = vi.fn(() => ({ createAuthorizeUrl, exchangeOAuthCode, fetchUserInfo }));

    try {
      const login = beginLarkOAuthLogin(env, {
        redirectUri: 'http://localhost:8731/api/feishu-svc/api/feishu/oauth/callback',
        scope: 'vc:meeting.search:read vc:note:read',
        state: 'state_test',
        nowMs: Date.parse('2026-07-08T10:00:00+08:00'),
        createClient,
      });

      expect(login.auth_url).toContain('state_test');
      expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
        LARK_REDIRECT_URI: 'http://localhost:8731/api/feishu-svc/api/feishu/oauth/callback',
      }));

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
