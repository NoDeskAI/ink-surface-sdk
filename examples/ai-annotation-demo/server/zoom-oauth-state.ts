/**
 * Zoom Server-to-Server OAuth 状态：从 hub env 读取账号级凭据，在进程内缓存 1h access token，
 * 提前 5 分钟刷新并对换取请求 single-flight；不使用 per-user OAuth、refresh token，也不落盘 token。
 */
import { createHash } from 'node:crypto';

const ZOOM_TOKEN_ENDPOINT = 'https://zoom.us/oauth/token';
const EARLY_REFRESH_MS = 5 * 60_000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export interface ZoomS2SEnv {
  ZOOM_S2S_ACCOUNT_ID?: string;
  ZOOM_S2S_CLIENT_ID?: string;
  ZOOM_S2S_CLIENT_SECRET?: string;
}

interface ZoomS2SConfig {
  accountId: string;
  clientId: string;
  clientSecret: string;
  fingerprint: string;
}

interface CachedZoomToken {
  accessToken: string;
  expiresAtMs: number;
}

export interface ZoomS2SOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  forceRefresh?: boolean;
}

export interface ZoomS2SStatus {
  configured: boolean;
  token_ok: boolean;
  last_error: string | null;
}

export class ZoomOAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'ZoomOAuthError';
    this.status = status;
    this.code = code;
  }
}

const tokenCache = new Map<string, CachedZoomToken>();
const tokenInflight = new Map<string, Promise<string>>();
const lastErrors = new Map<string, string>();

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function configFingerprint(accountId: string, clientId: string, clientSecret: string): string {
  return createHash('sha256').update(`${accountId}\0${clientId}\0${clientSecret}`).digest('hex');
}

function zoomS2SConfig(env: ZoomS2SEnv): ZoomS2SConfig | null {
  const accountId = clean(env.ZOOM_S2S_ACCOUNT_ID);
  const clientId = clean(env.ZOOM_S2S_CLIENT_ID);
  const clientSecret = clean(env.ZOOM_S2S_CLIENT_SECRET);
  if (!accountId || !clientId || !clientSecret) return null;
  return { accountId, clientId, clientSecret, fingerprint: configFingerprint(accountId, clientId, clientSecret) };
}

function requireZoomS2SConfig(env: ZoomS2SEnv): ZoomS2SConfig {
  const config = zoomS2SConfig(env);
  if (!config) throw new ZoomOAuthError('zoom_s2s_not_configured', 401, 'Zoom Server-to-Server OAuth is not configured');
  return config;
}

function cacheUsable(cached: CachedZoomToken | undefined, nowMs: number): cached is CachedZoomToken {
  return !!cached?.accessToken && nowMs + EARLY_REFRESH_MS < cached.expiresAtMs;
}

function credentialUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ZoomOAuthError('zoom_credential_url_invalid', 502, 'Zoom credential URL is invalid');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (hostname !== 'zoom.us' && !hostname.endsWith('.zoom.us'))) {
    throw new ZoomOAuthError('zoom_credential_url_untrusted', 502, 'Zoom credentials may only be sent to trusted HTTPS Zoom hosts');
  }
  return url;
}

function redirectLocation(response: Response, current: URL): URL | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = clean(response.headers.get('location'));
  if (!location) throw new ZoomOAuthError('zoom_redirect_location_missing', 502, 'Zoom redirect response is missing Location');
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new ZoomOAuthError('zoom_redirect_location_invalid', 502, 'Zoom redirect Location is invalid');
  }
  if (next.protocol !== 'https:') {
    throw new ZoomOAuthError('zoom_redirect_url_untrusted', 502, 'Zoom redirects must use HTTPS');
  }
  return next;
}

function trustedZoomHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === 'zoom.us' || hostname.endsWith('.zoom.us');
}

async function fetchWithValidatedRedirects(
  input: string | URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
  authorization?: string,
): Promise<Response> {
  let current = credentialUrl(input);
  let maySendAuthorization = true;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const headers = new Headers(init.headers);
    if (authorization && maySendAuthorization) headers.set('authorization', authorization);
    else headers.delete('authorization');
    const response = await fetchImpl(current, { ...init, headers, redirect: 'manual' });
    const next = redirectLocation(response, current);
    if (!next) return response;
    if (redirectCount === MAX_REDIRECTS) {
      throw new ZoomOAuthError('zoom_redirect_limit_exceeded', 502, 'Zoom redirect limit exceeded');
    }
    const nextIsTrusted = trustedZoomHost(next);
    maySendAuthorization = maySendAuthorization && nextIsTrusted;
    if (!nextIsTrusted) next.searchParams.delete('access_token');
    current = next;
  }
  throw new ZoomOAuthError('zoom_redirect_limit_exceeded', 502, 'Zoom redirect limit exceeded');
}

async function fetchTokenWithTimeout(fetchImpl: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutError = new ZoomOAuthError('zoom_s2s_token_timeout', 504, 'Zoom token exchange timed out');
  const timer = setTimeout(() => controller.abort(timeoutError), TOKEN_EXCHANGE_TIMEOUT_MS);
  timer.unref?.();
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason || timeoutError), { once: true });
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ZoomOAuthError('zoom_s2s_invalid_response', 502, 'Zoom token endpoint returned invalid JSON');
  }
}

