import { describe, expect, it } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, CLASSROOM_WORLD_GEOMETRY_VERSION, type ClassroomBoardEvent, type ClassroomMaterial } from 'ink-surface-sdk/runtime-schema';
import { eventBBox, eventPoints, normBoxToWorld, worldBoxToNorm } from './classroom-spatial';

const material: ClassroomMaterial = {
  schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom', material_id: 'material', title: 'Math', mime_type: 'application/pdf',
  byte_size: 1, content_hash: `sha256:${'a'.repeat(64)}`, page_count: 1, page_geometries: [{ page_index: 0, width_world: 600, height_world: 800, rotation: 0 }],
  source: 'builtin', published_at: '2026-07-20T00:00:00.000Z',
};

describe('classroom spatial compatibility', () => {
  it('round-trips normalized textbook boxes through the page world', () => {
    const box = [0.1, 0.2, 0.5, 0.25] as const;
    const world = normBoxToWorld([...box], material.page_geometries![0]);
    expect(world).toEqual([-240, -240, 300, 200]);
    expect(worldBoxToNorm(world, material.page_geometries![0])).toEqual(box);
  });

  it('reads legacy and world records without changing shared Ink contracts', () => {
    const legacy = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom', sequence: 1, client_event_id: 'legacy', accepted_at: 'now',
      surface: { kind: 'textbook_page', material_id: 'material', page_index: 0 },
      event: { event_id: 'ink', trace_id: 'trace', session_id: 'classroom', surface_id: 'page', pen_id: 'teacher', event_type: 'stroke', stroke_refs: ['stroke'], bbox_norm: [0, 0, 1, 1], ts_start_ms: 1, ts_end_ms: 2, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 } },
      stroke: { stroke_id: 'stroke', session_id: 'classroom', surface_id: 'page', pen_id: 'teacher', points: [{ x_norm: 0, y_norm: 0, t_ms: 1 }, { x_norm: 1, y_norm: 1, t_ms: 2 }], bbox_norm: [0, 0, 1, 1], ts_start_ms: 1, ts_end_ms: 2 },
    } as ClassroomBoardEvent;
    expect(eventBBox(legacy, material)).toEqual([-300, -400, 600, 800]);
    expect(eventPoints(legacy, material).map(({ x_world, y_world }) => [x_world, y_world])).toEqual([[-300, -400], [300, 400]]);

    const world = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom', sequence: 2, client_event_id: 'world', accepted_at: 'now', geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION,
      surface: { kind: 'textbook_page', material_id: 'material', page_index: 0 },
      event: { event_id: 'ink_world', trace_id: 'trace', session_id: 'classroom', surface_id: 'page', pen_id: 'teacher', event_type: 'stroke', stroke_refs: ['stroke_world'], bbox_world: [320, 0, 50, 20], ts_start_ms: 3, ts_end_ms: 4, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 } },
      stroke: { stroke_id: 'stroke_world', session_id: 'classroom', surface_id: 'page', pen_id: 'teacher', points_world: [{ x_world: 320, y_world: 0, t_ms: 3 }, { x_world: 370, y_world: 20, t_ms: 4 }], bbox_world: [320, 0, 50, 20], ts_start_ms: 3, ts_end_ms: 4 },
    } as ClassroomBoardEvent;
    expect(eventBBox(world, material)).toEqual([320, 0, 50, 20]);
  });
});
