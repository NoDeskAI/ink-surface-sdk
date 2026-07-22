import { describe, expect, it } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomBoardEvent, type ClassroomRecognitionRevision, type ClassroomSurfaceRef } from 'ink-surface-sdk/runtime-schema';
import { groupRecentFormulaEvents, latestRecognitionProjection, recognitionTrustLabel, remainingRecognitionIdleDelay, renderRecognitionCrop, shouldShowRecognitionLatex } from './classroom-recognition-client';

function event(id: string, x: number, y: number, start: number, surface: ClassroomSurfaceRef): ClassroomBoardEvent {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom', sequence: start, client_event_id: id, accepted_at: new Date(start).toISOString(), surface,
    event: { event_id: id, trace_id: `trace_${id}`, session_id: 'classroom', surface_id: 'surface', pen_id: 'teacher', event_type: 'stroke', stroke_refs: [`stroke_${id}`], bbox_norm: [x, y, 0.08, 0.04], ts_start_ms: start, ts_end_ms: start + 100, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' } },
    stroke: { stroke_id: `stroke_${id}`, session_id: 'classroom', surface_id: 'surface', pen_id: 'teacher', points: [{ x_norm: x, y_norm: y, t_ms: start }], bbox_norm: [x, y, 0.08, 0.04], ts_start_ms: start, ts_end_ms: start + 100 },
  };
}

function worldEvent(id: string, box: [number, number, number, number], start: number, surface: ClassroomSurfaceRef): ClassroomBoardEvent {
  const value = event(id, 0, 0, start, surface);
  return {
    ...value,
    geometry_version: 'classroom_page_world_v1',
    event: { ...value.event, bbox_world: box },
    stroke: { ...value.stroke, points_world: [{ x_world: box[0], y_world: box[1], t_ms: start }], bbox_world: box },
  } as ClassroomBoardEvent;
}

