import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_OAUTH_SCOPES,
  beginGoogleDeviceOAuth,
  completeGoogleOAuthCallback,
  googleDeviceOAuthCompletion,
  googleOAuthTokenPath,
  resolveGoogleOAuthStatus,
  resolveUserGoogleToken,
  type GoogleOAuthEnv,
  type GoogleOAuthIdentity,
} from './google-oauth-state';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('google oauth state', () => {
  const roots: string[] = [];
  const identity: GoogleOAuthIdentity = { tenantId: 'tenant-a', userId: 'user-a', deviceId: 'paper-1' };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function env(): GoogleOAuthEnv {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-google-oauth-'));
    roots.push(root);
    return {
      GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://meet.xiaobuyu.trade/api/google/oauth/callback',
      GOOGLE_AUTH_ROOT: root,
    };
  }

  it('builds the offline consent URL and persists callback tokens in the device bucket', async () => {
    const runtimeEnv = env();
    const nowMs = Date.parse('2026-07-14T08:00:00.000Z');
    const started = beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-1', nowMs });
    const url = new URL(started.auth_url);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_OAUTH_SCOPES);
    expect(googleDeviceOAuthCompletion(runtimeEnv, identity, nowMs + 1)).toMatchObject({ status: 'pending', connected: false });

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain('grant_type=authorization_code');
      return jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: GOOGLE_OAUTH_SCOPES.join(' '),
        token_type: 'Bearer',
      });
    });
    const completed = await completeGoogleOAuthCallback(
      runtimeEnv,
      { code: 'code-1', state: 'state-1' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: nowMs + 1_000 },
    );

    expect(completed.status.connected).toBe(true);
    expect(googleDeviceOAuthCompletion(runtimeEnv, identity, nowMs + 2_000)).toMatchObject({ status: 'complete', connected: true });
    expect(JSON.parse(readFileSync(googleOAuthTokenPath(runtimeEnv, identity), 'utf8'))).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      reauth_required: false,
    });
  });

  it('ignores expired pending states', () => {
    const runtimeEnv = { ...env(), GOOGLE_OAUTH_PENDING_TTL_MS: '1000' };
    const nowMs = Date.parse('2026-07-14T08:00:00.000Z');
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'expired-state', nowMs });

    expect(googleDeviceOAuthCompletion(runtimeEnv, identity, nowMs + 1_001)).toEqual({ status: 'idle', connected: false });
  });

  it('refreshes an expired token and keeps the original refresh token when Google omits it', async () => {
    const runtimeEnv = env();
    const initialMs = Date.parse('2026-07-14T08:00:00.000Z');
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-refresh', nowMs: initialMs });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'expired-access',
        refresh_token: 'refresh-stays',
        expires_in: 60,
        scope: GOOGLE_OAUTH_SCOPES.join(' '),
      }))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return jsonResponse({ access_token: 'fresh-access', expires_in: 3600 });
      });
    await completeGoogleOAuthCallback(
      runtimeEnv,
      { code: 'code-refresh', state: 'state-refresh' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: initialMs },
    );

    const resolved = await resolveUserGoogleToken(runtimeEnv, identity, initialMs + 61_000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(resolved).toMatchObject({ usable: true, token: 'fresh-access', refreshed: true, refreshTokenPresent: true });
    expect(JSON.parse(readFileSync(googleOAuthTokenPath(runtimeEnv, identity), 'utf8'))).toMatchObject({
      access_token: 'fresh-access',
      refresh_token: 'refresh-stays',
      reauth_required: false,
    });
  });

  it('marks refresh failures as reauth_required on disk and in public status', async () => {
    const runtimeEnv = env();
    const initialMs = Date.parse('2026-07-14T08:00:00.000Z');
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-fail', nowMs: initialMs });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'expired-access',
        refresh_token: 'bad-refresh',
        expires_in: 1,
        scope: GOOGLE_OAUTH_SCOPES.join(' '),
      }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant', error_description: 'refresh revoked' }, 400));
    await completeGoogleOAuthCallback(
      runtimeEnv,
      { code: 'code-fail', state: 'state-fail' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: initialMs },
    );

    const status = await resolveGoogleOAuthStatus(runtimeEnv, identity, initialMs + 2_000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(status).toMatchObject({ connected: false, reauth_required: true, reason: 'reauth_required' });
    expect(JSON.parse(readFileSync(googleOAuthTokenPath(runtimeEnv, identity), 'utf8'))).toMatchObject({
      reauth_required: true,
      refresh_error: 'google_oauth_token_request_failed',
    });
  });
});
