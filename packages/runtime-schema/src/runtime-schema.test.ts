import { describe, expect, it } from 'vitest';
import {
  AI_GRAPH_JOB_SCHEMA_VERSION,
  CLASSROOM_SCHEMA_VERSION,
  CLASSROOM_WORLD_GEOMETRY_VERSION,
  assertRuntimeSyncEvent,
  INKLOOP_AI_PEN_CONTRACT_VERSION,
  isRuntimeSyncEvent,
  validateInkLoopSourceRefs,
  validateAiGraphJob,
  validateClassroomBoardEvent,
  validateClassroomPreview,
  validateClassroomSnapshot,
  validateClassroomTeacherView,
  validateClassroomConfirmedFocus,
  validateClassroomTimelineEntry,
  validateClassroomRecognitionRevision,
  validateClassroomRecordingState,
  validateClassroomTranscriptRevision,
  validateClassroomTranscriptionState,
  validateLessonGraphSourceRefs,
  validateMeetingGraphSourceRefs,
  validateRawPenFrame,
  validateRuntimeSyncEvent,
  type AiGraphJob,
  type ClassroomBoardEvent,
  type ClassroomPreview,
  type ClassroomSnapshot,
  type ClassroomTeacherView,
  type ClassroomConfirmedFocus,
  type ClassroomTimelineEntry,
  type ClassroomRecognitionRevision,
  type ClassroomRecordingState,
  type ClassroomTranscriptRevision,
  type ClassroomTranscriptionState,
  type InkEvent,
  type InkLoopSourceRef,
  type LessonGraph,
  type MeetingGraph,
  type RawPenFrame,
  type RuntimeAnnotation,
  type RuntimeDocumentSnapshot,
  type RuntimeSyncEvent,
} from './index';

function event(input: Partial<RuntimeSyncEvent> = {}): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: 'evt_runtime_schema',
    source: 'test',
    doc_id: 'doc_runtime_schema',
    operation: 'annotation.add',
    target: { type: 'annotation', id: 'ko_runtime_schema', block_id: 'blk_runtime_schema' },
    payload: {},
    status: 'pending',
    dedupe_key: 'doc_runtime_schema:annotation.add:ko_runtime_schema',
    created_at: '2026-06-28T00:00:00.000Z',
    updated_at: '2026-06-28T00:00:00.000Z',
    ...input,
  };
}

function snapshot(): RuntimeDocumentSnapshot {
  return {
    doc_id: 'doc_runtime_schema',
    doc_dir: 'memory://doc_runtime_schema',
    document: { doc_id: 'doc_runtime_schema', title: 'Runtime Schema', source_type: 'markdown' },
    identity: {
      schema_version: 'inkloop.runtime_document_identity.v1',
      doc_id: 'doc_runtime_schema',
      source_kind: 'native_markdown',
      stable_key: 'obsidian://vault/Runtime Schema.md',
      source_path: 'Runtime Schema.md',
      created_at: '2026-06-28T00:00:00.000Z',
      updated_at: '2026-06-28T00:00:00.000Z',
    },
    source: { doc_id: 'doc_runtime_schema', kind: 'native_markdown', vault_file: { path: 'Runtime Schema.md' } },
    source_revision: { content_hash: 'sha256:old', source_path: 'Runtime Schema.md' },
    blocks: [],
    nodes: [],
  };
}

