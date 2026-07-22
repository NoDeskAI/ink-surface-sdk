import { describe, expect, it } from 'vitest';
import type { ClassroomConfirmedFocus, ClassroomMaterial, ClassroomTeacherView } from 'ink-surface-sdk/runtime-schema';
import { applyStudentBrowseIntent, applyTeacherProjection, applyTransientTeacherProjection, enterFreeBrowse, restoreLocalFollowState, returnToTeacher, type ClassroomFollowState } from './classroom-follow-state';

const view = (revision: number, pageIndex: number): ClassroomTeacherView => ({
  schema_version: 'inkloop.classroom.v1', classroom_id: 'classroom_1', material_id: 'material_1', page_index: pageIndex,
  zoom_mode: 'percent', zoom_percent: 125, active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: pageIndex },
  revision, updated_at: `2026-07-19T00:00:0${revision}.000Z`,
});
const focus: ClassroomConfirmedFocus = { schema_version: 'inkloop.classroom.v1', classroom_id: 'classroom_1', focus_id: 'focus_1', material_id: 'material_1', page_index: 2, bbox_norm: [0.1, 0.2, 0.3, 0.15], confirmed_at: '2026-07-19T00:00:03.000Z' };
const material: ClassroomMaterial = { schema_version: 'inkloop.classroom.v1', classroom_id: 'classroom_1', material_id: 'material_1', title: 'Math', mime_type: 'application/pdf', byte_size: 10, content_hash: `sha256:${'a'.repeat(64)}`, page_count: 3, source: 'builtin', published_at: '2026-07-19T00:00:00.000Z' };

describe('classroom follow state', () => {
  it('applies teacher updates while following and queues them while free browsing', () => {
    const initial: ClassroomFollowState = { mode: 'follow_teacher' };
    const following = applyTeacherProjection(initial, view(1, 1), undefined);
    expect(following).toMatchObject({ mode: 'follow_teacher', visible_view: { page_index: 1 }, pending_teacher_update: false });
    const free = enterFreeBrowse(following, { ...view(1, 0), zoom_percent: 90 });
    const pending = applyTeacherProjection(free, view(2, 2), focus);
    expect(pending).toMatchObject({ mode: 'free_browse', visible_view: { page_index: 0 }, teacher_view: { page_index: 2 }, pending_teacher_update: true });
    expect(pending.visible_focus).toBeUndefined();
  });

  it('returns atomically to the latest teacher page, zoom and confirmed focus', () => {
    const pending = applyTeacherProjection(enterFreeBrowse({ mode: 'follow_teacher' }, view(1, 0)), view(2, 2), focus);
    expect(returnToTeacher(pending)).toMatchObject({ mode: 'follow_teacher', visible_view: { page_index: 2, zoom_percent: 125 }, visible_focus: { focus_id: 'focus_1' }, pending_teacher_update: false });
  });

  it('does not let gestures silently leave follow mode', () => {
    const following = applyTeacherProjection({ mode: 'follow_teacher' }, view(1, 1));
    expect(applyStudentBrowseIntent(following, view(1, 0))).toBe(following);
    const browsing = enterFreeBrowse(following, view(1, 1));
    expect(applyStudentBrowseIntent(browsing, view(1, 0))).toMatchObject({ mode: 'free_browse', visible_view: { page_index: 0 } });
  });

  it('accepts only transient views based on the current durable revision and in sequence', () => {
    const durable = applyTeacherProjection({ mode: 'follow_teacher' }, view(2, 0));
    const transient = applyTransientTeacherProjection(durable, view(3, 1), { interaction_id: 'pan_1', transient_sequence: 2, base_revision: 2 });
    expect(transient.visible_view?.page_index).toBe(1);
    expect(applyTransientTeacherProjection(transient, view(3, 2), { interaction_id: 'pan_1', transient_sequence: 1, base_revision: 2 })).toBe(transient);
    expect(applyTransientTeacherProjection(transient, view(2, 2), { interaction_id: 'old', transient_sequence: 3, base_revision: 1 })).toBe(transient);
  });

  it('clears an old transient on durable arrival and ignores late durable revisions', () => {
    const durable = applyTeacherProjection({ mode: 'follow_teacher' }, view(2, 0));
    const transient = applyTransientTeacherProjection(durable, view(3, 1), { interaction_id: 'pan_1', transient_sequence: 1, base_revision: 2 });
    const finalized = applyTeacherProjection(transient, view(3, 2));
    expect(finalized).toMatchObject({ teacher_view: { page_index: 2, revision: 3 }, visible_view: { page_index: 2 }, durable_revision: 3 });
    expect(finalized.transient_projection).toBeUndefined();
    expect(applyTeacherProjection(finalized, view(2, 0))).toBe(finalized);
    expect(applyTransientTeacherProjection(finalized, view(3, 1), { interaction_id: 'late', transient_sequence: 9, base_revision: 2 })).toBe(finalized);
  });

  it('does not let an older confirmed focus replay overwrite a newer streamed focus', () => {
    const newer = { ...focus, focus_id: 'focus_new', confirmed_at: '2026-07-20T12:00:02.000Z' };
    const older = { ...focus, focus_id: 'focus_old', confirmed_at: '2026-07-20T12:00:01.000Z' };
    const current = applyTeacherProjection({ mode: 'follow_teacher' }, view(1, 0), newer);
    expect(applyTeacherProjection(current, undefined, older)).toBe(current);
  });

  it('restores only versioned finite local views that still reference published pages', () => {
    const local = { ...view(2, 1), viewport: { center_x_world: 10, center_y_world: -20, zoom_scale: 1.5 }, page_viewports: { 'material_1:1': { center_x_world: 10, center_y_world: -20, zoom_scale: 1.5 } } };
    expect(restoreLocalFollowState({ schema_version: 2, mode: 'free_browse', visible_view: local }, 'classroom_1', [material])).toMatchObject({ mode: 'free_browse', visible_view: { page_index: 1 } });
    expect(restoreLocalFollowState({ schema_version: 1, mode: 'free_browse', visible_view: local }, 'classroom_1', [material]).mode).toBe('follow_teacher');
    expect(restoreLocalFollowState({ schema_version: 2, mode: 'free_browse', visible_view: { ...local, page_index: 3 } }, 'classroom_1', [material]).mode).toBe('follow_teacher');
    expect(restoreLocalFollowState({ schema_version: 2, mode: 'free_browse', visible_view: { ...local, material_id: 'deleted' } }, 'classroom_1', [material]).mode).toBe('follow_teacher');
    expect(restoreLocalFollowState({ schema_version: 2, mode: 'free_browse', visible_view: { ...local, page_viewports: { 'material_1:99': local.viewport } } }, 'classroom_1', [material]).mode).toBe('follow_teacher');
    expect(restoreLocalFollowState({ schema_version: 2, mode: 'free_browse', visible_view: { ...local, viewport: { ...local.viewport, center_x_world: Number.NaN } } }, 'classroom_1', [material]).mode).toBe('follow_teacher');
  });
});