export function zoomS2SConfigured(env: ZoomS2SEnv = process.env): boolean {
  return !!zoomS2SConfig(env);
}

export function getZoomS2SAccessToken(
  env: ZoomS2SEnv = process.env,
  options: ZoomS2SOptions = {},
): Promise<string> {
  let config: ZoomS2SConfig;
  try {
    config = requireZoomS2SConfig(env);
  } catch (error) {
    return Promise.reject(error);
  }
  const nowMs = options.nowMs ?? Date.now();
  const cached = tokenCache.get(config.fingerprint);
  if (!options.forceRefresh && cacheUsable(cached, nowMs)) return Promise.resolve(cached.accessToken);
  const current = tokenInflight.get(config.fingerprint);
  if (current) return current;

  const job = (async (): Promise<string> => {
    const url = new URL(ZOOM_TOKEN_ENDPOINT);
    url.searchParams.set('grant_type', 'account_credentials');
    url.searchParams.set('account_id', config.accountId);
    const response = await fetchTokenWithTimeout(options.fetchImpl || fetch, url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    if (!response.ok) {
      throw new ZoomOAuthError(
        'zoom_s2s_token_request_failed',
        response.status >= 500 ? 502 : 401,
        `Zoom token request failed (HTTP ${response.status})`,
      );
    }
    const body = await readJson(response);
    const accessToken = clean(body.access_token);
    const expiresIn = Number(body.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ZoomOAuthError('zoom_s2s_token_invalid', 502, 'Zoom token response is missing access_token or expires_in');
    }
    tokenCache.set(config.fingerprint, { accessToken, expiresAtMs: nowMs + expiresIn * 1000 });
    lastErrors.delete(config.fingerprint);
    return accessToken;
  })().catch((error) => {
    const code = error instanceof ZoomOAuthError ? error.code : 'zoom_s2s_token_request_failed';
    lastErrors.set(config.fingerprint, code);
    throw error instanceof ZoomOAuthError
      ? error
      : new ZoomOAuthError(code, 502, 'Zoom token request failed');
  }).finally(() => {
    tokenInflight.delete(config.fingerprint);
  });
  tokenInflight.set(config.fingerprint, job);
  return job;
}

/** 带 S2S Bearer 的 Zoom 请求；首次 401 会失效旧 token、强制换取并且只重放一次。 */
export async function zoomS2SFetch(
  input: string | URL,
  init: RequestInit = {},
  env: ZoomS2SEnv = process.env,
  options: Pick<ZoomS2SOptions, 'fetchImpl' | 'nowMs'> = {},
): Promise<Response> {
  credentialUrl(input);
  const config = requireZoomS2SConfig(env);
  const fetchImpl = options.fetchImpl || fetch;
  const request = async (token: string): Promise<Response> => {
    return fetchWithValidatedRedirects(input, init, fetchImpl, `Bearer ${token}`);
  };
  const firstToken = await getZoomS2SAccessToken(env, options);
  const first = await request(firstToken);
  if (first.status !== 401) return first;
  const cached = tokenCache.get(config.fingerprint);
  if (cached?.accessToken === firstToken) tokenCache.delete(config.fingerprint);
  const refreshed = await getZoomS2SAccessToken(env, { ...options, forceRefresh: true });
  return request(refreshed);
}

/** Download-token URLs use the same trusted first hop and manual redirect policy, without adding S2S Bearer. */
export function zoomDownloadTokenFetch(
  input: string | URL,
  init: RequestInit = {},
  options: Pick<ZoomS2SOptions, 'fetchImpl'> = {},
): Promise<Response> {
  return fetchWithValidatedRedirects(input, init, options.fetchImpl || fetch);
}

/** 默认只做静态/缓存检查；probe=true 时实际换取一次 token 来验证 credentials。 */
export async function zoomS2SStatus(
  env: ZoomS2SEnv = process.env,
  options: Pick<ZoomS2SOptions, 'fetchImpl' | 'nowMs'> & { probe?: boolean } = {},
): Promise<ZoomS2SStatus> {
  const config = zoomS2SConfig(env);
  if (!config) return { configured: false, token_ok: false, last_error: 'zoom_s2s_not_configured' };
  if (options.probe) {
    try {
      await getZoomS2SAccessToken(env, options);
    } catch {
      // lastErrors 已由 token 换取路径记录稳定错误码，状态接口不回显响应正文。
    }
  }
  return {
    configured: true,
    token_ok: cacheUsable(tokenCache.get(config.fingerprint), options.nowMs ?? Date.now()),
    last_error: lastErrors.get(config.fingerprint) || null,
  };
}

export function zoomOAuthErrorPayload(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  const status = error instanceof ZoomOAuthError ? error.status : Number((error as { status?: number })?.status) || 500;
  const code = error instanceof ZoomOAuthError ? error.code : 'zoom_s2s_failed';
  const message = error instanceof Error ? error.message : String(error);
  return { status, body: { error: { code, message } } };
}

/** 仅供单测隔离全局内存缓存。 */
export function resetZoomS2SStateForTests(): void {
  tokenCache.clear();
  tokenInflight.clear();
  lastErrors.clear();
}
