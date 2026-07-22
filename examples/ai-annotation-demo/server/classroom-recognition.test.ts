import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomBoardEvent } from 'ink-surface-sdk/runtime-schema';
import { ClassroomRecognitionService, classroomRecognitionModel, trustedRecognitionEvidence } from './classroom-recognition';
import { JsonClassroomStore } from './classroom-store';

function boardEvent(id: string, x = 0.1, bbox: [number, number, number, number] = [x, 0.2, 0.2, 0.08], materialId = 'material_1'): Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'> {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: 'placeholder', client_event_id: id,
    surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 },
    event: { event_id: `ink_${id}`, trace_id: `trace_${id}`, session_id: 'placeholder', surface_id: 'page', pen_id: 'teacher', event_type: 'stroke', stroke_refs: [`stroke_${id}`], bbox_norm: bbox, ts_start_ms: 100, ts_end_ms: 150, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' } },
    stroke: { stroke_id: `stroke_${id}`, session_id: 'placeholder', surface_id: 'page', pen_id: 'teacher', points: [{ x_norm: bbox[0], y_norm: bbox[1], t_ms: 100 }, { x_norm: bbox[0] + bbox[2] / 2, y_norm: bbox[1] + bbox[3] / 2, t_ms: 150 }], bbox_norm: bbox, ts_start_ms: 100, ts_end_ms: 150 },
  };
}

