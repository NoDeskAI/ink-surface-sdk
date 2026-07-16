/**
 * 托管 AI 代理（独立 Node 服务）——给安卓 WebView 包用。
 *
 * dev 期 /api/* 是 Vite 中间件（见 vite.config.ts），`npm run build` 后的静态包里不存在；
 * 本服务把同一套 server/infer.ts 的 handler 暴露成同名 HTTP 路由，让 WebView 里的相对
 * /api/*（经 VITE_API_BASE_URL 指过来）有真实后端。Key 只在服务端环境变量；
 * **不暴露 /api/__debug/***（仅 dev 调试通道，生产不部署）。
 *
 * 运行（Node ≥23.6 直跑 TS / 本仓库 v25 可直接）：
 *   PORT=3000 node server/standalone.ts        # 真实 env 由部署环境给
 *   # 或本地：读项目根 .env；或 npx tsx server/standalone.ts
 *
 * 路由与 vite.config.ts 的中间件一一对应（9 路由），契约不变。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { assertNonEmptyVaultRelease, guardPanelVaultReqUrl, panelVaultGuardPayload, resolvePanelVaultGuardUser } from './panel-vault-guard';
import {
  runReflow, runReflowAi, reflowAiStream, chatStream,
  runOcrVlm, runExplainImage, runInterpret, runClassifyContext, runReadingNotePostprocess, runMeetingPanelSummary, runReflowVlm,
} from './infer';
import { runOcrLayout } from './ocr-layout-dev.mjs';
import { createRuntimeSyncDevHandler } from './runtime-sync-dev';
import { JsonlRuntimeSyncEventStore } from './runtime-sync-store';
import { createCloudLibraryHandler } from './cloud-library-handler';
import { JsonCloudLibraryStore } from './cloud-library-store';
import { createCloudKnowledgeHandler } from './cloud-knowledge-handler';
import { createCloudDeviceHandler } from './cloud-device-handler';
import { JsonCloudDeviceStore } from './cloud-device-store';
import { fetchFeishuBotCalendarEvents } from './feishu-bot-calendar';
import {
  fetchFeishuBotMessageResource,
  fetchFeishuBotWorkspaces,
  fetchFeishuBotWorkspaceDocxLinks,
  fetchFeishuBotWorkspaceFiles,
  fetchFeishuBotWorkspaceMembers,
  fetchFeishuBotWorkspaceMessages,
} from './feishu-bot-im';
import { fetchFeishuTeamAccess } from './feishu-team-access';
import {
  beginLarkOAuthLogin,
  completeLarkOAuthCallback,
  larkOAuthAuthStatePath,
  resolveLarkOAuthPublicStatus,
  resolveUserOAuthToken,
} from './lark-oauth-state';
import { fetchLarkMeetingSources, resolveLarkMeetingInstance } from './lark-meeting-sources';
import { reconcileLarkLiveMeetings } from './lark-meeting-reconcile';
import {
  beginGoogleDeviceOAuth,
  completeGoogleOAuthCallback,
  failGoogleDeviceOAuthCallback,
  googleCalendarSyncPath,
  googleMeetRecordsPath,
  googleDeviceOAuthCompletion,
  googleAuthRoot,
  googleOAuthErrorPayload,
  resolveAnyUserGoogleToken,
  resolveGoogleOAuthStatus,
  resolveUserGoogleToken,
  type GoogleOAuthIdentity,
} from './google-oauth-state';
import { fetchGoogleMeetingSources, googleCalendarErrorPayload } from './google-calendar-sync';
import { backfillGoogleMeetSmartNotes, fetchGoogleMeetingTranscript, googleMeetRecordsErrorPayload } from './google-meet-records';
import {
  currentMtlToken,
  mintMtlToken,
  mtlReceiverBaseUrl,
  revokeMtlToken,
  type MtlReceiverIdentity,
} from './mtl-receiver-auth';
import { handleMtlReceiver, listMtlMeetingWindows, mtlAttendanceWindows } from './mtl-receiver';
import { fetchLarkDocxMedia, fetchLarkMeetingNoteTranscript } from './lark-meeting-notes';
import { exportLarkDocxToPdf } from './lark-docx-export';
import { matchLocalFeishuMaterialRoute } from './local-feishu-material-routes';
import { resolvePanelAuthBase, rewriteLegacyConvertSource } from './standalone-service-config';
import {
  larkRealtimeMeetingSources,
  larkRealtimeMeetingStoreStatus,
  upsertLarkRealtimeMeeting,
} from './lark-realtime-meeting-store';
import { getLarkWsMeetingEventsStatus, startLarkWsMeetingEvents } from './lark-ws-meeting-events';
import {
  buildFeishuBotEnv,
  deleteFeishuBotConfig,
  publicFeishuBotConfigStatus,
  resolveFeishuBotConfig,
  saveFeishuBotConfig,
} from './feishu-bot-config';
import {
  JsonCloudKnowledgeStore,
  type CloudAiTurnRecord,
  type CloudKnowledgeNamespace,
  type CloudKnowledgeObjectPatch,
} from './cloud-knowledge-store';
import { isMeetingRuntimeDocumentId, shouldPostprocessRuntimeAnnotation } from './runtime-postprocess-policy';
import { prepareRuntimeAnnotationUpdate } from './runtime-annotation-postprocess';
import { createDeadlineSingleFlight } from './background-worker';
import type { RuntimeSurfaceBlock, RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';
import {
  buildInkloopDocUri,
  canonicalJson,
  computeDocumentProjectionBodyHash,
  computeDocumentProjectionHash,
  DOCUMENT_PROJECTION_SCHEMA_VERSION,
  KO_SCHEMA_VERSION,
  sha256ContentHash,
  type DocumentProjection,
  type DocumentProjectionBlock,
  type KnowledgeKind,
  type KnowledgeObject,
  type KnowledgeStatus,
  type NormBBox,
} from '../../../packages/knowledge-schema/src/index';

// ── .env：把项目根 .env 注入 process.env（只填未设的键），与 vite.config 行为一致 ──
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const k = m[1];
      if (!process.env[k]) process.env[k] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env 时靠真实环境变量 */ }
}
loadEnvFile(resolve(ROOT, '.env'));
loadEnvFile(resolve(homedir(), '.hermes/.env'));
if (!process.env.LLM_GATEWAY_KEY && process.env.NODESK_API_KEY) process.env.LLM_GATEWAY_KEY = process.env.NODESK_API_KEY;
if (!process.env.LLM_GATEWAY_URL) process.env.LLM_GATEWAY_URL = 'https://llm-gateway-api.nodesk.tech/default/v1';
if (!process.env.LLM_GATEWAY_TRANSPORT) process.env.LLM_GATEWAY_TRANSPORT = 'openai_chat_completions';
if (!process.env.LLM_MODEL) process.env.LLM_MODEL = 'glm-5.2';

function feishuBotRuntimeEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildFeishuBotEnv(ROOT, baseEnv);
}

function feishuBotConfigStatusPayload(): ReturnType<typeof publicFeishuBotConfigStatus> {
  return publicFeishuBotConfigStatus(resolveFeishuBotConfig(ROOT, process.env));
}

// ── CORS：放行 WebView 页面 origin（appassets）+ 本地开发；额外 origin 经 CORS_EXTRA_ORIGIN ──
const ALLOW_ORIGINS = new Set<string>([
  'https://appassets.androidplatform.net',
  'http://appassets.androidplatform.net',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  ...(process.env.CORS_EXTRA_ORIGIN ? [process.env.CORS_EXTRA_ORIGIN] : []),
]);
function requestHostName(req: IncomingMessage): string {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']')).toLowerCase();
  return host.split(':')[0].toLowerCase();
}
function isLanDevOrigin(req: IncomingMessage, origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    const host = url.hostname;
    return host.toLowerCase() === requestHostName(req)
      || host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\./.test(host);
  } catch {
    return false;
  }
}
function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && (ALLOW_ORIGINS.has(origin) || isLanDevOrigin(req, origin))) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-inkloop-runtime-token, x-inkloop-session, x-inkloop-tenant-id, x-inkloop-user-id, x-inkloop-device-id');
  res.setHeader('access-control-allow-private-network', 'true');
  res.setHeader('access-control-max-age', '86400');
}

// ── WS2-C：panel 飞书事件中枢 GET 代理（注入 x-inkloop-secret·secret 不进前端）。
//    与 vite.config.ts panelFeishuProxy 同构，让安卓/生产包也能拉妙记转写。──
const PANEL_FEISHU_BASE = (process.env.PANEL_FEISHU_BASE || '').replace(/\/+$/, '');
const INKLOOP_SHARED_SECRET = process.env.INKLOOP_SHARED_SECRET || '';
// 阶段C：二维码设备登录代理 + session introspection 校验。会议 sidecar 不提供 auth，禁止从 PANEL_FEISHU_BASE 隐式继承。
const PANEL_AUTH_BASE = resolvePanelAuthBase(process.env);
const LOCAL_DEVICE_AUTH = process.env.INKLOOP_LOCAL_DEVICE_AUTH === '1';
const LOCAL_DEVICE_AUTH_AUTO_APPROVE = process.env.INKLOOP_LOCAL_DEVICE_AUTH_AUTO_APPROVE === '1';
const LOCAL_AUTH_STORE = process.env.INKLOOP_LOCAL_AUTH_STORE || resolve(ROOT, '.inkloop/auth-sessions.json');
const LOCAL_LARK_OAUTH_PENDING_STORE = process.env.INKLOOP_LARK_OAUTH_PENDING_STORE || resolve(ROOT, '.inkloop/lark-auth/pending-device-oauth.json');
const LOCAL_AUTH_TENANT_ID = process.env.INKLOOP_LOCAL_AUTH_TENANT_ID || process.env.INKLOOP_TENANT_ID || 'local';
const LOCAL_AUTH_USER_ID = process.env.INKLOOP_LOCAL_AUTH_USER_ID || process.env.INKLOOP_USER_ID || 'local_demo';
const LOCAL_AUTH_TTL_MS = Math.max(60_000, Number(process.env.INKLOOP_LOCAL_AUTH_TTL_MS || 1000 * 60 * 60 * 24 * 30) || 1000 * 60 * 60 * 24 * 30);
const LOCAL_AUTH_FLOW_TTL_MS = Math.max(60_000, Number(process.env.INKLOOP_LOCAL_AUTH_FLOW_TTL_MS || 300_000) || 300_000);

interface InkLoopSessionContext {
  active: boolean;
  session_id?: string;
  session_token?: string;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
  expires_at?: number;
  error?: string;
  feishu_open_id?: string | null; // 阶段D：introspect 顺带返回，给 handleFeishuService 转发用户上下文
}

type LocalDeviceAuthStatus = 'pending' | 'authorized' | 'delivered' | 'expired';

interface LocalDeviceAuthFlow {
  flow_id: string;
  device_id: string;
  poll_token: string;
  user_code: string;
  qr_payload: string;
  status: LocalDeviceAuthStatus;
  created_at: number;
  expires_at: number;
  authorized_at?: number;
  delivered_at?: number;
  session_token?: string;
}

interface LocalDeviceSession extends InkLoopSessionContext {
  active: true;
  session_id: string;
  session_token: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
  feishu_open_id: string | null;
  feishu_oauth_updated_at?: string | null;
}

interface LocalDeviceAuthStore {
  schema_version: 'inkloop.local_device_auth.v1';
  flows: Record<string, LocalDeviceAuthFlow>;
  sessions: Record<string, LocalDeviceSession>;
}

interface LocalLarkOAuthPendingEntry {
  state: string;
  session_token: string;
  session_id?: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  redirect_uri: string;
  created_at: number;
  expires_at: number;
}

interface LocalLarkOAuthPendingStore {
  schema_version: 'inkloop.local_lark_oauth_pending.v1';
  states: Record<string, LocalLarkOAuthPendingEntry>;
}

function bearerToken(req: IncomingMessage): string {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

function newToken(prefix: string, bytes = 18): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

function localAuthEmptyStore(): LocalDeviceAuthStore {
  return { schema_version: 'inkloop.local_device_auth.v1', flows: {}, sessions: {} };
}

function readLocalAuthStore(): LocalDeviceAuthStore {
  if (!LOCAL_DEVICE_AUTH) return localAuthEmptyStore();
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_AUTH_STORE, 'utf8')) as Partial<LocalDeviceAuthStore>;
    return {
      schema_version: 'inkloop.local_device_auth.v1',
      flows: parsed.flows && typeof parsed.flows === 'object' ? parsed.flows : {},
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return localAuthEmptyStore();
  }
}

function writeLocalAuthStore(store: LocalDeviceAuthStore): void {
  mkdirSync(dirname(LOCAL_AUTH_STORE), { recursive: true });
  writeFileSync(LOCAL_AUTH_STORE, JSON.stringify(store, null, 2), 'utf8');
}

function readLocalLarkOAuthPendingStore(now = Date.now()): LocalLarkOAuthPendingStore {
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_LARK_OAUTH_PENDING_STORE, 'utf8')) as Partial<LocalLarkOAuthPendingStore>;
    const states = parsed.states && typeof parsed.states === 'object' ? parsed.states : {};
    return {
      schema_version: 'inkloop.local_lark_oauth_pending.v1',
      states: Object.fromEntries(Object.entries(states).filter(([, entry]) => Number(entry.expires_at) > now)),
    };
  } catch {
    return { schema_version: 'inkloop.local_lark_oauth_pending.v1', states: {} };
  }
}

function writeLocalLarkOAuthPendingStore(store: LocalLarkOAuthPendingStore): void {
  mkdirSync(dirname(LOCAL_LARK_OAUTH_PENDING_STORE), { recursive: true });
  writeFileSync(LOCAL_LARK_OAUTH_PENDING_STORE, JSON.stringify(store, null, 2), 'utf8');
}

function rememberLocalLarkOAuthState(sessionToken: string, session: InkLoopSessionContext, state: string, redirectUri: string): void {
  const now = Date.now();
  const store = readLocalLarkOAuthPendingStore(now);
  store.states[state] = {
    state,
    session_token: sessionToken,
    ...(session.session_id ? { session_id: session.session_id } : {}),
    tenant_id: session.tenant_id || LOCAL_AUTH_TENANT_ID,
    user_id: session.user_id || LOCAL_AUTH_USER_ID,
    device_id: session.device_id || session.session_id || 'device',
    redirect_uri: redirectUri,
    created_at: now,
    expires_at: now + LOCAL_AUTH_FLOW_TTL_MS,
  };
  writeLocalLarkOAuthPendingStore(store);
}

function takeLocalLarkOAuthState(state: string): LocalLarkOAuthPendingEntry | null {
  if (!state) return null;
  const store = readLocalLarkOAuthPendingStore();
  const entry = store.states[state];
  if (!entry) return null;
  delete store.states[state];
  writeLocalLarkOAuthPendingStore(store);
  return entry;
}

function requestPublicBase(req: IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT || 8731}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function localSessionPayload(session: LocalDeviceSession): InkLoopSessionContext {
  return {
    ...session,
    active: session.expires_at > Date.now(),
  };
}

function createLocalDeviceSession(store: LocalDeviceAuthStore, deviceId: string): LocalDeviceSession {
  const now = Date.now();
  const token = newToken('ilsess', 24);
  const session: LocalDeviceSession = {
    active: true,
    session_id: newToken('sid', 12),
    session_token: token,
    tenant_id: LOCAL_AUTH_TENANT_ID,
    user_id: LOCAL_AUTH_USER_ID,
    device_id: deviceId,
    expires_at: now + LOCAL_AUTH_TTL_MS,
    created_at: now,
    updated_at: now,
    feishu_open_id: null,
  };
  store.sessions[token] = session;
  return session;
}

function localSessionTokenFor(req: IncomingMessage): string {
  return bearerToken(req) || String(req.headers['x-inkloop-session'] || '').trim();
}

function updateLocalDeviceSession(token: string, patch: Partial<LocalDeviceSession>): LocalDeviceSession | null {
  if (!LOCAL_DEVICE_AUTH || !token || token === 'local-demo-token') return null;
  const store = readLocalAuthStore();
  const session = store.sessions[token];
  if (!session || session.expires_at <= Date.now()) return null;
  const next: LocalDeviceSession = {
    ...session,
    ...patch,
    updated_at: Date.now(),
  };
  store.sessions[token] = next;
  writeLocalAuthStore(store);
  return next;
}

function sessionScopedLarkAuthPath(session: InkLoopSessionContext): string {
  const tenantId = safeId(session.tenant_id || LOCAL_AUTH_TENANT_ID, 'tenant');
  const userId = safeId(session.user_id || LOCAL_AUTH_USER_ID, 'user');
  const deviceId = safeId(session.device_id || session.session_id || 'device', 'device');
  return resolve(ROOT, '.inkloop/lark-auth', tenantId, userId, `${deviceId}.json`);
}

function larkEnvForSession(session?: InkLoopSessionContext | null): NodeJS.ProcessEnv {
  if (!session) return process.env;
  return {
    ...process.env,
    LARK_MEETING_AUTH_STATE_PATH: sessionScopedLarkAuthPath(session),
  };
}

