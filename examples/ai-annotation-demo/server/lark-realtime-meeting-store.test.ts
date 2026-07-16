import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const storePath = join(root, 'meetings.json');
    vi.stubEnv('INKLOOP_LARK_REALTIME_MEETING_STORE', storePath);
    try {
      const live = upsertLarkRealtimeMeeting(root, {
        title: '出海即时会议',
        status: 'live',
        started_at: '2026-07-09T13:45:00+08:00',
        meeting_url: 'https://vc.feishu.cn/j/153186537',
        feishu_meeting_id: 'm_1',
        owner_open_id: 'ou_owner',
        participant_open_ids: ['ou_alice'],
        source_event_type: 'vc.meeting.all_meeting_started_v1',
        source_event_id: 'evt_start',
        source_transport: 'lark_ws_event',
      }, Date.parse('2026-07-09T13:45:10+08:00'));

      expect(live.status).toBe('live');
      expect(live.owner_open_id).toBe('ou_owner');
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
        participant_open_ids: ['ou_alice', 'ou_bob', 'ou_bob'],
        source_event_type: 'vc.meeting.all_meeting_ended_v1',
        source_event_id: 'evt_end',
        source_transport: 'lark_ws_event',
      }, Date.parse('2026-07-09T14:20:05+08:00'));

      expect(ended.id).toBe(live.id);
      expect(ended.status).toBe('ended');
      expect(ended.owner_open_id).toBe('ou_owner');
      expect(ended.participant_open_ids).toEqual(['ou_alice', 'ou_bob']);
      expect(larkRealtimeMeetingStoreStatus(root)).toMatchObject({ count: 1 });
      expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({
        schema_version: 'inkloop.lark_realtime_meetings.v1',
        meetings: [expect.objectContaining({
          owner_open_id: 'ou_owner',
          participant_open_ids: ['ou_alice', 'ou_bob'],
        })],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters realtime meetings by owner or historical participant while preserving demo-auth visibility', () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-lark-realtime-'));
    vi.stubEnv('INKLOOP_LARK_REALTIME_MEETING_STORE', join(root, 'meetings.json'));
    try {
      const base = {
        status: 'live',
        started_at: '2026-07-09T13:45:00+08:00',
        source_transport: 'lark_ws_event' as const,
      };
      upsertLarkRealtimeMeeting(root, {
        ...base,
        title: 'Owner match',
        feishu_meeting_id: 'm_owner',
        owner_open_id: 'ou_current',
      });
      upsertLarkRealtimeMeeting(root, {
        ...base,
        title: 'Participant match',
        feishu_meeting_id: 'm_participant',
        owner_open_id: 'ou_other',
        participant_open_ids: ['ou_current'],
      });
      upsertLarkRealtimeMeeting(root, {
        ...base,
        title: 'Unrelated',
        feishu_meeting_id: 'm_unrelated',
        owner_open_id: 'ou_other',
        participant_open_ids: ['ou_someone_else'],
      });
      upsertLarkRealtimeMeeting(root, {
        ...base,
        title: 'No identity',
        feishu_meeting_id: 'm_no_identity',
      });

      const nowMs = Date.parse('2026-07-09T13:46:00+08:00');
      expect(larkRealtimeMeetingSources(root, { nowMs, userOpenIds: ['ou_current'] }).map((item) => item.title).sort()).toEqual([
        'Owner match',
        'Participant match',
      ]);
      expect(larkRealtimeMeetingSources(root, { nowMs, userOpenIds: ['ou_missing'] })).toEqual([]);
      expect(larkRealtimeMeetingSources(root, { nowMs })).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
