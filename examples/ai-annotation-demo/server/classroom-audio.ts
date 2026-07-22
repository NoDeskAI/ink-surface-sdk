import { createHash, randomBytes } from 'node:crypto';
import type { JsonClassroomStore } from './classroom-store';
import type { ClassroomTranscriptionService } from './classroom-transcription';

export type ClassroomAudioAuth = { role: 'teacher' } | { role: 'participant'; participant_id: string };
export type ClassroomAudioSignalType = 'ready' | 'offer' | 'answer' | 'ice' | 'leave';

export interface ClassroomAudioSignal {
  signal_sequence: number;
  message_id: string;
  participant_id: string;
  negotiation_generation: number;
  type: ClassroomAudioSignalType;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at_ms: number;
  sender_role: 'teacher' | 'participant';
}

export interface ClassroomRecording {
  recording_id: string;
  classroom_id: string;
  classroom_generation: number;
  recording_generation: number;
  state: 'recording' | 'stopped' | 'interrupted';
  health: 'healthy' | 'incomplete';
  sample_rate?: number;
  channels?: number;
  chunk_count: number;
  byte_count: number;
  last_sequence: number;
  last_relative_end_ms: number;
  started_at: string;
  stopped_at?: string;
  interrupted_at?: string;
}

export interface ClassroomPcmChunkInput {
  recording_id: string;
  recording_generation: number;
  chunk_id: string;
  sequence: number;
  sample_rate: number;
  channels: number;
  relative_start_ms: number;
  relative_end_ms: number;
  pcm_s16le_base64: string;
  external_transcription_opt_in?: boolean;
  language_hint?: 'zh' | 'en';
}

const SIGNAL_TTL_MS = 30_000;
const MAX_SIGNAL_PAYLOAD_BYTES = 96 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const MAX_CHUNK_DURATION_MS = 5_000;

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(value || ''))) throw new Error(`${label}_invalid`);
  return value;
}

function safeGeneration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new Error(`${label}_invalid`);
  return value;
}

