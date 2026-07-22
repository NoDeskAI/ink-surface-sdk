import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import {
  CLASSROOM_SCHEMA_VERSION,
  type ClassroomDeliveryMode,
  type ClassroomTranscriptRevision,
  type ClassroomTranscriptionState,
} from 'ink-surface-sdk/runtime-schema';
import type { ClassroomService } from './classroom-service';
import type { JsonClassroomStore } from './classroom-store';
import { classroomTranscriptContextTerms, stabilizeClassroomTranscriptText, type TranscriptStabilizationReason } from './classroom-transcript-stabilizer';
import type { ClassroomLessonOutput } from './classroom-lesson';

export interface ClassroomTranscriptionChunk {
  recording_id: string;
  recording_generation: number;
  classroom_generation: number;
  chunk_id: string;
  chunk_hash: `sha256:${string}`;
  sequence: number;
  sample_rate: number;
  channels: number;
  relative_start_ms: number;
  relative_end_ms: number;
  pcm_s16le: Uint8Array;
  external_transcription_opt_in?: boolean;
  finalize_stream?: boolean;
  language_hint?: 'zh' | 'en';
}

export interface ClassroomTranscriptionProviderInput {
  recording_id: string;
  recording_generation: number;
  sequence: number;
  chunk_id: string;
  chunk_hash: `sha256:${string}`;
  relative_start_ms: number;
  relative_end_ms: number;
  language_hint: string;
  wav_bytes: Uint8Array;
  external_opt_in: boolean;
  finalize?: boolean;
}

export interface ClassroomTranscriptionProviderResult {
  provider: string;
  processing_mode: 'local' | 'external';
  stream_id?: string;
  language?: string;
  segments: Array<{
    segment_id: string;
    status: 'provisional' | 'final';
    relative_start_ms: number;
    relative_end_ms: number;
    text: string;
    confidence: number;
  }>;
}

type TranscriptionProvider = (input: ClassroomTranscriptionProviderInput, signal: AbortSignal) => Promise<ClassroomTranscriptionProviderResult>;
type TranscriptStabilizer = (input: { classroomId: string; text: string }) => Promise<{ text: string; reasons: TranscriptStabilizationReason[] }>;

const MAX_TRANSCRIPT_SEGMENTS = 64;
const MAX_TRANSCRIPT_TEXT = 2_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_PENDING_TRANSCRIPTION_CHUNKS = 12;

function safeToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s，。！？、,.!?；;：“”"'‘’（）()]/g, '');
}

function overlaps(a: { relative_start_ms: number; relative_end_ms: number }, b: { relative_start_ms: number; relative_end_ms: number }): boolean {
  return Math.max(a.relative_start_ms, b.relative_start_ms) < Math.min(a.relative_end_ms, b.relative_end_ms);
}

function privateIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  return false;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.');
}

export async function validateTranscriptionProviderUrl(value: string, mode: 'local' | 'external', externalOptIn: boolean): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('transcription_provider_url_invalid'); }
  if (url.username || url.password) throw new Error('transcription_provider_credentials_forbidden');
  const localDestination = privateIp(url.hostname);
  if (mode === 'local') {
    if (!loopbackHost(url.hostname)) throw new Error('transcription_provider_loopback_required');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('transcription_provider_protocol_invalid');
  } else {
    if (!externalOptIn) throw new Error('transcription_external_opt_in_required');
    if (url.protocol !== 'https:') throw new Error('transcription_provider_https_required');
    if (localDestination) throw new Error('transcription_provider_private_address');
    if (!isIP(url.hostname)) {
      let addresses: Array<{ address: string }>;
      try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); } catch { throw new Error('transcription_provider_dns_failed'); }
      if (addresses.length === 0 || addresses.some((entry) => privateIp(entry.address))) throw new Error('transcription_provider_private_address');
    }
  }
  return url;
}

