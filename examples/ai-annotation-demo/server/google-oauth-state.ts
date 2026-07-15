import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_GOOGLE_AUTH_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../.inkloop/google-auth');
const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
] as const;

export interface GoogleOAuthEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_AUTH_ROOT?: string;
  GOOGLE_OAUTH_PENDING_STORE?: string;
  GOOGLE_OAUTH_PENDING_TTL_MS?: string;
}

export interface GoogleOAuthIdentity {
  tenantId: string;
  userId: string;
  deviceId: string;
}

interface GoogleTokenState {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  obtained_at_ms?: number;
  expires_at_ms?: number;
  reauth_required?: boolean;
  refresh_error?: string;
  updated_at?: string;
}

export interface GoogleUserTokenResolution {
  usable: boolean;
  token?: string;
  scopes: string[];
  expiry?: string;
  expiresAtMs?: number;
  refreshTokenPresent: boolean;
  refreshed: boolean;
  reauthRequired: boolean;
  reason?: string;
  refreshError?: string;
  path: string;
}

export interface GoogleOAuthStatus {
  connected: boolean;
  configured: boolean;
  scopes: string[];
  required_scopes: string[];
  missing_scopes: string[];
  expiry?: string;
  refresh_token_present: boolean;
  reauth_required: boolean;
  refreshed: boolean;
  reason?: string;
}

export interface GooglePendingOAuthEntry {
  state: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'complete' | 'failed';
  completed_at?: number;
  error?: string;
}

interface GooglePendingOAuthStore {
  schema_version: 'inkloop.google_oauth_pending.v1';
  states: Record<string, GooglePendingOAuthEntry>;
}

export interface GoogleDeviceOAuthCompletion {
  status: 'idle' | 'pending' | 'complete' | 'failed';
  connected: boolean;
  expires_at?: number;
  completed_at?: number;
  error?: string;
}

export interface GoogleOAuthFetchOptions {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  forceRefresh?: boolean;
}

class GoogleOAuthError extends Error {
  status: number;
  code: string;

  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'GoogleOAuthError';
    this.status = status;
    this.code = code;
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safePathPart(value: string, fallback: string): string {
  const normalized = clean(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '');
  return normalized || fallback;
}

function authRoot(env: GoogleOAuthEnv): string {
  return resolve(clean(env.GOOGLE_AUTH_ROOT) || DEFAULT_GOOGLE_AUTH_ROOT);
}

function pendingStorePath(env: GoogleOAuthEnv): string {
  return resolve(clean(env.GOOGLE_OAUTH_PENDING_STORE) || resolve(authRoot(env), 'pending-device-oauth.json'));
}

function pendingTtlMs(env: GoogleOAuthEnv): number {
  const configured = Number(env.GOOGLE_OAUTH_PENDING_TTL_MS);
  return Number.isFinite(configured) && configured >= 1_000 ? configured : DEFAULT_PENDING_TTL_MS;
}

function tokenScopes(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function googleConfig(env: GoogleOAuthEnv): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = clean(env.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = clean(env.GOOGLE_OAUTH_CLIENT_SECRET);
  const redirectUri = clean(env.GOOGLE_OAUTH_REDIRECT_URI);
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
}

function requireGoogleConfig(env: GoogleOAuthEnv): { clientId: string; clientSecret: string; redirectUri: string } {
  const config = googleConfig(env);
  if (!config) throw new GoogleOAuthError('google_oauth_disabled', 503, 'Google OAuth is not configured');
  return config;
}

export function googleOAuthTokenPath(env: GoogleOAuthEnv, identity: GoogleOAuthIdentity): string {
  return resolve(
    authRoot(env),
    safePathPart(identity.tenantId, 'tenant'),
    safePathPart(identity.userId, 'user'),
    `${safePathPart(identity.deviceId, 'device')}.json`,
  );
}

export function googleCalendarSyncPath(env: GoogleOAuthEnv, identity: Pick<GoogleOAuthIdentity, 'tenantId' | 'userId'>): string {
  return resolve(
    authRoot(env),
    safePathPart(identity.tenantId, 'tenant'),
    safePathPart(identity.userId, 'user'),
    'calendar-sync.json',
  );
}

export function googleMeetRecordsPath(env: GoogleOAuthEnv, identity: Pick<GoogleOAuthIdentity, 'tenantId' | 'userId'>): string {
  return resolve(
    authRoot(env),
    safePathPart(identity.tenantId, 'tenant'),
    safePathPart(identity.userId, 'user'),
    'meet-records.json',
  );
}

export function buildAuthorizeUrl(env: GoogleOAuthEnv, state: string): string {
  const config = requireGoogleConfig(env);
  if (!clean(state)) throw new GoogleOAuthError('google_oauth_state_missing', 400);
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(
  params: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    throw new GoogleOAuthError('google_oauth_invalid_response', 502);
  }
  if (!response.ok) {
    const detail = clean(body.error_description) || clean(body.error) || `HTTP ${response.status}`;
    throw new GoogleOAuthError('google_oauth_token_request_failed', response.status >= 500 ? 502 : 401, detail);
  }
  if (!clean(body.access_token)) throw new GoogleOAuthError('google_oauth_access_token_missing', 502);
  return body;
}

export async function exchangeCode(
  env: GoogleOAuthEnv,
  code: string,
  options: Pick<GoogleOAuthFetchOptions, 'fetchImpl'> = {},
): Promise<Record<string, unknown>> {
  const config = requireGoogleConfig(env);
  if (!clean(code)) throw new GoogleOAuthError('google_oauth_code_missing', 400);
  return tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  }), options.fetchImpl || fetch);
}

