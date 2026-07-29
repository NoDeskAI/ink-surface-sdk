import type { MeetingChunkDeliveryState, MeetingTranscriptState, MeetingUtterance } from './contracts.js';
import { pendingChunks } from './chunk-delivery.js';

function sameUtterance(left: MeetingUtterance, right: MeetingUtterance): boolean {
  return left.utterance_id === right.utterance_id
    && left.session_id === right.session_id
    && left.track === right.track
    && left.start_ms === right.start_ms
    && left.end_ms === right.end_ms
    && left.text === right.text
    && left.revision === right.revision
    && left.stability === right.stability
    && left.speaker_cluster_id === right.speaker_cluster_id
    && left.confidence === right.confidence
    && left.duplicate_of === right.duplicate_of
    && left.source_chunk_ids.join('\u0000') === right.source_chunk_ids.join('\u0000');
}

function validateUtterance(state: MeetingTranscriptState, utterance: MeetingUtterance): void {
  if (!utterance.utterance_id || !utterance.text) throw new Error('utterance_id and text are required');
  if (utterance.session_id !== state.session_id) throw new Error('utterance belongs to another session');
  if (!Number.isInteger(utterance.revision) || utterance.revision < 1) throw new Error('utterance revision must be a positive integer');
  if (utterance.end_ms <= utterance.start_ms) throw new Error('utterance end_ms must be greater than start_ms');
  if (utterance.stability !== 'provisional') throw new Error('only provisional utterances can be upserted');
}

export function upsertProvisionalUtterance(
  state: MeetingTranscriptState,
  utterance: MeetingUtterance,
): MeetingTranscriptState {
  if (state.status !== 'provisional') throw new Error('formal transcript cannot accept provisional revisions');
  validateUtterance(state, utterance);
  const index = state.utterances.findIndex((candidate) => candidate.utterance_id === utterance.utterance_id);
  if (index >= 0) {
    const existing = state.utterances[index];
    if (utterance.revision < existing.revision) return state;
    if (utterance.revision === existing.revision) {
      if (!sameUtterance(existing, utterance)) throw new Error(`utterance revision conflict for ${utterance.utterance_id}`);
      return state;
    }
    const utterances = [...state.utterances];
    utterances[index] = { ...utterance, source_chunk_ids: [...utterance.source_chunk_ids] };
    return { ...state, utterances, revision: state.revision + 1 };
  }
  return {
    ...state,
    utterances: [...state.utterances, { ...utterance, source_chunk_ids: [...utterance.source_chunk_ids] }],
    revision: state.revision + 1,
  };
}

export function finalizeTranscript(
  state: MeetingTranscriptState,
  delivery: MeetingChunkDeliveryState,
  finalizedAtMs = Date.now(),
  additionalMissingChunkIds: string[] = [],
): MeetingTranscriptState {
  if (state.session_id !== delivery.session_id) throw new Error('transcript and chunk delivery sessions must match');
  if (state.status === 'formal') return state;
  const missing = [...pendingChunks(delivery).map((chunk) => chunk.chunk_id), ...additionalMissingChunkIds];
  const knownChunkIds = new Set(Object.values(delivery.chunks).map((chunk) => chunk.chunk_id));
  for (const utterance of state.utterances) {
    for (const ref of utterance.source_chunk_ids) {
      if (!knownChunkIds.has(ref)) missing.push(ref);
    }
  }
  const missingChunks = [...new Set(missing)].sort();
  return {
    ...state,
    status: 'formal',
    finality: missingChunks.length === 0 ? 'final' : 'partial',
    utterances: state.utterances
      .map((utterance) => ({ ...utterance, stability: 'formal' as const, source_chunk_ids: [...utterance.source_chunk_ids] }))
      .sort((left, right) => left.start_ms - right.start_ms || left.utterance_id.localeCompare(right.utterance_id)),
    missing_chunks: missingChunks,
    revision: state.revision + 1,
    finalized_at_ms: finalizedAtMs,
  };
}