export function createHttpTranscriptionProvider(options: {
  baseUrl: string;
  mode: 'local' | 'external';
  externalOptIn?: boolean;
  apiKey?: string;
  fetcher?: typeof fetch;
}): TranscriptionProvider {
  return async (input, signal) => {
    const url = await validateTranscriptionProviderUrl(options.baseUrl, options.mode, options.externalOptIn === true && input.external_opt_in);
    const response = await (options.fetcher ?? fetch)(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({
        recording_id: input.recording_id, recording_generation: input.recording_generation, sequence: input.sequence,
        chunk_id: input.chunk_id, chunk_hash: input.chunk_hash, relative_start_ms: input.relative_start_ms,
        relative_end_ms: input.relative_end_ms, language_hint: input.language_hint,
        wav_base64: Buffer.from(input.wav_bytes).toString('base64'), finalize: input.finalize === true,
      }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'transcription_provider_rate_limited' : 'transcription_provider_unavailable');
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('transcription_response_too_large');
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('transcription_response_too_large');
    let payload: ClassroomTranscriptionProviderResult;
    try { payload = JSON.parse(body) as ClassroomTranscriptionProviderResult; } catch { throw new Error('transcription_response_invalid'); }
    return { ...payload, processing_mode: options.mode };
  };
}

export function resolveClassroomDeliveryMode(input: { audioPlaying: boolean; transcriptReady: boolean; teacherCaptureAvailable: boolean }): ClassroomDeliveryMode {
  if (input.audioPlaying && input.transcriptReady) return 'audio_with_subtitles';
  if (input.transcriptReady && input.teacherCaptureAvailable) return 'subtitles_only';
  return 'textbook_board_only';
}

function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const output = new Uint8Array(44 + pcm.byteLength); const view = new DataView(output.buffer);
  const ascii = (offset: number, value: string): void => { for (let index = 0; index < value.length; index += 1) output[offset + index] = value.charCodeAt(index); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, pcm.byteLength, true); output.set(pcm, 44); return output;
}

function publicError(error: unknown): string {
  const code = String((error as Error)?.message || error).split(':')[0];
  return /^[a-z0-9_]{1,96}$/.test(code) ? code : 'transcription_provider_failed';
}

export class ClassroomTranscriptionService {
  private readonly provider: TranscriptionProvider;
  private readonly chunks = new Map<string, ClassroomTranscriptionChunk>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, number>();
  private readonly stabilizer: TranscriptStabilizer;

  readonly processingMode: 'local' | 'external';

  constructor(private readonly store: JsonClassroomStore, private readonly classroomService: ClassroomService, options: { provider?: TranscriptionProvider; stabilizer?: TranscriptStabilizer; processingMode?: 'local' | 'external' } = {}) {
    this.provider = options.provider ?? (async () => { throw new Error('transcription_provider_unavailable'); });
    this.processingMode = options.processingMode ?? 'local';
    this.stabilizer = options.stabilizer ?? (async ({ classroomId, text }) => {
      const snapshot = await this.store.getSnapshot(classroomId);
      const lesson = await this.store.getTeacherRecord(classroomId, 'lesson_generation') as ClassroomLessonOutput | null;
      const result = stabilizeClassroomTranscriptText(text, classroomTranscriptContextTerms(snapshot, lesson));
      return { text: result.text, reasons: result.reasons };
    });
  }

  private chunkKey(classroomId: string, chunkId: string): string { return `${classroomId}:${chunkId}`; }

  async registerChunk(classroomId: string, chunk: ClassroomTranscriptionChunk): Promise<void> {
    safeToken(chunk.recording_id, 'recording_id'); safeToken(chunk.chunk_id, 'audio_chunk_id');
    this.chunks.set(this.chunkKey(classroomId, chunk.chunk_id), structuredClone(chunk));
    const existing = await this.store.getTeacherRecord(classroomId, `transcription_job_${chunk.chunk_id}`) as { status?: string; attempt?: number } | null;
    if (existing?.status === 'completed') return;
    await this.store.putTeacherRecord(classroomId, `transcription_job_${chunk.chunk_id}`, {
      status: existing?.status === 'failed' ? 'failed' : 'queued', recording_id: chunk.recording_id, recording_generation: chunk.recording_generation,
      classroom_generation: chunk.classroom_generation, chunk_id: chunk.chunk_id, chunk_hash: chunk.chunk_hash,
      sequence: chunk.sequence, sample_rate: chunk.sample_rate, channels: chunk.channels,
      relative_start_ms: chunk.relative_start_ms, relative_end_ms: chunk.relative_end_ms, attempt: existing?.attempt ?? 0,
      external_transcription_opt_in: chunk.external_transcription_opt_in === true, language_hint: chunk.language_hint ?? 'zh', updated_at: new Date().toISOString(),
    });
  }

