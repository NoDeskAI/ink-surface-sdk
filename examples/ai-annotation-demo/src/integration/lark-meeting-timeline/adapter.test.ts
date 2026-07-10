import { describe, expect, it } from 'vitest';
import type { DocumentSchemaRef, ProjectMemoryRef } from 'ink-surface-sdk/knowledge-schema';
import {
  alignedEventFromLarkTimeline,
  meetingEventMarkFromLarkTimeline,
  meetingMarkKindFromLarkTimeline,
  meetingSessionFromLarkTimeline,
  postProcessContextFromLarkTimeline,
} from './adapter';

const meetingStartMs = Date.parse('2026-07-05T03:00:00.000Z');
const createdAt = '2026-07-05T03:00:00.000Z';

const documentRef: DocumentSchemaRef = {
  ref_type: 'document',
  document_id: 'doc_ai_ux',
  page_id: 'pg_1',
  page_index: 0,
  event_id: 'mark_why',
  trace_id: 'trace_doc_why',
  bbox: [0.12, 0.2, 0.42, 0.08],
  object_refs: ['mark_why'],
  quote: 'AI 时代的 UX 范式',
  confidence: 0.93,
};

const memoryRef: ProjectMemoryRef = {
  ref_type: 'project_memory',
  memory_id: 'mem_v1_loop',
  kind: 'milestone',
  title: 'V1 demo loop',
};

describe('Lark Meeting Timeline adapter', () => {
  it('turns an open meeting session annotation into an InkLoop meeting event mark', () => {
    const session = meetingSessionFromLarkTimeline({
      platform: 'lark',
      title: 'InkLoop V1 Review',
      meeting_url: 'https://meet.example.test/abc',
      start_time_ms: meetingStartMs,
      detector_source: 'open_meeting_session',
    }, { nowMs: meetingStartMs, createdAt });

    expect(session).toMatchObject({
      schema_version: 'inkloop.meeting_session.v1',
      platform: 'lark',
      title: 'InkLoop V1 Review',
      source: 'open_meeting_session',
    });
    expect(session.meeting_id).toContain('InkLoop_V1_Review');

    const mark = meetingEventMarkFromLarkTimeline({
      id: 'ann_why',
      source: 'hanwang_epaper',
      captured_at_ms: meetingStartMs + 8_000,
      kind: 'why?',
      label: '为什么这里的 Obsidian 只做投影',
      text: '讨论 Obsidian 受控编辑边界',
      device_id: 'm103',
    }, session, { createdAt });

    expect(mark).toMatchObject({
      schema_version: 'inkloop.meeting_event_mark.v1',
      id: 'ann_why',
      meeting_id: session.meeting_id,
      time_ms: 8_000,
      source: 'hanwang_epaper',
      kind: 'question',
      intent: 'question',
    });
    expect(mark.payload.text).toBe('讨论 Obsidian 受控编辑边界');
    expect(mark.payload.device_id).toBe('m103');
  });

  it('maps meeting labels to product post-process intents', () => {
    expect(meetingMarkKindFromLarkTimeline({ label: '决策：V1 只演示阅读闭环' })).toBe('decision');
    expect(meetingMarkKindFromLarkTimeline({ label: '任务：补齐 M103 低延迟验收' })).toBe('action');
    expect(meetingMarkKindFromLarkTimeline({ label: '风险：T10C Plus 手写延迟未验证' })).toBe('risk');
    expect(meetingMarkKindFromLarkTimeline({ label: 'Q: Obsidian 回跳打开哪里' })).toBe('question');
    expect(meetingMarkKindFromLarkTimeline({ label: '重点关注同步状态' })).toBe('attention');
  });

  it('aligns SDK annotation marks with the active document schema layer', () => {
    const aligned = alignedEventFromLarkTimeline({
      id: 'ann_decision',
      captured_at_ms: meetingStartMs + 12_000,
      label: '决策：MVP 演示闭环固定为 Web 导入、墨水屏标记、Obsidian 投影',
      meeting_session: {
        meeting_id: 'mtg_v1_review',
        title: 'InkLoop V1 Review',
        start_time_ms: meetingStartMs,
        detector_source: 'lark_ws_event',
      },
    }, {
      documentRef,
      projectMemoryRefs: [memoryRef],
      createdAt,
    });

    expect(aligned).toMatchObject({
      event_type: 'meeting.decision_mark',
      alignment_status: 'aligned',
      meeting_id: 'mtg_v1_review',
      meeting_mark_id: 'ann_decision',
    });
    expect(aligned.source_refs.map((ref) => ref.ref_type)).toEqual(['document', 'meeting_mark', 'project_memory']);
  });

  it('keeps unbound SDK annotations out of trusted post-processing refs', () => {
    const aligned = alignedEventFromLarkTimeline({
      id: 'ann_unbound',
      captured_at_ms: meetingStartMs + 15_000,
      label: '风险：没有活动文档绑定',
      meeting_session: {
        meeting_id: 'mtg_unbound',
        title: 'Unbound Meeting',
        start_time_ms: meetingStartMs,
      },
    }, { createdAt });

    expect(aligned.alignment_status).toBe('needs_repair');
    expect(aligned.failure_reason).toBe('no_active_document');
    expect(aligned.schema_refs).toEqual([]);
    expect(aligned.source_refs.map((ref) => ref.ref_type)).toEqual(['meeting_mark']);
  });

  it('builds a post-process context with deduped meeting, document, and project refs', () => {
    const bundle = postProcessContextFromLarkTimeline({
      session: {
        meeting_id: 'mtg_bundle',
        title: 'InkLoop V1 Review',
        start_time_ms: meetingStartMs,
        detector_source: 'passive_tenant_scan',
      },
      annotations: [
        {
          id: 'ann_task',
          source: 'hanwang_epaper',
          captured_at_ms: meetingStartMs + 20_000,
          label: '任务：把会议事件输出到 Obsidian',
        },
        {
          id: 'ann_risk',
          source: 'hanwang_epaper',
          captured_at_ms: meetingStartMs + 28_000,
          label: '风险：Cloud Hub 不持久化会丢事件',
        },
      ],
      documentRef,
      projectMemoryRefs: [memoryRef],
      userFeedback: 'accepted',
      createdAt,
    });

    expect(bundle.session.source).toBe('lark_tenant_passive_meeting_scan');
    expect(bundle.meetingMarks.map((mark) => mark.kind)).toEqual(['action', 'risk']);
    expect(bundle.alignedEvents.every((event) => event.alignment_status === 'aligned')).toBe(true);
    expect(bundle.context.document_refs).toHaveLength(1);
    expect(bundle.context.meeting_marks).toHaveLength(2);
    expect(bundle.context.project_memory_refs).toHaveLength(1);
    expect(bundle.context.user_feedback).toBe('accepted');
  });
});