describe('classroom recognition client helpers', () => {
  it('waits only for the remaining handwriting idle window', () => {
    expect(remainingRecognitionIdleDelay(1_000, 1_500)).toBe(1_100);
    expect(remainingRecognitionIdleDelay(1_000, 3_000)).toBe(0);
  });
  it('groups slow writing on one line while excluding another line and surface', () => {
    const page = { kind: 'textbook_page' as const, material_id: 'math', page_index: 0 };
    const events = [
      event('other-line', 0.1, 0.2, 1_000, page),
      event('x', 0.1, 0.5, 4_000, page),
      event('plus', 0.25, 0.51, 8_000, page),
      event('scratch', 0.4, 0.5, 8_500, { kind: 'scratch', scratch_id: 'scratch_1' }),
      event('two', 0.4, 0.49, 12_000, page),
    ];
    expect(groupRecentFormulaEvents(events, { surface: page, timeWindowMs: 6_000 })).toMatchObject({ event_ids: ['x', 'plus', 'two'], surface: page });
  });

  it('never groups across textbook pages or a long pause', () => {
    const first = { kind: 'textbook_page' as const, material_id: 'math', page_index: 0 };
    const second = { ...first, page_index: 1 };
    expect(groupRecentFormulaEvents([event('old', 0.1, 0.5, 1_000, first), event('new', 0.2, 0.5, 20_000, first)])?.event_ids).toEqual(['new']);
    expect(groupRecentFormulaEvents([event('p1', 0.1, 0.5, 1_000, first), event('p2', 0.2, 0.5, 2_000, second)])?.event_ids).toEqual(['p2']);
  });

  it('does not include strokes that were already recognized', () => {
    const page = { kind: 'textbook_page' as const, material_id: 'math', page_index: 0 };
    const events = [event('done', 0.1, 0.5, 1_000, page), event('new', 0.2, 0.5, 2_000, page)];
    expect(groupRecentFormulaEvents(events, { surface: page, excludedEventIds: new Set(['done']) })?.event_ids).toEqual(['new']);
  });

  it('ignores highlighter strokes when building a formula group', () => {
    const page = { kind: 'textbook_page' as const, material_id: 'math', page_index: 0 };
    const pen = event('pen', 0.1, 0.5, 1_000, page);
    const highlighter = event('highlight', 0.2, 0.5, 2_000, page);
    highlighter.event.metadata = { ...highlighter.event.metadata, tool: 'highlighter' };
    expect(groupRecentFormulaEvents([pen, highlighter], { surface: page })?.event_ids).toEqual(['pen']);
  });

  it('keeps a multi-height formula together when its last stroke is a baseline mark', () => {
    const page = { kind: 'textbook_page' as const, material_id: 'math', page_index: 13 };
    const boxes: Array<[number, number, number, number]> = [
      [16.38, -107.58, 18.74, 29.52], [16.38, -105.07, 27.49, 22.88], [52.85, -94.89, 24.99, 1.75],
      [63.70, -105.05, 0.16, 22.02], [83.76, -110.52, 16.84, 28.43], [117.31, -96.40, 22.18, 0.64],
      [122.01, -82.96, 19.37, 0.01], [153.19, -92.13, 14.06, 0.79], [162.48, -107.38, 0.01, 25.15],
      [155.96, -80.52, 16.71, 0.16], [178.88, -108.33, 28.29, 0.16],
    ];
    const events = boxes.map((box, index) => worldEvent(`formula-${index}`, box, 1_000 + index * 550, page));
    expect(groupRecentFormulaEvents(events, { surface: page, timeWindowMs: 15_000 })?.event_ids).toEqual(events.map((item) => item.event.event_id));
  });

  it('projects append-only revisions into a latest trust state', () => {
    const base = { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom', recognition_id: 'recognition_1', kind: 'formula' as const, text: 'x=+2', confidence: 0.5, provider: 'fixture', processing_mode: 'local' as const, event_ids: ['ink'], surface: { kind: 'teacher_board' as const }, bbox_norm: [0, 0, 0.2, 0.1] as [number, number, number, number] };
    const pending = { ...base, revision: 1, status: 'pending' as const, created_at: '2026-07-19T00:00:00.000Z' } satisfies ClassroomRecognitionRevision;
    const corrected = { ...base, revision: 2, status: 'corrected' as const, text: 'x=±2', original_revision: 1, created_at: '2026-07-19T00:01:00.000Z', reviewed_at: '2026-07-19T00:01:00.000Z' } satisfies ClassroomRecognitionRevision;
    expect(latestRecognitionProjection([pending, corrected])).toEqual([corrected]);
    expect(recognitionTrustLabel(pending)).toContain('待老师确认');
    expect(recognitionTrustLabel(corrected)).toBe('老师已更正并确认');
  });

  it('hides a duplicate LaTeX line but keeps structurally different LaTeX', () => {
    expect(shouldShowRecognitionLatex('y=（k-2）x+k-2', 'y=(k-2)x+k-2')).toBe(false);
    expect(shouldShowRecognitionLatex('二分之一', '\\frac{1}{2}')).toBe(true);
  });

  it('renders only selected events into a white PNG crop', () => {
    const page = { kind: 'textbook_page' as const, material_id: 'math', page_index: 0 };
    const context = { fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '', fillRect: () => undefined, beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined, stroke: () => undefined };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,AAAA' };
    const fakeDocument = { createElement: () => canvas } as unknown as Document;
    const selected = event('selected', 0.1, 0.5, 1_000, page); const ignored = event('ignored', 0.8, 0.1, 2_000, page);
    expect(renderRecognitionCrop([selected, ignored], { event_ids: ['selected'], surface: page, bbox_norm: [0.08, 0.48, 0.12, 0.08] }, fakeDocument)).toBe('data:image/png;base64,AAAA');
    expect(canvas).toMatchObject({ width: 960, height: 240 });
  });
});
