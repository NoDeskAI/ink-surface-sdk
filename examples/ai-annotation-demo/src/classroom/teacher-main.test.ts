import { describe, expect, it } from 'vitest';
import { compactStrokePoints, mergeBoardEvent, pointerSamples, previewWindow, shouldCommitCancelledStroke, strokeBoundingBox, teacherLessonErrorMessage } from './teacher-main';

describe('teacher classroom stroke helpers', () => {
  it('explains why LessonGraph generation is blocked instead of failing silently', () => {
    expect(teacherLessonErrorMessage(new Error('insufficient_evidence'))).toBe('板书证据不足，至少完成几笔有效板书后再生成课堂候选。');
    expect(teacherLessonErrorMessage(new Error('untrusted_formula_evidence'))).toContain('请先完成公式审核');
    expect(teacherLessonErrorMessage(new Error('gateway_unavailable'))).toBe('课堂候选生成失败：gateway_unavailable');
  });

  it('builds a normalized bounding box for a completed stroke', () => {
    expect(strokeBoundingBox([
      { x_norm: 0.8, y_norm: 0.1, t_ms: 1 },
      { x_norm: 0.2, y_norm: 0.7, t_ms: 2 },
    ])).toEqual([0.2, 0.1, 0.6000000000000001, 0.6]);
  });

  it('keeps a bounded cumulative preview instead of sending only a moving tail', () => {
    const points = Array.from({ length: 300 }, (_, index) => ({ x_norm: index / 300, y_norm: 0.5, t_ms: index }));
    expect(previewWindow(points)).toHaveLength(256);
    expect(previewWindow(points)[0].t_ms).toBe(44);
    expect(previewWindow(points).at(-1)?.t_ms).toBe(299);
  });

  it('compacts a very long stroke while preserving both endpoints', () => {
    const points = Array.from({ length: 9_000 }, (_, index) => ({ x_norm: index / 9_000, y_norm: 0.5, t_ms: index }));
    const compacted = compactStrokePoints(points);
    expect(compacted).toHaveLength(4_096);
    expect(compacted[0]).toEqual(points[0]);
    expect(compacted.at(-1)).toEqual(points.at(-1));
  });

  it('keeps committed board events in server sequence order when HTTP responses arrive out of order', () => {
    const event = (sequence: number) => ({ sequence, event: { event_id: `ink_${sequence}` } }) as never;
    expect(mergeBoardEvent([event(1), event(3)], event(2)).map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(mergeBoardEvent([event(1), event(2)], event(2))).toHaveLength(2);
  });

  it('falls back to the pointer event when a browser returns no coalesced samples', () => {
    const event = { x: 1, getCoalescedEvents: () => [] as typeof event[] };
    expect(pointerSamples(event)).toEqual([event]);
    const sample = { x: 2 };
    expect(pointerSamples({ x: 1, getCoalescedEvents: () => [sample] })).toEqual([sample]);
  });

  it('preserves a sampled pen stroke when iPadOS ends it with pointercancel', () => {
    expect(shouldCommitCancelledStroke(1)).toBe(false);
    expect(shouldCommitCancelledStroke(2)).toBe(true);
    expect(shouldCommitCancelledStroke(120)).toBe(true);
  });
});