export class ClassroomAudioService {
  private readonly signalMailboxes = new Map<string, ClassroomAudioSignal[]>();
  private readonly signalGenerations = new Map<string, Map<string, number>>();
  private readonly signalSequences = new Map<string, number>();
  private readonly signalRates = new Map<string, { startedAt: number; count: number }>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: JsonClassroomStore, private readonly transcription?: ClassroomTranscriptionService) {}

  private serialize<T>(classroomId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(classroomId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.queues.set(classroomId, current);
    return current.finally(() => { if (this.queues.get(classroomId) === current) this.queues.delete(classroomId); });
  }

  private async assertLive(classroomId: string): Promise<void> {
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    if (classroom.status !== 'live') throw new Error('classroom_not_live');
  }

  private async assertParticipant(classroomId: string, participantId: string): Promise<void> {
    if (!await this.store.hasParticipant(classroomId, participantId)) throw new Error('participant_not_found');
  }

  async signal(classroomId: string, auth: ClassroomAudioAuth, input: {
    message_id: string;
    negotiation_generation: number;
    participant_id?: string;
    type: ClassroomAudioSignalType;
    payload: Record<string, unknown>;
  }): Promise<ClassroomAudioSignal> {
    await this.assertLive(classroomId);
    safeId(input.message_id, 'audio_message_id'); safeGeneration(input.negotiation_generation, 'negotiation_generation');
    if (!['ready', 'offer', 'answer', 'ice', 'leave'].includes(input.type)) throw new Error('audio_signal_type_invalid');
    const allowed = auth.role === 'teacher' ? ['offer', 'ice', 'leave'] : ['ready', 'answer', 'ice', 'leave'];
    if (!allowed.includes(input.type)) throw new Error('audio_signal_direction_invalid');
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload) || Buffer.byteLength(JSON.stringify(input.payload)) > MAX_SIGNAL_PAYLOAD_BYTES) throw new Error('audio_signal_payload_invalid');
    const participantId = auth.role === 'teacher' ? safeId(String(input.participant_id || ''), 'participant_id') : auth.participant_id;
    if (auth.role === 'participant' && input.participant_id && input.participant_id !== auth.participant_id) throw new Error('audio_signal_scope_invalid');
    await this.assertParticipant(classroomId, participantId);
    const rateKey = `${classroomId}:${auth.role}:${participantId}`; const now = Date.now(); const rate = this.signalRates.get(rateKey);
    if (!rate || now - rate.startedAt >= 1_000) this.signalRates.set(rateKey, { startedAt: now, count: 1 });
    else { rate.count += 1; if (rate.count > 40) throw new Error('audio_signal_rate_limited'); }
    const generations = this.signalGenerations.get(classroomId) ?? new Map<string, number>(); this.signalGenerations.set(classroomId, generations);
    const latestGeneration = generations.get(participantId) ?? 0;
    if (input.negotiation_generation < latestGeneration) throw new Error('negotiation_generation_stale');
    if (input.negotiation_generation > latestGeneration) generations.set(participantId, input.negotiation_generation);
    const mailbox = (this.signalMailboxes.get(classroomId) ?? []).filter((item) => item.expires_at_ms > Date.now());
    const existing = mailbox.find((item) => item.message_id === input.message_id);
    if (existing) {
      const sameRequest = existing.participant_id === participantId && existing.sender_role === auth.role
        && existing.negotiation_generation === input.negotiation_generation && existing.type === input.type
        && JSON.stringify(existing.payload) === JSON.stringify(input.payload);
      if (!sameRequest) throw new Error('audio_message_id_conflict');
      return structuredClone(existing);
    }
    const signal: ClassroomAudioSignal = {
      signal_sequence: (this.signalSequences.get(classroomId) ?? 0) + 1, message_id: input.message_id, participant_id: participantId,
      negotiation_generation: input.negotiation_generation, type: input.type, payload: structuredClone(input.payload),
      created_at: new Date().toISOString(), expires_at_ms: Date.now() + SIGNAL_TTL_MS, sender_role: auth.role,
    };
    this.signalSequences.set(classroomId, signal.signal_sequence); mailbox.push(signal); this.signalMailboxes.set(classroomId, mailbox.slice(-256));
    return structuredClone(signal);
  }

  async signals(classroomId: string, auth: ClassroomAudioAuth, afterSequence: number): Promise<{ messages: ClassroomAudioSignal[]; cursor: number }> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error('audio_signal_cursor_invalid');
    if (!await this.store.getClassroom(classroomId)) throw new Error('classroom_not_found');
    const mailbox = (this.signalMailboxes.get(classroomId) ?? []).filter((item) => item.expires_at_ms > Date.now());
    this.signalMailboxes.set(classroomId, mailbox);
    const scoped = mailbox.filter((item) => item.signal_sequence > afterSequence
      && item.sender_role !== auth.role
      && item.negotiation_generation === (this.signalGenerations.get(classroomId)?.get(item.participant_id) ?? item.negotiation_generation)
      && (auth.role === 'teacher' || item.participant_id === auth.participant_id));
    return { messages: structuredClone(scoped), cursor: Math.max(afterSequence, this.signalSequences.get(classroomId) ?? 0) };
  }

  async start(classroomId: string): Promise<ClassroomRecording> {
    return this.serialize(classroomId, async () => {
      await this.assertLive(classroomId);
      const current = await this.current(classroomId);
      if (current?.state === 'recording') return current;
      const classroomGeneration = await this.store.getClassroomGeneration(classroomId);
      const recording: ClassroomRecording = {
        recording_id: `recording_${randomBytes(12).toString('base64url')}`, classroom_id: classroomId,
        classroom_generation: classroomGeneration, recording_generation: (current?.recording_generation ?? 0) + 1,
        state: 'recording', health: 'healthy', chunk_count: 0, byte_count: 0, last_sequence: 0, last_relative_end_ms: 0,
        started_at: new Date().toISOString(),
      };
      await this.store.putRecordingState(classroomId, recording);
      return recording;
    });
  }

  async current(classroomId: string): Promise<ClassroomRecording | null> {
    const value = await this.store.getRecordingState(classroomId) as ClassroomRecording | null;
    if (!value?.recording_id) return null;
    if (value.state === 'recording' && value.classroom_generation !== await this.store.getClassroomGeneration(classroomId)) {
      const interrupted = { ...value, state: 'interrupted' as const, health: 'incomplete' as const, interrupted_at: new Date().toISOString() };
      await this.store.putRecordingState(classroomId, interrupted); return interrupted;
    }
    return value;
  }

  async appendChunk(classroomId: string, input: ClassroomPcmChunkInput): Promise<{ inserted: boolean; recording: ClassroomRecording }> {
    return this.serialize(classroomId, async () => {
      safeId(input.recording_id, 'recording_id'); safeId(input.chunk_id, 'chunk_id'); safeGeneration(input.recording_generation, 'recording_generation');
      if (!Number.isInteger(input.sequence) || input.sequence < 1) throw new Error('audio_chunk_sequence_invalid');
      if (![16_000, 24_000, 44_100, 48_000].includes(input.sample_rate) || ![1, 2].includes(input.channels)) throw new Error('audio_format_invalid');
      if (!Number.isFinite(input.relative_start_ms) || !Number.isFinite(input.relative_end_ms) || input.relative_start_ms < 0 || input.relative_end_ms <= input.relative_start_ms || input.relative_end_ms - input.relative_start_ms > MAX_CHUNK_DURATION_MS) throw new Error('audio_chunk_time_invalid');
      if (typeof input.pcm_s16le_base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.pcm_s16le_base64)) throw new Error('audio_chunk_invalid');
      if (input.language_hint !== undefined && !['zh', 'en'].includes(input.language_hint)) throw new Error('transcription_language_invalid');
      const bytes = Buffer.from(input.pcm_s16le_base64, 'base64');
      if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES) throw new Error('audio_chunk_invalid');
      const expectedBytes = Math.round(input.sample_rate * input.channels * 2 * (input.relative_end_ms - input.relative_start_ms) / 1_000);
      const frameBytes = input.channels * 2;
      const roundingTolerance = Math.ceil(input.sample_rate * frameBytes / 2_000);
      if (bytes.length % frameBytes !== 0 || Math.abs(bytes.length - expectedBytes) > Math.max(frameBytes, roundingTolerance)) throw new Error('audio_chunk_size_mismatch');
      const recording = await this.current(classroomId);
      if (!recording || recording.state !== 'recording') throw new Error('recording_not_active');
      if (recording.recording_id !== input.recording_id || recording.recording_generation !== input.recording_generation || recording.classroom_generation !== await this.store.getClassroomGeneration(classroomId)) throw new Error('recording_generation_stale');
      if ((recording.sample_rate && recording.sample_rate !== input.sample_rate) || (recording.channels && recording.channels !== input.channels)) throw new Error('audio_format_drift');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const inserted = await this.store.putAudioChunk(classroomId, input.recording_id, input.chunk_id, input.sequence, bytes, digest, {
        classroom_generation: recording.classroom_generation, recording_generation: input.recording_generation,
        sample_rate: input.sample_rate, channels: input.channels, relative_start_ms: input.relative_start_ms,
        relative_end_ms: input.relative_end_ms, external_transcription_opt_in: input.external_transcription_opt_in === true, language_hint: input.language_hint ?? 'zh',
      });
      if (!inserted && input.sequence <= recording.last_sequence) return { inserted: false, recording };
      const contiguous = input.sequence === recording.last_sequence + 1 && input.relative_start_ms <= recording.last_relative_end_ms + 50;
      const next: ClassroomRecording = {
        ...recording, sample_rate: input.sample_rate, channels: input.channels,
        health: recording.health === 'incomplete' || !contiguous ? 'incomplete' : 'healthy', chunk_count: recording.chunk_count + 1,
        byte_count: recording.byte_count + bytes.length, last_sequence: Math.max(recording.last_sequence, input.sequence),
        last_relative_end_ms: Math.max(recording.last_relative_end_ms, input.relative_end_ms),
      };
      await this.store.putRecordingState(classroomId, next);
      if (inserted && this.transcription) {
        const transcriptionChunk = {
          recording_id: input.recording_id, recording_generation: input.recording_generation,
          classroom_generation: recording.classroom_generation, chunk_id: input.chunk_id, chunk_hash: `sha256:${digest}` as const,
          sequence: input.sequence, sample_rate: input.sample_rate, channels: input.channels,
          relative_start_ms: input.relative_start_ms, relative_end_ms: input.relative_end_ms, pcm_s16le: bytes,
          external_transcription_opt_in: input.external_transcription_opt_in === true, language_hint: input.language_hint ?? 'zh',
        };
        await this.transcription.enqueueChunk(classroomId, transcriptionChunk);
      }
      return { inserted, recording: next };
    });
  }

  async stop(classroomId: string, recordingId: string, recordingGeneration: number, clientHealth?: 'healthy' | 'incomplete'): Promise<ClassroomRecording> {
    return this.serialize(classroomId, async () => {
      const current = await this.current(classroomId);
      if (!current || current.recording_id !== recordingId) throw new Error('recording_not_found');
      if (current.recording_generation !== recordingGeneration) throw new Error('recording_generation_stale');
      if (current.state !== 'recording') return current;
      await this.transcription?.finalizeRecording(classroomId, recordingId, recordingGeneration).catch(() => undefined);
      const stopped = { ...current, state: 'stopped' as const, health: current.health === 'incomplete' || clientHealth === 'incomplete' ? 'incomplete' as const : 'healthy' as const, stopped_at: new Date().toISOString() };
      await this.store.putRecordingState(classroomId, stopped); return stopped;
    });
  }

  async stopCurrent(classroomId: string): Promise<ClassroomRecording | null> {
    const current = await this.current(classroomId);
    if (!current || current.state !== 'recording') return current;
    return this.stop(classroomId, current.recording_id, current.recording_generation);
  }

  clearClassroom(classroomId: string): void {
    this.signalMailboxes.delete(classroomId); this.signalGenerations.delete(classroomId); this.signalSequences.delete(classroomId); this.queues.delete(classroomId);
    for (const key of this.signalRates.keys()) if (key.startsWith(`${classroomId}:`)) this.signalRates.delete(key);
  }
}
