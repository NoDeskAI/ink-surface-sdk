import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomBoardEvent, type ClassroomRecognitionRevision, type ClassroomTranscriptRevision } from 'ink-surface-sdk/runtime-schema';
import { ClassroomAiService, type EducationGatewayInput } from './classroom-ai';
import { JsonClassroomStore } from './classroom-store';

function boardEvent(id: string, x: number, time: number): Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'> {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'ignored', client_event_id: id,
    event: {
      event_id: `ink_${id}`, trace_id: `trace_${id}`, session_id: 'ignored', surface_id: 'board', pen_id: 'teacher', event_type: 'stroke',
      stroke_refs: [`stroke_${id}`], bbox_norm: [x, 0.1, 0.1, 0.1], ts_start_ms: time, ts_end_ms: time + 20,
      source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' },
    },
    stroke: {
      stroke_id: `stroke_${id}`, session_id: 'ignored', surface_id: 'board', pen_id: 'teacher',
      points: [{ x_norm: x, y_norm: 0.1, t_ms: time }, { x_norm: x + 0.05, y_norm: 0.15, t_ms: time + 20 }],
      bbox_norm: [x, 0.1, 0.1, 0.1], ts_start_ms: time, ts_end_ms: time + 20,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'classroom-ai-'));
  const store = await JsonClassroomStore.open(root);
  const created = await store.createClassroom('Private AI');
  const id = created.classroom.classroom_id;
  await store.transition(id, 'live');
  const first = await store.joinClassroom(created.class_code, 'Alice');
  const second = await store.joinClassroom(created.class_code, 'Alice');
  await store.appendBoardEvent(id, boardEvent('one', 0.1, 100));
  await store.appendBoardEvent(id, boardEvent('two', 0.6, 200));
  return { root, store, created, id, first, second };
}

