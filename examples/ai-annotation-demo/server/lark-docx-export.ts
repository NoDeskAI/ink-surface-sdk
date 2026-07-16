import { resolveUserOAuthToken } from './lark-oauth-state';

const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
export const LARK_DOCX_EXPORT_SCOPE = 'drive:export:readonly';
export const LARK_DOCX_EXPORT_POLL_INTERVAL_MS = 1500;
export const LARK_DOCX_EXPORT_POLL_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

export interface LarkDocxExportEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
  LARK_MEETING_AUTH_STATE_PATH?: string;
}

export interface LarkDocxExportError {
  code: string;
  message: string;
  feishu_code?: string;
  required_scope?: string;
  job_status?: number;
  job_error_msg?: string;
}

export interface LarkDocxExportResult {
  ok: boolean;
  status: number;
  response?: Response;
  file_name?: string;
  error?: LarkDocxExportError;
}

function appConfig(env: LarkDocxExportEnv): { appId: string; appSecret: string; baseUrl: string } | null {
  const appId = String(env.LARK_APP_ID || env.FEISHU_APP_ID || '').trim();
  const appSecret = String(env.LARK_APP_SECRET || env.FEISHU_APP_SECRET || '').trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    baseUrl: String(env.LARK_BASE_URL || env.FEISHU_BASE_URL || DEFAULT_FEISHU_BASE_URL).replace(/\/+$/, ''),
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function feishuMessage(body: Record<string, unknown>): string {
  return String(body.msg || body.message || body.error || body.code || 'unknown Feishu error');
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return { raw }; }
}

function feishuApiError(response: Response, body: Record<string, unknown>, code: string): LarkDocxExportResult {
  return {
    ok: false,
    status: response.ok ? 502 : response.status,
    error: {
      code,
      message: feishuMessage(body),
      feishu_code: String(body.code || `http_${response.status}`),
      required_scope: LARK_DOCX_EXPORT_SCOPE,
    },
  };
}

export async function exportLarkDocxToPdf(documentId: string, options: {
  env?: LarkDocxExportEnv;
  expectedOpenId: string;
  fetchImpl?: FetchLike;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<LarkDocxExportResult> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(documentId)) {
    return { ok: false, status: 400, error: { code: 'invalid_docx_token', message: 'invalid docx token' } };
  }
  const env = options.env || process.env;
  const config = appConfig(env);
  if (!config) {
    return { ok: false, status: 503, error: { code: 'lark_not_configured', message: 'FEISHU_APP_ID/FEISHU_APP_SECRET or LARK_APP_ID/LARK_APP_SECRET is not configured' } };
  }
  const nowMs = options.nowMs || Date.now;
  const userOAuth = await resolveUserOAuthToken(env, nowMs());
  if (!userOAuth.usable || !userOAuth.token) {
    return { ok: false, status: 401, error: { code: userOAuth.reason || 'oauth_unavailable', message: '未检测到当前 session 可用的飞书用户 OAuth token', required_scope: LARK_DOCX_EXPORT_SCOPE } };
  }
  if (!options.expectedOpenId || !userOAuth.userOpenIds.includes(options.expectedOpenId)) {
    return { ok: false, status: 409, error: { code: 'feishu_identity_mismatch', message: '当前 session 与飞书 OAuth 身份不一致' } };
  }
  if (!userOAuth.scopes.includes(LARK_DOCX_EXPORT_SCOPE)) {
    return { ok: false, status: 403, error: { code: 'missing_oauth_scope', message: '当前飞书 OAuth token 缺少云文档导出权限，需要重新授权', required_scope: LARK_DOCX_EXPORT_SCOPE } };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const headers = { authorization: `Bearer ${userOAuth.token}` };
  const createdResponse = await fetchImpl(`${config.baseUrl}/open-apis/drive/v1/export_tasks`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ file_extension: 'pdf', token: documentId, type: 'docx' }),
  });
  const created = await jsonBody(createdResponse);
  if (!createdResponse.ok || created.code !== 0) return feishuApiError(createdResponse, created, 'export_task_create_failed');
  const ticket = String(objectOf(created.data).ticket || '').trim();
  if (!ticket) {
    return { ok: false, status: 502, error: { code: 'export_ticket_missing', message: '飞书 export_tasks 未返回 ticket', required_scope: LARK_DOCX_EXPORT_SCOPE } };
  }

  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = nowMs() + LARK_DOCX_EXPORT_POLL_TIMEOUT_MS;
  let fileToken = '';
  let fileName = '';
  while (nowMs() < deadline) {
    await sleep(LARK_DOCX_EXPORT_POLL_INTERVAL_MS);
    const query = new URLSearchParams({ token: documentId });
    const pollResponse = await fetchImpl(`${config.baseUrl}/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}?${query}`, { headers });
    const polled = await jsonBody(pollResponse);
    if (!pollResponse.ok || polled.code !== 0) return feishuApiError(pollResponse, polled, 'export_task_poll_failed');
    const data = objectOf(polled.data);
    const task = objectOf(data.result || data);
    const jobStatus = Number(task.job_status);
    if (jobStatus === 0) {
      fileToken = String(task.file_token || '').trim();
      fileName = String(task.file_name || '').trim();
      if (!fileToken) {
        return { ok: false, status: 502, error: { code: 'export_file_token_missing', message: '飞书导出任务成功但未返回 file_token' } };
      }
      break;
    }
    if (jobStatus !== 1 && jobStatus !== 2) {
      const jobError = String(task.job_error_msg || '').trim();
      return {
        ok: false,
        status: 502,
        error: {
          code: 'export_task_failed',
          message: `飞书文档导出失败：job_status=${jobStatus}${jobError ? ` ${jobError}` : ''}`,
          job_status: jobStatus,
          ...(jobError ? { job_error_msg: jobError } : {}),
        },
      };
    }
  }
  if (!fileToken) {
    return {
      ok: false,
      status: 504,
      error: {
        code: 'export_task_timeout',
        message: '飞书文档导出超时',
      },
    };
  }

  const downloadResponse = await fetchImpl(`${config.baseUrl}/open-apis/drive/v1/export_tasks/file/${encodeURIComponent(fileToken)}/download`, { headers });
  const contentType = downloadResponse.headers.get('content-type') || '';
  if (!downloadResponse.ok || /application\/json/i.test(contentType)) {
    const body = await jsonBody(downloadResponse);
    return feishuApiError(downloadResponse, body, 'export_file_download_failed');
  }
  return { ok: true, status: downloadResponse.status, response: downloadResponse, file_name: fileName || 'document.pdf' };
}
