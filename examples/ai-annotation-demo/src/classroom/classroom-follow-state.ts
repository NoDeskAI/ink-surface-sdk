import { validateClassroomTeacherView, type ClassroomConfirmedFocus, type ClassroomMaterial, type ClassroomTeacherView } from 'ink-surface-sdk/runtime-schema';

export type ClassroomFollowMode = 'follow_teacher' | 'free_browse';

export interface ClassroomFollowState {
  mode: ClassroomFollowMode;
  teacher_view?: ClassroomTeacherView;
  teacher_focus?: ClassroomConfirmedFocus;
  visible_view?: ClassroomTeacherView;
  visible_focus?: ClassroomConfirmedFocus;
  pending_teacher_update?: boolean;
  durable_revision?: number;
  transient_projection?: { interaction_id: string; transient_sequence: number; base_revision: number };
}

function latestFocus(current?: ClassroomConfirmedFocus, incoming?: ClassroomConfirmedFocus): ClassroomConfirmedFocus | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.confirmed_at > current.confirmed_at ? incoming : current;
}

export function applyTeacherProjection(state: ClassroomFollowState, view?: ClassroomTeacherView, focus?: ClassroomConfirmedFocus): ClassroomFollowState {
  if (!view && latestFocus(state.teacher_focus, focus) === state.teacher_focus) return state;
  const durableRevision = state.durable_revision ?? (state.transient_projection ? state.transient_projection.base_revision : state.teacher_view?.revision ?? 0);
  if (view && view.revision <= durableRevision) {
    const teacherFocus = latestFocus(state.teacher_focus, focus);
    if (teacherFocus === state.teacher_focus) return state;
    return applyTeacherProjection({ ...state, teacher_focus: teacherFocus }, undefined);
  }
  const teacherView = view ?? state.teacher_view;
  const teacherFocus = latestFocus(state.teacher_focus, focus);
  const nextDurableRevision = view?.revision ?? durableRevision;
  if (state.mode === 'free_browse') {
    return { ...state, teacher_view: teacherView, teacher_focus: teacherFocus, durable_revision: nextDurableRevision, transient_projection: undefined, pending_teacher_update: true };
  }
  return {
    ...state,
    mode: 'follow_teacher',
    teacher_view: teacherView,
    teacher_focus: teacherFocus,
    visible_view: teacherView,
    visible_focus: teacherFocus,
    durable_revision: nextDurableRevision,
    transient_projection: undefined,
    pending_teacher_update: false,
  };
}

export function applyTransientTeacherProjection(
  state: ClassroomFollowState,
  view: ClassroomTeacherView,
  projection: { interaction_id: string; transient_sequence: number; base_revision: number },
): ClassroomFollowState {
  const durableRevision = state.durable_revision ?? state.teacher_view?.revision ?? 0;
  if (projection.base_revision !== durableRevision || view.revision !== projection.base_revision + 1) return state;
  const previous = state.transient_projection;
  if (previous?.interaction_id === projection.interaction_id && projection.transient_sequence <= previous.transient_sequence) return state;
  const next = { ...state, teacher_view: view, transient_projection: projection, durable_revision: durableRevision };
  if (state.mode === 'free_browse') return { ...next, pending_teacher_update: true };
  return { ...next, visible_view: view, pending_teacher_update: false };
}

export function enterFreeBrowse(state: ClassroomFollowState, localView: ClassroomTeacherView): ClassroomFollowState {
  return { ...state, mode: 'free_browse', visible_view: localView, visible_focus: undefined, pending_teacher_update: false };
}

export function applyStudentBrowseIntent(state: ClassroomFollowState, localView: ClassroomTeacherView): ClassroomFollowState {
  return state.mode === 'free_browse' ? enterFreeBrowse(state, localView) : state;
}

export function returnToTeacher(state: ClassroomFollowState): ClassroomFollowState {
  return {
    ...state,
    mode: 'follow_teacher',
    visible_view: state.teacher_view,
    visible_focus: state.teacher_focus,
    pending_teacher_update: false,
  };
}

export function restoreLocalFollowState(value: unknown, classroomId: string, materials: readonly ClassroomMaterial[]): ClassroomFollowState {
  if (!value || typeof value !== 'object') return { mode: 'follow_teacher' };
  const saved = value as { schema_version?: unknown; mode?: unknown; visible_view?: unknown };
  if (saved.schema_version !== 2 || saved.mode !== 'free_browse' || validateClassroomTeacherView(saved.visible_view).length > 0) return { mode: 'follow_teacher' };
  const view = saved.visible_view as ClassroomTeacherView;
  const material = materials.find((item) => item.classroom_id === classroomId && item.material_id === view.material_id);
  if (view.classroom_id !== classroomId || !material || view.page_index >= material.page_count) return { mode: 'follow_teacher' };
  if (view.viewport && (view.viewport.zoom_scale < 0.5 || view.viewport.zoom_scale > 4)) return { mode: 'follow_teacher' };
  for (const [key, viewport] of Object.entries(view.page_viewports ?? {})) {
    const separator = key.lastIndexOf(':'); const materialId = key.slice(0, separator); const pageIndex = Number(key.slice(separator + 1));
    const pageMaterial = materials.find((item) => item.classroom_id === classroomId && item.material_id === materialId);
    if (!pageMaterial || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageMaterial.page_count || viewport.zoom_scale < 0.5 || viewport.zoom_scale > 4) return { mode: 'follow_teacher' };
  }
  return { mode: 'free_browse', visible_view: view };
}
