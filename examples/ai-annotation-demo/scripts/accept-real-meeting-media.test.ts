import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRealMeetingMedia } from './accept-real-meeting-media';

const sessionId = 'real-session-1';

async function fixture(options: { remote?: boolean; finality?: 'final' | 'partial' } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'inkloop-real-meeting-'));
  const localRoot = resolve(root, 'local');
  const serverRoot = resolve(root, 'server');
  const localSession = resolve(localRoot, sessionId);
  const serverSession = resolve(
    serverRoot,
    Buffer.from('tenant').toString('base64url'),
    Buffer.from('user').toString('base64url'),
    Buffer.from(sessionId).toString('base64url'),
  );
  await mkdir(localSession, { recursive: true });
  await mkdir(serverSession, { recursive: true });
  const remote = options.remote !== false;
  const chunk = (track: 'mic' | 'remote') => ({
    chunk_id: `${sessionId}:${track}:0`, track, sequence: 0,
    start_monotonic_ms: 100, end_monotonic_ms: 10_100,
    checksum: `sha256:${track}`, byte_length: 100,
  });
  const chunks = [chunk('mic'), ...(remote ? [chunk('remote')] : [])];
  const events = chunks.map((value, index) => ({
    type: 'audio.chunk.sealed', at_monotonic_ms: value.end_monotonic_ms,
    chunk_ref: { track: value.track, sequence: value.sequence, chunk_id: value.chunk_id },
    event_id: `event-${index}`,
  }));
  events.push({
    type: 'meeting.end.confirmed', at_monotonic_ms: 10_200,
    evidence: { signal: 'user_left_meeting', observed_at_wall_clock_ms: 20_100 },
    event_id: 'event-end',
  } as never, {
    type: 'recording.stopped', at_monotonic_ms: 10_200,
    event_id: 'event-stop',
  } as never);
  await writeFile(resolve(localSession, 'session.json'), JSON.stringify({
    session_id: sessionId, platform: 'google_meet', meeting_ref: 'google_meet:abc-defg-hij',
    status: 'sealed', start_mode: 'automatic', stop_reason: 'meeting_end_confirmed',
    wall_clock_anchor_ms: 10_000, monotonic_anchor_ms: 100,
    started_monotonic_ms: 100, ended_monotonic_ms: 10_200, events,
  }));
  await writeFile(resolve(localSession, 'sequence-manifest.json'), JSON.stringify({
    expected_tracks: ['mic', 'remote'],
    expected_last_sequence: Object.fromEntries(chunks.map((value) => [value.track, 0])),
  }));
  const deliveryChunks = Object.fromEntries(chunks.map((value) => [`${value.track}:0`, value]));
  const acknowledgements = Object.fromEntries(chunks.map((value) => [`${value.track}:0`, {
    chunk_id: value.chunk_id, checksum: value.checksum, acknowledged_at_ms: 123,
  }]));
  await writeFile(resolve(serverSession, 'delivery.json'), JSON.stringify({ chunks: deliveryChunks, acknowledgements }));
  await writeFile(resolve(serverSession, 'provider-outbox.json'), JSON.stringify({
    pending: {}, completed: Object.fromEntries(chunks.map((value) => [value.chunk_id, { provider_id: 'whisper', completed_at_ms: 200 }])),
  }));
  await writeFile(resolve(serverSession, 'transcript.json'), JSON.stringify({
    status: 'provisional', revision: 1,
    utterances: chunks.map((value) => ({
      utterance_id: `utt-${value.track}`, track: value.track,
      start_ms: 100, end_ms: 1_000, text: value.track,
    })),
  }));
  await writeFile(resolve(serverSession, 'telemetry.json'), JSON.stringify({
    registered_at_ms: 100,
    first_chunk_received_at_ms: 120,
    last_chunk_acknowledged_at_ms: 130,
    acknowledgement_count: chunks.length,
    replay_count: 0,
    peak_pending_chunk_count: 2,
    ack_persist_duration_ms: [4, 10],
    provider_attempt_count: chunks.length,
    provider_failure_count: 0,
    provider_timeout_count: 0,
    provider_duration_ms: [500, 900],
    realtime_frame_count: 20,
    realtime_audio_duration_ms: 10_000,
    realtime_provider_duration_ms: [400, 800],
    realtime_provider_ids: {
      mic: 'openai-compatible:buffered:127.0.0.1:8081:ggml-large-v3-turbo-q5_0',
      remote: 'openai-compatible:buffered:127.0.0.1:8081:ggml-large-v3-turbo-q5_0',
    },
    realtime_audio_derivations: {
      mic: 'apple_voice_processing',
      remote: 'raw',
    },
    formal_converger_id: 'openai-compatible:formal-raw-replay:127.0.0.1:8081:ggml-large-v3-turbo-q5_0',
    first_provisional_at_ms: 620,
    asr_drained_at_ms: 1_030,
    formalized_at_ms: 1_054,
  }));
  const finality = options.finality || (remote ? 'final' : 'partial');
  await writeFile(resolve(serverSession, 'formal-transcript.json'), JSON.stringify({ artifact: {
    finality,
    missing_chunk_ids: remote ? [] : ['missing_track:remote'],
    raw_utterances: chunks.map((value) => ({
      utterance_id: `utt-${value.track}`, session_id: sessionId, track: value.track,
      start_ms: 100, end_ms: 1_000, text: value.track, revision: 1, stability: 'formal',
      source_chunk_ids: [value.chunk_id],
    })),
    derived_utterances: chunks.filter((value) => value.track !== 'mic').map((value) => ({
      utterance_id: `utt-${value.track}`, session_id: sessionId, track: value.track,
      start_ms: 100, end_ms: 1_000, text: value.track, revision: 1, stability: 'formal',
      source_chunk_ids: [value.chunk_id],
    })),
    duplicate_assessments: remote ? [{
      primary_utterance_id: 'utt-remote', candidate_utterance_id: 'utt-mic',
      disposition: 'suppress_derived_duplicate', confidence: 0.9,
      signals: ['text_similarity', 'time_overlap'], source: 'text_fallback', applied: true,
    }] : [],
    dedupe_metrics: remote ? {
      raw_utterance_count: 2, derived_utterance_count: 1, assessed_pair_count: 1,
      suppressed_duplicate_count: 1, retained_conflict_count: 0, rejected_assessment_count: 0,
      external_assessment_count: 0, inferred_assessment_count: 1,
    } : null,
  } }));
  return { localRoot, serverRoot };
}

