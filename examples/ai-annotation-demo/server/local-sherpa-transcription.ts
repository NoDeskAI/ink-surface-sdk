import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

interface OnlineResult { text?: string }
interface OnlineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
}
interface OnlineRecognizer {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  getResult(stream: OnlineStream): OnlineResult;
  isEndpoint(stream: OnlineStream): boolean;
  reset(stream: OnlineStream): void;
}
interface SherpaModule { OnlineRecognizer: new (configuration: Record<string, unknown>) => OnlineRecognizer }
interface ParaformerFiles { encoder: string; decoder: string; tokens: string }
interface StreamSession {
  recognizer: OnlineRecognizer;
  stream: OnlineStream;
  streamId: string;
  utterance: number;
  lastPartial: string;
  lastSequence: number;
  utteranceStartMs: number;
  touchedAt: number;
  responses: Map<string, SherpaResponse>;
  utteranceSamples: Float32Array[];
}
interface SherpaRequest {
  recording_id: string;
  recording_generation: number;
  sequence: number;
  chunk_id: string;
  relative_start_ms: number;
  relative_end_ms: number;
  wav_base64: string;
  finalize?: boolean;
  language_hint?: string;
}
interface SherpaResponse {
  provider: 'sherpa_onnx_streaming_paraformer_zh_en';
  processing_mode: 'local';
  stream_id: string;
  language: 'zh-en';
  segments: Array<{
    segment_id: string;
    status: 'provisional' | 'final';
    relative_start_ms: number;
    relative_end_ms: number;
    text: string;
    confidence: number;
  }>;
}

export function verifiedFinalText(streamingText: string, verifiedText: string, endpoint: boolean): string {
  const verified = verifiedText.trim();
  const unexpectedCjkScript = /[\u3040-\u30ff\uac00-\ud7af]/u.test(verified);
  const streaming = streamingText.trim();
  if (!endpoint || !verified || unexpectedCjkScript) return streaming;
  if (!streaming) return verified;
  const comparable = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s，。！？、,.!?；;：“”"'‘’（）()\[\]]/gu, '');
  const streamingComparable = comparable(streaming); const verifiedComparable = comparable(verified);
  // The offline pass may complete a streaming prefix, but must never replace it
  // with a semantically different sentence or insert unrelated middle content.
  if (streamingComparable && verifiedComparable.length > streamingComparable.length && verifiedComparable.startsWith(streamingComparable)) return verified;
  return streaming;
}

function hasSpeechActivity(samples: Float32Array, sampleRate = 16_000): boolean {
  if (samples.length === 0) return false;
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  let activeFrames = 0; let frameCount = 0;
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const end = Math.min(samples.length, offset + frameSize); let sumSquares = 0;
    for (let index = offset; index < end; index += 1) sumSquares += (samples[index] ?? 0) ** 2;
    const rms = Math.sqrt(sumSquares / Math.max(1, end - offset)); frameCount += 1;
    if (rms >= 0.008) activeFrames += 1;
  }
  return activeFrames >= Math.min(6, Math.max(3, Math.ceil(frameCount * 0.06)));
}

function isKnownSubtitleHallucination(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /(?:字幕|subtitles?|captions?)\s*[:：]/iu.test(normalized)
    || /^\(.+\)[。.!?！？]?$/u.test(normalized);
}

export function isUsableFinalUtterance(samples: Float32Array, text: string): boolean {
  return Boolean(text.trim()) && hasSpeechActivity(samples) && !isKnownSubtitleHallucination(text);
}

const require = createRequire(import.meta.url);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SESSION_IDLE_MS = 10 * 60_000;

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function preferModel(left: string, right: string): number {
  const score = (path: string): number => {
    const name = basename(path).toLowerCase();
    return (name.includes('int8') ? 4 : 0) + (name.startsWith('encoder-') || name.startsWith('decoder-') ? 2 : 0);
  };
  return score(right) - score(left) || left.localeCompare(right);
}

async function listModelFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).slice(0, 256)) {
    const path = join(directory, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) files.push(...await listModelFiles(path, depth + 1));
  }
  return files;
}

