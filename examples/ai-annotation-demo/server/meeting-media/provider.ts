import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { MeetingAudioChunk, MeetingAudioTrack, MeetingUtterance } from '../../../../packages/meeting-media-core/src/index';

export interface StreamingAsrChunkInput {
  tenant_id: string;
  user_id: string;
  chunk: MeetingAudioChunk;
  audio: Uint8Array;
  /** Trusted only for the ephemeral Companion projection path. */
  speech_present?: boolean;
}

export interface StreamingAsrProviderEnvironment {
  INKLOOP_STREAMING_ASR_PROVIDER?: string;
  INKLOOP_STREAMING_ASR_URL?: string;
  INKLOOP_STREAMING_ASR_KEY?: string;
  INKLOOP_STREAMING_ASR_MODEL?: string;
  INKLOOP_STREAMING_ASR_LANGUAGE?: string;
  INKLOOP_STREAMING_ASR_PROMPT?: string;
  INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS?: string;
  INKLOOP_STREAMING_ASR_REVISION_INTERVAL_MS?: string;
  INKLOOP_STREAMING_ASR_MAXIMUM_WINDOW_MS?: string;
  INKLOOP_SHERPA_MODEL_DIR?: string;
}

export interface OpenAICompatibleStreamingAsrOptions {
  endpoint: string;
  apiKey?: string;
  model: string;
  language?: string;
  prompt?: string;
  fetchImpl?: typeof fetch;
}

export interface BufferedOpenAICompatibleStreamingAsrOptions
  extends OpenAICompatibleStreamingAsrOptions {
  minimumWindowMs?: number;
  revisionIntervalMs?: number;
  maximumWindowMs?: number;
}

export interface StreamingAsrProvider {
  readonly provider_id: string;
  transcribeChunk(input: StreamingAsrChunkInput, signal?: AbortSignal): Promise<MeetingUtterance[]>;
  endSpeech?(input: StreamingAsrChunkInput, signal?: AbortSignal): Promise<MeetingUtterance[]>;
  disposeSession?(input: {
    tenant_id: string;
    user_id: string;
    session_id: string;
  }): void | Promise<void>;
}

export class StreamingAsrProviderRouter {
  constructor(
    private readonly tracks: Partial<Record<MeetingAudioTrack, StreamingAsrProvider>>,
    private readonly fallback: StreamingAsrProvider,
  ) {}

  providerFor(track: MeetingAudioTrack): StreamingAsrProvider {
    return this.tracks[track] || this.fallback;
  }

  async disposeSession(input: {
    tenant_id: string;
    user_id: string;
    session_id: string;
  }): Promise<void> {
    const providers = new Set([...Object.values(this.tracks), this.fallback]);
    await Promise.all([...providers].map(async (provider) => {
      await provider.disposeSession?.(input);
    }));
  }

  providerIdFor(track: MeetingAudioTrack): string {
    return this.providerFor(track).provider_id;
  }
}

export function createUnavailableStreamingAsrProvider(reason = 'streaming_asr_provider_not_configured'): StreamingAsrProvider {
  return {
    provider_id: 'unavailable',
    async transcribeChunk() {
      throw new Error(reason);
    },
  };
}

