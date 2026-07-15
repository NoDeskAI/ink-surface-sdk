/**
 * 客户端 AI 传输信封：把分散在各调用点的 fetch('/api/...') 样板收口到一处。
 *
 *   - postJson：一次性 JSON POST，失败即抛（!ok 与网络错统一成一条 catch 路径）。
 *   - postNdjson：流式 NDJSON POST，逐行解析后回调，容忍半行/坏行。
 *
 * 只吸收 HTTP 样板（method/headers/序列化/ok 校验/分帧）；**降级语义留给各调用方**
 * （recognize 返默认、reflow 返原值、classify 返 {respond:true}……各不相同，不能一刀切）。
 */

/**
 * 生产/安卓包 API 基址：本地 V1 默认走同一台机器的局域网 Cloud Hub，而不是各端各自命中
 * Vite dev 中间件。Web UI 可以仍跑 8765，Cloud Hub 固定 8731；安卓包构建时会注入
 * `VITE_API_BASE_URL=http://<mac-lan-ip>:8731`。
 */
// ── API 线路（所有设备直连的云服务共用这一个出口：AI(interpret/chat/classify) + 知识库导出(panel-vault)
//    + 飞书妙记(panel-feishu) + 设备登录 + convert 全走 apiUrl）──
// 运行时可切换（换地方免重打包）：localStorage `inkloop.apiRoute` 覆盖烧录默认。''/'default'=烧录默认；
// 'intranet'/'cloud'=下面内置路由；也可存自定义 http(s):// URL。dev 页「网络线路」下拉调 setApiRoute。
const BAKED_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
const LOCAL_CLOUD_HUB_PORT = '8731';
function inferLocalCloudHubBase(): string {
  if (typeof window === 'undefined') return '';
  try {
    const { protocol, hostname } = window.location;
    if ((protocol !== 'http:' && protocol !== 'https:') || !hostname) return '';
    if (hostname === 'appassets.androidplatform.net') {
      if (BAKED_BASE) return BAKED_BASE;
      const port = localStorage.getItem('inkloop.cloudHubPort') || LOCAL_CLOUD_HUB_PORT;
      return `http://127.0.0.1:${port}`;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      const port = localStorage.getItem('inkloop.cloudHubPort') || LOCAL_CLOUD_HUB_PORT;
      return `${protocol}//${hostname}:${port}`.replace(/\/+$/, '');
    }
    if (BAKED_BASE) return BAKED_BASE;
    const port = localStorage.getItem('inkloop.cloudHubPort') || LOCAL_CLOUD_HUB_PORT;
    return `${protocol}//${hostname}:${port}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}
const DEFAULT_API_BASE = inferLocalCloudHubBase();
const DEV_INTRANET_BASE = BAKED_BASE.startsWith('http://') ? BAKED_BASE : DEFAULT_API_BASE;
const KNOWN_ROUTES: Record<string, string> = {
  intranet: DEV_INTRANET_BASE,               // 内网直连；debug 本地包优先使用构建时烧录的 Mac LAN Cloud Hub 地址。
  cloud: 'https://inkloopai.xiaobuyu.trade', // cloudflared 公网（内外网通用；https 无需明文配置）
};
const ROUTE_KEY = 'inkloop.apiRoute';
function readRouteOverride(): string {
  try {
    return localStorage.getItem(ROUTE_KEY) || '';
  } catch { return ''; }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isPrivateOrLocalHost(hostname: string): boolean {
  return isLoopbackHost(hostname)
    || hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || hostname.startsWith('169.254.')
    || hostname.startsWith('172.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

export function normalizeLocalCloudHubBase(base: string): string {
  if (!base) return '';
  try {
    const url = new URL(base);
    if (url.protocol === 'https:' && url.port === '8732' && isPrivateOrLocalHost(url.hostname)) {
      url.protocol = 'http:';
      url.port = LOCAL_CLOUD_HUB_PORT;
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    return base.replace(/\/+$/, '');
  }
  return base.replace(/\/+$/, '');
}

function routeOverrideUsable(route: string): boolean {
  if (!/^https?:\/\//i.test(route) || typeof window === 'undefined') return true;
  try {
    const pageHost = window.location.hostname;
    const routeHost = new URL(route).hostname;
    return isLoopbackHost(pageHost) || !isLoopbackHost(routeHost);
  } catch {
    return true;
  }
}

function resolveApiBase(): string {
  const raw = readRouteOverride();
  const o = routeOverrideUsable(raw) ? raw : '';
  if (raw && !o) {
    try { localStorage.removeItem(ROUTE_KEY); } catch { /* ignore stale route cleanup failures */ }
  }
  if (o && KNOWN_ROUTES[o]) return normalizeLocalCloudHubBase(KNOWN_ROUTES[o]);
  if (/^https?:\/\//i.test(o)) return normalizeLocalCloudHubBase(o); // 自定义绝对 URL
  return normalizeLocalCloudHubBase(DEFAULT_API_BASE);
}
let API_BASE = resolveApiBase();

function localCloudHubHttpFallback(url: string): string | null {
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : undefined);
    if (u.protocol !== 'https:' || u.port !== '8732' || !isPrivateOrLocalHost(u.hostname)) return null;
    u.protocol = 'http:';
    u.port = LOCAL_CLOUD_HUB_PORT;
    return u.toString();
  } catch {
    return null;
  }
}

export const DEFAULT_API_TIMEOUT_MS = 30_000;

export class ApiTimeoutError extends Error {
  override name = 'TimeoutError';
  readonly code = 'request_timeout';
}

export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly url: string,
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail || code ? `${url} ${status}: ${detail || code}` : `${url} ${status}`);
  }
}

interface RequestBudget {
  signal?: AbortSignal;
  timedOut: () => boolean;
  cancel: () => void;
}

function createRequestBudget(signal: AbortSignal | undefined, timeoutMs: number | null): RequestBudget {
  if (signal || timeoutMs == null) return { signal, timedOut: () => false, cancel: () => {} };
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel: () => globalThis.clearTimeout(timer),
  };
}

function normalizeRequestError(error: unknown, budget: RequestBudget, label: string): unknown {
  if (!budget.timedOut()) return error;
  return new ApiTimeoutError(`${label}超过请求时限`);
}

async function withRequestBudget<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const budget = createRequestBudget(signal, timeoutMs);
  try {
    return await run(budget.signal!);
  } catch (error) {
    throw normalizeRequestError(error, budget, label);
  } finally {
    budget.cancel();
  }
}

export async function fetchWithLocalCloudHubFallback(
  input: string,
  init?: RequestInit,
  timeoutMs: number | null = DEFAULT_API_TIMEOUT_MS,
): Promise<Response> {
  const budget = createRequestBudget(init?.signal ?? undefined, timeoutMs);
  const effectiveInit = { ...init, signal: budget.signal };
  try {
    try {
      return await fetch(input, effectiveInit);
    } catch (error) {
      if (budget.signal?.aborted) throw error;
      const fallback = localCloudHubHttpFallback(input);
      if (!fallback) throw error;
      const resp = await fetch(fallback, effectiveInit);
      if (resp.ok) {
        try {
          const u = new URL(fallback);
          API_BASE = `${u.protocol}//${u.host}`;
        } catch { /* keep current route if URL parsing ever fails */ }
      }
      return resp;
    }
  } catch (error) {
    throw normalizeRequestError(error, budget, `请求 ${input}`);
  } finally {
    budget.cancel();
  }
}

