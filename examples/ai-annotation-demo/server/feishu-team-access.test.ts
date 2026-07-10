import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFeishuTeamAccess } from './feishu-team-access';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('feishu team access', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('grants access to bot workspaces where the logged-in Feishu user is a member', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
      }
      if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [
              { chat_id: 'oc_allowed', name: '出海创新周会', chat_status: 'normal' },
              { chat_id: 'oc_other', name: '另一个群', chat_status: 'normal' },
            ],
          },
        });
      }
      if (url.includes('/open-apis/im/v1/chats/oc_allowed/members?')) {
        return jsonResponse({ code: 0, data: { member_total: 2, items: [{ member_id: 'ou_ethan', name: 'Ethan' }] } });
      }
      if (url.includes('/open-apis/im/v1/chats/oc_other/members?')) {
        return jsonResponse({ code: 0, data: { member_total: 1, items: [{ member_id: 'ou_other', name: 'Other' }] } });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const access = await fetchFeishuTeamAccess({
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      userOpenId: 'ou_ethan',
    });

    expect(access.identity_connected).toBe(true);
    expect(access.accessible_chat_ids).toEqual(['oc_allowed']);
    expect(access.groups).toEqual([{ chat_id: 'oc_allowed', name: '出海创新周会', chat_status: 'normal', member_name: 'Ethan' }]);
  });
});
