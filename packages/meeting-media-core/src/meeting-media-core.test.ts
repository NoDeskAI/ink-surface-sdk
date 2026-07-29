import { describe, expect, it } from 'vitest';
import {
  applyMeetingSessionEvent,
  assertMeetingRealtimeAudioFrame,
  createChunkDeliveryState,
  createMeetingSession,
  finalizeTranscript,
  pendingChunks,
  recordChunk,
  acknowledgeChunk,
  upsertProvisionalUtterance,
  sealedSequenceManifest,
  type MeetingAudioChunk,
  type MeetingTranscriptState,
} from './index';

const sessionId = 'session_meet_01';

function chunk(track: 'mic' | 'remote', sequence: number, checksum = `sha256:${track}:${sequence}`): MeetingAudioChunk {
  return {
    schema_version: 'inkloop.meeting_audio_chunk.v1',
    chunk_id: `${sessionId}:${track}:${sequence}`,
    session_id: sessionId,
    track,
    sequence,
    start_monotonic_ms: sequence * 1_000,
    end_monotonic_ms: (sequence + 1) * 1_000,
    checksum,
    byte_length: 16_000,
    sealed: true,
  };
}

describe('meeting session lifecycle', () => {
  it('starts recording and immediately seals after confirmed meeting end', () => {
    const detected = createMeetingSession({
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'meet:abc-defg-hij',
      start_mode: 'automatic',
      wall_clock_anchor_ms: 1_000,
      monotonic_anchor_ms: 100,
    });
    const recording = applyMeetingSessionEvent(detected, { type: 'recording.started', at_monotonic_ms: 120 });
    const sealed = applyMeetingSessionEvent(recording, {
      type: 'meeting.end.confirmed',
      at_monotonic_ms: 5_000,
      evidence: { adapter: 'chrome_google_meet', signal: 'meeting_call_ended' },
    });

    expect(recording.status).toBe('recording');
    expect(sealed).toMatchObject({ status: 'sealed', ended_monotonic_ms: 5_000, stop_reason: 'meeting_end_confirmed' });
    expect(sealed.events.map((event) => event.type)).toEqual([
      'session.detected',
      'recording.started',
      'meeting.end.confirmed',
      'recording.stopped',
    ]);
  });

  it.each(['window_blurred', 'tab_hidden', 'application_backgrounded', 'audio_silence', 'network_disconnected'])(
    'rejects weak end signal %s as confirmed evidence',
    (signal) => {
      const session = applyMeetingSessionEvent(createMeetingSession({
        session_id: sessionId,
        platform: 'zoom',
        meeting_ref: 'zoom:123',
        start_mode: 'automatic',
        wall_clock_anchor_ms: 1_000,
        monotonic_anchor_ms: 100,
      }), { type: 'recording.started', at_monotonic_ms: 120 });

      expect(() => applyMeetingSessionEvent(session, {
        type: 'meeting.end.confirmed',
        at_monotonic_ms: 5_000,
        evidence: { adapter: 'zoom_macos', signal },
      })).toThrow(/confirmed meeting-end signal/);
    },
  );

  it('does not allow audio chunks after the meeting has sealed', () => {
    const recording = applyMeetingSessionEvent(createMeetingSession({
      session_id: sessionId,
      platform: 'zoom',
      meeting_ref: 'zoom:123',
      start_mode: 'manual',
      wall_clock_anchor_ms: 1_000,
      monotonic_anchor_ms: 100,
    }), { type: 'recording.started', at_monotonic_ms: 120 });
    const sealed = applyMeetingSessionEvent(recording, {
      type: 'meeting.end.confirmed',
      at_monotonic_ms: 5_000,
      evidence: { adapter: 'zoom_macos', signal: 'meeting_call_ended' },
    });

    expect(() => applyMeetingSessionEvent(sealed, {
      type: 'audio.chunk.sealed',
      at_monotonic_ms: 5_100,
      chunk: chunk('mic', 0),
    })).toThrow(/sealed session/);
  });

  it('derives a sealed per-track sequence manifest for server gap validation', () => {
    let session = applyMeetingSessionEvent(createMeetingSession({ session_id: sessionId, platform: 'zoom', meeting_ref: 'zoom:123', start_mode: 'manual', wall_clock_anchor_ms: 1_000, monotonic_anchor_ms: 100 }), { type: 'recording.started', at_monotonic_ms: 120 });
    session = applyMeetingSessionEvent(session, { type: 'audio.chunk.sealed', at_monotonic_ms: 1_000, chunk: chunk('mic', 0) });
    session = applyMeetingSessionEvent(session, { type: 'audio.chunk.sealed', at_monotonic_ms: 2_000, chunk: chunk('remote', 1) });
    session = applyMeetingSessionEvent(session, { type: 'audio.chunk.sealed', at_monotonic_ms: 3_000, chunk: chunk('mic', 2) });
    const sealed = applyMeetingSessionEvent(session, { type: 'meeting.end.confirmed', at_monotonic_ms: 5_000, evidence: { adapter: 'zoom_macos', signal: 'meeting_call_ended' } });
    expect(sealedSequenceManifest(sealed)).toEqual({ schema_version: 'inkloop.meeting_sequence_manifest.v1', session_id: sessionId, expected_tracks: ['mic', 'remote'], expected_last_sequence: { mic: 2, remote: 1 }, known_missing_chunk_ids: [] });
  });

  it('seals an interrupted session without fabricating confirmed meeting-end evidence', () => {
    const recording = applyMeetingSessionEvent(createMeetingSession({
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      start_mode: 'automatic',
      wall_clock_anchor_ms: 1_000,
      monotonic_anchor_ms: 100,
    }), { type: 'recording.started', at_monotonic_ms: 120 });

    const recovered = applyMeetingSessionEvent(recording, {
      type: 'session.interrupted.recovered',
      at_monotonic_ms: 120,
    });

    expect(recovered).toMatchObject({
      status: 'sealed',
      ended_monotonic_ms: 120,
      stop_reason: 'interrupted_session_recovered',
    });
    expect(recovered.events.slice(-2).map((event) => event.type)).toEqual([
      'session.interrupted.recovered',
      'recording.stopped',
    ]);
    expect(recovered.events.some((event) => event.type === 'meeting.end.confirmed')).toBe(false);
    expect(sealedSequenceManifest(recovered)).toEqual({
      schema_version: 'inkloop.meeting_sequence_manifest.v1',
      session_id: sessionId,
      expected_tracks: ['mic', 'remote'],
      expected_last_sequence: {},
      known_missing_chunk_ids: [],
    });
  });

  it('persists a runtime track-loss boundary into the sealed manifest', () => {
    let session = applyMeetingSessionEvent(createMeetingSession({ session_id: sessionId, platform: 'zoom', meeting_ref: 'zoom:123', start_mode: 'automatic', wall_clock_anchor_ms: 1_000, monotonic_anchor_ms: 100 }), { type: 'recording.started', at_monotonic_ms: 120 });
    session = applyMeetingSessionEvent(session, { type: 'audio.track.unavailable', at_monotonic_ms: 1_500, track: 'remote', reason: 'screen_capture_stream_stopped' });
    const sealed = applyMeetingSessionEvent(session, { type: 'recording.stopped', at_monotonic_ms: 2_000, reason: 'manual' });

    expect(sealedSequenceManifest(sealed).known_missing_chunk_ids).toEqual([
      'track_unavailable:remote:1500',
    ]);
  });
});

