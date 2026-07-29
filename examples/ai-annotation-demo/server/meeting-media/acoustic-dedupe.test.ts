import { describe, expect, it } from 'vitest';
import type { MeetingAudioChunk, MeetingUtterance } from '../../../../packages/meeting-media-core/src/index';
import { inferAcousticCrossTrackDuplicateAssessments } from './acoustic-dedupe';

const sampleRate = 16_000;
const sessionId = 'acoustic-session';

function chunk(track: 'mic' | 'remote'): MeetingAudioChunk {
  return {
    schema_version: 'inkloop.meeting_audio_chunk.v1',
    chunk_id: `${sessionId}:${track}:0`,
    session_id: sessionId,
    track,
    sequence: 0,
    start_monotonic_ms: 0,
    end_monotonic_ms: 2_000,
    checksum: `sha256:${track}`,
    byte_length: sampleRate * 2 * 2,
    sealed: true,
    codec: 'pcm_s16le',
    sample_rate_hz: sampleRate,
    channel_count: 1,
  };
}

function utterance(track: 'mic' | 'remote'): MeetingUtterance {
  return {
    utterance_id: `utt-${track}`,
    session_id: sessionId,
    track,
    start_ms: 100,
    end_ms: 1_900,
    text: '发布计划已经确认',
    revision: 1,
    stability: 'provisional',
    source_chunk_ids: [`${sessionId}:${track}:0`],
  };
}

function pcm(envelope: readonly number[], shiftBuckets = 0): Uint8Array {
  const bucketSamples = sampleRate / 50;
  const values = new Int16Array(sampleRate * 2);
  for (let bucket = 0; bucket < envelope.length; bucket += 1) {
    const shifted = bucket + shiftBuckets;
    if (shifted < 0) continue;
    for (let index = shifted * bucketSamples; index < Math.min(values.length, (shifted + 1) * bucketSamples); index += 1) {
      // Alternate sign so every bucket contains real audio energy rather than
      // a DC offset. Only the short-time amplitude envelope is compared.
      values[index] = Math.round(envelope[bucket] * (index % 2 ? 1 : -1) * 30_000);
    }
  }
  return new Uint8Array(values.buffer);
}

const remoteEnvelope = Array.from({ length: 100 }, (_, index) => (
  0.08 + (((index * 17) % 31) / 40) + (index % 9 === 0 ? 0.12 : 0)
));

describe('acoustic cross-track dedupe', () => {
  it('recognizes a delayed loudspeaker pickup and keeps Remote as the primary utterance', async () => {
    const remote = chunk('remote');
    const mic = chunk('mic');
    const audio = new Map([
      [remote.chunk_id, pcm(remoteEnvelope)],
      [mic.chunk_id, pcm(remoteEnvelope.map((value) => value * 0.55), 3)],
    ]);

    await expect(inferAcousticCrossTrackDuplicateAssessments({
      utterances: [utterance('mic'), utterance('remote')],
      chunks: [mic, remote],
      loadAudio: async (item) => audio.get(item.chunk_id) || null,
    })).resolves.toEqual([expect.objectContaining({
      primary_utterance_id: 'utt-remote',
      candidate_utterance_id: 'utt-mic',
      disposition: 'suppress_derived_duplicate',
      signals: ['aec', 'acoustic_similarity', 'text_similarity', 'time_overlap'],
    })]);
  });

  it('retains simultaneous equal text when the acoustic evidence does not match', async () => {
    const remote = chunk('remote');
    const mic = chunk('mic');
    const unrelated = remoteEnvelope.map((_, index) => 0.08 + (((index * 7 + 13) % 29) / 38));
    const audio = new Map([[remote.chunk_id, pcm(remoteEnvelope)], [mic.chunk_id, pcm(unrelated)]]);

    await expect(inferAcousticCrossTrackDuplicateAssessments({
      utterances: [utterance('mic'), utterance('remote')],
      chunks: [mic, remote],
      loadAudio: async (item) => audio.get(item.chunk_id) || null,
    })).resolves.toEqual([expect.objectContaining({
      disposition: 'retain_conflict',
      signals: ['acoustic_similarity', 'text_similarity', 'time_overlap'],
    })]);
  });

  it('leaves the conservative text fallback in charge when PCM evidence is unavailable', async () => {
    await expect(inferAcousticCrossTrackDuplicateAssessments({
      utterances: [utterance('mic'), utterance('remote')],
      chunks: [chunk('mic'), chunk('remote')],
      loadAudio: async () => null,
    })).resolves.toEqual([]);
  });
});
