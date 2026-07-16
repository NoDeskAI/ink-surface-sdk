import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handleAuthFailure: vi.fn() }));

vi.mock('./auth', () => ({
  authHeaders: () => ({}),
  handleAuthFailure: mocks.handleAuthFailure,
}));

import {
  ApiError,
  DEFAULT_API_TIMEOUT_MS,
  fetchWithLocalCloudHubFallback,
  getJson,
  normalizeLocalCloudHubBase,
} from './api';

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('normalizeLocalCloudHubBase', () => {
  it('routes private HTTPS CloudHub dev endpoints back to fixed HTTP port 8731', () => {
    expect(normalizeLocalCloudHubBase('https://172.168.21.253:8732')).toBe('http://172.168.21.253:8731');
    expect(normalizeLocalCloudHubBase('https://192.168.1.8:8732/')).toBe('http://192.168.1.8:8731');
    expect(normalizeLocalCloudHubBase('https://127.0.0.1:8732')).toBe('http://127.0.0.1:8731');
  });

  it('keeps public HTTPS routes unchanged', () => {
    expect(normalizeLocalCloudHubBase('https://inkloopai.xiaobuyu.trade')).toBe('https://inkloopai.xiaobuyu.trade');
  });
});

describe('API request timeout', () => {
  it('turns a hanging default request into a recognizable TimeoutError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input, init) => rejectOnAbort(init?.signal)));
    const assertion = expect(getJson('/api/hang')).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'request_timeout',
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS);
    await assertion;
  });

  it('uses one timeout budget across the HTTPS-to-HTTP fallback', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce((_input, init) => rejectOnAbort(init?.signal));
    vi.stubGlobal('fetch', fetchMock);
    const assertion = expect(
      fetchWithLocalCloudHubFallback('https://192.168.1.8:8732/api/test'),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
  });

  it('does not stack the default timeout over an explicit signal', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_input, init) => rejectOnAbort(init?.signal)));
    const request = getJson('/api/explicit-signal', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS * 2);
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('API failures', () => {
  it('preserves the response status and structured error code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'upstream_unavailable', message: 'Cloud Hub is restarting' },
    }), { status: 503, headers: { 'content-type': 'application/json' } })));

    await expect(getJson('/api/status')).rejects.toEqual(expect.objectContaining({
      name: 'ApiError',
      status: 503,
      code: 'upstream_unavailable',
      message: '/api/status 503: Cloud Hub is restarting',
    } satisfies Partial<ApiError>));
  });

  it('intercepts the production 409 reauth response before throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'reauth_required',
    }), { status: 409, headers: { 'content-type': 'application/json' } })));

    await expect(getJson('/api/panel-feishu/meetings')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'reauth_required',
    });
    expect(mocks.handleAuthFailure).toHaveBeenCalledWith('reauth_required');
  });
});