describe('dual-track chunk delivery', () => {
  it('records chunks idempotently and rejects checksum conflicts', () => {
    const first = recordChunk(createChunkDeliveryState(sessionId), chunk('mic', 0));
    const replay = recordChunk(first, chunk('mic', 0));

    expect(replay).toEqual(first);
    expect(() => recordChunk(first, chunk('mic', 0, 'sha256:changed'))).toThrow(/chunk conflict/);
  });

  it('keeps unacknowledged chunks pending and sorts each track by sequence', () => {
    let state = createChunkDeliveryState(sessionId);
    state = recordChunk(state, chunk('remote', 2));
    state = recordChunk(state, chunk('mic', 1));
    state = recordChunk(state, chunk('remote', 0));
    state = recordChunk(state, chunk('mic', 0));
    state = acknowledgeChunk(state, {
      session_id: sessionId,
      track: 'remote',
      sequence: 0,
      chunk_id: `${sessionId}:remote:0`,
      checksum: 'sha256:remote:0',
      acknowledged_at_ms: 10_000,
    });

    expect(pendingChunks(state).map((item) => `${item.track}:${item.sequence}`)).toEqual([
      'mic:0',
      'mic:1',
      'remote:2',
    ]);
  });

  it('rejects acknowledgements that do not match the persisted chunk identity', () => {
    const state = recordChunk(createChunkDeliveryState(sessionId), chunk('remote', 0));

    expect(() => acknowledgeChunk(state, {
      session_id: sessionId,
      track: 'remote',
      sequence: 0,
      chunk_id: `${sessionId}:remote:0`,
      checksum: 'sha256:wrong',
      acknowledged_at_ms: 10_000,
    })).toThrow(/acknowledgement mismatch/);
  });
});

describe('realtime audio frame contract', () => {
  it('accepts explicit speech and silent coverage projections', () => {
    const base = {
      schema_version: 'inkloop.meeting_realtime_audio_frame.v1' as const,
      frame_id: `${sessionId}:mic:frame:0`,
      session_id: sessionId,
      track: 'mic' as const,
      frame_sequence: 0,
      source_chunk_id: `${sessionId}:mic:0`,
      start_monotonic_ms: 0,
      end_monotonic_ms: 20,
      codec: 'pcm_s16le' as const,
      sample_rate_hz: 16_000,
      channel_count: 1 as const,
    };

    expect(() => assertMeetingRealtimeAudioFrame({
      ...base,
      speech_present: true,
      audio_derivation: 'apple_voice_processing',
    })).not.toThrow();
    expect(() => assertMeetingRealtimeAudioFrame({ ...base, frame_sequence: 1, speech_present: false })).not.toThrow();
    expect(() => assertMeetingRealtimeAudioFrame({ ...base, audio_derivation: 'unknown' })).toThrow(/audio_derivation/);
  });

  it('allows unclassified remote projections for server-side VAD', () => {
    expect(() => assertMeetingRealtimeAudioFrame({
      schema_version: 'inkloop.meeting_realtime_audio_frame.v1',
      frame_id: `${sessionId}:mic:frame:0`,
      session_id: sessionId,
      track: 'remote',
      frame_sequence: 0,
      source_chunk_id: `${sessionId}:mic:0`,
      start_monotonic_ms: 0,
      end_monotonic_ms: 20,
      codec: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channel_count: 1,
    })).not.toThrow();
  });
});

