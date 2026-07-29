/**
 * Replay one authoritative local Companion recording through candidate
 * buffered Whisper windows and compare their final live projection with an
 * independent full-PCM formal replay.
 *
 * This tool never changes the source meeting. It deliberately reports a
 * streaming/formal disagreement ratio rather than CER/WER: without a
 * human-corrected transcript there is no ground truth.
 *
 * Usage:
 *   npm run diagnose:meeting-asr -- --session <uuid> --windows 4000,8000,12000
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type {
  MeetingAudioChunk,
  MeetingAudioTrack,
  MeetingUtterance,
} from '../../../packages/meeting-media-core/src/index';
import {
  createBufferedOpenAICompatibleStreamingAsrProvider,
  createOpenAICompatibleFormalTranscriptConverger,
} from '../server/meeting-media/provider';

type CliOptions = {
  session: string;
  localRoot: string;
  endpoint: string;
  model: string;
  language?: string;
  prompt?: string;
  windows: number[];
  maximumWindowMs: number;
  frameMs: number;
  output?: string;
};

type AudioQuality = {
  duration_ms: number;
  sample_count: number;
  zero_sample_ratio: number;
  clipping_sample_ratio: number;
  peak_dbfs: number;
  rms_dbfs: number;
  frame_rms_dbfs: {
    p10: number;
    p50: number;
    p90: number;
  };
};

type BufferedRun = {
  window_ms: number;
  provider_id: string;
  wall_time_ms: number;
  request_count: number;
  provider_duration_ms: number[];
  first_provisional_after_audio_start_ms: number | null;
  emitted_revision_count: number;
  final_utterance_count: number;
  short_utterance_count: number;
  short_utterance_rate: number | null;
  average_final_utterance_characters: number | null;
  punctuation_terminated_rate: number | null;
  average_revisions_per_utterance: number | null;
  maximum_revisions_per_utterance: number;
  normalized_text: string;
  utterances: MeetingUtterance[];
};

type LoadedAudioChunk = {
  chunk: MeetingAudioChunk;
  audio: Uint8Array;
};

const defaultPrompt = [
  'InkLoop', 'AI Pen', '白板笔', '电子纸', '虚拟摄像头', 'Google Meet', 'Zoom',
  '硬件', '软件', '竞品', '轨迹', '入射角', '畸变', '矢量', 'SKU',
].join('，');

function encodedChecksum(audio: Uint8Array): string {
  return `sha256:${createHash('sha256').update(audio).digest('hex')}`;
}

function dbfs(value: number): number {
  return Number((20 * Math.log10(Math.max(1 / 32_768, value))).toFixed(2));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] || 0;
}

export function analyzePcm16Mono(audio: Uint8Array, sampleRate = 16_000): AudioQuality {
  if (audio.byteLength < 2 || audio.byteLength % 2 !== 0) {
    throw new Error('asr_diagnostic_pcm16_required');
  }
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const frameLevels: number[] = [];
  let squared = 0;
  let zeroSamples = 0;
  let clippedSamples = 0;
  let peak = 0;
  let frameSquared = 0;
  let frameCount = 0;
  const sampleCount = audio.byteLength / 2;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    const normalized = sample / 32_768;
    squared += normalized * normalized;
    frameSquared += normalized * normalized;
    frameCount += 1;
    peak = Math.max(peak, Math.abs(normalized));
    if (sample === 0) zeroSamples += 1;
    if (Math.abs(sample) >= 32_767) clippedSamples += 1;
    if (frameCount === frameSamples || index === sampleCount - 1) {
      frameLevels.push(dbfs(Math.sqrt(frameSquared / frameCount)));
      frameSquared = 0;
      frameCount = 0;
    }
  }
  return {
    duration_ms: Math.round(sampleCount / sampleRate * 1_000),
    sample_count: sampleCount,
    zero_sample_ratio: zeroSamples / sampleCount,
    clipping_sample_ratio: clippedSamples / sampleCount,
    peak_dbfs: dbfs(peak),
    rms_dbfs: dbfs(Math.sqrt(squared / sampleCount)),
    frame_rms_dbfs: {
      p10: percentile(frameLevels, 0.1),
      p50: percentile(frameLevels, 0.5),
      p90: percentile(frameLevels, 0.9),
    },
  };
}

function compactText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

export function normalizedEditRatio(left: string, right: string): number | null {
  const a = [...compactText(left)];
  const b = [...compactText(right)];
  if (!a.length && !b.length) return 0;
  if (!a.length || !b.length) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] || 0) + 1,
        (previous[column] || 0) + 1,
        (previous[column - 1] || 0) + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return (previous[b.length] || 0) / Math.max(a.length, b.length);
}

async function loadTrack(
  sessionDirectory: string,
  track: MeetingAudioTrack,
): Promise<LoadedAudioChunk[]> {
  const directory = resolve(sessionDirectory, 'raw', track);
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const chunks: LoadedAudioChunk[] = [];
  for (const metadataName of names) {
    const stem = metadataName.slice(0, -'.json'.length);
    chunks.push({
      chunk: JSON.parse(await readFile(resolve(directory, metadataName), 'utf8')) as MeetingAudioChunk,
      audio: await readFile(resolve(directory, `${stem}.audio`)),
    });
  }
  return chunks;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function realtimeFrames(
  chunks: LoadedAudioChunk[],
  frameMs: number,
): Array<{ chunk: MeetingAudioChunk; audio: Uint8Array }> {
  const result: Array<{ chunk: MeetingAudioChunk; audio: Uint8Array }> = [];
  let frameSequence = 0;
  for (const value of chunks) {
    const sampleRate = value.chunk.sample_rate_hz;
    if (value.chunk.codec !== 'pcm_s16le' || sampleRate !== 16_000
      || value.chunk.channel_count !== 1 || value.audio.byteLength % 2 !== 0) {
      throw new Error('asr_diagnostic_pcm16_mono_required');
    }
    const bytesPerFrame = Math.max(
      2,
      Math.round(sampleRate * frameMs / 1_000) * 2,
    );
    for (let offset = 0; offset < value.audio.byteLength; offset += bytesPerFrame) {
      const audio = value.audio.slice(offset, Math.min(value.audio.byteLength, offset + bytesPerFrame));
      const sampleOffset = offset / 2;
      const endSampleOffset = (offset + audio.byteLength) / 2;
      const startMs = value.chunk.start_monotonic_ms + Math.round(sampleOffset / sampleRate * 1_000);
      const endMs = Math.min(
        value.chunk.end_monotonic_ms,
        value.chunk.start_monotonic_ms + Math.round(endSampleOffset / sampleRate * 1_000),
      );
      result.push({
        chunk: {
          ...value.chunk,
          chunk_id: `${value.chunk.session_id}:${value.chunk.track}:diagnostic-frame:${frameSequence}`,
          sequence: frameSequence,
          start_monotonic_ms: startMs,
          end_monotonic_ms: Math.max(startMs + 1, endMs),
          byte_length: audio.byteLength,
          checksum: encodedChecksum(audio),
        },
        audio,
      });
      frameSequence += 1;
    }
  }
  return result;
}

async function replayBuffered(
  options: CliOptions,
  chunks: LoadedAudioChunk[],
  windowMs: number,
): Promise<BufferedRun> {
  const providerDurations: number[] = [];
  const provider = createBufferedOpenAICompatibleStreamingAsrProvider({
    endpoint: options.endpoint,
    model: options.model,
    language: options.language,
    prompt: options.prompt,
    minimumWindowMs: windowMs,
    revisionIntervalMs: windowMs,
    maximumWindowMs: options.maximumWindowMs,
    fetchImpl: async (input, init) => {
      const started = performance.now();
      try {
        return await fetch(input, init);
      } finally {
        providerDurations.push(performance.now() - started);
      }
    },
  });
  const frames = realtimeFrames(chunks, options.frameMs);
  const latest = new Map<string, MeetingUtterance>();
  const revisionCounts = new Map<string, number>();
  let emittedRevisionCount = 0;
  let firstProvisionalAfterAudioStartMs: number | null = null;
  const audioStart = frames[0]?.chunk.start_monotonic_ms || 0;
  const wallStarted = performance.now();
  for (const frame of frames) {
    const requestCountBefore = providerDurations.length;
    const utterances = await provider.transcribeChunk({
      tenant_id: 'diagnostic',
      user_id: 'diagnostic',
      chunk: frame.chunk,
      audio: frame.audio,
    });
    for (const utterance of utterances) {
      emittedRevisionCount += 1;
      latest.set(utterance.utterance_id, utterance);
      revisionCounts.set(utterance.utterance_id, (revisionCounts.get(utterance.utterance_id) || 0) + 1);
      if (firstProvisionalAfterAudioStartMs === null) {
        const requestDuration = providerDurations[requestCountBefore] || 0;
        firstProvisionalAfterAudioStartMs = Math.round(
          frame.chunk.end_monotonic_ms - audioStart + requestDuration,
        );
      }
    }
  }
  const utterances = [...latest.values()].sort((left, right) =>
    left.start_ms - right.start_ms || left.utterance_id.localeCompare(right.utterance_id));
  const characterCounts = utterances.map((value) => compactText(value.text).length);
  const shortUtteranceCount = characterCounts.filter((value) => value <= 2).length;
  const punctuationTerminated = utterances.filter((value) => /[。！？!?；;：:]$/u.test(value.text.trim())).length;
  const revisions = [...revisionCounts.values()];
  return {
    window_ms: windowMs,
    provider_id: provider.provider_id,
    wall_time_ms: Math.round(performance.now() - wallStarted),
    request_count: providerDurations.length,
    provider_duration_ms: providerDurations.map(Math.round),
    first_provisional_after_audio_start_ms: firstProvisionalAfterAudioStartMs,
    emitted_revision_count: emittedRevisionCount,
    final_utterance_count: utterances.length,
    short_utterance_count: shortUtteranceCount,
    short_utterance_rate: utterances.length ? shortUtteranceCount / utterances.length : null,
    average_final_utterance_characters: utterances.length
      ? characterCounts.reduce((sum, value) => sum + value, 0) / utterances.length
      : null,
    punctuation_terminated_rate: utterances.length ? punctuationTerminated / utterances.length : null,
    average_revisions_per_utterance: revisions.length
      ? revisions.reduce((sum, value) => sum + value, 0) / revisions.length
      : null,
    maximum_revisions_per_utterance: revisions.length ? Math.max(...revisions) : 0,
    normalized_text: utterances.map((value) => value.text.trim()).join('\n'),
    utterances,
  };
}

export async function diagnoseMeetingAsr(options: CliOptions) {
  const sessionDirectory = resolve(options.localRoot, options.session);
  const micChunks = await loadTrack(sessionDirectory, 'mic');
  if (!micChunks.length) throw new Error(`asr_diagnostic_mic_chunks_missing:${options.session}`);
  const micAudio = concatenate(micChunks.map((value) => value.audio));
  const formalConverger = createOpenAICompatibleFormalTranscriptConverger({
    endpoint: options.endpoint,
    model: options.model,
    language: options.language,
    prompt: options.prompt,
  });
  const formalStarted = performance.now();
  const formalUtterances = await formalConverger.converge({
    session_id: options.session,
    chunks: micChunks.map((value) => ({
      chunk: value.chunk,
      loadAudio: async () => value.audio,
    })),
  });
  const formalWallTimeMs = Math.round(performance.now() - formalStarted);
  const formalText = formalUtterances.map((value) => value.text.trim()).join('\n');
  const runs: BufferedRun[] = [];
  for (const windowMs of options.windows) {
    process.stderr.write(`[asr-diagnostic] replaying ${windowMs} ms window\n`);
    runs.push(await replayBuffered(options, micChunks, windowMs));
  }
  return {
    schema_version: 'inkloop.meeting_asr_diagnostic.v1',
    generated_at_ms: Date.now(),
    ground_truth_available: false,
    accuracy_note: 'No human-corrected reference is present. Disagreement metrics compare two model projections and are not CER/WER.',
    source: {
      session_id: options.session,
      session_directory: sessionDirectory,
      track: 'mic',
      chunk_count: micChunks.length,
      audio_quality: analyzePcm16Mono(micAudio, micChunks[0].chunk.sample_rate_hz),
    },
    formal: {
      converger_id: formalConverger.converger_id,
      wall_time_ms: formalWallTimeMs,
      utterance_count: formalUtterances.length,
      text: formalText,
      utterances: formalUtterances,
    },
    candidates: runs.map((run) => ({
      ...run,
      streaming_formal_normalized_edit_ratio: normalizedEditRatio(run.normalized_text, formalText),
    })),
  };
}

const diagnosticUsage = 'usage: diagnose-meeting-asr --session <uuid> [--windows 4000,8000,12000] [--out report.json]';

export function parseMeetingAsrDiagnosticArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const supported = new Set([
    'session',
    'local-root',
    'endpoint',
    'model',
    'language',
    'prompt',
    'windows',
    'maximum-window-ms',
    'frame-ms',
    'out',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] || '';
    if (!flag.startsWith('--')) throw new Error(`unknown_argument:${flag}`);
    const name = flag.slice(2);
    if (!supported.has(name)) throw new Error(`unknown_argument:${flag}`);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`missing_value:${flag}`);
    if (values.has(name)) throw new Error(`duplicate_argument:${flag}`);
    values.set(name, next);
    index += 1;
  }
  const value = (name: string): string | undefined => values.get(name);
  const session = value('session')?.trim() || '';
  if (!session) throw new Error(diagnosticUsage);
  const windows = (value('windows') || '4000,8000,12000')
    .split(',')
    .map(Number)
    .filter((item) => Number.isInteger(item) && item >= 1_000);
  if (!windows.length) throw new Error('asr_diagnostic_windows_invalid');
  const maximumWindowMs = Number(value('maximum-window-ms') || 20_000);
  const frameMs = Number(value('frame-ms') || 1_000);
  if (!Number.isInteger(maximumWindowMs)
    || maximumWindowMs < Math.max(...windows)
    || maximumWindowMs > 120_000) {
    throw new Error('asr_diagnostic_maximum_window_invalid');
  }
  if (!Number.isInteger(frameMs) || frameMs < 100 || frameMs > 10_000) {
    throw new Error('asr_diagnostic_frame_invalid');
  }
  return {
    session,
    localRoot: resolve(value('local-root')
      || resolve(homedir(), 'Library/Application Support/InkLoop/MeetingEvidence')),
    endpoint: value('endpoint')?.trim()
      || process.env.INKLOOP_STREAMING_ASR_URL?.trim()
      || 'http://127.0.0.1:8081/inference',
    model: value('model')?.trim()
      || process.env.INKLOOP_STREAMING_ASR_MODEL?.trim()
      || 'ggml-large-v3-turbo-q5_0',
    language: value('language')?.trim()
      || process.env.INKLOOP_STREAMING_ASR_LANGUAGE?.trim()
      || 'zh',
    prompt: value('prompt')?.trim()
      || process.env.INKLOOP_STREAMING_ASR_PROMPT?.trim()
      || defaultPrompt,
    windows,
    maximumWindowMs,
    frameMs,
    output: value('out') ? resolve(value('out') || '') : undefined,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${diagnosticUsage}\n`);
    return;
  }
  const options = parseMeetingAsrDiagnosticArgs(argv);
  const report = await diagnoseMeetingAsr(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(resolve(options.output, '..'), { recursive: true });
    await writeFile(options.output, output, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      output: options.output,
      session_id: report.source.session_id,
      candidates: report.candidates.length,
    })}\n`);
    return;
  }
  process.stdout.write(output);
}

if (basename(process.argv[1] || '') === basename(import.meta.filename)) {
  void main().catch((error) => {
    console.error(String((error as Error).message || error));
    process.exitCode = 2;
  });
}
