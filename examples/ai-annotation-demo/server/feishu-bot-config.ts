import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type FeishuBotConfigSource = 'local_config' | 'env' | 'none';

export interface FeishuBotConfigEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
  INKLOOP_FEISHU_BOT_CONFIG?: string;
}

export interface FeishuBotConfigFile {
  schema_version?: 'inkloop.feishu_bot_config.v1';
  app_id?: string;
  app_secret?: string;
  base_url?: string;
  updated_at?: string;
}

export interface FeishuBotRuntimeConfig {
  configured: boolean;
  source: FeishuBotConfigSource;
  appId?: string;
  appSecret?: string;
  baseUrl?: string;
  updatedAt?: string;
  configPath: string;
}

export interface FeishuBotPublicConfigStatus {
  configured: boolean;
  configurable: true;
  source: FeishuBotConfigSource;
  auth_mode: 'tenant_access_token';
  app_id?: string;
  app_secret_set: boolean;
  base_url?: string;
  config_path: string;
  updated_at?: string;
}

export interface SaveFeishuBotConfigInput {
  app_id?: unknown;
  appId?: unknown;
  app_secret?: unknown;
  appSecret?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value: unknown): string {
  return text(value).replace(/\/+$/, '');
}

export function feishuBotConfigPath(root: string, env: FeishuBotConfigEnv = process.env): string {
  return resolve(text(env.INKLOOP_FEISHU_BOT_CONFIG) || resolve(root, '.inkloop/feishu-bot-config.json'));
}

export function readFeishuBotConfigFile(configPath: string): FeishuBotConfigFile | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as FeishuBotConfigFile;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function configFromEnv(configPath: string, env: FeishuBotConfigEnv): FeishuBotRuntimeConfig {
  const appId = text(env.FEISHU_APP_ID) || text(env.LARK_APP_ID);
  const appSecret = text(env.FEISHU_APP_SECRET) || text(env.LARK_APP_SECRET);
  const baseUrl = normalizeBaseUrl(env.FEISHU_BASE_URL) || normalizeBaseUrl(env.LARK_BASE_URL);
  if (!appId || !appSecret) return { configured: false, source: 'none', configPath };
  return {
    configured: true,
    source: 'env',
    appId,
    appSecret,
    ...(baseUrl ? { baseUrl } : {}),
    configPath,
  };
}

export function resolveFeishuBotConfig(root: string, env: FeishuBotConfigEnv = process.env): FeishuBotRuntimeConfig {
  const configPath = feishuBotConfigPath(root, env);
  const stored = readFeishuBotConfigFile(configPath);
  const appId = text(stored?.app_id);
  const appSecret = text(stored?.app_secret);
  if (appId && appSecret) {
    const baseUrl = normalizeBaseUrl(stored?.base_url);
    return {
      configured: true,
      source: 'local_config',
      appId,
      appSecret,
      ...(baseUrl ? { baseUrl } : {}),
      ...(stored?.updated_at ? { updatedAt: stored.updated_at } : {}),
      configPath,
    };
  }
  return configFromEnv(configPath, env);
}

export function buildFeishuBotEnv(root: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const config = resolveFeishuBotConfig(root, baseEnv);
  if (!config.configured) return baseEnv;
  return {
    ...baseEnv,
    FEISHU_APP_ID: config.appId,
    FEISHU_APP_SECRET: config.appSecret,
    LARK_APP_ID: config.appId,
    LARK_APP_SECRET: config.appSecret,
    ...(config.baseUrl ? { FEISHU_BASE_URL: config.baseUrl, LARK_BASE_URL: config.baseUrl } : {}),
  };
}

export function publicFeishuBotConfigStatus(config: FeishuBotRuntimeConfig): FeishuBotPublicConfigStatus {
  return {
    configured: config.configured,
    configurable: true,
    source: config.source,
    auth_mode: 'tenant_access_token',
    ...(config.appId ? { app_id: config.appId } : {}),
    app_secret_set: !!config.appSecret,
    ...(config.baseUrl ? { base_url: config.baseUrl } : {}),
    config_path: config.configPath,
    ...(config.updatedAt ? { updated_at: config.updatedAt } : {}),
  };
}

export function saveFeishuBotConfig(
  root: string,
  input: SaveFeishuBotConfigInput,
  env: FeishuBotConfigEnv = process.env,
): FeishuBotRuntimeConfig {
  const configPath = feishuBotConfigPath(root, env);
  const stored = readFeishuBotConfigFile(configPath);
  const appId = text(input.app_id) || text(input.appId);
  const current = resolveFeishuBotConfig(root, env);
  const currentSecret = current.appId === appId ? text(current.appSecret) : '';
  const appSecret = text(input.app_secret) || text(input.appSecret) || text(stored?.app_secret) || currentSecret;
  const baseUrl = normalizeBaseUrl(input.base_url) || normalizeBaseUrl(input.baseUrl) || normalizeBaseUrl(stored?.base_url);
  if (!appId) throw Object.assign(new Error('feishu_bot_app_id_required'), { status: 400 });
  if (!appSecret) throw Object.assign(new Error('feishu_bot_app_secret_required'), { status: 400 });
  const next: FeishuBotConfigFile = {
    schema_version: 'inkloop.feishu_bot_config.v1',
    app_id: appId,
    app_secret: appSecret,
    ...(baseUrl ? { base_url: baseUrl } : {}),
    updated_at: new Date().toISOString(),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  return resolveFeishuBotConfig(root, env);
}

export function deleteFeishuBotConfig(root: string, env: FeishuBotConfigEnv = process.env): FeishuBotRuntimeConfig {
  const configPath = feishuBotConfigPath(root, env);
  try { unlinkSync(configPath); } catch { /* missing config is fine */ }
  return resolveFeishuBotConfig(root, env);
}
