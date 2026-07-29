import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MeetingAudioChunk } from '../../../../packages/meeting-media-core/src/index';
import {
  createBufferedOpenAICompatibleStreamingAsrProvider,
  createConfiguredStreamingAsrProvider,
  createConfiguredFormalTranscriptConverger,
  createOpenAICompatibleStreamingAsrProvider,
  createOpenAICompatibleFormalTranscriptConverger,
  createSherpaFormalTranscriptConverger,
  createSherpaStreamingAsrProvider,
  StreamingAsrProviderRouter,
  type SherpaOnlineRecognizer,
  type StreamingAsrProvider,
} from './provider';

const audio = Buffer.alloc(8);
audio.writeFloatLE(0.25, 0);
audio.writeFloatLE(-0.25, 4);
const chunk: MeetingAudioChunk = {
  schema_version: 'inkloop.meeting_audio_chunk.v1',
  chunk_id: 'session-1:mic:2',
  session_id: 'session-1',
  track: 'mic',
  sequence: 2,
  start_monotonic_ms: 20_000,
  end_monotonic_ms: 30_000,
  checksum: `sha256:${createHash('sha256').update(audio).digest('hex')}`,
  byte_length: audio.length,
  sealed: true,
  codec: 'pcm_f32le',
  sample_rate_hz: 48_000,
  channel_count: 2,
};

