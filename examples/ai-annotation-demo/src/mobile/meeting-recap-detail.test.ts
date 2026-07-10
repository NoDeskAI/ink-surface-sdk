import { describe, expect, it } from 'vitest';
import type { TranscriptCue } from '../integration/panel-feishu/align';
import { selectInkPageTranscriptCues } from './meeting-recap';

function cue(index: number, startS: number): TranscriptCue {
  return {
    index,
    startMs: startS * 1000,
    endMs: (startS + 5) * 1000,
    speaker: `说话人 ${index}`,
    text: `第 ${index} 句`,
    rawText: `说话人 ${index}: 第 ${index} 句`,
  };
}

describe('meeting recap detail transcript selection', () => {
  it('uses the ink page time window when meeting ink timestamps are plausible', () => {
    const t0 = 1_000_000;
    const cues = Array.from({ length: 20 }, (_, i) => cue(i + 1, i * 10));

    const selected = selectInkPageTranscriptCues({
      cues,
      marks: [{ abs_timestamp: t0 + 95_000 }, { abs_timestamp: t0 + 106_000 }],
      pageIndex: 0,
      totalPages: 4,
      t0AbsMs: t0,
      offsetMs: 0,
      limit: 4,
    });

    expect(selected.source).toBe('time');
    expect(selected.meta).toContain('约对齐');
    expect(selected.cues.map((c) => c.index)).toEqual([9, 10, 11, 12]);
  });

  it('falls back to handwrite page order when device timestamps cannot align to the transcript', () => {
    const t0 = 1_000_000;
    const cues = Array.from({ length: 12 }, (_, i) => cue(i + 1, i * 10));

    const selected = selectInkPageTranscriptCues({
      cues,
      marks: [{ abs_timestamp: t0 - 7 * 24 * 3600_000 }],
      pageIndex: 2,
      totalPages: 4,
      t0AbsMs: t0,
      offsetMs: 0,
      limit: 3,
    });

    expect(selected.source).toBe('page_order');
    expect(selected.meta).toContain('按手写页序近似');
    expect(selected.cues.map((c) => c.index)).toEqual([7, 8, 9]);
  });
});
