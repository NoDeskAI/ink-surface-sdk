import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION, CLASSROOM_WORLD_GEOMETRY_VERSION, type ClassroomBoardEvent, type ClassroomBoardEventInput, type ClassroomRecognitionRevision, type ClassroomRecordingState, type ClassroomTranscriptRevision } from 'ink-surface-sdk/runtime-schema';
import { JsonClassroomStore } from './classroom-store';

function boardEvent(clientEventId: string, x = 0.1): Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'> {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION,
    classroom_id: 'placeholder',
    client_event_id: clientEventId,
    event: {
      event_id: `ink_${clientEventId}`,
      trace_id: `trace_${clientEventId}`,
      session_id: 'placeholder',
      surface_id: 'board',
      pen_id: 'teacher_pointer',
      event_type: 'stroke',
      stroke_refs: [`stroke_${clientEventId}`],
      bbox_norm: [x, 0.1, 0.1, 0.1],
      ts_start_ms: 100,
      ts_end_ms: 120,
      source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 },
      metadata: { mode: 'teach', tool: 'pen' },
    },
    stroke: {
      stroke_id: `stroke_${clientEventId}`,
      session_id: 'placeholder',
      surface_id: 'board',
      pen_id: 'teacher_pointer',
      points: [{ x_norm: x, y_norm: 0.1, t_ms: 100 }],
      bbox_norm: [x, 0.1, 0.1, 0.1],
      ts_start_ms: 100,
      ts_end_ms: 120,
    },
  };
}

function worldBoardEvent(clientEventId: string, materialId: string): Extract<ClassroomBoardEventInput, { geometry_version: 'classroom_page_world_v1' }> {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION,
    classroom_id: 'placeholder',
    client_event_id: clientEventId,
    geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION,
    surface: { kind: 'textbook_page', material_id: materialId, page_index: 0 },
    event: {
      event_id: `ink_${clientEventId}`, trace_id: `trace_${clientEventId}`, session_id: 'placeholder', surface_id: 'page:0', pen_id: 'teacher_pointer',
      event_type: 'stroke', stroke_refs: [`stroke_${clientEventId}`], bbox_world: [-24, 40, 180, 36], ts_start_ms: 200, ts_end_ms: 240,
      source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' },
    },
    stroke: {
      stroke_id: `stroke_${clientEventId}`, session_id: 'placeholder', surface_id: 'page:0', pen_id: 'teacher_pointer',
      points_world: [{ x_world: -24, y_world: 40, t_ms: 200 }, { x_world: 156, y_world: 76, t_ms: 240 }],
      bbox_world: [-24, 40, 180, 36], ts_start_ms: 200, ts_end_ms: 240,
    },
  };
}