describe('real meeting media acceptance', () => {
  it('passes a sealed dual-track session with ACK, ASR, and immediate confirmed stop', async () => {
    const paths = await fixture();
    const report = await analyzeRealMeetingMedia({
      session: sessionId, ...paths, tenantId: 'tenant', userId: 'user', now: 1,
    });
    expect(report.ok).toBe(true);
    expect(report.tracks).toMatchObject({
      mic: { server_chunk_count: 1, ack_count: 1, missing_sequences: [] },
      remote: { server_chunk_count: 1, ack_count: 1, missing_sequences: [] },
    });
    expect(report.gates).toMatchObject({ both_tracks_have_chunks: true, formalized: true });
    expect(report.transcript).toMatchObject({
      dedupe_metrics: { suppressed_duplicate_count: 1, inferred_assessment_count: 1 },
      dedupe_evaluation: null,
    });
    expect(report.performance).toEqual({
      first_server_ack_after_registration_ms: 20,
      ack_p50_persist_ms: 4,
      ack_p95_persist_ms: 10,
      provider_p50_ms: 500,
      provider_p95_ms: 900,
      realtime_provider_p50_ms: 400,
      realtime_provider_p95_ms: 800,
      first_provisional_after_first_chunk_ms: 500,
      asr_drain_after_last_ack_ms: 900,
      formal_after_asr_drain_ms: 24,
      peak_pending_chunk_count: 2,
      replay_count: 0,
      provider_attempt_count: 2,
      provider_failure_count: 0,
      provider_timeout_count: 0,
    });
    expect(report.asr_runtime).toEqual({
      realtime_frame_count: 20,
      realtime_audio_duration_ms: 10_000,
      realtime_provider_ids: {
        mic: 'openai-compatible:buffered:127.0.0.1:8081:ggml-large-v3-turbo-q5_0',
        remote: 'openai-compatible:buffered:127.0.0.1:8081:ggml-large-v3-turbo-q5_0',
      },
      realtime_audio_derivations: {
        mic: 'apple_voice_processing',
        remote: 'raw',
      },
      formal_converger_id: 'openai-compatible:formal-raw-replay:127.0.0.1:8081:ggml-large-v3-turbo-q5_0',
    });
  });

  it('reports labeled residual-duplicate and false-suppression quality separately from operational counts', async () => {
    const paths = await fixture();
    const report = await analyzeRealMeetingMedia({
      session: sessionId, ...paths, tenantId: 'tenant', userId: 'user', now: 1,
      dedupeLabels: [{
        left_utterance_id: 'utt-mic', right_utterance_id: 'utt-remote', expected_duplicate: true,
      }],
    });
    expect(report.transcript.dedupe_evaluation).toMatchObject({
      labeled_pair_count: 1,
      true_suppression_count: 1,
      residual_duplicate_rate: 0,
      false_suppression_rate: 0,
      suppression_precision: 1,
      duplicate_recall: 1,
    });
  });

  it('fails the real-meeting gate when an expected track never produced evidence', async () => {
    const paths = await fixture({ remote: false });
    const report = await analyzeRealMeetingMedia({
      session: 'latest', ...paths, tenantId: 'tenant', userId: 'user', now: 1,
    });
    expect(report.ok).toBe(false);
    expect(report.gates.both_tracks_have_chunks).toBe(false);
    expect(report.transcript).toMatchObject({
      formal_finality: 'partial',
      missing_chunk_ids: ['missing_track:remote'],
    });
  });
});
