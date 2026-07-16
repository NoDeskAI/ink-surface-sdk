import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MTL_TOKEN_STORE = resolve(dirname(fileURLToPath(import.meta.url)), '../.inkloop/mtl-tokens.json');
const DEFAULT_PUBLIC_HUB_BASE = 'https://meet.xiaobuyu.trade';

export interface MtlReceiverAuthEnv {
  MTL_TOKEN_STORE?: string;
  PUBLIC_HUB_BASE?: string;
}

export interface MtlReceiverIdentity {
  tenant_id: string;
  user_id: string;
}

export interface MtlTokenRecord extends MtlReceiverIdentity {
  created_at: string;
  revoked?: boolean;
  revoked_at?: string;
}

interface MtlTokenStore {
  schema_version: 'inkloop.mtl_tokens.v1';
  tokens: Record<string, MtlTokenRecord>;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tokenStorePath(env: MtlReceiverAuthEnv): string {
  return resolve(clean(env.MTL_TOKEN_STORE) || DEFAULT_MTL_TOKEN_STORE);
}

function emptyStore(): MtlTokenStore {
  return { schema_version: 'inkloop.mtl_tokens.v1', tokens: {} };
}

function readStore(env: MtlReceiverAuthEnv): MtlTokenStore {
  try {
    const parsed = JSON.parse(readFileSync(tokenStorePath(env), 'utf8')) as Partial<MtlTokenStore>;
    return {
      schema_version: 'inkloop.mtl_tokens.v1',
      tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(env: MtlReceiverAuthEnv, store: MtlTokenStore): void {
  const path = tokenStorePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function sameIdentity(left: MtlReceiverIdentity, right: MtlReceiverIdentity): boolean {
  return left.tenant_id === right.tenant_id && left.user_id === right.user_id;
}

function requireIdentity(identity: MtlReceiverIdentity): MtlReceiverIdentity {
  const tenantId = clean(identity.tenant_id);
  const userId = clean(identity.user_id);
  if (!tenantId || !userId) throw Object.assign(new Error('mtl_identity_missing'), { status: 400 });
  return { tenant_id: tenantId, user_id: userId };
}

export function listMtlTokens(
  identity: MtlReceiverIdentity,
  env: MtlReceiverAuthEnv = process.env,
): Array<{ token: string; record: MtlTokenRecord }> {
  const normalized = requireIdentity(identity);
  return Object.entries(readStore(env).tokens)
    .filter(([, record]) => sameIdentity(record, normalized))
    .map(([token, record]) => ({ token, record }))
    .sort((left, right) => right.record.created_at.localeCompare(left.record.created_at));
}

export function currentMtlToken(
  identity: MtlReceiverIdentity,
  env: MtlReceiverAuthEnv = process.env,
): { token: string; record: MtlTokenRecord } | null {
  return listMtlTokens(identity, env).find(({ record }) => !record.revoked) || null;
}

export function mintMtlToken(
  identity: MtlReceiverIdentity,
  env: MtlReceiverAuthEnv = process.env,
  nowMs = Date.now(),
): { token: string; record: MtlTokenRecord; created: boolean } {
  const normalized = requireIdentity(identity);
  const existing = currentMtlToken(normalized, env);
  if (existing) return { ...existing, created: false };

  const store = readStore(env);
  let token = randomBytes(16).toString('hex');
  while (store.tokens[token]) token = randomBytes(16).toString('hex');
  const record: MtlTokenRecord = {
    ...normalized,
    created_at: new Date(nowMs).toISOString(),
  };
  store.tokens[token] = record;
  writeStore(env, store);
  return { token, record, created: true };
}

export function revokeMtlToken(
  token: string,
  identity: MtlReceiverIdentity,
  env: MtlReceiverAuthEnv = process.env,
  nowMs = Date.now(),
): boolean {
  const normalized = requireIdentity(identity);
  const store = readStore(env);
  const record = store.tokens[clean(token)];
  if (!record || record.revoked || !sameIdentity(record, normalized)) return false;
  store.tokens[token] = {
    ...record,
    revoked: true,
    revoked_at: new Date(nowMs).toISOString(),
  };
  writeStore(env, store);
  return true;
}

export function resolveMtlToken(
  token: string,
  env: MtlReceiverAuthEnv = process.env,
): MtlReceiverIdentity | null {
  const normalized = clean(token).toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  const record = readStore(env).tokens[normalized];
  if (!record || record.revoked) return null;
  return { tenant_id: record.tenant_id, user_id: record.user_id };
}

export function mtlReceiverBaseUrl(token: string, env: MtlReceiverAuthEnv = process.env): string {
  const base = clean(env.PUBLIC_HUB_BASE) || DEFAULT_PUBLIC_HUB_BASE;
  return `${base.replace(/\/+$/, '')}/api/mtl/${token}`;
}