type VerboseTranscriptionResponse = {
  text?: string;
  segments?: Array<{
    id?: number;
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
};

export function createOpenAICompatibleStreamingAsrProvider(options: OpenAICompatibleStreamingAsrOptions): StreamingAsrProvider {
  return {
    provider_id: openAICompatibleProviderId(options, 'chunked'),
    async transcribeChunk(input, signal) {
      if (isDefinitelySilentPcm(input.chunk, input.audio)) return [];
      const segments = await requestOpenAICompatibleTranscription(
        options,
        input.chunk,
        input.audio,
        signal,
      );
      return segments.map((segment, index): MeetingUtterance => {
        const startMs = input.chunk.start_monotonic_ms + segment.startMs;
        const endMs = input.chunk.start_monotonic_ms + segment.endMs;
        return {
          utterance_id: stableUtteranceId(input.chunk, segment.id ?? index),
          session_id: input.chunk.session_id,
          track: input.chunk.track,
          start_ms: startMs,
          end_ms: Math.min(Math.max(startMs + 1, endMs), input.chunk.end_monotonic_ms),
          text: segment.text,
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [input.chunk.chunk_id],
          ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
        };
      });
    },
  };
}

interface BufferedOpenAIState {
  windowIndex: number;
  revision: number;
  startMs: number;
  endMs: number;
  lastRequestEndMs: number;
  lastSequence: number;
  lastText: string;
  audioParts: Uint8Array[];
  sourceChunkIds: string[];
  format: Pick<MeetingAudioChunk, 'codec' | 'sample_rate_hz' | 'channel_count'>;
}

/**
 * Whisper-style HTTP providers need several seconds of acoustic context. This
 * adapter keeps one bounded rolling utterance per session/track and revises it
 * at a controlled cadence. Capture callback boundaries never become ASR
 * boundaries, and the authoritative five-second fact chunks remain separate.
 */
export function createBufferedOpenAICompatibleStreamingAsrProvider(
  options: BufferedOpenAICompatibleStreamingAsrOptions,
): StreamingAsrProvider {
  const minimumWindowMs = Math.max(1_000, options.minimumWindowMs ?? 3_000);
  const revisionIntervalMs = Math.max(1_000, options.revisionIntervalMs ?? 4_000);
  const maximumWindowMs = Math.max(minimumWindowMs, options.maximumWindowMs ?? 20_000);
  const states = new Map<string, BufferedOpenAIState>();
  const keyOf = (input: StreamingAsrChunkInput) =>
    `${input.tenant_id}\u0000${input.user_id}\u0000${input.chunk.session_id}\u0000${input.chunk.track}`;
  const transcribeState = async (
    input: StreamingAsrChunkInput,
    state: BufferedOpenAIState,
    signal?: AbortSignal,
  ): Promise<MeetingUtterance[]> => {
    if (!state.audioParts.length) return [];
    const audio = concatenateBytes(state.audioParts);
    const aggregateChunk: MeetingAudioChunk = {
      ...input.chunk,
      chunk_id: `${input.chunk.session_id}:${input.chunk.track}:window:${state.windowIndex}`,
      sequence: state.windowIndex,
      start_monotonic_ms: state.startMs,
      end_monotonic_ms: state.endMs,
      byte_length: audio.byteLength,
      checksum: `sha256:${createHash('sha256').update(audio).digest('hex')}`,
    };
    const segments = isDefinitelySilentPcm(aggregateChunk, audio)
      ? []
      : await requestOpenAICompatibleTranscription(
        options,
        aggregateChunk,
        audio,
        signal,
      );
    state.lastRequestEndMs = state.endMs;
    const text = segments.map((segment) => segment.text).join('').trim();
    const changed = !!text && text !== state.lastText;
    const responseEndMs = segments.length
      ? state.startMs + Math.max(...segments.map((segment) => segment.endMs))
      : state.endMs;
    const confidenceValues = segments.flatMap((segment) =>
      segment.confidence === undefined ? [] : [segment.confidence]);
    const utterances: MeetingUtterance[] = changed ? [{
      utterance_id: `utt_${input.chunk.session_id}_${input.chunk.track}_window_${state.windowIndex}`,
      session_id: input.chunk.session_id,
      track: input.chunk.track,
      start_ms: state.startMs + (segments[0]?.startMs || 0),
      end_ms: Math.max(state.startMs + 1, Math.min(state.endMs, responseEndMs)),
      text,
      revision: state.revision + 1,
      stability: 'provisional',
      source_chunk_ids: [...state.sourceChunkIds],
      ...(confidenceValues.length
        ? { confidence: confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length }
        : {}),
    }] : [];
    if (changed) {
      state.revision += 1;
      state.lastText = text;
    }
    return utterances;
  };
  const nextState = (state: BufferedOpenAIState): BufferedOpenAIState => ({
    windowIndex: state.windowIndex + 1,
    revision: 0,
    startMs: state.endMs,
    endMs: state.endMs,
    lastRequestEndMs: state.endMs,
    lastSequence: state.lastSequence,
    lastText: '',
    audioParts: [],
    sourceChunkIds: [],
    format: state.format,
  });
  return {
    provider_id: openAICompatibleProviderId(options, 'buffered'),
    async transcribeChunk(input, signal) {
      requirePcm16Mono(input.chunk, input.audio);
      const key = keyOf(input);
      let state = states.get(key);
      const contiguous = state
        && input.chunk.sequence === state.lastSequence + 1
        && input.chunk.start_monotonic_ms <= state.endMs + 250
        && samePcmFormat(state.format, input.chunk);
      if (!state || !contiguous) {
        state = {
          windowIndex: state ? state.windowIndex + 1 : 0,
          revision: 0,
          startMs: input.chunk.start_monotonic_ms,
          endMs: input.chunk.end_monotonic_ms,
          lastRequestEndMs: input.chunk.start_monotonic_ms,
          lastSequence: input.chunk.sequence,
          lastText: '',
          audioParts: [],
          sourceChunkIds: [],
          format: {
            codec: input.chunk.codec,
            sample_rate_hz: input.chunk.sample_rate_hz,
            channel_count: input.chunk.channel_count,
          },
        };
        states.set(key, state);
      }
      state.lastSequence = input.chunk.sequence;
      state.endMs = input.chunk.end_monotonic_ms;
      state.audioParts.push(input.audio.slice());
      if (!state.sourceChunkIds.includes(input.chunk.chunk_id)) {
        state.sourceChunkIds.push(input.chunk.chunk_id);
      }
      const durationMs = state.endMs - state.startMs;
      const maximumReached = durationMs >= maximumWindowMs;
      const firstRequest = state.lastRequestEndMs === state.startMs;
      const requestDue = maximumReached
        || (firstRequest
          ? durationMs >= minimumWindowMs
          : state.endMs - state.lastRequestEndMs >= revisionIntervalMs);
      if (!requestDue) return [];

      const utterances = await transcribeState(input, state, signal);
      if (maximumReached) {
        states.set(key, nextState(state));
      }
      return utterances;
    },
    async endSpeech(input, signal) {
      const key = keyOf(input);
      const state = states.get(key);
      if (!state || !state.audioParts.length) return [];
      const utterances = state.endMs > state.lastRequestEndMs || !state.lastText
        ? await transcribeState(input, state, signal)
        : [];
      states.set(key, nextState(state));
      return utterances;
    },
    disposeSession(input) {
      const prefix = `${input.tenant_id}\u0000${input.user_id}\u0000${input.session_id}\u0000`;
      for (const key of states.keys()) if (key.startsWith(prefix)) states.delete(key);
    },
  };
}

interface SherpaOnlineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}

export interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream;
  isReady(stream: SherpaOnlineStream): boolean;
  decode(stream: SherpaOnlineStream): void;
  getResult(stream: SherpaOnlineStream): { text?: string };
  isEndpoint(stream: SherpaOnlineStream): boolean;
  reset(stream: SherpaOnlineStream): void;
}

export interface SpeechActivityGate {
  accepts(samples: Float32Array, sampleRate: number): boolean;
  reset(): void;
}

interface SherpaStreamState {
  recognizer: SherpaOnlineRecognizer;
  stream: SherpaOnlineStream;
  utteranceIndex: number;
  revision: number;
  utteranceStartMs: number;
  sourceChunkIds: string[];
  lastText: string;
  lastSequence: number;
  gate: SpeechActivityGate;
  speechActive: boolean;
  hangoverFramesRemaining: number;
  preRoll: SpeechFrame[];
}

