import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  larkRealtimeMeetingSources,
  larkRealtimeMeetingStoreStatus,
  upsertLarkRealtimeMeeting,
} from './lark-realtime-meeting-store';

describe('lark realtime meeting store', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('persists a live Feishu meeting source and updates the same meeting to ended', () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-lark-realtime-'));
    vi.stubEnv('INKLOOP_LARK_REALTIME_MEETING_STORE', join(root, 'meetings.json'));
    try {
      const live = upsertLarkRealtimeMeeting(root, {
        title: '出海即时会议',
        status: 'live',
        started_at: '2026-07-09T13:45:00+08:00',
        meeting_url: 'https://vc.feishu.cn/j/153186537',
        feishu_meeting_id: 'm_1',
        source_event_type: 'vc.meeting.all_meeting_started_v1',
        source_event_id: 'evt_start',
        source_transport: 'lark_ws_event',
      }, Date.parse('2026-07-09T13:45:10+08:00'));

      expect(live.status).toBe('live');
      expect(larkRealtimeMeetingSources(root, {
        nowMs: Date.parse('2026-07-09T13:46:00+08:00'),
      })).toEqual([expect.objectContaining({
        source: 'lark_meeting_timeline',
        title: '出海即时会议',
        status: 'live',
        meeting_no: '153186537',
        feishu_meeting_id: 'm_1',
      })]);

      const ended = upsertLarkRealtimeMeeting(root, {
        title: '出海即时会议',
        status: 'ended',
        started_at: '2026-07-09T13:45:00+08:00',
        ended_at: '2026-07-09T14:20:00+08:00',
        meeting_url: 'https://vc.feishu.cn/j/153186537',
        feishu_meeting_id: 'm_1',
        source_event_type: 'vc.meeting.all_meeting_ended_v1',
        source_event_id: 'evt_end',
        source_transport: 'lark_ws_event',
      }, Date.parse('2026-07-09T14:20:05+08:00'));

      expect(ended.id).toBe(live.id);
      expect(ended.status).toBe('ended');
      expect(larkRealtimeMeetingStoreStatus(root)).toMatchObject({ count: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
