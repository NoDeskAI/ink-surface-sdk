import { describe, expect, it, vi } from 'vitest';
import {
  fetchFeishuBotMessageResource,
  fetchFeishuBotWorkspaces,
  fetchFeishuBotWorkspaceDocxLinks,
  fetchFeishuBotWorkspaceMembers,
  fetchFeishuBotWorkspaceMessages,
} from './feishu-bot-im';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('feishu bot im client', () => {
  it('lists bot workspaces from joined chats', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              { chat_id: 'oc_1', name: '出海项目群', chat_status: 'normal', owner_id: 'ou_owner' },
            ],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    const result = await fetchFeishuBotWorkspaces({
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.connected).toBe(true);
    expect(result.workspaces).toEqual([
      { chat_id: 'oc_1', name: '出海项目群', chat_status: 'normal', owner_id: 'ou_owner' },
    ]);
  });

  it('normalizes workspace messages into the existing meeting contract', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.includes('/open-apis/im/v1/messages?')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_text',
                msg_type: 'text',
                create_time: '1783562400000',
                sender: { id: 'ou_user' },
                body: { content: JSON.stringify({ text: '明天 10 点项目会 https://vc.feishu.cn/j/123456789' }) },
              },
              {
                message_id: 'om_file',
                msg_type: 'file',
                create_time: '1783562500000',
                sender: { id: 'ou_user' },
                body: { content: JSON.stringify({ file_key: 'file_1', file_name: '方案.pdf' }) },
              },
            ],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    const result = await fetchFeishuBotWorkspaceMessages('oc_1', {
      nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.connected).toBe(true);
    expect(result.messages[0]).toMatchObject({
      message_id: 'om_text',
      msg_type: 'text',
      sender_id: 'ou_user',
      text: '明天 10 点项目会 https://vc.feishu.cn/j/123456789',
      meeting_url: 'https://vc.feishu.cn/j/123456789',
    });
    expect(result.messages[1]).toMatchObject({
      message_id: 'om_file',
      msg_type: 'file',
      file_name: '方案.pdf',
      file_key: 'file_1',
    });
  });

  it('lists workspace members', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.includes('/open-apis/im/v1/chats/oc_1/members?')) {
        return jsonResponse({
          code: 0,
          data: {
            member_total: 2,
            items: [
              { member_id: 'ou_1', name: '张宇' },
              { member_id: 'ou_2', name: 'Ethan' },
            ],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    const result = await fetchFeishuBotWorkspaceMembers('oc_1', {
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.total).toBe(2);
    expect(result.members.map((member) => member.name)).toEqual(['张宇', 'Ethan']);
  });

  it('extracts deduplicated docx links from workspace text messages', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.includes('/open-apis/im/v1/messages?')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_docx',
                msg_type: 'text',
                create_time: '1783562600000',
                body: { content: JSON.stringify({ text: '纪要 https://acme.feishu.cn/docx/Abcd_123456?from=chat，再看 https://acme.feishu.cn/docx/Abcd_123456' }) },
              },
              {
                message_id: 'om_other',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: '第二份 https://acme.feishu.cn/docx/Zyxw_987654#section' }) },
              },
            ],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    const result = await fetchFeishuBotWorkspaceDocxLinks('oc_1', {
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.connected).toBe(true);
    expect(result.links).toEqual([
      {
        message_id: 'om_docx',
        create_time: '1783562600000',
        url: 'https://acme.feishu.cn/docx/Abcd_123456?from=chat，再看',
        token: 'Abcd_123456',
      },
      {
        message_id: 'om_other',
        url: 'https://acme.feishu.cn/docx/Zyxw_987654#section',
        token: 'Zyxw_987654',
      },
    ]);
  });

  it('downloads a message resource with the bot tenant token without buffering it in the client', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.endsWith('/open-apis/im/v1/messages/om_file/resources/file_key_1?type=file')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tenant_token');
        return new Response(Buffer.from('real-file-bytes'), {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'content-length': '15' },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    const result = await fetchFeishuBotMessageResource('om_file', 'file_key_1', 'file', {
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.response?.headers.get('content-type')).toBe('application/pdf');
    expect(result.response?.headers.get('content-length')).toBe('15');
    expect(Buffer.from(await result.response!.arrayBuffer()).toString()).toBe('real-file-bytes');
  });
});
