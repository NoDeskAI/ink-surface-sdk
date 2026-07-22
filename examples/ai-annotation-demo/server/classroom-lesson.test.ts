import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomBoardEvent, type ClassroomRecognitionRevision } from 'ink-surface-sdk/runtime-schema';
import { ClassroomLessonService } from './classroom-lesson';
import { JsonClassroomStore } from './classroom-store';

function event(id: string, time: number): Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'> {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'ignored', client_event_id: id,
    event: { event_id: `ink_${id}`, trace_id: `trace_${id}`, session_id: 'ignored', surface_id: 'board', pen_id: 'teacher', event_type: 'stroke', stroke_refs: [`stroke_${id}`], bbox_norm: [0.1, 0.1, 0.2, 0.1], ts_start_ms: time, ts_end_ms: time + 20, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' } },
    stroke: { stroke_id: `stroke_${id}`, session_id: 'ignored', surface_id: 'board', pen_id: 'teacher', points: [{ x_norm: 0.1, y_norm: 0.1, t_ms: time }], bbox_norm: [0.1, 0.1, 0.2, 0.1], ts_start_ms: time, ts_end_ms: time + 20 },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'classroom-lesson-'));
  const store = await JsonClassroomStore.open(root);
  const created = await store.createClassroom('Lesson'); const id = created.classroom.classroom_id;
  await store.transition(id, 'live'); const participant = await store.joinClassroom(created.class_code, 'Student');
  await store.appendBoardEvent(id, event('one', 100)); await store.appendBoardEvent(id, event('two', 200)); await store.appendBoardEvent(id, event('three', 300));
  await store.transition(id, 'ended'); return { root, store, created, id, participant };
}