export interface SherpaStreamingAsrOptions {
  createRecognizer(): SherpaOnlineRecognizer;
  frameDurationMs?: number;
  preRollDurationMs?: number;
  hangoverDurationMs?: number;
  gate?: SpeechActivityGate;
  createGate?: () => SpeechActivityGate;
}

interface SpeechFrame {
  samples: Float32Array;
  chunkId: string;
  startMs: number;
  endMs: number;
}

export interface FormalTranscriptAudioChunk {
  chunk: MeetingAudioChunk;
  loadAudio(): Promise<Uint8Array>;
}

export interface FormalTranscriptConverger {
  readonly converger_id: string;
  converge(input: {
    session_id: string;
    chunks: FormalTranscriptAudioChunk[];
  }): Promise<MeetingUtterance[]>;
}

export interface OpenAICompatibleFormalTranscriptOptions
  extends OpenAICompatibleStreamingAsrOptions {
  maximumBatchMs?: number;
}

/**
 * A real streaming Provider: every session/track owns one long-lived decoder
 * stream. Chunks are transport/persistence envelopes only; they do not reset
 * ASR context. The same utterance ID is revised until Sherpa reports endpoint.
 */
export function createSherpaStreamingAsrProvider(options: SherpaStreamingAsrOptions): StreamingAsrProvider {
  const states = new Map<string, SherpaStreamState>();
  const frameDurationMs = Math.max(20, options.frameDurationMs ?? 100);
  const preRollFrames = Math.ceil(Math.max(0, options.preRollDurationMs ?? 200) / frameDurationMs);
  const hangoverFrames = Math.ceil(Math.max(0, options.hangoverDurationMs ?? 500) / frameDurationMs);
  const createState = (input: StreamingAsrChunkInput, utteranceIndex = 0): SherpaStreamState => {
    const recognizer = options.createRecognizer();
    return {
      recognizer,
      stream: recognizer.createStream(),
      utteranceIndex,
      revision: 0,
      utteranceStartMs: input.chunk.start_monotonic_ms,
      sourceChunkIds: [],
      lastText: '',
      lastSequence: input.chunk.sequence - 1,
      gate: options.createGate?.() || options.gate || createAdaptiveSpeechActivityGate(),
      speechActive: false,
      hangoverFramesRemaining: 0,
      preRoll: [],
    };
  };
  return {
    provider_id: 'sherpa-onnx:streaming-paraformer-zh-en',
    async transcribeChunk(input) {
      if (input.speech_present === false) return [];
      const samples = pcm16MonoSamples(input.chunk, input.audio);
      const key = `${input.tenant_id}\u0000${input.user_id}\u0000${input.chunk.session_id}\u0000${input.chunk.track}`;
      let state = states.get(key);
      if (!state) {
        state = createState(input);
        states.set(key, state);
      } else if (input.chunk.sequence !== state.lastSequence + 1) {
        // A real gap invalidates acoustic context. Start a new explicit
        // utterance instead of pretending the two sides are contiguous.
        state.recognizer.reset(state.stream);
        state = createState(input, state.utteranceIndex + 1);
        states.set(key, state);
      }

      state.lastSequence = input.chunk.sequence;
      const utterances: MeetingUtterance[] = [];
      const frames = speechFrames(input.chunk, samples, frameDurationMs);
      for (const frame of frames) {
        const accepted = input.speech_present === true
          ? [frame]
          : gatedFrames(state, frame, input.chunk.sample_rate_hz || 16_000, preRollFrames, hangoverFrames);
        for (const acceptedFrame of accepted) {
          if (state.sourceChunkIds.length === 0) state.utteranceStartMs = acceptedFrame.startMs;
          state.stream.acceptWaveform({
            samples: acceptedFrame.samples,
            sampleRate: input.chunk.sample_rate_hz || 16_000,
          });
          while (state.recognizer.isReady(state.stream)) state.recognizer.decode(state.stream);
          if (!state.sourceChunkIds.includes(acceptedFrame.chunkId)) state.sourceChunkIds.push(acceptedFrame.chunkId);
          const text = state.recognizer.getResult(state.stream).text?.trim() || '';
          const endpoint = state.recognizer.isEndpoint(state.stream);
          const changed = text !== state.lastText;
          if (changed && isUsableStreamingText(text, true, acceptedFrame.endMs - state.utteranceStartMs)) {
            state.revision += 1;
            state.lastText = text;
            utterances.push({
              utterance_id: streamUtteranceId(input.chunk.session_id, input.chunk.track, state.utteranceIndex),
              session_id: input.chunk.session_id,
              track: input.chunk.track,
              start_ms: state.utteranceStartMs,
              end_ms: acceptedFrame.endMs,
              text,
              revision: state.revision,
              stability: 'provisional',
              source_chunk_ids: [...state.sourceChunkIds],
            });
          }
          if (endpoint) resetSherpaUtterance(state, acceptedFrame.endMs);
        }
      }
      return utterances;
    },
    disposeSession(input) {
      const prefix = `${input.tenant_id}\u0000${input.user_id}\u0000${input.session_id}\u0000`;
      for (const key of states.keys()) if (key.startsWith(prefix)) states.delete(key);
    },
  };
}

/**
 * Replays the authoritative raw PCM in chronological order after a meeting
 * ends. This is deliberately separate from provisional revisions: a failed
 * convergence leaves the live transcript untouched and raw media eligible
 * for a later retry.
 */
