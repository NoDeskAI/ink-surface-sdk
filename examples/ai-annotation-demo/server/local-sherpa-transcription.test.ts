import { describe, expect, it } from 'vitest';
import { isUsableFinalUtterance, resampleForSherpa, resolveParaformerFilesFromList, verifiedFinalText } from './local-sherpa-transcription';

describe('local sherpa streaming transcription', () => {
  it('selects the int8 bilingual Paraformer pair from one model directory', () => {
    expect(resolveParaformerFilesFromList('/models', [
      '/models/paraformer/encoder.onnx', '/models/paraformer/decoder.onnx',
      '/models/paraformer/encoder.int8.onnx', '/models/paraformer/decoder.int8.onnx', '/models/paraformer/tokens.txt',
    ])).toEqual({
      encoder: '/models/paraformer/encoder.int8.onnx', decoder: '/models/paraformer/decoder.int8.onnx', tokens: '/models/paraformer/tokens.txt',
    });
  });

  it('rejects a parent containing multiple complete models', () => {
    expect(() => resolveParaformerFilesFromList('/models', [
      '/models/a/encoder.onnx', '/models/a/decoder.onnx', '/models/a/tokens.txt',
      '/models/b/encoder.onnx', '/models/b/decoder.onnx', '/models/b/tokens.txt',
    ])).toThrow('sherpa_model_ambiguous');
  });

  it('resamples browser audio to the 16 kHz model rate', () => {
    const source = Float32Array.from({ length: 48_000 }, (_, index) => Math.sin(index / 20));
    const output = resampleForSherpa(source, 48_000);
    expect(output).toHaveLength(16_000);
    expect(Number.isFinite(output[10])).toBe(true);
  });

  it('uses whole-utterance verification only for final text and falls back safely', () => {
    expect(verifiedFinalText('你在做什', '你在做什么', true)).toBe('你在做什么');
    expect(verifiedFinalText('拜', '拜拜', true)).toBe('拜拜');
    expect(verifiedFinalText('hello hello hel', 'Hello, hello, hello.', true)).toBe('Hello, hello, hello.');
    expect(verifiedFinalText('你好', '', true)).toBe('你好');
    expect(verifiedFinalText('实时临时字幕', '不应提前替换', false)).toBe('实时临时字幕');
    expect(verifiedFinalText('喂喂喂', 'おはようございます。', true)).toBe('喂喂喂');
    expect(verifiedFinalText('你好', '[몇일이 없음]', true)).toBe('你好');
    expect(verifiedFinalText('hello hello hel', '我去找你了', true)).toBe('hello hello hel');
    expect(verifiedFinalText('你好你', '尿尿', true)).toBe('你好你');
    expect(verifiedFinalText('今天我们学习方程', '今天我们学习一元二次方程。', true)).toBe('今天我们学习方程');
  });

  it('rejects near-silent and subtitle-credit hallucinations before publishing a final subtitle', () => {
    const nearSilence = Float32Array.from({ length: 48_000 }, (_, index) => Math.sin(index / 7) * 0.0015);
    const speechLike = Float32Array.from({ length: 48_000 }, (_, index) => Math.sin(index / 11) * (index % 1600 < 900 ? 0.045 : 0.004));

    expect(isUsableFinalUtterance(nearSilence, '( 字幕:J Chong )')).toBe(false);
    expect(isUsableFinalUtterance(speechLike, '( 字幕:J Chong )')).toBe(false);
    expect(isUsableFinalUtterance(speechLike, '( ˘ω˘ )')).toBe(false);
    expect(isUsableFinalUtterance(speechLike, '(拍摄)')).toBe(false);
    expect(isUsableFinalUtterance(speechLike, '（咱们先进去）')).toBe(false);
    expect(isUsableFinalUtterance(speechLike, '今天我们学习一元二次方程')).toBe(true);
    expect(isUsableFinalUtterance(speechLike, 'Let us solve this equation.')).toBe(true);
  });
});