function readLarkAuthStateFile(path: string): { token?: Record<string, unknown> | null; user?: unknown | null } {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { token?: Record<string, unknown> | null; user?: unknown | null };
  } catch {
    return {};
  }
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function feishuOpenIdFromUser(user: unknown): string | null {
  const root = recordOf(user);
  const data = recordOf(root.data);
  return textField(data.open_id) || textField(root.open_id);
}

function inkloopUserIdFromFeishuOpenId(openId: string): string {
  return `feishu_${safeId(openId, 'user')}`;
}

/** 该 open_id 最近登录设备的 lark OAuth state 文件路径；无登录记录返回空串。 */
function latestLarkAuthStatePath(openId: string): string {
  const userDir = resolve(ROOT, '.inkloop/lark-auth', LOCAL_AUTH_TENANT_ID, inkloopUserIdFromFeishuOpenId(openId));
  let statePath = '';
  try {
    const files = readdirSync(userDir).filter((name) => name.endsWith('.json'));
    let latest = -1;
    for (const name of files) {
      const mtime = statSync(resolve(userDir, name)).mtimeMs;
      if (mtime > latest) { latest = mtime; statePath = resolve(userDir, name); }
    }
  } catch { /* 用户目录不存在 = 未登录 */ }
  return statePath;
}

function shouldBootstrapLibraryForFeishuLogin(previousUserId: string, nextUserId: string): boolean {
  if (previousUserId === nextUserId) return false;
  if (previousUserId === LOCAL_AUTH_USER_ID) return true;
  return !previousUserId.startsWith('feishu_');
}

async function bootstrapLibraryForFeishuLogin(session: InkLoopSessionContext, nextUserId: string): Promise<void> {
  const previousUserId = session.user_id || LOCAL_AUTH_USER_ID;
  const tenantId = session.tenant_id || LOCAL_AUTH_TENANT_ID;
  if (!shouldBootstrapLibraryForFeishuLogin(previousUserId, nextUserId)) return;
  const result = await cloudLibraryStore.copyMissingDocuments(
    { tenant_id: tenantId, user_id: previousUserId },
    { tenant_id: tenantId, user_id: nextUserId },
  );
  if (result.copied.length) {
    console.info(`[cloud-library] bootstrapped ${result.copied.length} documents from ${previousUserId} to ${nextUserId}`);
  }
}

async function persistSessionFeishuIdentity(sessionToken: string, session: InkLoopSessionContext, openId: string | null): Promise<LocalDeviceSession | null> {
  if (!LOCAL_DEVICE_AUTH || !openId) return null;
  const nextUserId = inkloopUserIdFromFeishuOpenId(openId);
  // OAuth 完成时 token 存在升级前的 user 命名空间（local_user），身份升级为 feishu_ou_… 后
  // 会议/妙记查询按新 user 读 lark-auth 会读到空（oauth_token_missing）。把 token 文件迁到新命名空间。
  try {
    const oldAuthPath = sessionScopedLarkAuthPath(session);
    const newAuthPath = sessionScopedLarkAuthPath({ ...session, user_id: nextUserId });
    if (oldAuthPath !== newAuthPath) {
      const raw = readFileSync(oldAuthPath, 'utf8');
      mkdirSync(dirname(newAuthPath), { recursive: true });
      writeFileSync(newAuthPath, raw);
    }
  } catch { /* 无旧 token 文件（如未走 OAuth）时忽略 */ }
  await bootstrapLibraryForFeishuLogin(session, nextUserId);
  const patch: Partial<LocalDeviceSession> = {
    user_id: nextUserId,
    feishu_open_id: openId,
    feishu_oauth_updated_at: new Date().toISOString(),
  };
  const updated = updateLocalDeviceSession(sessionToken, patch);
  if (updated) return updated;
  const store = readLocalAuthStore();
  const created = createLocalDeviceSession(store, session.device_id || 'feishu-device');
  const next: LocalDeviceSession = {
    ...created,
    ...patch,
    updated_at: Date.now(),
  };
  store.sessions[next.session_token] = next;
  writeLocalAuthStore(store);
  return next;
}

function authorizeLocalFlow(store: LocalDeviceAuthStore, flow: LocalDeviceAuthFlow): LocalDeviceSession {
  const now = Date.now();
  const existing = flow.session_token ? store.sessions[flow.session_token] : null;
  const session = existing && existing.expires_at > now ? existing : createLocalDeviceSession(store, flow.device_id);
  flow.status = 'authorized';
  flow.session_token = session.session_token;
  flow.authorized_at = flow.authorized_at || now;
  return session;
}

function localDeviceSessionFromToken(token: string): InkLoopSessionContext | null {
  if (!LOCAL_DEVICE_AUTH || !token) return null;
  if (LOCAL_DEVICE_AUTH_AUTO_APPROVE && token === 'local-demo-token') {
    return {
      active: true,
      session_id: 'local-demo-session',
      session_token: token,
      tenant_id: LOCAL_AUTH_TENANT_ID,
      user_id: LOCAL_AUTH_USER_ID,
      device_id: 'local-demo-device',
      expires_at: Date.now() + LOCAL_AUTH_TTL_MS,
      feishu_open_id: null,
    };
  }
  const store = readLocalAuthStore();
  const session = store.sessions[token];
  if (!session) return null;
  if (session.expires_at <= Date.now()) return null;
  return localSessionPayload(session);
}

function localAuthFlowFromPath(path: string): { flowId: string; action: 'status' | 'ack' | 'scan' } | null {
  const match = path.match(/^\/device-authorizations\/([^/]+)\/(status|ack|scan)$/);
  if (!match) return null;
  return { flowId: decodeURIComponent(match[1]), action: match[2] as 'status' | 'ack' | 'scan' };
}

function localAuthBadPoll(flow: LocalDeviceAuthFlow, reqUrl: URL, body?: Record<string, unknown>): boolean {
  const poll = reqUrl.searchParams.get('poll_token') || String(body?.poll_token || '');
  return poll !== flow.poll_token;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  try {
    return recordOf(text ? JSON.parse(text) : {});
  } catch {
    return {};
  }
}

async function handleLocalInkLoopAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => sendJson(res, code, obj);
  const method = req.method || 'GET';
  const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const rest = (req.url || '').replace(/^\/api\/inkloop\/auth/, '');
  const apath = (rest || '/').split('?')[0];
  const store = readLocalAuthStore();

  if (method === 'POST' && apath === '/device-authorizations') {
    const raw = await readBody(req).catch(() => '{}');
    const body = parseJsonRecord(raw);
    const deviceId = safeId(textOf(body.device_id || body.install_id, newToken('device', 9)), 'device');
    const flowId = newToken('flow', 12);
    const pollToken = newToken('poll', 18);
    const userCode = `IL-${randomBytes(3).toString('hex').toUpperCase()}`;
    const qrPayload = `${requestPublicBase(req)}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flowId)}/scan?poll_token=${encodeURIComponent(pollToken)}`;
    const flow: LocalDeviceAuthFlow = {
      flow_id: flowId,
      device_id: deviceId,
      poll_token: pollToken,
      user_code: userCode,
      qr_payload: qrPayload,
      status: 'pending',
      created_at: Date.now(),
      expires_at: Date.now() + LOCAL_AUTH_FLOW_TTL_MS,
    };
    store.flows[flowId] = flow;
    if (LOCAL_DEVICE_AUTH_AUTO_APPROVE) authorizeLocalFlow(store, flow);
    writeLocalAuthStore(store);
    return send(200, { ...flow, interval_ms: 1200 });
  }

  const route = localAuthFlowFromPath(apath);
  if (!route) return send(403, { error: 'path not allowed' });
  const flow = store.flows[route.flowId];
  if (!flow) return send(404, { error: 'flow_not_found' });
  if (flow.expires_at <= Date.now() && flow.status !== 'authorized' && flow.status !== 'delivered') {
    flow.status = 'expired';
    writeLocalAuthStore(store);
  }

  if (route.action === 'status') {
    if (method !== 'GET') return send(405, { error: 'GET only' });
    if (localAuthBadPoll(flow, parsed)) return send(401, { error: 'bad_poll_token' });
    const session = flow.session_token ? store.sessions[flow.session_token] : null;
    return send(200, {
      flow_id: flow.flow_id,
      status: flow.status,
      expires_at: flow.expires_at,
      authorized_at: flow.authorized_at,
      session: session && session.expires_at > Date.now() ? localSessionPayload(session) : undefined,
    });
  }

  if (route.action === 'ack') {
    if (method !== 'POST') return send(405, { error: 'POST only' });
    const body = parseJsonRecord(await readBody(req).catch(() => '{}'));
    if (localAuthBadPoll(flow, parsed, body)) return send(401, { error: 'bad_poll_token' });
    if (!flow.session_token) return send(409, { error: 'not_authorized' });
    flow.status = 'delivered';
    flow.delivered_at = Date.now();
    writeLocalAuthStore(store);
    return send(200, { ok: true });
  }

  if (method !== 'GET') return send(405, { error: 'GET only' });
  if (localAuthBadPoll(flow, parsed)) return send(401, { error: 'bad_poll_token' });
  if (flow.status === 'expired') return send(410, { error: 'flow_expired' });
  const session = authorizeLocalFlow(store, flow);
  writeLocalAuthStore(store);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>InkLoop</title><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px"><h1>InkLoop 设备已授权</h1><p>可以回到墨水屏继续使用。</p><p style="color:#666">tenant=${session.tenant_id} user=${session.user_id}</p></body>`);
}

/** 向 panel 校验设备 session（token 只传 hash 不落库明文·panel 侧核对）。 */
async function resolveDeviceSession(req: IncomingMessage): Promise<InkLoopSessionContext | null> {
  const token = bearerToken(req) || String(req.headers['x-inkloop-session'] || '').trim();
  if (!token) throw Object.assign(new Error('missing_session_token'), { status: 401 });
  const localSession = localDeviceSessionFromToken(token);
  if (localSession) return localSession;
  if (LOCAL_DEVICE_AUTH && !PANEL_AUTH_BASE) throw Object.assign(new Error('reauth_required'), { status: 401 });
  if (!PANEL_AUTH_BASE || !INKLOOP_SHARED_SECRET) throw Object.assign(new Error('PANEL_AUTH_BASE / INKLOOP_SHARED_SECRET 未配置'), { status: 503 });
  const r = await fetch(`${PANEL_AUTH_BASE}/api/internal/inkloop/sessions/introspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inkloop-secret': INKLOOP_SHARED_SECRET },
    body: JSON.stringify({ session_token: token }),
  });
  const data = await r.json() as InkLoopSessionContext;
  if (!r.ok || !data.active) throw Object.assign(new Error(data.error || 'reauth_required'), { status: 401 });
  return data;
}

/** 校验失败直接把响应写掉并返回 null，调用方一律 `if (!session) return;`。 */
async function requireDeviceSession(req: IncomingMessage, res: ServerResponse): Promise<InkLoopSessionContext | null> {
  try {
    return await resolveDeviceSession(req);
  } catch (e) {
    sendJson(res, Number((e as { status?: number })?.status) || 502, { error: String((e as Error)?.message || e) });
    return null;
  }
}

async function optionalDeviceSession(req: IncomingMessage): Promise<InkLoopSessionContext | null> {
  try {
    return await resolveDeviceSession(req);
  } catch {
    return null;
  }
}

/** 阶段C：设备二维码登录 GET/POST 代理——create/status/ack 走 shared secret（前端不持有），scan 是纯 302 跳转。 */
async function handleInkLoopAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (LOCAL_DEVICE_AUTH && !PANEL_AUTH_BASE) {
    await handleLocalInkLoopAuth(req, res);
    return;
  }
  const send = (code: number, obj: unknown): void => sendJson(res, code, obj);
  if (!PANEL_AUTH_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_AUTH_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const method = req.method || 'GET';
  const rest = (req.url || '').replace(/^\/api\/inkloop\/auth/, '');
  const apath = (rest || '/').split('?')[0];

  const create = method === 'POST' && apath === '/device-authorizations';
  const status = method === 'GET' && /^\/device-authorizations\/flow_[A-Za-z0-9_-]+\/status$/.test(apath);
  const ack = method === 'POST' && /^\/device-authorizations\/flow_[A-Za-z0-9_-]+\/ack$/.test(apath);
  const scan = method === 'GET' && /^\/device-authorizations\/flow_[A-Za-z0-9_-]+\/scan$/.test(apath);
  if (!create && !status && !ack && !scan) return send(403, { error: 'path not allowed' });

  if (scan) {
    res.statusCode = 302;
    res.setHeader('location', `${PANEL_AUTH_BASE}/api/inkloop/auth${rest}`);
    res.end();
    return;
  }

  try {
    const headers: Record<string, string> = {
      'x-inkloop-secret': INKLOOP_SHARED_SECRET,
      'x-forwarded-host': String(req.headers.host || ''),
      'x-forwarded-proto': String(req.headers['x-forwarded-proto'] || 'http'),
    };
    let body: string | undefined;
    if (method === 'POST') { body = await readBody(req); headers['content-type'] = String(req.headers['content-type'] || 'application/json'); }
    const r = await fetch(`${PANEL_AUTH_BASE}/api/inkloop/auth${rest}`, { method, headers, body });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) { send(502, { error: String((e as Error)?.message || e) }); }
}

// 阶段F：与阶段D的 feishuUserContextHeaders 同款——panel-feishu 这条代理下所有端点现在都要转发身份
// （不像阶段D只对docx等少数端点转发，这次是给全部会议/妙记数据加per-user过滤，范围是整条代理）。
function panelFeishuUserContextHeaders(session: InkLoopSessionContext): Record<string, string> | null {
  const openId = session.feishu_open_id;
  if (!session.tenant_id || !session.user_id || !openId) return null;
  return {
    'x-inkloop-tenant-id': session.tenant_id,
    'x-inkloop-user-id': session.user_id,
    'x-inkloop-feishu-open-id': openId,
  };
}

async function handlePanelFeishu(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  const method = req.method || 'GET';
  // GET=拉妙记/会议/转写；POST=写操作（bind-minute / 生成总结 / 日程回写）。panel 侧 requireInkloopSecret + 路由收敛兜底。
  if (method !== 'GET' && method !== 'POST') return send(405, { error: 'GET/POST only' });
  const rest = (req.url || '').replace(/^\/api\/panel-feishu/, ''); // 含 query
  // 白名单：只放行设备真用的端点（防 confused-deputy——代理替前端带 secret，别让任意 POST 打到非预期端点）。
  const apath = (rest || '/').split('?')[0];
  const allowed = method === 'GET'
    ? (/^\/meetings\/[^/]+$/.test(apath) || /^\/meetings\/[^/]+\/summary$/.test(apath) || /^\/minutes\/[A-Za-z0-9_-]+(?:\/transcript)?$/.test(apath) || /^\/oauth\/status$/.test(apath))
    : /^\/meetings\/[^/]+\/(?:bind-minute|summary)$/.test(apath);
  if (!allowed) return send(403, { error: 'path not allowed' });
  if (!PANEL_FEISHU_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'PANEL_FEISHU_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const session = await requireDeviceSession(req, res);
  if (!session) return;
  // 阶段F：会议/妙记数据默认仅自己可见——这条代理下所有端点都要转发身份，panel 侧按身份过滤查询结果。
  const userContextHeaders = panelFeishuUserContextHeaders(session);
  if (!userContextHeaders) return send(409, { error: 'reauth_required' });
  try {
    const headers: Record<string, string> = { 'x-inkloop-secret': INKLOOP_SHARED_SECRET, ...userContextHeaders };
    let body: string | undefined;
    if (method === 'POST') { body = await readBody(req); headers['content-type'] = String(req.headers['content-type'] || 'application/json'); } // readBody 一次性 decode·中文安全
    const r = await fetch(`${PANEL_FEISHU_BASE}/api/feishu${rest}`, { method, headers, body });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) { send(502, { error: String((e as Error)?.message || e) }); }
}

// ── 交付路线 Y：panel vault release 代理（GET+POST·注入 x-inkloop-secret·secret 不进前端）。
//    与 vite.config.ts panelVaultProxy 同构，让安卓/生产包也能 上传 / 拉取 vault release。
//    userId 服务端 override 只认显式 INKLOOP_VAULT_FORCE_USER；默认用设备 session.user_id。
//    不能复用通用 INKLOOP_USER_ID，否则飞书登录后客户端按 feishu user 发布会被误判为越桶。
const PANEL_VAULT_BASE = (process.env.PANEL_VAULT_BASE || '').replace(/\/+$/, ''); // 形如 http://host:3001/api/inkloop/vault
const VAULT_FORCE_USER = process.env.INKLOOP_VAULT_FORCE_USER || '';
const MAX_VAULT_BODY = 50 * 1024 * 1024; // 对齐 panel vault 50mb 上限·避免生产代理比上游更早拒 release（dev proxy 不限·panel 50mb·默认 25mb 是给页面图/ink 的）
const LOCAL_VAULT_ROOT = resolve(ROOT, process.env.INKLOOP_LOCAL_VAULT_ROOT || '.inkloop/local-vault');

function localVaultUserDir(userId: string): string {
  return resolve(LOCAL_VAULT_ROOT, encodeURIComponent(userId));
}

function localVaultLatestPath(userId: string): string {
  return resolve(localVaultUserDir(userId), 'latest.json');
}

async function handleLocalPanelVault(route: { rest: string; releasePost: boolean }, method: string, body: string | undefined, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  const latestMatch = route.rest.match(/^\/users\/([^/]+)\/releases\/latest$/);
  const blobMatch = route.rest.match(/^\/users\/([^/]+)\/blobs\/sha256\/([a-f0-9]{64})$/i);
  const postMatch = route.rest.match(/^\/users\/([^/]+)\/releases$/);
  const userId = decodeURIComponent(postMatch?.[1] || latestMatch?.[1] || blobMatch?.[1] || '');
  if (!userId) return send(404, { error: 'no such vault route' });

  if (method === 'GET' && latestMatch) {
    try {
      const raw = readFileSync(localVaultLatestPath(userId), 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(raw);
    } catch {
      send(404, { error: 'no vault release' });
    }
    return;
  }

  if (method === 'GET' && blobMatch) {
    try {
      const hex = blobMatch[2].toLowerCase();
      const raw = readFileSync(resolve(localVaultUserDir(userId), 'blobs', 'sha256', hex), 'utf8');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/markdown; charset=utf-8');
      res.end(raw);
    } catch {
      send(404, { error: 'blob not found' });
    }
    return;
  }

  if (method !== 'POST' || !postMatch || !route.releasePost || !body) return send(404, { error: 'no such vault route' });
  const parsed = JSON.parse(body) as {
    manifest?: { release_hash?: string; generated_at?: string; files?: Array<{ path: string; content_hash: string; bytes: number }> };
    files?: Array<{ path: string; markdown: string }>;
    device_id?: string;
  };
  const manifest = parsed.manifest;
  const files = parsed.files || [];
  if (!manifest?.release_hash || !Array.isArray(manifest.files) || !files.length) return send(400, { error: 'release JSON 非法' });
  const userDir = localVaultUserDir(userId);
  const blobDir = resolve(userDir, 'blobs', 'sha256');
  mkdirSync(blobDir, { recursive: true });
  const latestPath = localVaultLatestPath(userId);
  let deduped = false;
  try {
    const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as { release?: { release_hash?: string } };
    deduped = latest.release?.release_hash === manifest.release_hash;
  } catch { /* first release */ }

  for (const file of files) {
    const entry = manifest.files.find((x) => x.path === file.path);
    const hex = entry?.content_hash?.replace(/^sha256:/, '').toLowerCase();
    if (!entry || !hex || !/^[a-f0-9]{64}$/.test(hex)) return send(400, { error: `release file missing manifest entry: ${file.path}` });
    writeFileSync(resolve(blobDir, hex), file.markdown, 'utf8');
  }

  const releaseId = `local_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const uploadedAt = new Date().toISOString();
  const latest = {
    release: { id: releaseId, release_hash: manifest.release_hash, generated_at: manifest.generated_at || uploadedAt, uploaded_at: uploadedAt },
    manifest,
    assets: manifest.files.map((file) => ({
      path: file.path,
      content_hash: file.content_hash,
      bytes: file.bytes,
      download: `/api/panel-vault/users/${encodeURIComponent(userId)}/blobs/${file.content_hash.replace(/^sha256:/, 'sha256/')}`,
    })),
    local: true,
    device_id: parsed.device_id,
  };
  writeFileSync(latestPath, JSON.stringify(latest, null, 2), 'utf8');
  send(200, {
    ok: true,
    release_id: releaseId,
    file_count: manifest.files.length,
    total_bytes: manifest.files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0),
    uploaded_at: uploadedAt,
    deduped,
    local: true,
  });
}

