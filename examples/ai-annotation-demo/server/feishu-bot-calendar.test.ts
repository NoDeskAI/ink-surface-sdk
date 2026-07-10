import { describe, expect, it, vi } from 'vitest';
import { fetchFeishuBotCalendarEvents } from './feishu-bot-calendar';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchFeishuBotCalendarEvents', () => {
  it('reports not_configured without calling Feishu', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchFeishuBotCalendarEvents({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.connected).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error?.code).toBe('not_configured');
  });

  it('returns a permission error with the Feishu permission URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      return jsonResponse({
        code: 99991672,
        msg: 'Access denied. https://open.feishu.cn/app/cli_test/auth?q=calendar:calendar:readonly&op_from=openapi&token_type=tenant',
      }, 400);
    });

    const result = await fetchFeishuBotCalendarEvents({
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.connected).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error?.code).toBe('missing_calendar_scope');
    expect(result.error?.permission_url).toContain('/app/cli_test/auth');
  });

  it('lists accessible calendars and normalizes upcoming events', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant_token', expire: 7200 });
      }
      if (url.endsWith('/open-apis/calendar/v4/calendars')) {
        return jsonResponse({ code: 0, data: { calendar_list: [{ calendar_id: 'cal_1', summary: '项目群日历' }] } });
      }
      if (url.includes('/open-apis/calendar/v4/calendars/cal_1/events')) {
        return jsonResponse({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                event_id: 'evt_later',
                summary: '晚一点的会议',
                start_time: { timestamp: '1783562400', timezone: 'Asia/Shanghai' },
                end_time: { timestamp: '1783566000', timezone: 'Asia/Shanghai' },
                vchat: { meeting_url: 'https://vc.feishu.cn/j/123456789' },
              },
              {
                event_id: 'evt_earlier',
                summary: '较早的会议',
                start_time: { timestamp: '1783558800', timezone: 'Asia/Shanghai' },
                end_time: { timestamp: '1783560600', timezone: 'Asia/Shanghai' },
              },
              {
                event_id: 'evt_cancelled',
                summary: '已取消会议',
                status: 'cancelled',
                start_time: { timestamp: '1783558800', timezone: 'Asia/Shanghai' },
              },
            ],
          },
        });
      }
      return jsonResponse({ code: 999, msg: `unexpected ${url}` }, 500);
    });

    const result = await fetchFeishuBotCalendarEvents({
      nowMs: Date.parse('2026-07-07T00:00:00+08:00'),
      env: { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.connected).toBe(true);
    expect(result.calendars).toEqual([{ calendar_id: 'cal_1', summary: '项目群日历' }]);
    expect(result.events.map((event) => event.event_id)).toEqual(['evt_earlier', 'evt_later']);
    expect(result.events[0]).toMatchObject({
      summary: '较早的会议',
      has_meeting: true,
      calendar_id: 'cal_1',
      source: 'bot_calendar',
    });
    expect(calls.some((url) => url.includes('start_time='))).toBe(true);
  });
});
