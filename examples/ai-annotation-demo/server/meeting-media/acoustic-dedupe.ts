import type { MeetingAudioChunk, MeetingUtterance } from '../../../../packages/meeting-media-core/src/index';
import type { CrossTrackDuplicateAssessment } from './transcript-finalizer';

const ENVELOPE_BUCKET_HZ = 50;
const MAX_LAG_MS = 250;
const SUPPRESS_CORRELATION = 0.82;

export interface AcousticDedupeInput {
  utterances: readonly MeetingUtterance[];
  chunks: readonly MeetingAudioChunk[];
  loadAudio(chunk: MeetingAudioChunk): Promise<Uint8Array | null>;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function timeOverlapRatio(left: MeetingUtterance, right: MeetingUtterance): number {
  const overlap = Math.max(0, Math.min(left.end_ms, right.end_ms) - Math.max(left.start_ms, right.start_ms));
  const shorter = Math.max(1, Math.min(left.end_ms - left.start_ms, right.end_ms - right.start_ms));
  return overlap / shorter;
}

function pcm16Envelope(chunk: MeetingAudioChunk, audio: Uint8Array): number[] | null {
  if (chunk.codec !== 'pcm_s16le' || !chunk.sample_rate_hz || chunk.channel_count !== 1
    || audio.byteLength < 2 || audio.byteLength % 2 !== 0) return null;
  const samplesPerBucket = Math.max(1, Math.round(chunk.sample_rate_hz / ENVELOPE_BUCKET_HZ));
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const sampleCount = audio.byteLength / 2;
  const result: number[] = [];
  for (let start = 0; start < sampleCount; start += samplesPerBucket) {
    let energy = 0;
    const end = Math.min(sampleCount, start + samplesPerBucket);
    for (let index = start; index < end; index += 1) {
      const sample = view.getInt16(index * 2, true) / 32_768;
      energy += sample * sample;
    }
    result.push(Math.sqrt(energy / Math.max(1, end - start)));
  }
  return result;
}

function sliceEnvelope(
  envelope: readonly number[],
  chunk: MeetingAudioChunk,
  startMs: number,
  endMs: number,
): number[] {
  const chunkDuration = Math.max(1, chunk.end_monotonic_ms - chunk.start_monotonic_ms);
  const first = Math.max(0, Math.floor((startMs - chunk.start_monotonic_ms) / chunkDuration * envelope.length));
  const last = Math.min(envelope.length, Math.ceil((endMs - chunk.start_monotonic_ms) / chunkDuration * envelope.length));
  return envelope.slice(first, last);
}

function correlation(left: readonly number[], right: readonly number[]): number {
  const size = Math.min(left.length, right.length);
  if (size < 8) return 0;
  const leftMean = left.slice(0, size).reduce((sum, value) => sum + value, 0) / size;
  const rightMean = right.slice(0, size).reduce((sum, value) => sum + value, 0) / size;
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < size; index += 1) {
    const leftCentered = left[index] - leftMean;
    const rightCentered = right[index] - rightMean;
    numerator += leftCentered * rightCentered;
    leftEnergy += leftCentered * leftCentered;
    rightEnergy += rightCentered * rightCentered;
  }
  if (leftEnergy <= Number.EPSILON || rightEnergy <= Number.EPSILON) return 0;
  return numerator / Math.sqrt(leftEnergy * rightEnergy);
}

function bestLaggedCorrelation(left: readonly number[], right: readonly number[]): number {
  const maxLagBuckets = Math.round(MAX_LAG_MS / 1_000 * ENVELOPE_BUCKET_HZ);
  let best = 0;
  for (let lag = -maxLagBuckets; lag <= maxLagBuckets; lag += 1) {
    const leftStart = Math.max(0, -lag);
    const rightStart = Math.max(0, lag);
    const size = Math.min(left.length - leftStart, right.length - rightStart);
    if (size < 8) continue;
    best = Math.max(best, correlation(
      left.slice(leftStart, leftStart + size),
      right.slice(rightStart, rightStart + size),
    ));
  }
  return best;
}

async function utteranceEnvelope(
  utterance: MeetingUtterance,
  chunks: Map<string, MeetingAudioChunk>,
  loadAudio: AcousticDedupeInput['loadAudio'],
): Promise<number[] | null> {
  const result: number[] = [];
  for (const chunkId of utterance.source_chunk_ids) {
    const chunk = chunks.get(chunkId);
    if (!chunk) return null;
    const audio = await loadAudio(chunk);
    if (!audio) return null;
    const envelope = pcm16Envelope(chunk, audio);
    if (!envelope) return null;
    result.push(...sliceEnvelope(envelope, chunk, utterance.start_ms, utterance.end_ms));
  }
  return result.length >= 8 ? result : null;
}

/**
 * Produce persisted acoustic decisions only for ambiguous exact-text pairs.
 * It does not touch raw media and deliberately retains low-correlation or
 * uncertain pairs. The text-only finalizer remains the last-resort fallback
 * when PCM evidence is missing.
 */
export async function inferAcousticCrossTrackDuplicateAssessments(
  input: AcousticDedupeInput,
): Promise<CrossTrackDuplicateAssessment[]> {
  const chunks = new Map(input.chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const cache = new Map<string, Promise<number[] | null>>();
  const envelope = (utterance: MeetingUtterance) => {
    const cached = cache.get(utterance.utterance_id);
    if (cached) return cached;
    const created = utteranceEnvelope(utterance, chunks, input.loadAudio);
    cache.set(utterance.utterance_id, created);
    return created;
  };
  const sorted = [...input.utterances].sort((left, right) => left.start_ms - right.start_ms
    || left.utterance_id.localeCompare(right.utterance_id));
  const assessments: CrossTrackDuplicateAssessment[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex];
    const text = normalizedText(left.text);
    if (text.length < 6) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = sorted[rightIndex];
      if (right.start_ms > left.end_ms) break;
      if (left.track === right.track || text !== normalizedText(right.text) || timeOverlapRatio(left, right) < 0.7) continue;
      const [leftEnvelope, rightEnvelope] = await Promise.all([envelope(left), envelope(right)]);
      if (!leftEnvelope || !rightEnvelope) continue;
      const similarity = bestLaggedCorrelation(leftEnvelope, rightEnvelope);
      const primary = left.track === 'remote' ? left : right;
      const candidate = primary === left ? right : left;
      if (similarity >= SUPPRESS_CORRELATION) assessments.push({
        primary_utterance_id: primary.utterance_id,
        candidate_utterance_id: candidate.utterance_id,
        disposition: 'suppress_derived_duplicate',
        confidence: Math.min(0.99, similarity),
        signals: ['aec', 'acoustic_similarity', 'text_similarity', 'time_overlap'],
      });
      else assessments.push({
        primary_utterance_id: primary.utterance_id,
        candidate_utterance_id: candidate.utterance_id,
        disposition: 'retain_conflict',
        confidence: Math.max(0.5, 1 - similarity),
        signals: ['acoustic_similarity', 'text_similarity', 'time_overlap'],
      });
      // Any available acoustic sample below the calibrated suppression bar is
      // an explicit retain decision. The text fallback must never overrule
      // contradictory real-audio evidence.
    }
  }
  return assessments;
}