export function createSherpaFormalTranscriptConverger(
  options: SherpaStreamingAsrOptions,
): FormalTranscriptConverger {
  const frameDurationMs = Math.max(20, options.frameDurationMs ?? 500);
  const preRollFrames = Math.ceil(Math.max(0, options.preRollDurationMs ?? 200) / frameDurationMs);
  const hangoverFrames = Math.ceil(Math.max(0, options.hangoverDurationMs ?? 500) / frameDurationMs);
  return {
    converger_id: 'sherpa-onnx:streaming-paraformer-zh-en:formal-replay-v1',
    async converge(input) {
      const utterances: MeetingUtterance[] = [];
      const tracks = new Map<MeetingAudioTrack, FormalTranscriptAudioChunk[]>();
      for (const value of input.chunks) {
        tracks.set(value.chunk.track, [...(tracks.get(value.chunk.track) || []), value]);
      }
      for (const track of [...tracks.keys()].sort()) {
        const chunks = [...(tracks.get(track) || [])].sort((left, right) => left.chunk.sequence - right.chunk.sequence);
        if (!chunks.length) continue;
        const recognizer = options.createRecognizer();
        const first = chunks[0];
        const state: SherpaStreamState = {
          recognizer,
          stream: recognizer.createStream(),
          utteranceIndex: 0,
          revision: 0,
          utteranceStartMs: first.chunk.start_monotonic_ms,
          sourceChunkIds: [],
          lastText: '',
          lastSequence: first.chunk.sequence - 1,
          gate: options.createGate?.() || options.gate || createAdaptiveSpeechActivityGate(),
          speechActive: false,
          hangoverFramesRemaining: 0,
          preRoll: [],
        };
        for (const value of chunks) {
          if (value.chunk.sequence !== state.lastSequence + 1) {
            emitFormalTail(input.session_id, track, state, value.chunk.start_monotonic_ms, utterances);
            recognizer.reset(state.stream);
            state.utteranceIndex += 1;
            state.revision = 0;
            state.utteranceStartMs = value.chunk.start_monotonic_ms;
            state.sourceChunkIds = [];
            state.lastText = '';
            state.gate.reset();
            state.speechActive = false;
            state.hangoverFramesRemaining = 0;
            state.preRoll = [];
          }
          state.lastSequence = value.chunk.sequence;
          const samples = pcm16MonoSamples(value.chunk, await value.loadAudio());
          for (const frame of speechFrames(value.chunk, samples, frameDurationMs)) {
            for (const acceptedFrame of gatedFrames(
              state,
              frame,
              value.chunk.sample_rate_hz || 16_000,
              preRollFrames,
              hangoverFrames,
            )) {
              if (state.sourceChunkIds.length === 0) state.utteranceStartMs = acceptedFrame.startMs;
              state.stream.acceptWaveform({
                samples: acceptedFrame.samples,
                sampleRate: value.chunk.sample_rate_hz || 16_000,
              });
              while (recognizer.isReady(state.stream)) recognizer.decode(state.stream);
              if (!state.sourceChunkIds.includes(acceptedFrame.chunkId)) state.sourceChunkIds.push(acceptedFrame.chunkId);
              state.lastText = recognizer.getResult(state.stream).text?.trim() || state.lastText;
              if (recognizer.isEndpoint(state.stream)) {
                emitFormalTail(input.session_id, track, state, acceptedFrame.endMs, utterances);
                recognizer.reset(state.stream);
                state.utteranceIndex += 1;
                state.revision = 0;
                state.utteranceStartMs = acceptedFrame.endMs;
                state.sourceChunkIds = [];
                state.lastText = '';
                state.gate.reset();
                state.speechActive = false;
                state.hangoverFramesRemaining = 0;
                state.preRoll = [];
              }
            }
          }
        }
        state.stream.inputFinished();
        while (recognizer.isReady(state.stream)) recognizer.decode(state.stream);
        state.lastText = recognizer.getResult(state.stream).text?.trim() || state.lastText;
        emitFormalTail(
          input.session_id,
          track,
          state,
          chunks[chunks.length - 1].chunk.end_monotonic_ms,
          utterances,
        );
      }
      return utterances.sort((left, right) => left.start_ms - right.start_ms
        || left.utterance_id.localeCompare(right.utterance_id));
    },
  };
}

/**
 * Formal convergence deliberately replays the untouched PCM facts instead of
 * reusing the client VAD projection. Tracks are submitted independently so
 * their source and clock identity remain auditable.
 */