describe('ClassroomLessonService', () => {
  it('blocks pending formula evidence and marks an existing generation stale after correction', async () => {
    const setup = await fixture();
    const pending: ClassroomRecognitionRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, recognition_id: 'recognition_lesson', revision: 1,
      status: 'pending', kind: 'formula', text: 'x + 2 = +3', confidence: 0.5, provider: 'fixture', processing_mode: 'local',
      event_ids: ['ink_one'], surface: { kind: 'teacher_board' }, bbox_norm: [0.1, 0.1, 0.2, 0.1], created_at: '2026-07-19T00:00:00.000Z',
    };
    await setup.store.appendRecognitionRevision(setup.id, pending);
    const lesson = new ClassroomLessonService(setup.store, async () => ({ candidates: [] }));
    await expect(lesson.generate(setup.id)).rejects.toThrow('untrusted_formula_evidence');
    await setup.store.appendRecognitionRevision(setup.id, { ...pending, revision: 2, status: 'confirmed', original_revision: 1, reviewed_at: '2026-07-19T00:01:00.000Z', created_at: '2026-07-19T00:01:00.000Z' });
    const generated = await new ClassroomLessonService(setup.store, async () => { throw new Error('offline'); }).generate(setup.id);
    expect(generated.stale).not.toBe(true);
    await setup.store.appendRecognitionRevision(setup.id, { ...pending, revision: 3, status: 'corrected', text: 'x + 2 = ±3', confidence: 1, original_revision: 1, reviewed_at: '2026-07-19T00:02:00.000Z', created_at: '2026-07-19T00:02:00.000Z' });
    expect((await new ClassroomLessonService(setup.store).get(setup.id))?.stale).toBe(true);
  });

  it('generates stable source-bound candidates only from shared classroom evidence', async () => {
    const setup = await fixture();
    await setup.store.putPrivateRecord(setup.id, setup.participant.participant_id, 'job_private', { content: 'student secret' });
    const lesson = new ClassroomLessonService(setup.store, async () => { throw new Error('offline'); });
    const first = await lesson.generate(setup.id); const replay = await lesson.generate(setup.id);
    expect(first.generation_id).toBe(replay.generation_id);
    expect(first.candidates).toHaveLength(3);
    expect(first.execution_mode).toBe('deterministic_fallback');
    expect(JSON.stringify(first)).not.toContain('student secret');
    expect(first.candidates.map((item) => item.source_refs[0].type === 'ink_event' ? item.source_refs[0].event_id : '')).toEqual(['ink_one', 'ink_two', 'ink_three']);
  });

  it('passes trusted recognition and transcript semantics to LessonGraph generation', async () => {
    const setup = await fixture();
    await setup.store.appendRecognitionRevision(setup.id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, recognition_id: 'recognition_lesson_semantic', revision: 1,
      status: 'confirmed', kind: 'formula', text: '(x + 2)² = 9', latex: '(x+2)^2=9', confidence: 1, provider: 'fixture',
      processing_mode: 'local', event_ids: ['ink_two'], surface: { kind: 'teacher_board' }, bbox_norm: [0.1, 0.1, 0.2, 0.1],
      created_at: '2026-07-20T00:00:00.000Z', reviewed_at: '2026-07-20T00:00:00.000Z',
    });
    await setup.store.appendTranscriptRevision(setup.id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: setup.id, transcript_id: 'transcript_lesson_semantic', revision: 1,
      status: 'final', recording_id: 'recording_1', recording_generation: 1, chunk_id: 'chunk_1', chunk_hash: `sha256:${'c'.repeat(64)}`,
      relative_start_ms: 150, relative_end_ms: 260, text: '把左边写成完全平方', confidence: 1, language: 'zh-CN', provider: 'fixture',
      processing_mode: 'local', created_at: '2026-07-20T00:00:01.000Z',
    });
    let evidence: unknown[] = [];
    const lesson = new ClassroomLessonService(setup.store, async (input) => {
      evidence = input;
      return { candidates: [
        { kind: 'definition', content: '原方程', confidence: 1, event_ids: ['ink_one'] },
        { kind: 'formula', content: '完全平方', latex: '(x+2)^2=9', confidence: 1, event_ids: ['ink_two'] },
        { kind: 'conclusion', content: '继续求解', confidence: 1, event_ids: ['ink_three'] },
      ] };
    });
    await lesson.generate(setup.id);
    expect(JSON.stringify(evidence)).toContain('(x + 2)² = 9');
    expect(JSON.stringify(evidence)).toContain('把左边写成完全平方');
  });

  it('accepts, edits, and dismisses candidates before building the reviewed projection', async () => {
    const setup = await fixture(); const lesson = new ClassroomLessonService(setup.store, async () => { throw new Error('offline'); });
    let output = await lesson.generate(setup.id);
    output = await lesson.review(setup.id, output.candidates[0].candidate_id, { status: 'accepted' });
    output = await lesson.review(setup.id, output.candidates[1].candidate_id, { status: 'edited', content: '教师修订的第二步' });
    output = await lesson.review(setup.id, output.candidates[2].candidate_id, { status: 'dismissed' });
    expect(output.review_complete).toBe(true);
    expect(output.reviewed_lesson_graph?.steps.map((step) => step.content)).toEqual(['课堂步骤 1', '教师修订的第二步']);
    expect(output.reviewed_lesson_graph?.steps.every((step) => step.source_refs.length > 0)).toBe(true);
    const restarted = new ClassroomLessonService(await JsonClassroomStore.open(setup.root), async () => { throw new Error('offline'); });
    expect(await restarted.get(setup.id)).toEqual(output);
  });

  it('stores validated real gateway candidates and rejects invented source ids into a labeled fallback', async () => {
    const setup = await fixture();
    const real = new ClassroomLessonService(setup.store, async () => ({ candidates: [
      { kind: 'definition', content: '第一步', confidence: 0.9, event_ids: ['ink_one'] },
      { kind: 'derivation', content: '第二步', confidence: 0.8, event_ids: ['ink_two'] },
      { kind: 'formula', content: '第三步', latex: 'x^2', confidence: 0.4, event_ids: ['ink_three'] },
    ] }));
    expect((await real.generate(setup.id)).execution_mode).toBe('real');

    const another = await fixture();
    const invalid = new ClassroomLessonService(another.store, async () => ({ candidates: [
      { kind: 'definition', content: '一', confidence: 0.9, event_ids: ['invented'] },
      { kind: 'derivation', content: '二', confidence: 0.8, event_ids: ['ink_two'] },
      { kind: 'conclusion', content: '三', confidence: 0.8, event_ids: ['ink_three'] },
    ] }));
    expect(await invalid.generate(another.id)).toMatchObject({ execution_mode: 'deterministic_fallback', fallback_reason: 'invalid_structured_output' });
  });

  it('deduplicates concurrent teacher generation requests', async () => {
    const setup = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gateway = vi.fn(async () => {
      await gate;
      return { candidates: [
        { kind: 'definition' as const, content: '一', confidence: 0.9, event_ids: ['ink_one'] },
        { kind: 'derivation' as const, content: '二', confidence: 0.8, event_ids: ['ink_two'] },
        { kind: 'conclusion' as const, content: '三', confidence: 0.8, event_ids: ['ink_three'] },
      ] };
    });
    const lesson = new ClassroomLessonService(setup.store, gateway);
    const first = lesson.generate(setup.id);
    const second = lesson.generate(setup.id);
    await vi.waitFor(() => expect(gateway).toHaveBeenCalledTimes(1));
    release();
    expect((await first).generation_id).toBe((await second).generation_id);
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it('requires an ended classroom and rejects unknown review candidates', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-lesson-live-')));
    const created = await store.createClassroom('Live'); await store.transition(created.classroom.classroom_id, 'live');
    const lesson = new ClassroomLessonService(store);
    await expect(lesson.generate(created.classroom.classroom_id)).rejects.toThrow('classroom_not_ended');
    await expect(lesson.review(created.classroom.classroom_id, 'candidate_unknown', { status: 'accepted' })).rejects.toThrow('lesson_generation_not_found');
  });
});