async function handlePanelVault(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET' && req.method !== 'POST') return send(405, { error: 'GET/POST only' });
  const session = await requireDeviceSession(req, res);
  if (!session) return;
  try {
    // fail-closed 路由白名单 + user 钉死 + 路径规范化（防 confused-deputy：`../` 逃出 vault 子树把 secret 打到其它端点 / 越桶）
    const route = guardPanelVaultReqUrl(req.url || '', req.method || 'GET', resolvePanelVaultGuardUser(session.user_id, VAULT_FORCE_USER));
    const headers: Record<string, string> = { 'x-inkloop-secret': INKLOOP_SHARED_SECRET };
    let body: string | undefined;
    if (req.method === 'POST') { body = await readBody(req, MAX_VAULT_BODY); if (route.releasePost) assertNonEmptyVaultRelease(body); headers['content-type'] = String(req.headers['content-type'] || 'application/json'); }
    if (!PANEL_VAULT_BASE) {
      await handleLocalPanelVault(route, req.method || 'GET', body, res);
      return;
    }
    if (!INKLOOP_SHARED_SECRET) return send(503, { error: 'INKLOOP_SHARED_SECRET 未配置' });
    const r = await fetch(`${PANEL_VAULT_BASE}${route.rest}`, { method: req.method, headers, body });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (e) { const g = panelVaultGuardPayload(e); if (g) return send(g.status, { error: g.error }); send(502, { error: String((e as Error)?.message || e) }); }
}

// ── P0 安全止血：feishu-service（日历/群聊/群文件）+ convert-service（文件转PDF）GET 代理。
//    两条服务之前设备前端裸连、零鉴权（见项目记忆盲区扫描发现）；与 vite.config.ts feishuServiceProxy/convertServiceProxy 同构，
//    让安卓/生产包也走同源代理注入 secret。响应统一走 Buffer（群文件下载是图片/PDF 字节，.text() 会糟蹋二进制）。──
const FEISHU_SERVICE_BASE = (process.env.FEISHU_SERVICE_BASE || '').replace(/\/+$/, '');
// offline_access：飞书据此签发 refresh_token；无它则 access_token(~2h)过期只能重新扫码登录。
// 刷新机制已就绪（resolveUserOAuthToken 自动 refreshOAuthToken）——只差在授权时申请这个 scope。
// drive:export:readonly 用于 docx 官方 export_tasks；已有 token refresh 不会扩 scope，老用户需重新授权一次。
// minutes:minutes:readonly 用于妙记信息/搜索；minutes:minutes.transcript:export 用于转写导出（飞书 99991679 点名，
// 与 minutes:minute:download 二选一）。token 收编：panel sidecar 的独立 v1 OAuth 已废，妙记取数改用 hub 这份 token。
// vc:meeting.meetingevent:read 来自 production-baseline（会议信息/事件查询 API 点名"二选一"权限之一）。
// ⚠️不要请求 vc:meeting:readonly：粗粒度权限已被细粒度取代、开放平台后台没有这项，带上它整个授权流程直接失败
// （2026-07-14 c7a7d9e 教训；7-15 merge 并集误把它带回导致用户无法重新授权，再删）。
const DEFAULT_LARK_MEETING_OAUTH_SCOPE = 'offline_access auth:user.id:read vc:meeting.search:read vc:meeting.meetingid:read vc:meeting.meetingevent:read calendar:calendar:read calendar:calendar.event:read vc:note:read docx:document:readonly docs:document.media:download drive:export:readonly minutes:minutes:readonly minutes:minutes.search:read minutes:minutes.transcript:export';
const LARK_MEETING_OAUTH_SCOPE = (process.env.LARK_MEETING_OAUTH_SCOPE || DEFAULT_LARK_MEETING_OAUTH_SCOPE).trim();
// 「已连接」判定只看核心功能 scope（会议/日历/docx）——授权请求 scope 每次扩容（drive:export、minutes 等）
// 都会让老 token 被误判 connected=false、前端停拉日历。新增能力各自的端点自行校验所需 scope。
// vc:meeting.meetingevent:read 是刻意的例外：hub 侧 REST 对账（清卡 live 会议）靠它，且缺它时没有任何
// 401/409 会触发前端的重新授权提示——只能靠 core-required 判缺口，把身份面板的按钮翻成「重新授权」。
const LARK_CORE_REQUIRED_SCOPE = (process.env.LARK_CORE_REQUIRED_SCOPE
  || 'vc:meeting.search:read vc:meeting.meetingid:read vc:meeting.meetingevent:read minutes:minutes.search:read calendar:calendar:read calendar:calendar.event:read vc:note:read docx:document:readonly docs:document.media:download').trim();
const LARK_MEETING_CALLBACK_PORT = String(process.env.LARK_MEETING_SDK_PORT || process.env.LARK_SDK_PORT || '8789').trim() || '8789';
const LARK_MEETING_CALLBACK_PATH = '/api/auth/lark/callback';
const CONVERT_SERVICE_BASE = (process.env.CONVERT_SERVICE_BASE || '').replace(/\/+$/, '');
type LarkDeviceOAuthRedirectMode = 'web' | 'http' | 'deeplink';
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function googleOAuthIdentity(session: InkLoopSessionContext): GoogleOAuthIdentity {
  return {
    tenantId: session.tenant_id || LOCAL_AUTH_TENANT_ID,
    userId: session.user_id || LOCAL_AUTH_USER_ID,
    deviceId: session.device_id || session.session_id || 'device',
  };
}

function mtlReceiverIdentity(session: InkLoopSessionContext): MtlReceiverIdentity {
  return {
    tenant_id: session.tenant_id || LOCAL_AUTH_TENANT_ID,
    user_id: session.user_id || LOCAL_AUTH_USER_ID,
  };
}

function googleOAuthDisabled(): boolean {
  return !String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
}

function sendGoogleHtml(res: ServerResponse, status: number, title: string, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:28px;line-height:1.6"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`);
}

async function handleGoogleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/api/google', 'http://inkloop.local');
  const path = url.pathname;
  if (path === '/api/google/meeting-summary') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'POST only' } });
      return;
    }
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    try {
      const payload = JSON.parse(await readBody(req, 64 * 1024));
      sendJson(res, 200, await runMeetingPanelSummary(payload));
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 502;
      sendJson(res, status, { error: { code: String((error as Error)?.message || error), message: 'Google meeting summary generation failed' } });
    }
    return;
  }
  if (path === '/api/google/mtl-token') {
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET/POST/DELETE only' } });
      return;
    }
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    res.setHeader('cache-control', 'no-store');
    const identity = mtlReceiverIdentity(session);
    if (req.method === 'DELETE') {
      const current = currentMtlToken(identity);
      const revoked = current ? revokeMtlToken(current.token, identity) : false;
      sendJson(res, 200, { ok: true, revoked });
      return;
    }
    const current = req.method === 'POST' ? mintMtlToken(identity) : currentMtlToken(identity);
    sendJson(res, 200, current ? {
      token: current.token,
      base_url: mtlReceiverBaseUrl(current.token),
      created_at: current.record.created_at,
      ...(req.method === 'POST' && 'created' in current ? { created: current.created } : {}),
    } : { token: null, base_url: null });
    return;
  }
  if (path === '/api/google/meeting-live-state') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } });
      return;
    }
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    res.setHeader('cache-control', 'no-store');
    const identity = mtlReceiverIdentity(session);
    const configured = !!currentMtlToken(identity);
    sendJson(res, 200, {
      connected: configured,
      source: 'mtl_receiver',
      windows: configured ? listMtlMeetingWindows(identity) : [],
    });
    return;
  }
  const callback = path === '/api/google/oauth/callback';
  if (googleOAuthDisabled()) {
    if (callback) sendGoogleHtml(res, 503, 'Google 日历未启用', 'google_oauth_disabled');
    else sendJson(res, 503, { error: { code: 'google_oauth_disabled', message: 'Google OAuth is disabled' } });
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  if (callback) {
    const providerError = url.searchParams.get('error');
    if (providerError) {
      // 用户在授权页点了拒绝（access_denied 等）：把 pending 标 failed，设备轮询立即拿到终态而不是干等 TTL
      failGoogleDeviceOAuthCallback(process.env, { state: url.searchParams.get('state') || '', error: providerError });
      sendGoogleHtml(res, 400, 'Google 授权失败', providerError);
      return;
    }
    try {
      const result = await completeGoogleOAuthCallback(process.env, {
        code: url.searchParams.get('code') || '',
        state: url.searchParams.get('state') || '',
      });
      const scopeMessage = result.status.connected
        ? 'Google 日历已连接，可以回到 InkLoop。'
        : `授权已写入，但仍缺少权限：${result.status.missing_scopes.join(', ')}`;
      sendGoogleHtml(res, 200, 'Google 授权完成', scopeMessage);
    } catch (error) {
      const failure = googleOAuthErrorPayload(error);
      sendGoogleHtml(res, failure.status, 'Google 授权失败', `${failure.body.error.code}: ${failure.body.error.message}`);
    }
    return;
  }

  const session = await requireDeviceSession(req, res);
  if (!session) return;
  const identity = googleOAuthIdentity(session);

  if (path === '/api/google/oauth/device/start') {
    try {
      const payload = beginGoogleDeviceOAuth(process.env, identity);
      sendJson(res, 200, { ...payload, auth_mode: 'device_oauth', data_isolation: 'inkloop_session_namespace' });
    } catch (error) {
      const failure = googleOAuthErrorPayload(error);
      sendJson(res, failure.status, failure.body);
    }
    return;
  }

  if (path === '/api/google/oauth/device/complete') {
    const completion = googleDeviceOAuthCompletion(process.env, identity);
    if (completion.status !== 'complete') {
      sendJson(res, 200, completion);
      return;
    }
    try {
      const status = await resolveGoogleOAuthStatus(process.env, identity);
      sendJson(res, 200, { ...completion, connected: status.connected, oauth: status });
    } catch (error) {
      const failure = googleOAuthErrorPayload(error);
      sendJson(res, failure.status, failure.body);
    }
    return;
  }

  if (path === '/api/google/oauth/status') {
    try {
      sendJson(res, 200, await resolveGoogleOAuthStatus(process.env, identity));
    } catch (error) {
      const failure = googleOAuthErrorPayload(error);
      sendJson(res, failure.status, failure.body);
    }
    return;
  }

  if (path === '/api/google/meeting-sources') {
    try {
      const resolved = await resolveUserGoogleToken(process.env, identity);
      if (!resolved.usable || !resolved.token) {
        sendJson(res, 401, {
          connected: false,
          sources: [],
          error: { code: resolved.reason || 'google_oauth_unavailable', message: 'Google OAuth authorization is required' },
        });
        return;
      }
      const result = await fetchGoogleMeetingSources(resolved.token, {
        path: googleCalendarSyncPath(process.env, identity),
      }, {
        refreshAccessToken: async () => {
          const refreshed = await resolveUserGoogleToken(process.env, identity, Date.now(), { forceRefresh: true });
          if (!refreshed.usable || !refreshed.token) throw Object.assign(new Error('reauth_required'), { status: 401 });
          return refreshed.token;
        },
      });
      sendJson(res, 200, {
        connected: true,
        configured: true,
        mtl_token_configured: !!currentMtlToken(mtlReceiverIdentity(session)),
        ...result,
      });
    } catch (error) {
      const failure = googleCalendarErrorPayload(error);
      sendJson(res, failure.status, { connected: false, sources: [], ...failure.body });
    }
    return;
  }

  if (path === '/api/google/meeting-transcript') {
    try {
      const meetingCode = url.searchParams.get('meeting_code') || '';
      const scheduledAt = url.searchParams.get('scheduled_at') || '';
      if (!meetingCode || !scheduledAt) {
        sendJson(res, 400, { error: { code: 'google_meeting_transcript_input_missing', message: 'meeting_code and scheduled_at are required' } });
        return;
      }
      const resolved = await resolveUserGoogleToken(process.env, identity);
      if (!resolved.usable || !resolved.token) {
        sendJson(res, 401, { error: { code: resolved.reason || 'google_oauth_unavailable', message: 'Google OAuth authorization is required' } });
        return;
      }
      const result = await fetchGoogleMeetingTranscript(resolved.token, {
        path: googleMeetRecordsPath(process.env, identity),
      }, {
        meetingCode,
        scheduledAt,
        attendance: mtlAttendanceWindows(mtlReceiverIdentity(session), meetingCode),
      }, {
        grantedScopes: resolved.scopes,
        refreshAccessToken: async () => {
          const refreshed = await resolveUserGoogleToken(process.env, identity, Date.now(), { forceRefresh: true });
          if (!refreshed.usable || !refreshed.token) throw Object.assign(new Error('reauth_required'), { status: 401 });
          return refreshed.token;
        },
      });
      sendJson(res, 200, result);
    } catch (error) {
      const failure = googleMeetRecordsErrorPayload(error);
      sendJson(res, failure.status, failure.body);
    }
    return;
  }

  sendJson(res, 404, { error: { code: 'google_route_not_found', message: 'Google API route not found' } });
}
function larkOAuthRedirectUri(_req?: IncomingMessage): string {
  const configured = String(process.env.LARK_CLOUD_HUB_REDIRECT_URI || process.env.INKLOOP_LARK_REDIRECT_URI || process.env.LARK_REDIRECT_URI || '').trim();
  if (configured) return configured;
  // Feishu validates redirect_uri against the configured allow-list. Do not derive this from
  // the e-paper/iPad LAN host unless an explicit product callback URL is configured.
  return `http://localhost:${LARK_MEETING_CALLBACK_PORT}${LARK_MEETING_CALLBACK_PATH}`;
}
function larkDeviceOAuthRedirectUri(): string {
  return String(process.env.LARK_DEVICE_REDIRECT_URI || process.env.INKLOOP_LARK_DEVICE_REDIRECT_URI || 'inkloop://oauth/lark/callback').trim();
}
function larkHttpDeviceOAuthRedirectUri(req: IncomingMessage): string {
  const configured = String(process.env.LARK_DEVICE_HTTP_REDIRECT_URI || process.env.INKLOOP_LARK_DEVICE_HTTP_REDIRECT_URI || '').trim();
  if (configured) return configured;
  return `${requestPublicBase(req).replace(/\/+$/, '')}/api/feishu-svc/api/feishu/oauth/device/callback`;
}
function larkDeviceOAuthRedirectMode(value?: string | null): LarkDeviceOAuthRedirectMode {
  const requested = String(value || process.env.INKLOOP_LARK_DEVICE_AUTH_MODE || 'web').trim().toLowerCase();
  return requested === 'deeplink' || requested === 'http' ? requested : 'web';
}
function larkDeviceOAuthRedirectUriForMode(req: IncomingMessage, mode: LarkDeviceOAuthRedirectMode): string {
  if (mode === 'deeplink') return larkDeviceOAuthRedirectUri();
  if (mode === 'http') return larkHttpDeviceOAuthRedirectUri(req);
  return larkOAuthRedirectUri(req);
}
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}
function urlHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return ''; }
}
function larkOAuthCallbackIsLoopback(): boolean {
  return isLoopbackHostname(urlHostname(larkOAuthRedirectUri()));
}
function requestIsLoopback(req: IncomingMessage): boolean {
  return isLoopbackHostname(requestHostName(req));
}
function larkOAuthDesktopLoginUrl(scope?: string): string {
  const url = new URL(`http://localhost:${PORT}/api/feishu-svc/api/feishu/oauth/login`);
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}
function sessionFromPendingLarkOAuth(entry: LocalLarkOAuthPendingEntry): InkLoopSessionContext {
  return {
    active: true,
    session_id: entry.session_id,
    session_token: entry.session_token,
    tenant_id: entry.tenant_id,
    user_id: entry.user_id,
    device_id: entry.device_id,
    expires_at: Date.now() + LOCAL_AUTH_TTL_MS,
    feishu_open_id: null,
  };
}
async function completePendingLarkOAuthCallback(res: ServerResponse, entry: LocalLarkOAuthPendingEntry, code: string, state: string): Promise<void> {
  const session = sessionFromPendingLarkOAuth(entry);
  try {
    const env = feishuBotRuntimeEnv(larkEnvForSession(session));
    const result = await completeLarkOAuthCallback(env, {
      code,
      state,
      redirectUri: entry.redirect_uri,
    });
    const authFile = readLarkAuthStateFile(larkOAuthAuthStatePath(env));
    const openId = feishuOpenIdFromUser(authFile.user || result.user);
    const updatedSession = await persistSessionFeishuIdentity(entry.session_token, session, openId);
    const missing = result.status.missing_scopes.length ? `<p>仍缺少权限：${escapeHtml(result.status.missing_scopes.join(', '))}</p>` : '<p>会议读取权限已就绪。</p>';
    const userLine = openId ? `<p>当前飞书身份：${escapeHtml(openId)}</p>` : '';
    const sessionLine = updatedSession ? '<p>设备登录态已写入 Cloud Hub，可以回到 InkLoop 后刷新会议。</p>' : '<p>飞书身份已写入本机授权文件，可以回到 InkLoop 后刷新会议。</p>';
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书授权完成</title><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:28px;line-height:1.6"><h1>飞书授权完成</h1>${missing}${userLine}${sessionLine}</body>`);
  } catch (e) {
    res.statusCode = Number((e as { status?: number })?.status) || 500;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<h1>飞书授权失败</h1><p>${escapeHtml(String((e as Error)?.message || e))}</p>`);
  }
}
function renderLarkOAuthConnectPage(req: IncomingMessage, res: ServerResponse, scope?: string): void {
  const callback = larkOAuthRedirectUri(req);
  const currentBase = requestPublicBase(req);
  const currentCallback = `${currentBase.replace(/\/+$/, '')}/api/feishu-svc/api/feishu/oauth/callback`;
  const desktopLoginUrl = larkOAuthDesktopLoginUrl(scope);
  const canLoginHere = requestIsLoopback(req) || !larkOAuthCallbackIsLoopback();
  const directUrl = `${currentBase.replace(/\/+$/, '')}/api/feishu-svc/api/feishu/oauth/login?direct=1${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InkLoop 飞书授权</title>
<style>
  body{margin:0;background:#f7f5ef;color:#1f1f1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
  main{max-width:760px;margin:0 auto;padding:28px 22px 40px}
  h1{font-size:24px;margin:0 0 14px}
  p{margin:10px 0;color:#444}
  .card{background:#fff;border:1px solid #d8d4ca;border-radius:10px;padding:18px 18px;margin:16px 0}
  .code{display:block;word-break:break-all;background:#f1efe8;border:1px solid #ddd7cc;border-radius:8px;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222}
  .btn{display:inline-block;margin:10px 8px 0 0;padding:10px 14px;border-radius:8px;border:1px solid #222;background:#222;color:#fff;text-decoration:none;font-weight:700}
  .mut{color:#777;font-size:13px}
  .warn{border-left:4px solid #a33;padding-left:12px}
</style>
<main>
  <h1>InkLoop 飞书授权</h1>
  <div class="card warn">
    <p>飞书会严格校验 <b>redirect_uri</b>，必须和开发平台配置的重定向 URL 完全一致。当前本地开发默认使用 <b>http://localhost:${escapeHtml(LARK_MEETING_CALLBACK_PORT)}${escapeHtml(LARK_MEETING_CALLBACK_PATH)}</b>；电子纸/iPad 会拦截这个回调并把授权结果转交给 Cloud Hub。</p>
  </div>
  ${canLoginHere ? `<div class="card"><p>当前环境可以直接继续飞书授权。</p><a class="btn" href="${escapeHtml(directUrl)}">打开飞书授权</a></div>` : ''}
  <div class="card">
    <p><b>推荐做法：</b>在运行 Cloud Hub 的 Mac 浏览器打开下面地址完成授权：</p>
    <span class="code">${escapeHtml(desktopLoginUrl)}</span>
    <p class="mut">授权完成后回到电子纸，点击“刷新重试”。</p>
  </div>
  <div class="card">
    <p><b>当前 OAuth 回调地址：</b></p>
    <span class="code">${escapeHtml(callback)}</span>
    <p class="mut">如果要改成其他回调地址，必须先把该地址加入飞书开发平台，并通过 <code>LARK_CLOUD_HUB_REDIRECT_URI</code> 显式配置：</p>
    <span class="code">${escapeHtml(currentCallback)}</span>
  </div>
</main>`);
}
async function relayBinary(res: ServerResponse, r: Response): Promise<void> {
  const buf = Buffer.from(await r.arrayBuffer());
  res.statusCode = r.status;
  res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
  const cd = r.headers.get('content-disposition'); if (cd) res.setHeader('content-disposition', cd);
  res.end(buf);
}

async function relayStreamingBinary(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  res.setHeader('content-type', r.headers.get('content-type') || 'application/octet-stream');
  const contentLength = r.headers.get('content-length');
  if (contentLength) res.setHeader('content-length', contentLength);
  const contentDisposition = r.headers.get('content-disposition');
  if (contentDisposition) res.setHeader('content-disposition', contentDisposition);
  if (!r.body) { res.end(); return; }
  const reader = r.body.getReader();
  try {
    while (!res.destroyed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!res.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolveDrain) => {
          const done = (): void => {
            res.off('drain', done);
            res.off('close', done);
            resolveDrain();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    }
    if (!res.destroyed) res.end();
  } finally {
    if (res.destroyed) await reader.cancel().catch(() => undefined);
  }
}
// 阶段D：这几条端点要「我本人」的飞书用户身份（走 panel 统一 token 店），需要有效设备 session 才能拿到
// tenant_id/user_id/feishu_open_id 转发给 feishu-service；其余群/文件/应用日历端点走 tenant 身份，不需要 session。
const FEISHU_NEEDS_USER_CONTEXT = /^\/api\/feishu\/(oauth\/status|my\/events|meetings\/[^/]+\/note-transcript|docx\/[^/]+\/(meta|raw-content|pdf)|docx\/[^/]+\/media\/[^/]+)$/;

function feishuUserContextHeaders(session: InkLoopSessionContext): Record<string, string> {
  const openId = session.feishu_open_id;
  if (!session.tenant_id || !session.user_id || !openId) return {}; // 未连接飞书身份·feishu-service 走 legacy fallback
  return {
    'x-inkloop-tenant-id': session.tenant_id,
    'x-inkloop-user-id': session.user_id,
    'x-inkloop-feishu-open-id': openId,
  };
}

async function handleFeishuService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  const rest = (req.url || '').replace(/^\/api\/feishu-svc/, ''); // 含 query
  const apath = (rest || '/').split('?')[0];
  const localBotConfigRoute = !FEISHU_SERVICE_BASE && apath === '/api/feishu/bot/config';
  const localManualMeetingRoute = !FEISHU_SERVICE_BASE && apath === '/api/feishu/meeting-sources/manual';
  const allowedWrite = (req.method === 'POST' && apath === '/api/feishu/oauth/device/complete')
    || (req.method === 'POST' && localManualMeetingRoute)
    || (localBotConfigRoute && (req.method === 'POST' || req.method === 'DELETE'));
  if (req.method !== 'GET' && !allowedWrite) return send(405, { error: 'GET only' });
  const botWorkspaceMatch = apath.match(/^\/api\/feishu\/workspaces\/([^/]+)\/(members|messages|files)$/);
  const localMaterialRoute = matchLocalFeishuMaterialRoute(apath);
  if (localBotConfigRoute) {
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    try {
      if (req.method === 'GET') return send(200, {
        ...feishuBotConfigStatusPayload(),
        token_store: 'cloud_hub_server',
        data_isolation: 'inkloop_session_namespace',
      });
      if (req.method === 'DELETE') return send(200, {
        ...publicFeishuBotConfigStatus(deleteFeishuBotConfig(ROOT, process.env)),
        token_store: 'cloud_hub_server',
        data_isolation: 'inkloop_session_namespace',
      });
      const body = parseJsonRecord(await readBody(req).catch(() => '{}'));
      return send(200, {
        ...publicFeishuBotConfigStatus(saveFeishuBotConfig(ROOT, body, process.env)),
        token_store: 'cloud_hub_server',
        data_isolation: 'inkloop_session_namespace',
      });
    } catch (e) {
      return send(Number((e as { status?: number })?.status) || 500, { ok: false, error: String((e as Error)?.message || e) });
    }
  }
  if (apath === '/api/feishu/bot/events' || (!FEISHU_SERVICE_BASE && (apath === '/api/feishu/calendars' || apath === '/api/feishu/events'))) {
    try {
      const u = new URL(rest, 'http://inkloop.local');
      const lookaheadDays = Number(u.searchParams.get('lookahead_days') || '');
      const lookbackDays = Number(u.searchParams.get('lookback_days') || '');
      const result = await fetchFeishuBotCalendarEvents({
        lookbackSeconds: Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays * 24 * 60 * 60 : undefined,
        lookaheadSeconds: Number.isFinite(lookaheadDays) && lookaheadDays > 0 ? lookaheadDays * 24 * 60 * 60 : undefined,
        pageSize: Number(u.searchParams.get('page_size') || '') || undefined,
        env: feishuBotRuntimeEnv(),
      });
      return send(200, result);
    } catch (e) {
      return send(502, { connected: false, configured: true, source: 'feishu_bot_calendar', auth_mode: 'tenant_access_token', events: [], calendars: [], error: { code: 'bot_calendar_failed', message: String((e as Error)?.message || e) } });
    }
  }
  if (apath === '/api/feishu/meeting-sources') {
    try {
      const u = new URL(rest, 'http://inkloop.local');
      const lookaheadDays = Number(u.searchParams.get('lookahead_days') || '');
      const lookbackDays = Number(u.searchParams.get('lookback_days') || '');
      const lookbackSeconds = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays * 24 * 60 * 60 : undefined;
      const lookaheadSeconds = Number.isFinite(lookaheadDays) && lookaheadDays > 0 ? lookaheadDays * 24 * 60 * 60 : undefined;
      const session = await optionalDeviceSession(req);
      const result = await fetchLarkMeetingSources({
        lookbackSeconds,
        lookaheadSeconds,
        pageSize: Number(u.searchParams.get('page_size') || '') || undefined,
        // 与 extraSources 同契约：无飞书身份=[]（bot 日历/群聊/VC 搜索全跳过），不再 undefined 走全量
        userOpenIds: session?.feishu_open_id ? [session.feishu_open_id] : [],
        // 三态过滤：有飞书身份=按身份过滤；无身份=[]（什么都不给·否则反而看到全量=泄漏）
        extraSources: larkRealtimeMeetingSources(ROOT, {
          lookbackSeconds,
          lookaheadSeconds,
          userOpenIds: session?.feishu_open_id ? [session.feishu_open_id] : [],
        }),
        env: feishuBotRuntimeEnv(larkEnvForSession(session)),
      });
      return send(200, result);
    } catch (e) {
      return send(502, { connected: false, configured: true, source: 'lark_meeting_sources', sources: [], errors: [{ source: 'lark_meeting_sources', code: 'meeting_sources_failed', message: String((e as Error)?.message || e) }] });
    }
  }
  if (apath === '/api/feishu/meeting-instance') {
    try {
      const u = new URL(rest, 'http://inkloop.local');
      const session = await optionalDeviceSession(req);
      const result = await resolveLarkMeetingInstance(
        u.searchParams.get('meeting_no') || '',
        u.searchParams.get('scheduled_at') || '',
        { env: feishuBotRuntimeEnv(larkEnvForSession(session)) },
      );
      return send(200, result);
    } catch (e) {
      return send(Number((e as { status?: number })?.status) || 502, { meeting: null, error: String((e as Error)?.message || e) });
    }
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/meeting-events/status') {
    return send(200, {
      connected: true,
      source: 'inkloop_lark_meeting_events',
      ws: getLarkWsMeetingEventsStatus(),
      realtime_store: larkRealtimeMeetingStoreStatus(ROOT),
    });
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/time') {
    return send(200, {
      connected: true,
      source: 'inkloop_cloud_hub_time',
      server_now_ms: Date.now(),
      server_time: new Date().toISOString(),
    });
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/meeting-sources/manual') {
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    try {
      const body = parseJsonRecord(await readBody(req).catch(() => '{}'));
      const record = upsertLarkRealtimeMeeting(ROOT, {
        title: body.title || '飞书即时会议',
        status: body.status || 'live',
        scheduled_at: body.scheduled_at || new Date().toISOString(),
        started_at: body.started_at || body.scheduled_at || new Date().toISOString(),
        ended_at: body.ended_at,
        meeting_url: body.meeting_url || body.url,
        meeting_no: body.meeting_no,
        feishu_meeting_id: body.feishu_meeting_id || body.meeting_id,
        // 手动绑定必须落归属，否则创建者自己按身份过滤后立刻看不到这条记录
        owner_open_id: session.feishu_open_id || undefined,
        source_event_type: 'manual_bind_current_meeting',
        source_event_id: body.source_event_id,
        source_transport: 'manual',
      });
      return send(200, { ok: true, source: 'manual_lark_realtime_meeting', record });
    } catch (e) {
      return send(400, { ok: false, error: String((e as Error)?.message || e) });
    }
  }
  const noteTranscriptMatch = apath.match(/^\/api\/feishu\/meetings\/([^/]+)\/note-transcript$/);
  if (!FEISHU_SERVICE_BASE && noteTranscriptMatch) {
    try {
      const session = await requireDeviceSession(req, res);
      if (!session) return;
      const meetingId = decodeURIComponent(noteTranscriptMatch[1]);
      const result = await fetchLarkMeetingNoteTranscript(meetingId, { env: feishuBotRuntimeEnv(larkEnvForSession(session)) });
      return send(200, result);
    } catch (e) {
      const meetingId = decodeURIComponent(noteTranscriptMatch[1]);
      return send(502, { connected: false, configured: true, source: 'lark_meeting_note_transcript', status: 'failed', meeting_id: meetingId, artifacts: [], errors: [{ source: 'lark_meeting_note_transcript', code: 'note_transcript_failed', message: String((e as Error)?.message || e) }] });
    }
  }
  const docxMediaMatch = apath.match(/^\/api\/feishu\/docx\/([^/]+)\/media\/([^/]+)$/);
  if (!FEISHU_SERVICE_BASE && docxMediaMatch) {
    try {
      const session = await requireDeviceSession(req, res);
      if (!session) return;
      const documentId = decodeURIComponent(docxMediaMatch[1]);
      const fileToken = decodeURIComponent(docxMediaMatch[2]);
      const result = await fetchLarkDocxMedia(documentId, fileToken, { env: feishuBotRuntimeEnv(larkEnvForSession(session)) });
      if (!result.ok || !result.body) return send(result.status || 502, { error: result.error });
      res.statusCode = result.status;
      res.setHeader('content-type', result.content_type || 'application/octet-stream');
      res.setHeader('cache-control', 'private, max-age=86400');
      res.end(result.body);
      return;
    } catch (e) {
      return send(502, { error: { code: 'docx_media_failed', message: String((e as Error)?.message || e) } });
    }
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/connect') {
    const u = new URL(rest, 'http://inkloop.local');
    renderLarkOAuthConnectPage(req, res, u.searchParams.get('scope') || LARK_MEETING_OAUTH_SCOPE);
    return;
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/device/start') {
    try {
      const sessionToken = localSessionTokenFor(req);
      const session = await requireDeviceSession(req, res);
      if (!session) return;
      const u = new URL(rest, 'http://inkloop.local');
      const requestedScope = u.searchParams.get('scope') || LARK_MEETING_OAUTH_SCOPE;
      const redirectMode = larkDeviceOAuthRedirectMode(u.searchParams.get('redirect') || u.searchParams.get('mode'));
      const redirectUri = larkDeviceOAuthRedirectUriForMode(req, redirectMode);
      const payload = beginLarkOAuthLogin(feishuBotRuntimeEnv(larkEnvForSession(session)), {
        scope: requestedScope,
        redirectUri,
      });
      rememberLocalLarkOAuthState(sessionToken, session, payload.state, redirectUri);
      return send(200, {
        ...payload,
        auth_mode: 'device_oauth',
        token_store: 'cloud_hub_session',
        data_isolation: 'inkloop_session_namespace',
        redirect_mode: redirectMode,
        tenant_id: session.tenant_id,
        user_id: session.user_id,
        device_id: session.device_id,
      });
    } catch (e) {
      return send(Number((e as { status?: number })?.status) || 503, { authenticated: false, connected: false, error: String((e as Error)?.message || e) });
    }
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/device/complete') {
    try {
      const sessionToken = localSessionTokenFor(req);
      const currentSession = await requireDeviceSession(req, res);
      if (!currentSession) return;
      const body = parseJsonRecord(await readBody(req).catch(() => '{}'));
      const state = textOf(body.state, '');
      const pending = takeLocalLarkOAuthState(state);
      const session = pending ? sessionFromPendingLarkOAuth(pending) : currentSession;
      const expectedRedirectUri = pending?.redirect_uri || larkDeviceOAuthRedirectUri();
      const redirectUri = textOf(body.redirect_uri, expectedRedirectUri);
      if (redirectUri !== expectedRedirectUri) return send(400, { error: 'redirect_uri_mismatch', expected_redirect_uri: expectedRedirectUri });
      const env = feishuBotRuntimeEnv(larkEnvForSession(session));
      const result = await completeLarkOAuthCallback(env, {
        code: textOf(body.code, ''),
        state,
        redirectUri,
      });
      const authFile = readLarkAuthStateFile(larkOAuthAuthStatePath(env));
      const openId = feishuOpenIdFromUser(authFile.user || result.user);
      const updatedSession = await persistSessionFeishuIdentity(pending?.session_token || sessionToken, session, openId);
      return send(200, {
        ok: true,
        auth_mode: 'device_oauth',
        token_store: 'cloud_hub_session',
        data_isolation: 'inkloop_session_namespace',
        feishu_open_id: openId,
        session: updatedSession ? localSessionPayload(updatedSession) : localSessionPayload({
          ...session,
          active: true,
          session_id: session.session_id || 'local-demo-session',
          session_token: session.session_token || sessionToken,
          tenant_id: session.tenant_id || LOCAL_AUTH_TENANT_ID,
          user_id: openId ? inkloopUserIdFromFeishuOpenId(openId) : (session.user_id || LOCAL_AUTH_USER_ID),
          device_id: session.device_id || 'device',
          expires_at: session.expires_at || Date.now() + LOCAL_AUTH_TTL_MS,
          created_at: Date.now(),
          updated_at: Date.now(),
          feishu_open_id: openId,
        }),
        status: result.status,
      });
    } catch (e) {
      return send(Number((e as { status?: number })?.status) || 500, { ok: false, error: String((e as Error)?.message || e) });
    }
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/device/callback') {
    const u = new URL(rest, 'http://inkloop.local');
    const error = u.searchParams.get('error');
    if (error) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<h1>飞书授权失败</h1><p>${escapeHtml(error)}</p>`);
      return;
    }
    const state = u.searchParams.get('state') || '';
    const pending = takeLocalLarkOAuthState(state);
    if (!pending) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<h1>飞书授权失败</h1><p>授权状态已过期，请回到 InkLoop 重新登录飞书。</p>');
      return;
    }
    await completePendingLarkOAuthCallback(res, pending, u.searchParams.get('code') || '', state);
    return;
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/login') {
    try {
      const u = new URL(rest, 'http://inkloop.local');
      const requestedScope = u.searchParams.get('scope') || LARK_MEETING_OAUTH_SCOPE;
      const forceDirect = ['1', 'true', 'yes'].includes(String(u.searchParams.get('direct') || '').toLowerCase());
      if (!forceDirect && larkOAuthCallbackIsLoopback() && !requestIsLoopback(req)) {
        renderLarkOAuthConnectPage(req, res, requestedScope);
        return;
      }
      const payload = beginLarkOAuthLogin(feishuBotRuntimeEnv(process.env), {
        scope: requestedScope,
        redirectUri: larkOAuthRedirectUri(req),
      });
      res.statusCode = 302;
      res.setHeader('location', payload.auth_url);
      res.end();
    } catch (e) {
      send(503, { authenticated: false, connected: false, error: String((e as Error)?.message || e) });
    }
    return;
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/status') {
    try {
      const session = await optionalDeviceSession(req);
      const status = await resolveLarkOAuthPublicStatus(feishuBotRuntimeEnv(larkEnvForSession(session)), LARK_CORE_REQUIRED_SCOPE);
      return send(200, {
        ...status,
        redirect_uri: larkOAuthRedirectUri(req),
        device_redirect_uri: larkDeviceOAuthRedirectUri(),
        auth_mode: session ? 'device_oauth' : status.auth_mode,
        token_store: session ? 'cloud_hub_session' : 'shared_user_oauth',
      });
    } catch (e) {
      send(502, { authenticated: false, connected: false, error: String((e as Error)?.message || e) });
    }
    return;
  }
  if (!FEISHU_SERVICE_BASE && (apath === '/api/feishu/team/access' || apath === '/api/feishu/me')) {
    try {
      const sessionToken = localSessionTokenFor(req);
      const session = await requireDeviceSession(req, res);
      if (!session) return;
      const status = await resolveLarkOAuthPublicStatus(feishuBotRuntimeEnv(larkEnvForSession(session)), LARK_CORE_REQUIRED_SCOPE);
      const openId = session.feishu_open_id || status.user_open_ids[0] || null;
      if (openId && !session.feishu_open_id) await persistSessionFeishuIdentity(sessionToken, session, openId);
      const teamAccess = await fetchFeishuTeamAccess({ env: feishuBotRuntimeEnv(), userOpenId: openId });
      return send(200, {
        connected: !!status.connected,
        configured: !!status.configured,
        source: 'feishu_identity',
        server_now_ms: Date.now(),
        server_time: new Date().toISOString(),
        auth_mode: 'device_oauth',
        token_store: 'cloud_hub_session',
        data_isolation: 'inkloop_session_namespace',
        session: {
          tenant_id: session.tenant_id,
          user_id: openId ? inkloopUserIdFromFeishuOpenId(openId) : session.user_id,
          device_id: session.device_id,
          feishu_open_id: openId,
        },
        oauth: status,
        team_access: teamAccess,
        bot: {
          ...feishuBotConfigStatusPayload(),
          token_store: 'cloud_hub_server',
        },
      });
    } catch (e) {
      return send(Number((e as { status?: number })?.status) || 502, { connected: false, configured: true, error: String((e as Error)?.message || e) });
    }
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/refresh') {
    try {
      const session = await optionalDeviceSession(req);
      const status = await resolveLarkOAuthPublicStatus(feishuBotRuntimeEnv(larkEnvForSession(session)), LARK_CORE_REQUIRED_SCOPE, Date.now());
      return send(200, {
        ...status,
        redirect_uri: larkOAuthRedirectUri(req),
        device_redirect_uri: larkDeviceOAuthRedirectUri(),
        auth_mode: session ? 'device_oauth' : status.auth_mode,
        token_store: session ? 'cloud_hub_session' : 'shared_user_oauth',
      });
    } catch (e) {
      send(502, { authenticated: false, connected: false, error: String((e as Error)?.message || e) });
    }
    return;
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/oauth/callback') {
    const u = new URL(rest, 'http://inkloop.local');
    const error = u.searchParams.get('error');
    if (error) {
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<h1>飞书授权失败</h1><p>${escapeHtml(error)}</p>`);
      return;
    }
    const state = u.searchParams.get('state') || '';
    const pending = takeLocalLarkOAuthState(state);
    if (pending) {
      await completePendingLarkOAuthCallback(res, pending, u.searchParams.get('code') || '', state);
      return;
    }
    try {
      const result = await completeLarkOAuthCallback(feishuBotRuntimeEnv(process.env), {
        code: u.searchParams.get('code') || '',
        state: u.searchParams.get('state'),
        redirectUri: larkOAuthRedirectUri(req),
      });
      const missing = result.status.missing_scopes.length ? `<p>仍缺少权限：${escapeHtml(result.status.missing_scopes.join(', '))}</p>` : '<p>会议读取权限已就绪。</p>';
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>飞书授权完成</title><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:28px;line-height:1.6"><h1>飞书授权完成</h1>${missing}<p>可以回到 InkLoop 继续使用。</p><script>if(window.opener){setTimeout(()=>window.close(),900)}</script></body>`);
    } catch (e) {
      res.statusCode = Number((e as { status?: number })?.status) || 500;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<h1>飞书授权失败</h1><p>${escapeHtml(String((e as Error)?.message || e))}</p>`);
    }
    return;
  }
  if (!FEISHU_SERVICE_BASE && apath === '/api/feishu/workspaces') {
    try {
      const result = await fetchFeishuBotWorkspaces({ env: feishuBotRuntimeEnv() });
      return send(200, result);
    } catch (e) {
      return send(502, { connected: false, configured: true, source: 'feishu_bot_im', auth_mode: 'tenant_access_token', workspaces: [], error: { code: 'bot_workspaces_failed', message: String((e as Error)?.message || e) } });
    }
  }
  if (!FEISHU_SERVICE_BASE && localMaterialRoute?.kind === 'workspace_docx_links') {
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    try {
      const u = new URL(rest, 'http://inkloop.local');
      const limit = Number(u.searchParams.get('limit') || u.searchParams.get('page_size') || '') || undefined;
      return send(200, await fetchFeishuBotWorkspaceDocxLinks(localMaterialRoute.chatId, { pageSize: limit, env: feishuBotRuntimeEnv() }));
    } catch (e) {
      return send(502, { connected: false, configured: true, source: 'feishu_bot_im', auth_mode: 'tenant_access_token', links: [], error: { code: 'bot_docx_links_failed', message: String((e as Error)?.message || e) } });
    }
  }
  if (!FEISHU_SERVICE_BASE && localMaterialRoute?.kind === 'message_file') {
    // convert sidecar 服务端抓取源文件时带 x-inkloop-secret（老 feishu-service 的服务间鉴权约定），
    // 没有设备 session——放行 secret 命中的服务间请求，其余仍走设备 session 门。
    const secretHeader = String(req.headers['x-inkloop-secret'] || '');
    const serviceAuthed = !!INKLOOP_SHARED_SECRET && secretHeader.length === INKLOOP_SHARED_SECRET.length
      && timingSafeEqual(Buffer.from(secretHeader), Buffer.from(INKLOOP_SHARED_SECRET));
    if (!serviceAuthed) {
      const session = await requireDeviceSession(req, res);
      if (!session) return;
    }
    const u = new URL(rest, 'http://inkloop.local');
    const type = u.searchParams.get('type') || 'file';
    if (type !== 'file' && type !== 'image') return send(400, { error: { code: 'invalid_resource_type', message: 'type must be file or image' } });
    try {
      const result = await fetchFeishuBotMessageResource(localMaterialRoute.messageId, localMaterialRoute.resourceKey, type, { env: feishuBotRuntimeEnv() });
      if (!result.ok || !result.response) return send(result.status || 502, { error: result.error });
      const name = u.searchParams.get('name');
      if (name && !result.response.headers.has('content-disposition')) {
        res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      }
      await relayStreamingBinary(res, result.response);
      return;
    } catch (e) {
      if (!res.headersSent) return send(502, { error: { code: 'resource_download_failed', message: String((e as Error)?.message || e) } });
      res.destroy(e as Error);
      return;
    }
  }
  if (!FEISHU_SERVICE_BASE && localMaterialRoute?.kind === 'docx_pdf') {
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    if (!session.tenant_id || !session.user_id || !session.feishu_open_id) return send(409, { error: { code: 'reauth_required', message: '当前 session 未绑定飞书身份' } });
    const documentId = localMaterialRoute.documentId;
    try {
      const result = await exportLarkDocxToPdf(documentId, {
        env: feishuBotRuntimeEnv(larkEnvForSession(session)),
        expectedOpenId: session.feishu_open_id,
      });
      if (!result.ok || !result.response) return send(result.status || 502, { error: result.error });
      if (!result.response.headers.has('content-disposition')) {
        res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(result.file_name || `${documentId}.pdf`)}`);
      }
      await relayStreamingBinary(res, result.response);
      return;
    } catch (e) {
      if (!res.headersSent) return send(Number((e as { status?: number })?.status) || 502, { error: { code: 'docx_pdf_failed', message: String((e as Error)?.message || e) } });
      res.destroy(e as Error);
      return;
    }
  }
  if (!FEISHU_SERVICE_BASE && botWorkspaceMatch) {
    try {
      const u = new URL(rest, 'http://inkloop.local');
      const chatId = decodeURIComponent(botWorkspaceMatch[1]);
      const kind = botWorkspaceMatch[2];
      const limit = Number(u.searchParams.get('limit') || u.searchParams.get('page_size') || '') || undefined;
      if (kind === 'members') return send(200, await fetchFeishuBotWorkspaceMembers(chatId, { pageSize: limit, env: feishuBotRuntimeEnv() }));
      if (kind === 'files') {
        const result = await fetchFeishuBotWorkspaceFiles(chatId, { pageSize: limit, env: feishuBotRuntimeEnv() });
        return send(200, {
          ...result,
          files: result.messages.map((message) => ({
            message_id: message.message_id,
            msg_type: message.msg_type,
            file_name: message.file_name || (message.msg_type === 'image' ? '［图片］' : '文件'),
            file_key: message.file_key,
            image_key: message.image_key,
            resource_key: message.image_key || message.file_key || message.message_id,
            create_time: message.create_time,
            download_path: `/api/feishu/workspaces/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(message.message_id)}/file/${encodeURIComponent(message.image_key || message.file_key || '')}?type=${message.msg_type === 'image' ? 'image' : 'file'}&name=${encodeURIComponent(message.file_name || (message.msg_type === 'image' ? '［图片］' : '文件'))}`,
          })),
        });
      }
      return send(200, await fetchFeishuBotWorkspaceMessages(chatId, { pageSize: limit, env: feishuBotRuntimeEnv() }));
    } catch (e) {
      return send(502, { connected: false, configured: true, source: 'feishu_bot_im', auth_mode: 'tenant_access_token', messages: [], error: { code: 'bot_workspace_failed', message: String((e as Error)?.message || e) } });
    }
  }
  if (!FEISHU_SERVICE_BASE) return send(503, { error: 'FEISHU_SERVICE_BASE 未配置' });
  const target = `${FEISHU_SERVICE_BASE}${rest}`;
  if (apath === '/api/feishu/oauth/login') { res.statusCode = 302; res.setHeader('location', target); res.end(); return; } // 纯跳转·不需要 secret
  if (!INKLOOP_SHARED_SECRET) return send(503, { error: 'INKLOOP_SHARED_SECRET 未配置' });
  // 白名单：只放行设备真用的 GET 数据端点（防 confused-deputy）。
  // 妙记 docx 挂资料：workspaces/:chatId/docx-links(链接候选) + docx/:token/(meta|raw-content|pdf)(元信息/纯文本/手动导出PDF)。
  const allowed = /^\/api\/feishu\/(oauth\/status|my\/events|meeting-sources|meeting-events\/status|meetings\/[^/]+\/note-transcript|workspaces(\/[^/]+)?(\/(members|messages|files|docx-links))?|messages\/[^/]+\/file\/[^/]+|docx\/[^/]+\/(meta|raw-content|pdf)|docx\/[^/]+\/media\/[^/]+|calendars|events)$/.test(apath);
  if (!allowed) return send(403, { error: 'path not allowed' });
  let userContextHeaders: Record<string, string> = {};
  if (FEISHU_NEEDS_USER_CONTEXT.test(apath)) {
    const session = await requireDeviceSession(req, res);
    if (!session) return;
    userContextHeaders = feishuUserContextHeaders(session);
  }
  try {
    const r = await fetch(target, { headers: { 'x-inkloop-secret': INKLOOP_SHARED_SECRET, ...userContextHeaders } });
    await relayBinary(res, r);
  } catch (e) { send(502, { error: String((e as Error)?.message || e) }); }
}
// 阶段E：convert-service 代抓 feishu-service 的 docx 私有资源(meta/raw-content/pdf)时，不能只信任裸 url——
// 要先拿真实设备 session 向 panel 换一张一次性下载票据，转发给 convert-service（而不是 tenant/user 身份头，
// convert-service 不该直接持有/转发这些身份信息）。群文件等其它 convert 目标不受影响，走原来的裸转发。
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
const FEISHU_DOCX_TICKET_PATH = /^\/api\/feishu\/docx\/([A-Za-z0-9_-]{8,80})\/(meta|raw-content|pdf)$/;

function parseFeishuDocxTicketTarget(raw: string): { token: string; action: string } | null {
  if (!FEISHU_SERVICE_BASE) return null;
  try {
    const u = new URL(raw);
    const b = new URL(FEISHU_SERVICE_BASE + '/');
    if (u.origin !== b.origin) return null;
    const base = b.pathname.replace(/\/+$/, '');
    const rel = base && base !== '/' ? (u.pathname.startsWith(base + '/') ? u.pathname.slice(base.length) : '') : u.pathname;
    const m = rel.match(FEISHU_DOCX_TICKET_PATH);
    return m ? { token: m[1], action: m[2] } : null;
  } catch { return null; }
}

async function issueDownloadTicket(sessionToken: string, target: { token: string; action: string }): Promise<string> {
  if (!PANEL_AUTH_BASE || !INTERNAL_SERVICE_TOKEN) throw Object.assign(new Error('PANEL_AUTH_BASE / INTERNAL_SERVICE_TOKEN 未配置'), { status: 503 });
  const r = await fetch(`${PANEL_AUTH_BASE}/api/internal/inkloop/download-tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_token: sessionToken, resource_type: 'feishu_docx', resource_id: target.token, action: target.action, audience: 'feishu-service', ttl_ms: 300000 }),
  });
  const data = await r.json().catch(() => ({})) as { ticket?: string; error?: string };
  if (!r.ok || !data.ticket) throw Object.assign(new Error(data.error || `issue ticket HTTP ${r.status}`), { status: r.status });
  return data.ticket;
}

async function handleConvertService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, obj: unknown): void => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (!CONVERT_SERVICE_BASE || !INKLOOP_SHARED_SECRET) return send(503, { error: 'CONVERT_SERVICE_BASE / INKLOOP_SHARED_SECRET 未配置' });
  const selfFeishuBase = (process.env.CONVERT_FEISHU_SOURCE_BASE || `http://127.0.0.1:${PORT}/api/feishu-svc`).replace(/\/+$/, '');
  const rest = rewriteLegacyConvertSource((req.url || '').replace(/^\/api\/convert/, ''), selfFeishuBase);
  const apath = (rest || '/').split('?')[0];
  if (apath !== '/to-pdf') return send(403, { error: 'path not allowed' });
  const sourceUrl = new URL(req.url || '/', 'http://inkloop.local').searchParams.get('url') || '';
  const docxTarget = parseFeishuDocxTicketTarget(sourceUrl);
  const headers: Record<string, string> = { 'x-inkloop-secret': INKLOOP_SHARED_SECRET };
  try {
    if (docxTarget) {
      const sessionToken = bearerToken(req) || String(req.headers['x-inkloop-session'] || '').trim();
      const session = await requireDeviceSession(req, res);
      if (!session) return;
      if (!session.tenant_id || !session.user_id || !session.feishu_open_id) return send(409, { error: 'reauth_required' });
      headers['x-inkloop-download-ticket'] = await issueDownloadTicket(sessionToken, docxTarget);
    }
    const r = await fetch(`${CONVERT_SERVICE_BASE}/convert${rest}`, { headers });
    await relayBinary(res, r);
  } catch (e) { send(Number((e as { status?: number })?.status) || 502, { error: String((e as Error)?.message || e) }); }
}

// intent A/B 影子数据落盘位置（板上 production 收集云端↔端侧 respond/fold 一致率）。
const AB_LOG = process.env.AB_LOG || resolve(ROOT, '.ab-intent.jsonl');

const MAX_BODY = 25 * 1024 * 1024; // 25MB：页面图 / ink PNG dataURL
function readBody(req: IncomingMessage, maxBody = MAX_BODY): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) { rej(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    // 先 Buffer.concat 再一次性 decode：逐 chunk toString() 会在多字节 UTF-8（中文）跨 chunk 边界处插入替换字符，
    // 板上长 prompt/会议转写会静默失真（vite.config 代理早已这么做）。
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

// 一次性 JSON 路由（与流式两路分开）
const JSON_ROUTES: Record<string, (body: unknown) => Promise<unknown>> = {
  '/api/reflow': runReflow,
  '/api/reflow-ai': runReflowAi,
  '/api/ocr-layout': runOcrLayout,
  '/api/ocr-vlm': runOcrVlm,
  '/api/explain-image': runExplainImage,
  '/api/interpret': runInterpret,
  '/api/classify-context': runClassifyContext,
  '/api/reflow-vlm': runReflowVlm,
};

const requireRuntimeSession = process.env.INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION === '1';
const localRuntimeSession = requireRuntimeSession ? undefined : {
  active: true,
  tenant_id: process.env.INKLOOP_TENANT_ID || 'local',
  user_id: process.env.INKLOOP_USER_ID || 'local_demo',
};
const cloudKnowledgeStore = new JsonCloudKnowledgeStore(process.env.INKLOOP_KNOWLEDGE_STORE || resolve(ROOT, '.inkloop/knowledge'));
const cloudLibraryStore = new JsonCloudLibraryStore(process.env.INKLOOP_LIBRARY_STORE || resolve(ROOT, '.inkloop/library'));
const cloudDeviceStore = new JsonCloudDeviceStore(process.env.INKLOOP_DEVICE_STORE || resolve(ROOT, '.inkloop/devices'));
function knowledgePatchFromRuntimeEvent(event: RuntimeSyncEvent): CloudKnowledgeObjectPatch | null {
  if (event.operation !== 'knowledge.update') return null;
  const payload = event.payload || {};
  const rawPatch = payload.patch;
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) return null;
  const patch = rawPatch as Record<string, unknown>;
  const out: CloudKnowledgeObjectPatch = {};
  if (typeof patch.status === 'string' && ['inbox', 'accepted', 'edited', 'follow_up', 'dismissed', 'export_ready', 'exported', 'archived'].includes(patch.status)) {
    out.status = patch.status as CloudKnowledgeObjectPatch['status'];
  }
  if (Array.isArray(patch.tags)) out.tags = patch.tags.map((item) => String(item).trim()).filter(Boolean);
  if (typeof patch.task_done === 'boolean') out.task_done = patch.task_done;
  if (typeof patch.risk_status === 'string' && ['open', 'watching', 'mitigated', 'closed'].includes(patch.risk_status)) {
    out.risk_status = patch.risk_status as CloudKnowledgeObjectPatch['risk_status'];
  }
  if (typeof patch.risk_note === 'string') out.risk_note = patch.risk_note;
  if (typeof patch.comment_md === 'string') out.comment_md = patch.comment_md;
  return Object.keys(out).length ? out : null;
}
async function applyRuntimeKnowledgeUpdate(event: RuntimeSyncEvent, namespace: CloudKnowledgeNamespace): Promise<void> {
  const patch = knowledgePatchFromRuntimeEvent(event);
  if (!patch) return;
  const koId = typeof event.payload.ko_id === 'string' ? event.payload.ko_id : event.target?.id;
  if (!koId) throw Object.assign(new Error('knowledge_update_missing_ko_id'), { status: 400 });
  await cloudKnowledgeStore.patchKnowledgeObject(namespace, koId, patch, event.updated_at);
}
async function applyRuntimeAnnotationDelete(event: RuntimeSyncEvent, namespace: CloudKnowledgeNamespace): Promise<void> {
  if (event.operation !== 'annotation.delete') return;
  const payload = recordOf(event.payload);
  const markId = textOf(payload.mark_id, event.target?.id || event.event_id);
  const koId = textOf(payload.ko_id, event.target?.id || '');
  await cloudKnowledgeStore.deleteByRuntimeRefs(namespace, {
    document_id: event.doc_id,
    mark_ids: markId ? [markId] : [],
    ko_ids: koId ? [koId] : [],
  });
}
function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeId(input: string, fallback: string): string {
  return (input || fallback).normalize('NFKC').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96) || fallback;
}
function textOf(value: unknown, fallback = ''): string {
  return String(value || fallback).trim();
}
function normalizePostprocessText(value: unknown): string {
  return textOf(value).replace(/\s+/g, ' ').trim();
}
function isPostprocessNoiseText(value: unknown, docTitle = ''): boolean {
  const text = normalizePostprocessText(value);
  if (!text) return true;
  if (text === '稍后处理') return true;
  const title = normalizePostprocessText(docTitle).replace(/\.(pdf|epub|md|markdown)$/i, '');
  if (title && text === title) return true;
  if (/\.pdf\s*·\s*p\d+$/i.test(text)) return true;
  return false;
}
function firstSignalText(docTitle: string, values: unknown[], fallback = ''): string {
  const candidates = values.map((value) => normalizePostprocessText(value)).filter(Boolean);
  return candidates.find((value) => !isPostprocessNoiseText(value, docTitle)) || normalizePostprocessText(fallback);
}
function postprocessDisplayTitle(input: {
  annotation: Record<string, unknown>;
  payload: Record<string, unknown>;
  kind: KnowledgeKind;
  docTitle: string;
  signalText: string;
}): string {
  const explicit = firstSignalText(input.docTitle, [
    input.annotation.title,
    input.payload.title,
  ]);
  if (explicit) return explicit.slice(0, 80);
  if (input.signalText && !isPostprocessNoiseText(input.signalText, input.docTitle)) return input.signalText.slice(0, 80);
  if (input.kind === 'highlight') return 'Highlight';
  if (input.kind === 'task' || input.kind === 'meeting_action') return 'Task';
  if (input.kind === 'decision' || input.kind === 'meeting_decision') return 'Decision';
  if (input.kind === 'risk' || input.kind === 'meeting_risk') return 'Risk';
  if (input.kind === 'qa') return 'Question';
  const hasInk = Array.isArray(input.annotation.visual_strokes) || Array.isArray(input.annotation.surface_strokes);
  return hasInk ? '手写标记' : 'Reading Note';
}
function postprocessSignalText(input: {
  annotation: Record<string, unknown>;
  payload: Record<string, unknown>;
  docTitle: string;
}): string {
  return firstSignalText(input.docTitle, [
    input.annotation.body_md,
    input.annotation.text,
    input.annotation.description,
    input.payload.marked_text,
    input.payload.text,
    input.annotation.title,
  ], Array.isArray(input.annotation.visual_strokes) || Array.isArray(input.annotation.surface_strokes) ? '手写标记' : 'Ink mark');
}
function postprocessQuoteText(input: {
  annotation: Record<string, unknown>;
  payload: Record<string, unknown>;
  docTitle: string;
}): string {
  return firstSignalText(input.docTitle, [
    input.payload.marked_text,
    input.payload.quote,
    input.annotation.quote,
    input.payload.text,
    input.annotation.body_md,
    input.annotation.text,
  ]);
}
function postprocessUserNoteText(input: {
  annotation: Record<string, unknown>;
  payload: Record<string, unknown>;
  docTitle: string;
}): string {
  return firstSignalText(input.docTitle, [
    input.annotation.body_md,
    input.annotation.text,
    input.annotation.description,
    input.annotation.title,
    input.payload.title,
    input.payload.user_note,
  ]);
}
function postprocessContextText(annotation: Record<string, unknown>, payload: Record<string, unknown>): string {
  return firstSignalText('', [
    payload.context_text,
    payload.page_text,
    annotation.context_text,
    annotation.page_text,
  ]);
}
function normBBox(value: unknown): NormBBox | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const nums = value.map((item) => Number(item));
  return nums.every(Number.isFinite) ? nums as NormBBox : undefined;
}
function isMeetingRuntimeDocument(documentId: string): boolean {
  return isMeetingRuntimeDocumentId(documentId);
}
function normalizeRuntimeKnowledgeKind(annotation: Record<string, unknown>, payload: Record<string, unknown>, documentId: string): KnowledgeKind {
  const raw = [
    annotation.kind,
    payload.kind,
    annotation.action,
    payload.action,
    annotation.hmp_action,
    payload.hmp_action,
    annotation.tool,
    payload.tool,
    annotation.origin,
    payload.origin,
    annotation.scored_type,
    payload.scored_type,
    annotation.title,
  ].map((value) => String(value || '')).join(' ').toLowerCase();
  if (isMeetingRuntimeDocument(documentId)) {
    if (raw.includes('task') || raw.includes('todo') || raw.includes('action')) return 'meeting_action';
    if (raw.includes('decision')) return 'meeting_decision';
    if (raw.includes('risk')) return 'meeting_risk';
    if (raw.includes('question') || raw.includes('qa')) return 'qa';
    return 'reading_note';
  }
  if (raw.includes('reading_summary') || raw.includes('summary') || raw.includes('摘要')) return 'summary';
  if (raw.includes('ai_note') || raw.includes('ai_response') || raw.includes('aipen') || raw.includes('ai_pen')) return 'ai_note';
  if (raw.includes('excerpt') || raw.includes('quote')) return 'excerpt';
  if (raw.includes('highlighter') || raw.includes('highlight') || raw.includes('高亮')) return 'highlight';
  return 'reading_note';
}
function postprocessKind(annotation: Record<string, unknown>, payload: Record<string, unknown>, documentId: string): KnowledgeKind {
  return normalizeRuntimeKnowledgeKind(annotation, payload, documentId);
}
function calloutForKind(kind: KnowledgeKind): 'summary' | 'quote' | 'todo' | 'tip' | 'warning' | 'question' {
  if (kind === 'task' || kind === 'meeting_action') return 'todo';
  if (kind === 'decision' || kind === 'meeting_decision') return 'tip';
  if (kind === 'risk' || kind === 'meeting_risk') return 'warning';
  if (kind === 'highlight') return 'quote';
  if (kind === 'qa') return 'question';
  return 'summary';
}
function isReadingKnowledgeKind(kind: KnowledgeKind): boolean {
  return kind === 'summary' || kind === 'reading_note' || kind === 'highlight' || kind === 'excerpt' || kind === 'ai_note';
}
function positivePageNumberFromText(value: unknown): number | null {
  const match = String(value || '').match(/\b(?:p|page|pg)[ _.-]*(\d{1,4})\b/i);
  if (!match) return null;
  const page = Number(match[1]);
  return Number.isInteger(page) && page > 0 ? page : null;
}
function runtimeEventPageIndex(event: RuntimeSyncEvent, annotation: Record<string, unknown>): number {
  const payload = recordOf(event.payload);
  const candidates = [
    payload.page_index,
    annotation.page_index,
    recordOf(annotation.source).page_index,
  ];
  for (const candidate of candidates) {
    const index = Number(candidate);
    if (Number.isInteger(index) && index >= 0) return index;
  }
  const blockPage = positivePageNumberFromText(event.target?.block_id);
  if (blockPage) return blockPage - 1;
  const titlePage = positivePageNumberFromText(annotation.title);
  if (titlePage) return titlePage - 1;
  const pageId = positivePageNumberFromText(payload.page_id || annotation.page_id || recordOf(annotation.source).page_id);
  if (pageId) return pageId - 1;
  return 0;
}
function runtimeEventPageId(event: RuntimeSyncEvent, annotation: Record<string, unknown>, pageIndex: number): string {
  const payload = recordOf(event.payload);
  return textOf(payload.page_id, textOf(annotation.page_id, textOf(recordOf(annotation.source).page_id, `pg_${safeId(event.doc_id, 'doc')}_${pageIndex + 1}`)));
}
function inkloopPageAnchorUri(documentId: string, pageIndex: number, anchor: string): string {
  return `${buildInkloopDocUri(documentId)}/page/${pageIndex + 1}?anchor=${encodeURIComponent(anchor)}`;
}
async function documentTitle(namespace: CloudKnowledgeNamespace, documentId: string): Promise<string> {
  const doc = await cloudLibraryStore.get(namespace, documentId);
  return doc?.filename || documentId;
}
async function buildPostprocessKnowledgeObject(input: {
  event: RuntimeSyncEvent;
  annotation: Record<string, unknown>;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  aiTurnId: string;
  docTitle: string;
  title: string;
  body: string;
  quote: string;
}): Promise<KnowledgeObject> {
  const markId = textOf(recordOf(input.event.payload).mark_id, input.event.target?.id || input.event.event_id);
  const sourceKoId = safeId(textOf(input.annotation.ko_id, `ko_${input.event.event_id}`), `ko_${input.event.event_id}`);
  const koId = `ko_ai_${safeId(`${input.event.event_id}_${sourceKoId}`, 'event')}`;
  const pageIndex = runtimeEventPageIndex(input.event, input.annotation);
  const uri = inkloopPageAnchorUri(input.event.doc_id, pageIndex, markId);
  const title = textOf(input.title, input.kind === 'highlight' ? 'Highlight' : 'Reading Note');
  const visualStrokes = Array.isArray(input.annotation.visual_strokes) ? input.annotation.visual_strokes : undefined;
  const isTestRun = recordOf(input.event.payload).inkloop_test_run === true;
  const source = {
    document_id: input.event.doc_id,
    document_title: input.docTitle,
    page_id: runtimeEventPageId(input.event, input.annotation, pageIndex),
    page_index: pageIndex,
    object_refs: [markId],
    anchor_bbox: normBBox(input.annotation.visual_bbox || recordOf(input.event.payload).bbox),
    quote: input.quote,
    inkloop_uri: uri,
  };
  const draft: KnowledgeObject & { metadata?: Record<string, unknown>; visual_strokes?: unknown } = {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: koId,
    kind: input.kind,
    title,
    body_md: [
      input.body,
      '',
      input.quote ? `Marked evidence: ${input.quote}` : '',
      '',
      `Backlink: ${uri}`,
    ].filter((line, index, arr) => line || arr[index - 1]).join('\n'),
    source,
    provenance: { created_from: 'ai_turn', mark_ids: [markId], ai_turn_ids: [input.aiTurnId] },
    tags: ['inkloop', `inkloop/${input.kind}`, 'inkloop/postprocess'],
    status: input.status,
    privacy: 'export_allowed',
    render_hints: { markdown_callout: calloutForKind(input.kind) },
    ...(isTestRun ? { metadata: { inkloop_test_run: true } } : {}),
    ...(visualStrokes ? { visual_strokes: visualStrokes } : {}),
    content_hash: 'sha256:pending',
    created_at: input.event.created_at,
    updated_at: input.event.updated_at,
  };
  return {
    ...draft,
    content_hash: await sha256ContentHash(canonicalJson({
      kind: draft.kind,
      title: draft.title,
      body_md: draft.body_md,
      source: draft.source,
      status: draft.status,
      visual_strokes: draft.visual_strokes,
    })),
  };
}
async function buildRawRuntimeAnnotationKnowledgeObject(input: {
  event: RuntimeSyncEvent;
  annotation: Record<string, unknown>;
  kind: KnowledgeKind;
  docTitle: string;
  body: string;
  quote: string;
}): Promise<KnowledgeObject> {
  const payload = recordOf(input.event.payload);
  const markId = textOf(payload.mark_id, input.event.target?.id || input.event.event_id);
  const koId = safeId(textOf(input.annotation.ko_id, input.event.target?.id || `ko_${input.event.event_id}`), `ko_${input.event.event_id}`);
  const pageIndex = runtimeEventPageIndex(input.event, input.annotation);
  const uri = inkloopPageAnchorUri(input.event.doc_id, pageIndex, markId);
  const rawKind: KnowledgeKind = input.kind === 'ai_note' ? 'reading_note' : input.kind;
  const visualStrokes = Array.isArray(input.annotation.visual_strokes) ? input.annotation.visual_strokes : undefined;
  const surfaceStrokes = Array.isArray(input.annotation.surface_strokes) ? input.annotation.surface_strokes : undefined;
  const title = postprocessDisplayTitle({
    annotation: input.annotation,
    payload,
    kind: rawKind,
    docTitle: input.docTitle,
    signalText: input.body || input.quote,
  });
  const source = {
    document_id: input.event.doc_id,
    document_title: input.docTitle,
    page_id: runtimeEventPageId(input.event, input.annotation, pageIndex),
    page_index: pageIndex,
    object_refs: [markId],
    anchor_bbox: normBBox(input.annotation.visual_bbox || payload.bbox),
    quote: input.quote,
    inkloop_uri: uri,
  };
  const draft: KnowledgeObject & { metadata?: Record<string, unknown>; visual_strokes?: unknown; surface_strokes?: unknown } = {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: koId,
    kind: rawKind,
    title,
    body_md: [
      input.body || input.quote || title,
      '',
      input.quote && input.quote !== input.body ? `Marked evidence: ${input.quote}` : '',
      '',
      `Backlink: ${uri}`,
    ].filter((line, index, arr) => line || arr[index - 1]).join('\n'),
    source,
    provenance: { created_from: 'mark', mark_ids: [markId] },
    tags: ['inkloop', `inkloop/${rawKind}`, 'inkloop/reading', 'inkloop/raw-mark'],
    status: 'accepted',
    privacy: 'export_allowed',
    render_hints: { markdown_callout: calloutForKind(rawKind) },
    ...(payload.inkloop_test_run === true ? { metadata: { inkloop_test_run: true } } : {}),
    ...(visualStrokes ? { visual_strokes: visualStrokes } : {}),
    ...(surfaceStrokes ? { surface_strokes: surfaceStrokes } : {}),
    content_hash: 'sha256:pending',
    created_at: input.event.created_at,
    updated_at: input.event.updated_at,
  };
  return {
    ...draft,
    content_hash: await sha256ContentHash(canonicalJson({
      kind: draft.kind,
      title: draft.title,
      body_md: draft.body_md,
      source: draft.source,
      status: draft.status,
      visual_strokes: draft.visual_strokes,
      surface_strokes: draft.surface_strokes,
    })),
  };
}
async function buildPostprocessProjection(input: {
  event: RuntimeSyncEvent;
  ko: KnowledgeObject;
  docTitle: string;
  text: string;
  annotation: Record<string, unknown>;
}): Promise<DocumentProjection> {
  const isTestRun = recordOf(input.event.payload).inkloop_test_run === true;
  const annotation = {
    ko_id: input.ko.ko_id,
    kind: input.ko.kind,
    title: input.ko.title,
    body_md: input.text,
    status: input.ko.status,
    render_mode: textOf(input.annotation.render_mode, Array.isArray(input.annotation.visual_strokes) ? 'stroke_only' : 'margin_note'),
    visual_bbox: input.ko.source.anchor_bbox,
    visual_strokes: Array.isArray(input.annotation.visual_strokes) ? input.annotation.visual_strokes : undefined,
    surface_strokes: Array.isArray(input.annotation.surface_strokes) ? input.annotation.surface_strokes : undefined,
    created_at: input.event.created_at,
    updated_at: input.event.updated_at,
  };
  const block: DocumentProjectionBlock & { annotations?: unknown[] } = {
    block_id: `blk_${safeId(input.event.event_id, 'event')}`,
    kind: 'paragraph',
    text_md: input.text,
    region: 'generated',
    source: {
      page_id: input.ko.source.page_id || `pg_${safeId(input.event.doc_id, 'doc')}_1`,
      page_index: input.ko.source.page_index ?? 0,
      object_refs: input.ko.source.object_refs,
      source_range: { start: 0, end: input.text.length },
      anchor_bbox: input.ko.source.anchor_bbox,
    },
    knowledge_object_ids: [input.ko.ko_id],
    annotations: [annotation],
  };
  const bodyHash = await computeDocumentProjectionBodyHash([block]);
  const base: Omit<DocumentProjection, 'content_hash'> & { metadata?: Record<string, unknown> } = {
    schema_version: DOCUMENT_PROJECTION_SCHEMA_VERSION,
    projection_id: `dp_${safeId(input.event.doc_id, 'doc')}_${safeId(input.event.event_id, 'event')}`,
    document_id: input.event.doc_id,
    document_title: input.docTitle,
    document_uri: buildInkloopDocUri(input.event.doc_id),
    revision_id: `rev_${bodyHash.replace('sha256:', '').slice(0, 16)}`,
    generated_at: input.event.updated_at,
    source: { app: 'inkloop-cloud-hub', app_version: '0.1.0' },
    privacy: 'export_allowed',
    export_policy: {
      include_full_text: false,
      include_pdf_asset: false,
      include_raw_strokes: false,
      include_debug_evidence: false,
    },
    blocks: [block],
    body_hash: bodyHash,
    created_at: input.event.created_at,
    updated_at: input.event.updated_at,
    ...(isTestRun ? { metadata: { inkloop_test_run: true } } : {}),
  };
  return { ...base, content_hash: await computeDocumentProjectionHash(base) };
}
async function applyRuntimeAnnotationPostprocess(event: RuntimeSyncEvent, namespace: CloudKnowledgeNamespace): Promise<void> {
  if (event.operation !== 'annotation.add' && event.operation !== 'annotation.update') return;
  const payload = recordOf(event.payload);
  const updateDisposition = await prepareRuntimeAnnotationUpdate(event, namespace, cloudKnowledgeStore);
  if (updateDisposition === 'patched') return;
  const annotation = recordOf(event.operation === 'annotation.update' ? payload.patch : payload.annotation);
  const docTitle = await documentTitle(namespace, event.doc_id);
  const markText = postprocessSignalText({ annotation, payload, docTitle });
  const quoteText = postprocessQuoteText({ annotation, payload, docTitle }) || markText;
  const userNote = postprocessUserNoteText({ annotation, payload, docTitle });
  const contextText = postprocessContextText(annotation, payload);
  const kind = postprocessKind(annotation, payload, event.doc_id);
  const rawKo = isMeetingRuntimeDocument(event.doc_id)
    ? null
    : await buildRawRuntimeAnnotationKnowledgeObject({
        event,
        annotation,
        kind,
        docTitle,
        body: userNote || markText,
        quote: quoteText,
      });
  if (!shouldPostprocessRuntimeAnnotation(event)) {
    if (rawKo) await cloudKnowledgeStore.upsertKnowledgeObject(namespace, rawKo);
    return;
  }
  let classifier: { respond: boolean; reason: string } = { respond: true, reason: 'Cloud Hub accepted the reading mark for V1 post-processing.' };
  let postprocessError = '';
  try {
    classifier = await runClassifyContext({
      question: userNote || markText,
      marked: quoteText || markText,
      view_narrative: `InkLoop Paper/Web runtime mark on ${docTitle}.`,
      conversation: [],
      model: process.env.LLM_MODEL || 'glm-5.2',
    });
  } catch (error) {
    postprocessError = String((error as Error)?.message || error);
    classifier = {
      respond: true,
      reason: 'LLM gateway was unavailable; Cloud Hub preserved the mark as a post-processing inbox item.',
    };
  }
  const aiTurnId = `turn_${safeId(event.event_id, 'event')}`;
  let generatedNote: { title?: string; body_md?: string; summary_md?: string } = {};
  try {
    if (isReadingKnowledgeKind(kind)) {
      generatedNote = await runReadingNotePostprocess({
        doc_title: docTitle,
        quote: quoteText,
        user_note: userNote,
        context_text: contextText,
        model: process.env.LLM_MODEL || 'glm-5.2',
      });
    }
  } catch (error) {
    postprocessError = [postprocessError, String((error as Error)?.message || error)].filter(Boolean).join(' | ');
  }
  const title = generatedNote.title || postprocessDisplayTitle({ annotation, payload, kind, docTitle, signalText: userNote || markText });
  const aiReason = classifier.reason || 'Cloud Hub created a reviewed projection from this runtime mark.';
  const body = generatedNote.body_md
    || (userNote && quoteText && userNote !== quoteText ? `${userNote}\n\n${quoteText}` : '')
    || (markText && !isPostprocessNoiseText(markText, docTitle) ? markText : aiReason);
  const status: KnowledgeStatus = isReadingKnowledgeKind(kind) && (body || quoteText) ? 'accepted' : (classifier.respond ? 'accepted' : 'inbox');
  const aiTurn: CloudAiTurnRecord = {
    schema_version: 'inkloop.cloud_hub.ai_turn.v1',
    ai_turn_id: aiTurnId,
    document_id: event.doc_id,
    mark_ids: [textOf(payload.mark_id, event.target?.id || event.event_id)],
    prompt_md: 'Cloud Hub runtime mark post-processing',
    response_md: generatedNote.summary_md || classifier.reason || 'Cloud Hub created a reviewed projection from this runtime mark.',
    status,
    created_at: event.created_at,
    updated_at: event.updated_at,
    metadata: {
      source: 'runtime-sync-accepted-event',
      runtime_event_id: event.event_id,
      classifier_respond: classifier.respond,
      marked_text: markText,
      quote_text: quoteText,
      user_note: userNote,
      generated_summary_md: generatedNote.summary_md || '',
      ...(payload.inkloop_test_run === true ? { inkloop_test_run: true } : {}),
      ...(postprocessError ? { llm_error: postprocessError } : {}),
    },
  };
  const ko = await buildPostprocessKnowledgeObject({
    event,
    annotation,
    kind,
    status,
    aiTurnId,
    docTitle,
    title,
    body,
    quote: quoteText,
  });
  const projection = await buildPostprocessProjection({
    event,
    ko,
    docTitle,
    text: generatedNote.summary_md || quoteText || markText,
    annotation,
  });
  if (rawKo) await cloudKnowledgeStore.upsertKnowledgeObject(namespace, rawKo);
  await cloudKnowledgeStore.upsertAiTurn(namespace, aiTurn);
  await cloudKnowledgeStore.upsertKnowledgeObject(namespace, ko);
  await cloudKnowledgeStore.upsertDocumentProjection(namespace, projection);
}
function runtimeSnapshotFromEvent(event: RuntimeSyncEvent): { blocks: RuntimeSurfaceBlock[]; documentTitle: string } | null {
  if (event.operation !== 'runtime.bootstrap') return null;
  const payload = recordOf(event.payload);
  const snapshot = recordOf(payload.snapshot);
  const blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks as RuntimeSurfaceBlock[] : [];
  if (!blocks.length) return null;
  const document = recordOf(snapshot.document);
  const identity = recordOf(snapshot.identity);
  const title = textOf(document.title, textOf(identity.title, event.doc_id));
  return { blocks, documentTitle: title };
}
async function applyRuntimeBootstrapSnapshot(event: RuntimeSyncEvent, namespace: CloudKnowledgeNamespace): Promise<void> {
  const snapshot = runtimeSnapshotFromEvent(event);
  if (!snapshot) return;
  // Bootstrap is a device-state snapshot for recovery and cursor catch-up. It is
  // intentionally not a publishing source for Obsidian; otherwise historical
  // blocks, synthetic demo marks, and stale annotations are promoted as current
  // reading notes. Canonical Cloud Knowledge comes from explicit annotation
  // events and their post-processing output.
  void namespace;
}
async function applyRuntimeAcceptedEvent(event: RuntimeSyncEvent, namespace: CloudKnowledgeNamespace): Promise<void> {
  await applyRuntimeBootstrapSnapshot(event, namespace);
  await applyRuntimeKnowledgeUpdate(event, namespace);
  await applyRuntimeAnnotationDelete(event, namespace);
  await applyRuntimeAnnotationPostprocess(event, namespace);
}
const runtimeSyncHandler = createRuntimeSyncDevHandler({
  token: process.env.INKLOOP_RUNTIME_SYNC_TOKEN || '',
  requireSession: requireRuntimeSession,
  defaultSession: localRuntimeSession,
  store: new JsonlRuntimeSyncEventStore(process.env.INKLOOP_RUNTIME_SYNC_STORE || resolve(ROOT, '.inkloop/runtime-events.jsonl')),
  resolveSession: requireRuntimeSession ? resolveDeviceSession : undefined,
  onAcceptedEvent: applyRuntimeAcceptedEvent,
  allowOrigins: (process.env.INKLOOP_RUNTIME_SYNC_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  logger(entry) {
    console.info(`[runtime-sync:${entry.operation}] tenant=${entry.tenant_id || '-'} user=${entry.user_id || '-'} device=${entry.device_id || '-'} cursor=${entry.cursor || '-'} count=${entry.count} docs=${entry.doc_ids.join(',') || '-'} events=${entry.event_ids.join(',') || '-'} latency=${entry.latency_ms}ms`);
  },
});

const cloudLibraryHandler = createCloudLibraryHandler({
  store: cloudLibraryStore,
  resolveSession: resolveDeviceSession,
  requireSession: process.env.INKLOOP_LIBRARY_REQUIRE_SESSION === '1',
});
const cloudKnowledgeHandler = createCloudKnowledgeHandler({
  store: cloudKnowledgeStore,
  resolveSession: resolveDeviceSession,
  requireSession: process.env.INKLOOP_KNOWLEDGE_REQUIRE_SESSION === '1',
});
const cloudDeviceHandler = createCloudDeviceHandler({
  store: cloudDeviceStore,
  resolveSession: resolveDeviceSession,
  requireSession: process.env.INKLOOP_DEVICE_REQUIRE_SESSION === '1',
});

function isAuthorizedInternalLoopbackRequest(req: IncomingMessage): boolean {
  // 内部端点必须同时满足直连 loopback 和共享密钥；forwarded 头说明请求经过代理，一律按外部处理。
  const forwarded = req.headers.forwarded || req.headers['x-forwarded-for'];
  const remote = String(req.socket.remoteAddress || '');
  const isLoopback = !forwarded
    && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1');
  const actual = Buffer.from(String(req.headers['x-inkloop-secret'] || ''));
  const expected = Buffer.from(INKLOOP_SHARED_SECRET);
  return isLoopback && expected.length > 0
    && actual.length === expected.length
    && timingSafeEqual(actual, expected);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url || '/').split('?')[0];
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method === 'GET' && url === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: 'inkloop-cloud-hub',
      port: PORT,
      local_device_auth: LOCAL_DEVICE_AUTH,
      require_session: {
        library: process.env.INKLOOP_LIBRARY_REQUIRE_SESSION === '1',
        runtime_sync: process.env.INKLOOP_RUNTIME_SYNC_REQUIRE_SESSION === '1',
        knowledge: process.env.INKLOOP_KNOWLEDGE_REQUIRE_SESSION === '1',
        devices: process.env.INKLOOP_DEVICE_REQUIRE_SESSION === '1',
      },
      stores: {
        library: process.env.INKLOOP_LIBRARY_STORE || resolve(ROOT, '.inkloop/library'),
        runtime_sync: process.env.INKLOOP_RUNTIME_SYNC_STORE || resolve(ROOT, '.inkloop/runtime-events.jsonl'),
        knowledge: process.env.INKLOOP_KNOWLEDGE_STORE || resolve(ROOT, '.inkloop/knowledge'),
        devices: process.env.INKLOOP_DEVICE_STORE || resolve(ROOT, '.inkloop/devices'),
      },
    });
    return;
  }
  // 妙记 token 收编：panel meeting sidecar 从 hub 取 user_access_token（loopback + shared secret 双门）。
  // 背景：sidecar 原有独立 v1 OAuth token 库已死（refresh_token 被 hub 侧重授权顶掉·2026-07-15），
  // 妙记取数的 token 真相源收编到 hub 这份 v2 OAuth state（resolveUserOAuthToken 自带懒刷新）。
  if (url === '/api/internal/lark-user-token') {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    res.setHeader('cache-control', 'no-store');
    if (!isAuthorizedInternalLoopbackRequest(req)) { sendJson(res, 403, { ok: false, reason: 'forbidden' }); return; }
    // hub 的 lark auth state 按 `.inkloop/lark-auth/<tenant>/feishu_<open_id>/<device>.json` 分桶（见 sessionScopedLarkAuthPath）。
    // 带 open_id：取该用户最近登录设备的 state 走 resolveUserOAuthToken（自带懒刷新）；不带：枚举可用 open_id（不发 token）。
    const larkAuthRoot = resolve(ROOT, '.inkloop/lark-auth', LOCAL_AUTH_TENANT_ID);
    const openIdParam = new URL(req.url || '/', 'http://inkloop.local').searchParams.get('open_id')?.trim() || '';
    if (!openIdParam) {
      let openIds: string[] = [];
      try {
        openIds = readdirSync(larkAuthRoot)
          .filter((name) => name.startsWith('feishu_'))
          .map((name) => name.slice('feishu_'.length));
      } catch { /* 目录不存在 = 无人登录 */ }
      sendJson(res, 200, { ok: true, open_ids: openIds });
      return;
    }
    const statePath = latestLarkAuthStatePath(openIdParam);
    if (!statePath) { sendJson(res, 404, { ok: false, reason: 'oauth_not_logged_in' }); return; }
    const oauth = await resolveUserOAuthToken({ ...process.env, LARK_MEETING_AUTH_STATE_PATH: statePath });
    if (!oauth.usable || !oauth.token) {
      sendJson(res, 409, { ok: false, reason: oauth.reason || 'oauth_unusable', ...(oauth.refreshError ? { refresh_error: oauth.refreshError } : {}) });
      return;
    }
    sendJson(res, 200, { ok: true, access_token: oauth.token, open_ids: oauth.userOpenIds.length ? oauth.userOpenIds : [openIdParam], scopes: oauth.scopes });
    return;
  }
  if (url === '/api/internal/lark-note-transcript') {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    res.setHeader('cache-control', 'no-store');
    if (!isAuthorizedInternalLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, reason: 'forbidden' });
      return;
    }

    const query = new URL(req.url || '/', 'http://inkloop.local').searchParams;
    const meetingId = query.get('meeting_id')?.trim() || '';
    const openId = query.get('open_id')?.trim() || '';
    if (!meetingId || !openId || meetingId.length > 256 || openId.length > 256) {
      sendJson(res, 400, { ok: false, reason: 'meeting_id_and_open_id_required' });
      return;
    }

    const statePath = latestLarkAuthStatePath(openId);
    if (!statePath) {
      sendJson(res, 404, {
        ok: false,
        status: 'oauth_unavailable',
        meeting_id: meetingId,
        reason: 'oauth_not_logged_in',
      });
      return;
    }

    try {
      // 这里没有 device/session，只能从已解析的用户 statePath 叠加本机飞书应用配置。
      const env = feishuBotRuntimeEnv({
        ...process.env,
        LARK_MEETING_AUTH_STATE_PATH: statePath,
      });
      const result = await fetchLarkMeetingNoteTranscript(meetingId, { env });
      const transcript = result.transcript?.segments
        .map((segment) => `${segment.speaker}：${segment.text.replace(/\s*\n+\s*/g, ' ').trim()}`)
        .filter(Boolean)
        .join('\n') || '';
      // panel summarizer 只需逐行正文；禁止在内部 JSON 重复携带 raw/segments/srt/summary/artifacts。
      sendJson(res, 200, {
        ok: true,
        status: result.status,
        meeting_id: meetingId,
        topic: result.meeting?.topic || '',
        transcript_source: result.transcript?.source || null,
        transcript_ref: result.transcript?.document_id || null,
        transcript,
        content_length: transcript.length,
        errors: result.errors.map(({ source, code, message }) => ({ source, code, message })),
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        status: 'failed',
        meeting_id: meetingId,
        reason: 'note_transcript_failed',
        error: String((error as Error)?.message || error),
      });
    }
    return;
  }
  if (url.startsWith('/v1/runtime/')) {
    const handled = await runtimeSyncHandler(req, res);
    if (handled) return;
  }
  if (url.startsWith('/v1/library/')) {
    const handled = await cloudLibraryHandler(req, res);
    if (handled) return;
  }
  if (url.startsWith('/v1/knowledge/')) {
    const handled = await cloudKnowledgeHandler(req, res);
    if (handled) return;
  }
  if (url.startsWith('/v1/devices')) {
    const handled = await cloudDeviceHandler(req, res);
    if (handled) return;
  }
  // 阶段C：二维码设备登录（在 POST-only 闸之前·create/status/ack 都有 POST/GET 混合）
  if (url.startsWith('/api/inkloop/auth')) { await handleInkLoopAuth(req, res); return; }
  // Google Calendar OAuth + meeting sources；callback 由 Google 直连，其余子路由在 handler 内校验设备 session。
  if (url.startsWith('/api/google')) { await handleGoogleApi(req, res); return; }
  // MTL browser extension receiver uses a per-user secret path and includes GET /api/state.
  if (url.startsWith('/api/mtl/')) { await handleMtlReceiver(req, res); return; }
  // WS2-C：panel 飞书 GET 代理（在 POST-only 闸之前）
  if (url.startsWith('/api/panel-feishu')) { await handlePanelFeishu(req, res); return; }
  // 交付路线 Y：vault release GET/POST 代理（在 POST-only 闸之前·因含 GET latest/blob）
  if (url.startsWith('/api/panel-vault')) { await handlePanelVault(req, res); return; }
  // P0 安全止血：feishu-service / convert-service GET 代理（在 POST-only 闸之前）
  if (url.startsWith('/api/feishu-svc')) { await handleFeishuService(req, res); return; }
  if (url.startsWith('/api/convert')) { await handleConvertService(req, res); return; }
  if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }

  try {
    // intent A/B 影子收集：落 jsonl（非 LLM 调用；板上 production 也可发）。
    if (url === '/api/ab/intent') {
      const rec = JSON.parse(await readBody(req));
      try { appendFileSync(AB_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n'); }
      catch { /* 落盘失败不影响主链路 */ }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    // 流式：NDJSON 重排——边收模型分组边写回；x-accel-buffering 禁中间层缓冲。
    if (url === '/api/reflow-ai-stream') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-accel-buffering', 'no');
      for await (const group of reflowAiStream(body)) res.write(JSON.stringify(group) + '\n');
      res.end();
      return;
    }
    // 流式：text/plain 对话——逐段增量写回。
    if (url === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-accel-buffering', 'no');
      for await (const delta of chatStream(body)) res.write(String(delta));
      res.write(JSON.stringify({ k: 'done' }) + '\n'); // 完成哨兵（与 vite.config 同·防客户端把半截当成功）
      res.end();
      return;
    }
    // 一次性 JSON
    const fn = JSON_ROUTES[url];
    if (!fn) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: `no such route: ${url}` })); return; }
    const body = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await fn(body)));
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: msg })); }
    else { if (url === '/api/chat') { try { res.write(JSON.stringify({ k: 'e', d: msg }) + '\n'); } catch { /* 客户端已断 */ } } res.end(); } // chat 流已写出后出错：发 error 帧让客户端丢半截
  }
}

