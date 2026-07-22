import {
  validateClassroomTeacherView,
  validateClassroomPreview,
  type ClassroomBoardEvent,
  type ClassroomBoardEventInput,
  type ClassroomConfirmedFocus,
  type ClassroomMaterial,
  type ClassroomPreview,
  type ClassroomRecognitionRevision,
  type ClassroomRecordingState,
  type ClassroomTranscriptRevision,
  type ClassroomTranscriptionState,
  type ClassroomTeacherView,
} from 'ink-surface-sdk/runtime-schema';
import type { JsonClassroomStore } from './classroom-store';

export type ClassroomStreamMessage =
  | { type: 'board_event'; sequence: number; board_event: ClassroomBoardEvent }
  | { type: 'preview'; preview: ClassroomPreview }
  | { type: 'teacher_view'; teacher_view: ClassroomTeacherView }
  | { type: 'teacher_view_transient'; teacher_view: ClassroomTeacherView; interaction_id: string; transient_sequence: number; base_revision: number }
  | { type: 'confirmed_focus'; confirmed_focus: ClassroomConfirmedFocus }
  | { type: 'material_published'; material: ClassroomMaterial }
  | { type: 'recognition_revision'; recognition: ClassroomRecognitionRevision }
  | { type: 'recording_state'; recording: ClassroomRecordingState }
  | { type: 'transcript_revision'; transcript: ClassroomTranscriptRevision }
  | { type: 'transcription_state'; transcription: ClassroomTranscriptionState }
  | { type: 'transcripts_cleared'; cleared_at: string }
  | { type: 'class_state'; status: 'draft' | 'live' | 'ended' }
  | { type: 'resync_required'; reason: 'slow_client' | 'replay_too_large' }
  | { type: 'class_deleted' };

interface Subscriber {
  send: (message: ClassroomStreamMessage) => void;
  close: () => void;
}

export class ClassroomService {
  static readonly MAX_SUBSCRIBERS_PER_CLASSROOM = 128;
  static readonly MAX_REPLAY_EVENTS = 5_000;
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly transientViews = new Map<string, { interactionId: string; sequence: number; baseRevision: number }>();
  private readonly eventBuckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly previewRates = new Map<string, number[]>();
  private readonly transientPublishedAt = new Map<string, number>();

  constructor(readonly store: JsonClassroomStore) {}

  private publish(classroomId: string, message: ClassroomStreamMessage): void {
    for (const subscriber of this.subscribers.get(classroomId) ?? []) subscriber.send(message);
  }

  async appendBoardEvent(classroomId: string, input: ClassroomBoardEventInput | Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'>): Promise<{ event: ClassroomBoardEvent; inserted: boolean }> {
    if (this.store.getBoardEventByClientId(classroomId, input.client_event_id)) return this.store.appendBoardEvent(classroomId, input);
    const now = Date.now(); const previous = this.eventBuckets.get(classroomId) ?? { tokens: 40, updatedAt: now };
    const bucket = { tokens: Math.min(40, previous.tokens + Math.max(0, now - previous.updatedAt) * 20 / 1_000), updatedAt: now };
    if (bucket.tokens < 1) { this.eventBuckets.set(classroomId, bucket); throw new Error('stroke_rate_limited'); }
    bucket.tokens -= 1; this.eventBuckets.set(classroomId, bucket);
    try {
      const accepted = await this.store.appendBoardEvent(classroomId, input);
      if (accepted.inserted) this.publish(classroomId, { type: 'board_event', sequence: accepted.event.sequence, board_event: accepted.event });
      else bucket.tokens = Math.min(40, bucket.tokens + 1);
      return accepted;
    } catch (error) {
      bucket.tokens = Math.min(40, bucket.tokens + 1);
      throw error;
    }
  }