function readTokenState(path: string): GoogleTokenState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GoogleTokenState;
  } catch {
    return null;
  }
}

function writeTokenState(path: string, state: GoogleTokenState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

function readPendingStore(env: GoogleOAuthEnv, nowMs = Date.now()): GooglePendingOAuthStore {
  try {
    const parsed = JSON.parse(readFileSync(pendingStorePath(env), 'utf8')) as Partial<GooglePendingOAuthStore>;
    const entries = parsed.states && typeof parsed.states === 'object' ? parsed.states : {};
    return {
      schema_version: 'inkloop.google_oauth_pending.v1',
      states: Object.fromEntries(Object.entries(entries).filter(([, entry]) => Number(entry.expires_at) > nowMs)),
    };
  } catch {
    return { schema_version: 'inkloop.google_oauth_pending.v1', states: {} };
  }
}

function writePendingStore(env: GoogleOAuthEnv, store: GooglePendingOAuthStore): void {
  const path = pendingStorePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
}

function sameIdentity(entry: GooglePendingOAuthEntry, identity: GoogleOAuthIdentity): boolean {
  return entry.tenant_id === identity.tenantId
    && entry.user_id === identity.userId
    && entry.device_id === identity.deviceId;
}

export function beginGoogleDeviceOAuth(
  env: GoogleOAuthEnv,
  identity: GoogleOAuthIdentity,
  options: { state?: string; nowMs?: number } = {},
): { auth_url: string; state: string; expires_at: number; scopes: string[] } {
  requireGoogleConfig(env);
  const nowMs = options.nowMs ?? Date.now();
  const state = clean(options.state) || randomBytes(24).toString('hex');
  const store = readPendingStore(env, nowMs);
  const expiresAt = nowMs + pendingTtlMs(env);
  store.states[state] = {
    state,
    tenant_id: identity.tenantId,
    user_id: identity.userId,
    device_id: identity.deviceId,
    created_at: nowMs,
    expires_at: expiresAt,
    status: 'pending',
  };
  writePendingStore(env, store);
  return { auth_url: buildAuthorizeUrl(env, state), state, expires_at: expiresAt, scopes: [...GOOGLE_OAUTH_SCOPES] };
}

export async function completeGoogleOAuthCallback(
  env: GoogleOAuthEnv,
  input: { code: string; state: string },
  options: GoogleOAuthFetchOptions = {},
): Promise<{ identity: GoogleOAuthIdentity; status: GoogleOAuthStatus }> {
  const nowMs = options.nowMs ?? Date.now();
  const store = readPendingStore(env, nowMs);
  const pending = store.states[clean(input.state)];
  if (!pending || pending.status !== 'pending') throw new GoogleOAuthError('google_oauth_state_invalid_or_expired', 400);
  const identity = { tenantId: pending.tenant_id, userId: pending.user_id, deviceId: pending.device_id };
  try {
    const token = await exchangeCode(env, input.code, options);
    const expiresIn = Number(token.expires_in);
    const path = googleOAuthTokenPath(env, identity);
    const previous = readTokenState(path);
    const state: GoogleTokenState = {
      ...token,
      access_token: clean(token.access_token),
      refresh_token: clean(token.refresh_token) || previous?.refresh_token,
      scope: clean(token.scope) || GOOGLE_OAUTH_SCOPES.join(' '),
      obtained_at_ms: nowMs,
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_in: expiresIn, expires_at_ms: nowMs + expiresIn * 1000 } : {}),
      reauth_required: false,
      updated_at: new Date(nowMs).toISOString(),
    };
    delete state.refresh_error;
    writeTokenState(path, state);
    pending.status = 'complete';
    pending.completed_at = nowMs;
    delete pending.error;
    store.states[pending.state] = pending;
    writePendingStore(env, store);
    return { identity, status: await resolveGoogleOAuthStatus(env, identity, nowMs, options) };
  } catch (error) {
    pending.status = 'failed';
    pending.error = error instanceof GoogleOAuthError ? error.code : 'google_oauth_callback_failed';
    store.states[pending.state] = pending;
    writePendingStore(env, store);
    throw error;
  }
}

