import { describe, expect, it } from 'vitest';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';
import type { InkLoopSourceRef, LessonGraph, MeetingGraph } from 'ink-surface-sdk/runtime-schema';
import {
  alignMeetingEventMark,
  buildInkloopDocUri,
  buildInkloopDocUriFromDocumentRef,
  buildKnowledgeObjectFromPostProcessResult,
  buildLessonGraphKnowledgeObjects,
  buildMeetingEventMark,
  buildMeetingGraphKnowledgeObjects,
  buildPostProcessContext,
  isExportableKnowledgeObject,
  sha256Hex,
  validateMeetingPostProcessSourceRefs,
  type DocumentSchemaRef,
  type PostProcessResult,
  type ProjectMemoryRef,
} from './index';

async function withoutSubtle<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete (globalThis as { crypto?: Crypto }).crypto;
  }
}

const inkRef: InkLoopSourceRef = {
  type: 'ink_event',
  session_id: 'sess_ai_pen_demo',
  event_id: 'evt_board_mark',
  ts_start_ms: 100,
  ts_end_ms: 240,
  bbox_norm: [0.1, 0.2, 0.3, 0.1],
};

const actionRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_demo',
  object_id: 'obj_action',
  object_type: 'action_item',
  bbox_norm: [0.2, 0.4, 0.3, 0.1],
};

const diagramNodeRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_demo',
  object_id: 'obj_node',
  object_type: 'diagram_node',
  bbox_norm: [0.2, 0.2, 0.2, 0.1],
};

const arrowRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_demo',
  object_id: 'obj_arrow',
  object_type: 'arrow',
  bbox_norm: [0.4, 0.2, 0.2, 0.1],
};

const audioRef: InkLoopSourceRef = {
  type: 'audio_segment',
  session_id: 'sess_ai_pen_demo',
  start_ms: 1_000,
  end_ms: 6_000,
  speaker: 'Alex',
  transcript_ref: 'transcript_meeting_demo',
};

const projectMemoryRef: InkLoopSourceRef = {
  type: 'project_memory',
  memory_id: 'mem_prior_architecture',
  kind: 'prior_decision',
  title: 'Prior architecture notes',
};

const materialPageRef: InkLoopSourceRef = {
  type: 'material_page',
  session_id: 'sess_ai_pen_demo',
  material_id: 'material_math_9',
  page_index: 12,
  bbox_norm: [0.15, 0.25, 0.5, 0.2],
};

