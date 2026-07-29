import { describe, expect, it } from 'vitest';
import { analyzePcm16Mono, normalizedEditRatio, parseMeetingAsrDiagnosticArgs } from './diagnose-meeting-asr';

describe('meeting ASR diagnostics', () => {
  it('reports PCM16 silence and clipping without claiming recognition accuracy', () => {
    const silence = Buffer.alloc(16_000 * 2);
    expect(analyzePcm16Mono(silence)).toMatchObject({
      duration_ms: 1_000,
      sample_count: 16_000,
      zero_sample_ratio: 1,
      clipping_sample_ratio: 0,
      rms_dbfs: -90.31,
    });

    const clipped = Buffer.alloc(4);
    clipped.writeInt16LE(32_767, 0);
    clipped.writeInt16LE(-32_768, 2);
    expect(analyzePcm16Mono(clipped, 2)).toMatchObject({
      duration_ms: 1_000,
      zero_sample_ratio: 0,
      clipping_sample_ratio: 1,
      peak_dbfs: 0,
    });
  });

  it('uses normalized model disagreement rather than labeling it CER or WER', () => {
    expect(normalizedEditRatio('硬件难度下降。', '硬件的难度下降')).toBeCloseTo(1 / 7);
    expect(normalizedEditRatio('', '')).toBe(0);
    expect(normalizedEditRatio('', '有人说话')).toBe(1);
  });

  it('rejects unknown, duplicate, and missing-value flags', () => {
    expect(() => parseMeetingAsrDiagnosticArgs(['--session', 's', '--widnows', '4000']))
      .toThrow('unknown_argument:--widnows');
    expect(() => parseMeetingAsrDiagnosticArgs(['--session', 's', '--session', 's2']))
      .toThrow('duplicate_argument:--session');
    expect(() => parseMeetingAsrDiagnosticArgs(['--session', '--out', 'report.json']))
      .toThrow('missing_value:--session');
  });
});