export function googleDeviceOAuthCompletion(
  env: GoogleOAuthEnv,
  identity: GoogleOAuthIdentity,
  nowMs = Date.now(),
): GoogleDeviceOAuthCompletion {
  const store = readPendingStore(env, nowMs);
  const latest = Object.values(store.states)
    .filter((entry) => sameIdentity(entry, identity))
    .sort((left, right) => right.created_at - left.created_at)[0];
  if (!latest) return { status: 'idle', connected: false };
  return {
    status: latest.status,
    connected: latest.status === 'complete',
    expires_at: latest.expires_at,
    ...(latest.completed_at ? { completed_at: latest.completed_at } : {}),
    ...(latest.error ? { error: latest.error } : {}),
  };
}

export async function resolveUserGoogleToken(
  env: GoogleOAuthEnv,
  identity: GoogleOAuthIdentity,
  nowMs = Date.now(),
  options: GoogleOAuthFetchOptions = {},
): Promise<GoogleUserTokenResolution> {
  const path = googleOAuthTokenPath(env, identity);
  const state = readTokenState(path);
  const missing = (reason: string): GoogleUserTokenResolution => ({
    usable: false,
    scopes: [],
    refreshTokenPresent: false,
    refreshed: false,
    reauthRequired: reason === 'reauth_required',
    reason,
    path,
  });
  if (!state) return missing('google_oauth_not_connected');
  const accessToken = clean(state.access_token);
  const refreshToken = clean(state.refresh_token);
  const scopes = tokenScopes(state.scope);
  const expiresAtMs = Number(state.expires_at_ms)
    || (Number(state.obtained_at_ms) + Number(state.expires_in) * 1000);
  const base = {
    scopes,
    expiry: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? new Date(expiresAtMs).toISOString() : undefined,
    expiresAtMs: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : undefined,
    refreshTokenPresent: !!refreshToken,
    refreshed: false,
    reauthRequired: !!state.reauth_required,
    path,
  };
  if (state.reauth_required) return { ...base, usable: false, reason: 'reauth_required', refreshError: state.refresh_error };
  if (!accessToken) return { ...base, usable: false, reason: 'google_oauth_access_token_missing' };
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs > 0 && nowMs >= expiresAtMs;
  if (!expired && !options.forceRefresh) return { ...base, token: accessToken, usable: true };
  if (!refreshToken) {
    writeTokenState(path, {
      ...state,
      reauth_required: true,
      refresh_error: 'refresh_token_missing',
      updated_at: new Date(nowMs).toISOString(),
    });
    return { ...base, usable: false, reauthRequired: true, reason: 'reauth_required', refreshError: 'refresh_token_missing' };
  }

  let config: { clientId: string; clientSecret: string; redirectUri: string };
  try {
    config = requireGoogleConfig(env);
  } catch {
    return { ...base, usable: false, reason: 'google_oauth_refresh_not_configured' };
  }
  try {
    const refreshed = await tokenRequest(new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }), options.fetchImpl || fetch);
    const expiresIn = Number(refreshed.expires_in);
    const next: GoogleTokenState = {
      ...state,
      ...refreshed,
      access_token: clean(refreshed.access_token),
      refresh_token: clean(refreshed.refresh_token) || refreshToken,
      scope: clean(refreshed.scope) || state.scope || GOOGLE_OAUTH_SCOPES.join(' '),
      obtained_at_ms: nowMs,
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_in: expiresIn, expires_at_ms: nowMs + expiresIn * 1000 } : {}),
      reauth_required: false,
      updated_at: new Date(nowMs).toISOString(),
    };
    delete next.refresh_error;
    writeTokenState(path, next);
    const nextExpiresAtMs = Number(next.expires_at_ms) || undefined;
    return {
      usable: true,
      token: clean(next.access_token),
      scopes: tokenScopes(next.scope),
      ...(nextExpiresAtMs ? { expiry: new Date(nextExpiresAtMs).toISOString(), expiresAtMs: nextExpiresAtMs } : {}),
      refreshTokenPresent: true,
      refreshed: true,
      reauthRequired: false,
      path,
    };
  } catch (error) {
    const refreshError = error instanceof GoogleOAuthError ? error.code : String((error as Error)?.message || error);
    writeTokenState(path, {
      ...state,
      reauth_required: true,
      refresh_error: refreshError,
      updated_at: new Date(nowMs).toISOString(),
    });
    return { ...base, usable: false, reauthRequired: true, reason: 'reauth_required', refreshError };
  }
}

