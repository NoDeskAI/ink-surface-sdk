import { describe, expect, it } from 'vitest';
import {
  CLASSROOM_WORLD_GEOMETRY_VERSION,
  CLASSROOM_SCHEMA_VERSION,
  type ClassroomBoardEvent,
  type ClassroomConfirmedFocus,
  type ClassroomMaterial,
  type ClassroomRecognitionRevision,
  type ClassroomSnapshot,
  type ClassroomTimelineEntry,
  type ClassroomTranscriptRevision,
  type RuntimeNormBBox,
} from 'ink-surface-sdk/runtime-schema';
import { buildClassroomEvidenceBundle } from './classroom-evidence';

const classroomId = 'classroom_evidence';
const materialId = 'builtin_completing_square';

function event(order: number, bbox_norm: RuntimeNormBBox, time: number): ClassroomBoardEvent {
  const id = `ink_formula_0${order}`;
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, sequence: order, client_event_id: `client_${order}`,
    accepted_at: `2026-07-20T00:00:0${order}.000Z`, surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 },
    event: {
      event_id: id, trace_id: `trace_${order}`, session_id: classroomId, surface_id: 'textbook', pen_id: 'teacher',
      event_type: 'stroke', stroke_refs: [`stroke_${order}`], bbox_norm, ts_start_ms: time, ts_end_ms: time + 500,
      source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' },
    },
    stroke: {
      stroke_id: `stroke_${order}`, session_id: classroomId, surface_id: 'textbook', pen_id: 'teacher',
      points: [{ x_norm: bbox_norm[0], y_norm: bbox_norm[1], t_ms: time }], bbox_norm, ts_start_ms: time, ts_end_ms: time + 500,
    },
  };
}

function worldEvent(id: string, sequence: number, bbox: [number, number, number, number]): ClassroomBoardEvent {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, sequence, client_event_id: `client_${id}`, accepted_at: '2026-07-20T00:00:00Z',
    geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 },
    event: { event_id: id, trace_id: `trace_${id}`, session_id: classroomId, surface_id: 'page', pen_id: 'teacher', event_type: 'stroke', stroke_refs: [`stroke_${id}`], bbox_world: bbox, ts_start_ms: 10_000 + sequence, ts_end_ms: 10_500 + sequence, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' } },
    stroke: { stroke_id: `stroke_${id}`, session_id: classroomId, surface_id: 'page', pen_id: 'teacher', points_world: [{ x_world: bbox[0], y_world: bbox[1], t_ms: 10_000 + sequence }], bbox_world: bbox, ts_start_ms: 10_000 + sequence, ts_end_ms: 10_500 + sequence },
  };
}

function recognition(order: number, status: ClassroomRecognitionRevision['status'] = 'corrected'): ClassroomRecognitionRevision {
  const rows = [
    ['x² + 4x - 5 = 0', 'x^2+4x-5=0'],
    ['x² + 4x = 5', 'x^2+4x=5'],
    ['x² + 4x + 4 = 9', 'x^2+4x+4=9'],
    ['(x + 2)² = 9', '(x+2)^2=9'],
    ['x + 2 = ±3', 'x+2=\\pm3'],
  ];
  const source = rows[order - 1];
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, recognition_id: `recognition_${order}`, revision: 2,
    status, kind: 'formula', text: source[0], latex: source[1], confidence: 1, provider: 'fixture', processing_mode: 'local',
    event_ids: [`ink_formula_0${order}`], surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 },
    bbox_norm: [0.12, 0.18 + (order - 1) * 0.11, 0.5, 0.07], original_revision: 1,
    created_at: `2026-07-20T00:00:1${order}.000Z`, reviewed_at: `2026-07-20T00:00:1${order}.000Z`,
  };
}

function transcript(id: number, start: number, end: number, text: string, status: ClassroomTranscriptRevision['status'] = 'corrected'): ClassroomTranscriptRevision {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, transcript_id: `transcript_${id}`, revision: status === 'corrected' ? 2 : 1,
    status, recording_id: 'recording_1', recording_generation: 1, chunk_id: `chunk_${id}`,
    chunk_hash: `sha256:${String(id).padStart(64, '0')}`, relative_start_ms: start, relative_end_ms: end, text,
    confidence: status === 'provisional' ? 0.5 : 1, language: 'zh-CN', provider: 'fixture', processing_mode: 'local',
    ...(status === 'corrected' ? { original_revision: 1, corrected_at: `2026-07-20T00:00:2${id}.000Z` } : {}),
    created_at: `2026-07-20T00:00:2${id}.000Z`,
  };
}

