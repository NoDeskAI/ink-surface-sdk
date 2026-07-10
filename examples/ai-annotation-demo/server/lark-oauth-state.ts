import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLarkClient } from '../Lark-Meeting-Timeline-main/src/larkClient.mjs';

const DEFAULT_AUTH_STATE_PATHS = [
  resolve(dirname(fileURLToPath(import.meta.url)), '../Lark-Meeting-Timeline-main/data/lark-auth.json'),
  resolve(dirname(fileURLToPath(import.meta.url)), '../Lark-Meeting-Timeline-main/data/auth-state.json'),
];

export interface LarkOAuthEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
  LARK_MEETING_AUTH_STATE_PATH?: string;
}

export interface LarkUserOAuthState {
  token?: string;
  scopes: string[];
  userOpenIds: string[];
  usable: boolean;
  reason?: string;
  path: string;
  refreshed: boolean;
  refreshTokenPresent: boolean;
  refreshExpired: boolean;
  refreshError?: string;
}

interface RefreshCapableClient {
  refreshOAuthToken?: (refreshToken: string) => Promise<Record<string, unknown>>;
}

interface LarkOAuthClient extends RefreshCapableClient {
  createAuthorizeUrl?: (state: string, opts?: Record<string, unknown>) => string;
  exchangeOAuthCode?: (code: string) => Promise<Record<string, unknown>>;
  fetchUserInfo?: (userAccessToken: string) => Promise<unknown>;
}

interface LarkAuthStateHistoryEntry {
  state: string;
  created_at_ms?: number;
  created_at?: string;
}

interface LarkAuthStateFile {
  oauth_state?: string | null;
  oauth_state_history?: LarkAuthStateHistoryEntry[];
  token?: Record<string, unknown> | null;
  user?: unknown | null;
  updated_at?: string | null;
}

export interface LarkOAuthPublicStatus {
  authenticated: boolean;
  connected: boolean;
  configured: boolean;
  auth_mode: 'shared_user_oauth';
  data_isolation: 'inkloop_session_namespace';
  token_present: boolean;
  token_path: string;
  user_open_ids: string[];
  scopes: string[];
  required_scopes: string[];
  missing_scopes: string[];
  refresh_token_present: boolean;
  refresh_expired: boolean;
  refreshed: boolean;
  reason?: string;
  refresh_error?: string;
  permission_url?: string;
}

export interface LarkOAuthLoginPayload {
  auth_url: string;
  state: string;
  redirect_uri: string;
  scope: string;
  auth_state_path: string;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_HISTORY_LIMIT = 12;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function tokenScopeList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function authStatePaths(env: LarkOAuthEnv): string[] {
  const configured = String(env.LARK_MEETING_AUTH_STATE_PATH || '').trim();
  return configured ? [resolve(configured)] : DEFAULT_AUTH_STATE_PATHS;
}

export function larkOAuthAuthStatePath(env: LarkOAuthEnv): string {
  const candidates = authStatePaths(env);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function appConfig(env: LarkOAuthEnv): { appId: string; appSecret: string; baseUrl?: string } | null {
  const appId = String(env.LARK_APP_ID || env.FEISHU_APP_ID || '').trim();
  const appSecret = String(env.LARK_APP_SECRET || env.FEISHU_APP_SECRET || '').trim();
  const baseUrl = String(env.LARK_BASE_URL || env.FEISHU_BASE_URL || '').trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret, ...(baseUrl ? { baseUrl } : {}) };
}

function userOpenIdCandidates(parsed: Record<string, unknown>): string[] {
  const user = obj(parsed.user);
  const data = obj(user.data);
  return [data.open_id, user.open_id]
    .map(text)
    .filter((value, index, values): value is string => !!value && values.indexOf(value) === index);
}

function expiryMs(tokenState: Record<string, unknown>, field: 'expires_in' | 'refresh_expires_in'): number {
  const obtainedAtMs = Number(tokenState.obtained_at_ms);
  const expiresIn = Number(tokenState[field]);
  return Number.isFinite(obtainedAtMs) && Number.isFinite(expiresIn) && expiresIn > 0
    ? obtainedAtMs + expiresIn * 1000
    : 0;
}

function missing(path: string, reason: string): LarkUserOAuthState {
  return { usable: false, scopes: [], userOpenIds: [], reason, path, refreshed: false, refreshTokenPresent: false, refreshExpired: false };
}

function permissionUrl(env: LarkOAuthEnv, missingScopes: string[]): string | undefined {
  const appId = String(env.LARK_APP_ID || env.FEISHU_APP_ID || '').trim();
  if (!appId || !missingScopes.length) return undefined;
  return `https://open.feishu.cn/app/${encodeURIComponent(appId)}/auth?q=${encodeURIComponent(missingScopes.join(' '))}&op_from=openapi&token_type=user`;
}

function loadAuthState(env: LarkOAuthEnv): LarkAuthStateFile {
  const path = larkOAuthAuthStatePath(env);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LarkAuthStateFile;
    return {
      oauth_state: null,
      token: null,
      user: null,
      updated_at: null,
      ...parsed,
      oauth_state_history: pruneOAuthStateHistory(parsed.oauth_state_history || []),
    };
  } catch {
    return { oauth_state: null, oauth_state_history: [], token: null, user: null, updated_at: null };
  }
}