export function resolveParaformerFilesFromList(modelDirectory: string, files: readonly string[]): ParaformerFiles {
  const byDirectory = new Map<string, string[]>();
  for (const file of files) byDirectory.set(dirname(file), [...(byDirectory.get(dirname(file)) ?? []), file]);
  const candidates: Array<ParaformerFiles & { directory: string }> = [];
  for (const [directory, directoryFiles] of byDirectory) {
    const onnx = directoryFiles.filter((path) => path.toLowerCase().endsWith('.onnx'));
    const encoder = onnx.filter((path) => basename(path).toLowerCase().includes('encoder')).sort(preferModel)[0];
    const decoder = onnx.filter((path) => basename(path).toLowerCase().includes('decoder')).sort(preferModel)[0];
    const tokens = directoryFiles.find((path) => basename(path).toLowerCase() === 'tokens.txt');
    if (encoder && decoder && tokens) candidates.push({ directory, encoder, decoder, tokens });
  }
  if (candidates.length === 0) throw new Error('sherpa_model_missing');
  if (candidates.length > 1) throw new Error(`sherpa_model_ambiguous:${candidates.map((item) => relative(modelDirectory, item.directory) || '.').join(',')}`);
  const { encoder, decoder, tokens } = candidates[0]!;
  return { encoder, decoder, tokens };
}

export async function resolveParaformerFiles(modelDirectory: string): Promise<ParaformerFiles> {
  const info = await stat(modelDirectory).catch(() => null);
  if (!info?.isDirectory()) throw new Error('sherpa_model_missing');
  return resolveParaformerFilesFromList(modelDirectory, await listModelFiles(modelDirectory));
}

function wavToFloat32(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  if (bytes.byteLength < 44) throw new Error('sherpa_audio_invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number): string => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('sherpa_audio_invalid');
  let offset = 12; let format = 0; let channels = 0; let sampleRate = 0; let bits = 0; let dataOffset = 0; let dataSize = 0;
  while (offset + 8 <= bytes.byteLength) {
    const kind = text(offset, 4); const size = view.getUint32(offset + 4, true); const body = offset + 8;
    if (body + size > bytes.byteLength) throw new Error('sherpa_audio_invalid');
    if (kind === 'fmt ' && size >= 16) {
      format = view.getUint16(body, true); channels = view.getUint16(body + 2, true); sampleRate = view.getUint32(body + 4, true); bits = view.getUint16(body + 14, true);
    } else if (kind === 'data') { dataOffset = body; dataSize = size; break; }
    offset = body + size + (size % 2);
  }
  if (format !== 1 || bits !== 16 || ![1, 2].includes(channels) || sampleRate < 8_000 || !dataOffset || dataSize < channels * 2) throw new Error('sherpa_audio_invalid');
  const frames = Math.floor(dataSize / (channels * 2)); const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 0x8000;
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate };
}

export function resampleForSherpa(samples: Float32Array, inputRate: number, outputRate = 16_000): Float32Array {
  if (inputRate === outputRate) return samples;
  const ratio = inputRate / outputRate; const length = Math.max(1, Math.floor(samples.length / ratio)); const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio; const left = Math.floor(position); const right = Math.min(samples.length - 1, left + 1); const mix = position - left;
    output[index] = (samples[left] ?? 0) * (1 - mix) + (samples[right] ?? 0) * mix;
  }
  return output;
}

function response(session: StreamSession, request: SherpaRequest, text: string, final: boolean): SherpaResponse {
  return {
    provider: 'sherpa_onnx_streaming_paraformer_zh_en', processing_mode: 'local', stream_id: session.streamId, language: 'zh-en',
    segments: text ? [{
      segment_id: `utterance_${session.utterance}`, status: final ? 'final' : 'provisional',
      relative_start_ms: session.utteranceStartMs, relative_end_ms: request.relative_end_ms,
      text, confidence: final ? 0.86 : 0.72,
    }] : [],
  };
}

