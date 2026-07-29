import { describe, expect, it } from 'vitest';
import {
  acknowledgeChunk,
  createChunkDeliveryState,
  recordChunk,
  type MeetingAudioChunk,
  type MeetingTranscriptState,
} from '../../../../packages/meeting-media-core/src/index';
import { buildFormalTranscriptArtifact, inferCrossTrackDuplicateAssessments } from './transcript-finalizer';

const sessionId = 'session-finalizer';

function chunk(track: 'mic' | 'remote', sequence: number): MeetingAudioChunk {
  return {
    schema_version: 'inkloop.meeting_audio_chunk.v1',
    chunk_id: `${sessionId}:${track}:${sequence}`,
    session_id: sessionId,
    track,
    sequence,
    start_monotonic_ms: sequence * 1_000,
    end_monotonic_ms: sequence * 1_000 + 999,
    checksum: `sha256:${track}:${sequence}`,
    byte_length: 1,
    sealed: true,
  };
}

function delivery(...chunks: MeetingAudioChunk[]) {
  let state = createChunkDeliveryState(sessionId);
  for (const item of chunks) {
    state = recordChunk(state, item);
    state = acknowledgeChunk(state, {
      session_id: sessionId,
      track: item.track,
      sequence: item.sequence,
      chunk_id: item.chunk_id,
      checksum: item.checksum,
      acknowledged_at_ms: 1_000,
    });
  }
  return state;
}

function transcript(): MeetingTranscriptState {
  return {
    schema_version: 'inkloop.meeting_transcript.v1',
    session_id: sessionId,
    status: 'provisional',
    revision: 2,
    missing_chunks: [],
    utterances: [
      {
        utterance_id: 'utt-mic', session_id: sessionId, track: 'mic', start_ms: 0, end_ms: 900,
        text: '发布计划已确认', revision: 1, stability: 'provisional', source_chunk_ids: [`${sessionId}:mic:0`],
      },
      {
        utterance_id: 'utt-remote', session_id: sessionId, track: 'remote', start_ms: 20, end_ms: 920,
        text: '发布计划已确认', revision: 1, stability: 'provisional', source_chunk_ids: [`${sessionId}:remote:0`],
      },
    ],
  };
}