describe('runtime schema', () => {
  it('validates textbook surfaces, teacher views, confirmed focus, and point-free timeline references', () => {
    const view: ClassroomTeacherView = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      material_id: 'material_1',
      page_index: 1,
      zoom_mode: 'percent',
      zoom_percent: 150,
      active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 1 },
      revision: 2,
      updated_at: '2026-07-19T00:00:00.000Z',
    };
    const focus: ClassroomConfirmedFocus = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      focus_id: 'focus_1',
      material_id: 'material_1',
      page_index: 1,
      bbox_norm: [0.1, 0.2, 0.5, 0.2],
      confirmed_at: '2026-07-19T00:00:01.000Z',
    };
    const timeline: ClassroomTimelineEntry = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      timeline_sequence: 1,
      kind: 'board_event_ref',
      occurred_at: '2026-07-19T00:00:02.000Z',
      board_sequence: 4,
      event_id: 'ink_4',
      surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 1 },
    };

    expect(validateClassroomTeacherView(view)).toEqual([]);
    expect(validateClassroomTeacherView({
      ...view,
      zoom_percent: 400,
      viewport: { center_x_world: 0, center_y_world: 0, zoom_scale: 4 },
    })).toEqual([]);
    expect(validateClassroomTeacherView({
      ...view,
      zoom_percent: 401,
      viewport: { center_x_world: 0, center_y_world: 0, zoom_scale: 4 },
    }).map((issue) => issue.path)).toContain('teacher_view.zoom_percent');
    expect(validateClassroomConfirmedFocus(focus)).toEqual([]);
    expect(validateClassroomTeacherView({
      ...view,
      active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 },
    }).map((issue) => issue.path)).toContain('teacher_view.active_surface');
    expect(validateClassroomConfirmedFocus({
      ...focus,
      bbox_norm: undefined,
      spatial_region: {
        coordinate_space: 'classroom_page_world_v1',
        surface: { kind: 'textbook_page', material_id: 'material_2', page_index: 1 },
        bbox_world: [0, 0, 10, 10],
      },
    }).map((issue) => issue.path)).toContain('confirmed_focus.spatial_region.surface');
    expect(validateClassroomTimelineEntry(timeline)).toEqual([]);
    expect(JSON.stringify(timeline)).not.toContain('points');
    expect(validateClassroomTimelineEntry({ ...timeline, surface: { kind: 'textbook_page', material_id: '', page_index: -1 } }).map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'timeline.surface.material_id', 'timeline.surface.page_index',
    ]));
  });

  it('validates append-only formula recognition revisions and rejects unbound trust', () => {
    const revision: ClassroomRecognitionRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', recognition_id: 'recognition_1', revision: 1,
      status: 'pending', kind: 'formula', text: 'x² + 4x = 5', latex: 'x^2+4x=5', confidence: 0.82,
      provider: 'test_fixture', processing_mode: 'local', event_ids: ['ink_1'],
      surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 }, bbox_norm: [0.1, 0.2, 0.5, 0.1], created_at: '2026-07-19T00:00:00.000Z',
    };
    expect(validateClassroomRecognitionRevision(revision)).toEqual([]);
    expect(validateClassroomRecognitionRevision({ ...revision, status: 'corrected', text: '', reviewed_at: undefined })).not.toEqual([]);
    expect(validateClassroomRecognitionRevision({ ...revision, event_ids: [] })).not.toEqual([]);
  });

  it('validates recording lifecycle state in snapshots and point-free timeline entries', () => {
    const recording: ClassroomRecordingState = {
      recording_id: 'recording_1', classroom_id: 'classroom_1', classroom_generation: 2, recording_generation: 1,
      state: 'recording', health: 'healthy', sample_rate: 16_000, channels: 1, chunk_count: 2, byte_count: 6_400,
      last_sequence: 2, last_relative_end_ms: 200, started_at: '2026-07-19T00:00:00.000Z',
    };
    const timeline: ClassroomTimelineEntry = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', timeline_sequence: 1,
      kind: 'recording_state', occurred_at: recording.started_at, recording,
    };
    expect(validateClassroomRecordingState(recording)).toEqual([]);
    expect(validateClassroomTimelineEntry(timeline)).toEqual([]);
    expect(validateClassroomSnapshot({
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', classroom_status: 'live',
      snapshot_sequence: 0, board_events: [], timeline_sequence: 1, recording,
      generated_at: '2026-07-19T00:00:01.000Z',
    })).toEqual([]);
    expect(JSON.stringify(timeline)).not.toMatch(/pcm|base64|sdp|candidate|points/i);
    expect(validateClassroomRecordingState({ ...recording, sample_rate: 12_345, channels: 8 }).map((issue) => issue.path)).toEqual(expect.arrayContaining(['recording.sample_rate', 'recording.channels']));
    expect(validateClassroomRecordingState({ ...recording, state: 'stopped' }).map((issue) => issue.path)).toContain('recording.stopped_at');
    expect(validateClassroomRecordingState({ ...recording, state: 'interrupted', health: 'incomplete' }).map((issue) => issue.path)).toContain('recording.interrupted_at');
  });

  it('validates append-only transcript revisions and transcription degradation state', () => {
    const transcript: ClassroomTranscriptRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', transcript_id: 'transcript_chunk_1_0', revision: 1,
      status: 'final', recording_id: 'recording_1', recording_generation: 1, chunk_id: 'chunk_1',
      chunk_hash: `sha256:${'a'.repeat(64)}`, relative_start_ms: 100, relative_end_ms: 900, text: '两边加九',
      confidence: 0.93, language: 'zh-CN', provider: 'loopback_whisper', processing_mode: 'local', created_at: '2026-07-19T00:00:01.000Z',
    };
    const transcription: ClassroomTranscriptionState = {
      classroom_id: 'classroom_1', recording_id: 'recording_1', recording_generation: 1, state: 'ready',
      provider: 'loopback_whisper', processing_mode: 'local', processed_chunk_count: 1, failed_chunk_count: 0,
      audio_available: true, updated_at: '2026-07-19T00:00:01.000Z',
    };
    expect(validateClassroomTranscriptRevision(transcript)).toEqual([]);
    expect(validateClassroomTranscriptionState(transcription)).toEqual([]);
    expect(validateClassroomTranscriptRevision({ ...transcript, status: 'corrected', original_revision: undefined, corrected_at: undefined })).not.toEqual([]);
    expect(validateClassroomTranscriptRevision({ ...transcript, relative_end_ms: 50 })).not.toEqual([]);
    expect(validateClassroomTranscriptionState({ ...transcription, state: 'failed', last_error_code: undefined })).not.toEqual([]);
    expect(validateClassroomTimelineEntry({
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', timeline_sequence: 2,
      kind: 'transcript_revision', occurred_at: transcript.created_at, transcript,
    })).toEqual([]);
  });

  it('validates classroom board, preview, snapshot, AI job, and teacher review contracts', () => {
    const stroke = {
      stroke_id: 'stroke_classroom_1',
      session_id: 'classroom_1',
      surface_id: 'board_1',
      pen_id: 'teacher_pointer',
      points: [{ x_norm: 0.1, y_norm: 0.2, t_ms: 100 }, { x_norm: 0.4, y_norm: 0.5, t_ms: 180, pressure: 0.8 }],
      bbox_norm: [0.1, 0.2, 0.3, 0.3] as [number, number, number, number],
      ts_start_ms: 100,
      ts_end_ms: 180,
    };
    const boardEvent: ClassroomBoardEvent = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      sequence: 1,
      client_event_id: 'client_event_1',
      accepted_at: '2026-07-17T00:00:00.000Z',
      event: {
        event_id: 'ink_event_1',
        trace_id: 'trace_1',
        session_id: 'classroom_1',
        surface_id: 'board_1',
        pen_id: 'teacher_pointer',
        event_type: 'stroke',
        stroke_refs: [stroke.stroke_id],
        bbox_norm: stroke.bbox_norm,
        ts_start_ms: 100,
        ts_end_ms: 180,
        source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 },
        metadata: { mode: 'teach', tool: 'pen', color: '#111111' },
      },
      stroke,
    };
    const preview: ClassroomPreview = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      client_event_id: 'client_event_1',
      revision: 2,
      points: stroke.points,
      tool: 'pen',
      color: '#111111',
      expires_at_ms: 1_800,
    };
    const snapshot: ClassroomSnapshot = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      classroom_status: 'live',
      snapshot_sequence: 1,
      board_events: [boardEvent],
      generated_at: '2026-07-17T00:00:01.000Z',
    };
    expect(validateClassroomBoardEvent(boardEvent)).toEqual([]);
    expect(validateClassroomPreview(preview)).toEqual([]);
    expect(validateClassroomSnapshot(snapshot)).toEqual([]);
  });

  it('validates classroom-only world records without loosening normalized Ink contracts', () => {
    const world: ClassroomBoardEvent = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', sequence: 1, client_event_id: 'world_1', accepted_at: '2026-07-20T00:00:00.000Z',
      geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 },
      event: { event_id: 'ink_world_1', trace_id: 'trace_world_1', session_id: 'classroom_1', surface_id: 'page', pen_id: 'teacher', event_type: 'stroke', stroke_refs: ['stroke_world_1'], bbox_world: [310, -20, 120, 40], ts_start_ms: 1, ts_end_ms: 2, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 } },
      stroke: { stroke_id: 'stroke_world_1', session_id: 'classroom_1', surface_id: 'page', pen_id: 'teacher', points_world: [{ x_world: 310, y_world: -20, t_ms: 1 }, { x_world: 430, y_world: 20, t_ms: 2 }], bbox_world: [310, -20, 120, 40], ts_start_ms: 1, ts_end_ms: 2 },
    };
    expect(validateClassroomBoardEvent(world)).toEqual([]);
    expect(validateClassroomBoardEvent({ ...world, surface: { kind: 'teacher_board' } } as unknown).map((issue) => issue.path)).toContain('board_event.surface');
    expect(validateClassroomBoardEvent({ ...world, stroke: { ...world.stroke, points_world: [{ x_world: Number.POSITIVE_INFINITY, y_world: 0, t_ms: 1 }] } } as unknown).map((issue) => issue.path)).toContain('board_event.stroke.points_world.0.x_world');
    expect(validateClassroomPreview({ schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', client_event_id: 'preview_world', revision: 1, geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, points_world: world.stroke.points_world, tool: 'pen', expires_at_ms: 100, surface: world.surface })).toEqual([]);

    const legacyInk: InkEvent = { ...world.event, bbox_norm: [0, 0, 1, 1] };
    delete (legacyInk as unknown as Record<string, unknown>).bbox_world;
    expect(legacyInk.bbox_norm).toEqual([0, 0, 1, 1]);
  });

  it('rejects malformed classroom coordinates, ordering, private stream state, and unsupported AI evidence', () => {
    const boardIssues = validateClassroomBoardEvent({
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      sequence: 0,
      client_event_id: 'event_1',
      accepted_at: 'now',
      event: {
        event_id: 'ink_1', trace_id: 'trace_1', session_id: 'classroom_1', surface_id: 'board_1', pen_id: 'teacher',
        event_type: 'stroke', stroke_refs: ['stroke_1'], bbox_norm: [-0.1, 0, 1.1, 1], ts_start_ms: 20, ts_end_ms: 10,
        source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 },
      },
      stroke: {
        stroke_id: 'stroke_1', session_id: 'classroom_1', surface_id: 'board_1', pen_id: 'teacher', points: [],
        bbox_norm: [0, 0, 1, 1], ts_start_ms: 20, ts_end_ms: 10,
      },
    });
    const previewIssues = validateClassroomPreview({
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1',
      client_event_id: 'event_1',
      revision: -1,
      points: [{ x_norm: Number.NaN, y_norm: 2, t_ms: 1 }],
      tool: 'pen', color: '#000', expires_at_ms: 1,
    });
    const snapshotIssues = validateClassroomSnapshot({
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: 'classroom_1', classroom_status: 'live', snapshot_sequence: 2,
      board_events: [{ sequence: 2 }, { sequence: 1 }], generated_at: 'now',
      private_jobs: [{ job_id: 'must_not_leak' }],
    });

    expect(boardIssues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['board_event.sequence', 'board_event.event.bbox_norm', 'board_event.event.ts_end_ms', 'board_event.stroke.points']));
    expect(previewIssues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['preview.revision', 'preview.points.0.x_norm', 'preview.points.0.y_norm']));
    expect(snapshotIssues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['snapshot.board_events.0', 'snapshot.board_events.1', 'snapshot.private_jobs']));
  });

  it('bounds durable stroke and ephemeral preview point counts', () => {
    const oversizedPoints = Array.from({ length: 4_097 }, (_, index) => ({ x_norm: 0.5, y_norm: 0.5, t_ms: index }));
    const boardIssues = validateClassroomBoardEvent({
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', sequence: 1, client_event_id: 'event_1', accepted_at: 'now',
      event: {
        event_id: 'ink_1', trace_id: 'trace_1', session_id: 'classroom_1', surface_id: 'board_1', pen_id: 'teacher', event_type: 'stroke',
        stroke_refs: ['stroke_1'], bbox_norm: [0, 0, 1, 1], ts_start_ms: 0, ts_end_ms: 4_096,
        source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 },
      },
      stroke: { stroke_id: 'stroke_1', session_id: 'classroom_1', surface_id: 'board_1', pen_id: 'teacher', points: oversizedPoints, bbox_norm: [0, 0, 1, 1], ts_start_ms: 0, ts_end_ms: 4_096 },
    });
    const previewIssues = validateClassroomPreview({
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'classroom_1', client_event_id: 'event_1', revision: 257,
      points: oversizedPoints.slice(0, 257), tool: 'pen', expires_at_ms: 5_000,
    });

    expect(boardIssues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'board_event.stroke.points', message: expect.stringContaining('at most 4096') })]));
    expect(previewIssues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'preview.points', message: expect.stringContaining('at most 256') })]));
  });

  it('validates the current runtime sync event contract', () => {
    const value = event();

    expect(validateRuntimeSyncEvent(value)).toEqual([]);
    expect(isRuntimeSyncEvent(value)).toBe(true);
    expect(() => assertRuntimeSyncEvent(value)).not.toThrow();
  });

  it('reports missing required event fields without throwing', () => {
    const issues = validateRuntimeSyncEvent({ schema_version: 'inkloop.runtime_sync_event.v1', status: 'pending' });

    expect(issues.map((issue) => issue.path)).toContain('event_id');
    expect(issues.map((issue) => issue.path)).toContain('doc_id');
    expect(issues.map((issue) => issue.path)).toContain('operation');
    expect(issues.map((issue) => issue.path)).toContain('target');
  });

  it('validates bootstrap, delete, progress, and source rename operations', () => {
    expect(validateRuntimeSyncEvent(event({
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: 'doc_runtime_schema' },
      payload: { snapshot: snapshot() },
      origin: { device_id: 'device_schema' },
    }))).toEqual([]);

    expect(validateRuntimeSyncEvent(event({
      operation: 'annotation.delete',
      target: { type: 'annotation', id: 'ko_runtime_schema' },
      payload: { ko_id: 'ko_runtime_schema', tombstone: true },
    }))).toEqual([]);

    expect(validateRuntimeSyncEvent(event({
      operation: 'progress.update',
      target: { type: 'progress', id: 'doc_runtime_schema' },
      payload: { progress: { page_index: 2, scroll_ratio: 0.4, updated_at: '2026-06-28T00:05:00.000Z' } },
    }))).toEqual([]);

    expect(validateRuntimeSyncEvent(event({
      operation: 'source.rename',
      target: { type: 'source', id: 'doc_runtime_schema' },
      payload: { source_path: 'Renamed Runtime Schema.md' },
    }))).toEqual([]);

    expect(validateRuntimeSyncEvent(event({
      operation: 'knowledge.update',
      target: { type: 'knowledge_object', id: 'ko_runtime_schema' },
      payload: { ko_id: 'ko_runtime_schema', patch: { status: 'archived', task_done: true } },
    }))).toEqual([]);
  });

  it('rejects malformed bootstrap, delete, knowledge update, progress, and origin metadata', () => {
    const issues = [
      ...validateRuntimeSyncEvent(event({ operation: 'runtime.bootstrap', target: { type: 'document' }, payload: {} })),
      ...validateRuntimeSyncEvent(event({ operation: 'annotation.delete', target: { type: 'annotation' }, payload: {} })),
      ...validateRuntimeSyncEvent(event({ operation: 'knowledge.update', target: { type: 'knowledge_object' }, payload: { ko_id: '', patch: null as never } })),
      ...validateRuntimeSyncEvent(event({ operation: 'progress.update', target: { type: 'progress' }, payload: {} })),
      ...validateRuntimeSyncEvent(event({ origin: { client_id: 'missing-device' } as RuntimeSyncEvent['origin'] })),
    ];

    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'payload.snapshot',
      'payload.ko_id',
      'payload.patch',
      'payload.progress',
      'origin.device_id',
    ]));
  });

  it('keeps overflow stroke coordinates valid for infinite canvas marks', () => {
    const annotation: RuntimeAnnotation = {
      ko_id: 'ko_overflow',
      render_mode: 'stroke_only',
      visual_strokes: [{ tool: 'pen', points: [{ x: -0.3, y: 0.2 }, { x: 1.8, y: 0.9 }] }],
    };

    expect(annotation.visual_strokes?.[0].points).toEqual([{ x: -0.3, y: 0.2 }, { x: 1.8, y: 0.9 }]);
  });

  it('models the AI Pen capture path from RawPenFrame to InkEvent', () => {
    const frame: RawPenFrame = {
      schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
      pen_id: 'pen_alpha',
      session_id: 'sess_teacher_demo',
      surface_id: 'surface_a2_001',
      ts_device_ms: 1200,
      ts_host_ms: 1218,
      tip_state: 'down',
      pressure: 0.72,
      optical: { x_raw: 412, y_raw: 128, pattern_id: 'pat_42', quality: 0.94 },
      imu: { ax: 0, ay: 0.1, az: 0.9, gx: 0.01, gy: 0.02, gz: 0.03 },
      battery: 0.83,
      firmware_version: '0.1.0',
    };

    const inkEvent: InkEvent = {
      schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
      event_id: 'evt_stroke_001',
      trace_id: 'trace_teacher_demo',
      session_id: frame.session_id,
      surface_id: frame.surface_id ?? 'surface_unknown',
      pen_id: frame.pen_id,
      event_type: 'stroke',
      stroke_refs: ['stroke_001'],
      bbox_norm: [0.1, 0.2, 0.3, 0.1],
      ts_start_ms: frame.ts_host_ms ?? frame.ts_device_ms,
      ts_end_ms: 1360,
      source: { device: 'ai_pen', localization: 'encoded_surface', confidence: 0.94 },
      metadata: { mode: 'teach', tool: 'pen', color: 'black' },
    };

    expect(inkEvent.pen_id).toBe(frame.pen_id);
    expect(inkEvent.source.localization).toBe('encoded_surface');
    expect(inkEvent.metadata?.mode).toBe('teach');
    expect(validateRawPenFrame(frame)).toEqual([]);
  });

  it('reports malformed AI Pen hardware frames with precise paths', () => {
    const issues = validateRawPenFrame({
      schema_version: 'inkloop.ai_pen.future',
      pen_id: '',
      session_id: 'sess_teacher_demo',
      ts_device_ms: Number.NaN,
      ts_host_ms: 'late',
      tip_state: 'move',
      pressure: 1.2,
      optical: { quality: 1.5, x_raw: 'x' },
      imu: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0 },
      battery: -0.1,
      firmware_version: '',
    });

    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'frame.schema_version',
      'frame.pen_id',
      'frame.ts_device_ms',
      'frame.ts_host_ms',
      'frame.tip_state',
      'frame.pressure',
      'frame.battery',
      'frame.firmware_version',
      'frame.optical.x_raw',
      'frame.optical.quality',
      'frame.imu.gz',
    ]));
  });

  it('requires lesson and meeting AI outputs to retain ink or board evidence', () => {
    const audioOnly: InkLoopSourceRef[] = [{ type: 'audio_segment', session_id: 'sess_meeting', start_ms: 0, end_ms: 1200 }];
    const boardObject: InkLoopSourceRef = {
      type: 'board_object',
      session_id: 'sess_meeting',
      object_id: 'obj_action',
      object_type: 'action_item',
      bbox_norm: [0.2, 0.2, 0.2, 0.1],
    };

    expect(validateInkLoopSourceRefs('meeting_action', audioOnly).map((issue) => issue.message)).toContain(
      'meeting results must include ink_event or board_object evidence, not audio/project memory alone',
    );
    expect(validateInkLoopSourceRefs('meeting_action', [boardObject])).toEqual([]);
  });

  it('validates LessonGraph and MeetingGraph source_refs against the Kickstarter V1 contract', () => {
    const inkRef: InkLoopSourceRef = {
      type: 'ink_event',
      session_id: 'sess_education',
      event_id: 'evt_formula',
      ts_start_ms: 100,
      ts_end_ms: 500,
      bbox_norm: [0.1, 0.1, 0.4, 0.2],
    };
    const arrowRef: InkLoopSourceRef = {
      type: 'board_object',
      session_id: 'sess_meeting',
      object_id: 'obj_arrow',
      object_type: 'arrow',
      bbox_norm: [0.4, 0.2, 0.2, 0.1],
    };
    const shapeRef: InkLoopSourceRef = {
      type: 'board_object',
      session_id: 'sess_meeting',
      object_id: 'obj_service',
      object_type: 'diagram_node',
      bbox_norm: [0.1, 0.2, 0.2, 0.1],
    };

    const lesson: LessonGraph = {
      lesson_id: 'lesson_1',
      session_id: 'sess_education',
      steps: [{
        step_id: 'step_1',
        order: 1,
        kind: 'formula',
        content: 'Complete the square.',
        latex: 'x^2+2x+1',
        board_object_refs: ['obj_formula'],
        source_refs: [inkRef],
        confidence: 0.78,
      }],
      concepts: [],
    };

    const meeting: MeetingGraph = {
      meeting_id: 'meeting_1',
      session_id: 'sess_meeting',
      decisions: [{ decision_id: 'decide_1', content: 'Use the event ledger as SSoT.', source_refs: [inkRef], confidence: 0.86 }],
      actions: [{ action_id: 'act_1', content: 'Lock PenFrame schema.', status: 'candidate', source_refs: [inkRef], confidence: 0.82 }],
      risks: [{ risk_id: 'risk_1', content: 'Optical quality drops under glare.', source_refs: [shapeRef], confidence: 0.7 }],
      diagrams: [{ diagram_id: 'diagram_1', type: 'architecture', mermaid: 'flowchart LR', source_refs: [shapeRef, arrowRef], confidence: 0.73 }],
    };

    expect(validateLessonGraphSourceRefs(lesson)).toEqual([]);
    expect(validateMeetingGraphSourceRefs(meeting)).toEqual([]);
    expect(validateInkLoopSourceRefs('diagram_export', [shapeRef]).map((issue) => issue.path)).toEqual(['source_refs']);
  });

  it('validates completed AI graph jobs with retained source evidence', () => {
    const inkEvent: InkEvent = {
      schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
      event_id: 'evt_lesson_job',
      trace_id: 'trace_lesson_job',
      session_id: 'sess_education',
      surface_id: 'surface_a2_001',
      pen_id: 'pen_alpha',
      event_type: 'stroke',
      stroke_refs: ['stroke_formula'],
      bbox_norm: [0.1, 0.1, 0.4, 0.2],
      ts_start_ms: 100,
      ts_end_ms: 500,
      source: { device: 'ai_pen', localization: 'encoded_surface', confidence: 0.94 },
      metadata: { mode: 'teach', tool: 'pen' },
    };
    const lesson: LessonGraph = {
      lesson_id: 'lesson_job',
      session_id: 'sess_education',
      steps: [{
        step_id: 'step_formula',
        order: 1,
        kind: 'formula',
        content: 'Explain the marked formula.',
        latex: '(x+1)^2',
        board_object_refs: [],
        source_refs: [{
          type: 'ink_event',
          session_id: inkEvent.session_id,
          event_id: inkEvent.event_id,
          ts_start_ms: inkEvent.ts_start_ms,
          ts_end_ms: inkEvent.ts_end_ms,
          bbox_norm: inkEvent.bbox_norm,
        }],
        confidence: 0.8,
      }],
      concepts: [],
    };
    const job: AiGraphJob = {
      schema_version: AI_GRAPH_JOB_SCHEMA_VERSION,
      job_id: 'job_lesson_1',
      session_id: inkEvent.session_id,
      surface_id: inkEvent.surface_id,
      mode: 'teach',
      status: 'completed',
      input: {
        ink_events: [inkEvent],
        board_objects: [],
      },
      output: { lesson_graph: lesson },
      created_at: '2026-07-03T00:00:00.000Z',
      updated_at: '2026-07-03T00:00:01.000Z',
      completed_at: '2026-07-03T00:00:01.000Z',
    };

    expect(validateAiGraphJob(job)).toEqual([]);
  });

  it('rejects completed AI graph jobs that bypass ink or board evidence', () => {
    const audioOnly: InkLoopSourceRef = {
      type: 'audio_segment',
      session_id: 'sess_meeting',
      start_ms: 0,
      end_ms: 1200,
    };
    const job: AiGraphJob = {
      schema_version: AI_GRAPH_JOB_SCHEMA_VERSION,
      job_id: 'job_meeting_audio_only',
      session_id: 'sess_meeting',
      surface_id: 'surface_a2_001',
      mode: 'meeting',
      status: 'completed',
      input: {
        ink_events: [],
        board_objects: [],
        optional_context: { audio_segment_refs: [audioOnly] },
      },
      output: {
        meeting_graph: {
          meeting_id: 'meeting_audio_only',
          session_id: 'sess_meeting',
          decisions: [{
            decision_id: 'decision_audio',
            content: 'Audio-only decision should not enter the InkLoop graph.',
            source_refs: [audioOnly],
            confidence: 0.7,
          }],
          actions: [],
          risks: [],
          diagrams: [],
        },
      },
      created_at: '2026-07-03T00:00:00.000Z',
      updated_at: '2026-07-03T00:00:01.000Z',
      completed_at: '2026-07-03T00:00:01.000Z',
    };

    expect(validateAiGraphJob(job).map((issue) => issue.message)).toEqual(expect.arrayContaining([
      'must include ink_event or board_object evidence',
      'meeting results must include ink_event or board_object evidence, not audio/project memory alone',
    ]));
  });
});