function saveAuthState(env: LarkOAuthEnv, next: LarkAuthStateFile): LarkAuthStateFile {
  const path = larkOAuthAuthStatePath(env);
  const state: LarkAuthStateFile = {
    oauth_state: null,
    token: null,
    user: null,
    ...next,
    oauth_state_history: pruneOAuthStateHistory(next.oauth_state_history || []),
    updated_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}

function oauthStateCreatedAtMs(entry: LarkAuthStateHistoryEntry): number | null {
  const fromMs = Number(entry.created_at_ms);
  if (Number.isFinite(fromMs)) return fromMs;
  const parsed = Date.parse(String(entry.created_at || ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function pruneOAuthStateHistory(history: Array<LarkAuthStateHistoryEntry | string>, nowMs = Date.now()): LarkAuthStateHistoryEntry[] {
  const seen = new Set<string>();
  return (Array.isArray(history) ? history : [])
    .map((entry) => {
      if (typeof entry === 'string') return { state: entry, created_at_ms: nowMs, created_at: new Date(nowMs).toISOString() };
      const createdAtMs = oauthStateCreatedAtMs(entry) ?? nowMs;
      return {
        state: String(entry.state || ''),
        created_at_ms: createdAtMs,
        created_at: entry.created_at || new Date(createdAtMs).toISOString(),
      };
    })
    .filter((entry) => {
      if (!entry.state || seen.has(entry.state)) return false;
      if (nowMs - Number(entry.created_at_ms || 0) > OAUTH_STATE_TTL_MS) return false;
      seen.add(entry.state);
      return true;
    })
    .sort((left, right) => Number(right.created_at_ms || 0) - Number(left.created_at_ms || 0))
    .slice(0, OAUTH_STATE_HISTORY_LIMIT);
}

function rememberOAuthState(env: LarkOAuthEnv, state: string, nowMs = Date.now()): void {
  const current = loadAuthState(env);
  const history = pruneOAuthStateHistory([
    { state, created_at_ms: nowMs, created_at: new Date(nowMs).toISOString() },
    ...(current.oauth_state ? [{ state: current.oauth_state, created_at: current.updated_at || new Date(nowMs).toISOString() }] : []),
    ...(current.oauth_state_history || []),
  ], nowMs);
  saveAuthState(env, { ...current, oauth_state: state, oauth_state_history: history });
}

function oauthStateMatches(env: LarkOAuthEnv, receivedState: string | null | undefined, nowMs = Date.now()): boolean {
  if (!receivedState) return false;
  const current = loadAuthState(env);
  const expected = [
    current.oauth_state ? { state: current.oauth_state, created_at: current.updated_at || undefined } : null,
    ...(current.oauth_state_history || []),
  ].filter(Boolean) as LarkAuthStateHistoryEntry[];
  return pruneOAuthStateHistory(expected, nowMs).some((entry) => entry.state === receivedState);
}

function configuredClient(env: LarkOAuthEnv, overrides: Record<string, unknown> = {}, createClient?: (env: Record<string, unknown>) => unknown): LarkOAuthClient {
  const config = appConfig(env);
  if (!config) throw new Error('lark_oauth_app_not_configured');
  return (createClient || createLarkClient)({
    ...process.env,
    ...env,
    LARK_APP_ID: config.appId,
    LARK_APP_SECRET: config.appSecret,
    ...(config.baseUrl ? { LARK_BASE_URL: config.baseUrl } : {}),
    ...overrides,
  }) as LarkOAuthClient;
}

export async function resolveLarkOAuthPublicStatus(env: LarkOAuthEnv, requiredScopeValue = '', nowMs = Date.now(), options: {
  createClient?: (env: Record<string, unknown>) => unknown;
} = {}): Promise<LarkOAuthPublicStatus> {
  const configured = !!appConfig(env);
  const userOAuth = await resolveUserOAuthToken(env, nowMs, options);
  const requiredScopes = tokenScopeList(requiredScopeValue);
  const granted = new Set(userOAuth.scopes);
  const missingScopes = requiredScopes.filter((scope) => !granted.has(scope));
  const connected = configured && userOAuth.usable && missingScopes.length === 0;
  return {
    authenticated: userOAuth.usable,
    connected,
    configured,
    auth_mode: 'shared_user_oauth',
    data_isolation: 'inkloop_session_namespace',
    token_present: !!userOAuth.token,
    token_path: userOAuth.path,
    user_open_ids: userOAuth.userOpenIds,
    scopes: userOAuth.scopes,
    required_scopes: requiredScopes,
    missing_scopes: missingScopes,
    refresh_token_present: userOAuth.refreshTokenPresent,
    refresh_expired: userOAuth.refreshExpired,
    refreshed: userOAuth.refreshed,
    ...(connected ? {} : { reason: !configured ? 'lark_oauth_app_not_configured' : userOAuth.reason || (missingScopes.length ? 'missing_oauth_scope' : 'oauth_unavailable') }),
    ...(userOAuth.refreshError ? { refresh_error: userOAuth.refreshError } : {}),
    ...(permissionUrl(env, missingScopes) ? { permission_url: permissionUrl(env, missingScopes) } : {}),
  };
}

export function beginLarkOAuthLogin(env: LarkOAuthEnv, input: {
  redirectUri: string;
  scope: string;
  state?: string;
  nowMs?: number;
  createClient?: (env: Record<string, unknown>) => unknown;
}): LarkOAuthLoginPayload {
  const state = input.state || randomBytes(16).toString('hex');
  const scope = tokenScopeList(input.scope).join(' ');
  rememberOAuthState(env, state, input.nowMs || Date.now());
  const client = configuredClient(env, {
    LARK_REDIRECT_URI: input.redirectUri,
    LARK_OAUTH_SCOPES: scope,
  }, input.createClient);
  if (!client.createAuthorizeUrl) throw new Error('lark_oauth_authorize_unsupported');
  return {
    auth_url: client.createAuthorizeUrl(state, { scope, ignoreDefaultScopes: true }),
    state,
    redirect_uri: input.redirectUri,
    scope,
    auth_state_path: larkOAuthAuthStatePath(env),
  };
}

export async function completeLarkOAuthCallback(env: LarkOAuthEnv, input: {
  code: string;
  state?: string | null;
  redirectUri: string;
  nowMs?: number;
  createClient?: (env: Record<string, unknown>) => unknown;
}): Promise<{ user?: unknown; status: LarkOAuthPublicStatus }> {
  const nowMs = input.nowMs || Date.now();
  if (!input.code) throw Object.assign(new Error('oauth_code_missing'), { status: 400 });
  if (!oauthStateMatches(env, input.state, nowMs)) throw Object.assign(new Error('oauth_state_mismatch'), { status: 400 });
  const client = configuredClient(env, { LARK_REDIRECT_URI: input.redirectUri }, input.createClient);
  if (!client.exchangeOAuthCode) throw new Error('lark_oauth_exchange_unsupported');
  const token = await client.exchangeOAuthCode(input.code);
  const accessToken = text(token.access_token) || text(token.user_access_token);
  if (!accessToken) throw new Error('oauth_token_missing');
  const tokenWithTime = { ...token, access_token: accessToken, obtained_at_ms: nowMs };
  let user: unknown = null;
  try {
    user = client.fetchUserInfo ? await client.fetchUserInfo(accessToken) : null;
  } catch (error) {
    user = { error: String((error as Error)?.message || error) };
  }
  saveAuthState(env, { oauth_state: null, oauth_state_history: [], token: tokenWithTime, user });
  return { user, status: await resolveLarkOAuthPublicStatus(env, String(token.scope || ''), nowMs, { createClient: input.createClient }) };
}

export async function resolveUserOAuthToken(env: LarkOAuthEnv, nowMs = Date.now(), options: {
  createClient?: (env: Record<string, unknown>) => unknown;
} = {}): Promise<LarkUserOAuthState> {
  const candidates = authStatePaths(env);
  const path = candidates.find((candidate) => existsSync(candidate)) || candidates[0];
  if (!existsSync(path)) return missing(path, 'oauth_not_logged_in');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return missing(path, `oauth_state_unreadable:${String((e as Error)?.message || e)}`);
  }

  const tokenState = obj(parsed.token);
  const token = text(tokenState.access_token);
  const refreshToken = text(tokenState.refresh_token);
  const scopes = tokenScopeList(tokenState.scope);
  const userOpenIds = userOpenIdCandidates(parsed);
  const refreshExpiresAtMs = expiryMs(tokenState, 'refresh_expires_in');
  const refreshExpired = refreshExpiresAtMs > 0 && nowMs >= refreshExpiresAtMs;
  const base = {
    scopes,
    userOpenIds,
    path,
    refreshed: false,
    refreshTokenPresent: !!refreshToken,
    refreshExpired,
  };

  if (!token) return { ...base, usable: false, reason: 'oauth_token_missing' };
  const expiresAtMs = expiryMs(tokenState, 'expires_in');
  if (!expiresAtMs || nowMs < expiresAtMs) return { ...base, token, usable: true };
  if (!refreshToken) return { ...base, usable: false, reason: 'oauth_token_expired' };
  if (refreshExpired) return { ...base, usable: false, reason: 'oauth_refresh_token_expired' };

  const config = appConfig(env);
  if (!config) return { ...base, usable: false, reason: 'oauth_refresh_not_configured' };

  try {
    const client = (options.createClient || createLarkClient)({
      ...process.env,
      ...env,
      LARK_APP_ID: config.appId,
      LARK_APP_SECRET: config.appSecret,
      ...(config.baseUrl ? { LARK_BASE_URL: config.baseUrl } : {}),
    }) as RefreshCapableClient;
    if (!client.refreshOAuthToken) return { ...base, usable: false, reason: 'oauth_refresh_unsupported' };
    const refreshed = await client.refreshOAuthToken(refreshToken);
    const refreshedState = obj(refreshed);
    const refreshedToken = text(refreshedState.access_token) || text(refreshedState.user_access_token);
    if (!refreshedToken) return { ...base, usable: false, reason: 'oauth_refresh_failed', refreshError: 'missing refreshed access_token' };
    const nextState = {
      ...parsed,
      token: {
        ...refreshedState,
        access_token: refreshedToken,
        obtained_at_ms: nowMs,
      },
      updated_at: new Date(nowMs).toISOString(),
    };
    writeFileSync(path, JSON.stringify(nextState, null, 2));
    return {
      token: refreshedToken,
      scopes: tokenScopeList(refreshedState.scope ?? tokenState.scope),
      userOpenIds,
      usable: true,
      path,
      refreshed: true,
      refreshTokenPresent: !!text(refreshed.refresh_token) || !!refreshToken,
      refreshExpired: false,
    };
  } catch (e) {
    return { ...base, usable: false, reason: 'oauth_refresh_failed', refreshError: String((e as Error)?.message || e) };
  }
}