const server = createServer(handleRequest);

function positiveTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value ?? fallbackMs);
  return Number.isFinite(parsed) ? Math.max(1_000, parsed) : fallbackMs;
}

// WS end 事件可能丢（断线/重启窗口/同 app 多长连接抢路由），live 状态用 REST 周期对账兜底自愈。
const LARK_MEETING_RECONCILE_MS = Math.max(0, Number(process.env.INKLOOP_LARK_MEETING_RECONCILE_MS ?? 120_000));
const LARK_MEETING_RECONCILE_TIMEOUT_MS = positiveTimeoutMs(process.env.INKLOOP_LARK_MEETING_RECONCILE_TIMEOUT_MS, 60_000);
const larkMeetingReconcileGate = createDeadlineSingleFlight({
  timeoutMs: LARK_MEETING_RECONCILE_TIMEOUT_MS,
  label: 'Lark meeting reconcile',
});
async function runLarkMeetingReconcile(reason: string): Promise<void> {
  if (FEISHU_SERVICE_BASE) return;
  try {
    await larkMeetingReconcileGate.run(async (signal) => {
      const result = await reconcileLarkLiveMeetings({
        root: ROOT,
        baseUrl: process.env.LARK_BASE_URL || process.env.FEISHU_BASE_URL || undefined,
        signal,
        resolveUserToken: async (openId) => {
          const statePath = latestLarkAuthStatePath(openId);
          if (!statePath) return '';
          const oauth = await resolveUserOAuthToken(
            { ...process.env, LARK_MEETING_AUTH_STATE_PATH: statePath },
            Date.now(),
            { signal },
          );
          return oauth.usable && oauth.token ? oauth.token : '';
        },
        logger: (event, details) => console.log(`[inkloop proxy] ${event}`, JSON.stringify(details)),
      });
      if (result.checked > 0 || result.errors.length > 0) {
        console.log(`[inkloop proxy] lark meeting reconcile reason=${reason} checked=${result.checked} ended=${result.ended} still_live=${result.still_live} skipped=${result.skipped}${result.errors.length ? ` errors=${result.errors.join('; ')}` : ''}`);
      }
    });
  } catch (e) {
    console.warn(`[inkloop proxy] lark meeting reconcile failed reason=${reason}: ${String((e as Error)?.message || e)}`);
  }
}

