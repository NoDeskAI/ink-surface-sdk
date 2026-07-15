import { describe, expect, it } from 'vitest';
import { meetingInputFromEvent } from './lark-ws-meeting-events';

describe('Lark WS meeting identity extraction', () => {
  it.each([
    ['owner', { owner: { id: { open_id: 'ou_owner' }, user_type: 1 } }],
    ['host_user', { host_user: { id: { open_id: 'ou_host' }, user_type: 1 } }],
  ])('extracts the meeting %s open_id', (_field, identity) => {
    const input = meetingInputFromEvent({
      meeting: {
        id: 'm_started',
        topic: 'Identity meeting',
        start_time: '1783595100',
        ...identity,
      },
    }, 'vc.meeting.all_meeting_started_v1', Date.parse('2026-07-09T13:45:10+08:00'));

    expect(input).toEqual(expect.objectContaining({
      owner_open_id: _field === 'owner' ? 'ou_owner' : 'ou_host',
      status: 'live',
    }));
  });

  it.each([
    'vc.meeting.join_meeting_v1',
    'vc.meeting.leave_meeting_v1',
  ])('collects participant and operator open_ids for %s without ending the meeting', (eventType) => {
    const input = meetingInputFromEvent({
      meeting: {
        id: 'm_participant',
        topic: 'Participant meeting',
        start_time: '1783595100',
      },
      participant: { id: { open_id: 'ou_participant' }, user_type: 1 },
      operator: { id: 'ou_operator', user_type: 1 },
    }, eventType, Date.parse('2026-07-09T13:45:10+08:00'));

    expect(input).toEqual(expect.objectContaining({
      participant_open_ids: ['ou_participant', 'ou_operator'],
      status: 'live',
    }));
    expect(input).not.toHaveProperty('ended_at');
  });

  it('does not treat an untyped scalar user id as an open_id', () => {
    const input = meetingInputFromEvent({
      meeting: { id: 'm_unknown_id', start_time: '1783595100' },
      participant: { id: 'user_123', user_type: 1 },
    }, 'vc.meeting.join_meeting_v1', Date.parse('2026-07-09T13:45:10+08:00'));

    expect(input).not.toHaveProperty('participant_open_ids');
  });
});
