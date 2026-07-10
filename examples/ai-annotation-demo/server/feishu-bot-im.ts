const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
const DEFAULT_MESSAGE_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MESSAGE_PAGE_SIZE = 30;

type FetchLike = typeof fetch;

export interface FeishuBotImEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
}

export interface FeishuBotImFetchOptions {
  nowMs?: number;
  lookbackSeconds?: number;
  pageSize?: number;
  fetchImpl?: FetchLike;
  env?: FeishuBotImEnv;
}

export interface FeishuBotWorkspace {
  chat_id: string;
  name: string;
  chat_status: string;
  description?: string;
  owner_id?: string;
}

export interface FeishuBotWorkspaceMember {
  open_id: string;
  name: string;
}

export interface FeishuBotMessage {
  message_id: string;
  msg_type: string;
  sender_id?: string;
  create_time?: string;
  text?: string;
  file_name?: string;
  file_key?: string;
  image_key?: string;
  meeting_url?: string;
  raw_content?: string;
}

export interface FeishuBotImError {
  code: string;
  message: string;
  permission_url?: string;
  required_scopes?: string[];
}

interface FeishuBotImBaseResult {
  connected: boolean;
  configured: boolean;
  source: 'feishu_bot_im';
  auth_mode: 'tenant_access_token';
  error?: FeishuBotImError;
}

export interface FeishuBotWorkspacesResult extends FeishuBotImBaseResult {
  workspaces: FeishuBotWorkspace[];
}

export interface FeishuBotWorkspaceMembersResult extends FeishuBotImBaseResult {
  total: number;
  members: FeishuBotWorkspaceMember[];
}

export interface FeishuBotWorkspaceMessagesResult extends FeishuBotImBaseResult {
  messages: FeishuBotMessage[];
}

function appConfig(env: FeishuBotImEnv): { appId: string; appSecret: string; baseUrl: string } | null {
  const appId = String(env.FEISHU_APP_ID || env.LARK_APP_ID || '').trim();
  const appSecret = String(env.FEISHU_APP_SECRET || env.LARK_APP_SECRET || '').trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    baseUrl: String(env.FEISHU_BASE_URL || env.LARK_BASE_URL || DEFAULT_FEISHU_BASE_URL).replace(/\/+$/, ''),
  };
}

function permissionUrl(appId: string, scopes: string[]): string {
  return `https://open.feishu.cn/app/${appId}/auth?q=${encodeURIComponent(scopes.join(','))}&op_from=openapi&token_type=tenant`;
}

function emptyBase(error: FeishuBotImError, configured = true): FeishuBotImBaseResult {
  return {
    connected: false,
    configured,
    source: 'feishu_bot_im',
    auth_mode: 'tenant_access_token',
    error,
  };
}

async function requestJson(fetchImpl: FetchLike, baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; }
  catch { json = { raw: text }; }
  return { status: res.status, json };
}

function feishuMsg(json: Record<string, unknown>): string {
  return String(json.msg || json.message || json.error || json.code || 'unknown Feishu error');
}

function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return (json.data && typeof json.data === 'object') ? json.data as Record<string, unknown> : {};
}

function isPermissionDenied(json: Record<string, unknown>): boolean {
  const msg = feishuMsg(json);
  return Number(json.code) === 99991672 || /Access denied|scope|permission|权限/.test(msg);
}

function permissionError(appId: string, message: string, scopes: string[]): FeishuBotImError {
  return {
    code: 'missing_im_scope',
    message,
    permission_url: permissionUrl(appId, scopes),
    required_scopes: scopes,
  };
}

