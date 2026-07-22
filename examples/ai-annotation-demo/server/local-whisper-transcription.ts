import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

interface ClassroomProviderRequest {
  chunk_id: string;
  chunk_hash: string;
  relative_start_ms: number;
  relative_end_ms: number;
  language_hint: string;
  wav_base64: string;
}

interface WhisperJsonSegment {
  offsets?: { from?: number; to?: number };
  text?: string;
  tokens?: Array<{ p?: number }>;
}

interface WhisperJson {
  transcription?: WhisperJsonSegment[];
}

export interface WhisperCliRunnerInput {
  cliPath: string;
  modelPath: string;
  wavPath: string;
  outputPath: string;
  language: string;
  timeoutMs: number;
}

export type WhisperCliRunner = (input: WhisperCliRunnerInput) => Promise<WhisperJson & { outputPath?: string }>;

export interface LocalWhisperServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function transcribeFloat32WithWhisper(options: {
  samples: Float32Array;
  sampleRate: number;
  cliPath: string;
  modelPath: string;
  language?: string;
  timeoutMs?: number;
}): Promise<string> {
  if (options.samples.length === 0 || !(options.sampleRate > 0)) return '';
  const directory = await mkdtemp(join(tmpdir(), 'inkloop-whisper-final-'));
  try {
    const wav = new Uint8Array(44 + options.samples.length * 2); const view = new DataView(wav.buffer);
    const ascii = (offset: number, value: string): void => { for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index); };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + options.samples.length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, options.sampleRate, true);
    view.setUint32(28, options.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, options.samples.length * 2, true);
    for (let index = 0; index < options.samples.length; index += 1) view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, options.samples[index] ?? 0)) * 0x7fff), true);
    const wavPath = join(directory, 'utterance.wav'); const outputPath = join(directory, 'transcript');
    await writeFile(wavPath, wav, { mode: 0o600 });
    const output = await runWhisperCli({
      cliPath: options.cliPath, modelPath: options.modelPath, wavPath, outputPath,
      language: options.language ?? 'auto', timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return (output.transcription ?? []).map((segment) => String(segment.text || '').trim()).filter(Boolean).join(' ').trim();
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}

function isRequest(value: unknown): value is ClassroomProviderRequest {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(input.chunk_id || ''))
    && /^sha256:[a-f0-9]{64}$/i.test(String(input.chunk_hash || ''))
    && Number.isInteger(input.relative_start_ms) && Number.isInteger(input.relative_end_ms)
    && Number(input.relative_start_ms) >= 0 && Number(input.relative_end_ms) > Number(input.relative_start_ms)
    && Number(input.relative_end_ms) - Number(input.relative_start_ms) <= 5_000
    && typeof input.language_hint === 'string' && input.language_hint.length <= 32
    && typeof input.wav_base64 === 'string' && input.wav_base64.length > 0;
}

function confidence(segment: WhisperJsonSegment): number {
  const probabilities = (segment.tokens ?? []).map((token) => token.p).filter((value): value is number => Number.isFinite(value));
  if (probabilities.length === 0) return 0.75;
  return Math.round((probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length) * 10_000) / 10_000;
}

export function parseWhisperJson(payload: WhisperJson, input: Pick<ClassroomProviderRequest, 'relative_start_ms' | 'relative_end_ms'>) {
  const duration = input.relative_end_ms - input.relative_start_ms;
  return (payload.transcription ?? []).flatMap((segment, index) => {
    const text = String(segment.text || '').trim();
    if (!text) return [];
    const localStart = Math.max(0, Math.min(duration - 1, Math.round(Number(segment.offsets?.from ?? 0))));
    const localEnd = Math.max(localStart + 1, Math.min(duration, Math.round(Number(segment.offsets?.to ?? duration))));
    return [{
      segment_id: `segment_${index + 1}`,
      status: 'final' as const,
      relative_start_ms: input.relative_start_ms + localStart,
      relative_end_ms: input.relative_start_ms + localEnd,
      text,
      confidence: confidence(segment),
    }];
  });
}

export const runWhisperCli: WhisperCliRunner = async (input) => {
  await execFileAsync(input.cliPath, [
    '-m', input.modelPath,
    '-f', input.wavPath,
    '-l', input.language,
    '-ojf',
    '-of', input.outputPath,
    '-np',
  ], { timeout: input.timeoutMs, maxBuffer: 1024 * 1024 });
  return JSON.parse(await readFile(`${input.outputPath}.json`, 'utf8')) as WhisperJson;
};

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let received = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.byteLength;
    if (received > maxBytes) throw new Error('request_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('request_invalid'); }
}

function respond(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' });
  res.end(json);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

export async function startLocalWhisperTranscriptionServer(options: {
  port?: number;
  host?: string;
  modelPath: string;
  cliPath?: string;
  runner?: WhisperCliRunner;
  workRoot?: string;
  maxRequestBytes?: number;
  timeoutMs?: number;
}): Promise<LocalWhisperServer> {
  const host = options.host ?? '127.0.0.1';
  const runner = options.runner ?? runWhisperCli;
  const workRoot = resolve(options.workRoot ?? join(tmpdir(), 'inkloop-whisper'));
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return respond(res, 200, { status: 'ok', provider: 'whisper_cpp' });
    if (req.method !== 'POST' || req.url !== '/v1/transcribe') return respond(res, 404, { error: 'not_found' });
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return respond(res, 415, { error: 'content_type_invalid' });
    let directory = '';
    try {
      const body = await readJsonBody(req, options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
      if (!isRequest(body)) return respond(res, 400, { error: 'request_invalid' });
      const wav = Buffer.from(body.wav_base64, 'base64');
      if (wav.byteLength < 12 || wav.subarray(0, 4).toString() !== 'RIFF' || wav.subarray(8, 12).toString() !== 'WAVE') return respond(res, 400, { error: 'wav_invalid' });
      directory = await mkdtemp(join(workRoot, `${body.chunk_id}-`));
      const wavPath = join(directory, 'audio.wav');
      const outputPath = join(directory, 'transcript');
      await writeFile(wavPath, wav, { mode: 0o600 });
      const output = await runner({
        cliPath: options.cliPath ?? '/opt/homebrew/bin/whisper-cli', modelPath: options.modelPath,
        wavPath, outputPath, language: body.language_hint.toLowerCase().startsWith('zh') ? 'zh' : 'auto',
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return respond(res, 200, {
        provider: `whisper_cpp_${basename(options.modelPath).replace(/^ggml-|\.bin$/g, '').replace(/[^A-Za-z0-9_-]/g, '_')}`,
        processing_mode: 'local', segments: parseWhisperJson(output, body),
      });
    } catch (error) {
      const code = String((error as Error)?.message || error);
      if (code === 'request_too_large') return respond(res, 413, { error: code });
      if (code === 'request_invalid') return respond(res, 400, { error: code });
      return respond(res, 503, { error: 'whisper_inference_failed' });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  server.requestTimeout = (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8178, host, () => { server.off('error', reject); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { await closeServer(server); throw new Error('whisper_server_address_invalid'); }
  return { url: `http://${host}:${address.port}/v1/transcribe`, port: address.port, close: () => closeServer(server) };
}
