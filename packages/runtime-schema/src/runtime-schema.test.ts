import { describe, expect, it } from 'vitest';
import {
  AI_GRAPH_JOB_SCHEMA_VERSION,
  assertRuntimeSyncEvent,
  INKLOOP_AI_PEN_CONTRACT_VERSION,
  isRuntimeSyncEvent,
  validateInkLoopSourceRefs,
  validateAiGraphJob,
  validateLessonGraphSourceRefs,
  validateMeetingGraphSourceRefs,
  validateRawPenFrame,
  validateRuntimeSyncEvent,
  type AiGraphJob,
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