  async enqueueChunk(classroomId: string, chunk: ClassroomTranscriptionChunk): Promise<void> {
    await this.registerChunk(classroomId, chunk);
    const count = this.pending.get(classroomId) ?? 0;
    if (count >= MAX_PENDING_TRANSCRIPTION_CHUNKS) {
      const current = await this.store.getTranscriptionState(classroomId);
      const retryable = [...new Set([...(current?.retryable_chunk_ids ?? []), chunk.chunk_id])].slice(-64);
      await this.state(classroomId, chunk, { state: 'delayed', failed_chunk_count: retryable.length, retryable_chunk_ids: retryable, last_error_code: 'transcription_queue_full' });
      return;
    }
    this.pending.set(classroomId, count + 1);
    const previous = this.queues.get(classroomId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(() => this.transcribeChunk(classroomId, chunk));
    this.queues.set(classroomId, queued);
    void queued.catch(() => undefined).finally(() => {
      const next = Math.max(0, (this.pending.get(classroomId) ?? 1) - 1);
      if (next === 0) this.pending.delete(classroomId); else this.pending.set(classroomId, next);
      if (this.queues.get(classroomId) === queued) this.queues.delete(classroomId);
    });
  }

  async recover(): Promise<void> {
    for (const classroomId of this.store.listClassroomIds()) {
      const recording = await this.store.getRecordingState(classroomId);
      if (!recording) continue;
      const currentState = await this.store.getTranscriptionState(classroomId);
      if (currentState?.retryable_chunk_ids?.length) {
        const retryable: string[] = [];
        for (const chunkId of currentState.retryable_chunk_ids) {
          const job = await this.store.getTeacherRecord(classroomId, `transcription_job_${chunkId}`) as { status?: string } | null;
          if (job?.status !== 'completed') retryable.push(chunkId);
        }
        if (retryable.length !== currentState.retryable_chunk_ids.length) {
          const repaired = await this.store.putTranscriptionState(classroomId, {
            ...currentState, state: retryable.length ? 'delayed' : 'ready', failed_chunk_count: retryable.length,
            retryable_chunk_ids: retryable, last_error_code: retryable.length ? currentState.last_error_code : undefined,
            updated_at: new Date().toISOString(),
          });
          this.classroomService.publishTranscription(classroomId, repaired);
        }
      }
      const completed = new Set((await this.store.listTranscriptRevisions(classroomId)).map((item) => item.chunk_id));
      for (const descriptor of await this.store.listAudioChunkDescriptors(classroomId, recording.recording_id)) {
        if (completed.has(descriptor.chunk_id)) continue;
        const job = await this.store.getTeacherRecord(classroomId, `transcription_job_${descriptor.chunk_id}`) as { status?: string } | null;
        if (job?.status === 'completed') continue;
        if (await this.store.isTranscriptChunkCleared(classroomId, recording.recording_id, descriptor.chunk_id)) continue;
        const pcm = await this.store.getAudioChunk(classroomId, recording.recording_id, descriptor.chunk_id); if (!pcm) continue;
        await this.enqueueChunk(classroomId, {
          recording_id: recording.recording_id, recording_generation: descriptor.metadata.recording_generation,
          classroom_generation: descriptor.metadata.classroom_generation, chunk_id: descriptor.chunk_id, chunk_hash: `sha256:${descriptor.hash}`,
          sequence: descriptor.sequence, sample_rate: descriptor.metadata.sample_rate, channels: descriptor.metadata.channels,
          relative_start_ms: descriptor.metadata.relative_start_ms, relative_end_ms: descriptor.metadata.relative_end_ms,
          external_transcription_opt_in: descriptor.metadata.external_transcription_opt_in, language_hint: descriptor.metadata.language_hint, pcm_s16le: pcm,
        });
      }
    }
  }

  private async state(classroomId: string, chunk: ClassroomTranscriptionChunk, patch: Partial<ClassroomTranscriptionState>): Promise<ClassroomTranscriptionState> {
    const current = await this.store.getTranscriptionState(classroomId);
    const state: ClassroomTranscriptionState = {
      classroom_id: classroomId, recording_id: chunk.recording_id, recording_generation: chunk.recording_generation,
      state: 'transcribing', provider: current?.provider ?? 'pending', processing_mode: current?.processing_mode ?? 'local',
      processed_chunk_count: current?.processed_chunk_count ?? 0, failed_chunk_count: current?.failed_chunk_count ?? 0,
      ...(current?.retryable_chunk_ids ? { retryable_chunk_ids: current.retryable_chunk_ids } : {}),
      audio_available: current?.audio_available ?? true, ...(current?.audio_deleted_at ? { audio_deleted_at: current.audio_deleted_at } : {}),
      updated_at: new Date().toISOString(), ...patch,
    };
    const saved = await this.store.putTranscriptionState(classroomId, state); this.classroomService.publishTranscription(classroomId, saved); return saved;
  }

  async transcribeChunk(classroomId: string, chunk: ClassroomTranscriptionChunk): Promise<ClassroomTranscriptRevision[]> {
    safeToken(chunk.recording_id, 'recording_id'); safeToken(chunk.chunk_id, 'audio_chunk_id');
    if (await this.store.isTranscriptChunkCleared(classroomId, chunk.recording_id, chunk.chunk_id)) return [];
    if (chunk.classroom_generation !== await this.store.getClassroomGeneration(classroomId)) throw new Error('classroom_generation_stale');
    const activeRecording = await this.store.getRecordingState(classroomId);
    if (!activeRecording || activeRecording.recording_id !== chunk.recording_id || activeRecording.recording_generation !== chunk.recording_generation) throw new Error('recording_generation_stale');
    await this.registerChunk(classroomId, chunk);
    const previousJob = await this.store.getTeacherRecord(classroomId, `transcription_job_${chunk.chunk_id}`) as { attempt?: number } | null;
    await this.store.putTeacherRecord(classroomId, `transcription_job_${chunk.chunk_id}`, {
      status: 'running', recording_id: chunk.recording_id, recording_generation: chunk.recording_generation,
      classroom_generation: chunk.classroom_generation, chunk_id: chunk.chunk_id, chunk_hash: chunk.chunk_hash,
      sequence: chunk.sequence, sample_rate: chunk.sample_rate, channels: chunk.channels,
      relative_start_ms: chunk.relative_start_ms, relative_end_ms: chunk.relative_end_ms, attempt: (previousJob?.attempt ?? 0) + 1,
      external_transcription_opt_in: chunk.external_transcription_opt_in === true,
      language_hint: chunk.language_hint ?? 'zh',
      updated_at: new Date().toISOString(),
    });
    await this.state(classroomId, chunk, { state: 'transcribing', last_error_code: undefined });
    const controller = new AbortController(); const set = this.controllers.get(classroomId) ?? new Set<AbortController>(); set.add(controller); this.controllers.set(classroomId, set);
    const timeout = setTimeout(() => controller.abort('provider_timeout'), PROVIDER_TIMEOUT_MS);
    try {
      const providerPromise = this.provider({
        recording_id: chunk.recording_id, recording_generation: chunk.recording_generation, sequence: chunk.sequence,
        chunk_id: chunk.chunk_id, chunk_hash: chunk.chunk_hash, relative_start_ms: chunk.relative_start_ms,
        relative_end_ms: chunk.relative_end_ms, language_hint: chunk.language_hint ?? 'zh', wav_bytes: pcmToWav(chunk.pcm_s16le, chunk.sample_rate, chunk.channels),
        external_opt_in: chunk.external_transcription_opt_in === true, finalize: chunk.finalize_stream === true,
      }, controller.signal);
      const timeoutPromise = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('provider_timeout')), { once: true }));
      const result = await Promise.race([providerPromise, timeoutPromise]);
      if (await this.store.isTranscriptChunkCleared(classroomId, chunk.recording_id, chunk.chunk_id)) return [];
      if (chunk.classroom_generation !== await this.store.getClassroomGeneration(classroomId)) throw new Error('classroom_generation_stale');
      const currentRecording = await this.store.getRecordingState(classroomId);
      if (!currentRecording || currentRecording.recording_id !== chunk.recording_id || currentRecording.recording_generation !== chunk.recording_generation) throw new Error('recording_generation_stale');
      if (!result || !['local', 'external'].includes(result.processing_mode) || !safeToken(result.provider, 'transcription_provider')
        || !Array.isArray(result.segments) || result.segments.length > MAX_TRANSCRIPT_SEGMENTS) throw new Error('transcription_response_invalid');
      const streamId = result.stream_id ? safeToken(result.stream_id, 'transcription_stream_id') : undefined;
      const language = String(result.language || 'zh-en').trim();
      if (!language || language.length > 32) throw new Error('transcription_language_invalid');
      const stored = await this.store.listTranscriptRevisions(classroomId); const appended: ClassroomTranscriptRevision[] = [];
      for (const segment of result.segments) {
        safeToken(segment.segment_id, 'transcription_segment_id');
        const text = String(segment.text || '').trim();
        if (!['provisional', 'final'].includes(segment.status) || text.length === 0 || text.length > MAX_TRANSCRIPT_TEXT || !Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1) throw new Error('transcription_segment_invalid');
        const minimumStart = streamId ? 0 : chunk.relative_start_ms;
        if (!Number.isInteger(segment.relative_start_ms) || !Number.isInteger(segment.relative_end_ms) || segment.relative_start_ms < minimumStart
          || segment.relative_end_ms > chunk.relative_end_ms || segment.relative_end_ms <= segment.relative_start_ms) throw new Error('transcription_segment_time_invalid');
        const duplicate = [...stored, ...appended].some((item) => item.status !== 'provisional' && segment.status === 'final'
          && normalizedText(item.text) === normalizedText(text) && overlaps(item, segment));
        if (duplicate) continue;
        const transcriptScope = streamId ? `${chunk.recording_id}:${streamId}` : `${chunk.recording_id}:${chunk.chunk_id}`;
        const transcriptId = `transcript_${createHash('sha256').update(`${transcriptScope}:${result.provider}:${segment.segment_id}`).digest('hex').slice(0, 24)}`;
        const history = [...stored, ...appended].filter((item) => item.transcript_id === transcriptId);
        const revision: ClassroomTranscriptRevision = {
          schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, transcript_id: transcriptId, revision: history.length + 1,
          status: segment.status, recording_id: chunk.recording_id, recording_generation: chunk.recording_generation, chunk_id: chunk.chunk_id,
          chunk_hash: chunk.chunk_hash, relative_start_ms: segment.relative_start_ms, relative_end_ms: segment.relative_end_ms, text,
          confidence: segment.confidence, language, provider: result.provider, processing_mode: result.processing_mode, created_at: new Date().toISOString(),
        };
        const saved = await this.store.appendTranscriptRevision(classroomId, revision); appended.push(saved); this.classroomService.publishTranscript(classroomId, saved);
        if (saved.status === 'final' && /(?:sherpa|streaming)/i.test(saved.provider)) {
          const stabilized = await this.stabilizer({ classroomId, text: saved.text }).catch(() => ({ text: saved.text, reasons: [] as TranscriptStabilizationReason[] }));
          const stabilizedText = stabilized.text.trim();
          if (stabilizedText && stabilizedText !== saved.text && stabilizedText.length <= MAX_TRANSCRIPT_TEXT) {
            const now = new Date().toISOString();
            const corrected: ClassroomTranscriptRevision = {
              ...saved, revision: saved.revision + 1, status: 'corrected', text: stabilizedText,
              provider: `${saved.provider}_stabilizer`.slice(0, 128), original_revision: saved.revision,
              created_at: now, corrected_at: now,
            };
            const stabilizedRevision = await this.store.appendTranscriptRevision(classroomId, corrected);
            appended.push(stabilizedRevision); this.classroomService.publishTranscript(classroomId, stabilizedRevision);
            await this.store.putTeacherRecord(classroomId, `transcript_stabilization_${saved.transcript_id}_${corrected.revision}`, {
              transcript_id: saved.transcript_id, source_revision: saved.revision, corrected_revision: corrected.revision,
              source_text: saved.text, corrected_text: stabilizedText, reasons: stabilized.reasons, created_at: now,
            });
          }
        }
      }
      const current = await this.store.getTranscriptionState(classroomId);
      const remainingRetryable = (current?.retryable_chunk_ids ?? []).filter((id) => id !== chunk.chunk_id);
      await this.state(classroomId, chunk, {
        state: remainingRetryable.length > 0 ? 'delayed' : 'ready', provider: result.provider, processing_mode: result.processing_mode,
        processed_chunk_count: (current?.processed_chunk_count ?? 0) + 1,
        failed_chunk_count: remainingRetryable.length, retryable_chunk_ids: remainingRetryable,
        last_error_code: remainingRetryable.length > 0 ? current?.last_error_code ?? 'transcription_retry_pending' : undefined,
      });
      await this.store.putTeacherRecord(classroomId, `transcription_job_${chunk.chunk_id}`, {
        status: 'completed', recording_id: chunk.recording_id, recording_generation: chunk.recording_generation,
        classroom_generation: chunk.classroom_generation, chunk_id: chunk.chunk_id, chunk_hash: chunk.chunk_hash,
        sequence: chunk.sequence, sample_rate: chunk.sample_rate, channels: chunk.channels,
        relative_start_ms: chunk.relative_start_ms, relative_end_ms: chunk.relative_end_ms, attempt: (previousJob?.attempt ?? 0) + 1,
        external_transcription_opt_in: chunk.external_transcription_opt_in === true,
        language_hint: chunk.language_hint ?? 'zh',
        updated_at: new Date().toISOString(),
      });
      return appended;
    } catch (error) {
      if (await this.store.isTranscriptChunkCleared(classroomId, chunk.recording_id, chunk.chunk_id).catch(() => false)) return [];
      const code = controller.signal.aborted ? 'provider_timeout' : publicError(error); const current = await this.store.getTranscriptionState(classroomId).catch(() => null);
      if (current) {
        const retryable = [...new Set([...(current.retryable_chunk_ids ?? []), chunk.chunk_id])].slice(-64);
        await this.state(classroomId, chunk, { state: 'delayed', failed_chunk_count: retryable.length, retryable_chunk_ids: retryable, last_error_code: code }).catch(() => undefined);
      }
      await this.store.putTeacherRecord(classroomId, `transcription_job_${chunk.chunk_id}`, {
        status: 'failed', error_code: code, recording_id: chunk.recording_id, recording_generation: chunk.recording_generation,
        classroom_generation: chunk.classroom_generation, chunk_id: chunk.chunk_id, chunk_hash: chunk.chunk_hash,
        sequence: chunk.sequence, sample_rate: chunk.sample_rate, channels: chunk.channels,
        relative_start_ms: chunk.relative_start_ms, relative_end_ms: chunk.relative_end_ms, attempt: (previousJob?.attempt ?? 0) + 1,
        external_transcription_opt_in: chunk.external_transcription_opt_in === true,
        language_hint: chunk.language_hint ?? 'zh',
        updated_at: new Date().toISOString(),
      }).catch(() => undefined);
      throw new Error(code);
    } finally {
      clearTimeout(timeout); set.delete(controller); if (set.size === 0) this.controllers.delete(classroomId);
    }
  }

  async retryChunk(classroomId: string, chunkId: string): Promise<ClassroomTranscriptRevision[]> {
    const safeChunkId = safeToken(chunkId, 'audio_chunk_id');
    const storedJob = await this.store.getTeacherRecord(classroomId, `transcription_job_${safeChunkId}`) as { status?: string } | null;
    const recording = await this.store.getRecordingState(classroomId);
    if (recording && await this.store.isTranscriptChunkCleared(classroomId, recording.recording_id, safeChunkId)) return [];
    if (storedJob?.status === 'completed') return (await this.store.listTranscriptRevisions(classroomId)).filter((item) => item.chunk_id === safeChunkId);
    let chunk = this.chunks.get(this.chunkKey(classroomId, chunkId));
    if (!chunk) {
      const job = await this.store.getTeacherRecord(classroomId, `transcription_job_${safeChunkId}`) as Omit<ClassroomTranscriptionChunk, 'pcm_s16le'> | null;
      if (job?.chunk_id) {
        const pcm = await this.store.getAudioChunk(classroomId, job.recording_id, job.chunk_id);
        if (pcm) chunk = { ...job, pcm_s16le: pcm };
      }
      if (!chunk) {
        const recording = await this.store.getRecordingState(classroomId);
        if (recording) {
          const descriptor = await this.store.getAudioChunkDescriptor(classroomId, recording.recording_id, chunkId);
          const pcm = descriptor ? await this.store.getAudioChunk(classroomId, recording.recording_id, chunkId) : null;
          if (descriptor && pcm) chunk = {
            recording_id: recording.recording_id, recording_generation: descriptor.metadata.recording_generation,
            classroom_generation: descriptor.metadata.classroom_generation, chunk_id: descriptor.chunk_id, chunk_hash: `sha256:${descriptor.hash}`,
            sequence: descriptor.sequence, sample_rate: descriptor.metadata.sample_rate, channels: descriptor.metadata.channels,
            relative_start_ms: descriptor.metadata.relative_start_ms, relative_end_ms: descriptor.metadata.relative_end_ms,
            external_transcription_opt_in: descriptor.metadata.external_transcription_opt_in, language_hint: descriptor.metadata.language_hint, pcm_s16le: pcm,
          };
        }
      }
    }
    if (!chunk) throw new Error('transcription_job_not_found');
    return this.transcribeChunk(classroomId, chunk);
  }

  async finalizeRecording(classroomId: string, recordingId: string, recordingGeneration: number): Promise<void> {
    // Finalization must be ordered after every previously queued chunk. Calling
    await (this.queues.get(classroomId) ?? Promise.resolve()).catch(() => undefined);
    const prefix = `${classroomId}:`;
    const candidates = [...this.chunks.entries()].filter(([key, chunk]) => key.startsWith(prefix)
      && chunk.recording_id === recordingId && chunk.recording_generation === recordingGeneration).map(([, chunk]) => chunk);
    let latest = candidates.sort((a, b) => b.sequence - a.sequence)[0];
    if (!latest) {
      const descriptor = (await this.store.listAudioChunkDescriptors(classroomId, recordingId)).sort((a, b) => b.sequence - a.sequence)[0];
      const pcm = descriptor ? await this.store.getAudioChunk(classroomId, recordingId, descriptor.chunk_id) : null;
      if (descriptor && pcm) latest = {
        recording_id: recordingId, recording_generation: descriptor.metadata.recording_generation,
        classroom_generation: descriptor.metadata.classroom_generation, chunk_id: descriptor.chunk_id, chunk_hash: `sha256:${descriptor.hash}`,
        sequence: descriptor.sequence, sample_rate: descriptor.metadata.sample_rate, channels: descriptor.metadata.channels,
        relative_start_ms: descriptor.metadata.relative_start_ms, relative_end_ms: descriptor.metadata.relative_end_ms,
        external_transcription_opt_in: descriptor.metadata.external_transcription_opt_in, language_hint: descriptor.metadata.language_hint, pcm_s16le: pcm,
      };
    }
    if (latest) await this.transcribeChunk(classroomId, { ...latest, finalize_stream: true });
  }

  async correct(classroomId: string, transcriptId: string, text: string): Promise<ClassroomTranscriptRevision> {
    safeToken(transcriptId, 'transcript_id'); const normalized = text.trim();
    if (!normalized || normalized.length > MAX_TRANSCRIPT_TEXT) throw new Error('transcript_text_invalid');
    const history = (await this.store.listTranscriptRevisions(classroomId)).filter((item) => item.transcript_id === transcriptId);
    const latest = history.at(-1); if (!latest) throw new Error('transcript_not_found');
    const now = new Date().toISOString();
    const corrected: ClassroomTranscriptRevision = { ...latest, revision: latest.revision + 1, status: 'corrected', text: normalized, confidence: 1, original_revision: latest.revision, created_at: now, corrected_at: now };
    const saved = await this.store.appendTranscriptRevision(classroomId, corrected); this.classroomService.publishTranscript(classroomId, saved); return saved;
  }

  async clear(classroomId: string): Promise<{ cleared_at: string }> {
    const marker = await this.store.clearTranscriptHistory(classroomId);
    for (const controller of this.controllers.get(classroomId) ?? []) controller.abort('transcripts_cleared');
    this.classroomService.publishTranscriptsCleared(classroomId, marker.cleared_at);
    return { cleared_at: marker.cleared_at };
  }

  abortClassroom(classroomId: string): void {
    for (const controller of this.controllers.get(classroomId) ?? []) controller.abort('classroom_deleted');
    this.controllers.delete(classroomId);
    this.queues.delete(classroomId); this.pending.delete(classroomId);
    for (const key of this.chunks.keys()) if (key.startsWith(`${classroomId}:`)) this.chunks.delete(key);
  }
}
