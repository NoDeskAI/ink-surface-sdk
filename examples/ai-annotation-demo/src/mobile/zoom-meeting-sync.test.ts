import { describe, expect, it, vi } from 'vitest';
import type { PersistedMeeting, PersistedWorkspace } from '../core/store-format';
import type { ZoomMeetingLiveWindow, ZoomMeetingSource } from '../integration/zoom/client';
import { syncZoomMeetingLiveState, syncZoomMeetingSources } from './zoom-meeting-sync';

const NOW = Date.parse('2026-07-17T08:00:00.000Z');

function meeting(id: string, patch: Partial<PersistedMeeting> = {}): PersistedMeeting {
  return {
    meeting_id: id,
    workspace_id: 'ws_schedule',
    title: id,
    scheduled_at: '2026-07-18T01:00:00.000Z',
    status: 'upcoming',
    material_doc_ids: [],
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
    ...patch,
  };
}

function source(id: string, patch: Partial<ZoomMeetingSource> = {}): ZoomMeetingSource {
  return {
    platform: 'zoom',
    meeting_id: id,
    topic: `Zoom ${id}`,
    scheduled_at: '2026-07-18T01:00:00.000Z',
    duration_minutes: 45,
    join_url: `https://zoom.us/j/${id}?pwd=calendar-secret`,
    host_user_id: 'host-1',
    ...patch,
  };
}

function liveWindow(patch: Partial<ZoomMeetingLiveWindow> = {}): ZoomMeetingLiveWindow {
  return {
    platform: 'zoom',
    meeting_id: '987654321',
    external_meeting_id: 'zoom-session-uuid',
    meeting_url: 'https://acme.zoom.us/j/987654321',
    title: 'Zoom live window',
    started_at_ms: Date.parse('2026-07-18T01:02:00.000Z'),
    detector_source: 'meeting_app_extension',
    updated_at: '2026-07-18T01:02:01.000Z',
    ...patch,
  };
}

function dependencies(initial: PersistedMeeting[]) {
  const meetings = [...initial];
  const schedule: PersistedWorkspace = {
    workspace_id: 'ws_schedule',
    name: '日程',
    source: 'manual',
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  };
  const upsertScheduleWorkspace = vi.fn(async () => schedule);
  const updateMeeting = vi.fn(async (id: string, patch: Partial<PersistedMeeting>) => {
    const index = meetings.findIndex((item) => item.meeting_id === id);
    if (index < 0) return null;
    meetings[index] = { ...meetings[index], ...patch, updated_at: new Date(NOW).toISOString() };
    return meetings[index];
  });
  const mutateMeeting = vi.fn(async (id: string, mutator: (current: PersistedMeeting) => Partial<PersistedMeeting> | null) => {
    const index = meetings.findIndex((item) => item.meeting_id === id);
    if (index < 0) return null;
    const patch = mutator(meetings[index]);
    if (!patch) return null;
    meetings[index] = { ...meetings[index], ...patch, updated_at: new Date(NOW).toISOString() };
    return meetings[index];
  });
  let seq = 0;
  const createMeeting = vi.fn(async (workspaceId: string, input: { title: string; scheduled_at: string; status?: PersistedMeeting['status'] }) => {
    const created = meeting(`created-${++seq}`, { workspace_id: workspaceId, ...input, status: input.status || 'upcoming' });
    meetings.push(created);
    return created;
  });
  return {
    meetings,
    deps: {
      listAllMeetings: async () => [...meetings],
      upsertScheduleWorkspace,
      createMeeting,
      updateMeeting,
      mutateMeeting,
      nowMs: NOW,
    },
    upsertScheduleWorkspace,
    createMeeting,
    updateMeeting,
    mutateMeeting,
  };
}

