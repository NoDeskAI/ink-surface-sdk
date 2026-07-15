import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_OAUTH_SCOPES,
  beginGoogleDeviceOAuth,
  completeGoogleOAuthCallback,
  googleDeviceOAuthCompletion,
  googleOAuthTokenPath,
  resolveAnyUserGoogleToken,
  resolveGoogleOAuthStatus,
  resolveUserGoogleToken,
  type GoogleOAuthEnv,
  type GoogleOAuthIdentity,
} from './google-oauth-state';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
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

  it('atomically persists pending and token files with private permissions', async () => {
    const runtimeEnv = env();
    const root = runtimeEnv.GOOGLE_AUTH_ROOT as string;
    const nowMs = Date.parse('2026-07-14T08:00:00.000Z');
    const pendingPath = join(root, 'pending-device-oauth.json');
    chmodSync(root, 0o755);

    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-private', nowMs });

    expect(mode(root)).toBe(0o700);
    expect(mode(pendingPath)).toBe(0o600);

    chmodSync(root, 0o755);
    chmodSync(pendingPath, 0o644);
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-private-2', nowMs: nowMs + 1 });

    expect(mode(root)).toBe(0o700);
    expect(mode(pendingPath)).toBe(0o600);

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'private-access',
        refresh_token: 'private-refresh',
        expires_in: 3600,
        scope: GOOGLE_OAUTH_SCOPES.join(' '),
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'private-access-refreshed', expires_in: 3600 }));
    await completeGoogleOAuthCallback(runtimeEnv, {
      code: 'code-private',
      state: 'state-private',
    }, {
      nowMs: nowMs + 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const tokenPath = googleOAuthTokenPath(runtimeEnv, identity);
    const tokenDirectory = dirname(tokenPath);
    expect(mode(tokenDirectory)).toBe(0o700);
    expect(mode(tokenPath)).toBe(0o600);

    chmodSync(tokenDirectory, 0o755);
    chmodSync(tokenPath, 0o644);
    await resolveUserGoogleToken(runtimeEnv, identity, nowMs + 3, {
      forceRefresh: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(mode(tokenDirectory)).toBe(0o700);
    expect(mode(tokenPath)).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(tokenDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(tokenPath, 'utf8'))).toMatchObject({
      access_token: 'private-access-refreshed',
      refresh_token: 'private-refresh',
    });
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

  it('keeps transient refresh failures retryable and succeeds on the next attempt', async () => {
    const runtimeEnv = env();
    const initialMs = Date.parse('2026-07-14T08:00:00.000Z');
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-transient', nowMs: initialMs });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'expired-access',
        refresh_token: 'retryable-refresh',
        expires_in: 1,
        scope: GOOGLE_OAUTH_SCOPES.join(' '),
      }))
      .mockResolvedValueOnce(jsonResponse({ error: 'server_error', error_description: 'temporary outage' }, 503))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'recovered-access', expires_in: 3600 }));
    await completeGoogleOAuthCallback(runtimeEnv, {
      code: 'code-transient',
      state: 'state-transient',
    }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: initialMs,
    });

    const failed = await resolveUserGoogleToken(runtimeEnv, identity, initialMs + 2_000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(failed).toMatchObject({
      usable: false,
      reauthRequired: false,
      reason: 'google_oauth_refresh_transient_failure',
      refreshError: 'server_error',
      refreshTokenPresent: true,
    });
    expect(JSON.parse(readFileSync(googleOAuthTokenPath(runtimeEnv, identity), 'utf8'))).toMatchObject({
      refresh_token: 'retryable-refresh',
      reauth_required: false,
      refresh_error: 'server_error',
      updated_at: new Date(initialMs + 2_000).toISOString(),
    });

    const recovered = await resolveUserGoogleToken(runtimeEnv, identity, initialMs + 3_000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(recovered).toMatchObject({ usable: true, token: 'recovered-access', refreshed: true, reauthRequired: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(googleOAuthTokenPath(runtimeEnv, identity), 'utf8'))).not.toHaveProperty('refresh_error');
  });

  it('marks unrecoverable OAuth refresh failures as reauth_required on disk and in public status', async () => {
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
      refresh_error: 'invalid_grant',
    });

    const repeated = await resolveUserGoogleToken(runtimeEnv, identity, initialMs + 3_000, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(repeated).toMatchObject({ usable: false, reauthRequired: true, reason: 'reauth_required' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('preserves a concurrent begin when a callback succeeds', async () => {
    const runtimeEnv = env();
    const nowMs = Date.parse('2026-07-14T08:00:00.000Z');
    const otherIdentity: GoogleOAuthIdentity = { tenantId: 'tenant-b', userId: 'user-b', deviceId: 'paper-2' };
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-callback-success', nowMs });

    let completeExchange!: (response: Response) => void;
    const exchangeResponse = new Promise<Response>((resolve) => {
      completeExchange = resolve;
    });
    const callback = completeGoogleOAuthCallback(runtimeEnv, {
      code: 'code-concurrent-success',
      state: 'state-callback-success',
    }, {
      nowMs: nowMs + 1,
      fetchImpl: vi.fn(() => exchangeResponse) as unknown as typeof fetch,
    });

    beginGoogleDeviceOAuth(runtimeEnv, otherIdentity, { state: 'state-concurrent-success', nowMs: nowMs + 2 });
    completeExchange(jsonResponse({
      access_token: 'concurrent-access',
      refresh_token: 'concurrent-refresh',
      expires_in: 3600,
      scope: GOOGLE_OAUTH_SCOPES.join(' '),
    }));
    await callback;

    expect(googleDeviceOAuthCompletion(runtimeEnv, identity, nowMs + 3)).toMatchObject({ status: 'complete' });
    expect(googleDeviceOAuthCompletion(runtimeEnv, otherIdentity, nowMs + 3)).toMatchObject({ status: 'pending' });
  });

  it('preserves a concurrent begin when a callback fails', async () => {
    const runtimeEnv = env();
    const nowMs = Date.parse('2026-07-14T08:00:00.000Z');
    const otherIdentity: GoogleOAuthIdentity = { tenantId: 'tenant-b', userId: 'user-b', deviceId: 'paper-2' };
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-callback-failure', nowMs });

    let completeExchange!: (response: Response) => void;
    const exchangeResponse = new Promise<Response>((resolve) => {
      completeExchange = resolve;
    });
    const callback = completeGoogleOAuthCallback(runtimeEnv, {
      code: 'code-concurrent-failure',
      state: 'state-callback-failure',
    }, {
      nowMs: nowMs + 1,
      fetchImpl: vi.fn(() => exchangeResponse) as unknown as typeof fetch,
    });

    beginGoogleDeviceOAuth(runtimeEnv, otherIdentity, { state: 'state-concurrent-failure', nowMs: nowMs + 2 });
    completeExchange(jsonResponse({ error: 'access_denied', error_description: 'authorization denied' }, 400));
    await expect(callback).rejects.toThrow('authorization denied');

    expect(googleDeviceOAuthCompletion(runtimeEnv, identity, nowMs + 3)).toMatchObject({ status: 'failed' });
    expect(googleDeviceOAuthCompletion(runtimeEnv, otherIdentity, nowMs + 3)).toMatchObject({ status: 'pending' });
  });

  it('resolves a user token without requiring the originating device id', async () => {
    const runtimeEnv = env();
    const nowMs = Date.parse('2026-07-14T08:00:00.000Z');
    beginGoogleDeviceOAuth(runtimeEnv, identity, { state: 'state-user-token', nowMs });
    await completeGoogleOAuthCallback(runtimeEnv, {
      code: 'code-user-token',
      state: 'state-user-token',
    }, {
      nowMs,
      fetchImpl: vi.fn(async () => jsonResponse({
        access_token: 'user-access-token',
        refresh_token: 'user-refresh-token',
        expires_in: 3600,
        scope: GOOGLE_OAUTH_SCOPES.join(' '),
      })) as unknown as typeof fetch,
    });

    const resolved = await resolveAnyUserGoogleToken(runtimeEnv, {
      tenantId: identity.tenantId,
      userId: identity.userId,
    }, nowMs + 1_000);

    expect(resolved).toMatchObject({ usable: true, token: 'user-access-token' });
  });
});
