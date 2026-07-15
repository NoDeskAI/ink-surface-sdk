import { describe, expect, it, vi } from 'vitest';
import type { PersistedMeeting, PersistedWorkspace } from '../core/store-format';
import type { GoogleMeetingLiveWindow, GoogleMeetingSource } from '../integration/google-meet/client';
import { syncGoogleMeetingLiveState, syncGoogleMeetingSources } from './google-meeting-sync';

const NOW = Date.parse('2026-07-14T08:00:00.000Z');

function meeting(id: string, patch: Partial<PersistedMeeting> = {}): PersistedMeeting {
  return {
    meeting_id: id,
    workspace_id: 'ws_schedule',
    title: id,
    scheduled_at: '2026-07-15T01:00:00.000Z',
    status: 'upcoming',
    material_doc_ids: [],
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
    ...patch,
  };
}

function source(id: string, patch: Partial<GoogleMeetingSource> = {}): GoogleMeetingSource {
  return {
    platform: 'google_meet',
    calendar_event_id: id,
    title: `Google ${id}`,
    scheduled_at: '2026-07-15T01:00:00.000Z',
    scheduled_end_at: '2026-07-15T02:00:00.000Z',
    meeting_code: 'abc-defg-hij',
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    status: 'confirmed',
    ...patch,
  };
}

function liveWindow(patch: Partial<GoogleMeetingLiveWindow> = {}): GoogleMeetingLiveWindow {
  return {
    platform: 'google_meet',
    meeting_id: 'abc-defg-hij',
    meeting_code: 'abc-defg-hij',
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    title: 'Google live window',
    started_at_ms: Date.parse('2026-07-15T01:02:00.000Z'),
    detector_source: 'meeting_app_extension',
    updated_at: '2026-07-15T01:02:01.000Z',
    ...patch,
  };
}

function dependencies(initial: PersistedMeeting[]) {
  const meetings = [...initial];
  const schedule: PersistedWorkspace = {
    workspace_id: 'ws_schedule',
    name: '日程',
    source: 'manual',
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
  };
  const updateMeeting = vi.fn(async (id: string, patch: Partial<PersistedMeeting>) => {
    const index = meetings.findIndex((item) => item.meeting_id === id);
    if (index < 0) return null;
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
      upsertScheduleWorkspace: async () => schedule,
      createMeeting,
      updateMeeting,
      nowMs: NOW,
    },
    createMeeting,
    updateMeeting,
  };
}

