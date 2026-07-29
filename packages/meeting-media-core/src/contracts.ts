export const MEETING_SESSION_SCHEMA_VERSION = 'inkloop.meeting_session.v1' as const;
export const MEETING_AUDIO_CHUNK_SCHEMA_VERSION = 'inkloop.meeting_audio_chunk.v1' as const;
export const MEETING_REALTIME_AUDIO_FRAME_SCHEMA_VERSION = 'inkloop.meeting_realtime_audio_frame.v1' as const;
export const MEETING_CHUNK_DELIVERY_SCHEMA_VERSION = 'inkloop.meeting_chunk_delivery.v1' as const;
export const MEETING_TRANSCRIPT_SCHEMA_VERSION = 'inkloop.meeting_transcript.v1' as const;

export type MeetingPlatform = 'google_meet' | 'zoom';
export type MeetingSessionStartMode = 'automatic' | 'manual';
export type MeetingSessionStatus = 'detected' | 'recording' | 'paused' | 'sealed';
export type MeetingAudioTrack = 'mic' | 'remote';
export type MeetingRealtimeAudioDerivation = 'raw' | 'apple_voice_processing';

export interface MeetingContractValidationIssue {
  path: string;
  message: string;
}

export interface ConfirmedMeetingEndEvidence {
  adapter: string;
  signal: string;
  provider_event_id?: string;
  observed_at_wall_clock_ms?: number;
}

export interface MeetingAudioChunk {
  schema_version: typeof MEETING_AUDIO_CHUNK_SCHEMA_VERSION;
  chunk_id: string;
  session_id: string;
  track: MeetingAudioTrack;
  sequence: number;
  start_monotonic_ms: number;
  end_monotonic_ms: number;
  checksum: string;
  byte_length: number;
  sealed: boolean;
  codec?: string;
  sample_rate_hz?: number;
  channel_count?: number;
}

/**
 * Ephemeral low-latency ASR projection input. The enclosing 5-second
 * MeetingAudioChunk remains the immutable fact and retry boundary.
 */
export interface MeetingRealtimeAudioFrame {
  schema_version: typeof MEETING_REALTIME_AUDIO_FRAME_SCHEMA_VERSION;
  frame_id: string;
  session_id: string;
  track: MeetingAudioTrack;
  frame_sequence: number;
  source_chunk_id: string;
  start_monotonic_ms: number;
  end_monotonic_ms: number;
  codec: 'pcm_s16le';
  sample_rate_hz: number;
  channel_count: 1;
  /**
   * Client-side speech projection decision when one was made. A false frame
   * carries no audio and advances transport coverage. An omitted value means
   * the server must apply its own VAD (the default for Remote).
   */
  speech_present?: boolean;
  /**
   * Identifies the ephemeral ASR projection. Authoritative fact chunks remain
   * raw even when this frame was produced by Apple Voice Processing.
   */
  audio_derivation?: MeetingRealtimeAudioDerivation;
}

export interface MeetingAudioChunkAcknowledgement {
  session_id: string;
  track: MeetingAudioTrack;
  sequence: number;
  chunk_id: string;
  checksum: string;
  acknowledged_at_ms: number;
}

export interface MeetingChunkDeliveryState {
  schema_version: typeof MEETING_CHUNK_DELIVERY_SCHEMA_VERSION;
  session_id: string;
  chunks: Record<string, MeetingAudioChunk>;
  acknowledgements: Record<string, MeetingAudioChunkAcknowledgement>;
}

export interface MeetingUtterance {
  utterance_id: string;
  session_id: string;
  track: MeetingAudioTrack;
  start_ms: number;
  end_ms: number;
  text: string;
  revision: number;
  stability: 'provisional' | 'formal';
  source_chunk_ids: string[];
  speaker_cluster_id?: string;
  confidence?: number;
  duplicate_of?: string;
}

export interface MeetingTranscriptState {
  schema_version: typeof MEETING_TRANSCRIPT_SCHEMA_VERSION;
  session_id: string;
  status: 'provisional' | 'formal';
  finality?: 'final' | 'partial';
  utterances: MeetingUtterance[];
  missing_chunks: string[];
  revision: number;
  finalized_at_ms?: number;
}

export interface MeetingSessionAuditEvent {
  event_id: string;
  type:
    | 'session.detected'
    | 'recording.started'
    | 'recording.paused'
    | 'recording.resumed'
    | 'audio.chunk.sealed'
    | 'audio.track.unavailable'
    | 'meeting.end.confirmed'
    | 'session.interrupted.recovered'
    | 'recording.stopped';
  at_monotonic_ms: number;
  evidence?: ConfirmedMeetingEndEvidence;
  chunk_ref?: Pick<MeetingAudioChunk, 'chunk_id' | 'track' | 'sequence' | 'checksum'>;
  stop_reason?: 'meeting_end_confirmed' | 'manual' | 'interrupted_session_recovered';
  track?: MeetingAudioTrack;
  unavailability_reason?: string;
}

export interface MeetingSessionState {
  schema_version: typeof MEETING_SESSION_SCHEMA_VERSION;
  session_id: string;
  platform: MeetingPlatform;
  meeting_ref: string;
  start_mode: MeetingSessionStartMode;
  status: MeetingSessionStatus;
  wall_clock_anchor_ms: number;
  monotonic_anchor_ms: number;
  started_monotonic_ms?: number;
  ended_monotonic_ms?: number;
  stop_reason?: 'meeting_end_confirmed' | 'manual' | 'interrupted_session_recovered';
  events: MeetingSessionAuditEvent[];
}

