import type { MeetingAudioTrack, MeetingSessionState } from './contracts.js';

export interface SealedMeetingSequenceManifest {
  schema_version: 'inkloop.meeting_sequence_manifest.v1';
  session_id: string;
  expected_tracks: MeetingAudioTrack[];
  expected_last_sequence: Partial<Record<MeetingAudioTrack, number>>;
  known_missing_chunk_ids: string[];
}

/** Derives the server-verifiable sequence boundary from the local sealed fact log. */
export function sealedSequenceManifest(session: MeetingSessionState): SealedMeetingSequenceManifest {
  if (session.status !== 'sealed') throw new Error('meeting session must be sealed before building a sequence manifest');
  const expectedLast: Partial<Record<MeetingAudioTrack, number>> = {};
  for (const event of session.events) {
    const chunk = event.chunk_ref;
    if (!chunk) continue;
    expectedLast[chunk.track] = Math.max(expectedLast[chunk.track] ?? -1, chunk.sequence);
  }
  // Both tracks remain part of the evidence contract even when an adapter
  // failed before producing its first chunk. The server can then expose
  // `missing_track:*` instead of silently upgrading a degraded/recovered
  // session to a complete transcript.
  const expected_tracks = ['mic', 'remote'] as MeetingAudioTrack[];
  return {
    schema_version: 'inkloop.meeting_sequence_manifest.v1',
    session_id: session.session_id,
    expected_tracks,
    expected_last_sequence: expectedLast,
    known_missing_chunk_ids: session.events.flatMap((event) => event.type === 'audio.track.unavailable' && event.track
      ? [`track_unavailable:${event.track}:${event.at_monotonic_ms}`]
      : []),
  };
}