function fixture(overrides: Partial<ClassroomSnapshot> = {}): ClassroomSnapshot {
  const boxes: RuntimeNormBBox[] = [
    [0.12, 0.18, 0.48, 0.07], [0.12, 0.29, 0.40, 0.07], [0.12, 0.40, 0.50, 0.07],
    [0.12, 0.51, 0.38, 0.07], [0.12, 0.62, 0.40, 0.07],
  ];
  const material: ClassroomMaterial = {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, material_id: materialId,
    title: '配方法：把二次方程变成完全平方', mime_type: 'application/pdf', byte_size: 1_024,
    content_hash: `sha256:${'a'.repeat(64)}`, page_count: 1, source: 'builtin', published_at: '2026-07-20T00:00:00.000Z',
  };
  const focus: ClassroomConfirmedFocus = {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, focus_id: 'focus_step_2', material_id: materialId,
    page_index: 0, bbox_norm: boxes[1], confirmed_at: '2026-07-20T00:00:02.500Z',
  };
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, classroom_status: 'live', snapshot_sequence: 5,
    board_events: boxes.map((bbox, index) => event(index + 1, bbox, 10_000 + index * 10_000)),
    capabilities: { textbook: true, recognition: true, audio: true, transcript: true }, timeline_sequence: 12,
    materials: [material], teacher_view: {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, material_id: materialId, page_index: 0,
      zoom_mode: 'fit-width', zoom_percent: 100, active_surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 },
      revision: 1, updated_at: '2026-07-20T00:00:01.000Z',
    },
    confirmed_focus: focus, recognitions: [1, 2, 3, 4, 5].map((order) => recognition(order)),
    transcripts: [
      transcript(1, 8_000, 12_000, '先把常数项移到右边'),
      transcript(2, 18_000, 22_000, '接着在等式两边同时加四'),
      transcript(3, 38_000, 42_000, '然后写成完全平方'),
      transcript(4, 48_000, 52_000, '最后两边开平方得到正负三'),
    ], generated_at: '2026-07-20T00:01:00.000Z', ...overrides,
  };
}