export function createOpenAICompatibleFormalTranscriptConverger(
  options: OpenAICompatibleFormalTranscriptOptions,
): FormalTranscriptConverger {
  const maximumBatchMs = Math.max(60_000, options.maximumBatchMs ?? 20 * 60_000);
  return {
    converger_id: `${openAICompatibleProviderId(options, 'formal-raw-replay')}`,
    async converge(input) {
      const utterances: MeetingUtterance[] = [];
      const tracks = new Map<MeetingAudioTrack, FormalTranscriptAudioChunk[]>();
      for (const value of input.chunks) {
        tracks.set(value.chunk.track, [...(tracks.get(value.chunk.track) || []), value]);
      }
      for (const track of [...tracks.keys()].sort()) {
        const chunks = [...(tracks.get(track) || [])]
          .sort((left, right) => left.chunk.sequence - right.chunk.sequence);
        let batch: FormalTranscriptAudioChunk[] = [];
        let batchIndex = 0;
        const flush = async () => {
          if (!batch.length) return;
          const first = batch[0].chunk;
          const last = batch[batch.length - 1].chunk;
          const audio = concatenateBytes(
            await Promise.all(batch.map((value) => value.loadAudio())),
          );
          const aggregate: MeetingAudioChunk = {
            ...first,
            chunk_id: `${input.session_id}:${track}:formal:${batchIndex}`,
            sequence: batchIndex,
            start_monotonic_ms: first.start_monotonic_ms,
            end_monotonic_ms: last.end_monotonic_ms,
            byte_length: audio.byteLength,
            checksum: `sha256:${createHash('sha256').update(audio).digest('hex')}`,
          };
          const segments = isDefinitelySilentPcm(aggregate, audio)
            ? []
            : await requestOpenAICompatibleTranscription(options, aggregate, audio);
          const utteranceSegments = coalesceFormalSegments(segments);
          for (const [segmentIndex, segment] of utteranceSegments.entries()) {
            const startMs = aggregate.start_monotonic_ms + segment.startMs;
            const endMs = aggregate.start_monotonic_ms + segment.endMs;
            const sourceChunkIds = batch
              .filter(({ chunk }) =>
                chunk.end_monotonic_ms > startMs && chunk.start_monotonic_ms < endMs)
              .map(({ chunk }) => chunk.chunk_id);
            utterances.push({
              utterance_id: `formal_${input.session_id}_${track}_${batchIndex}_${segment.id ?? segmentIndex}`,
              session_id: input.session_id,
              track,
              start_ms: startMs,
              end_ms: Math.max(startMs + 1, Math.min(aggregate.end_monotonic_ms, endMs)),
              text: segment.text,
              revision: 1,
              stability: 'provisional',
              source_chunk_ids: sourceChunkIds.length
                ? sourceChunkIds
                : batch.map(({ chunk }) => chunk.chunk_id),
              ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
            });
          }
          batch = [];
          batchIndex += 1;
        };
        for (const value of chunks) {
          const batchDuration = batch.length
            ? value.chunk.end_monotonic_ms - batch[0].chunk.start_monotonic_ms
            : 0;
          const prior = batch[batch.length - 1];
          const discontinuous = prior
            && (value.chunk.sequence !== prior.chunk.sequence + 1
              || !samePcmFormat(prior.chunk, value.chunk));
          if (batch.length && (discontinuous || batchDuration > maximumBatchMs)) await flush();
          batch.push(value);
        }
        await flush();
      }
      return utterances.sort((left, right) =>
        left.start_ms - right.start_ms || left.utterance_id.localeCompare(right.utterance_id));
    },
  };
}

function coalesceFormalSegments(
  segments: NormalizedTranscriptionSegment[],
): NormalizedTranscriptionSegment[] {
  const result: NormalizedTranscriptionSegment[] = [];
  for (const segment of segments) {
    const prior = result.at(-1);
    const compactLength = segment.text.replace(/[\s\p{P}\p{S}]/gu, '').length;
    const gapMs = prior ? segment.startMs - prior.endMs : Number.POSITIVE_INFINITY;
    const priorTerminated = !!prior && /[。！？!?；;：:]$/u.test(prior.text.trim());
    const mergeIntoPrior = !!prior
      && gapMs >= 0
      && gapMs <= 500
      && !priorTerminated
      && (compactLength <= 4 || segment.endMs - prior.startMs <= 15_000);
    if (!mergeIntoPrior) {
      result.push({ ...segment });
      continue;
    }
    const confidences = [prior.confidence, segment.confidence]
      .filter((value): value is number => value !== undefined);
    prior.endMs = segment.endMs;
    prior.text = `${prior.text.trim()}${segment.text.trim()}`;
    prior.confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : undefined;
  }
  return result;
}

function speechFrames(chunk: MeetingAudioChunk, samples: Float32Array, durationMs: number): SpeechFrame[] {
  const sampleRate = chunk.sample_rate_hz || 16_000;
  const frameSize = Math.max(1, Math.round(sampleRate * durationMs / 1_000));
  const frames: SpeechFrame[] = [];
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const endOffset = Math.min(samples.length, offset + frameSize);
    frames.push({
      samples: samples.slice(offset, endOffset),
      chunkId: chunk.chunk_id,
      startMs: chunk.start_monotonic_ms + Math.round(offset / sampleRate * 1_000),
      endMs: Math.min(
        chunk.end_monotonic_ms,
        chunk.start_monotonic_ms + Math.round(endOffset / sampleRate * 1_000),
      ),
    });
  }
  return frames;
}

function gatedFrames(
  state: SherpaStreamState,
  frame: SpeechFrame,
  sampleRate: number,
  preRollFrameCount: number,
  hangoverFrameCount: number,
): SpeechFrame[] {
  if (state.gate.accepts(frame.samples, sampleRate)) {
    const frames = [...state.preRoll, frame];
    state.preRoll = [];
    state.speechActive = true;
    state.hangoverFramesRemaining = hangoverFrameCount;
    return frames;
  }
  if (state.speechActive && state.hangoverFramesRemaining > 0) {
    state.hangoverFramesRemaining -= 1;
    if (state.hangoverFramesRemaining === 0) state.speechActive = false;
    return [frame];
  }
  if (preRollFrameCount > 0) {
    state.preRoll.push(frame);
    if (state.preRoll.length > preRollFrameCount) state.preRoll.shift();
  }
  return [];
}

function resetSherpaUtterance(state: SherpaStreamState, atMs: number): void {
  state.recognizer.reset(state.stream);
  state.utteranceIndex += 1;
  state.revision = 0;
  state.utteranceStartMs = atMs;
  state.sourceChunkIds = [];
  state.lastText = '';
  state.gate.reset();
  state.speechActive = false;
  state.hangoverFramesRemaining = 0;
  state.preRoll = [];
}

function emitFormalTail(
  sessionId: string,
  track: MeetingAudioTrack,
  state: SherpaStreamState,
  endMs: number,
  output: MeetingUtterance[],
): void {
  const text = state.lastText.trim();
  if (!state.sourceChunkIds.length || !isUsableFormalText(
    text,
    endMs - state.utteranceStartMs,
  )) return;
  output.push({
    utterance_id: `formal_${sessionId}_${track}_${state.utteranceIndex}`,
    session_id: sessionId,
    track,
    start_ms: state.utteranceStartMs,
    end_ms: Math.max(state.utteranceStartMs + 1, endMs),
    text,
    revision: 1,
    stability: 'provisional',
    source_chunk_ids: [...state.sourceChunkIds],
  });
}