describe('ClassroomRecognitionService', () => {
  it('uses a vision-capable model for classroom handwriting recognition', () => {
    expect(classroomRecognitionModel({})).toBe('gemini-3.1-flash-lite');
    expect(classroomRecognitionModel({ INKLOOP_CLASSROOM_RECOGNITION_MODEL: 'vision-model' })).toBe('vision-model');
  });
  it('runs all six completing-square fixture lines through the same review contract', async () => {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/education-completing-square-evidence.json', import.meta.url), 'utf8')) as {
      surface: { kind: 'textbook_page'; material_id: string; page_index: number };
      lines: Array<{ order: number; event_ids: string[]; bbox_norm: [number, number, number, number]; text: string; latex: string }>;
    };
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-recognition-six-lines-')));
    const created = await store.createClassroom('Six formula lines'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    for (const line of fixture.lines) await store.appendBoardEvent(id, boardEvent(`formula_0${line.order}`, line.bbox_norm[0], line.bbox_norm, fixture.surface.material_id));
    const expected = new Map(fixture.lines.map((line) => [line.event_ids[0], line]));
    const service = new ClassroomRecognitionService(store, async (input) => {
      const line = expected.get(input.event_ids[0]); if (!line) throw new Error('fixture_line_missing');
      return { kind: 'formula', text: line.text, latex: line.latex, confidence: 0.96, provider: 'fixture' };
    });
    for (const line of fixture.lines) {
      const pending = await service.recognize(id, { client_request_id: `fixture_${line.order}`, event_ids: line.event_ids, surface: fixture.surface, bbox_norm: line.bbox_norm, processing_mode: 'local' });
      await service.review(id, pending.recognition_id, { status: 'confirmed' });
    }
    expect(trustedRecognitionEvidence(await service.list(id)).map((item) => item.text)).toEqual(fixture.lines.map((line) => line.text));
  });

  it('keeps low confidence pending, then appends confirmed and corrected revisions', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-recognition-')));
    const created = await store.createClassroom('Recognition'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.appendBoardEvent(id, boardEvent('formula'));
    const service = new ClassroomRecognitionService(store, async () => ({ kind: 'formula', text: 'x + 2 = +3', latex: 'x+2=+3', confidence: 0.54, provider: 'fixture' }));
    const pending = await service.recognize(id, {
      client_request_id: 'request_1', event_ids: ['ink_formula'], surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 }, bbox_norm: [0.05, 0.15, 0.4, 0.2], processing_mode: 'local',
    });
    expect(pending).toMatchObject({ revision: 1, status: 'pending', text: 'x + 2 = +3', confidence: 0.54 });
    const confirmed = await service.review(id, pending.recognition_id, { status: 'confirmed' });
    expect(confirmed).toMatchObject({ revision: 2, status: 'confirmed', original_revision: 1 });
    const corrected = await service.review(id, pending.recognition_id, { status: 'corrected', text: 'x + 2 = ±3', latex: 'x+2=\\pm3' });
    expect(corrected).toMatchObject({ revision: 3, status: 'corrected', text: 'x + 2 = ±3', original_revision: 1 });
    expect(await service.history(id, pending.recognition_id)).toHaveLength(3);
    expect(trustedRecognitionEvidence(await service.list(id))).toEqual([corrected]);
  });

  it('rejects unknown, cross-surface, and non-intersecting event evidence', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-recognition-invalid-')));
    const created = await store.createClassroom('Invalid recognition'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.appendBoardEvent(id, boardEvent('one'));
    let calls = 0;
    const service = new ClassroomRecognitionService(store, async () => { calls += 1; return { kind: 'formula', text: 'x=1', confidence: 1, provider: 'fixture' }; });
    const base = { client_request_id: 'bad', event_ids: ['ink_one'], surface: { kind: 'textbook_page' as const, material_id: 'material_1', page_index: 0 }, bbox_norm: [0.7, 0.7, 0.1, 0.1] as [number, number, number, number], processing_mode: 'local' as const };
    await expect(service.recognize(id, base)).rejects.toThrow('recognition_bbox_mismatch');
    await expect(service.recognize(id, { ...base, bbox_norm: [0, 0, 1, 1], event_ids: ['missing'] })).rejects.toThrow('recognition_source_invalid');
    await expect(service.recognize(id, { ...base, bbox_norm: [0, 0, 1, 1], surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 1 } })).rejects.toThrow('recognition_surface_mismatch');
    expect(calls).toBe(0);
  });

  it('records provider failure without manufacturing a formula', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-recognition-failed-')));
    const created = await store.createClassroom('Failed recognition'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.appendBoardEvent(id, boardEvent('one'));
    const service = new ClassroomRecognitionService(store, async () => { throw new Error('provider_down'); });
    const failed = await service.recognize(id, { client_request_id: 'failed_1', event_ids: ['ink_one'], surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 }, bbox_norm: [0, 0, 0.5, 0.5], processing_mode: 'external', image_data_url: 'data:image/png;base64,AAAA' });
    expect(failed).toMatchObject({ status: 'failed', text: '', error_code: 'recognition_provider_failed' });
    expect(trustedRecognitionEvidence([failed])).toEqual([]);
    await expect(service.review(id, failed.recognition_id, { status: 'confirmed' })).rejects.toThrow('recognition_failed_review_invalid');
    const dismissed = await service.review(id, failed.recognition_id, { status: 'dismissed' });
    expect(dismissed).toMatchObject({ revision: 2, status: 'dismissed', text: '', original_revision: 1 });
  });

  it('requires a bounded PNG crop for external recognition and passes only the selected crop', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-recognition-image-')));
    const created = await store.createClassroom('Recognition image'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.appendBoardEvent(id, boardEvent('image'));
    let received = '';
    const service = new ClassroomRecognitionService(store, async (input) => { received = input.image_base64 || ''; return { kind: 'formula', text: 'x=1', confidence: 0.9, provider: 'fixture' }; });
    const base = { client_request_id: 'image_request', event_ids: ['ink_image'], surface: { kind: 'textbook_page' as const, material_id: 'material_1', page_index: 0 }, bbox_norm: [0, 0, 0.5, 0.5] as [number, number, number, number], processing_mode: 'external' as const };
    await expect(service.recognize(id, base)).rejects.toThrow('recognition_image_required');
    await expect(service.recognize(id, { ...base, image_data_url: 'data:image/jpeg;base64,AAAA' })).rejects.toThrow('recognition_image_invalid');
    const result = await service.recognize(id, { ...base, image_data_url: 'data:image/png;base64,AAAA' });
    expect(result.status).toBe('pending'); expect(received).toBe('AAAA');
  });
});