describe('buildClassroomEvidenceBundle', () => {
  it('builds the current confirmed step without leaking future formulas or transcripts', () => {
    const bundle = buildClassroomEvidenceBundle({ snapshot: fixture(), intent: 'current_step' });

    expect(bundle.material).toMatchObject({ material_id: materialId, page_index: 0, bbox_norm: [0.12, 0.29, 0.40, 0.07] });
    expect(bundle.events.map((item) => item.event.event_id)).toEqual(['ink_formula_02']);
    expect(bundle.recognitions.map((item) => item.text)).toEqual(['x² + 4x = 5']);
    expect(bundle.transcripts.map((item) => item.text)).toEqual(['接着在等式两边同时加四']);
    expect(JSON.stringify(bundle)).not.toContain('x + 2 = ±3');
    expect(bundle.trust_status).toBe('trusted');
    expect(bundle.checkpoint.evidence_revision_fingerprint).toBe(bundle.fingerprint);
    expect(new Set(bundle.source_refs.map((ref) => ref.type))).toEqual(new Set(['material_page', 'ink_event', 'audio_segment']));
  });

  it('aligns recording-relative subtitles with absolute board timestamps', () => {
    const recordingStart = Date.parse('2026-07-20T08:00:00.000Z');
    const snapshot = fixture({
      board_events: [event(1, [0.12, 0.18, 0.48, 0.07], recordingStart + 10_000)],
      snapshot_sequence: 1,
      confirmed_focus: { ...fixture().confirmed_focus!, bbox_norm: [0.12, 0.18, 0.48, 0.07] },
      recognitions: [recognition(1)],
      transcripts: [transcript(1, 8_000, 12_000, '先把常数项移到右边')],
    });
    const timeline: ClassroomTimelineEntry[] = [{
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: 1,
      kind: 'recording_state', occurred_at: '2026-07-20T08:00:00.000Z',
      recording: {
        recording_id: 'recording_1', classroom_id: classroomId, classroom_generation: 1, recording_generation: 1,
        state: 'recording', health: 'healthy', chunk_count: 0, byte_count: 0, last_sequence: 0,
        last_relative_end_ms: 0, started_at: '2026-07-20T08:00:00.000Z',
      },
    }];

    const bundle = buildClassroomEvidenceBundle({ snapshot, timeline, intent: 'current_step' });
    expect(bundle.transcripts.map((item) => item.text)).toEqual(['先把常数项移到右边']);
    expect(bundle.missing_sources).not.toContain('trusted_transcript');
  });

  it('uses an explicit selected region instead of falling back to the whole page', () => {
    const bundle = buildClassroomEvidenceBundle({ snapshot: fixture(), intent: 'selected_region', selection_bbox_norm: [0.1, 0.49, 0.45, 0.11] });
    expect(bundle.recognitions.map((item) => item.text)).toEqual(['(x + 2)² = 9']);
    expect(bundle.events.map((item) => item.event.event_id)).toEqual(['ink_formula_04']);
    expect(bundle.material?.bbox_norm).toEqual([0.1, 0.49, 0.45, 0.11]);
  });

  it('keeps world board refs exact and derives material refs only for the page intersection', () => {
    const snapshot = fixture({
      board_events: [worldEvent('inside', 1, [-240, -300, 120, 80]), worldEvent('outside', 2, [360, -20, 140, 80])], snapshot_sequence: 2,
      materials: [{ ...fixture().materials![0], page_geometries: [{ page_index: 0, width_world: 600, height_world: 800, rotation: 0 }] }],
      recognitions: [], transcripts: [], confirmed_focus: undefined,
    });
    const inside = buildClassroomEvidenceBundle({ snapshot, intent: 'selected_region', selection_region: { coordinate_space: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 }, bbox_world: [-260, -320, 180, 120] } });
    expect(inside.events.map((item) => item.event.event_id)).toEqual(['inside']);
    expect(inside.material?.bbox_norm).toEqual([40 / 600, 80 / 800, 180 / 600, 120 / 800]);
    expect(inside.source_refs.find((ref) => ref.type === 'ink_event')).toMatchObject({ spatial_region: { bbox_world: [-240, -300, 120, 80] } });

    const outside = buildClassroomEvidenceBundle({ snapshot, intent: 'selected_region', selection_region: { coordinate_space: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 }, bbox_world: [350, -40, 180, 140] } });
    expect(outside.events.map((item) => item.event.event_id)).toEqual(['outside']);
    expect(outside.material).toMatchObject({ material_id: materialId, page_index: 0 });
    expect(outside.material?.bbox_norm).toBeUndefined();
    expect(outside.source_refs.find((ref) => ref.type === 'material_page')).not.toHaveProperty('bbox_norm');
  });

  it('bounds a missed segment to 60 seconds and starts at the latest focus boundary', () => {
    const snapshot = fixture();
    const timeline: ClassroomTimelineEntry[] = [
      { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: 1, kind: 'board_event_ref', occurred_at: 'now', board_sequence: 1, event_id: 'ink_formula_01', surface: snapshot.board_events[0].surface! },
      { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: 2, kind: 'confirmed_focus', occurred_at: 'now', confirmed_focus: { ...snapshot.confirmed_focus!, focus_id: 'focus_boundary' } },
      { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: 3, kind: 'board_event_ref', occurred_at: 'now', board_sequence: 2, event_id: 'ink_formula_02', surface: snapshot.board_events[1].surface! },
      ...snapshot.board_events.slice(2).map((item, index): ClassroomTimelineEntry => ({ schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: index + 4, kind: 'board_event_ref', occurred_at: 'now', board_sequence: item.sequence, event_id: item.event.event_id, surface: item.surface! })),
    ];
    const bundle = buildClassroomEvidenceBundle({ snapshot, timeline, intent: 'missed_segment', trigger_time_ms: 55_000 });
    expect(bundle.checkpoint.time_start_ms).toBe(20_000);
    expect(bundle.checkpoint.time_end_ms).toBe(55_000);
    expect(bundle.events.map((item) => item.event.event_id)).toEqual(['ink_formula_02', 'ink_formula_03', 'ink_formula_04', 'ink_formula_05']);
  });

  it('marks unreviewed math and provisional-only speech as untrusted for post-class output', () => {
    const snapshot = fixture({
      classroom_status: 'ended',
      recognitions: [recognition(1), recognition(2, 'pending')],
      transcripts: [transcript(1, 8_000, 12_000, '临时字幕', 'provisional')],
      snapshot_sequence: 2,
      board_events: fixture().board_events.slice(0, 2),
    });
    const bundle = buildClassroomEvidenceBundle({ snapshot, intent: 'class_summary' });
    expect(bundle.trust_status).toBe('needs_confirmation');
    expect(bundle.missing_sources).toContain('trusted_transcript');
    expect(bundle.recognitions.map((item) => item.text)).toEqual(['x² + 4x - 5 = 0']);
    expect(bundle.transcripts).toEqual([]);
  });

  it('changes its combined fingerprint when a relevant transcript correction changes', () => {
    const before = fixture();
    const first = buildClassroomEvidenceBundle({ snapshot: before, intent: 'class_summary' });
    const corrected = before.transcripts!.map((item) => item.transcript_id === 'transcript_2'
      ? { ...item, revision: 3, text: '在等式两边同时加四，等式仍成立', corrected_at: '2026-07-20T01:00:00.000Z' }
      : item);
    const second = buildClassroomEvidenceBundle({ snapshot: { ...before, transcripts: corrected }, intent: 'class_summary' });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});
