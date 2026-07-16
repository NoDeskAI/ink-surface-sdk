import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLarkMeetingSources, resolveLarkMeetingInstance } from './lark-meeting-sources';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchLarkMeetingSources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps chat meeting links unresolved while searching VC meetings', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars')) {
        return jsonResponse({ code: 0, data: { calendar_list: [] } });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) {
        return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '个人日历' } });
      }
      if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) {
        return jsonResponse({ code: 0, data: { items: [], has_more: false } });
      }
      if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
        return jsonResponse({
          code: 0,
          data: { items: [{ chat_id: 'oc_1', name: '项目群', chat_status: 'normal' }] },
        });
      }
      if (url.includes('/open-apis/im/v1/messages?')) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{
              message_id: 'om_1',
              msg_type: 'text',
              create_time: '1783562400000',
              body: { content: JSON.stringify({ text: '十点项目会 https://vc.feishu.cn/j/123456789' }) },
            }],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const listMeetingsByNo = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{
          id: 'meeting_from_link',
          topic: '项目例会',
          meeting_no: '123456789',
          start_time: '1783566000',
          end_time: '1783569600',
          url: 'https://vc.feishu.cn/j/123456789',
        }],
      },
    }));
    const listMeetingsByNoWithToken = vi.fn();
    const searchMeetings = vi.fn(async () => ({
      code: 0,
      data: {
        items: [{
          id: 'meeting_from_search',
          topic: 'VC 搜索会议',
          meeting_no: '987654321',
          start_time: '1783573200',
        }],
      },
    }));

    const result = await fetchLarkMeetingSources({
      nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
      env: {
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret',
        LARK_MEETING_AUTH_STATE_PATH: join(tmpdir(), 'inkloop-no-oauth-link-search.json'),
      },
      createClient: () => ({
        listMeetingsByNo,
        listMeetingsByNoWithToken,
        searchMeetings,
      }),
    });

    expect(result.configured).toBe(true);
    expect(listMeetingsByNo).not.toHaveBeenCalled();
    expect(listMeetingsByNoWithToken).not.toHaveBeenCalled();
    expect(searchMeetings).toHaveBeenCalledWith(expect.objectContaining({ page_size: 10 }));

    expect(result.sources.map((source) => source.feishu_meeting_id)).not.toContain('meeting_from_link');
    expect(result.sources.map((source) => source.feishu_meeting_id)).toContain('meeting_from_search');

    expect(result.sources.find((source) => source.feishu_meeting_id === 'meeting_from_search')).toMatchObject({
      source: 'lark_meeting_timeline',
      title: 'VC 搜索会议',
      meeting_no: '987654321',
      start_time_reliable: true,
    });

    const chatMeeting = result.sources.find((source) => source.source === 'bot_chat_message');
    expect(chatMeeting).toMatchObject({
      source_id: 'chat:oc_1:om_1',
      source: 'bot_chat_message',
      meeting_no: '123456789',
      meeting_url: 'https://vc.feishu.cn/j/123456789',
      chat_id: 'oc_1',
      chat_name: '项目群',
      message_id: 'om_1',
      start_time_reliable: false,
    });
    expect(chatMeeting).not.toHaveProperty('feishu_meeting_id');
  });

  it('filters bot chat meeting sources to groups that contain the logged-in Feishu user', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars')) {
        return jsonResponse({ code: 0, data: { calendar_list: [] } });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) {
        return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '个人日历' } });
      }
      if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) {
        return jsonResponse({ code: 0, data: { items: [], has_more: false } });
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
        return jsonResponse({ code: 0, data: { member_total: 1, items: [{ member_id: 'ou_ethan', name: 'Ethan' }] } });
      }
      if (url.includes('/open-apis/im/v1/chats/oc_other/members?')) {
        return jsonResponse({ code: 0, data: { member_total: 1, items: [{ member_id: 'ou_other', name: 'Other' }] } });
      }
      if (url.includes('/open-apis/im/v1/messages?')) {
        const containerId = new URL(url).searchParams.get('container_id');
        return jsonResponse({
          code: 0,
          data: {
            items: [{
              message_id: `om_${containerId}`,
              msg_type: 'text',
              create_time: '1783562400000',
              body: { content: JSON.stringify({ text: `${containerId} 会议 https://vc.feishu.cn/j/123456789` }) },
            }],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await fetchLarkMeetingSources({
      nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
      env: {
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret',
        LARK_MEETING_AUTH_STATE_PATH: join(tmpdir(), 'inkloop-no-oauth-for-team-filter.json'),
      },
      userOpenIds: ['ou_ethan'],
      createClient: () => ({}),
    });

    expect(result.sources.map((source) => source.chat_id).filter(Boolean)).toEqual(['oc_allowed']);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('container_id=oc_other'))).toBe(false);
  });

  it('skips bot calendar/chat/VC sources entirely when caller requires filtering but requester has no identity', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      return jsonResponse({ code: 999, msg: `should not be called: ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await fetchLarkMeetingSources({
      nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
      env: {
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret',
        LARK_MEETING_AUTH_STATE_PATH: join(tmpdir(), 'inkloop-no-oauth-identityless.json'),
      },
      userOpenIds: [],
      createClient: () => ({}),
    });

    expect(result.sources).toEqual([]);
    // 无身份=[] 时 bot 日历/群聊一次都不该发起（undefined 才是 demo 全量语义）
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/calendar/'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/im/v1/chats'))).toBe(false);
  });

  it('uses the SDK OAuth user token for VC search without batch meeting lookup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'vc:meeting.search:read vc:meeting.meetingid:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
          return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars')) {
          return jsonResponse({ code: 0, data: { calendar_list: [] } });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) {
          return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '个人日历' } });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) {
          return jsonResponse({ code: 0, data: { items: [], has_more: false } });
        }
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
          return jsonResponse({
            code: 0,
            data: { items: [{ chat_id: 'oc_1', name: '项目群', chat_status: 'normal' }] },
          });
        }
        if (url.includes('/open-apis/im/v1/chats/oc_1/members?')) {
          return jsonResponse({
            code: 0,
            data: { member_total: 1, items: [{ member_id: 'ou_ethan', name: 'Ethan' }] },
          });
        }
        if (url.includes('/open-apis/im/v1/messages?')) {
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                message_id: 'om_1',
                msg_type: 'text',
                create_time: '1783562400000',
                body: { content: JSON.stringify({ text: '会议链接 https://vc.feishu.cn/j/123456789' }) },
              }],
            },
          });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const listMeetingsByNoWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          items: [{
            id: 'meeting_from_user_lookup',
            topic: '用户授权会议',
            meeting_no: '123456789',
            start_time: '1783566000',
          }],
        },
      }));
      const searchMeetingsWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          items: [{
            id: 'meeting_from_user_search',
            topic: '用户授权搜索会议',
            meeting_no: '987654321',
            start_time: '1783573200',
          }],
        },
      }));
      const listMeetingsByNo = vi.fn();
      const searchMeetings = vi.fn();

      const result = await fetchLarkMeetingSources({
        nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
        env: {
          FEISHU_APP_ID: 'cli_test',
          FEISHU_APP_SECRET: 'secret',
          LARK_MEETING_AUTH_STATE_PATH: authPath,
        },
        createClient: () => ({
          listMeetingsByNoWithToken,
          listMeetingsByNo,
          searchMeetingsWithToken,
          searchMeetings,
        }),
      });

      expect(listMeetingsByNoWithToken).not.toHaveBeenCalled();
      expect(listMeetingsByNo).not.toHaveBeenCalled();
      expect(searchMeetingsWithToken).toHaveBeenCalledWith(
        'user_token',
        expect.objectContaining({
          page_size: 10,
          participant_ids: ['ou_ethan'],
        }),
      );
      expect(searchMeetings).not.toHaveBeenCalled();
      expect(result.errors.find((error) => error.source === 'lark_oauth')).toBeUndefined();

      expect(result.sources.map((source) => source.feishu_meeting_id)).not.toContain('meeting_from_user_lookup');
      expect(result.sources.map((source) => source.feishu_meeting_id)).toContain('meeting_from_user_search');

      const chatMeeting = result.sources.find((source) => source.source === 'bot_chat_message');
      expect(chatMeeting).toMatchObject({
        meeting_no: '123456789',
        chat_id: 'oc_1',
        message_id: 'om_1',
      });
      expect(chatMeeting).not.toHaveProperty('feishu_meeting_id');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refreshes expired SDK OAuth state before user calendar and VC search without batch lookup', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    const nowMs = Date.parse('2026-07-07T16:00:00+08:00');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'expired_user_token',
        refresh_token: 'refresh_user_token',
        expires_in: 60,
        refresh_expires_in: 24 * 60 * 60,
        obtained_at_ms: Date.parse('2026-07-07T15:00:00+08:00'),
        scope: 'auth:user.id:read vc:meeting.search:read vc:meeting.meetingid:read calendar:calendar:read calendar:calendar.event:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
          return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars') && auth.includes('fresh_user_token')) {
          return jsonResponse({
            code: 0,
            data: { calendar_list: [{ calendar_id: 'user_primary', summary: '张宇日历' }] },
          });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/user_primary/events') && auth.includes('fresh_user_token')) {
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                event_id: 'evt_current_weekly',
                summary: '出海创新周会',
                start_time: {
                  timestamp: String(Date.parse('2026-07-07T15:00:00+08:00') / 1000),
                },
                end_time: {
                  timestamp: String(Date.parse('2026-07-07T16:00:00+08:00') / 1000),
                },
                vchat: { meeting_url: 'https://vc.feishu.cn/j/473388422' },
              }],
              has_more: false,
            },
          });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars')) {
          return jsonResponse({ code: 0, data: { calendar_list: [] } });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) {
          return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '应用日历' } });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) {
          return jsonResponse({ code: 0, data: { items: [] } });
        }
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
          return jsonResponse({ code: 0, data: { items: [] } });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const refreshOAuthToken = vi.fn(async () => ({
        access_token: 'fresh_user_token',
        refresh_token: 'fresh_refresh_token',
        expires_in: 7200,
        refresh_expires_in: 30 * 24 * 60 * 60,
        scope: 'auth:user.id:read vc:meeting.search:read vc:meeting.meetingid:read calendar:calendar:read calendar:calendar.event:read',
      }));
      const listMeetingsByNoWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          items: [{
            id: 'meeting_from_user_lookup',
            topic: '出海创新周会',
            meeting_no: '473388422',
            start_time: String(Date.parse('2026-07-07T15:01:00+08:00') / 1000),
            end_time: String(Date.parse('2026-07-07T16:00:00+08:00') / 1000),
          }],
        },
      }));
      const listMeetingsByNo = vi.fn();
      const searchMeetingsWithToken = vi.fn(async () => ({
        code: 0,
        data: { items: [] },
      }));

      const result = await fetchLarkMeetingSources({
        nowMs,
        env: {
          FEISHU_APP_ID: 'cli_test',
          FEISHU_APP_SECRET: 'secret',
          LARK_MEETING_AUTH_STATE_PATH: authPath,
        },
        createClient: () => ({
          refreshOAuthToken,
          listMeetingsByNoWithToken,
          listMeetingsByNo,
          searchMeetingsWithToken,
        }),
      });

      expect(refreshOAuthToken).toHaveBeenCalledWith('refresh_user_token');
      expect(listMeetingsByNoWithToken).not.toHaveBeenCalled();
      expect(listMeetingsByNo).not.toHaveBeenCalled();
      expect(searchMeetingsWithToken).toHaveBeenCalledWith(
        'fresh_user_token',
        expect.objectContaining({ participant_ids: ['ou_ethan'] }),
      );

      const calendarMeeting = result.sources.find(
        (source) => source.calendar_event_id === 'evt_current_weekly',
      );
      expect(calendarMeeting).toMatchObject({
        source: 'user_calendar',
        title: '出海创新周会',
        status: 'live',
        scheduled_at: new Date(Date.parse('2026-07-07T15:00:00+08:00')).toISOString(),
        ended_at: new Date(Date.parse('2026-07-07T16:00:00+08:00')).toISOString(),
        meeting_no: '473388422',
      });
      expect(calendarMeeting).not.toHaveProperty('feishu_meeting_id');
      expect(result.sources.map((source) => source.feishu_meeting_id)).not.toContain('meeting_from_user_lookup');

      expect(JSON.parse(readFileSync(authPath, 'utf8')).token).toMatchObject({
        access_token: 'fresh_user_token',
        refresh_token: 'fresh_refresh_token',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes SDK meeting search cards into scheduled meeting sources', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: Date.parse('2026-07-07T00:00:00+08:00'),
        scope: 'vc:meeting.search:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
        if (url.endsWith('/open-apis/calendar/v4/calendars')) return jsonResponse({ code: 0, data: { calendar_list: [] } });
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '个人日历' } });
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) return jsonResponse({ code: 0, data: { items: [] } });
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) return jsonResponse({ code: 0, data: { items: [] } });
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const searchMeetingsWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          items: [{
            display_info: '电子纸&lt;-&gt;桌面客户端-&gt;三方软件 交互讨论\n云文档：智能纪要：电子纸&lt;-&gt;桌面客户端-&gt;三方软件 交互讨论 2026年7月2日\n7月2日 17:20 | 组织者：王辰炜 | ID: 153 186 537',
            id: '7657857535629855964',
            meta_data: { description: '7月2日 17:20 | 组织者：王辰炜 | ID: 153 186 537' },
          }],
        },
      }));

      const result = await fetchLarkMeetingSources({
        nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ searchMeetingsWithToken }),
      });

      expect(result.source_count).toBe(1);
      expect(result.sources[0]).toMatchObject({
        feishu_meeting_id: '7657857535629855964',
        meeting_no: '153186537',
        scheduled_at: '2026-07-02T09:20:00.000Z',
        title: '电子纸<->桌面客户端->三方软件 交互讨论',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses current user calendar events so scheduled meetings appear even when VC search is empty', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    const nowMs = Date.parse('2026-07-07T10:00:00+08:00');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: nowMs,
        scope: 'vc:meeting.search:read vc:meeting.meetingid:read calendar:calendar:read calendar:calendar.event:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
        if (url.endsWith('/open-apis/calendar/v4/calendars') && auth.includes('user_token')) {
          return jsonResponse({ code: 0, data: { calendar_list: [{ calendar_id: 'user_primary', summary: '张宇日历' }] } });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/user_primary/events') && auth.includes('user_token')) {
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                event_id: 'evt_current_weekly',
                summary: '出海创新周会',
                start_time: { timestamp: String(Date.parse('2026-07-07T11:00:00+08:00') / 1000) },
                end_time: { timestamp: String(Date.parse('2026-07-07T12:00:00+08:00') / 1000) },
                vchat: { meeting_url: 'https://vc.feishu.cn/j/473388422' },
              }],
              has_more: false,
            },
          });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars')) return jsonResponse({ code: 0, data: { calendar_list: [] } });
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '应用日历' } });
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) return jsonResponse({ code: 0, data: { items: [] } });
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) return jsonResponse({ code: 0, data: { items: [] } });
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const searchMeetingsWithToken = vi.fn(async () => ({ code: 0, data: { items: [] } }));

      const result = await fetchLarkMeetingSources({
        nowMs,
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ searchMeetingsWithToken }),
      });

      expect(result.errors.find((error) => error.source === 'user_calendar')).toBeUndefined();
      expect(result.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'user_calendar',
          title: '出海创新周会',
          status: 'upcoming',
          calendar_event_id: 'evt_current_weekly',
          meeting_no: '473388422',
        }),
      ]));
      expect(searchMeetingsWithToken).toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('expands weekly user calendar recurrence into the current occurrence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    const nowMs = Date.parse('2026-07-07T15:30:00+08:00');
    const firstStart = Date.parse('2026-06-09T15:00:00+08:00');
    const firstEnd = Date.parse('2026-06-09T16:00:00+08:00');
    const currentStart = Date.parse('2026-07-07T15:00:00+08:00');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: nowMs,
        scope: 'auth:user.id:read vc:meeting.search:read vc:meeting.meetingid:read calendar:calendar:read calendar:calendar.event:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
        if (url.endsWith('/open-apis/calendar/v4/calendars') && auth.includes('user_token')) {
          return jsonResponse({ code: 0, data: { calendar_list: [{ calendar_id: 'user_group_cal', summary: '张宇' }] } });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/user_group_cal/events') && auth.includes('user_token')) {
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                event_id: 'b886b858-4672-4843-abe5-26805f24c334_0',
                summary: '出海创新周会',
                start_time: { timestamp: String(firstStart / 1000), timezone: 'Asia/Shanghai' },
                end_time: { timestamp: String(firstEnd / 1000), timezone: 'Asia/Shanghai' },
                recurrence: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
                vchat: { meeting_url: 'https://vc.feishu.cn/j/473388422' },
              }],
            },
          });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars')) return jsonResponse({ code: 0, data: { calendar_list: [] } });
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '应用日历' } });
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) return jsonResponse({ code: 0, data: { items: [] } });
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) return jsonResponse({ code: 0, data: { items: [] } });
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const result = await fetchLarkMeetingSources({
        nowMs,
        lookbackSeconds: 2 * 24 * 60 * 60,
        lookaheadSeconds: 14 * 24 * 60 * 60,
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ searchMeetingsWithToken: vi.fn(async () => ({ code: 0, data: { items: [] } })) }),
      });

      expect(result.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'user_calendar',
          title: '出海创新周会',
          status: 'live',
          scheduled_at: new Date(currentStart).toISOString(),
          calendar_event_id: `b886b858-4672-4843-abe5-26805f24c334_${Math.floor(currentStart / 1000)}`,
          meeting_no: '473388422',
        }),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps calendar meetings visible shortly after planned end when no real VC end is known', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    const nowMs = Date.parse('2026-07-07T16:31:00+08:00');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: nowMs,
        scope: 'auth:user.id:read vc:meeting.search:read vc:meeting.meetingid:read calendar:calendar:read calendar:calendar.event:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
        if (url.endsWith('/open-apis/calendar/v4/calendars') && auth.includes('user_token')) {
          return jsonResponse({ code: 0, data: { calendar_list: [{ calendar_id: 'user_group_cal', summary: '张宇' }] } });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/user_group_cal/events') && auth.includes('user_token')) {
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                event_id: 'b886b858-4672-4843-abe5-26805f24c334_1783407600',
                summary: '出海创新周会',
                start_time: { timestamp: String(Date.parse('2026-07-07T15:00:00+08:00') / 1000), timezone: 'Asia/Shanghai' },
                end_time: { timestamp: String(Date.parse('2026-07-07T16:00:00+08:00') / 1000), timezone: 'Asia/Shanghai' },
                vchat: { meeting_url: 'https://vc.feishu.cn/j/473388422' },
              }],
              has_more: false,
            },
          });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars')) return jsonResponse({ code: 0, data: { calendar_list: [] } });
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '应用日历' } });
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) return jsonResponse({ code: 0, data: { items: [] } });
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) return jsonResponse({ code: 0, data: { items: [] } });
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const result = await fetchLarkMeetingSources({
        nowMs,
        env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret', LARK_MEETING_AUTH_STATE_PATH: authPath },
        createClient: () => ({ searchMeetingsWithToken: vi.fn(async () => ({ code: 0, data: { items: [] } })) }),
      });

      expect(result.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: 'user_calendar',
          title: '出海创新周会',
          status: 'live',
          scheduled_at: new Date(Date.parse('2026-07-07T15:00:00+08:00')).toISOString(),
          ended_at: new Date(Date.parse('2026-07-07T16:00:00+08:00')).toISOString(),
          meeting_no: '473388422',
        }),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fuses calendar ended with stale VC live from search for the same occurrence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-auth-'));
    const authPath = join(tempDir, 'auth-state.json');
    const nowMs = Date.parse('2026-07-07T19:15:00+08:00');
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: nowMs,
        scope: 'auth:user.id:read vc:meeting.search:read vc:meeting.meetingid:read calendar:calendar:read calendar:calendar.event:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));
    try {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || '');
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
          return jsonResponse({ code: 0, tenant_access_token: 'tenant_token' });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars') && auth.includes('user_token')) {
          return jsonResponse({
            code: 0,
            data: { calendar_list: [{ calendar_id: 'user_group_cal', summary: '张宇' }] },
          });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/user_group_cal/events') && auth.includes('user_token')) {
          return jsonResponse({
            code: 0,
            data: {
              items: [{
                event_id: 'b886b858-4672-4843-abe5-26805f24c334_1783407600',
                summary: '出海创新周会',
                start_time: {
                  timestamp: String(Date.parse('2026-07-07T15:00:00+08:00') / 1000),
                  timezone: 'Asia/Shanghai',
                },
                end_time: {
                  timestamp: String(Date.parse('2026-07-07T16:00:00+08:00') / 1000),
                  timezone: 'Asia/Shanghai',
                },
                vchat: { meeting_url: 'https://vc.feishu.cn/j/473388422' },
              }],
              has_more: false,
            },
          });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars')) {
          return jsonResponse({ code: 0, data: { calendar_list: [] } });
        }
        if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) {
          return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '应用日历' } });
        }
        if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) {
          return jsonResponse({ code: 0, data: { items: [] } });
        }
        if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
          return jsonResponse({ code: 0, data: { items: [] } });
        }
        return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
      });
      vi.stubGlobal('fetch', fetchImpl);

      const listMeetingsByNoWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          items: [{
            id: 'ignored_lookup_meeting',
            meeting_no: '473388422',
          }],
        },
      }));
      const listMeetingsByNo = vi.fn();
      const searchMeetingsWithToken = vi.fn(async () => ({
        code: 0,
        data: {
          items: [{
            id: '7659677460199738340',
            topic: '出海创新周会',
            meeting_no: '473388422',
            start_time: String(Date.parse('2026-07-07T15:01:00+08:00') / 1000),
          }],
        },
      }));

      const result = await fetchLarkMeetingSources({
        nowMs,
        lookbackSeconds: 7 * 24 * 60 * 60,
        lookaheadSeconds: 14 * 24 * 60 * 60,
        env: {
          FEISHU_APP_ID: 'cli_test',
          FEISHU_APP_SECRET: 'secret',
          LARK_MEETING_AUTH_STATE_PATH: authPath,
        },
        createClient: () => ({
          listMeetingsByNoWithToken,
          listMeetingsByNo,
          searchMeetingsWithToken,
        }),
      });

      expect(listMeetingsByNoWithToken).not.toHaveBeenCalled();
      expect(listMeetingsByNo).not.toHaveBeenCalled();
      expect(searchMeetingsWithToken).toHaveBeenCalledWith(
        'user_token',
        expect.objectContaining({
          page_size: 10,
          participant_ids: ['ou_ethan'],
        }),
      );

      const matches = result.sources.filter(
        (source) =>
          source.meeting_no === '473388422'
          && source.scheduled_at.slice(0, 10) === '2026-07-07',
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        source: 'lark_meeting_timeline',
        title: '出海创新周会',
        status: 'ended',
        scheduled_at: new Date(Date.parse('2026-07-07T15:00:00+08:00')).toISOString(),
        started_at: new Date(Date.parse('2026-07-07T15:01:00+08:00')).toISOString(),
        ended_at: new Date(Date.parse('2026-07-07T16:00:00+08:00')).toISOString(),
        meeting_no: '473388422',
        feishu_meeting_id: '7659677460199738340',
        calendar_event_id: 'b886b858-4672-4843-abe5-26805f24c334_1783407600',
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports missing configuration without calling Feishu or the SDK', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const createClient = vi.fn();

    const result = await fetchLarkMeetingSources({ env: {}, createClient });

    expect(result.configured).toBe(false);
    expect(result.errors[0]?.code).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('does not treat arbitrary long numbers in group messages as meetings', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars')) {
        return jsonResponse({ code: 0, data: { calendar_list: [] } });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars/primary')) {
        return jsonResponse({ code: 0, data: { calendar_id: 'primary', summary: '个人日历' } });
      }
      if (url.includes('/open-apis/calendar/v4/calendars/primary/events')) {
        return jsonResponse({ code: 0, data: { items: [], has_more: false } });
      }
      if (url.endsWith('/open-apis/im/v1/chats?page_size=100')) {
        return jsonResponse({ code: 0, data: { items: [{ chat_id: 'oc_1', name: '新闻群', chat_status: 'normal' }] } });
      }
      if (url.includes('/open-apis/im/v1/messages?')) {
        return jsonResponse({
          code: 0,
          data: { items: [{ message_id: 'om_news', msg_type: 'text', create_time: '1783562400000', body: { content: JSON.stringify({ text: '今日新闻编号 2247520467，不是会议。' }) } }] },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const listMeetingsByNo = vi.fn();
    const searchMeetings = vi.fn(async () => ({ code: 0, data: { items: [] } }));

    const result = await fetchLarkMeetingSources({
      nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      createClient: () => ({ listMeetingsByNo, searchMeetings }),
    });

    expect(listMeetingsByNo).not.toHaveBeenCalled();
    expect(result.sources).toEqual([]);
  });
});

describe('resolveLarkMeetingInstance', () => {
  const meetingNo = '123456789';
  const scheduledAt = '2026-07-07T10:00:00+08:00';
  const scheduledAtMs = Date.parse(scheduledAt);
  const nowMs = Date.parse('2026-07-07T08:00:00+08:00');
  const lookupOptions = {
    start_time: Math.floor(scheduledAtMs / 1000) - 6 * 60 * 60,
    end_time: Math.floor(scheduledAtMs / 1000) + 6 * 60 * 60,
    page_size: 10,
  };
  const tempDirs: string[] = [];

  function createTestEnv() {
    const tempDir = mkdtempSync(join(tmpdir(), 'inkloop-lark-resolve-'));
    tempDirs.push(tempDir);
    return {
      authPath: join(tempDir, 'auth-state.json'),
      env: {
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret',
        LARK_MEETING_AUTH_STATE_PATH: join(tempDir, 'auth-state.json'),
      },
    };
  }

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the real meeting id when list_by_no has exactly one candidate', async () => {
    const { env } = createTestEnv();
    const listMeetingsByNo = vi.fn(async () => ({
      code: 0,
      data: {
        meeting_briefs: [{
          id: '7659677460199738340',
          meeting_no: meetingNo,
          topic: '项目例会',
        }],
      },
    }));

    const result = await resolveLarkMeetingInstance(meetingNo, scheduledAt, {
      env,
      nowMs,
      createClient: () => ({ listMeetingsByNo }),
    });

    expect(listMeetingsByNo).toHaveBeenCalledTimes(1);
    expect(listMeetingsByNo).toHaveBeenCalledWith(meetingNo, lookupOptions);
    expect(result.meeting).toMatchObject({
      source_id: 'lark:7659677460199738340',
      source: 'lark_meeting_timeline',
      title: '项目例会',
      status: 'upcoming',
      scheduled_at: new Date(scheduledAtMs).toISOString(),
      start_time_reliable: false,
      meeting_no: meetingNo,
      feishu_meeting_id: '7659677460199738340',
    });
  });

  it('returns null when the same meeting number resolves to two candidates', async () => {
    const { env } = createTestEnv();
    const listMeetingsByNo = vi.fn(async () => ({
      code: 0,
      data: {
        meeting_briefs: [
          {
            id: '7659677460199738340',
            meeting_no: meetingNo,
            topic: '项目例会第一场',
          },
          {
            id: '7659677460199738341',
            meeting_no: meetingNo,
            topic: '项目例会第二场',
          },
        ],
      },
    }));

    const result = await resolveLarkMeetingInstance(meetingNo, scheduledAt, {
      env,
      nowMs,
      createClient: () => ({ listMeetingsByNo }),
    });

    expect(listMeetingsByNo).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ meeting: null });
  });

  it('throws status 400 for an invalid meeting number or scheduled time', async () => {
    const createClient = vi.fn();

    await expect(resolveLarkMeetingInstance('not-a-meeting-no', scheduledAt, {
      env: {},
      nowMs,
      createClient,
    })).rejects.toMatchObject({
      message: 'invalid meeting_no or scheduled_at',
      status: 400,
    });

    await expect(resolveLarkMeetingInstance(meetingNo, 'not-a-date', {
      env: {},
      nowMs,
      createClient,
    })).rejects.toMatchObject({
      message: 'invalid meeting_no or scheduled_at',
      status: 400,
    });

    expect(createClient).not.toHaveBeenCalled();
  });

  it('throws when list_by_no returns a non-zero code', async () => {
    const { env } = createTestEnv();
    const listMeetingsByNo = vi.fn(async () => ({
      code: 99991400,
      msg: 'list_by_no throttled',
    }));

    await expect(resolveLarkMeetingInstance(meetingNo, scheduledAt, {
      env,
      nowMs,
      createClient: () => ({ listMeetingsByNo }),
    })).rejects.toThrow('list_by_no throttled');

    expect(listMeetingsByNo).toHaveBeenCalledWith(meetingNo, lookupOptions);
  });

  it('falls back to the tenant lookup when the user-token lookup throws', async () => {
    const { env, authPath } = createTestEnv();
    writeFileSync(authPath, JSON.stringify({
      token: {
        access_token: 'user_token',
        expires_in: 7200,
        obtained_at_ms: nowMs,
        scope: 'vc:meeting.meetingid:read',
      },
      user: { data: { name: 'Ethan', open_id: 'ou_ethan' } },
    }));

    const listMeetingsByNoWithToken = vi.fn(async () => {
      throw new Error('user token lookup failed');
    });
    const listMeetingsByNo = vi.fn(async () => ({
      code: 0,
      data: {
        meeting_briefs: [{
          id: '7659677460199738340',
          meeting_no: meetingNo,
          topic: '租户身份可见会议',
        }],
      },
    }));

    const result = await resolveLarkMeetingInstance(meetingNo, scheduledAt, {
      env,
      nowMs,
      createClient: () => ({
        listMeetingsByNoWithToken,
        listMeetingsByNo,
      }),
    });

    expect(listMeetingsByNoWithToken).toHaveBeenCalledTimes(1);
    expect(listMeetingsByNoWithToken).toHaveBeenCalledWith(
      meetingNo,
      'user_token',
      lookupOptions,
    );
    expect(listMeetingsByNo).toHaveBeenCalledTimes(1);
    expect(listMeetingsByNo).toHaveBeenCalledWith(meetingNo, lookupOptions);
    expect(result.meeting).toMatchObject({
      meeting_no: meetingNo,
      feishu_meeting_id: '7659677460199738340',
      title: '租户身份可见会议',
    });
  });

  it('filters out a candidate whose meeting id equals the meeting number', async () => {
    const { env } = createTestEnv();
    const listMeetingsByNo = vi.fn(async () => ({
      code: 0,
      data: {
        meeting_briefs: [{
          id: meetingNo,
          meeting_no: meetingNo,
          topic: '只有短号的无效候选',
        }],
      },
    }));

    const result = await resolveLarkMeetingInstance(meetingNo, scheduledAt, {
      env,
      nowMs,
      createClient: () => ({ listMeetingsByNo }),
    });

    expect(listMeetingsByNo).toHaveBeenCalledWith(meetingNo, lookupOptions);
    expect(result).toEqual({ meeting: null });
  });
});