export type MeetingSessionEvent =
  | { type: 'recording.started'; at_monotonic_ms: number }
  | { type: 'recording.paused'; at_monotonic_ms: number }
  | { type: 'recording.resumed'; at_monotonic_ms: number }
  | { type: 'audio.chunk.sealed'; at_monotonic_ms: number; chunk: MeetingAudioChunk }
  | { type: 'audio.track.unavailable'; at_monotonic_ms: number; track: MeetingAudioTrack; reason: string }
  | { type: 'meeting.end.confirmed'; at_monotonic_ms: number; evidence: ConfirmedMeetingEndEvidence }
  | { type: 'session.interrupted.recovered'; at_monotonic_ms: number }
  | { type: 'recording.stopped'; at_monotonic_ms: number; reason: 'manual' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(
  value: Record<string, unknown>,
  key: string,
  issues: MeetingContractValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || value[key] === '') issues.push({ path: key, message: 'must be a non-empty string' });
}

function requireFiniteNumber(
  value: Record<string, unknown>,
  key: string,
  issues: MeetingContractValidationIssue[],
): void {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) issues.push({ path: key, message: 'must be a finite number' });
}

export function validateMeetingAudioChunk(value: unknown): MeetingContractValidationIssue[] {
  if (!isRecord(value)) return [{ path: '', message: 'must be an object' }];
  const issues: MeetingContractValidationIssue[] = [];
  if (value.schema_version !== MEETING_AUDIO_CHUNK_SCHEMA_VERSION) {
    issues.push({ path: 'schema_version', message: `must be ${MEETING_AUDIO_CHUNK_SCHEMA_VERSION}` });
  }
  requireNonEmptyString(value, 'chunk_id', issues);
  requireNonEmptyString(value, 'session_id', issues);
  requireNonEmptyString(value, 'checksum', issues);
  if (value.track !== 'mic' && value.track !== 'remote') issues.push({ path: 'track', message: 'must be mic or remote' });
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 0) {
    issues.push({ path: 'sequence', message: 'must be a non-negative integer' });
  }
  requireFiniteNumber(value, 'start_monotonic_ms', issues);
  requireFiniteNumber(value, 'end_monotonic_ms', issues);
  if (typeof value.start_monotonic_ms === 'number' && typeof value.end_monotonic_ms === 'number' && value.end_monotonic_ms <= value.start_monotonic_ms) {
    issues.push({ path: 'end_monotonic_ms', message: 'must be greater than start_monotonic_ms' });
  }
  if (!Number.isInteger(value.byte_length) || Number(value.byte_length) < 0) {
    issues.push({ path: 'byte_length', message: 'must be a non-negative integer' });
  }
  if (value.sealed !== true) issues.push({ path: 'sealed', message: 'must be true before delivery' });
  return issues;
}

export function assertMeetingAudioChunk(value: unknown): asserts value is MeetingAudioChunk {
  const issues = validateMeetingAudioChunk(value);
  if (issues.length > 0) throw new Error(`invalid meeting audio chunk: ${issues.map((issue) => `${issue.path} ${issue.message}`).join(', ')}`);
}

export function validateMeetingRealtimeAudioFrame(value: unknown): MeetingContractValidationIssue[] {
  if (!isRecord(value)) return [{ path: '', message: 'must be an object' }];
  const issues: MeetingContractValidationIssue[] = [];
  if (value.schema_version !== MEETING_REALTIME_AUDIO_FRAME_SCHEMA_VERSION) {
    issues.push({ path: 'schema_version', message: `must be ${MEETING_REALTIME_AUDIO_FRAME_SCHEMA_VERSION}` });
  }
  requireNonEmptyString(value, 'frame_id', issues);
  requireNonEmptyString(value, 'session_id', issues);
  requireNonEmptyString(value, 'source_chunk_id', issues);
  if (value.track !== 'mic' && value.track !== 'remote') issues.push({ path: 'track', message: 'must be mic or remote' });
  if (!Number.isInteger(value.frame_sequence) || Number(value.frame_sequence) < 0) {
    issues.push({ path: 'frame_sequence', message: 'must be a non-negative integer' });
  }
  requireFiniteNumber(value, 'start_monotonic_ms', issues);
  requireFiniteNumber(value, 'end_monotonic_ms', issues);
  if (typeof value.start_monotonic_ms === 'number' && typeof value.end_monotonic_ms === 'number'
    && value.end_monotonic_ms <= value.start_monotonic_ms) {
    issues.push({ path: 'end_monotonic_ms', message: 'must be greater than start_monotonic_ms' });
  }
  if (value.codec !== 'pcm_s16le') issues.push({ path: 'codec', message: 'must be pcm_s16le' });
  if (value.sample_rate_hz !== 16_000) issues.push({ path: 'sample_rate_hz', message: 'must be 16000' });
  if (value.channel_count !== 1) issues.push({ path: 'channel_count', message: 'must be 1' });
  if (value.speech_present !== undefined && typeof value.speech_present !== 'boolean') {
    issues.push({ path: 'speech_present', message: 'must be a boolean when provided' });
  }
  if (value.audio_derivation !== undefined
    && value.audio_derivation !== 'raw'
    && value.audio_derivation !== 'apple_voice_processing') {
    issues.push({ path: 'audio_derivation', message: 'must be raw or apple_voice_processing when provided' });
  }
  return issues;
}

export function assertMeetingRealtimeAudioFrame(value: unknown): asserts value is MeetingRealtimeAudioFrame {
  const issues = validateMeetingRealtimeAudioFrame(value);
  if (issues.length > 0) {
    throw new Error(`invalid meeting realtime audio frame: ${issues.map((issue) => `${issue.path} ${issue.message}`).join(', ')}`);
  }
}
