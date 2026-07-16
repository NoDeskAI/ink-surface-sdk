import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileLarkLiveMeetings, staleLiveLarkMeetings } from './lark-meeting-reconcile';
import { listLarkRealtimeMeetings, upsertLarkRealtimeMeeting } from './lark-realtime-meeting-store';

const NOW_MS = Date.parse('2026-07-15T22:45:00+08:00');

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'inkloop-lark-reconcile-'));
  vi.stubEnv('INKLOOP_LARK_REALTIME_MEETING_STORE', join(root, 'meetings.json'));
  return root;
}

function seedLiveMeeting(root: string, overrides: Record<string, unknown> = {}): void {
  upsertLarkRealtimeMeeting(root, {
    title: '晚上的飞书会议通过性测试',
    status: 'live',
    started_at: '2026-07-15T22:31:07+08:00',
    feishu_meeting_id: 'm_evening',
    owner_open_id: 'ou_owner',
    source_event_type: 'vc.meeting.all_meeting_started_v1',
    source_transport: 'lark_ws_event',
    ...overrides,
  }, Date.parse('2026-07-15T22:31:08+08:00'));
}

function vcMeetingResponse(status: number, endTime?: string): Response {
  return new Response(JSON.stringify({
    code: 0,
    data: { meeting: { id: 'm_evening', status, ...(endTime ? { end_time: endTime } : {}) } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('lark meeting reconcile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('marks a stale live meeting ended when VC REST reports status=3', async () => {
    const root = seedRoot();
    try {
      seedLiveMeeting(root);
      const fetchImpl = vi.fn(async () => vcMeetingResponse(3, '1784299500'));
      const controller = new AbortController();
      const result = await reconcileLarkLiveMeetings({
        root,
        nowMs: NOW_MS,
        resolveUserToken: async (openId) => (openId === 'ou_owner' ? 'token_owner' : ''),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: controller.signal,
      });

      expect(result).toMatchObject({ checked: 1, ended: 1, still_live: 0, skipped: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/open-apis/vc/v1/meetings/m_evening');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer token_owner');
      expect(init.signal).toBe(controller.signal);

      const [record] = listLarkRealtimeMeetings(root, { nowMs: NOW_MS });
      expect(record.status).toBe('ended');
      expect(record.ended_at).toBe(new Date(1784299500 * 1000).toISOString());
      expect(record.source_transport).toBe('lark_rest_reconcile');
      expect(record.started_at).toBe(new Date('2026-07-15T22:31:07+08:00').toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves genuinely live meetings untouched and reports still_live', async () => {
    const root = seedRoot();
    try {
      seedLiveMeeting(root);
      const result = await reconcileLarkLiveMeetings({
        root,
        nowMs: NOW_MS,
        resolveUserToken: async () => 'token_owner',
        fetchImpl: (async () => vcMeetingResponse(2)) as unknown as typeof fetch,
      });

      expect(result).toMatchObject({ checked: 1, ended: 0, still_live: 1 });
      expect(listLarkRealtimeMeetings(root, { nowMs: NOW_MS })[0].status).toBe('live');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips meetings without a usable token and surfaces API failures without flipping status', async () => {
    const root = seedRoot();
    try {
      seedLiveMeeting(root, { feishu_meeting_id: 'm_no_token', owner_open_id: 'ou_gone' });
      seedLiveMeeting(root, { feishu_meeting_id: 'm_api_fail', owner_open_id: 'ou_owner', started_at: '2026-07-15T22:20:00+08:00' });
      const result = await reconcileLarkLiveMeetings({
        root,
        nowMs: NOW_MS,
        resolveUserToken: async (openId) => (openId === 'ou_owner' ? 'token_owner' : ''),
        fetchImpl: (async () => new Response(JSON.stringify({ code: 99991672, msg: 'no permission' }), { status: 200 })) as unknown as typeof fetch,
      });

      expect(result.checked).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.ended).toBe(0);
      expect(result.errors.some((error) => error.includes('no_usable_token'))).toBe(true);
      expect(result.errors.some((error) => error.includes('vc_get_failed code=99991672'))).toBe(true);
      for (const record of listLarkRealtimeMeetings(root, { nowMs: NOW_MS })) {
        expect(record.status).toBe('live');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores meetings younger than minLiveAgeMs and non-live records', () => {
    const root = seedRoot();
    try {
      seedLiveMeeting(root, { feishu_meeting_id: 'm_fresh', started_at: new Date(NOW_MS - 30_000).toISOString() });
      seedLiveMeeting(root, { feishu_meeting_id: 'm_done', status: 'ended', ended_at: new Date(NOW_MS - 60_000).toISOString() });
      const stale = staleLiveLarkMeetings(root, NOW_MS, 90_000);
      expect(stale).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