describe('provisional to formal transcript', () => {
  function transcript(): MeetingTranscriptState {
    return {
      schema_version: 'inkloop.meeting_transcript.v1',
      session_id: sessionId,
      status: 'provisional',
      utterances: [],
      missing_chunks: [],
      revision: 0,
    };
  }

  it('replaces an utterance only when its provider revision increases', () => {
    const first = upsertProvisionalUtterance(transcript(), {
      utterance_id: 'utt_remote_1',
      session_id: sessionId,
      track: 'remote',
      start_ms: 0,
      end_ms: 800,
      text: '我们今天讨论',
      revision: 1,
      stability: 'provisional',
      source_chunk_ids: [`${sessionId}:remote:0`],
    });
    const replay = upsertProvisionalUtterance(first, first.utterances[0]);
    const corrected = upsertProvisionalUtterance(replay, { ...first.utterances[0], text: '我们今天讨论发布计划', revision: 2 });

    expect(replay).toEqual(first);
    expect(corrected.utterances).toHaveLength(1);
    expect(corrected.utterances[0]).toMatchObject({ text: '我们今天讨论发布计划', revision: 2 });
  });

  it.each([
    ['speaker_cluster_id', 'speaker-2'],
    ['confidence', 0.42],
    ['duplicate_of', 'utt_remote_original'],
  ] as const)('rejects same-revision conflicts in %s', (field, value) => {
    const first = upsertProvisionalUtterance(transcript(), {
      utterance_id: 'utt_remote_conflict',
      session_id: sessionId,
      track: 'remote',
      start_ms: 0,
      end_ms: 800,
      text: '同一版转写',
      revision: 1,
      stability: 'provisional',
      source_chunk_ids: [`${sessionId}:remote:0`],
    });

    expect(() => upsertProvisionalUtterance(first, {
      ...first.utterances[0],
      [field]: value,
    })).toThrow(/utterance revision conflict/);
  });

  it('finalizes a complete transcript when every referenced chunk is acknowledged', () => {
    const delivery = acknowledgeChunk(recordChunk(createChunkDeliveryState(sessionId), chunk('remote', 0)), {
      session_id: sessionId,
      track: 'remote',
      sequence: 0,
      chunk_id: `${sessionId}:remote:0`,
      checksum: 'sha256:remote:0',
      acknowledged_at_ms: 10_000,
    });
    const provisional = upsertProvisionalUtterance(transcript(), {
      utterance_id: 'utt_remote_1', session_id: sessionId, track: 'remote', start_ms: 0, end_ms: 800,
      text: '发布计划已确认', revision: 1, stability: 'provisional', source_chunk_ids: [`${sessionId}:remote:0`],
    });

    const formal = finalizeTranscript(provisional, delivery);

    expect(formal).toMatchObject({ status: 'formal', finality: 'final', missing_chunks: [], revision: 2 });
    expect(formal.utterances[0].stability).toBe('formal');
  });

  it('produces partial formal output and exposes missing chunks', () => {
    const delivery = recordChunk(createChunkDeliveryState(sessionId), chunk('remote', 0));
    const provisional = upsertProvisionalUtterance(transcript(), {
      utterance_id: 'utt_remote_1', session_id: sessionId, track: 'remote', start_ms: 0, end_ms: 800,
      text: '网络中断前的内容', revision: 1, stability: 'provisional', source_chunk_ids: [`${sessionId}:remote:0`],
    });

    const formal = finalizeTranscript(provisional, delivery);

    expect(formal).toMatchObject({ status: 'formal', finality: 'partial', missing_chunks: [`${sessionId}:remote:0`] });
  });

  it('keeps provider-pending chunks partial even after the durable ingest ACK', () => {
    const delivery = acknowledgeChunk(recordChunk(createChunkDeliveryState(sessionId), chunk('remote', 0)), {
      session_id: sessionId,
      track: 'remote',
      sequence: 0,
      chunk_id: `${sessionId}:remote:0`,
      checksum: 'sha256:remote:0',
      acknowledged_at_ms: 10_000,
    });

    const formal = finalizeTranscript(transcript(), delivery, 20_000, [`${sessionId}:remote:0`]);

    expect(formal).toMatchObject({
      status: 'formal',
      finality: 'partial',
      missing_chunks: [`${sessionId}:remote:0`],
      finalized_at_ms: 20_000,
    });
  });
});