describe('Google meeting source persistence', () => {
  it('maps Calendar identity and meeting code without claiming a provider meeting instance', async () => {
    const state = dependencies([]);

    const result = await syncGoogleMeetingSources([source('google-event-1')], state.deps);

    expect(result).toEqual({ imported: 1, updated: 0, cancelled: 0 });
    expect(state.meetings[0]).toMatchObject({
      platform: 'google_meet',
      provider_calendar_event_id: 'google-event-1',
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      calendar_meeting_no: 'abc-defg-hij',
      source_kind: 'calendar',
      workspace_id: 'ws_schedule',
      status: 'upcoming',
    });
    expect(state.meetings[0]).not.toHaveProperty('provider_meeting_id');
    expect(state.meetings[0]).not.toHaveProperty('provider_space_name');
  });

  it('keeps equal Lark and Google event ids separate and deduplicates the Google instance', async () => {
    const lark = meeting('lark-1', { platform: 'lark', feishu_calendar_event_id: 'shared-event' });
    const state = dependencies([lark]);

    await syncGoogleMeetingSources([source('shared-event')], state.deps);
    await syncGoogleMeetingSources([source('shared-event', { title: 'Updated Google title' })], state.deps);

    expect(state.createMeeting).toHaveBeenCalledTimes(1);
    expect(state.meetings).toHaveLength(2);
    expect(state.meetings.find((item) => item.meeting_id === 'lark-1')).toMatchObject({
      platform: 'lark',
      feishu_calendar_event_id: 'shared-event',
      title: 'lark-1',
    });
    expect(state.meetings.find((item) => item.platform === 'google_meet')).toMatchObject({
      provider_calendar_event_id: 'shared-event',
      title: 'Updated Google title',
    });
  });

  it('moves cancelled Google instances to history and ignores unknown cancellations', async () => {
    const google = meeting('google-existing', {
      platform: 'google_meet',
      provider_calendar_event_id: 'cancel-me',
    });
    const lark = meeting('lark-same-id', {
      platform: 'lark',
      feishu_calendar_event_id: 'unknown-cancel',
    });
    const state = dependencies([google, lark]);

    const result = await syncGoogleMeetingSources([
      source('cancel-me', { status: 'cancelled' }),
      source('unknown-cancel', { status: 'cancelled' }),
    ], state.deps);

    expect(result).toEqual({ imported: 0, updated: 1, cancelled: 1 });
    expect(state.meetings.find((item) => item.meeting_id === 'google-existing')).toMatchObject({
      status: 'ended',
      ended_at: '2026-07-15T02:00:00.000Z',
    });
    expect(state.meetings.find((item) => item.meeting_id === 'lark-same-id')?.status).toBe('upcoming');
  });

  it('preserves the alignment anchor when a live meeting ends', async () => {
    const google = meeting('google-live', {
      platform: 'google_meet',
      provider_calendar_event_id: 'live-then-ended',
      status: 'live',
      started_at: '2026-07-14T06:05:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-14T06:05:00.000Z'),
      t0_source: 'calendar',
      align_state: 'estimated',
    });
    const state = dependencies([google]);

    await syncGoogleMeetingSources([source('live-then-ended', {
      scheduled_at: '2026-07-14T06:00:00.000Z',
      scheduled_end_at: '2026-07-14T07:00:00.000Z',
    })], state.deps);

    expect(state.meetings[0]).toMatchObject({
      status: 'ended',
      ended_at: '2026-07-14T07:00:00.000Z',
      started_at: '2026-07-14T06:05:00.000Z',
      t0_source: 'calendar',
      align_state: 'estimated',
    });
  });

  it('does not overwrite an existing start anchor while the meeting stays live', async () => {
    const google = meeting('google-live-anchor', {
      platform: 'google_meet',
      provider_calendar_event_id: 'still-live',
      status: 'live',
      started_at: '2026-07-14T07:10:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-14T07:10:00.000Z'),
      t0_source: 'calendar',
      align_state: 'estimated',
    });
    const state = dependencies([google]);

    await syncGoogleMeetingSources([source('still-live', {
      scheduled_at: '2026-07-14T07:00:00.000Z',
      scheduled_end_at: '2026-07-14T09:00:00.000Z',
    })], state.deps);

    expect(state.meetings[0]).toMatchObject({
      status: 'live',
      started_at: '2026-07-14T07:10:00.000Z',
    });
  });

  it('clears stale calendar timing when an ended occurrence is rescheduled', async () => {
    const google = meeting('google-rescheduled', {
      platform: 'google_meet',
      provider_calendar_event_id: 'rescheduled',
      status: 'ended',
      started_at: '2026-07-13T01:00:00.000Z',
      ended_at: '2026-07-13T02:00:00.000Z',
      t0_source: 'calendar',
      align_state: 'estimated',
    });
    const state = dependencies([google]);

    await syncGoogleMeetingSources([source('rescheduled')], state.deps);

    expect(state.meetings[0]).toMatchObject({ status: 'upcoming' });
    expect(state.meetings[0].started_at).toBeUndefined();
    expect(state.meetings[0].ended_at).toBeUndefined();
    expect(state.meetings[0].t0_source).toBeUndefined();
    expect(state.meetings[0].align_state).toBeUndefined();
  });

  it('merges detector start/end windows into the matching Google Calendar card', async () => {
    const google = meeting('google-live-state', {
      platform: 'google_meet',
      calendar_meeting_no: 'abc-defg-hij',
      status: 'ended',
      ended_at: '2026-07-15T00:30:00.000Z',
    });
    const state = dependencies([google]);
    const endedAtMs = Date.parse('2026-07-15T01:55:00.000Z');

    const result = await syncGoogleMeetingLiveState([
      liveWindow(),
      liveWindow({ ended_at_ms: endedAtMs, updated_at: '2026-07-15T01:55:01.000Z' }),
    ], state.deps);

    expect(result).toEqual({ matched: 2, updated: 2 });
    expect(state.meetings[0]).toMatchObject({
      status: 'ended',
      started_at: '2026-07-15T01:02:00.000Z',
      ended_at: '2026-07-15T01:55:00.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-15T01:02:00.000Z'),
      t0_source: 'local_detector',
      align_state: 'estimated',
    });
    expect(state.meetings[0]).not.toHaveProperty('provider_meeting_id');
  });

  it('clears an old detector end when the same Calendar occurrence becomes active again', async () => {
    const google = meeting('google-rejoined', {
      platform: 'google_meet',
      calendar_meeting_no: 'abc-defg-hij',
      status: 'ended',
      ended_at: '2026-07-15T00:50:00.000Z',
    });
    const state = dependencies([google]);

    await syncGoogleMeetingLiveState([liveWindow()], state.deps);

    expect(state.meetings[0]).toMatchObject({ status: 'live', t0_source: 'local_detector' });
    expect(state.meetings[0].ended_at).toBeUndefined();
  });

  it('does not downgrade a provider event anchor and ignores an unmatched detector window', async () => {
    const providerAnchored = meeting('google-provider-anchor', {
      platform: 'google_meet',
      calendar_meeting_no: 'abc-defg-hij',
      started_at: '2026-07-15T01:00:30.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-15T01:00:30.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
    const state = dependencies([providerAnchored]);

    const result = await syncGoogleMeetingLiveState([
      liveWindow(),
      liveWindow({ meeting_id: 'zzz-yyyy-xxx', meeting_code: 'zzz-yyyy-xxx' }),
    ], state.deps);

    expect(result).toEqual({ matched: 1, updated: 1 });
    expect(state.meetings[0]).toMatchObject({
      status: 'live',
      started_at: '2026-07-15T01:00:30.000Z',
      vc_meeting_start_t0: Date.parse('2026-07-15T01:00:30.000Z'),
      t0_source: 'provider_event',
      align_state: 'event',
    });
  });
});
