import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, type ClassroomBoardEvent } from 'ink-surface-sdk/runtime-schema';
import { ClassroomService } from './classroom-service';
import { JsonClassroomStore } from './classroom-store';

function event(clientEventId: string): Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'> {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION,
    classroom_id: 'ignored',
    client_event_id: clientEventId,
    event: {
      event_id: `ink_${clientEventId}`, trace_id: `trace_${clientEventId}`, session_id: 'ignored', surface_id: 'board', pen_id: 'teacher',
      event_type: 'stroke', stroke_refs: [`stroke_${clientEventId}`], bbox_norm: [0.1, 0.1, 0.1, 0.1], ts_start_ms: 1, ts_end_ms: 2,
      source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' },
    },
    stroke: {
      stroke_id: `stroke_${clientEventId}`, session_id: 'ignored', surface_id: 'board', pen_id: 'teacher',
      points: [{ x_norm: 0.1, y_norm: 0.1, t_ms: 1 }], bbox_norm: [0.1, 0.1, 0.1, 0.1], ts_start_ms: 1, ts_end_ms: 2,
    },
  };
}

describe('ClassroomService', () => {
  it('replays after a cursor, then tails each accepted event once and terminates on deletion', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-service-')));
    const service = new ClassroomService(store);
    const created = await store.createClassroom('Service');
    await store.transition(created.classroom.classroom_id, 'live');
    await service.appendBoardEvent(created.classroom.classroom_id, event('one'));

    const messages: Array<{ type: string; sequence?: number }> = [];
    let closed = false;
    const subscription = await service.subscribe(created.classroom.classroom_id, 0, (message) => { messages.push(message); return true; }, () => { closed = true; });
    await service.appendBoardEvent(created.classroom.classroom_id, event('two'));
    await store.transition(created.classroom.classroom_id, 'ended');
    await service.deleteClassroom(created.classroom.classroom_id);

    expect(messages.filter((message) => message.type === 'board_event').map((message) => message.sequence)).toEqual([1, 2]);
    expect(messages.at(-1)?.type).toBe('class_deleted');
    expect(closed).toBe(true);
    subscription.close();
  });

  it('bounds a slow subscriber and asks it to resync without blocking other subscribers', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-service-slow-')));
    const service = new ClassroomService(store);
    const created = await store.createClassroom('Slow client');
    const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    const slowMessages: string[] = [];
    const fastMessages: string[] = [];
    let slowClosed = false;
    await service.subscribe(id, 0, (message) => {
      slowMessages.push(message.type);
      return message.type !== 'board_event';
    }, () => { slowClosed = true; });
    await service.subscribe(id, 0, (message) => { fastMessages.push(message.type); return true; }, () => undefined);

    await service.appendBoardEvent(id, event('one'));
    await service.appendBoardEvent(id, event('two'));

    expect(slowMessages).toEqual(['board_event', 'resync_required']);
    expect(slowClosed).toBe(true);
    expect(fastMessages).toEqual(['board_event', 'board_event']);
  });

  it('persists and broadcasts teacher view and confirmed focus updates', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-service-view-')));
    const service = new ClassroomService(store);
    const created = await store.createClassroom('Textbook stream');
    const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    const messages: string[] = [];
    await service.subscribe(id, 0, (message) => { messages.push(message.type); return true; }, () => undefined);

    await service.updateTeacherView(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_1', page_index: 2,
      zoom_mode: 'fit-width', zoom_percent: 120, active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 2 },
      revision: 1, updated_at: '2026-07-19T01:00:00.000Z',
    });
    await service.confirmFocus(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, focus_id: 'focus_1', material_id: 'material_1', page_index: 2,
      bbox_norm: [0.2, 0.3, 0.4, 0.15], confirmed_at: '2026-07-19T01:00:01.000Z',
    });

    expect(messages.slice(-2)).toEqual(['teacher_view', 'confirmed_focus']);
    expect(await store.getSharedState(id)).toMatchObject({ teacher_view: { page_index: 2 }, confirmed_focus: { focus_id: 'focus_1' } });
    await store.transition(id, 'ended');
    await expect(service.updateTeacherView(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_1', page_index: 2,
      zoom_mode: 'percent', zoom_percent: 100, active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 2 },
      revision: 2, updated_at: '2026-07-19T01:00:02.000Z',
    })).rejects.toThrow('classroom_not_live');
    await expect(service.confirmFocus(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, focus_id: 'focus_2', material_id: 'material_1', page_index: 2,
      bbox_norm: [0.2, 0.3, 0.4, 0.15], confirmed_at: '2026-07-19T01:00:03.000Z',
    })).rejects.toThrow('classroom_not_live');
  });

  it('replays durable textbook projection after subscribing so snapshot handoff cannot miss it', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-service-projection-replay-')));
    const service = new ClassroomService(store);
    const created = await store.createClassroom('Projection replay'); const id = created.classroom.classroom_id;
    await store.updateTeacherView(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_1', page_index: 1,
      zoom_mode: 'percent', zoom_percent: 130, active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 1 }, revision: 1, updated_at: '2026-07-19T01:00:00.000Z',
    });
    const messages: string[] = [];
    await service.subscribe(id, 0, (message) => { messages.push(message.type); return true; }, () => undefined);
    expect(messages).toContain('teacher_view');
  });

  it('broadcasts transcript clearing to every classroom subscriber', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-service-transcript-clear-'))); const service = new ClassroomService(store);
    const created = await store.createClassroom('Transcript clear'); const id = created.classroom.classroom_id;
    const first: string[] = []; const second: string[] = [];
    await service.subscribe(id, 0, (message) => { first.push(message.type); return true; }, () => undefined);
    await service.subscribe(id, 0, (message) => { second.push(message.type); return true; }, () => undefined);
    service.publishTranscriptsCleared(id, '2026-07-21T00:00:00Z');
    expect(first.at(-1)).toBe('transcripts_cleared'); expect(second.at(-1)).toBe('transcripts_cleared');
  });

  it('streams latest transient views without timeline writes and persists one revision-fenced final', async () => {
    const root = await mkdtemp(join(tmpdir(), 'classroom-service-transient-')); const store = await JsonClassroomStore.open(root); const service = new ClassroomService(store);
    const created = await store.createClassroom('Transient'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const messages: string[] = []; await service.subscribe(id, 0, (message) => { messages.push(message.type); return true; }, () => undefined);
    const teacher_view = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_1', page_index: 0,
      zoom_mode: 'percent' as const, zoom_percent: 160, viewport: { center_x_world: 120, center_y_world: -40, zoom_scale: 1.6 },
      active_surface: { kind: 'textbook_page' as const, material_id: 'material_1', page_index: 0 }, revision: 1, updated_at: '2026-07-20T12:00:00Z',
    };
    await service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'pan_1', transient_sequence: 1, base_revision: 0 });
    expect((await store.getTimeline(id)).filter((item) => item.kind === 'teacher_view')).toHaveLength(0);
    await expect(service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'pan_1', transient_sequence: 1, base_revision: 0 })).rejects.toThrow('transient_stale');
    const final = await service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'pan_1', transient_sequence: 2, base_revision: 0, final: true });
    expect(final.durable).toBe(true);
    const retry = await service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'pan_1', transient_sequence: 2, base_revision: 0, final: true });
    expect(retry).toEqual(final);
    const laterView = { ...teacher_view, viewport: { ...teacher_view.viewport, center_x_world: 240 }, revision: 2, updated_at: '2026-07-20T12:00:01Z' };
    await service.updateTransientTeacherView(id, { teacher_view: laterView, interaction_id: 'pan_2', transient_sequence: 1, base_revision: 1, final: true });
    expect(await service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'pan_1', transient_sequence: 2, base_revision: 0, final: true })).toEqual(final);
    await expect(service.updateTransientTeacherView(id, { teacher_view: { ...teacher_view, zoom_percent: 170 }, interaction_id: 'pan_1', transient_sequence: 2, base_revision: 0, final: true })).rejects.toThrow('idempotency_conflict');
    expect((await store.getTimeline(id)).filter((item) => item.kind === 'teacher_view')).toHaveLength(2);
    expect(messages).toContain('teacher_view_transient'); expect(messages).toContain('teacher_view');
    await expect(service.updateTransientTeacherView(id, { teacher_view: { ...teacher_view, revision: 2 }, interaction_id: 'stale', transient_sequence: 1, base_revision: 0 })).rejects.toThrow('view_stale');
    const restarted = await JsonClassroomStore.open(root); expect((await restarted.getSnapshot(id)).teacher_view?.viewport).toEqual(laterView.viewport);
    const restartedService = new ClassroomService(restarted);
    expect(await restartedService.updateTransientTeacherView(id, { teacher_view, interaction_id: 'pan_1', transient_sequence: 2, base_revision: 0, final: true })).toEqual(final);
  });

  it('rate limits board commits without changing the accepted ledger', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-service-rate-'))); const service = new ClassroomService(store);
    const created = await store.createClassroom('Rate'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const accepted = Promise.all(Array.from({ length: 40 }, (_, index) => service.appendBoardEvent(id, event(`rate_${index}`))));
    const limited = expect(service.appendBoardEvent(id, event('rate_over'))).rejects.toThrow('stroke_rate_limited');
    await accepted;
    await limited;
    expect(await service.appendBoardEvent(id, event('rate_0'))).toMatchObject({ inserted: false, event: { sequence: 1 } });
    expect((await store.getSnapshot(id)).board_events).toHaveLength(40);
  });

  it('keeps previews transient across restart and fences pending view finals after deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'classroom-service-recovery-')); const store = await JsonClassroomStore.open(root); const service = new ClassroomService(store);
    const created = await store.createClassroom('Recovery'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const messages: string[] = []; await service.subscribe(id, 0, (message) => { messages.push(message.type); return true; }, () => undefined);
    await service.publishPreview(id, { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, client_event_id: 'preview_recovery', revision: 1, points: [{ x_norm: 0.1, y_norm: 0.1, t_ms: 1 }], tool: 'pen', expires_at_ms: Date.now() + 1_000 });
    expect(messages).toContain('preview'); expect((await store.getSnapshot(id)).board_events).toHaveLength(0); expect(await store.getTimeline(id)).toHaveLength(0);
    const teacher_view = { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_1', page_index: 0, zoom_mode: 'percent' as const, zoom_percent: 100, viewport: { center_x_world: 10, center_y_world: 20, zoom_scale: 1 }, active_surface: { kind: 'textbook_page' as const, material_id: 'material_1', page_index: 0 }, revision: 1, updated_at: '2026-07-20T12:00:00Z' };
    await service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'delete_pan', transient_sequence: 1, base_revision: 0 });
    await store.transition(id, 'ended'); await service.deleteClassroom(id);
    await expect(service.updateTransientTeacherView(id, { teacher_view, interaction_id: 'delete_pan', transient_sequence: 2, base_revision: 0, final: true })).rejects.toThrow('classroom_not_found');
    const restarted = await JsonClassroomStore.open(root); expect(await restarted.getClassroom(id)).toBeNull();
  });
});
