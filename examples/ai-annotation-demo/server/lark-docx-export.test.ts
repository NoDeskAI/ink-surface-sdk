import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  exportLarkDocxToPdf,
  LARK_DOCX_EXPORT_POLL_INTERVAL_MS,
  LARK_DOCX_EXPORT_POLL_TIMEOUT_MS,
} from './lark-docx-export';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function authState(scope = 'drive:export:readonly', openId = 'ou_session_user'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'inkloop-docx-export-'));
  const path = join(dir, 'auth-state.json');
  writeFileSync(path, JSON.stringify({
    token: { access_token: 'user_token', scope },
    user: { data: { open_id: openId } },
  }));
  return { dir, path };
}

describe('local lark docx export', () => {
  it('creates, polls, and downloads a Feishu export task with the session user token', async () => {
    const auth = authState();
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer user_token');
      if (url.endsWith('/open-apis/drive/v1/export_tasks')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ file_extension: 'pdf', token: 'Docx_123456', type: 'docx' });
        return jsonResponse({ code: 0, data: { ticket: 'ticket_1' } });
      }
      if (url.endsWith('/open-apis/drive/v1/export_tasks/ticket_1?token=Docx_123456')) {
        pollCount += 1;
        return jsonResponse({
          code: 0,
          data: { result: pollCount === 1 ? { job_status: 1 } : { job_status: 0, file_token: 'file_1', file_name: '会议纪要.pdf' } },
        });
      }
      if (url.endsWith('/open-apis/drive/v1/export_tasks/file/file_1/download')) {
        return new Response(Buffer.from('%PDF-mock'), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '9' } });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    try {
      const result = await exportLarkDocxToPdf('Docx_123456', {
        env: {
          FEISHU_APP_ID: 'cli_test',
          FEISHU_APP_SECRET: 'secret',
          FEISHU_BASE_URL: 'https://open.feishu.test',
          LARK_MEETING_AUTH_STATE_PATH: auth.path,
        },
        expectedOpenId: 'ou_session_user',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowMs: () => clock,
        sleep,
      });

      expect(result).toMatchObject({ ok: true, status: 200, file_name: '会议纪要.pdf' });
      expect(result.response?.headers.get('content-length')).toBe('9');
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(LARK_DOCX_EXPORT_POLL_INTERVAL_MS);
    } finally {
      rmSync(auth.dir, { recursive: true, force: true });
    }
  });

  it('returns a structured task failure', async () => {
    const auth = authState();
    let clock = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/drive/v1/export_tasks')) return jsonResponse({ code: 0, data: { ticket: 'ticket_1' } });
      return jsonResponse({ code: 0, data: { result: { job_status: 3, job_error_msg: 'permission denied' } } });
    });
    try {
      const result = await exportLarkDocxToPdf('Docx_123456', {
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: auth.path },
        expectedOpenId: 'ou_session_user',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowMs: () => clock,
        sleep: async (ms) => { clock += ms; },
      });
      expect(result).toEqual({
        ok: false,
        status: 502,
        error: {
          code: 'export_task_failed',
          message: '飞书文档导出失败：job_status=3 permission denied',
          job_status: 3,
          job_error_msg: 'permission denied',
        },
      });
    } finally {
      rmSync(auth.dir, { recursive: true, force: true });
    }
  });

  it('times out after the legacy 30 second polling window', async () => {
    const auth = authState();
    let clock = 0;
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/drive/v1/export_tasks')) return jsonResponse({ code: 0, data: { ticket: 'ticket_1' } });
      polls += 1;
      return jsonResponse({ code: 0, data: { result: { job_status: 2 } } });
    });
    try {
      const result = await exportLarkDocxToPdf('Docx_123456', {
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: auth.path },
        expectedOpenId: 'ou_session_user',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowMs: () => clock,
        sleep: async (ms) => { clock += ms; },
      });
      expect(result).toEqual({ ok: false, status: 504, error: { code: 'export_task_timeout', message: '飞书文档导出超时' } });
      expect(clock).toBe(LARK_DOCX_EXPORT_POLL_TIMEOUT_MS);
      expect(polls).toBe(LARK_DOCX_EXPORT_POLL_TIMEOUT_MS / LARK_DOCX_EXPORT_POLL_INTERVAL_MS);
    } finally {
      rmSync(auth.dir, { recursive: true, force: true });
    }
  });

  it('requires the export scope and keeps session identity binding', async () => {
    const missingScope = authState('docx:document:readonly');
    const wrongIdentity = authState('drive:export:readonly', 'ou_other_user');
    try {
      const scopeResult = await exportLarkDocxToPdf('Docx_123456', {
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: missingScope.path },
        expectedOpenId: 'ou_session_user',
      });
      expect(scopeResult).toMatchObject({ ok: false, status: 403, error: { code: 'missing_oauth_scope', required_scope: 'drive:export:readonly' } });

      const identityResult = await exportLarkDocxToPdf('Docx_123456', {
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: wrongIdentity.path },
        expectedOpenId: 'ou_session_user',
      });
      expect(identityResult).toEqual({ ok: false, status: 409, error: { code: 'feishu_identity_mismatch', message: '当前 session 与飞书 OAuth 身份不一致' } });
    } finally {
      rmSync(missingScope.dir, { recursive: true, force: true });
      rmSync(wrongIdentity.dir, { recursive: true, force: true });
    }
  });
});