// Gemini 智能纪要在会议结束后几分钟才导出成 Doc，设备端请求不是可靠触发源（recap 可能一直开着或没开）。
// hub 侧周期扫全部已连接用户的 meet-records，窗口内的空壳纪要主动回补。
const GOOGLE_SMART_NOTE_BACKFILL_MS = Math.max(0, Number(process.env.INKLOOP_GOOGLE_SMART_NOTE_BACKFILL_MS ?? 120_000));
const GOOGLE_SMART_NOTE_BACKFILL_TIMEOUT_MS = positiveTimeoutMs(process.env.INKLOOP_GOOGLE_SMART_NOTE_BACKFILL_TIMEOUT_MS, 60_000);
const googleBackfillGate = createDeadlineSingleFlight({
  timeoutMs: GOOGLE_SMART_NOTE_BACKFILL_TIMEOUT_MS,
  label: 'Google meeting backfill',
});
async function runGoogleSmartNoteBackfill(reason: string): Promise<void> {
  try {
    await googleBackfillGate.run(async (signal) => {
      const fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal });
      const root = googleAuthRoot(process.env);
      let identities: Array<{ tenantId: string; userId: string }> = [];
      try {
        identities = readdirSync(root, { withFileTypes: true })
          .filter((tenant) => tenant.isDirectory())
          .flatMap((tenant) => readdirSync(resolve(root, tenant.name), { withFileTypes: true })
            .filter((user) => user.isDirectory())
            .map((user) => ({ tenantId: tenant.name, userId: user.name })));
      } catch { /* 目录不存在 = 无人连接 Google */ }
      for (const identity of identities) {
        if (signal.aborted) throw signal.reason;
        const recordsPath = googleMeetRecordsPath(process.env, identity);
        if (!existsSync(recordsPath)) continue;
        const resolved = await resolveAnyUserGoogleToken(process.env, identity, Date.now(), { fetchImpl });
        if (!resolved.usable || !resolved.token) continue;
        const result = await backfillGoogleMeetSmartNotes(resolved.token, { path: recordsPath }, {
          grantedScopes: resolved.scopes,
          fetchImpl,
        });
        if (result.scanned > 0 || result.errors.length > 0) {
          console.log(`[inkloop proxy] google smart-note backfill reason=${reason} user=${identity.userId} scanned=${result.scanned} backfilled=${result.backfilled} completed=${result.completed}${result.errors.length ? ` errors=${result.errors.join('; ')}` : ''}`);
        }
      }
    });
  } catch (e) {
    console.warn(`[inkloop proxy] google smart-note backfill failed reason=${reason}: ${String((e as Error)?.message || e)}`);
  }
}

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`[inkloop proxy] :${PORT}  model=${process.env.LLM_MODEL || 'kimi-k2.6'}  key=${process.env.LLM_GATEWAY_KEY ? 'set' : 'MISSING'}`);
  const wsStatus = startLarkWsMeetingEvents(ROOT, feishuBotRuntimeEnv(process.env));
  console.log(`[inkloop proxy] Lark meeting WS ${wsStatus.enabled ? wsStatus.state : 'disabled'} events=${wsStatus.registered_event_types.length}`);
  if (LARK_MEETING_RECONCILE_MS > 0 && !FEISHU_SERVICE_BASE) {
    setInterval(() => { void runLarkMeetingReconcile('interval'); }, LARK_MEETING_RECONCILE_MS).unref();
    // 启动即对账一次（延迟给 WS 建连留窗口），把重启窗口/历史丢事件卡住的 live 清掉。
    setTimeout(() => { void runLarkMeetingReconcile('boot'); }, 15_000).unref();
  }
  if (GOOGLE_SMART_NOTE_BACKFILL_MS > 0) {
    setInterval(() => { void runGoogleSmartNoteBackfill('interval'); }, GOOGLE_SMART_NOTE_BACKFILL_MS).unref();
    setTimeout(() => { void runGoogleSmartNoteBackfill('boot'); }, 20_000).unref();
  }
});