export function createAdaptiveSpeechActivityGate(): SpeechActivityGate {
  let noiseFloorDb = -60;
  let initialized = false;
  return {
    accepts(samples, sampleRate) {
      const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
      const frameLevels: number[] = [];
      for (let offset = 0; offset < samples.length; offset += frameSize) {
        const end = Math.min(samples.length, offset + frameSize);
        let squared = 0;
        for (let index = offset; index < end; index += 1) squared += (samples[index] || 0) ** 2;
        frameLevels.push(20 * Math.log10(Math.max(1e-7, Math.sqrt(squared / Math.max(1, end - offset)))));
      }
      if (!frameLevels.length) return false;
      const sorted = [...frameLevels].sort((left, right) => left - right);
      const observedFloor = sorted[Math.floor((sorted.length - 1) * 0.2)] || -60;
      if (!initialized) {
        noiseFloorDb = observedFloor;
        initialized = true;
      } else {
        noiseFloorDb = noiseFloorDb * 0.92 + observedFloor * 0.08;
      }
      const threshold = Math.max(-50, Math.min(-30, noiseFloorDb + 7));
      const active = frameLevels.filter((level) => level >= threshold).length;
      return active >= Math.max(3, Math.ceil(frameLevels.length * 0.06));
    },
    reset() {
      initialized = false;
      noiseFloorDb = -60;
    },
  };
}

function isUsableTranscriptionSegment(
  text: string,
  segment: { start?: number; end?: number; no_speech_prob?: number },
): boolean {
  if (!text || (segment.no_speech_prob ?? 0) >= 0.6 || isKnownAsrHallucination(text)) return false;
  const duration = Math.max(0.001, (segment.end || 0) - (segment.start || 0));
  const compactLength = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
  if (duration < 0.45 && compactLength >= 6) return false;
  if (compactLength >= 8 && compactLength / duration > 18) return false;
  return !hasPathologicalRepetition(text);
}

function isUsableStreamingText(text: string, voiced: boolean, durationMs: number): boolean {
  if (!voiced || !text || isKnownAsrHallucination(text) || hasPathologicalRepetition(text)) return false;
  const compactLength = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
  return durationMs >= 300 || compactLength <= 2;
}

function isUsableFormalText(text: string, durationMs: number): boolean {
  if (!isUsableStreamingText(text, true, durationMs)) return false;
  const normalized = text.normalize('NFKC').trim();
  const compact = normalized.replace(/[\s\p{P}\p{S}]/gu, '');
  if (compact.length < 2) return false;
  const latinLetters = (normalized.match(/[a-z]/giu) || []).length;
  if (latinLetters >= 3 && /[\p{Script=Han}]/u.test(normalized)
    && latinLetters / Math.max(1, compact.length) > 0.25) return false;
  return compact.length / Math.max(0.001, durationMs / 1_000) <= 12;
}

function isKnownAsrHallucination(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /(?:字幕|翻译|校对).{0,8}(?:志愿者|组|提供|制作)/u.test(normalized)
    || /(?:请不吝|别忘了).{0,12}(?:点赞|订阅|转发|打赏)/u.test(normalized)
    || /(?:感谢|谢谢)(?:大家)?(?:观看|收看|聆听)/u.test(normalized)
    || /subtitles?\s+by/iu.test(normalized);
}

function hasPathologicalRepetition(text: string): boolean {
  const compact = text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  if (compact.length < 6) return false;
  if (/^(.)\1{5,}$/u.test(compact)) return true;
  for (let width = 1; width <= Math.min(4, Math.floor(compact.length / 3)); width += 1) {
    const unit = compact.slice(0, width);
    if (unit.repeat(Math.floor(compact.length / width)) === compact) return true;
  }
  const counts = new Map<string, number>();
  for (const character of compact) counts.set(character, (counts.get(character) || 0) + 1);
  return Math.max(...counts.values()) / compact.length >= 0.75;
}

function pcm16MonoSamples(chunk: MeetingAudioChunk, audio: Uint8Array): Float32Array {
  if (chunk.codec !== 'pcm_s16le' || chunk.channel_count !== 1 || !chunk.sample_rate_hz
    || audio.byteLength < 2 || audio.byteLength % 2 !== 0) {
    throw new Error('sherpa_streaming_pcm16_mono_required');
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Float32Array(audio.byteLength / 2);
  for (let offset = 0; offset < audio.byteLength; offset += 2) {
    samples[offset / 2] = view.getInt16(offset, true) / 32_768;
  }
  return samples;
}

function streamUtteranceId(sessionId: string, track: MeetingAudioTrack, utteranceIndex: number): string {
  return `utt_${sessionId}_${track}_${utteranceIndex}`;
}

function localSherpaRecognizer(modelDirectory: string): () => SherpaOnlineRecognizer {
  return () => {
    const files = resolveParaformerFiles(modelDirectory);
    const require = createRequire(import.meta.url);
    const sherpa = require('sherpa-onnx-node') as {
      OnlineRecognizer: new (configuration: Record<string, unknown>) => SherpaOnlineRecognizer;
    };
    return new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        paraformer: { encoder: files.encoder, decoder: files.decoder },
        tokens: files.tokens,
        numThreads: 2,
        debug: false,
        provider: 'cpu',
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.0,
      rule3MinUtteranceLength: 20,
    });
  };
}