/** MTL receiver tokens are scoped to tenant/user rather than one Paper device. Try that
 * user's device buckets in deterministic order and reuse the normal refresh path. */
export async function resolveAnyUserGoogleToken(
  env: GoogleOAuthEnv,
  identity: Pick<GoogleOAuthIdentity, 'tenantId' | 'userId'>,
  nowMs = Date.now(),
  options: GoogleOAuthFetchOptions = {},
): Promise<GoogleUserTokenResolution> {
  const userRoot = resolve(
    authRoot(env),
    safePathPart(identity.tenantId, 'tenant'),
    safePathPart(identity.userId, 'user'),
  );
  let deviceIds: string[] = [];
  try {
    deviceIds = readdirSync(userRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((deviceId) => deviceId !== 'calendar-sync' && deviceId !== 'meet-records')
      .sort();
  } catch {
    // No device bucket means this user has not connected Google yet.
  }
  let last: GoogleUserTokenResolution = {
    usable: false,
    scopes: [],
    refreshTokenPresent: false,
    refreshed: false,
    reauthRequired: false,
    reason: 'google_oauth_not_connected',
    path: userRoot,
  };
  for (const deviceId of deviceIds) {
    const resolved = await resolveUserGoogleToken(env, { ...identity, deviceId }, nowMs, options);
    if (resolved.usable && resolved.token) return resolved;
    last = resolved;
  }
  return last;
}

export async function resolveGoogleOAuthStatus(
  env: GoogleOAuthEnv,
  identity: GoogleOAuthIdentity,
  nowMs = Date.now(),
  options: GoogleOAuthFetchOptions = {},
): Promise<GoogleOAuthStatus> {
  const configured = !!googleConfig(env);
  const token = await resolveUserGoogleToken(env, identity, nowMs, options);
  const granted = new Set(token.scopes);
  const missingScopes = GOOGLE_OAUTH_SCOPES.filter((scope) => !granted.has(scope));
  const connected = configured && token.usable && !token.reauthRequired && missingScopes.length === 0;
  return {
    connected,
    configured,
    scopes: token.scopes,
    required_scopes: [...GOOGLE_OAUTH_SCOPES],
    missing_scopes: missingScopes,
    ...(token.expiry ? { expiry: token.expiry } : {}),
    refresh_token_present: token.refreshTokenPresent,
    reauth_required: token.reauthRequired,
    refreshed: token.refreshed,
    ...(connected ? {} : { reason: !configured ? 'google_oauth_disabled' : token.reason || (missingScopes.length ? 'missing_oauth_scope' : 'google_oauth_unavailable') }),
  };
}

export function googleOAuthErrorPayload(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  const status = error instanceof GoogleOAuthError ? error.status : Number((error as { status?: number })?.status) || 500;
  const code = error instanceof GoogleOAuthError ? error.code : 'google_oauth_failed';
  const message = error instanceof Error ? error.message : String(error);
  return { status, body: { error: { code, message } } };
}