const LARK_MEETING_CALLBACK_SERVER_PORT = Number(LARK_MEETING_CALLBACK_PORT);
if (Number.isFinite(LARK_MEETING_CALLBACK_SERVER_PORT) && LARK_MEETING_CALLBACK_SERVER_PORT > 0 && LARK_MEETING_CALLBACK_SERVER_PORT !== PORT) {
  const larkCallbackBridge = createServer((req, res) => {
    const originalUrl = req.url || '/';
    if (originalUrl.startsWith(LARK_MEETING_CALLBACK_PATH)) {
      req.url = `/api/feishu-svc/api/feishu/oauth/callback${originalUrl.slice(LARK_MEETING_CALLBACK_PATH.length)}`;
      handleRequest(req, res);
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not_found', expected_path: LARK_MEETING_CALLBACK_PATH }));
  });
  larkCallbackBridge.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`[inkloop proxy] Lark OAuth callback bridge :${LARK_MEETING_CALLBACK_SERVER_PORT} already in use; WebView interception still works.`);
      return;
    }
    console.warn(`[inkloop proxy] Lark OAuth callback bridge disabled: ${String(error.message || error)}`);
  });
  larkCallbackBridge.listen(LARK_MEETING_CALLBACK_SERVER_PORT, () => {
    console.log(`[inkloop proxy] Lark OAuth callback bridge :${LARK_MEETING_CALLBACK_SERVER_PORT}${LARK_MEETING_CALLBACK_PATH}`);
  });
}

const HTTPS_PORT = Number(process.env.INKLOOP_HTTPS_PORT || 0);
const HTTPS_KEY_PATH = String(process.env.INKLOOP_HTTPS_KEY_PATH || '').trim();
const HTTPS_CERT_PATH = String(process.env.INKLOOP_HTTPS_CERT_PATH || '').trim();
if (HTTPS_PORT > 0 && HTTPS_KEY_PATH && HTTPS_CERT_PATH) {
  try {
    const httpsServer = createHttpsServer({
      key: readFileSync(HTTPS_KEY_PATH),
      cert: readFileSync(HTTPS_CERT_PATH),
    }, handleRequest);
    httpsServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`[inkloop proxy] HTTPS :${HTTPS_PORT} already in use; HTTP endpoint remains active.`);
        return;
      }
      console.warn(`[inkloop proxy] HTTPS disabled: ${String(error.message || error)}`);
    });
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`[inkloop proxy] https :${HTTPS_PORT}  cert=${HTTPS_CERT_PATH}`);
    });
  } catch (error) {
    console.warn(`[inkloop proxy] HTTPS disabled: ${String((error as Error)?.message || error)}`);
  }
}
