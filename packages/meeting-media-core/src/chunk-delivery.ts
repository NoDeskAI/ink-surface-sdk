import {
  MEETING_CHUNK_DELIVERY_SCHEMA_VERSION,
  assertMeetingAudioChunk,
  type MeetingAudioChunk,
  type MeetingAudioChunkAcknowledgement,
  type MeetingChunkDeliveryState,
} from './contracts.js';

function deliveryKey(track: MeetingAudioChunk['track'], sequence: number): string {
  return `${track}:${sequence}`;
}

function sameChunk(left: MeetingAudioChunk, right: MeetingAudioChunk): boolean {
  return left.chunk_id === right.chunk_id
    && left.checksum === right.checksum
    && left.session_id === right.session_id
    && left.track === right.track
    && left.sequence === right.sequence
    && left.start_monotonic_ms === right.start_monotonic_ms
    && left.end_monotonic_ms === right.end_monotonic_ms
    && left.byte_length === right.byte_length;
}

export function createChunkDeliveryState(sessionId: string): MeetingChunkDeliveryState {
  if (!sessionId) throw new Error('session_id is required');
  return {
    schema_version: MEETING_CHUNK_DELIVERY_SCHEMA_VERSION,
    session_id: sessionId,
    chunks: {},
    acknowledgements: {},
  };
}

export function recordChunk(state: MeetingChunkDeliveryState, chunk: MeetingAudioChunk): MeetingChunkDeliveryState {
  assertMeetingAudioChunk(chunk);
  if (chunk.session_id !== state.session_id) throw new Error('audio chunk belongs to another delivery session');
  const key = deliveryKey(chunk.track, chunk.sequence);
  const existing = state.chunks[key];
  if (existing) {
    if (!sameChunk(existing, chunk)) throw new Error(`chunk conflict at ${key}`);
    return state;
  }
  if (Object.values(state.chunks).some((candidate) => candidate.chunk_id === chunk.chunk_id)) {
    throw new Error(`chunk conflict for duplicate chunk_id ${chunk.chunk_id}`);
  }
  return { ...state, chunks: { ...state.chunks, [key]: { ...chunk } } };
}

export function acknowledgeChunk(
  state: MeetingChunkDeliveryState,
  acknowledgement: MeetingAudioChunkAcknowledgement,
): MeetingChunkDeliveryState {
  const key = deliveryKey(acknowledgement.track, acknowledgement.sequence);
  const chunk = state.chunks[key];
  if (!chunk
    || acknowledgement.session_id !== state.session_id
    || acknowledgement.chunk_id !== chunk.chunk_id
    || acknowledgement.checksum !== chunk.checksum) {
    throw new Error(`acknowledgement mismatch at ${key}`);
  }
  const existing = state.acknowledgements[key];
  if (existing) {
    if (existing.chunk_id !== acknowledgement.chunk_id || existing.checksum !== acknowledgement.checksum) {
      throw new Error(`acknowledgement conflict at ${key}`);
    }
    return state;
  }
  return {
    ...state,
    acknowledgements: { ...state.acknowledgements, [key]: { ...acknowledgement } },
  };
}

export function pendingChunks(state: MeetingChunkDeliveryState): MeetingAudioChunk[] {
  const trackOrder: Record<MeetingAudioChunk['track'], number> = { mic: 0, remote: 1 };
  return Object.entries(state.chunks)
    .filter(([key]) => !state.acknowledgements[key])
    .map(([, chunk]) => chunk)
    .sort((left, right) => trackOrder[left.track] - trackOrder[right.track] || left.sequence - right.sequence);
}

export function acknowledgedChunks(state: MeetingChunkDeliveryState): MeetingAudioChunk[] {
  return Object.entries(state.chunks)
    .filter(([key]) => !!state.acknowledgements[key])
    .map(([, chunk]) => chunk);
}