describe('formal transcript convergence', () => {
  it('stays partial while a persisted chunk is still pending at the provider', () => {
    const artifact = buildFormalTranscriptArtifact({
      provisional: transcript(),
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
      provider_pending_chunk_ids: [`${sessionId}:remote:0`],
      finalized_at_ms: 2_000,
    });

    expect(artifact).toMatchObject({
      finality: 'partial',
      missing_chunk_ids: [`${sessionId}:remote:0`],
      finalized_at_ms: 2_000,
    });
  });

  it('suppresses a cross-track duplicate only in the derived projection', () => {
    const artifact = buildFormalTranscriptArtifact({
      provisional: transcript(),
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
      duplicate_assessments: [{
        primary_utterance_id: 'utt-mic',
        candidate_utterance_id: 'utt-remote',
        disposition: 'suppress_derived_duplicate',
        confidence: 0.98,
        signals: ['aec', 'text_similarity', 'time_overlap'],
      }],
    });

    expect(artifact.finality).toBe('final');
    expect(artifact.raw_utterances).toHaveLength(2);
    expect(artifact.raw_utterances.find((item) => item.utterance_id === 'utt-remote')?.duplicate_of).toBe('utt-mic');
    expect(artifact.derived_utterances.map((item) => item.utterance_id)).toEqual(['utt-mic']);
    expect(artifact.dedupe_metrics).toEqual({
      raw_utterance_count: 2,
      derived_utterance_count: 1,
      assessed_pair_count: 1,
      suppressed_duplicate_count: 1,
      retained_conflict_count: 0,
      rejected_assessment_count: 0,
      external_assessment_count: 1,
      inferred_assessment_count: 0,
    });
  });

  it('conservatively infers a simultaneous exact-text echo without external DSP input', () => {
    const artifact = buildFormalTranscriptArtifact({
      provisional: transcript(),
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
    });

    expect(artifact.raw_utterances).toHaveLength(2);
    expect(artifact.derived_utterances.map((item) => item.utterance_id)).toEqual(['utt-remote']);
    expect(artifact.duplicate_assessments).toEqual([expect.objectContaining({
      primary_utterance_id: 'utt-remote',
      candidate_utterance_id: 'utt-mic',
      disposition: 'suppress_derived_duplicate',
      applied: true,
      source: 'text_fallback',
      signals: ['text_similarity', 'time_overlap'],
    })]);
    expect(artifact.dedupe_metrics).toMatchObject({
      suppressed_duplicate_count: 1,
      external_assessment_count: 0,
      inferred_assessment_count: 1,
    });
  });

  it('does not infer duplicates for short acknowledgements or adjacent non-overlapping speech', () => {
    const state = transcript();
    state.utterances = [
      { ...state.utterances[0], text: '好的', start_ms: 0, end_ms: 300 },
      { ...state.utterances[1], text: '好的', start_ms: 10, end_ms: 310 },
      { ...state.utterances[0], utterance_id: 'utt-long-mic', text: '发布计划已经确认', start_ms: 1_000, end_ms: 1_800 },
      { ...state.utterances[1], utterance_id: 'utt-long-remote', text: '发布计划已经确认。', start_ms: 1_900, end_ms: 2_700 },
    ];

    expect(inferCrossTrackDuplicateAssessments(state.utterances)).toEqual([]);
  });

  it('lets an external acoustic assessment override the automatic text decision for the same pair', () => {
    const artifact = buildFormalTranscriptArtifact({
      provisional: transcript(),
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
      duplicate_assessments: [{
        primary_utterance_id: 'utt-remote',
        candidate_utterance_id: 'utt-mic',
        disposition: 'retain_conflict',
        confidence: 0.6,
        signals: ['acoustic_similarity'],
      }],
    });

    expect(artifact.derived_utterances).toHaveLength(2);
    expect(artifact.duplicate_assessments).toEqual([expect.objectContaining({
      disposition: 'retain_conflict',
      applied: true,
    })]);
  });

  it('retains an explicit low-confidence conflict in the derived timeline', () => {
    const artifact = buildFormalTranscriptArtifact({
      provisional: transcript(),
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
      duplicate_assessments: [{
        primary_utterance_id: 'utt-mic',
        candidate_utterance_id: 'utt-remote',
        disposition: 'retain_conflict',
        confidence: 0.55,
        signals: ['time_overlap'],
      }],
    });

    expect(artifact.derived_utterances).toHaveLength(2);
    expect(artifact.duplicate_assessments[0]).toMatchObject({ applied: true, disposition: 'retain_conflict' });
  });

  it('applies only high-confidence identity matches to known clusters', () => {
    const state = transcript();
    state.utterances[1] = { ...state.utterances[1], speaker_cluster_id: 'cluster-remote' };
    const artifact = buildFormalTranscriptArtifact({
      provisional: state,
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
      speaker_identity_matches: [
        { speaker_cluster_id: 'cluster-remote', display_name: 'Alice', confidence: 0.93, source: 'provider_participant' },
        { speaker_cluster_id: 'cluster-missing', display_name: 'Bob', confidence: 0.99, source: 'calendar_participant' },
      ],
    });
    expect(artifact.speaker_identity_matches).toEqual([
      expect.objectContaining({ display_name: 'Alice', applied: true }),
      expect.objectContaining({ display_name: 'Bob', applied: false, reason: 'cluster_not_found' }),
    ]);
  });

  it('rejects a same-track suppression decision from the dedupe adapter', () => {
    const state = transcript();
    state.utterances[1] = { ...state.utterances[1], track: 'mic' };
    const artifact = buildFormalTranscriptArtifact({
      provisional: state,
      delivery: delivery(chunk('mic', 0), chunk('remote', 0)),
      duplicate_assessments: [{
        primary_utterance_id: 'utt-mic',
        candidate_utterance_id: 'utt-remote',
        disposition: 'suppress_derived_duplicate',
        confidence: 0.99,
        signals: ['text_similarity'],
      }],
    });

    expect(artifact.derived_utterances).toHaveLength(2);
    expect(artifact.duplicate_assessments[0]).toMatchObject({ applied: false, reason: 'same_track' });
    expect(artifact.dedupe_metrics).toMatchObject({
      suppressed_duplicate_count: 0,
      rejected_assessment_count: 1,
    });
  });
});
