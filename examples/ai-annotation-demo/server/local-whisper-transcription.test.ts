import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseWhisperJson,
  startLocalWhisperTranscriptionServer,
  type WhisperCliRunner,
} from './local-whisper-transcription';

const request = {
  chunk_id: 'chunk_7',
  chunk_hash: `sha256:${'a'.repeat(64)}`,
  relative_start_ms: 4_000,
  relative_end_ms: 6_000,
  language_hint: 'zh-CN',
  wav_base64: Buffer.from('RIFF0000WAVE').toString('base64'),
};

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

describe('local whisper transcription provider', () => {
  it('maps whisper.cpp JSON to the classroom timeline and clamps padded timestamps', () => {
    expect(parseWhisperJson({ transcription: [
      { offsets: { from: 100, to: 900 }, text: '  两边同时加九  ', tokens: [{ p: 0.8 }, { p: 0.6 }] },
      { offsets: { from: 1_900, to: 30_000 }, text: '得到完全平方', tokens: [{ p: 0.9 }] },
    ] }, request)).toEqual([
      { segment_id: 'segment_1', status: 'final', relative_start_ms: 4_100, relative_end_ms: 4_900, text: '两边同时加九', confidence: 0.7 },
      { segment_id: 'segment_2', status: 'final', relative_start_ms: 5_900, relative_end_ms: 6_000, text: '得到完全平方', confidence: 0.9 },
    ]);
    expect(parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 100 }, text: '   ' }] }, request)).toEqual([]);
  });

  it('accepts the classroom JSON contract, writes a WAV, and returns local segments', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'inkloop-whisper-test-'));
    const runner: WhisperCliRunner = vi.fn(async ({ wavPath, outputPath }) => {
      expect((await readFile(wavPath)).subarray(0, 4).toString()).toBe('RIFF');
      return { transcription: [{ offsets: { from: 0, to: 1_000 }, text: '移项', tokens: [{ p: 0.88 }] }], outputPath };
    });
    const server = await startLocalWhisperTranscriptionServer({ port: 0, modelPath: '/models/ggml-base.bin', runner, workRoot });
    servers.push(server);
    const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: 'whisper_cpp_base', processing_mode: 'local',
      segments: [{ segment_id: 'segment_1', status: 'final', relative_start_ms: 4_000, relative_end_ms: 5_000, text: '移项', confidence: 0.88 }],
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it('rejects oversized or malformed requests without invoking whisper', async () => {
    const runner: WhisperCliRunner = vi.fn();
    const server = await startLocalWhisperTranscriptionServer({ port: 0, modelPath: '/models/ggml-base.bin', runner, maxRequestBytes: 128 });
    servers.push(server);
    const oversized = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(oversized.status).toBe(413);
    const malformed = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns a stable provider error when whisper-cli fails', async () => {
    const runner: WhisperCliRunner = vi.fn(async () => { throw new Error('private stderr must not leak'); });
    const server = await startLocalWhisperTranscriptionServer({ port: 0, modelPath: '/models/ggml-base.bin', runner });
    servers.push(server);
    const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'whisper_inference_failed' });
  });
});