describe('ClassroomAiService', () => {
  it('sends textbook, trusted math, and corrected teacher speech through one gateway payload', async () => {
    const setup = await fixture();
    const material = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, material_id: 'material_math', title: '配方法讲义',
      mime_type: 'application/pdf' as const, byte_size: 4, content_hash: `sha256:${'a'.repeat(64)}` as const,
      page_count: 1, page_geometries: [{ page_index: 0, width_world: 595, height_world: 842, rotation: 0 as const }], source: 'builtin' as const, published_at: '2026-07-20T00:00:00.000Z',
    };
    await setup.store.publishMaterial(setup.id, material, new Uint8Array([1, 2, 3, 4]), 'material_math_key');
    await setup.store.updateTeacherView(setup.id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, material_id: material.material_id, page_index: 0,
      zoom_mode: 'fit-width', zoom_percent: 100, active_surface: { kind: 'textbook_page', material_id: material.material_id, page_index: 0 },
      revision: 1, updated_at: '2026-07-20T00:00:01.000Z',
    });
    const math: ClassroomRecognitionRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, recognition_id: 'recognition_semantic', revision: 1,
      status: 'corrected', kind: 'formula', text: 'x² + 4x + 4 = 9', latex: 'x^2+4x+4=9', confidence: 1,
      provider: 'fixture', processing_mode: 'local', event_ids: ['ink_one'], surface: { kind: 'teacher_board' },
      bbox_norm: [0.05, 0.05, 0.3, 0.2], original_revision: 1, created_at: '2026-07-20T00:00:02.000Z', reviewed_at: '2026-07-20T00:00:02.000Z',
    };
    const speech: ClassroomTranscriptRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, transcript_id: 'transcript_semantic', revision: 1,
      status: 'final', recording_id: 'recording_1', recording_generation: 1, chunk_id: 'chunk_1',
      chunk_hash: `sha256:${'b'.repeat(64)}`, relative_start_ms: 80, relative_end_ms: 240,
      text: '在等式两边同时加四，等式仍然成立', confidence: 1, language: 'zh-CN', provider: 'fixture', processing_mode: 'local',
      created_at: '2026-07-20T00:00:03.000Z',
    };
    await setup.store.appendRecognitionRevision(setup.id, math);
    await setup.store.appendTranscriptRevision(setup.id, speech);
    await setup.store.transition(setup.id, 'ended');
    let payload: EducationGatewayInput | undefined;
    const ai = new ClassroomAiService(setup.store, { gateway: async (input) => {
      payload = input;
      return { title: '总结', sections: [{ content: '两边同加四完成配方。', event_ids: ['ink_one'] }] };
    } });
    const job = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'class_summary', client_request_id: 'semantic_bundle' });

    expect(payload?.material).toMatchObject({ title: '配方法讲义', page_index: 0 });
    expect(payload?.recognitions).toMatchObject([{ text: 'x² + 4x + 4 = 9' }]);
    expect(payload?.transcripts).toMatchObject([{ text: '在等式两边同时加四，等式仍然成立' }]);
    expect(new Set(job.result?.sections[0].source_refs.map((ref) => ref.type))).toEqual(new Set(['material_page', 'audio_segment', 'ink_event']));
  });

  it('warns live students, blocks post-class outputs, and only sends teacher-trusted formulas', async () => {
    const setup = await fixture();
    const pending: ClassroomRecognitionRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, recognition_id: 'recognition_math', revision: 1,
      status: 'pending', kind: 'formula', text: 'x + 2 = +3', latex: 'x+2=+3', confidence: 0.54, provider: 'fixture',
      processing_mode: 'local', event_ids: ['ink_one'], surface: { kind: 'teacher_board' }, bbox_norm: [0.05, 0.05, 0.3, 0.2], created_at: '2026-07-19T00:00:00.000Z',
    };
    await setup.store.appendRecognitionRevision(setup.id, pending);
    let gatewayInput: EducationGatewayInput | undefined;
    const gateway = vi.fn(async (input: EducationGatewayInput) => { gatewayInput = input; return { title: '解释', sections: [{ content: '可信公式', event_ids: ['ink_one'] }] }; });
    const ai = new ClassroomAiService(setup.store, { gateway });
    const warning = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'pending_warning', selection_bbox_norm: [0.05, 0.05, 0.3, 0.2] });
    expect(warning.result).toMatchObject({ fallback_reason: 'untrusted_formula_evidence', title: '公式尚待老师确认' });
    expect(gateway).not.toHaveBeenCalled();
    await setup.store.transition(setup.id, 'ended');
    await expect(ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'practice', client_request_id: 'pending_practice' })).rejects.toThrow('untrusted_formula_evidence');

    await setup.store.appendRecognitionRevision(setup.id, { ...pending, revision: 2, status: 'corrected', text: 'x + 2 = ±3', latex: 'x+2=\\pm3', confidence: 1, original_revision: 1, reviewed_at: '2026-07-19T00:01:00.000Z', created_at: '2026-07-19T00:01:00.000Z' });
    const practice = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'practice', client_request_id: 'trusted_practice' });
    expect(practice.result?.execution_mode).toBe('real');
    expect(gatewayInput?.recognitions).toMatchObject([{ text: 'x + 2 = ±3', latex: 'x+2=\\pm3', revision: 2 }]);
    expect(gatewayInput?.evidence.find((item) => item.event_id === 'ink_one')?.points).toEqual([]);
    expect((await ai.get(setup.id, setup.first.participant_id, warning.job_id))?.stale).toBe(true);
    const refreshed = await ai.retry(setup.id, setup.first.participant_id, warning.job_id);
    expect(refreshed.result?.execution_mode).toBe('real');
    expect((await ai.get(setup.id, setup.first.participant_id, warning.job_id))?.stale).toBe(false);
  });

  it('freezes selected evidence, validates gateway source ids, and never sends participant identity', async () => {
    const setup = await fixture();
    const gateway = vi.fn(async (_input) => ({ title: '局部讲解', sections: [{ content: '右侧这一步。', event_ids: ['ink_two'] }] }));
    const ai = new ClassroomAiService(setup.store, { gateway });
    const job = await ai.createAndRun(setup.id, setup.first.participant_id, {
      kind: 'live_explanation', client_request_id: 'request_one', selection_bbox_norm: [0.55, 0, 0.3, 0.4],
    });

    expect(job.status).toBe('completed');
    expect(job.evidence.source_refs.map((ref) => ref.type === 'ink_event' ? ref.event_id : '')).toEqual(['ink_two']);
    expect(job.result?.execution_mode).toBe('real');
    const payload = JSON.stringify(gateway.mock.calls[0][0]);
    expect(payload).not.toContain(setup.first.participant_id);
    expect(payload).not.toContain(setup.first.credential);
    expect(payload).not.toContain('Alice');
  });

  it('persists a labeled deterministic fallback and returns the same job for an idempotent replay', async () => {
    const setup = await fixture();
    const gateway = vi.fn(async () => { throw new Error('gateway secret and body'); });
    const ai = new ClassroomAiService(setup.store, { gateway });
    const first = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'stable_request' });
    const replay = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'stable_request' });

    expect(first.job_id).toBe(replay.job_id);
    expect(first.result).toMatchObject({ execution_mode: 'deterministic_fallback', fallback_reason: 'gateway_unavailable' });
    expect(gateway).toHaveBeenCalledTimes(1);
    const restarted = new ClassroomAiService(await JsonClassroomStore.open(setup.root), { gateway });
    expect((await restarted.list(setup.id, setup.first.participant_id))[0].job_id).toBe(first.job_id);
  });

  it('classifies malformed structured output separately and tracks retry attempts without duplicating the job', async () => {
    const setup = await fixture();
    const gateway = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('schema mismatch'), { name: 'ZodError' }))
      .mockRejectedValueOnce(new Error('still offline'));
    const ai = new ClassroomAiService(setup.store, { gateway });
    const first = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'retryable_request' });
    expect(first.result).toMatchObject({ execution_mode: 'deterministic_fallback', fallback_reason: 'invalid_structured_output' });
    expect(first.attempt_count).toBe(1);

    const retried = await ai.retry(setup.id, setup.first.participant_id, first.job_id);
    expect(retried.job_id).toBe(first.job_id);
    expect(retried.attempt_count).toBe(2);
    expect(retried.error_code).toBe('retry_gateway_unavailable');
    expect((await ai.list(setup.id, setup.first.participant_id))).toHaveLength(1);
  });

  it('deduplicates concurrent idempotent requests before invoking the gateway', async () => {
    const setup = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gateway = vi.fn(async () => { await gate; return { title: '解释', sections: [{ content: '同一请求', event_ids: ['ink_one'] }] }; });
    const ai = new ClassroomAiService(setup.store, { gateway });
    const input = { kind: 'live_explanation' as const, client_request_id: 'concurrent_request', selection_bbox_norm: [0.05, 0.05, 0.2, 0.2] as [number, number, number, number] };
    const first = ai.createAndRun(setup.id, setup.first.participant_id, input);
    const second = ai.createAndRun(setup.id, setup.first.participant_id, input);
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.job_id).toBe(b.job_id);
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight gateway on classroom deletion and cannot recreate participant data', async () => {
    const setup = await fixture();
    await setup.store.transition(setup.id, 'ended');
    const ai = new ClassroomAiService(setup.store, { gateway: async (_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
    const pending = ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'class_summary', client_request_id: 'delete_race' });
    const rejected = expect(pending).rejects.toThrow('classroom_not_found');
    await vi.waitFor(async () => expect((await ai.list(setup.id, setup.first.participant_id))[0]?.status).toBe('running'));
    ai.abortClassroom(setup.id);
    await setup.store.deleteClassroom(setup.id);
    await rejected;
    expect(await setup.store.getClassroom(setup.id)).toBeNull();
  });

  it('keeps participant histories isolated and preserves the original result when edited or dismissed', async () => {
    const setup = await fixture();
    const ai = new ClassroomAiService(setup.store, { gateway: async () => ({ title: '解释', sections: [{ content: '原始内容', event_ids: ['ink_one'] }] }) });
    const job = await ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'review_me' });
    expect(await ai.get(setup.id, setup.second.participant_id, job.job_id)).toBeNull();

    const edited = await ai.review(setup.id, setup.first.participant_id, job.job_id, { status: 'edited', user_edit: '我的理解' });
    expect(edited.result).toMatchObject({ review_status: 'edited', user_edit: '我的理解', original_result: { title: '解释' } });
    const dismissed = await ai.review(setup.id, setup.first.participant_id, job.job_id, { status: 'dismissed' });
    expect(dismissed.result?.review_status).toBe('dismissed');
    expect(await ai.get(setup.id, setup.second.participant_id, job.job_id)).toBeNull();
  });

  it('generates post-class practice from the whole classroom evidence', async () => {
    const setup = await fixture();
    const ai = new ClassroomAiService(setup.store, { gateway: async () => ({ title: '整堂课练习', sections: [
      { content: '题目', event_ids: ['ink_one', 'ink_two'] }, { content: '提示', event_ids: ['ink_one', 'ink_two'] }, { content: '答案', event_ids: ['ink_one', 'ink_two'] },
    ] }) });
    await setup.store.transition(setup.id, 'ended');
    const practice = await ai.createAndRun(setup.id, setup.first.participant_id, {
      kind: 'practice', client_request_id: 'whole_class_practice',
    });
    expect(practice.evidence.source_refs.filter((ref) => ref.type === 'ink_event').map((ref) => ref.event_id)).toEqual(['ink_one', 'ink_two']);
  });

  it('enforces live versus post-class task states and does not call the gateway for insufficient evidence', async () => {
    const setup = await fixture();
    const gateway = vi.fn(async () => ({ title: 'unused', sections: [] }));
    const ai = new ClassroomAiService(setup.store, { gateway });
    await expect(ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'class_summary', client_request_id: 'too_early' })).rejects.toThrow('classroom_not_ended');
    await expect(ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'empty_region', selection_bbox_norm: [0.85, 0.8, 0.1, 0.1] })).rejects.toThrow('insufficient_evidence');
    await expect(ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'missed_without_math', evidence_intent: 'missed_segment', trigger_time_ms: 250 })).rejects.toThrow('insufficient_evidence');
    expect(gateway).not.toHaveBeenCalled();
    await setup.store.transition(setup.id, 'ended');
    await expect(ai.createAndRun(setup.id, setup.first.participant_id, { kind: 'live_explanation', client_request_id: 'too_late' })).rejects.toThrow('classroom_not_live');
  });
});