describe('AI graph KnowledgeObject projection', () => {
  it('computes stable SHA-256 when crypto.subtle is unavailable', async () => {
    const hash = await withoutSubtle(() => sha256Hex('abc'));
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('promotes reviewed MeetingGraph items into exportable Obsidian markdown with backlinks', async () => {
    const meeting: MeetingGraph = {
      meeting_id: 'meeting_demo',
      session_id: 'sess_ai_pen_demo',
      title: 'Architecture whiteboard review',
      decisions: [{
        decision_id: 'decision_ledger',
        content: 'Use the event ledger as the source of truth.',
        source_refs: [inkRef],
        confidence: 0.84,
      }],
      actions: [{
        action_id: 'action_schema',
        content: 'Lock PenFrame / InkEvent schema.',
        owner: 'Runtime',
        status: 'candidate',
        source_refs: [actionRef],
        confidence: 0.82,
      }],
      risks: [{
        risk_id: 'risk_glare',
        content: 'Surface glare can lower optical quality.',
        severity: 'high',
        source_refs: [diagramNodeRef],
        confidence: 0.74,
      }],
      diagrams: [{
        diagram_id: 'diagram_runtime',
        type: 'architecture',
        mermaid: 'flowchart LR\n  Host --> Ledger',
        source_refs: [diagramNodeRef, arrowRef],
        confidence: 0.72,
      }],
    };

    const objects = await buildMeetingGraphKnowledgeObjects(meeting, {
      documentId: 'doc_ai_pen_meeting',
      documentTitle: 'AI Pen Meeting Demo',
      now: '2026-07-02T00:00:00.000Z',
      statusById: {
        decision_ledger: 'accepted',
        action_schema: 'edited',
        risk_glare: 'dismissed',
        diagram_runtime: 'follow_up',
      },
      titleOverridesById: {
        action_schema: 'Edited Action: Lock AI Pen schema',
      },
      bodyOverridesById: {
        action_schema: 'Edited: Lock PenFrame and InkEvent schema before firmware integration.',
      },
    });

    expect(objects.map((ko) => ko.kind)).toEqual(['meeting_decision', 'meeting_action', 'diagram']);
    expect(objects.every(isExportableKnowledgeObject)).toBe(true);
    expect(objects.map((ko) => ko.status)).toEqual(['accepted', 'edited', 'follow_up']);
    expect(objects.map((ko) => ko.body_md).join('\n')).toContain(buildInkloopDocUri('doc_ai_pen_meeting'));
    expect(objects[1]?.title).toBe('Edited Action: Lock AI Pen schema');
    expect(objects[1]?.body_md).toContain('Edited: Lock PenFrame and InkEvent schema before firmware integration.');

    const markdown = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen_meeting',
        documentTitle: 'AI Pen Meeting Demo',
        mode: 'meeting',
        dates: ['2026-07-02'],
        knowledgeObjects: objects,
        documentProjections: [],
      }],
    }).map((file) => file.markdown).join('\n');

    expect(markdown).toContain('> [!tip] Decision: Use the event ledger as the source of truth.');
    expect(markdown).toContain('> [!todo] Edited Action: Lock AI Pen schema');
    expect(markdown).toContain('Edited: Lock PenFrame and InkEvent schema before firmware integration.');
    expect(markdown).toContain('> [!tip] Diagram: architecture');
    expect(markdown).toContain('inkloop://doc/doc_ai_pen_meeting');
    expect(markdown).not.toContain('Surface glare can lower optical quality.');
  });

  it('keeps meeting audio and project memory as context unless board evidence is present', async () => {
    const meeting: MeetingGraph = {
      meeting_id: 'meeting_context_demo',
      session_id: 'sess_ai_pen_demo',
      title: 'Meeting context boundary',
      decisions: [{
        decision_id: 'decision_audio_only',
        content: 'Do not promote this because it has no marked board event.',
        source_refs: [audioRef, projectMemoryRef],
        confidence: 0.9,
      }],
      actions: [{
        action_id: 'action_board_plus_audio',
        content: 'Follow up on the marked board action with transcript context.',
        owner: 'Product',
        status: 'candidate',
        source_refs: [actionRef, audioRef],
        confidence: 0.83,
      }],
      risks: [],
      diagrams: [],
    };

    const objects = await buildMeetingGraphKnowledgeObjects(meeting, {
      documentId: 'doc_ai_pen_meeting_context',
      documentTitle: 'AI Pen Meeting Context Demo',
      now: '2026-07-02T00:00:00.000Z',
      statusById: {
        decision_audio_only: 'accepted',
        action_board_plus_audio: 'accepted',
      },
    });

    expect(objects.map((ko) => ko.ko_id)).toEqual(['ko_action_board_plus_audio']);
    expect(objects[0]?.source.object_refs).toEqual(['obj_action', 'audio_1000_6000']);
    expect(objects[0]?.source.anchor_bbox).toEqual(actionRef.bbox_norm);
    expect(objects[0]?.body_md).toContain('action_item:obj_action');
    expect(objects[0]?.body_md).toContain('audio:1000-6000 Alex');
    expect(objects[0]?.body_md).not.toContain('Do not promote this');
  });

  it('does not promote unreviewed, dismissed, or invalid LessonGraph outputs', async () => {
    const lesson: LessonGraph = {
      lesson_id: 'lesson_demo',
      session_id: 'sess_ai_pen_demo',
      title: 'Completing the square',
      steps: [
        {
          step_id: 'step_formula',
          order: 1,
          kind: 'formula',
          content: 'Convert x^2 + 2x + 1 into (x + 1)^2.',
          latex: '(x + 1)^2',
          board_object_refs: ['obj_formula'],
          source_refs: [inkRef],
          confidence: 0.78,
        },
        {
          step_id: 'step_unreviewed',
          order: 2,
          kind: 'conclusion',
          content: 'Keep this as an unreviewed candidate.',
          board_object_refs: ['obj_conclusion'],
          source_refs: [inkRef],
          confidence: 0.83,
        },
      ],
      concepts: [{
        concept_id: 'concept_square',
        name: 'Completing the square',
        explanation: 'A reversible algebra step.',
        source_refs: [],
      }],
    };

    const objectsWithoutConcept = await buildLessonGraphKnowledgeObjects(lesson, {
      documentId: 'doc_ai_pen_lesson',
      documentTitle: 'AI Pen Lesson Demo',
      now: '2026-07-02T00:00:00.000Z',
      statusById: { step_formula: 'accepted', concept_square: 'accepted' },
    });

    expect(objectsWithoutConcept).toHaveLength(1);
    expect(objectsWithoutConcept[0]?.kind).toBe('formula_step');

    const validLesson = { ...lesson, concepts: [{ ...lesson.concepts[0], source_refs: [inkRef] }] };
    const objects = await buildLessonGraphKnowledgeObjects(validLesson, {
      documentId: 'doc_ai_pen_lesson',
      documentTitle: 'AI Pen Lesson Demo',
      now: '2026-07-02T00:00:00.000Z',
      statusById: { step_formula: 'accepted', concept_square: 'dismissed' },
    });

    expect(objects).toHaveLength(1);
    expect(objects[0]?.kind).toBe('formula_step');
    expect(objects[0]?.body_md).toContain('Formula: (x + 1)^2');
    expect(objects[0]?.body_md).toContain('Backlink: inkloop://doc/doc_ai_pen_lesson');
  });

  it('projects material-page evidence with stable deduplication and anchors', async () => {
    const lesson: LessonGraph = {
      lesson_id: 'lesson_material', session_id: 'sess_ai_pen_demo', title: 'Textbook lesson',
      steps: [{ step_id: 'step_material', order: 1, kind: 'derivation', content: 'Follow the textbook example.', board_object_refs: [], source_refs: [inkRef, materialPageRef, materialPageRef], confidence: 0.9 }],
      concepts: [],
    };
    const [object] = await buildLessonGraphKnowledgeObjects(lesson, {
      documentId: 'doc_material_lesson', documentTitle: 'Textbook lesson', now: '2026-07-02T00:00:00.000Z', statusById: { step_material: 'accepted' },
    });
    expect(object.source.object_refs).toEqual(['evt_board_mark', 'material_material_math_9_12']);
    expect(object.source.anchor_bbox).toEqual(inkRef.bbox_norm);
    expect(object.body_md.match(/material:material_math_9#page=13/g)).toHaveLength(1);
  });
});

