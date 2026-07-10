import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFeishuBotEnv,
  deleteFeishuBotConfig,
  publicFeishuBotConfigStatus,
  resolveFeishuBotConfig,
  saveFeishuBotConfig,
} from './feishu-bot-config';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'inkloop-feishu-bot-'));
}

describe('feishu bot config', () => {
  it('falls back to the current env bot when no local config exists', () => {
    const root = tempRoot();
    try {
      const config = resolveFeishuBotConfig(root, {
        FEISHU_APP_ID: 'cli_env',
        FEISHU_APP_SECRET: 'env_secret',
      });
      expect(config).toMatchObject({
        configured: true,
        source: 'env',
        appId: 'cli_env',
        appSecret: 'env_secret',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers saved user bot config and never exposes the secret in public status', () => {
    const root = tempRoot();
    try {
      const config = saveFeishuBotConfig(root, {
        app_id: 'cli_saved',
        app_secret: 'saved_secret',
        base_url: 'https://open.feishu.cn/',
      }, {
        FEISHU_APP_ID: 'cli_env',
        FEISHU_APP_SECRET: 'env_secret',
      });
      expect(config).toMatchObject({
        configured: true,
        source: 'local_config',
        appId: 'cli_saved',
        appSecret: 'saved_secret',
        baseUrl: 'https://open.feishu.cn',
      });
      const publicStatus = publicFeishuBotConfigStatus(config);
      expect(publicStatus).toMatchObject({
        configured: true,
        configurable: true,
        source: 'local_config',
        auth_mode: 'tenant_access_token',
        app_id: 'cli_saved',
        app_secret_set: true,
      });
      expect(JSON.stringify(publicStatus)).not.toContain('saved_secret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the previous secret when updating only app id/base url', () => {
    const root = tempRoot();
    try {
      const first = saveFeishuBotConfig(root, { app_id: 'cli_one', app_secret: 'secret_one' }, {});
      const second = saveFeishuBotConfig(root, { app_id: 'cli_two', base_url: 'https://example.feishu.cn' }, {});
      expect(first.appSecret).toBe('secret_one');
      expect(second).toMatchObject({
        appId: 'cli_two',
        appSecret: 'secret_one',
        baseUrl: 'https://example.feishu.cn',
      });
      const raw = readFileSync(second.configPath, 'utf8');
      expect(raw).toContain('secret_one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows saving env fallback config without retyping the same app secret', () => {
    const root = tempRoot();
    try {
      const config = saveFeishuBotConfig(root, { app_id: 'cli_env' }, {
        FEISHU_APP_ID: 'cli_env',
        FEISHU_APP_SECRET: 'env_secret',
      });
      expect(config).toMatchObject({
        source: 'local_config',
        appId: 'cli_env',
        appSecret: 'env_secret',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds a merged env for bot calendar, IM, OAuth and SDK calls', () => {
    const root = tempRoot();
    try {
      saveFeishuBotConfig(root, { app_id: 'cli_saved', app_secret: 'saved_secret' }, {});
      const env = buildFeishuBotEnv(root, {
        LARK_MEETING_AUTH_STATE_PATH: '/tmp/auth.json',
        FEISHU_APP_ID: 'cli_env',
        FEISHU_APP_SECRET: 'env_secret',
      });
      expect(env).toMatchObject({
        FEISHU_APP_ID: 'cli_saved',
        FEISHU_APP_SECRET: 'saved_secret',
        LARK_APP_ID: 'cli_saved',
        LARK_APP_SECRET: 'saved_secret',
        LARK_MEETING_AUTH_STATE_PATH: '/tmp/auth.json',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resets local config back to env fallback', () => {
    const root = tempRoot();
    try {
      saveFeishuBotConfig(root, { app_id: 'cli_saved', app_secret: 'saved_secret' }, {});
      const config = deleteFeishuBotConfig(root, {
        FEISHU_APP_ID: 'cli_env',
        FEISHU_APP_SECRET: 'env_secret',
      });
      expect(config).toMatchObject({
        configured: true,
        source: 'env',
        appId: 'cli_env',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