function resolveParaformerFiles(modelDirectory: string): { encoder: string; decoder: string; tokens: string } {
  const directory = resolve(modelDirectory);
  if (!existsSync(directory)) throw new Error(`sherpa_model_missing:${directory}`);
  const files = listLocalFiles(directory);
  const groups = new Map<string, string[]>();
  for (const file of files) groups.set(dirname(file), [...(groups.get(dirname(file)) || []), file]);
  const candidates = [...groups.values()].flatMap((directoryFiles) => {
    const encoder = preferredOnnx(directoryFiles, 'encoder');
    const decoder = preferredOnnx(directoryFiles, 'decoder');
    const tokens = directoryFiles.find((file) => basename(file).toLowerCase() === 'tokens.txt');
    return encoder && decoder && tokens ? [{ encoder, decoder, tokens }] : [];
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? 'sherpa_model_ambiguous' : 'sherpa_model_missing');
  return candidates[0];
}

function listLocalFiles(directory: string, depth = 0): string[] {
  if (depth > 2) return [];
  return readdirSync(directory, { withFileTypes: true }).slice(0, 256).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listLocalFiles(path, depth + 1) : [path];
  });
}

function preferredOnnx(files: string[], kind: 'encoder' | 'decoder'): string | undefined {
  return files.filter((file) => basename(file).toLowerCase().includes(kind)
    && basename(file).toLowerCase().endsWith('.onnx'))
    .sort((left, right) => Number(basename(right).includes('int8')) - Number(basename(left).includes('int8'))
      || left.localeCompare(right))[0];
}

function isDefinitelySilentPcm(chunk: MeetingAudioChunk, audio: Uint8Array): boolean {
  if (chunk.codec === 'pcm_s16le') {
    if (audio.byteLength < 2 || audio.byteLength % 2 !== 0) return false;
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    let peak = 0;
    let squaredSum = 0;
    const sampleCount = audio.byteLength / 2;
    for (let offset = 0; offset < audio.byteLength; offset += 2) {
      const sample = view.getInt16(offset, true);
      peak = Math.max(peak, Math.abs(sample));
      squaredSum += sample * sample;
    }
    return peak <= 8 && Math.sqrt(squaredSum / sampleCount) <= 4;
  }
  if (chunk.codec === 'pcm_f32le') {
    if (audio.byteLength < 4 || audio.byteLength % 4 !== 0) return false;
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    let peak = 0;
    let squaredSum = 0;
    const sampleCount = audio.byteLength / 4;
    for (let offset = 0; offset < audio.byteLength; offset += 4) {
      const sample = view.getFloat32(offset, true);
      peak = Math.max(peak, Math.abs(sample));
      squaredSum += sample * sample;
    }
    return peak <= 8 / 32_768 && Math.sqrt(squaredSum / sampleCount) <= 4 / 32_768;
  }
  return false;
}