describe('OpenAI-compatible streaming ASR provider', () => {
  it('uses the shorter minimum window for the first provisional result before the slower revision cadence', async () => {
    const requestedDurations: number[] = [];
    const provider = createBufferedOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      minimumWindowMs: 3_000,
      revisionIntervalMs: 4_000,
      maximumWindowMs: 20_000,
      fetchImpl: async (_input, init) => {
        const file = (init?.body as FormData).get('file') as File;
        requestedDurations.push(((await file.arrayBuffer()).byteLength - 44) / 2 / 16_000);
        return new Response(JSON.stringify({
          segments: [{
            id: 0,
            start: 0,
            end: requestedDurations.at(-1),
            text: `窗口 ${requestedDurations.length}`,
          }],
        }), { status: 200 });
      },
    });
    const pcm = Buffer.alloc(16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }

    for (let sequence = 0; sequence < 7; sequence += 1) {
      await provider.transcribeChunk({
        tenant_id: 't',
        user_id: 'u',
        chunk: {
          ...chunk,
          codec: 'pcm_s16le',
          sample_rate_hz: 16_000,
          channel_count: 1,
          sequence,
          chunk_id: `session-1:mic:frame:${sequence}`,
          start_monotonic_ms: sequence * 1_000,
          end_monotonic_ms: (sequence + 1) * 1_000,
          byte_length: pcm.length,
        },
        audio: pcm,
      });
    }

    expect(requestedDurations).toEqual([3, 7]);
  });

  it('flushes a speech window immediately when the client endpoint detector reports silence', async () => {
    const requestedDurations: number[] = [];
    const provider = createBufferedOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      minimumWindowMs: 3_000,
      revisionIntervalMs: 4_000,
      maximumWindowMs: 20_000,
      fetchImpl: async (_input, init) => {
        const file = (init?.body as FormData).get('file') as File;
        requestedDurations.push(((await file.arrayBuffer()).byteLength - 44) / 2 / 16_000);
        return new Response(JSON.stringify({
          segments: [{ id: 0, start: 0, end: 1.2, text: '短句立即结算' }],
        }), { status: 200 });
      },
    });
    const pcm = Buffer.alloc(16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }
    const input = (sequence: number, speechPresent: boolean, audio: Buffer) => ({
      tenant_id: 't',
      user_id: 'u',
      speech_present: speechPresent,
      chunk: {
        ...chunk,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence,
        chunk_id: `session-1:mic:frame:${sequence}`,
        start_monotonic_ms: sequence * 1_000,
        end_monotonic_ms: (sequence + 1) * 1_000,
        byte_length: audio.length,
      },
      audio,
    });

    expect(await provider.transcribeChunk(input(0, true, pcm))).toEqual([]);
    const result = await provider.endSpeech?.(input(1, false, Buffer.alloc(0)));

    expect(requestedDurations).toEqual([1]);
    expect(result).toEqual([expect.objectContaining({
      text: '短句立即结算',
      stability: 'provisional',
    })]);
  });

  it('buffers continuous realtime PCM and revises one stable utterance instead of decoding every callback', async () => {
    const requests: Array<{ bytes: number; responseFormat: string | null }> = [];
    const responses = [
      { segments: [{ id: 0, start: 0.2, end: 3.8, text: ' 硬件难度下降 ', avg_logprob: -0.1 }] },
      { segments: [{ id: 0, start: 0.2, end: 7.8, text: ' 硬件难度下降，重点在软件 ', avg_logprob: -0.08 }] },
    ];
    const provider = createBufferedOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      minimumWindowMs: 4_000,
      revisionIntervalMs: 4_000,
      maximumWindowMs: 20_000,
      fetchImpl: async (_input, init) => {
        const form = init?.body as FormData;
        const file = form.get('file') as File;
        requests.push({
          bytes: (await file.arrayBuffer()).byteLength,
          responseFormat: form.get('response_format') as string | null,
        });
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      },
    });
    const pcm = Buffer.alloc(16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }
    const input = (sequence: number) => ({
      tenant_id: 't',
      user_id: 'u',
      chunk: {
        ...chunk,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence,
        chunk_id: `session-1:mic:frame:${sequence}`,
        start_monotonic_ms: sequence * 1_000,
        end_monotonic_ms: (sequence + 1) * 1_000,
        byte_length: pcm.length,
      },
      audio: pcm,
    });

    const outputs = [];
    for (let sequence = 0; sequence < 8; sequence += 1) {
      outputs.push(await provider.transcribeChunk(input(sequence)));
    }

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.responseFormat)).toEqual(['verbose_json', 'verbose_json']);
    expect(requests[0].bytes).toBe(44 + 4 * pcm.length);
    expect(requests[1].bytes).toBe(44 + 8 * pcm.length);
    expect(outputs.flat()).toEqual([
      expect.objectContaining({
        utterance_id: 'utt_session-1_mic_window_0',
        text: '硬件难度下降',
        revision: 1,
      }),
      expect.objectContaining({
        utterance_id: 'utt_session-1_mic_window_0',
        text: '硬件难度下降，重点在软件',
        revision: 2,
      }),
    ]);
  });

  it('flushes and rotates a buffered window at the maximum duration even when the revision interval is not due', async () => {
    const requestedDurations: number[] = [];
    const provider = createBufferedOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      minimumWindowMs: 12_000,
      revisionIntervalMs: 12_000,
      maximumWindowMs: 20_000,
      fetchImpl: async (_input, init) => {
        const file = (init?.body as FormData).get('file') as File;
        requestedDurations.push(((await file.arrayBuffer()).byteLength - 44) / 2 / 16_000);
        return new Response(JSON.stringify({
          segments: [{ id: 0, start: 0, end: requestedDurations.at(-1), text: `窗口 ${requestedDurations.length}` }],
        }), { status: 200 });
      },
    });
    const pcm = Buffer.alloc(16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }
    for (let sequence = 0; sequence < 24; sequence += 1) {
      await provider.transcribeChunk({
        tenant_id: 't',
        user_id: 'u',
        chunk: {
          ...chunk,
          codec: 'pcm_s16le',
          sample_rate_hz: 16_000,
          channel_count: 1,
          sequence,
          chunk_id: `session-1:mic:frame:${sequence}`,
          start_monotonic_ms: sequence * 1_000,
          end_monotonic_ms: (sequence + 1) * 1_000,
          byte_length: pcm.length,
        },
        audio: pcm,
      });
    }

    expect(requestedDurations).toEqual([12, 20]);
  });

  it('advances and rotates an all-zero buffered window without invoking Whisper', async () => {
    let requestCount = 0;
    const provider = createBufferedOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      minimumWindowMs: 4_000,
      revisionIntervalMs: 4_000,
      maximumWindowMs: 8_000,
      fetchImpl: async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ text: '请不吝点赞订阅' }), { status: 200 });
      },
    });
    const silence = Buffer.alloc(16_000 * 2);
    for (let sequence = 0; sequence < 12; sequence += 1) {
      await expect(provider.transcribeChunk({
        tenant_id: 't',
        user_id: 'u',
        chunk: {
          ...chunk,
          codec: 'pcm_s16le',
          sample_rate_hz: 16_000,
          channel_count: 1,
          sequence,
          chunk_id: `session-1:remote:frame:${sequence}`,
          track: 'remote',
          start_monotonic_ms: sequence * 1_000,
          end_monotonic_ms: (sequence + 1) * 1_000,
          byte_length: silence.length,
        },
        audio: silence,
      })).resolves.toEqual([]);
    }

    expect(requestCount).toBe(0);
  });

  it('replays complete raw PCM through the configured high-quality formal provider', async () => {
    const requestedDurations: number[] = [];
    const converger = createOpenAICompatibleFormalTranscriptConverger({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      fetchImpl: async (_input, init) => {
        const file = (init?.body as FormData).get('file') as File;
        requestedDurations.push(((await file.arrayBuffer()).byteLength - 44) / 2 / 16_000);
        return new Response(JSON.stringify({
          segments: [
            { id: 0, start: 0.4, end: 1.8, text: ' 完整原始音频。 ', avg_logprob: -0.1 },
            { id: 1, start: 2.0, end: 3.7, text: ' 正式收敛 ', avg_logprob: -0.08 },
          ],
        }), { status: 200 });
      },
    });
    const pcm = Buffer.alloc(2 * 16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }
    const chunks = [0, 1].map((sequence) => ({
      chunk: {
        ...chunk,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence,
        chunk_id: `session-1:mic:${sequence}`,
        start_monotonic_ms: sequence * 2_000,
        end_monotonic_ms: (sequence + 1) * 2_000,
        byte_length: pcm.length,
      },
      loadAudio: async () => pcm,
    }));

    await expect(converger.converge({ session_id: 'session-1', chunks })).resolves.toEqual([
      expect.objectContaining({
        utterance_id: 'formal_session-1_mic_0_0',
        text: '完整原始音频。',
        source_chunk_ids: ['session-1:mic:0'],
      }),
      expect.objectContaining({
        utterance_id: 'formal_session-1_mic_0_1',
        text: '正式收敛',
        source_chunk_ids: ['session-1:mic:1'],
      }),
    ]);
    expect(requestedDurations).toEqual([4]);
    expect(converger.converger_id).toContain('large-v3-turbo');
  });

  it('coalesces adjacent formal Whisper fragments without changing their text or source coverage', async () => {
    const converger = createOpenAICompatibleFormalTranscriptConverger({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'large-v3-turbo',
      fetchImpl: async () => new Response(JSON.stringify({
        segments: [
          { id: 0, start: 0.2, end: 3.8, text: ' 这是一个被模型拆开的长句 ', avg_logprob: -0.1 },
          { id: 1, start: 3.8, end: 4.1, text: ' 的 ', avg_logprob: -0.2 },
          { id: 2, start: 5.4, end: 6.8, text: ' 新议题。 ', avg_logprob: -0.08 },
        ],
      }), { status: 200 }),
    });
    const pcm = Buffer.alloc(8 * 16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }
    const utterances = await converger.converge({
      session_id: 'session-1',
      chunks: [0, 1].map((sequence) => ({
        chunk: {
          ...chunk,
          codec: 'pcm_s16le',
          sample_rate_hz: 16_000,
          channel_count: 1,
          sequence,
          chunk_id: `session-1:mic:${sequence}`,
          start_monotonic_ms: sequence * 4_000,
          end_monotonic_ms: (sequence + 1) * 4_000,
          byte_length: pcm.length / 2,
        },
        loadAudio: async () =>
          pcm.subarray(sequence * pcm.length / 2, (sequence + 1) * pcm.length / 2),
      })),
    });

    expect(utterances).toEqual([
      expect.objectContaining({
        text: '这是一个被模型拆开的长句的',
        start_ms: 200,
        end_ms: 4_100,
        source_chunk_ids: ['session-1:mic:0', 'session-1:mic:1'],
      }),
      expect.objectContaining({
        text: '新议题。',
        start_ms: 5_400,
        end_ms: 6_800,
        source_chunk_ids: ['session-1:mic:1'],
      }),
    ]);
  });

  it('does not send silent PCM16 chunks to ASR or turn them into captions', async () => {
    const silentAudio = Buffer.alloc(16_000 * 2);
    const silentChunk: MeetingAudioChunk = {
      ...chunk,
      codec: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channel_count: 1,
      byte_length: silentAudio.length,
      checksum: `sha256:${createHash('sha256').update(silentAudio).digest('hex')}`,
    };
    let requestCount = 0;
    const provider = createOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'streaming-model',
      fetchImpl: async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ text: '请不吝点赞订阅' }), { status: 200 });
      },
    });

    await expect(provider.transcribeChunk({
      tenant_id: 't', user_id: 'u', chunk: silentChunk, audio: silentAudio,
    })).resolves.toEqual([]);
    expect(requestCount).toBe(0);
  });

  it('does not send inaudible PCM16 floor noise to ASR', async () => {
    const floorNoise = Buffer.alloc(16_000 * 2);
    for (let offset = 0; offset < floorNoise.length; offset += 2) {
      floorNoise.writeInt16LE(offset % 4 === 0 ? 1 : -1, offset);
    }
    const floorNoiseChunk: MeetingAudioChunk = {
      ...chunk,
      codec: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channel_count: 1,
      byte_length: floorNoise.length,
      checksum: `sha256:${createHash('sha256').update(floorNoise).digest('hex')}`,
    };
    let requestCount = 0;
    const provider = createOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'streaming-model',
      fetchImpl: async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ text: '噪声幻觉' }), { status: 200 });
      },
    });

    await expect(provider.transcribeChunk({
      tenant_id: 't', user_id: 'u', chunk: floorNoiseChunk, audio: floorNoise,
    })).resolves.toEqual([]);
    expect(requestCount).toBe(0);
  });

  it('wraps the realtime 16 kHz mono PCM16 baseline as a standard WAV upload', async () => {
    const pcm16Audio = Buffer.from([0, 0, 255, 127]);
    const pcm16Chunk: MeetingAudioChunk = {
      ...chunk,
      codec: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channel_count: 1,
      byte_length: pcm16Audio.length,
      checksum: `sha256:${createHash('sha256').update(pcm16Audio).digest('hex')}`,
    };
    const provider = createOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'streaming-model',
      fetchImpl: async (_input, init) => {
        const file = (init?.body as FormData).get('file') as File;
        const wav = Buffer.from(await file.arrayBuffer());
        expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(wav.readUInt16LE(20)).toBe(1);
        expect(wav.readUInt16LE(22)).toBe(1);
        expect(wav.readUInt32LE(24)).toBe(16_000);
        expect(wav.readUInt16LE(34)).toBe(16);
        expect(wav.subarray(44)).toEqual(pcm16Audio);
        return new Response(JSON.stringify({ text: '实时字幕' }), { status: 200 });
      },
    });

    await expect(provider.transcribeChunk({
      tenant_id: 't', user_id: 'u', chunk: pcm16Chunk, audio: pcm16Audio,
    })).resolves.toEqual([expect.objectContaining({ text: '实时字幕' })]);
  });

  it('maps verbose segments to stable provisional utterances on the meeting clock', async () => {
    const provider = createOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      apiKey: 'secret',
      model: 'streaming-model',
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
        const form = init?.body as FormData;
        expect(form.get('model')).toBe('streaming-model');
        const file = form.get('file') as File;
        expect(file).toBeInstanceOf(Blob);
        expect(file.type).toBe('audio/wav');
        expect(file.name).toBe('mic-00000002.wav');
        expect(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString('ascii')).toBe('RIFF');
        return new Response(JSON.stringify({ segments: [{ id: 7, start: 0.2, end: 1.7, text: ' 开始执行 ', avg_logprob: -0.1 }] }), { status: 200 });
      },
    });

    const first = await provider.transcribeChunk({ tenant_id: 't', user_id: 'u', chunk, audio });
    const replay = await provider.transcribeChunk({ tenant_id: 't', user_id: 'u', chunk, audio });

    expect(first).toEqual(replay);
    expect(first).toEqual([expect.objectContaining({
      session_id: 'session-1',
      track: 'mic',
      start_ms: 20_200,
      end_ms: 21_700,
      text: '开始执行',
      revision: 1,
      stability: 'provisional',
      source_chunk_ids: ['session-1:mic:2'],
    })]);
  });

  it('rejects non-speech, implausibly fast text and common subtitle hallucinations', async () => {
    const responses = [
      { segments: [{ id: 0, start: 0.1, end: 0.5, text: '空调声', avg_logprob: -0.1, no_speech_prob: 0.91 }] },
      { segments: [{ id: 0, start: 3.3, end: 3.6, text: '中文字幕志愿者 杨栋梁', avg_logprob: -0.11, no_speech_prob: 0 }] },
      { segments: [{ id: 0, start: 1, end: 2.6, text: '好好好好好好好好好好', avg_logprob: -0.03, no_speech_prob: 0 }] },
    ];
    const provider = createOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'streaming-model',
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    });

    for (let sequence = 0; sequence < 3; sequence += 1) {
      await expect(provider.transcribeChunk({
        tenant_id: 't',
        user_id: 'u',
        chunk: { ...chunk, sequence, chunk_id: `session-1:mic:${sequence}` },
        audio,
      })).resolves.toEqual([]);
    }
  });

  it('keeps one recognizer stream and revises the same utterance until endpoint', async () => {
    const texts = ['发布', '发布计划', '发布计划已经确认', '下一项'];
    let acceptedFrames = 0;
    let resetCount = 0;
    const stream = {
      acceptWaveform() { acceptedFrames += 1; },
      inputFinished() {},
    };
    const recognizer: SherpaOnlineRecognizer = {
      createStream: () => stream,
      isReady: () => false,
      decode() {},
      getResult: () => ({ text: texts[Math.min(acceptedFrames - 1, texts.length - 1)] }),
      isEndpoint: () => acceptedFrames === 3,
      reset() { resetCount += 1; },
    };
    const provider = createSherpaStreamingAsrProvider({
      createRecognizer: () => recognizer,
      frameDurationMs: 1_000,
      gate: { accepts: () => true, reset() {} },
    });
    const pcm = Buffer.alloc(16_000 * 2);
    const base = {
      ...chunk,
      codec: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channel_count: 1,
      byte_length: pcm.length,
    } as const;

    const first = await provider.transcribeChunk({
      tenant_id: 't', user_id: 'u',
      chunk: { ...base, sequence: 0, chunk_id: 'session-1:mic:0', start_monotonic_ms: 0, end_monotonic_ms: 1_000 },
      audio: pcm,
    });
    const second = await provider.transcribeChunk({
      tenant_id: 't', user_id: 'u',
      chunk: { ...base, sequence: 1, chunk_id: 'session-1:mic:1', start_monotonic_ms: 1_000, end_monotonic_ms: 2_000 },
      audio: pcm,
    });
    const endpoint = await provider.transcribeChunk({
      tenant_id: 't', user_id: 'u',
      chunk: { ...base, sequence: 2, chunk_id: 'session-1:mic:2', start_monotonic_ms: 2_000, end_monotonic_ms: 3_000 },
      audio: pcm,
    });
    const next = await provider.transcribeChunk({
      tenant_id: 't', user_id: 'u',
      chunk: { ...base, sequence: 3, chunk_id: 'session-1:mic:3', start_monotonic_ms: 3_000, end_monotonic_ms: 4_000 },
      audio: pcm,
    });

    expect(first).toEqual([expect.objectContaining({
      utterance_id: 'utt_session-1_mic_0',
      revision: 1,
      text: '发布',
    })]);
    expect(second).toEqual([expect.objectContaining({
      utterance_id: 'utt_session-1_mic_0',
      revision: 2,
      text: '发布计划',
      source_chunk_ids: ['session-1:mic:0', 'session-1:mic:1'],
    })]);
    expect(endpoint).toEqual([expect.objectContaining({
      utterance_id: 'utt_session-1_mic_0',
      revision: 3,
      text: '发布计划已经确认',
    })]);
    expect(next).toEqual([expect.objectContaining({
      utterance_id: 'utt_session-1_mic_1',
      revision: 1,
      text: '下一项',
    })]);
    expect(resetCount).toBe(1);
  });

  it('gates background noise before it reaches the decoder', async () => {
    let acceptedFrames = 0;
    const recognizer: SherpaOnlineRecognizer = {
      createStream: () => ({
        acceptWaveform() { acceptedFrames += 1; },
        inputFinished() {},
      }),
      isReady: () => false,
      decode() {},
      getResult: () => ({ text: '空调背景噪音' }),
      isEndpoint: () => false,
      reset() {},
    };
    const provider = createSherpaStreamingAsrProvider({
      createRecognizer: () => recognizer,
      frameDurationMs: 100,
      gate: { accepts: () => false, reset() {} },
    });
    const pcm = Buffer.alloc(16_000 * 2);

    const utterances = await provider.transcribeChunk({
      tenant_id: 't',
      user_id: 'u',
      chunk: {
        ...chunk,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence: 0,
        chunk_id: 'session-1:mic:0',
        start_monotonic_ms: 0,
        end_monotonic_ms: 1_000,
        byte_length: pcm.length,
      },
      audio: pcm,
    });

    expect(acceptedFrames).toBe(0);
    expect(utterances).toEqual([]);
  });

  it('accepts a client-gated 20 ms speech frame without requiring three server subframes', async () => {
    let acceptedFrames = 0;
    const recognizer: SherpaOnlineRecognizer = {
      createStream: () => ({
        acceptWaveform() { acceptedFrames += 1; },
        inputFinished() {},
      }),
      isReady: () => false,
      decode() {},
      getResult: () => ({ text: '实时' }),
      isEndpoint: () => false,
      reset() {},
    };
    const provider = createSherpaStreamingAsrProvider({
      createRecognizer: () => recognizer,
      frameDurationMs: 100,
    });
    const pcm = Buffer.alloc(320 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 7_000 : -7_000, offset);
    }

    const utterances = await provider.transcribeChunk({
      tenant_id: 't',
      user_id: 'u',
      speech_present: true,
      chunk: {
        ...chunk,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence: 0,
        chunk_id: 'session-1:mic:0',
        start_monotonic_ms: 0,
        end_monotonic_ms: 20,
        byte_length: pcm.length,
      },
      audio: pcm,
    } as Parameters<typeof provider.transcribeChunk>[0]);

    expect(acceptedFrames).toBe(1);
    expect(utterances).toEqual([expect.objectContaining({ text: '实时' })]);
  });

  it('advances through client-confirmed silence without decoding it or breaking the next speech revision', async () => {
    let acceptedFrames = 0;
    let resetCount = 0;
    const recognizer: SherpaOnlineRecognizer = {
      createStream: () => ({
        acceptWaveform() { acceptedFrames += 1; },
        inputFinished() {},
      }),
      isReady: () => false,
      decode() {},
      getResult: () => ({ text: acceptedFrames === 1 ? '开始' : '继续' }),
      isEndpoint: () => false,
      reset() { resetCount += 1; },
    };
    const provider = createSherpaStreamingAsrProvider({
      createRecognizer: () => recognizer,
      frameDurationMs: 100,
    });
    const speech = Buffer.alloc(320 * 2, 1);
    const input = (sequence: number, speechPresent: boolean) => ({
      tenant_id: 't',
      user_id: 'u',
      speech_present: speechPresent,
      chunk: {
        ...chunk,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence,
        chunk_id: 'session-1:mic:0',
        start_monotonic_ms: sequence * 20,
        end_monotonic_ms: (sequence + 1) * 20,
        byte_length: speechPresent ? speech.length : 0,
      },
      audio: speechPresent ? speech : Buffer.alloc(0),
    });

    await provider.transcribeChunk(input(0, true) as Parameters<typeof provider.transcribeChunk>[0]);
    await provider.transcribeChunk(input(1, false) as Parameters<typeof provider.transcribeChunk>[0]);
    const next = await provider.transcribeChunk(input(2, true) as Parameters<typeof provider.transcribeChunk>[0]);

    expect(acceptedFrames).toBe(2);
    expect(resetCount).toBe(1);
    expect(next).toEqual([expect.objectContaining({
      utterance_id: 'utt_session-1_mic_1',
      text: '继续',
    })]);
  });

  it('re-decodes ordered raw chunks into endpoint-delimited formal candidates', async () => {
    let acceptedFrames = 0;
    let finished = false;
    let resetCount = 0;
    const stream = {
      acceptWaveform() { acceptedFrames += 1; },
      inputFinished() { finished = true; },
    };
    const recognizer: SherpaOnlineRecognizer = {
      createStream: () => stream,
      isReady: () => false,
      decode() {},
      getResult: () => ({
        text: resetCount === 0 ? '正式转写已经重新收敛' : '第二个议题',
      }),
      isEndpoint: () => acceptedFrames === 2 && resetCount === 0,
      reset() { resetCount += 1; },
    };
    const converger = createSherpaFormalTranscriptConverger({
      createRecognizer: () => recognizer,
      frameDurationMs: 500,
      gate: { accepts: () => true, reset() {} },
    });
    const pcm = Buffer.alloc(16_000 * 2);
    const value = await converger.converge({
      session_id: 'session-1',
      chunks: [0, 1].map((sequence) => ({
        chunk: {
          ...chunk,
          codec: 'pcm_s16le' as const,
          sample_rate_hz: 16_000,
          channel_count: 1,
          sequence,
          chunk_id: `session-1:mic:${sequence}`,
          start_monotonic_ms: sequence * 1_000,
          end_monotonic_ms: (sequence + 1) * 1_000,
          byte_length: pcm.length,
        },
        loadAudio: async () => pcm,
      })),
    });

    expect(finished).toBe(true);
    expect(value).toEqual([
      expect.objectContaining({
        utterance_id: 'formal_session-1_mic_0',
        text: '正式转写已经重新收敛',
        source_chunk_ids: ['session-1:mic:0'],
      }),
      expect.objectContaining({
        utterance_id: 'formal_session-1_mic_1',
        text: '第二个议题',
        source_chunk_ids: ['session-1:mic:1'],
      }),
    ]);
  });

  it('stays explicitly unavailable when deployment configuration is incomplete', async () => {
    const provider = createConfiguredStreamingAsrProvider({});
    expect(provider.provider_id).toBe('unavailable');
    await expect(provider.transcribeChunk({ tenant_id: 't', user_id: 'u', chunk, audio })).rejects.toThrow('streaming_asr_provider_not_configured');
  });

  it('selects the local continuous Sherpa provider when configured', () => {
    const provider = createConfiguredStreamingAsrProvider({
      INKLOOP_STREAMING_ASR_PROVIDER: 'sherpa',
      INKLOOP_SHERPA_MODEL_DIR: '/missing-model',
    });
    expect(provider.provider_id).toContain('sherpa-onnx');
  });

  it('supports a trusted local OpenAI-compatible endpoint without an API key', async () => {
    const provider = createConfiguredStreamingAsrProvider({
      INKLOOP_STREAMING_ASR_URL: 'http://127.0.0.1:8081/inference',
      INKLOOP_STREAMING_ASR_MODEL: 'ggml-small',
      INKLOOP_STREAMING_ASR_LANGUAGE: 'zh',
      INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS: '4000',
      INKLOOP_STREAMING_ASR_REVISION_INTERVAL_MS: '4000',
    }, {
      fetchImpl: async (_input, init) => {
        expect(init?.headers).toBeUndefined();
        return new Response(JSON.stringify({ text: '本地实时转写' }), { status: 200 });
      },
    });

    const pcm = Buffer.alloc(4 * 16_000 * 2);
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(offset % 4 === 0 ? 4_000 : -4_000, offset);
    }
    const utterances = await provider.transcribeChunk({
      tenant_id: 't',
      user_id: 'u',
      chunk: {
        ...chunk,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        sequence: 0,
        chunk_id: 'session-1:mic:0',
        start_monotonic_ms: 0,
        end_monotonic_ms: 4_000,
        byte_length: pcm.length,
      },
      audio: pcm,
    });

    expect(provider.provider_id).toContain('127.0.0.1:8081');
    expect(utterances[0]?.text).toBe('本地实时转写');
  });

  it('configures the same OpenAI-compatible model for buffered realtime and raw formal convergence', () => {
    const env = {
      INKLOOP_STREAMING_ASR_URL: 'http://127.0.0.1:8081/inference',
      INKLOOP_STREAMING_ASR_MODEL: 'ggml-large-v3-turbo-q5_0',
      INKLOOP_STREAMING_ASR_LANGUAGE: 'zh',
    };

    expect(createConfiguredStreamingAsrProvider(env).provider_id).toContain('buffered');
    expect(createConfiguredFormalTranscriptConverger(env)?.converger_id)
      .toContain('ggml-large-v3-turbo-q5_0');
  });

  it('forwards cancellation to the underlying ASR HTTP request', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const provider = createOpenAICompatibleStreamingAsrProvider({
      endpoint: 'https://asr.test/v1/audio/transcriptions',
      model: 'streaming-model',
      fetchImpl: async (_input, init) => {
        receivedSignal = init?.signal;
        return new Response(JSON.stringify({ text: '' }), { status: 200 });
      },
    });
    const controller = new AbortController();

    await provider.transcribeChunk({ tenant_id: 't', user_id: 'u', chunk, audio }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });
});

describe('streaming ASR provider lifecycle', () => {
  it('disposes every unique provider once when a session is finalized', async () => {
    let sharedDisposals = 0;
    let fallbackDisposals = 0;
    const shared: StreamingAsrProvider = {
      provider_id: 'shared',
      async transcribeChunk() { return []; },
      disposeSession() { sharedDisposals += 1; },
    };
    const fallback: StreamingAsrProvider = {
      provider_id: 'fallback',
      async transcribeChunk() { return []; },
      disposeSession() { fallbackDisposals += 1; },
    };
    const router = new StreamingAsrProviderRouter(
      { mic: shared, remote: shared },
      fallback,
    );

    await router.disposeSession({
      tenant_id: 'tenant',
      user_id: 'user',
      session_id: 'session-1',
    });

    expect(sharedDisposals).toBe(1);
    expect(fallbackDisposals).toBe(1);
  });
});