export async function startLocalSherpaTranscriptionServer(options: {
  port: number;
  modelDirectory: string;
  numThreads?: number;
  finalVerifier?: (input: { samples: Float32Array; sampleRate: number; language: 'zh' | 'en' }) => Promise<string>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const files = await resolveParaformerFiles(options.modelDirectory);
  let sherpa: SherpaModule;
  try { sherpa = require('sherpa-onnx-node') as SherpaModule; } catch { throw new Error('sherpa_native_package_missing'); }
  const sessions = new Map<string, StreamSession>();
  const createSession = (streamId: string): StreamSession => {
    const recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: { paraformer: { encoder: files.encoder, decoder: files.decoder }, tokens: files.tokens, numThreads: options.numThreads ?? 2, debug: false, provider: 'cpu' },
      decodingMethod: 'greedy_search', enableEndpoint: true,
      rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.0, rule3MinUtteranceLength: 20,
    });
    return { recognizer, stream: recognizer.createStream(), streamId, utterance: 1, lastPartial: '', lastSequence: 0, utteranceStartMs: 0, touchedAt: Date.now(), responses: new Map(), utteranceSamples: [] };
  };
  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/transcribe') { res.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_REQUEST_BYTES) throw new Error('request_too_large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SherpaRequest;
      const recordingId = safeId(input.recording_id, 'recording_id'); const chunkId = safeId(input.chunk_id, 'chunk_id');
      if (!Number.isInteger(input.recording_generation) || input.recording_generation < 1 || !Number.isInteger(input.sequence) || input.sequence < 1) throw new Error('sherpa_sequence_invalid');
      if (!Number.isInteger(input.relative_start_ms) || !Number.isInteger(input.relative_end_ms) || input.relative_end_ms <= input.relative_start_ms) throw new Error('sherpa_time_invalid');
      const key = `${recordingId}:${input.recording_generation}`;
      let session = sessions.get(key);
      if (!session) { session = createSession(`stream_${recordingId}_${input.recording_generation}_${input.sequence}`); sessions.set(key, session); }
      const responseKey = `${chunkId}:${input.finalize === true ? 'final' : 'audio'}`;
      const cached = session.responses.get(responseKey); if (cached) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cached)); return; }
      if (!input.finalize && session.lastSequence > 0 && input.sequence !== session.lastSequence + 1) {
        session = createSession(`stream_${recordingId}_${input.recording_generation}_gap_${input.sequence}`); sessions.set(key, session);
      }
      if (input.finalize) session.stream.inputFinished();
      else {
        const audio = wavToFloat32(Buffer.from(input.wav_base64, 'base64'));
        const samples = resampleForSherpa(audio.samples, audio.sampleRate);
        session.utteranceSamples.push(samples); session.stream.acceptWaveform({ samples, sampleRate: 16_000 });
      }
      while (session.recognizer.isReady(session.stream)) session.recognizer.decode(session.stream);
      const streamingText = session.recognizer.getResult(session.stream).text?.trim() ?? '';
      const endpoint = input.finalize === true || session.recognizer.isEndpoint(session.stream);
      const length = session.utteranceSamples.reduce((sum, samples) => sum + samples.length, 0); const utterance = new Float32Array(length); let utteranceOffset = 0;
      for (const samples of session.utteranceSamples) { utterance.set(samples, utteranceOffset); utteranceOffset += samples.length; }
      let verifiedText = '';
      if (endpoint && options.finalVerifier && utterance.length > 0) {
        verifiedText = await options.finalVerifier({ samples: utterance, sampleRate: 16_000, language: input.language_hint === 'en' ? 'en' : 'zh' }).catch(() => '');
      }
      const candidateText = verifiedFinalText(streamingText, verifiedText, endpoint);
      const text = isUsableFinalUtterance(utterance, candidateText) ? candidateText : '';
      const result = response(session, input, text, endpoint);
      if (!endpoint && text === session.lastPartial) result.segments = [];
      if (endpoint && !input.finalize) { session.recognizer.reset(session.stream); session.utterance += 1; session.utteranceStartMs = input.relative_end_ms; session.lastPartial = ''; session.utteranceSamples = []; }
      else session.lastPartial = text;
      session.lastSequence = input.sequence; session.touchedAt = Date.now(); session.responses.set(responseKey, result);
      if (session.responses.size > 64) session.responses.delete(session.responses.keys().next().value!);
      for (const [id, stale] of sessions) if (Date.now() - stale.touchedAt > SESSION_IDLE_MS) sessions.delete(id);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      const code = String((error as Error).message || 'sherpa_inference_failed').split(':')[0];
      res.writeHead(code === 'request_too_large' ? 413 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: code }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : options.port;
  return { url: `http://127.0.0.1:${port}/v1/transcribe`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

export async function transcribePcmWithSherpa(options: { modelDirectory: string; pcmS16le: Uint8Array; sampleRate: number; channels?: number }): Promise<string> {
  const files = await resolveParaformerFiles(options.modelDirectory);
  let sherpa: SherpaModule;
  try { sherpa = require('sherpa-onnx-node') as SherpaModule; } catch { throw new Error('sherpa_native_package_missing'); }
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: { paraformer: { encoder: files.encoder, decoder: files.decoder }, tokens: files.tokens, numThreads: 2, debug: false, provider: 'cpu' },
    decodingMethod: 'greedy_search', enableEndpoint: true,
  });
  const channels = options.channels ?? 1; const view = new DataView(options.pcmS16le.buffer, options.pcmS16le.byteOffset, options.pcmS16le.byteLength);
  const frames = Math.floor(options.pcmS16le.byteLength / (channels * 2)); const source = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0; for (let channel = 0; channel < channels; channel += 1) sum += view.getInt16((frame * channels + channel) * 2, true) / 0x8000;
    source[frame] = sum / channels;
  }
  const stream = recognizer.createStream(); stream.acceptWaveform({ samples: resampleForSherpa(source, options.sampleRate), sampleRate: 16_000 }); stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  return recognizer.getResult(stream).text?.trim() ?? '';
}