interface NormalizedTranscriptionSegment {
  id?: number;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

async function requestOpenAICompatibleTranscription(
  options: OpenAICompatibleStreamingAsrOptions,
  chunk: MeetingAudioChunk,
  audio: Uint8Array,
  signal?: AbortSignal,
): Promise<NormalizedTranscriptionSegment[]> {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const form = new FormData();
  form.append('model', options.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (options.language) form.append('language', options.language);
  if (options.prompt) form.append('prompt', options.prompt);
  const upload = providerAudio(chunk, audio);
  form.append('file', new Blob([upload.bytes], { type: upload.mimeType }), upload.fileName);
  const response = await (options.fetchImpl || fetch)(endpoint, {
    method: 'POST',
    headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
    body: form,
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`streaming_asr_http_${response.status}`), {
      status: response.status,
    });
  }
  const body = await response.json() as VerboseTranscriptionResponse;
  const durationSeconds = Math.max(
    0.001,
    (chunk.end_monotonic_ms - chunk.start_monotonic_ms) / 1_000,
  );
  const segments = body.segments?.length
    ? body.segments
    : body.text?.trim()
      ? [{ id: 0, start: 0, end: durationSeconds, text: body.text }]
      : [];
  return segments.flatMap((segment, index): NormalizedTranscriptionSegment[] => {
    const text = segment.text?.trim() || '';
    if (!isUsableTranscriptionSegment(text, segment)) return [];
    const startMs = Math.max(0, Math.round((segment.start || 0) * 1_000));
    const endMs = Math.min(
      Math.round(durationSeconds * 1_000),
      Math.max(startMs + 1, Math.round((segment.end || 0) * 1_000)),
    );
    return [{
      id: segment.id ?? index,
      startMs,
      endMs,
      text,
      ...(Number.isFinite(segment.avg_logprob)
        ? { confidence: logProbabilityConfidence(Number(segment.avg_logprob)) }
        : {}),
    }];
  });
}

function openAICompatibleProviderId(
  options: OpenAICompatibleStreamingAsrOptions,
  mode: 'chunked' | 'buffered' | 'formal-raw-replay',
): string {
  return `openai-compatible:${mode}:${new URL(options.endpoint.replace(/\/+$/, '')).host}:${options.model}`;
}

function samePcmFormat(
  left: Pick<MeetingAudioChunk, 'codec' | 'sample_rate_hz' | 'channel_count'>,
  right: Pick<MeetingAudioChunk, 'codec' | 'sample_rate_hz' | 'channel_count'>,
): boolean {
  return left.codec === right.codec
    && left.sample_rate_hz === right.sample_rate_hz
    && left.channel_count === right.channel_count;
}

function requirePcm16Mono(chunk: MeetingAudioChunk, audio: Uint8Array): void {
  if (chunk.codec !== 'pcm_s16le'
    || chunk.sample_rate_hz !== 16_000
    || chunk.channel_count !== 1
    || audio.byteLength % 2 !== 0) {
    throw new Error('buffered_streaming_asr_pcm16_mono_required');
  }
}

function concatenateBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function createConfiguredStreamingAsrProvider(
  env: StreamingAsrProviderEnvironment = process.env,
  options: { fetchImpl?: typeof fetch } = {},
): StreamingAsrProvider {
  if (env.INKLOOP_STREAMING_ASR_PROVIDER?.trim().toLowerCase() === 'sherpa') {
    const modelDirectory = env.INKLOOP_SHERPA_MODEL_DIR?.trim();
    if (!modelDirectory) return createUnavailableStreamingAsrProvider('sherpa_model_not_configured');
    return createSherpaStreamingAsrProvider({
      createRecognizer: localSherpaRecognizer(modelDirectory),
    });
  }
  const endpoint = env.INKLOOP_STREAMING_ASR_URL?.trim();
  const apiKey = env.INKLOOP_STREAMING_ASR_KEY?.trim();
  const model = env.INKLOOP_STREAMING_ASR_MODEL?.trim();
  if (!endpoint || !model) return createUnavailableStreamingAsrProvider();
  return createBufferedOpenAICompatibleStreamingAsrProvider({
    endpoint,
    apiKey,
    model,
    language: env.INKLOOP_STREAMING_ASR_LANGUAGE?.trim() || undefined,
    prompt: env.INKLOOP_STREAMING_ASR_PROMPT?.trim() || undefined,
    minimumWindowMs: positiveInteger(env.INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS, 3_000),
    revisionIntervalMs: positiveInteger(env.INKLOOP_STREAMING_ASR_REVISION_INTERVAL_MS, 4_000),
    maximumWindowMs: positiveInteger(env.INKLOOP_STREAMING_ASR_MAXIMUM_WINDOW_MS, 20_000),
    fetchImpl: options.fetchImpl,
  });
}

export function createConfiguredFormalTranscriptConverger(
  env: StreamingAsrProviderEnvironment = process.env,
): FormalTranscriptConverger | undefined {
  if (env.INKLOOP_STREAMING_ASR_PROVIDER?.trim().toLowerCase() === 'sherpa') {
    const modelDirectory = env.INKLOOP_SHERPA_MODEL_DIR?.trim();
    if (!modelDirectory) return undefined;
    return createSherpaFormalTranscriptConverger({
      createRecognizer: localSherpaRecognizer(modelDirectory),
    });
  }
  const endpoint = env.INKLOOP_STREAMING_ASR_URL?.trim();
  const model = env.INKLOOP_STREAMING_ASR_MODEL?.trim();
  if (!endpoint || !model) return undefined;
  return createOpenAICompatibleFormalTranscriptConverger({
    endpoint,
    apiKey: env.INKLOOP_STREAMING_ASR_KEY?.trim(),
    model,
    language: env.INKLOOP_STREAMING_ASR_LANGUAGE?.trim() || undefined,
    prompt: env.INKLOOP_STREAMING_ASR_PROMPT?.trim() || undefined,
  });
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stableUtteranceId(chunk: MeetingAudioChunk, segmentIndex: number): string {
  const value = `${chunk.session_id}\u0000${chunk.track}\u0000${chunk.sequence}\u0000${segmentIndex}`;
  return `utt_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function audioMimeType(codec?: string): string {
  if (codec === 'wav') return 'audio/wav';
  if (codec === 'flac') return 'audio/flac';
  if (codec === 'mp3') return 'audio/mpeg';
  if (codec === 'm4a' || codec === 'aac') return 'audio/mp4';
  return 'application/octet-stream';
}

function audioFileName(chunk: MeetingAudioChunk): string {
  const extension = chunk.codec === 'pcm_f32le' ? 'pcm' : chunk.codec || 'audio';
  return `${chunk.track}-${String(chunk.sequence).padStart(8, '0')}.${extension.replace(/[^a-z0-9]/gi, '')}`;
}

function providerAudio(chunk: MeetingAudioChunk, audio: Uint8Array): { bytes: ArrayBuffer; mimeType: string; fileName: string } {
  if (chunk.codec === 'pcm_s16le') {
    if (!chunk.sample_rate_hz || !chunk.channel_count || audio.byteLength % 2 !== 0) {
      throw new Error('streaming_asr_pcm_format_invalid');
    }
    return {
      bytes: encodePcmWav(audio, chunk.sample_rate_hz, chunk.channel_count, 1, 16),
      mimeType: 'audio/wav',
      fileName: `${chunk.track}-${String(chunk.sequence).padStart(8, '0')}.wav`,
    };
  }
  if (chunk.codec === 'pcm_f32le') {
    if (!chunk.sample_rate_hz || !chunk.channel_count || audio.byteLength % 4 !== 0) {
      throw new Error('streaming_asr_pcm_format_invalid');
    }
    return {
      bytes: encodePcmWav(audio, chunk.sample_rate_hz, chunk.channel_count, 3, 32),
      mimeType: 'audio/wav',
      fileName: `${chunk.track}-${String(chunk.sequence).padStart(8, '0')}.wav`,
    };
  }
  const bytes = new ArrayBuffer(audio.byteLength);
  new Uint8Array(bytes).set(audio);
  return { bytes, mimeType: audioMimeType(chunk.codec), fileName: audioFileName(chunk) };
}

function encodePcmWav(
  audio: Uint8Array,
  sampleRate: number,
  channels: number,
  formatCode: 1 | 3,
  bitsPerSample: 16 | 32,
): ArrayBuffer {
  const headerSize = 44;
  const result = new ArrayBuffer(headerSize + audio.byteLength);
  const view = new DataView(result);
  const bytes = new Uint8Array(result);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + audio.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true); // 1 = PCM integer, 3 = IEEE float
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  const bytesPerSample = bitsPerSample / 8;
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, audio.byteLength, true);
  bytes.set(audio, headerSize);
  return result;
}

function logProbabilityConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.exp(value)));
}