describe('Zoom meeting source persistence', () => {
  it('creates a schedule card with the logical meeting id and no UUID session key', async () => {
    const state = dependencies([]);

    const result = await syncZoomMeetingSources([source('987654321')], state.deps);

    expect(result).toEqual({ imported: 1, updated: 0 });
    expect(state.upsertScheduleWorkspace).toHaveBeenCalledTimes(1);
    expect(state.meetings[0]).toMatchObject({
      platform: 'zoom',
      workspace_id: 'ws_schedule',
      provider_space_name: '987654321',
      meeting_url: 'https://zoom.us/j/987654321?pwd=calendar-secret',
      scheduled_at: '2026-07-18T01:00:00.000Z',
      duration: 45,
      topic: 'Zoom 987654321',
      title: 'Zoom 987654321',
      source_kind: 'calendar',
      status: 'upcoming',
    });
    expect(state.meetings[0]).not.toHaveProperty('provider_meeting_id');
  });

  it('keeps equal Lark and Google ids separate while deduplicating the Zoom card', async () => {
    const lark = meeting('lark', { platform: 'lark', provider_space_name: '987654321' });
    const google = meeting('google', { platform: 'google_meet', provider_space_name: '987654321' });
    const state = dependencies([lark, google]);

    await syncZoomMeetingSources([source('987654321')], state.deps);
    await syncZoomMeetingSources([source('987654321', { topic: 'Updated Zoom topic' })], state.deps);

    expect(state.createMeeting).toHaveBeenCalledTimes(1);
    expect(state.meetings).toHaveLength(3);
    expect(state.meetings.find((item) => item.meeting_id === 'lark')?.title).toBe('lark');
    expect(state.meetings.find((item) => item.meeting_id === 'google')?.title).toBe('google');
    expect(state.meetings.find((item) => item.platform === 'zoom')).toMatchObject({
      provider_space_name: '987654321',
      title: 'Updated Zoom topic',
    });
  });

  it('does not create missing sources or mutate an existing card marked missing', async () => {
    const existing = meeting('zoom-existing', {
      platform: 'zoom',
      provider_space_name: '987654321',
      title: 'Keep this title',
    });
    const state = dependencies([existing]);

    const result = await syncZoomMeetingSources([
      source('987654321', { topic: 'Do not apply', missing_since: '2026-07-17T07:00:00.000Z' }),
      source('123456789', { missing_since: '2026-07-17T07:00:00.000Z' }),
    ], state.deps);

    expect(result).toEqual({ imported: 0, updated: 0 });
    expect(state.createMeeting).not.toHaveBeenCalled();
    expect(state.updateMeeting).not.toHaveBeenCalled();
    expect(state.upsertScheduleWorkspace).not.toHaveBeenCalled();
    expect(state.meetings[0].title).toBe('Keep this title');
  });

  it('preserves a live start anchor, then clears stale session fields when rescheduled', async () => {
    const existing = meeting('zoom-rescheduled', {
      platform: 'zoom',
      provider_space_name: '987654321',
      status: 'live',
      started_at: '2026-07-17T07:10:00.000Z',
      ended_at: '2026-07-17T07:50:00.000Z',
      provider_meeting_id: 'zoom-uuid-p2',
      provider_transcript_ref: 'transcript-p2',
      provider_participants: [{
        name: '旧场成员', identity: 'signed_in',
        joined_at: '2026-07-17T07:10:00.000Z', left_at: '2026-07-17T07:50:00.000Z',
      }],
      vc_meeting_start_t0: Date.parse('2026-07-17T07:10:00.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
    const state = dependencies([existing]);

    await syncZoomMeetingSources([source('987654321', {
      scheduled_at: '2026-07-17T07:00:00.000Z',
      duration_minutes: 120,
    })], state.deps);
    expect(state.meetings[0]).toMatchObject({
      status: 'live',
      started_at: '2026-07-17T07:10:00.000Z',
      t0_source: 'provider_event',
    });

    await syncZoomMeetingSources([source('987654321', {
      scheduled_at: '2026-07-20T07:00:00.000Z',
    })], state.deps);
    expect(state.meetings[0]).toMatchObject({
      status: 'upcoming',
      provider_space_name: '987654321',
      scheduled_at: '2026-07-20T07:00:00.000Z',
    });
    expect(state.meetings[0].started_at).toBeUndefined();
    expect(state.meetings[0].ended_at).toBeUndefined();
    expect(state.meetings[0].provider_meeting_id).toBeUndefined();
    expect(state.meetings[0].provider_transcript_ref).toBeUndefined();
    expect(state.meetings[0].provider_participants).toBeUndefined();
    expect(state.meetings[0].t0_source).toBeUndefined();
  });

  it('按事务内当前值计算并保留并发写入的转写锚点', async () => {
    const current = meeting('zoom-concurrent', {
      platform: 'zoom',
      provider_space_name: '987654321',
      started_at: '2026-07-17T07:02:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-17T07:02:00.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
    const state = dependencies([current]);
    state.deps.listAllMeetings = async () => [{
      ...current,
      started_at: undefined,
      vc_meeting_start_t0: undefined,
      t0_source: undefined,
      align_state: undefined,
    }];

    await syncZoomMeetingSources([source('987654321', {
      scheduled_at: '2026-07-17T07:00:00.000Z',
      duration_minutes: 120,
    })], state.deps);

    expect(state.meetings[0]).toMatchObject({
      started_at: '2026-07-17T07:02:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-17T07:02:00.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
  });

  it('does not replace an actual provider end with the scheduled end', async () => {
    const actualEnd = '2026-07-17T07:42:00.000Z';
    const state = dependencies([meeting('zoom-actual-end', {
      platform: 'zoom',
      provider_space_name: '987654321',
      scheduled_at: '2026-07-17T06:00:00.000Z',
      status: 'ended',
      ended_at: actualEnd,
      t0_source: 'provider_event',
    })]);

    await syncZoomMeetingSources([source('987654321', {
      scheduled_at: '2026-07-17T06:00:00.000Z',
      duration_minutes: 60,
    })], state.deps);

    expect(state.meetings[0].ended_at).toBe(actualEnd);
  });
});

describe('Zoom MTL live window merge', () => {
  it('matches by numeric meeting id and merges live then ended state', async () => {
    const zoom = meeting('zoom-live', {
      platform: 'zoom',
      provider_space_name: '987654321',
      meeting_url: 'https://zoom.us/j/987654321?pwd=calendar-secret',
    });
    const state = dependencies([zoom]);
    const endedAt = Date.parse('2026-07-18T01:55:00.000Z');

    const result = await syncZoomMeetingLiveState([
      liveWindow(),
      liveWindow({ ended_at_ms: endedAt, updated_at: '2026-07-18T01:55:01.000Z' }),
    ], state.deps);

    expect(result).toEqual({ matched: 2, updated: 2 });
    expect(state.meetings[0]).toMatchObject({
      status: 'ended',
      started_at: '2026-07-18T01:02:00.000Z',
      ended_at: '2026-07-18T01:55:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:02:00.000Z'),
      t0_source: 'local_detector',
      align_state: 'estimated',
    });
  });

  it('falls back through normalized join URL and scheduled time without crossing platforms', async () => {
    const zoomByUrl = meeting('zoom-url', {
      platform: 'zoom',
      meeting_url: 'https://acme.zoom.us/j/222333444?pwd=calendar-secret',
      scheduled_at: '2026-07-18T05:00:00.000Z',
    });
    const zoomByTime = meeting('zoom-time', {
      platform: 'zoom',
      scheduled_at: '2026-07-18T09:05:00.000Z',
    });
    const larkSameId = meeting('lark-same-id', {
      platform: 'lark',
      provider_space_name: '222333444',
      scheduled_at: '2026-07-18T05:00:00.000Z',
    });
    const googleSameId = meeting('google-same-id', {
      platform: 'google_meet',
      provider_space_name: '222333444',
      scheduled_at: '2026-07-18T09:00:00.000Z',
    });
    const state = dependencies([zoomByUrl, zoomByTime, larkSameId, googleSameId]);

    const result = await syncZoomMeetingLiveState([
      liveWindow({
        meeting_id: 'extension-local-id',
        external_meeting_id: 'zoom-uuid',
        meeting_url: 'https://acme.zoom.us/j/222333444',
        started_at_ms: Date.parse('2026-07-18T05:02:00.000Z'),
      }),
      liveWindow({
        meeting_id: 'extension-local-id-2',
        external_meeting_id: 'zoom-uuid-2',
        meeting_url: undefined,
        started_at_ms: Date.parse('2026-07-18T09:00:00.000Z'),
        updated_at: '2026-07-18T09:00:01.000Z',
      }),
    ], state.deps);

    expect(result).toEqual({ matched: 2, updated: 2 });
    expect(state.meetings.find((item) => item.meeting_id === 'zoom-url')?.status).toBe('live');
    expect(state.meetings.find((item) => item.meeting_id === 'zoom-time')?.status).toBe('live');
    expect(state.meetings.find((item) => item.meeting_id === 'lark-same-id')?.status).toBe('upcoming');
    expect(state.meetings.find((item) => item.meeting_id === 'google-same-id')?.status).toBe('upcoming');
  });

  it('preserves stronger provider anchors and ignores unknown or non-Zoom windows', async () => {
    const providerAnchored = meeting('zoom-provider-anchor', {
      platform: 'zoom',
      provider_space_name: '987654321',
      started_at: '2026-07-18T01:00:30.000Z',
      ended_at: '2026-07-18T01:50:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:00:30.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
    const state = dependencies([providerAnchored]);

    const result = await syncZoomMeetingLiveState([
      liveWindow(),
      liveWindow({ platform: 'google_meet' }),
      liveWindow({
        meeting_id: 'unknown',
        external_meeting_id: 'unknown',
        meeting_url: undefined,
        started_at_ms: Date.parse('2026-07-19T20:00:00.000Z'),
      }),
    ], state.deps);

    expect(result).toEqual({ matched: 1, updated: 1 });
    expect(state.meetings[0]).toMatchObject({
      status: 'live',
      started_at: '2026-07-18T01:00:30.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-18T01:00:30.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
    expect(state.meetings[0].ended_at).toBeUndefined();
  });

  it('decides detector writes from the transactional meeting value, not the stale matching snapshot', async () => {
    const actualEnd = '2026-07-18T01:50:00.000Z';
    const current = meeting('zoom-cas-anchor', {
      platform: 'zoom',
      provider_space_name: '987654321',
      ended_at: actualEnd,
      t0_source: 'provider_event',
    });
    const state = dependencies([current]);
    state.deps.listAllMeetings = async () => [{ ...current, ended_at: undefined, t0_source: 'local_detector' }];

    await syncZoomMeetingLiveState([liveWindow({ ended_at_ms: Date.parse('2026-07-18T01:55:00.000Z') })], state.deps);

    expect(state.meetings[0].ended_at).toBe(actualEnd);
  });
});