async function tenantAccessToken(fetchImpl: FetchLike, config: { appId: string; appSecret: string; baseUrl: string }): Promise<{ token?: string; error?: FeishuBotImError }> {
  const res = await requestJson(fetchImpl, config.baseUrl, '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  if (res.json.code !== 0) return { error: { code: 'token_failed', message: feishuMsg(res.json) } };
  const token = String(res.json.tenant_access_token || '').trim();
  return token ? { token } : { error: { code: 'token_missing', message: 'Feishu token response missing tenant_access_token' } };
}

async function withToken<T>(
  options: FeishuBotImFetchOptions,
  run: (ctx: { fetchImpl: FetchLike; config: { appId: string; appSecret: string; baseUrl: string }; token: string }) => Promise<T>,
): Promise<T | FeishuBotImBaseResult> {
  const env = options.env || process.env;
  const config = appConfig(env);
  if (!config) {
    return emptyBase({
      code: 'not_configured',
      message: 'FEISHU_APP_ID/FEISHU_APP_SECRET or LARK_APP_ID/LARK_APP_SECRET is not configured',
    }, false);
  }
  const fetchImpl = options.fetchImpl || fetch;
  const token = await tenantAccessToken(fetchImpl, config);
  if (!token.token) return emptyBase(token.error || { code: 'token_failed', message: 'Feishu token failed' });
  return run({ fetchImpl, config, token: token.token });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function findMeetingUrl(raw: string): string | undefined {
  return raw.match(/https:\/\/(?:vc|meeting)\.feishu\.cn\/[^\s"')]+/)?.[0];
}

function normalizeMessage(item: Record<string, unknown>): FeishuBotMessage | null {
  const messageId = String(item.message_id || '').trim();
  const msgType = String(item.msg_type || item.message_type || '').trim();
  if (!messageId || !msgType) return null;
  const sender = parseJsonObject(item.sender);
  const body = parseJsonObject(item.body);
  const rawContent = String(body.content || '');
  const content = parseJsonObject(rawContent);
  const text = firstString(content.text, content.title, content.summary, content.description, rawContent);
  const senderId = firstString(sender.id, sender.sender_id);
  return {
    message_id: messageId,
    msg_type: msgType,
    ...(senderId ? { sender_id: senderId } : {}),
    ...(item.create_time ? { create_time: String(item.create_time) } : {}),
    ...(text ? { text } : {}),
    ...(firstString(content.file_name, content.name) ? { file_name: firstString(content.file_name, content.name) } : {}),
    ...(firstString(content.file_key, content.file_token) ? { file_key: firstString(content.file_key, content.file_token) } : {}),
    ...(firstString(content.image_key) ? { image_key: firstString(content.image_key) } : {}),
    ...(findMeetingUrl(rawContent) ? { meeting_url: findMeetingUrl(rawContent) } : {}),
    ...(rawContent ? { raw_content: rawContent } : {}),
  };
}

export async function fetchFeishuBotWorkspaces(options: FeishuBotImFetchOptions = {}): Promise<FeishuBotWorkspacesResult> {
  const result = await withToken(options, async ({ fetchImpl, config, token }) => {
    const res = await requestJson(fetchImpl, config.baseUrl, '/open-apis/im/v1/chats?page_size=100', { headers: { authorization: `Bearer ${token}` } });
    if (res.json.code !== 0) {
      const message = feishuMsg(res.json);
      return {
        ...emptyBase(isPermissionDenied(res.json) ? permissionError(config.appId, message, ['im:chat']) : { code: 'chat_list_failed', message }),
        workspaces: [],
      };
    }
    const raw = (Array.isArray(dataOf(res.json).items) ? dataOf(res.json).items : []) as Record<string, unknown>[];
    return {
      connected: true,
      configured: true,
      source: 'feishu_bot_im' as const,
      auth_mode: 'tenant_access_token' as const,
      workspaces: raw
        .map((item) => ({
          chat_id: String(item.chat_id || '').trim(),
          name: String(item.name || '飞书群').trim(),
          chat_status: String(item.chat_status || 'normal'),
          ...(item.description ? { description: String(item.description) } : {}),
          ...(item.owner_id ? { owner_id: String(item.owner_id) } : {}),
        }))
        .filter((item) => item.chat_id),
    };
  });
  return 'workspaces' in result ? result : { ...result, workspaces: [] };
}

export async function fetchFeishuBotWorkspaceMembers(chatId: string, options: FeishuBotImFetchOptions = {}): Promise<FeishuBotWorkspaceMembersResult> {
  const encoded = encodeURIComponent(chatId);
  const result = await withToken(options, async ({ fetchImpl, config, token }) => {
    const res = await requestJson(fetchImpl, config.baseUrl, `/open-apis/im/v1/chats/${encoded}/members?page_size=100&member_id_type=open_id`, { headers: { authorization: `Bearer ${token}` } });
    if (res.json.code !== 0) {
      const message = feishuMsg(res.json);
      return {
        ...emptyBase(isPermissionDenied(res.json) ? permissionError(config.appId, message, ['im:chat']) : { code: 'chat_members_failed', message }),
        total: 0,
        members: [],
      };
    }
    const data = dataOf(res.json);
    const raw = (Array.isArray(data.items) ? data.items : []) as Record<string, unknown>[];
    const members = raw.map((item) => {
      const memberId = String(item.member_id || item.open_id || item.user_id || '').trim();
      return {
        open_id: memberId,
        name: String(item.name || item.en_name || item.nickname || memberId || '成员'),
      };
    }).filter((item) => item.open_id);
    return {
      connected: true,
      configured: true,
      source: 'feishu_bot_im' as const,
      auth_mode: 'tenant_access_token' as const,
      total: Number(data.member_total || members.length) || members.length,
      members,
    };
  });
  return 'members' in result ? result : { ...result, total: 0, members: [] };
}

export async function fetchFeishuBotWorkspaceMessages(chatId: string, options: FeishuBotImFetchOptions = {}): Promise<FeishuBotWorkspaceMessagesResult> {
  const result = await withToken(options, async ({ fetchImpl, config, token }) => {
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
    const start = nowSeconds - Math.max(60, Math.floor(options.lookbackSeconds ?? DEFAULT_MESSAGE_LOOKBACK_SECONDS));
    const end = nowSeconds + 60;
    const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? DEFAULT_MESSAGE_PAGE_SIZE), 1), 100);
    const params = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chatId,
      start_time: String(start),
      end_time: String(end),
      page_size: String(pageSize),
    });
    const res = await requestJson(fetchImpl, config.baseUrl, `/open-apis/im/v1/messages?${params.toString()}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.json.code !== 0) {
      const message = feishuMsg(res.json);
      return {
        ...emptyBase(isPermissionDenied(res.json) ? permissionError(config.appId, message, ['im:message']) : { code: 'message_list_failed', message }),
        messages: [],
      };
    }
    const raw = (Array.isArray(dataOf(res.json).items) ? dataOf(res.json).items : []) as Record<string, unknown>[];
    return {
      connected: true,
      configured: true,
      source: 'feishu_bot_im' as const,
      auth_mode: 'tenant_access_token' as const,
      messages: raw.map(normalizeMessage).filter((item): item is FeishuBotMessage => !!item),
    };
  });
  return 'messages' in result ? result : { ...result, messages: [] };
}

export async function fetchFeishuBotWorkspaceFiles(chatId: string, options: FeishuBotImFetchOptions = {}): Promise<FeishuBotWorkspaceMessagesResult> {
  const result = await fetchFeishuBotWorkspaceMessages(chatId, { ...options, pageSize: Math.max(options.pageSize || DEFAULT_MESSAGE_PAGE_SIZE, 100) });
  return {
    ...result,
    messages: result.messages.filter((message) => message.msg_type === 'file' || message.msg_type === 'image'),
  };
}