/** 运行时切换所有云服务共用的 API 线路（换地方免重打包·立即对后续请求生效）。
 *  route: ''/'default'=用烧录默认；'intranet'/'cloud'=内置路由；或自定义 http(s):// URL。 */
export function setApiRoute(route: string): void {
  try {
    if (!route || route === 'default') localStorage.removeItem(ROUTE_KEY);
    else localStorage.setItem(ROUTE_KEY, route);
  } catch { /* localStorage 不可用则仅本次会话不持久 */ }
  API_BASE = resolveApiBase();
}
/** dev 页显示用：当前线路选择的原始值（''=烧录默认）。 */
export function apiRouteChoice(): string { return readRouteOverride(); }
/** dev 页显示用：当前实际生效的 base（空=dev 同源）。 */
export function apiBase(): string { return API_BASE; }

/** 导出供直连 fetch 的调用点复用（不走 getJson/postJson 的场景，如二进制下载）——codex 扫描出的真 bug：
 *  会中资料链路(feishuGet/fetchPdfBytes/listMeetingGroupMaterialFiles)之前裸 fetch('/api/...')，
 *  安卓静态包(WebView appassets 源)下不会走 VITE_API_BASE_URL，直接打到 assets 域名 404。 */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;                    // dev：同源 /api/*
  if (/^https?:\/\//i.test(path)) return path;   // 已是绝对 URL，原样
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 直连型长连接/XHR 无法像 postJson/getJson 那样统一 catch 重试；本地 debug Cloud Hub 的自签 HTTPS
 *  在部分 Android WebView 中会直接 Failed to fetch，因此这些入口先使用同主机 HTTP 8731。公网 HTTPS 不变。 */
export function apiUrlWithLocalHttpFallback(path: string): string {
  const url = apiUrl(path);
  return localCloudHubHttpFallback(url) ?? url;
}

import { authHeaders, handleAuthFailure } from './auth';

export type ApiOpts = {
  signal?: AbortSignal;
  timeoutMs?: number;
  acceptStatuses?: number[];
  auth?: boolean;
};

/** 阶段C：哪些路径自动带设备 session——只覆盖 panel/受保护代理路由，AI 推理端点(/api/chat等)这轮不动，
 *  避免一次性把还没接 session 校验的服务端一起改坏行为。调用方可用 opts.auth 显式覆盖。 */
function shouldSendAuth(url: string, opts?: ApiOpts): boolean {
  if (opts?.auth === false) return false;
  if (opts?.auth === true) return true;
  return /^\/api\/(?:panel-feishu|panel-vault|feishu-svc|convert)(?:\/|$)/.test(url);
}

function headersWithAuth(url: string, base?: Record<string, string>, opts?: ApiOpts): Record<string, string> {
  return shouldSendAuth(url, opts) ? { ...(base || {}), ...authHeaders() } : { ...(base || {}) };
}

async function parseApiFailure(resp: Response): Promise<{ code: string; message: string }> {
  try {
    const data = await resp.clone().json() as {
      error?: string | { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    const nested = data.error && typeof data.error === 'object' ? data.error : null;
    return {
      code: String(nested?.code || (typeof data.error === 'string' ? data.error : '') || data.code || ''),
      message: String(nested?.message || data.message || ''),
    };
  } catch {
    return { code: '', message: '' };
  }
}

/** 401/403 且能识别出"需要重新登录"的错误码时，清本地 session + 派发 `inkloop:reauth-required`
 *  （auth-login.ts 监听后重新弹二维码）。不抛错——调用方原有的状态码判断逻辑照常处理这次失败。 */
async function notifyAuthFailureIfNeeded(resp: Response): Promise<void> {
  if (resp.status !== 401 && resp.status !== 403 && resp.status !== 409) return;
  const failure = await parseApiFailure(resp);
  if (
    failure.code === 'reauth_required'
    || failure.code === 'missing_session_token'
    || failure.code === 'invalid_session'
    || (resp.status === 401 && !failure.code)
  ) {
    handleAuthFailure(failure.code || 'reauth_required');
  }
}

async function throwForApiStatus(url: string, resp: Response, acceptStatuses?: number[]): Promise<void> {
  if (resp.ok || acceptStatuses?.includes(resp.status)) return;
  const failure = await parseApiFailure(resp);
  throw new ApiError(url, resp.status, failure.code, failure.message);
}

/** 需要设备 session 但不走 JSON 收发的原始 fetch（如二进制下载）。 */
export async function authFetch(path: string, init: RequestInit = {}, opts?: ApiOpts): Promise<Response> {
  const headers = new Headers(init.headers || undefined);
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
  const explicitSignal = opts?.signal ?? init.signal ?? undefined;
  const budget = createRequestBudget(explicitSignal, opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
  try {
    const resp = await fetchWithLocalCloudHubFallback(apiUrl(path), { ...init, headers, signal: budget.signal });
    await notifyAuthFailureIfNeeded(resp);
    if (!resp.body) budget.cancel();
    return resp;
  } catch (error) {
    budget.cancel();
    throw normalizeRequestError(error, budget, `请求 ${path}`);
  }
}

/** 发后不管的 JSON POST（遥测/beacon）：失败静默、不阻塞、不抛。keepalive 让翻页/退出时也能送达。 */
export function postBeacon(url: string, body: unknown): void {
  try {
    void fetchWithLocalCloudHubFallback(apiUrl(url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), keepalive: true,
    }, null).catch(() => { /* beacon 不在/出错都无所谓 */ });
  } catch { /* 序列化出错也不连累 UI */ }
}

/** 一次性 JSON POST。失败（!resp.ok 且状态码不在 opts.acceptStatuses 里）一律抛错，调用方自行 try/catch 兜底。
 *  acceptStatuses：个别非 2xx 状态码本身携带可展示的结构化 body（如 409 表示"缺依赖不是真失败"），
 *  调用方想正常解析这份 body 而非被泛化成异常时传入（codex 扫描出的真 bug：不传时 body 会被整个丢弃）。 */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts?: ApiOpts,
): Promise<T> {
  return withRequestBudget(opts?.signal, opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS, `POST ${url}`, async (signal) => {
    const resp = await fetchWithLocalCloudHubFallback(apiUrl(url), {
      method: 'POST',
      headers: headersWithAuth(url, { 'content-type': 'application/json' }, opts),
      signal,
      body: JSON.stringify(body),
    });
    await notifyAuthFailureIfNeeded(resp);
    await throwForApiStatus(url, resp, opts?.acceptStatuses);
    return (await resp.json()) as T;
  });
}

/**
 * 一次性 JSON GET（经 apiUrl·支持安卓包绝对基址）。失败（!ok / 网络错）即抛。
 * WS2-C panel-feishu client 走它，不裸 fetch('/api/...')（dev 同源 + 生产 VITE_API_BASE_URL 都覆盖）。
 */
export async function getJson<T>(url: string, opts?: ApiOpts): Promise<T> {
  return withRequestBudget(opts?.signal, opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS, `GET ${url}`, async (signal) => {
    const resp = await fetchWithLocalCloudHubFallback(apiUrl(url), {
      method: 'GET',
      signal,
      headers: headersWithAuth(url, undefined, opts),
    });
    await notifyAuthFailureIfNeeded(resp);
    await throwForApiStatus(url, resp, opts?.acceptStatuses);
    return (await resp.json()) as T;
  });
}

/**
 * 流式 NDJSON POST：边收边按 '\n' 切行，逐行 JSON.parse 后调 onLine。
 * 半行先攒着、坏行跳过、收尾处理残行。失败（!ok / 无 body）抛错。
 */
export async function postNdjson<T>(
  url: string,
  body: unknown,
  onLine: (parsed: T) => void,
  opts?: ApiOpts,
): Promise<void> {
  const resp = await fetchWithLocalCloudHubFallback(apiUrl(url), {
    method: 'POST',
    headers: headersWithAuth(url, { 'content-type': 'application/json' }, opts),
    signal: opts?.signal,
    body: JSON.stringify(body),
  }, null);
  await notifyAuthFailureIfNeeded(resp);
  if (!resp.ok) throw new Error(`${url} ${resp.status}`);
  const consume = (line: string): void => {
    if (!line) return;
    try { onLine(JSON.parse(line) as T); } catch { /* 容忍半行/坏行 */ }
  };
  // 非流式兜底：某些代理/CDN/WebView 会缓冲或剥离流式 body，则一次性读全文按行解析。
  if (!resp.body) {
    const text = await resp.text();
    for (const line of text.split('\n')) consume(line.trim());
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      consume(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  consume(buf.trim()); // 残行
}
