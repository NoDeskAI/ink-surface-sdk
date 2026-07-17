import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getZoomS2SAccessToken,
  resetZoomS2SStateForTests,
  zoomS2SFetch,
  zoomS2SStatus,
  type ZoomS2SEnv,
} from './zoom-oauth-state';

const NOW_MS = Date.parse('2026-07-17T00:00:00.000Z');
const env: ZoomS2SEnv = {
  ZOOM_S2S_ACCOUNT_ID: 'account-id',
  ZOOM_S2S_CLIENT_ID: 'client-id',
  ZOOM_S2S_CLIENT_SECRET: 'client-secret',
};

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetZoomS2SStateForTests();
  vi.restoreAllMocks();
});

describe('zoom S2S OAuth state', () => {
  it('uses Basic account_credentials and serves subsequent requests from memory cache', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('token-1'));
    await expect(getZoomS2SAccessToken(env, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS })).resolves.toBe('token-1');
    await expect(getZoomS2SAccessToken(env, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS + 1_000 })).resolves.toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.searchParams.get('grant_type')).toBe('account_credentials');
    expect(input.searchParams.get('account_id')).toBe('account-id');
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  });

  it('refreshes when the cached token enters the five-minute early-expiry window', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResponse('token-1'))
      .mockResolvedValueOnce(tokenResponse('token-2'));
    await getZoomS2SAccessToken(env, { fetchImpl, nowMs: NOW_MS });
    await expect(getZoomS2SAccessToken(env, { fetchImpl, nowMs: NOW_MS + 55 * 60_000 })).resolves.toBe('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent token exchanges', async () => {
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = getZoomS2SAccessToken(env, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS });
    const second = getZoomS2SAccessToken(env, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(tokenResponse('shared-token'));
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
  });

  it('hard-times out token exchange after ten seconds and clears the failed single-flight', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const first = getZoomS2SAccessToken(env, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS });
    const timedOut = expect(first).rejects.toMatchObject({ code: 'zoom_s2s_token_timeout', status: 504 });
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;

    fetchImpl.mockResolvedValueOnce(tokenResponse('recovered-token'));
    await expect(getZoomS2SAccessToken(env, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS })).resolves.toBe('recovered-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('forces one refresh on API 401 and never retries a second 401', async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') {
        const tokenCalls = fetchImpl.mock.calls.filter(([value]) => new URL(String(value)).hostname === 'zoom.us').length;
        return tokenResponse(`token-${tokenCalls}`);
      }
      return new Response('', { status: 401 });
    });
    const response = await zoomS2SFetch('https://api.zoom.us/v2/users/me', {}, env, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: NOW_MS,
    });
    expect(response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const apiCalls = fetchImpl.mock.calls.filter(([value]) => new URL(String(value)).hostname === 'api.zoom.us');
    expect(apiCalls).toHaveLength(2);
    expect(new Headers(apiCalls[0][1]?.headers).get('authorization')).toBe('Bearer token-1');
    expect(new Headers(apiCalls[1][1]?.headers).get('authorization')).toBe('Bearer token-2');
  });

  it('uses manual redirects and strips Bearer after a redirect leaves Zoom domains', async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return tokenResponse('redirect-token');
      if (url.hostname === 'api.zoom.us') {
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer redirect-token');
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/result?access_token=must-not-leak' } });
      }
      if (url.hostname === 'cdn.example.test') {
        expect(url.searchParams.get('access_token')).toBeNull();
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        return new Response('downloaded', { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const response = await zoomS2SFetch('https://api.zoom.us/v2/redirect', {}, env, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: NOW_MS,
    });
    expect(await response.text()).toBe('downloaded');
  });

  it('rejects an untrusted first hop before token exchange or credentialed fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(zoomS2SFetch('https://evil.example.test/steal', {}, env, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: NOW_MS,
    })).rejects.toMatchObject({ code: 'zoom_credential_url_untrusted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports and rejects an explicitly unconfigured environment without making a request', async () => {
    const fetchImpl = vi.fn();
    await expect(zoomS2SStatus({}, { fetchImpl: fetchImpl as typeof fetch })).resolves.toEqual({
      configured: false,
      token_ok: false,
      last_error: 'zoom_s2s_not_configured',
    });
    await expect(getZoomS2SAccessToken({}, { fetchImpl: fetchImpl as typeof fetch })).rejects.toMatchObject({
      code: 'zoom_s2s_not_configured',
      status: 401,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