describe('meeting event schema alignment contract', () => {
  const documentRef: DocumentSchemaRef = {
    ref_type: 'document',
    document_id: 'doc_meeting_deck',
    page_id: 'pg_12',
    page_index: 11,
    event_id: 'ann_doc_12',
    trace_id: 'trace_doc_12',
    bbox: [0.1, 0.2, 0.3, 0.12],
    object_refs: ['ann_doc_12'],
    quote: 'MVP 演示闭环',
    confidence: 0.92,
  };
  const memoryRef: ProjectMemoryRef = {
    ref_type: 'project_memory',
    memory_id: 'mem_h2_milestone',
    kind: 'milestone',
    title: '2026H2 MVP milestone',
  };

  it('aligns a meeting mark with document and project memory refs for post-processing', async () => {
    const mark = buildMeetingEventMark({
      id: 'ann_action',
      meetingId: 'mtg_v1',
      meetingStartMs: 1_700_000_000_000,
      capturedAtMs: 1_700_000_014_000,
      source: 'hanwang_epaper',
      kind: 'action',
      label: '任务：补齐 M103 低延迟手写验收数据',
      deviceId: 'm103',
    });

    expect(mark.time_ms).toBe(14_000);
    expect(mark.intent).toBe('action');
    expect(mark.idempotency_key).toBe('mtg_v1:ann_action:1700000014000');

    const aligned = alignMeetingEventMark({ mark, documentRef, projectMemoryRefs: [memoryRef] });
    expect(aligned).toMatchObject({
      schema_version: 'inkloop.schema_aligned_event.v1',
      event_type: 'meeting.action_mark',
      alignment_status: 'aligned',
      meeting_mark_id: 'ann_action',
    });
    expect(aligned.source_refs.map((ref) => ref.ref_type)).toEqual(['document', 'meeting_mark', 'project_memory']);

    const context = buildPostProcessContext({
      traceId: mark.trace_id,
      alignedEvents: [aligned],
      userFeedback: 'accepted',
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    expect(context.document_refs).toHaveLength(1);
    expect(context.meeting_marks).toHaveLength(1);
    expect(context.project_memory_refs).toHaveLength(1);

    const result: PostProcessResult = {
      schema_version: 'inkloop.post_process_result.v1',
      result_id: 'result_action_m103_latency',
      trace_id: mark.trace_id,
      result_type: 'task',
      title: '补齐 M103 低延迟手写验收数据',
      content_md: '把 M103 手写写入、显示、同步延迟补成验收报告。',
      source_refs: aligned.source_refs,
      confidence: 0.87,
      status: 'accepted',
      created_at: '2026-07-03T00:00:00.000Z',
    };
    expect(validateMeetingPostProcessSourceRefs(result.source_refs)).toEqual([]);

    const ko = await buildKnowledgeObjectFromPostProcessResult({ result, documentTitle: 'V1 SDK Meeting E2E' });
    expect(ko.kind).toBe('meeting_action');
    expect(ko.source_refs?.map((ref) => 'ref_type' in ref ? ref.ref_type : ref.type)).toEqual(['document', 'meeting_mark', 'project_memory']);
    expect(ko.source.inkloop_uri).toBe(buildInkloopDocUriFromDocumentRef(documentRef));
    expect(ko.body_md).toContain('meeting_mark:mtg_v1/ann_action');
    expect(ko.body_md).toContain('Backlink: inkloop://doc/doc_meeting_deck?page=11&anchor=ann_doc_12');
    expect(isExportableKnowledgeObject(ko)).toBe(true);
  });

  it('keeps unbound meeting marks out of trusted post-processing refs', () => {
    const mark = buildMeetingEventMark({
      id: 'ann_unbound',
      meetingId: 'mtg_v1',
      meetingStartMs: 1_700_000_000_000,
      capturedAtMs: 1_700_000_021_000,
      source: 'hanwang_epaper',
      kind: 'risk',
      label: '风险：没有活动文档绑定',
    });

    const aligned = alignMeetingEventMark({ mark });
    expect(aligned.alignment_status).toBe('needs_repair');
    expect(aligned.failure_reason).toBe('no_active_document');
    expect(aligned.schema_refs).toEqual([]);
    expect(validateMeetingPostProcessSourceRefs(aligned.source_refs).map((issue) => issue.message)).toContain('must include at least one document ref');
  });
});
