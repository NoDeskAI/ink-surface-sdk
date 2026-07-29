import {
  MEETING_SESSION_SCHEMA_VERSION,
  type ConfirmedMeetingEndEvidence,
  type MeetingSessionAuditEvent,
  type MeetingSessionEvent,
  type MeetingSessionState,
} from './contracts.js';

const CONFIRMED_END_SIGNALS = new Set([
  'meeting_call_ended',
  'platform_meeting_ended',
  'user_left_meeting',
]);

export interface CreateMeetingSessionInput {
  session_id: string;
  platform: MeetingSessionState['platform'];
  meeting_ref: string;
  start_mode: MeetingSessionState['start_mode'];
  wall_clock_anchor_ms: number;
  monotonic_anchor_ms: number;
}

function auditEvent(
  session: MeetingSessionState,
  type: MeetingSessionAuditEvent['type'],
  at: number,
  detail: Pick<MeetingSessionAuditEvent, 'evidence' | 'chunk_ref' | 'stop_reason' | 'track' | 'unavailability_reason'> = {},
): MeetingSessionAuditEvent {
  return {
    event_id: `${session.session_id}:${session.events.length}:${type}`,
    type,
    at_monotonic_ms: at,
    ...detail,
  };
}

function append(session: MeetingSessionState, event: MeetingSessionAuditEvent): MeetingSessionState {
  const previous = session.events.at(-1);
  if (previous && event.at_monotonic_ms < previous.at_monotonic_ms) throw new Error('session event time cannot move backwards');
  return { ...session, events: [...session.events, event] };
}

function assertConfirmedEndEvidence(evidence: ConfirmedMeetingEndEvidence): void {
  if (!evidence.adapter || !CONFIRMED_END_SIGNALS.has(evidence.signal)) {
    throw new Error('meeting.end.confirmed requires a confirmed meeting-end signal from a platform adapter');
  }
}

export function createMeetingSession(input: CreateMeetingSessionInput): MeetingSessionState {
  if (!input.session_id || !input.meeting_ref) throw new Error('session_id and meeting_ref are required');
  const base: MeetingSessionState = {
    schema_version: MEETING_SESSION_SCHEMA_VERSION,
    ...input,
    status: 'detected',
    events: [],
  };
  return append(base, auditEvent(base, 'session.detected', input.monotonic_anchor_ms));
}

export function applyMeetingSessionEvent(session: MeetingSessionState, event: MeetingSessionEvent): MeetingSessionState {
  if (session.status === 'sealed') throw new Error('cannot apply events to a sealed session');

  if (event.type === 'recording.started') {
    if (session.status !== 'detected') throw new Error('recording can only start from detected');
    const next = append(session, auditEvent(session, event.type, event.at_monotonic_ms));
    return { ...next, status: 'recording', started_monotonic_ms: event.at_monotonic_ms };
  }

  if (event.type === 'recording.paused') {
    if (session.status !== 'recording') throw new Error('recording can only pause while recording');
    return { ...append(session, auditEvent(session, event.type, event.at_monotonic_ms)), status: 'paused' };
  }

  if (event.type === 'recording.resumed') {
    if (session.status !== 'paused') throw new Error('recording can only resume from paused');
    return { ...append(session, auditEvent(session, event.type, event.at_monotonic_ms)), status: 'recording' };
  }

  if (event.type === 'audio.chunk.sealed') {
    if (session.status !== 'recording') throw new Error('audio chunks require a recording session');
    if (event.chunk.session_id !== session.session_id) throw new Error('audio chunk belongs to another session');
    return append(session, auditEvent(session, event.type, event.at_monotonic_ms, {
      chunk_ref: {
        chunk_id: event.chunk.chunk_id,
        track: event.chunk.track,
        sequence: event.chunk.sequence,
        checksum: event.chunk.checksum,
      },
    }));
  }

  if (event.type === 'audio.track.unavailable') {
    if (session.status !== 'recording') throw new Error('audio track failure requires a recording session');
    return append(session, auditEvent(session, event.type, event.at_monotonic_ms, {
      track: event.track,
      unavailability_reason: event.reason.slice(0, 160),
    }));
  }

  if (event.type === 'meeting.end.confirmed') {
    if (session.status !== 'recording' && session.status !== 'paused') {
      throw new Error('meeting end can only seal an active recording');
    }
    assertConfirmedEndEvidence(event.evidence);
    const confirmed = append(session, auditEvent(session, event.type, event.at_monotonic_ms, { evidence: event.evidence }));
    const stopped = append(confirmed, auditEvent(confirmed, 'recording.stopped', event.at_monotonic_ms, { stop_reason: 'meeting_end_confirmed' }));
    return {
      ...stopped,
      status: 'sealed',
      ended_monotonic_ms: event.at_monotonic_ms,
      stop_reason: 'meeting_end_confirmed',
    };
  }

  if (event.type === 'session.interrupted.recovered') {
    if (session.status !== 'detected' && session.status !== 'recording' && session.status !== 'paused') {
      throw new Error('only an interrupted active session can be recovered');
    }
    const recovered = append(session, auditEvent(session, event.type, event.at_monotonic_ms, {
      stop_reason: 'interrupted_session_recovered',
    }));
    const stopped = append(recovered, auditEvent(recovered, 'recording.stopped', event.at_monotonic_ms, {
      stop_reason: 'interrupted_session_recovered',
    }));
    return {
      ...stopped,
      status: 'sealed',
      ended_monotonic_ms: event.at_monotonic_ms,
      stop_reason: 'interrupted_session_recovered',
    };
  }

  if (event.type === 'recording.stopped') {
    if (session.status !== 'recording' && session.status !== 'paused') {
      throw new Error('recording can only stop from an active state');
    }
    const stopped = append(session, auditEvent(session, event.type, event.at_monotonic_ms, { stop_reason: event.reason }));
    return { ...stopped, status: 'sealed', ended_monotonic_ms: event.at_monotonic_ms, stop_reason: event.reason };
  }

  return session;
}