describe('JsonClassroomStore', () => {
  function recording(classroomId: string, state: ClassroomRecordingState['state'] = 'recording'): ClassroomRecordingState {
    return {
      recording_id: 'recording_store', classroom_id: classroomId, classroom_generation: 2, recording_generation: 1,
      state, health: state === 'recording' ? 'healthy' : 'incomplete', sample_rate: 16_000, channels: 1,
      chunk_count: 1, byte_count: 4, last_sequence: 1, last_relative_end_ms: 10,
      started_at: '2026-07-19T01:00:00.000Z',
      ...(state === 'stopped' ? { stopped_at: '2026-07-19T01:00:01.000Z' } : {}),
      ...(state === 'interrupted' ? { interrupted_at: '2026-07-19T01:00:01.000Z' } : {}),
    };
  }

  it('persists classroom roles, distinct same-name participants, events, and private records across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Algebra');
    await store.transition(created.classroom.classroom_id, 'live');
    const first = await store.joinClassroom(created.class_code, 'Alex');
    const second = await store.joinClassroom(created.class_code, 'Alex');
    expect(first.participant_id).not.toBe(second.participant_id);
    expect(first.credential).not.toBe(second.credential);

    const accepted = await store.appendBoardEvent(created.classroom.classroom_id, boardEvent('evt_1'));
    expect(accepted.event.sequence).toBe(1);
    await store.putPrivateRecord(created.classroom.classroom_id, first.participant_id, 'job_1', { status: 'completed', content: 'private' });

    const restarted = await JsonClassroomStore.open(root);
    expect((await restarted.authenticate(created.teacher_credential))?.role).toBe('teacher');
    expect((await restarted.authenticate(first.credential))?.participant_id).toBe(first.participant_id);
    expect((await restarted.getSnapshot(created.classroom.classroom_id)).board_events).toHaveLength(1);
    expect(await restarted.getPrivateRecord(created.classroom.classroom_id, first.participant_id, 'job_1')).toMatchObject({ content: 'private' });
    expect(await restarted.getPrivateRecord(created.classroom.classroom_id, second.participant_id, 'job_1')).toBeNull();

    const metaText = await readFile(join(root, created.classroom.classroom_id, 'meta.json'), 'utf8');
    expect(metaText).not.toContain(created.teacher_credential);
    expect(metaText).not.toContain(first.credential);
  });

  it('acknowledges an identical event idempotently and rejects conflicting reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Geometry');
    await store.transition(created.classroom.classroom_id, 'live');

    const first = await store.appendBoardEvent(created.classroom.classroom_id, boardEvent('evt_same'));
    const duplicate = await store.appendBoardEvent(created.classroom.classroom_id, boardEvent('evt_same'));
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.event.sequence).toBe(first.event.sequence);
    await expect(store.appendBoardEvent(created.classroom.classroom_id, boardEvent('evt_same', 0.4))).rejects.toThrow('idempotency_conflict');
    expect((await store.getSnapshot(created.classroom.classroom_id)).board_events).toHaveLength(1);
  });

  it('rejects invalid state actions and makes deletion durable across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Calculus');
    await expect(store.joinClassroom(created.class_code, 'Student')).rejects.toThrow('classroom_not_live');
    await store.transition(created.classroom.classroom_id, 'live');
    const participant = await store.joinClassroom(created.class_code, 'Student');
    await expect(store.deleteClassroom(created.classroom.classroom_id)).rejects.toThrow('classroom_not_ended');
    await store.transition(created.classroom.classroom_id, 'ended');
    await expect(store.joinClassroom(created.class_code, 'Late')).rejects.toThrow('classroom_not_live');
    await expect(store.appendBoardEvent(created.classroom.classroom_id, boardEvent('late_event'))).rejects.toThrow('classroom_not_live');

    await store.deleteClassroom(created.classroom.classroom_id);
    expect(await store.authenticate(created.teacher_credential)).toBeNull();
    expect(await store.authenticate(participant.credential)).toBeNull();
    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.getClassroom(created.classroom.classroom_id)).toBeNull();
  });

  it('serializes concurrent appends and recovers the latest sequence from the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Sequences');
    await store.transition(created.classroom.classroom_id, 'live');

    const accepted = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.appendBoardEvent(created.classroom.classroom_id, boardEvent(`evt_${index}`, 0.01 * index))
    )));
    expect(accepted.map((item) => item.event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const restarted = await JsonClassroomStore.open(root);
    const snapshot = await restarted.getSnapshot(created.classroom.classroom_id);
    expect(snapshot.snapshot_sequence).toBe(20);
    expect(snapshot.board_events.map((event) => event.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('persists world geometry exactly and keeps the timeline point-free across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-world-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('World ledger'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    await store.publishMaterial(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_world', title: 'World', mime_type: 'application/pdf', byte_size: 4,
      content_hash: `sha256:${'c'.repeat(64)}`, page_count: 1, page_geometries: [{ page_index: 0, width_world: 600, height_world: 800, rotation: 0 }], source: 'builtin', published_at: '2026-07-20T00:00:00Z',
    }, Uint8Array.of(1, 2, 3, 4), 'world_material');
    const accepted = await store.appendBoardEvent(id, worldBoardEvent('world_1', 'material_world'));
    expect(accepted.event).toMatchObject({ geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, stroke: { bbox_world: [-24, 40, 180, 36] } });

    const restarted = await JsonClassroomStore.open(root);
    expect((await restarted.getSnapshot(id)).board_events).toEqual([accepted.event]);
    const timeline = await restarted.getTimeline(id);
    expect(timeline.at(-1)).toMatchObject({ kind: 'board_event_ref', event_id: 'ink_world_1', surface: { material_id: 'material_world', page_index: 0 } });
    expect(JSON.stringify(timeline.at(-1))).not.toMatch(/points_world|bbox_world|stroke/);
  });

  it('rejects invalid world geometry atomically before ledger or timeline mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-invalid-world-')); const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Invalid world'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const invalid = worldBoardEvent('invalid_world', 'missing_material');
    invalid.stroke.points_world[0].x_world = Number.NaN;
    await expect(store.appendBoardEvent(id, invalid)).rejects.toThrow('invalid_board_event');
    expect((await store.getSnapshot(id)).board_events).toHaveLength(0); expect(await store.getTimeline(id)).toHaveLength(0);
    const restarted = await JsonClassroomStore.open(root);
    expect((await restarted.getSnapshot(id)).board_events).toHaveLength(0); expect(await restarted.getTimeline(id)).toHaveLength(0);
  });

  it('rebuilds page and classroom quota usage from the durable ledger after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-quota-'));
    const limits = { maxPageEvents: 2, maxClassroomEvents: 3, maxPageBytes: 1_000_000, maxClassroomBytes: 1_000_000 };
    const store = await JsonClassroomStore.open(root, limits); const created = await store.createClassroom('Quota'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    await store.publishMaterial(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_quota', title: 'Quota', mime_type: 'application/pdf', byte_size: 4,
      content_hash: `sha256:${'d'.repeat(64)}`, page_count: 2, page_geometries: [{ page_index: 0, width_world: 600, height_world: 800, rotation: 0 }, { page_index: 1, width_world: 600, height_world: 800, rotation: 0 }], source: 'builtin', published_at: '2026-07-20T00:00:00Z',
    }, Uint8Array.of(1, 2, 3, 4), 'quota_material');
    await store.appendBoardEvent(id, worldBoardEvent('quota_1', 'material_quota')); await store.appendBoardEvent(id, worldBoardEvent('quota_2', 'material_quota'));
    const restarted = await JsonClassroomStore.open(root, limits);
    await expect(restarted.appendBoardEvent(id, worldBoardEvent('quota_page', 'material_quota'))).rejects.toThrow('page_quota_reached');
    const otherPage = worldBoardEvent('quota_3', 'material_quota'); otherPage.surface.page_index = 1; otherPage.event.surface_id = 'page:1'; otherPage.stroke.surface_id = 'page:1';
    await restarted.appendBoardEvent(id, otherPage);
    const overClass = worldBoardEvent('quota_class', 'material_quota'); overClass.surface.page_index = 1; overClass.event.surface_id = 'page:1'; overClass.stroke.surface_id = 'page:1';
    await expect(restarted.appendBoardEvent(id, overClass)).rejects.toThrow('classroom_quota_reached');
    expect((await restarted.getSnapshot(id)).board_events).toHaveLength(3);
  });

  it('enforces page and classroom byte quotas from durable bytes after restart', async () => {
    const pageRoot = await mkdtemp(join(tmpdir(), 'inkloop-classroom-page-bytes-')); const sample = worldBoardEvent('bytes_1', 'material_bytes');
    const setup = async (root: string) => {
      const limits = { maxPageBytes: 1_000_000, maxClassroomBytes: 1_000_000 };
      const store = await JsonClassroomStore.open(root, limits); const created = await store.createClassroom('Byte quota'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
      await store.publishMaterial(id, { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_bytes', title: 'Bytes', mime_type: 'application/pdf', byte_size: 4, content_hash: `sha256:${'e'.repeat(64)}`, page_count: 2, page_geometries: [{ page_index: 0, width_world: 600, height_world: 800, rotation: 0 }, { page_index: 1, width_world: 600, height_world: 800, rotation: 0 }], source: 'builtin', published_at: '2026-07-20T00:00:00Z' }, Uint8Array.of(1, 2, 3, 4), 'bytes_material');
      return { store, id };
    };
    const page = await setup(pageRoot); await page.store.appendBoardEvent(page.id, sample);
    const firstStoredBytes = Buffer.byteLength(JSON.stringify((await page.store.getSnapshot(page.id)).board_events[0]), 'utf8');
    const pageLimits = { maxPageBytes: firstStoredBytes + 1, maxClassroomBytes: 1_000_000 };
    const pageRestarted = await JsonClassroomStore.open(pageRoot, pageLimits);
    await expect(pageRestarted.appendBoardEvent(page.id, worldBoardEvent('bytes_2', 'material_bytes'))).rejects.toThrow('page_quota_reached');

    const classRoot = await mkdtemp(join(tmpdir(), 'inkloop-classroom-class-bytes-'));
    const classroom = await setup(classRoot); await classroom.store.appendBoardEvent(classroom.id, sample);
    const classLimits = { maxPageBytes: 1_000_000, maxClassroomBytes: Buffer.byteLength(JSON.stringify((await classroom.store.getSnapshot(classroom.id)).board_events[0]), 'utf8') + 1 };
    const classRestarted = await JsonClassroomStore.open(classRoot, classLimits); const otherPage = worldBoardEvent('bytes_3', 'material_bytes'); otherPage.surface.page_index = 1; otherPage.event.surface_id = 'page:1'; otherPage.stroke.surface_id = 'page:1';
    await expect(classRestarted.appendBoardEvent(classroom.id, otherPage)).rejects.toThrow('classroom_quota_reached');
  });

  it('never restores a tombstoned classroom after interrupted physical cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-'));
    const tombstone = join(root, 'classroom_interrupted.deleted');
    await mkdir(tombstone, { recursive: true });
    await writeFile(join(tombstone, 'meta.json'), JSON.stringify({ classroom_id: 'classroom_interrupted' }));

    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.getClassroom('classroom_interrupted')).toBeNull();
  });

  it('projects recording state into snapshots and records only lifecycle or health transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-recording-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Recording state'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    const active = recording(id);
    await store.putRecordingState(id, active);
    await store.putRecordingState(id, { ...active, chunk_count: 2, byte_count: 8, last_sequence: 2, last_relative_end_ms: 20 });
    await store.putRecordingState(id, { ...active, health: 'incomplete', chunk_count: 3, byte_count: 12, last_sequence: 4, last_relative_end_ms: 40 });
    const timeline = await store.getTimeline(id);
    expect(timeline.filter((entry) => entry.kind === 'recording_state')).toHaveLength(2);
    expect(await store.getSnapshot(id)).toMatchObject({ recording: { state: 'recording', health: 'incomplete', chunk_count: 3 } });
    expect(JSON.stringify(timeline)).not.toMatch(/pcm_s16le|base64|sdp|ice|candidate/i);
  });

  it('marks active recording interrupted exactly once across repeated reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-recording-reopen-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Interrupted recording'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.putRecordingState(id, recording(id));
    const once = await JsonClassroomStore.open(root);
    const twice = await JsonClassroomStore.open(root);
    expect(await twice.getRecordingState(id)).toMatchObject({ state: 'interrupted', health: 'incomplete' });
    expect((await once.getTimeline(id)).filter((entry) => entry.kind === 'recording_state' && entry.recording.state === 'interrupted')).toHaveLength(1);
    expect((await twice.getTimeline(id)).filter((entry) => entry.kind === 'recording_state' && entry.recording.state === 'interrupted')).toHaveLength(1);
  });

  it('deletes audio files with the classroom and rejects late chunk writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-audio-delete-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Delete audio'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.putRecordingState(id, recording(id));
    await store.putAudioChunk(id, 'recording_store', 'chunk_1', 1, Uint8Array.of(0, 1, 2, 3), 'hash_1');
    const audioDirectory = join(root, id, 'audio'); await access(audioDirectory);
    await store.transition(id, 'ended'); await store.deleteClassroom(id);
    await expect(access(audioDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.putAudioChunk(id, 'recording_store', 'late_chunk', 2, Uint8Array.of(4, 5), 'hash_2')).rejects.toThrow('classroom_not_found');
  });

  it('marks an interrupted private AI job retryable after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-restart-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Restart jobs');
    await store.transition(created.classroom.classroom_id, 'live');
    const participant = await store.joinClassroom(created.class_code, 'Student');
    await store.putPrivateRecord(created.classroom.classroom_id, participant.participant_id, 'job_interrupted', {
      schema_version: CLASSROOM_SCHEMA_VERSION, job_id: 'job_interrupted', classroom_id: created.classroom.classroom_id,
      kind: 'live_explanation', status: 'running', evidence: {}, created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:00.000Z',
    });
    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.getPrivateRecord(created.classroom.classroom_id, participant.participant_id, 'job_interrupted')).toMatchObject({ status: 'failed', error_code: 'service_restarted' });
  });

  it('reconciles a first-stage board ledger into point-free timeline references without changing board sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-timeline-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Legacy board');
    const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    await store.appendBoardEvent(id, boardEvent('legacy_1'));
    await writeFile(join(root, id, 'timeline.jsonl'), '');

    const restarted = await JsonClassroomStore.open(root);
    const snapshot = await restarted.getSnapshot(id);
    const timeline = await restarted.getTimeline(id);
    expect(snapshot.snapshot_sequence).toBe(1);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: 'board_event_ref', board_sequence: 1, event_id: 'ink_legacy_1' });
    expect(JSON.stringify(timeline[0])).not.toContain('points');
  });

  it('persists the latest teacher view and confirmed focus while keeping old classrooms whiteboard-compatible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-view-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Textbook class');
    const id = created.classroom.classroom_id;
    await store.transition(id, 'live');
    await store.updateTeacherView(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, material_id: 'material_1', page_index: 1,
      zoom_mode: 'percent', zoom_percent: 140, active_surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 1 }, revision: 1, updated_at: '2026-07-19T00:00:00.000Z',
    });
    await store.confirmFocus(id, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, focus_id: 'focus_1', material_id: 'material_1', page_index: 1,
      bbox_norm: [0.1, 0.2, 0.4, 0.2], confirmed_at: '2026-07-19T00:00:01.000Z',
    });

    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.getSharedState(id)).toMatchObject({
      teacher_view: { page_index: 1, zoom_percent: 140 }, confirmed_focus: { focus_id: 'focus_1' },
    });
    expect((await restarted.getSnapshot(id)).capabilities).toMatchObject({ textbook: true, recognition: true, audio: true, transcript: true });
  });

  it('drops a corrupt or dangling timeline tail and repairs missing board references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-timeline-repair-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Repair'); const id = created.classroom.classroom_id;
    await store.transition(id, 'live'); await store.appendBoardEvent(id, boardEvent('repair_1'));
    await writeFile(join(root, id, 'timeline.jsonl'), `${JSON.stringify({
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, timeline_sequence: 1, kind: 'board_event_ref', occurred_at: new Date().toISOString(),
      board_sequence: 99, event_id: 'missing', surface: { kind: 'teacher_board' },
    })}\n{broken`);

    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.getTimeline(id)).toMatchObject([{ kind: 'board_event_ref', board_sequence: 1, event_id: 'ink_repair_1' }]);
    expect(await readFile(join(root, id, 'timeline.jsonl'), 'utf8')).not.toContain('missing');
  });

  it('repairs interrupted recognition dual writes and keeps exact revision retries idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-recognition-repair-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Recognition repair'); const id = created.classroom.classroom_id;
    const revision: ClassroomRecognitionRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, recognition_id: 'recognition_repair', revision: 1,
      status: 'pending', kind: 'formula', text: 'x + 2 = +3', latex: 'x+2=+3', confidence: 0.51,
      provider: 'fixture', processing_mode: 'local', event_ids: ['ink_one'], surface: { kind: 'teacher_board' },
      bbox_norm: [0.1, 0.1, 0.3, 0.1], created_at: '2026-07-19T00:00:00.000Z',
    };
    await store.appendRecognitionRevision(id, revision);
    await writeFile(join(root, id, 'timeline.jsonl'), '');

    const restarted = await JsonClassroomStore.open(root);
    expect((await restarted.getTimeline(id)).filter((item) => item.kind === 'recognition_revision')).toHaveLength(1);
    expect(await restarted.listRecognitionRevisions(id)).toEqual([revision]);
    await restarted.appendRecognitionRevision(id, revision);
    expect((await restarted.getTimeline(id)).filter((item) => item.kind === 'recognition_revision')).toHaveLength(1);

    await writeFile(join(root, id, 'teacher', 'recognition_revisions.json'), '[]');
    const timelineAuthoritative = await JsonClassroomStore.open(root);
    expect(await timelineAuthoritative.listRecognitionRevisions(id)).toEqual([revision]);
  });

  it('repairs an interrupted transcript dual write without duplicating its revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-transcript-repair-')); const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Transcript repair'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const transcript: ClassroomTranscriptRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, transcript_id: 'transcript_repair', revision: 1, status: 'final',
      recording_id: 'recording_repair', recording_generation: 1, chunk_id: 'chunk_repair', chunk_hash: `sha256:${'a'.repeat(64)}`,
      relative_start_ms: 0, relative_end_ms: 500, text: '两边加九', confidence: 0.9, language: 'zh-CN', provider: 'fixture', processing_mode: 'local', created_at: '2026-07-19T00:00:00Z',
    };
    const teacher = join(root, id, 'teacher'); await mkdir(teacher, { recursive: true }); await writeFile(join(teacher, 'transcript_revisions.json'), JSON.stringify([transcript]));
    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.listTranscriptRevisions(id)).toEqual([transcript]);
    expect((await restarted.getTimeline(id)).filter((item) => item.kind === 'transcript_revision')).toHaveLength(1);
    await restarted.appendTranscriptRevision(id, transcript);
    expect((await restarted.getTimeline(id)).filter((item) => item.kind === 'transcript_revision')).toHaveLength(1);
  });

  it('accepts eraser tombstones only for active strokes on the same surface', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'inkloop-classroom-eraser-')));
    const created = await store.createClassroom('Eraser'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const stroke = boardEvent('eraser_source');
    const saved = await store.appendBoardEvent(id, stroke);
    const baseErase = boardEvent('eraser_action');
    const erase = {
      ...baseErase,
      event: { ...baseErase.event, event_type: 'erase' as const, metadata: { mode: 'teach' as const, tool: 'eraser' as const, erased_event_ids: [saved.event.event.event_id] } },
    };
    await expect(store.appendBoardEvent(id, erase)).resolves.toMatchObject({ inserted: true });
    await expect(store.appendBoardEvent(id, { ...erase, client_event_id: 'eraser_again', event: { ...erase.event, event_id: 'ink_eraser_again', trace_id: 'trace_eraser_again' } })).rejects.toThrow('invalid_eraser_targets');
  });

  it('clears transcript state and timeline durably without deleting the source audio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-transcript-clear-')); const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Transcript clear'); const id = created.classroom.classroom_id; await store.transition(id, 'live');
    const transcript: ClassroomTranscriptRevision = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: id, transcript_id: 'transcript_clear', revision: 1, status: 'final',
      recording_id: 'recording_clear', recording_generation: 1, chunk_id: 'chunk_clear', chunk_hash: `sha256:${'b'.repeat(64)}`,
      relative_start_ms: 0, relative_end_ms: 500, text: '需要清空', confidence: 0.9, language: 'zh-en', provider: 'fixture', processing_mode: 'local', created_at: '2026-07-21T00:00:00Z',
    };
    await store.appendTranscriptRevision(id, transcript);
    await store.putAudioChunk(id, 'recording_clear', 'chunk_clear', 1, new Uint8Array([1, 2]), 'b'.repeat(64), {
      classroom_generation: 2, recording_generation: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 500,
    });
    const marker = await store.clearTranscriptHistory(id);
    expect(marker.cleared_chunks).toContainEqual({ recording_id: 'recording_clear', chunk_id: 'chunk_clear' });
    expect(await store.listTranscriptRevisions(id)).toEqual([]);
    expect((await store.getTimeline(id)).some((item) => item.kind === 'transcript_revision' || item.kind === 'transcription_state')).toBe(false);
    expect(await store.getAudioChunk(id, 'recording_clear', 'chunk_clear')).toEqual(new Uint8Array([1, 2]));
    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.listTranscriptRevisions(id)).toEqual([]);
    expect(await restarted.isTranscriptChunkCleared(id, 'recording_clear', 'chunk_clear')).toBe(true);
  });

  it('infers whiteboard-only capabilities for a first-stage classroom directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-classroom-legacy-capabilities-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Legacy'); const id = created.classroom.classroom_id;
    const metaPath = join(root, id, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete meta.capabilities; delete meta.generation; delete meta.materials;
    await writeFile(metaPath, JSON.stringify(meta));

    const restarted = await JsonClassroomStore.open(root);
    expect((await restarted.getSnapshot(id)).capabilities).toEqual({ textbook: false, recognition: false, audio: false, transcript: false });
  });
});