  async publishPreview(classroomId: string, preview: ClassroomPreview): Promise<void> {
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    if (classroom.status !== 'live') throw new Error('classroom_not_live');
    const normalized = { ...preview, classroom_id: classroomId };
    const issues = validateClassroomPreview(normalized);
    if (issues.length) throw new Error(`invalid_preview:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
    if (normalized.geometry_version === 'classroom_page_world_v1') {
      const material = (await this.store.getSharedState(classroomId)).materials.find((item) => item.material_id === normalized.surface.material_id);
      if (!material || normalized.surface.page_index >= material.page_count) throw new Error('material_page_not_found');
    }
    const now = Date.now(); const recent = (this.previewRates.get(classroomId) ?? []).filter((time) => now - time < 1_000);
    if (recent.length >= 15) throw new Error('preview_rate_limited');
    recent.push(now); this.previewRates.set(classroomId, recent); this.publish(classroomId, { type: 'preview', preview: normalized });
  }

  async updateTeacherView(classroomId: string, teacherView: ClassroomTeacherView): Promise<ClassroomTeacherView> {
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    if (classroom.status === 'ended') throw new Error('classroom_not_live');
    const issues = validateClassroomTeacherView(teacherView);
    if (issues.length) throw new Error(`invalid_teacher_view:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
    const shared = await this.store.getSharedState(classroomId);
    if (shared.materials.length > 0) {
      const material = shared.materials.find((item) => item.material_id === teacherView.material_id);
      if (!material || teacherView.page_index >= material.page_count) throw new Error('material_page_not_found');
    }
    const value = await this.store.updateTeacherView(classroomId, teacherView);
    this.publish(classroomId, { type: 'teacher_view', teacher_view: value });
    return value;
  }

  async updateTransientTeacherView(classroomId: string, input: { teacher_view: ClassroomTeacherView; interaction_id: string; transient_sequence: number; base_revision: number; final?: boolean }): Promise<{ teacher_view: ClassroomTeacherView; durable: boolean }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.interaction_id)) throw new Error('interaction_id_invalid');
    if (!Number.isInteger(input.transient_sequence) || input.transient_sequence < 1) throw new Error('transient_sequence_invalid');
    const classroom = await this.store.getClassroom(classroomId); if (!classroom) throw new Error('classroom_not_found'); if (classroom.status !== 'live') throw new Error('classroom_not_live');
    const issues = validateClassroomTeacherView(input.teacher_view); if (issues.length) throw new Error(`invalid_teacher_view:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
    const shared = await this.store.getSharedState(classroomId);
    if (shared.materials.length > 0) {
      const material = shared.materials.find((item) => item.material_id === input.teacher_view.material_id);
      if (!material || input.teacher_view.page_index < 0 || input.teacher_view.page_index >= material.page_count) throw new Error('material_page_not_found');
    }
    const key = `${classroomId}:${input.interaction_id}`;
    if (input.final) {
      const value = await this.store.updateTeacherView(classroomId, input.teacher_view, `${input.interaction_id}_${input.transient_sequence}`, input.base_revision);
      this.transientViews.delete(key); this.publish(classroomId, { type: 'teacher_view', teacher_view: value }); return { teacher_view: value, durable: true };
    }
    const durable = (await this.store.getSharedState(classroomId)).teacher_view;
    if ((durable?.revision ?? 0) !== input.base_revision) throw new Error('view_stale');
    const previous = this.transientViews.get(key);
    if (previous && input.transient_sequence <= previous.sequence) throw new Error('transient_stale');
    if (input.teacher_view.revision !== input.base_revision + 1) throw new Error('view_revision_invalid');
    this.transientViews.set(key, { interactionId: input.interaction_id, sequence: input.transient_sequence, baseRevision: input.base_revision });
    const now = Date.now(); const last = this.transientPublishedAt.get(classroomId) ?? 0;
    if (now - last >= 84) {
      this.transientPublishedAt.set(classroomId, now);
      this.publish(classroomId, { type: 'teacher_view_transient', teacher_view: input.teacher_view, interaction_id: input.interaction_id, transient_sequence: input.transient_sequence, base_revision: input.base_revision });
    }
    return { teacher_view: input.teacher_view, durable: false };
  }

  async confirmFocus(classroomId: string, focus: ClassroomConfirmedFocus): Promise<ClassroomConfirmedFocus> {
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    if (classroom.status !== 'live') throw new Error('classroom_not_live');
    const shared = await this.store.getSharedState(classroomId);
    if (shared.materials.length > 0) {
      const material = shared.materials.find((item) => item.material_id === focus.material_id);
      if (!material || focus.page_index >= material.page_count) throw new Error('material_page_not_found');
    }
    const value = await this.store.confirmFocus(classroomId, focus);
    this.publish(classroomId, { type: 'confirmed_focus', confirmed_focus: value });
    return value;
  }

  publishMaterial(classroomId: string, material: ClassroomMaterial): void {
    this.publish(classroomId, { type: 'material_published', material });
  }

  publishRecognition(classroomId: string, recognition: ClassroomRecognitionRevision): void {
    this.publish(classroomId, { type: 'recognition_revision', recognition });
  }

  publishRecording(classroomId: string, recording: ClassroomRecordingState): void {
    this.publish(classroomId, { type: 'recording_state', recording });
  }

  publishTranscript(classroomId: string, transcript: ClassroomTranscriptRevision): void {
    this.publish(classroomId, { type: 'transcript_revision', transcript });
  }

  publishTranscription(classroomId: string, transcription: ClassroomTranscriptionState): void {
    this.publish(classroomId, { type: 'transcription_state', transcription });
  }

  publishTranscriptsCleared(classroomId: string, clearedAt: string): void {
    this.publish(classroomId, { type: 'transcripts_cleared', cleared_at: clearedAt });
  }

  async transition(classroomId: string, next: 'live' | 'ended'): Promise<unknown> {
    const classroom = await this.store.transition(classroomId, next);
    this.publish(classroomId, { type: 'class_state', status: next });
    return classroom;
  }

  async subscribe(
    classroomId: string,
    cursor: number,
    send: (message: ClassroomStreamMessage) => boolean,
    onClose: () => void,
  ): Promise<{ close: () => void }> {
    const classroom = await this.store.getClassroom(classroomId);
    if (!classroom) throw new Error('classroom_not_found');
    const set = this.subscribers.get(classroomId) ?? new Set<Subscriber>();
    if (set.size >= ClassroomService.MAX_SUBSCRIBERS_PER_CLASSROOM) throw new Error('stream_limit_reached');
    this.subscribers.set(classroomId, set);
    let active = true;
    let delivered = cursor;
    const pending = new Map<number, ClassroomStreamMessage & { type: 'board_event' }>();
    const deliver = (message: ClassroomStreamMessage): void => {
      if (!active) return;
      if (message.type !== 'board_event') {
        if (!send(message)) {
          send({ type: 'resync_required', reason: 'slow_client' });
          subscriber.close();
        }
        return;
      }
      if (message.sequence <= delivered) return;
      pending.set(message.sequence, message);
      for (;;) {
        const next = pending.get(delivered + 1);
        if (!next) break;
        pending.delete(delivered + 1);
        delivered = next.sequence;
        if (!send(next)) {
          send({ type: 'resync_required', reason: 'slow_client' });
          subscriber.close();
          break;
        }
      }
    };
    const subscriber: Subscriber = {
      send: deliver,
      close() {
        if (!active) return;
        active = false;
        set.delete(subscriber);
        if (set.size === 0) thisService.subscribers.delete(classroomId);
        onClose();
      },
    };
    const thisService = this;

    // Register before replay; duplicate delivery during the handoff is suppressed by sequence.
    set.add(subscriber);
    const replay = await this.store.eventsAfter(classroomId, cursor);
    if (replay.length > ClassroomService.MAX_REPLAY_EVENTS) {
      subscriber.send({ type: 'resync_required', reason: 'replay_too_large' });
      subscriber.close();
      return { close: () => undefined };
    }
    for (const event of replay) {
      subscriber.send({ type: 'board_event', sequence: event.sequence, board_event: event });
    }
    const shared = await this.store.getSharedState(classroomId);
    for (const material of shared.materials) subscriber.send({ type: 'material_published', material });
    if (shared.teacher_view) subscriber.send({ type: 'teacher_view', teacher_view: shared.teacher_view });
    if (shared.confirmed_focus) subscriber.send({ type: 'confirmed_focus', confirmed_focus: shared.confirmed_focus });
    for (const recognition of await this.store.listRecognitionRevisions(classroomId)) subscriber.send({ type: 'recognition_revision', recognition });
    const recording = await this.store.getRecordingState(classroomId); if (recording) subscriber.send({ type: 'recording_state', recording });
    for (const transcript of await this.store.listTranscriptRevisions(classroomId)) subscriber.send({ type: 'transcript_revision', transcript });
    const transcription = await this.store.getTranscriptionState(classroomId); if (transcription) subscriber.send({ type: 'transcription_state', transcription });
    return { close: () => subscriber.close() };
  }

  async deleteClassroom(classroomId: string): Promise<void> {
    const set = [...(this.subscribers.get(classroomId) ?? [])];
    await this.store.deleteClassroom(classroomId);
    for (const key of this.transientViews.keys()) if (key.startsWith(`${classroomId}:`)) this.transientViews.delete(key);
    this.eventBuckets.delete(classroomId);
    this.previewRates.delete(classroomId); this.transientPublishedAt.delete(classroomId);
    for (const subscriber of set) {
      subscriber.send({ type: 'class_deleted' });
      subscriber.close();
    }
  }
}
