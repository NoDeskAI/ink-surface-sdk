import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLASSROOM_SCHEMA_VERSION,
  validateClassroomBoardEvent,
  validateClassroomConfirmedFocus,
  validateClassroomRecognitionRevision,
  validateClassroomTranscriptRevision,
  validateClassroomTranscriptionState,
  validateClassroomTeacherView,
  validateClassroomTimelineEntry,
  type ClassroomBoardEvent,
  type ClassroomBoardEventInput,
  type ClassroomCapabilities,
  type ClassroomConfirmedFocus,
  type ClassroomMaterial,
  type ClassroomRecognitionRevision,
  type ClassroomRecordingState,
  type ClassroomTranscriptRevision,
  type ClassroomTranscriptionState,
  type ClassroomSessionSummary,
  type ClassroomSharedState,
  type ClassroomSnapshot,
  type ClassroomStatus,
  type ClassroomTeacherView,
  type ClassroomTimelineEntry,
} from 'ink-surface-sdk/runtime-schema';
import { createClassCode, createOpaqueCredential, credentialHash, normalizeNickname, safeClassroomTitle } from './classroom-auth';
import { activeBoardEvents, boxesIntersect, eventBBox, sameSurface } from '../shared/classroom/classroom-spatial';

interface StoredParticipant {
  participant_id: string;
  nickname: string;
  credential_hash: string;
  joined_at: string;
}

interface StoredClassroom {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  title: string;
  status: ClassroomStatus;
  class_code_hash: string;
  teacher_credential_hash: string;
  participants: StoredParticipant[];
  latest_sequence: number;
  generation?: number;
  capabilities?: ClassroomCapabilities;
  latest_timeline_sequence?: number;
  board_timeline_watermark?: number;
  materials?: ClassroomMaterial[];
  material_upload_keys?: Record<string, string>;
  teacher_view?: ClassroomTeacherView;
  teacher_view_final_keys?: Record<string, number>;
  confirmed_focus?: ClassroomConfirmedFocus;
  created_at: string;
  started_at?: string;
  ended_at?: string;
}

interface ClassroomMemory {
  meta: StoredClassroom;
  events: ClassroomBoardEvent[];
  timeline: ClassroomTimelineEntry[];
}

export interface ClassroomTranscriptClearMarker {
  cleared_at: string;
  cleared_chunks: Array<{ recording_id: string; chunk_id: string }>;
}

export interface ClassroomStoreLimits {
  maxPageEvents?: number;
  maxClassroomEvents?: number;
  maxPageBytes?: number;
  maxClassroomBytes?: number;
  maxClassrooms?: number;
  maxParticipants?: number;
  maxMaterialBytes?: number;
  maxAudioBytes?: number;
}

const DEFAULT_STORE_LIMITS: Required<ClassroomStoreLimits> = {
  maxPageEvents: 10_000,
  maxClassroomEvents: 50_000,
  maxPageBytes: 64 * 1024 * 1024,
  maxClassroomBytes: 256 * 1024 * 1024,
  maxClassrooms: 100,
  maxParticipants: 100,
  maxMaterialBytes: 100 * 1024 * 1024,
  maxAudioBytes: 256 * 1024 * 1024,
};

export interface ClassroomAuthContext {
  classroom_id: string;
  role: 'teacher' | 'participant';
  participant_id?: string;
}

function safeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

function assertStorageId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label}_invalid`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function publicSummary(meta: StoredClassroom, role: 'teacher' | 'participant', classCode?: string): ClassroomSessionSummary {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION,
    classroom_id: meta.classroom_id,
    ...(classCode ? { class_code: classCode } : {}),
    title: meta.title,
    status: meta.status,
    role,
    created_at: meta.created_at,
    started_at: meta.started_at,
    ended_at: meta.ended_at,
    latest_sequence: meta.latest_sequence,
    capabilities: meta.capabilities ?? legacyCapabilities(),
  };
}

function legacyCapabilities(): ClassroomCapabilities {
  return { textbook: false, recognition: false, audio: false, transcript: false };
}

function phaseOneCapabilities(): ClassroomCapabilities {
  return { textbook: true, recognition: true, audio: true, transcript: true };
}

function boardTimelineEntry(classroomId: string, timelineSequence: number, event: ClassroomBoardEvent): ClassroomTimelineEntry {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION,
    classroom_id: classroomId,
    timeline_sequence: timelineSequence,
    kind: 'board_event_ref',
    occurred_at: event.accepted_at,
    board_sequence: event.sequence,
    event_id: event.event.event_id,
    surface: event.surface ?? { kind: 'teacher_board' },
  };
}

export class JsonClassroomStore {
  private readonly classrooms = new Map<string, ClassroomMemory>();
  private readonly credentialIndex = new Map<string, ClassroomAuthContext>();
  private readonly classCodeIndex = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private constructor(private readonly root: string, private readonly limits: Required<ClassroomStoreLimits>) {}

  static async open(root: string, limits: ClassroomStoreLimits = {}): Promise<JsonClassroomStore> {
    const store = new JsonClassroomStore(root, { ...DEFAULT_STORE_LIMITS, ...limits });
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.deleted')) {
        await rm(join(root, entry.name), { recursive: true, force: true });
        continue;
      }
      if (!entry.isDirectory() || !entry.name.startsWith('classroom_')) continue;
      const meta = await readJson<StoredClassroom>(join(root, entry.name, 'meta.json'));
      if (!meta || meta.classroom_id !== entry.name || meta.schema_version !== CLASSROOM_SCHEMA_VERSION) continue;
      const events: ClassroomBoardEvent[] = [];
      try {
        const text = await readFile(join(root, entry.name, 'events.jsonl'), 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as ClassroomBoardEvent;
            if (validateClassroomBoardEvent(event).length === 0 && event.sequence === events.length + 1) events.push(event);
          } catch {
            break;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const timeline: ClassroomTimelineEntry[] = [];
      let timelineNeedsRepair = false;
      try {
        const text = await readFile(join(root, entry.name, 'timeline.jsonl'), 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const item = JSON.parse(line) as ClassroomTimelineEntry;
            const boardRefValid = item.kind !== 'board_event_ref' || events.some((event) => event.sequence === item.board_sequence && event.event.event_id === item.event_id);
            if (validateClassroomTimelineEntry(item).length === 0 && item.timeline_sequence === timeline.length + 1 && boardRefValid) timeline.push(item);
            else { timelineNeedsRepair = true; break; }
          } catch {
            timelineNeedsRepair = true; break;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (timelineNeedsRepair) await writeFile(join(root, entry.name, 'timeline.jsonl'), timeline.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8');
      const referencedBoardSequences = new Set(timeline.filter((item) => item.kind === 'board_event_ref').map((item) => item.board_sequence));
      for (const event of events) {
        if (referencedBoardSequences.has(event.sequence)) continue;
        const timelineEntry = boardTimelineEntry(meta.classroom_id, timeline.length + 1, event);
        await appendFile(join(root, entry.name, 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
        timeline.push(timelineEntry);
      }
      const recognitionPath = join(root, entry.name, 'teacher', 'recognition_revisions.json');
      const storedRecognitions = await readJson<ClassroomRecognitionRevision[]>(recognitionPath) ?? [];
      const canonicalRecognitions: ClassroomRecognitionRevision[] = [];
      const recognitionKeys = new Set<string>();
      const addRecognition = (recognition: ClassroomRecognitionRevision): void => {
        if (recognition.classroom_id !== meta.classroom_id || validateClassroomRecognitionRevision(recognition).length > 0) return;
        const key = `${recognition.recognition_id}:${recognition.revision}`;
        if (recognitionKeys.has(key)) return;
        const prior = canonicalRecognitions.filter((item) => item.recognition_id === recognition.recognition_id);
        if (recognition.revision !== prior.length + 1) return;
        recognitionKeys.add(key); canonicalRecognitions.push(recognition);
      };
      for (const item of timeline) if (item.kind === 'recognition_revision') addRecognition(item.recognition);
      for (const recognition of storedRecognitions) addRecognition(recognition);
      if (canonicalRecognitions.length > 0 || storedRecognitions.length > 0) {
        await mkdir(join(root, entry.name, 'teacher'), { recursive: true });
        await writeJsonAtomic(recognitionPath, canonicalRecognitions);
      }
      const timelineRecognitionKeys = new Set(timeline.filter((item) => item.kind === 'recognition_revision').map((item) => `${item.recognition.recognition_id}:${item.recognition.revision}`));
      for (const recognition of canonicalRecognitions) {
        const key = `${recognition.recognition_id}:${recognition.revision}`;
        if (timelineRecognitionKeys.has(key)) continue;
        const timelineEntry: ClassroomTimelineEntry = {
          schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: meta.classroom_id, timeline_sequence: timeline.length + 1,
          kind: 'recognition_revision', occurred_at: recognition.created_at, recognition,
        };
        await appendFile(join(root, entry.name, 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
        timeline.push(timelineEntry); timelineRecognitionKeys.add(key);
      }
      const transcriptPath = join(root, entry.name, 'teacher', 'transcript_revisions.json');
      const storedTranscripts = await readJson<ClassroomTranscriptRevision[]>(transcriptPath) ?? [];
      const canonicalTranscripts: ClassroomTranscriptRevision[] = [];
      const transcriptKeys = new Set<string>();
      const addTranscript = (transcript: ClassroomTranscriptRevision): void => {
        if (transcript.classroom_id !== meta.classroom_id || validateClassroomTranscriptRevision(transcript).length > 0) return;
        const key = `${transcript.transcript_id}:${transcript.revision}`;
        if (transcriptKeys.has(key)) return;
        const prior = canonicalTranscripts.filter((item) => item.transcript_id === transcript.transcript_id);
        if (transcript.revision !== prior.length + 1) return;
        transcriptKeys.add(key); canonicalTranscripts.push(transcript);
      };
      for (const item of timeline) if (item.kind === 'transcript_revision') addTranscript(item.transcript);
      for (const transcript of storedTranscripts) addTranscript(transcript);
      if (canonicalTranscripts.length > 0 || storedTranscripts.length > 0) {
        await mkdir(join(root, entry.name, 'teacher'), { recursive: true });
        await writeJsonAtomic(transcriptPath, canonicalTranscripts);
      }
      const timelineTranscriptKeys = new Set(timeline.filter((item) => item.kind === 'transcript_revision').map((item) => `${item.transcript.transcript_id}:${item.transcript.revision}`));
      for (const transcript of canonicalTranscripts) {
        const key = `${transcript.transcript_id}:${transcript.revision}`; if (timelineTranscriptKeys.has(key)) continue;
        const timelineEntry: ClassroomTimelineEntry = {
          schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: meta.classroom_id, timeline_sequence: timeline.length + 1,
          kind: 'transcript_revision', occurred_at: transcript.corrected_at ?? transcript.created_at, transcript,
        };
        await appendFile(join(root, entry.name, 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
        timeline.push(timelineEntry); timelineTranscriptKeys.add(key);
      }
      for (const item of timeline) {
        if (item.kind === 'teacher_view' && (!meta.teacher_view || item.teacher_view.revision > meta.teacher_view.revision)) meta.teacher_view = item.teacher_view;
        if (item.kind === 'confirmed_focus' && (!meta.confirmed_focus || item.confirmed_focus.confirmed_at >= meta.confirmed_focus.confirmed_at)) meta.confirmed_focus = item.confirmed_focus;
        if (item.kind === 'material_published' && !(meta.materials ?? []).some((material) => material.material_id === item.material.material_id)) meta.materials = [...(meta.materials ?? []), item.material];
      }
      meta.latest_sequence = events.length;
      meta.capabilities = meta.capabilities ?? legacyCapabilities();
      meta.latest_timeline_sequence = timeline.length;
      meta.board_timeline_watermark = events.length;
      meta.materials = meta.materials ?? [];
      meta.material_upload_keys = meta.material_upload_keys ?? {};
      store.classrooms.set(meta.classroom_id, { meta, events, timeline });
      store.indexClassroom(meta);
      await store.persistMeta(meta);
      const participantsRoot = join(root, entry.name, 'participants');
      try {
        for (const participant of await readdir(participantsRoot, { withFileTypes: true })) {
          if (!participant.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(participant.name)) continue;
          const directory = join(participantsRoot, participant.name);
          for (const file of await readdir(directory)) {
            if (!/^job_[A-Za-z0-9_-]{1,123}\.json$/.test(file)) continue;
            const path = join(directory, file);
            const record = await readJson<Record<string, unknown>>(path);
            if (record?.status !== 'running') continue;
            const now = new Date().toISOString();
            await writeJsonAtomic(path, { ...record, status: 'failed', error_code: 'service_restarted', updated_at: now });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const recordingPath = join(root, entry.name, 'teacher', 'audio_recording.json');
      const recording = await readJson<Record<string, unknown>>(recordingPath);
      if (recording?.state === 'recording') {
        const now = new Date().toISOString();
        const interrupted = { ...recording, state: 'interrupted', health: 'incomplete', interrupted_at: now } as ClassroomRecordingState;
        await writeJsonAtomic(recordingPath, interrupted);
        const hit = store.classrooms.get(meta.classroom_id)!;
        const timelineEntry: ClassroomTimelineEntry = { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: meta.classroom_id, timeline_sequence: hit.timeline.length + 1, kind: 'recording_state', occurred_at: now, recording: interrupted };
        await appendFile(join(root, entry.name, 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
        hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await store.persistMeta(hit.meta);
      }
    }
    return store;
  }

  private classroomDir(classroomId: string): string {
    assertStorageId(classroomId, 'classroom_id');
    return join(this.root, classroomId);
  }

  private async serialize<T>(classroomId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(classroomId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.queues.set(classroomId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(classroomId) === current) this.queues.delete(classroomId);
    }
  }

  private async persistMeta(meta: StoredClassroom): Promise<void> {
    const directory = this.classroomDir(meta.classroom_id);
    await mkdir(directory, { recursive: true });
    await writeJsonAtomic(join(directory, 'meta.json'), meta);
  }

  private indexClassroom(meta: StoredClassroom): void {
    this.classCodeIndex.set(meta.class_code_hash, meta.classroom_id);
    this.credentialIndex.set(meta.teacher_credential_hash, { classroom_id: meta.classroom_id, role: 'teacher' });
    for (const participant of meta.participants) this.credentialIndex.set(participant.credential_hash, { classroom_id: meta.classroom_id, role: 'participant', participant_id: participant.participant_id });
  }

  private unindexClassroom(meta: StoredClassroom): void {
    this.classCodeIndex.delete(meta.class_code_hash);
    this.credentialIndex.delete(meta.teacher_credential_hash);
    for (const participant of meta.participants) this.credentialIndex.delete(participant.credential_hash);
  }

  listClassroomIds(): string[] {
    return [...this.classrooms.keys()];
  }

  async createClassroom(title: string): Promise<{ classroom: ClassroomSessionSummary; class_code: string; teacher_credential: string }> {
    if (this.classrooms.size >= this.limits.maxClassrooms) throw new Error('classroom_limit_reached');
    const classroomId = safeId('classroom');
    const classCode = createClassCode();
    const teacher = createOpaqueCredential('teacher');
    const now = new Date().toISOString();
    const meta: StoredClassroom = {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: classroomId,
      title: safeClassroomTitle(title),
      status: 'draft',
      class_code_hash: credentialHash(classCode),
      teacher_credential_hash: teacher.hash,
      participants: [],
      latest_sequence: 0,
      generation: 2,
      capabilities: phaseOneCapabilities(),
      latest_timeline_sequence: 0,
      board_timeline_watermark: 0,
      materials: [],
      material_upload_keys: {},
      created_at: now,
    };
    this.classrooms.set(classroomId, { meta, events: [], timeline: [] });
    this.indexClassroom(meta);
    try {
      await this.persistMeta(meta);
      await writeFile(join(this.classroomDir(classroomId), 'events.jsonl'), '', { flag: 'a' });
      await writeFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), '', { flag: 'a' });
    } catch (error) {
      this.classrooms.delete(classroomId);
      this.unindexClassroom(meta);
      await rm(this.classroomDir(classroomId), { recursive: true, force: true });
      throw error;
    }
    return { classroom: publicSummary(meta, 'teacher', classCode), class_code: classCode, teacher_credential: teacher.token };
  }

  async getClassroom(classroomId: string): Promise<ClassroomSessionSummary | null> {
    const hit = this.classrooms.get(classroomId);
    return hit ? publicSummary(hit.meta, 'teacher') : null;
  }

  async getClassroomGeneration(classroomId: string): Promise<number> {
    const hit = this.classrooms.get(classroomId);
    if (!hit) throw new Error('classroom_not_found');
    return hit.meta.generation ?? 1;
  }

  async hasParticipant(classroomId: string, participantId: string): Promise<boolean> {
    assertStorageId(participantId, 'participant_id');
    return this.classrooms.get(classroomId)?.meta.participants.some((item) => item.participant_id === participantId) ?? false;
  }

  async authenticate(token: string): Promise<ClassroomAuthContext | null> {
    if (!token) return null;
    return this.credentialIndex.get(credentialHash(token)) ?? null;
  }

  async transition(classroomId: string, next: ClassroomStatus): Promise<ClassroomSessionSummary> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit) throw new Error('classroom_not_found');
      const allowed = (hit.meta.status === 'draft' && next === 'live') || (hit.meta.status === 'live' && next === 'ended');
      if (!allowed) throw new Error('invalid_classroom_transition');
      hit.meta.status = next;
      if (next === 'live') hit.meta.started_at = new Date().toISOString();
      if (next === 'ended') hit.meta.ended_at = new Date().toISOString();
      await this.persistMeta(hit.meta);
      return publicSummary(hit.meta, 'teacher');
    });
  }

  async joinClassroom(classCode: string, nickname: string): Promise<{ classroom: ClassroomSessionSummary; participant_id: string; credential: string }> {
    const codeHash = credentialHash(String(classCode || '').trim().toUpperCase());
    const classroomId = this.classCodeIndex.get(codeHash);
    const hit = classroomId ? this.classrooms.get(classroomId) : undefined;
    if (!hit || hit.meta.status !== 'live') throw new Error('classroom_not_live');
    return this.serialize(hit.meta.classroom_id, async () => {
      if (hit.meta.status !== 'live') throw new Error('classroom_not_live');
      if (hit.meta.participants.length >= this.limits.maxParticipants) throw new Error('participant_limit_reached');
      const credential = createOpaqueCredential('participant');
      const participant: StoredParticipant = {
        participant_id: safeId('participant'),
        nickname: normalizeNickname(nickname),
        credential_hash: credential.hash,
        joined_at: new Date().toISOString(),
      };
      hit.meta.participants.push(participant);
      this.credentialIndex.set(participant.credential_hash, { classroom_id: hit.meta.classroom_id, role: 'participant', participant_id: participant.participant_id });
      await this.persistMeta(hit.meta);
      return { classroom: publicSummary(hit.meta, 'participant'), participant_id: participant.participant_id, credential: credential.token };
    });
  }

  async appendBoardEvent(classroomId: string, input: ClassroomBoardEventInput | Omit<ClassroomBoardEvent, 'sequence' | 'accepted_at'>): Promise<{ event: ClassroomBoardEvent; inserted: boolean }> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit) throw new Error('classroom_not_found');
      if (hit.meta.status !== 'live') throw new Error('classroom_not_live');
      const normalizedInput: ClassroomBoardEventInput = input.geometry_version === 'classroom_page_world_v1'
        ? {
            ...input as Omit<Extract<ClassroomBoardEvent, { geometry_version: 'classroom_page_world_v1' }>, 'sequence' | 'accepted_at'>,
            classroom_id: classroomId,
            event: { ...input.event, session_id: classroomId } as Extract<ClassroomBoardEvent, { geometry_version: 'classroom_page_world_v1' }>['event'],
            stroke: { ...input.stroke, session_id: classroomId } as Extract<ClassroomBoardEvent, { geometry_version: 'classroom_page_world_v1' }>['stroke'],
          }
        : {
            ...input as Omit<Extract<ClassroomBoardEvent, { geometry_version?: 'normalized_v1' }>, 'sequence' | 'accepted_at'>,
            classroom_id: classroomId,
            event: { ...input.event, session_id: classroomId } as Extract<ClassroomBoardEvent, { geometry_version?: 'normalized_v1' }>['event'],
            stroke: { ...input.stroke, session_id: classroomId } as Extract<ClassroomBoardEvent, { geometry_version?: 'normalized_v1' }>['stroke'],
          };
      const existing = hit.events.find((event) => event.client_event_id === input.client_event_id);
      if (existing) {
        const comparable = { ...existing, sequence: undefined, accepted_at: undefined };
        if (stableJson(comparable) !== stableJson({ ...normalizedInput, sequence: undefined, accepted_at: undefined })) throw new Error('idempotency_conflict');
        if (!hit.timeline.some((item) => item.kind === 'board_event_ref' && item.board_sequence === existing.sequence)) {
          const timelineEntry = boardTimelineEntry(classroomId, hit.timeline.length + 1, existing);
          await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
          hit.timeline.push(timelineEntry);
          hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence;
          hit.meta.board_timeline_watermark = Math.max(hit.meta.board_timeline_watermark ?? 0, existing.sequence);
          await this.persistMeta(hit.meta);
        }
        return { event: existing, inserted: false };
      }
      const candidate: ClassroomBoardEvent = normalizedInput.geometry_version === 'classroom_page_world_v1'
        ? { ...normalizedInput, sequence: hit.events.length + 1, accepted_at: new Date().toISOString() }
        : { ...normalizedInput, sequence: hit.events.length + 1, accepted_at: new Date().toISOString() };
      const issues = validateClassroomBoardEvent(candidate);
      if (issues.length) throw new Error(`invalid_board_event:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
      if (candidate.event.event_type === 'erase') {
        const targets = candidate.event.metadata?.erased_event_ids;
        if (!Array.isArray(targets) || targets.length === 0 || targets.length > 128 || targets.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('invalid_eraser_targets');
        const active = new Map(activeBoardEvents(hit.events).map((event) => [event.event.event_id, event]));
        const materialId = candidate.surface?.kind === 'textbook_page' ? candidate.surface.material_id : undefined;
        const material = (hit.meta.materials ?? []).find((item) => item.material_id === materialId);
        if (new Set(targets).size !== targets.length || targets.some((id) => {
          const target = active.get(id);
          return !target || !sameSurface(target.surface, candidate.surface) || !boxesIntersect(eventBBox(target, material), eventBBox(candidate, material));
        })) throw new Error('invalid_eraser_targets');
      }
      if (input.geometry_version === 'classroom_page_world_v1') {
        const surface = (input as Extract<ClassroomBoardEventInput, { geometry_version: 'classroom_page_world_v1' }>).surface;
        const material = (hit.meta.materials ?? []).find((item) => item.material_id === surface.material_id);
        if (!material || surface.page_index < 0 || surface.page_index >= material.page_count) throw new Error('material_page_not_found');
      }
      const pointCount = input.geometry_version === 'classroom_page_world_v1'
        ? (input.stroke as Extract<ClassroomBoardEvent, { geometry_version: 'classroom_page_world_v1' }>['stroke']).points_world.length
        : (input.stroke as Extract<ClassroomBoardEvent, { geometry_version?: 'normalized_v1' }>['stroke']).points.length;
      if (pointCount > 4_096) throw new Error('stroke_too_large');
      const canonicalBytes = Buffer.byteLength(JSON.stringify(normalizedInput), 'utf8');
      if (canonicalBytes > 128 * 1024) throw new Error('stroke_too_large');
      const pageEvents = hit.events.filter((event) => {
        if (input.surface?.kind !== 'textbook_page' || event.surface?.kind !== 'textbook_page') return false;
        return input.surface.material_id === event.surface.material_id && input.surface.page_index === event.surface.page_index;
      });
      if (pageEvents.length >= this.limits.maxPageEvents) throw new Error('page_quota_reached');
      if (hit.events.length >= this.limits.maxClassroomEvents) throw new Error('classroom_quota_reached');
      const ledgerBytes = hit.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
      const pageBytes = pageEvents.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
      if (pageBytes + canonicalBytes > this.limits.maxPageBytes) throw new Error('page_quota_reached');
      if (ledgerBytes + canonicalBytes > this.limits.maxClassroomBytes) throw new Error('classroom_quota_reached');
      const sequence = hit.events.length + 1;
      const acceptedAt = new Date().toISOString();
      const event: ClassroomBoardEvent = normalizedInput.geometry_version === 'classroom_page_world_v1'
        ? { ...normalizedInput, sequence, accepted_at: acceptedAt }
        : { ...normalizedInput, sequence, accepted_at: acceptedAt };
      await appendFile(join(this.classroomDir(classroomId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
      hit.events.push(event);
      hit.meta.latest_sequence = event.sequence;
      const timelineEntry = boardTimelineEntry(classroomId, hit.timeline.length + 1, event);
      await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
      hit.timeline.push(timelineEntry);
      hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence;
      hit.meta.board_timeline_watermark = event.sequence;
      await this.persistMeta(hit.meta);
      return { event, inserted: true };
    });
  }

  async getSnapshot(classroomId: string): Promise<ClassroomSnapshot> {
    await this.ensureAllMaterialPageGeometries(classroomId);
    const hit = this.classrooms.get(classroomId);
    if (!hit) throw new Error('classroom_not_found');
    const recording = await this.getRecordingState(classroomId);
    const transcripts = await this.listTranscriptRevisions(classroomId);
    const transcription = await this.getTranscriptionState(classroomId);
    return {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      classroom_id: classroomId,
      classroom_status: hit.meta.status,
      snapshot_sequence: hit.events.length,
      board_events: hit.events.map((event) => structuredClone(event)),
      ...this.sharedState(hit),
      recognitions: await this.listRecognitionRevisions(classroomId),
      ...(recording ? { recording } : {}),
      transcripts,
      ...(transcription ? { transcription } : {}),
      generated_at: new Date().toISOString(),
    };
  }

  getBoardEventByClientId(classroomId: string, clientEventId: string): ClassroomBoardEvent | undefined {
    return structuredClone(this.classrooms.get(classroomId)?.events.find((event) => event.client_event_id === clientEventId));
  }

  private sharedState(hit: ClassroomMemory): ClassroomSharedState {
    return {
      capabilities: structuredClone(hit.meta.capabilities ?? legacyCapabilities()),
      timeline_sequence: hit.timeline.length,
      materials: structuredClone(hit.meta.materials ?? []),
      ...(hit.meta.teacher_view ? { teacher_view: structuredClone(hit.meta.teacher_view) } : {}),
      ...(hit.meta.confirmed_focus ? { confirmed_focus: structuredClone(hit.meta.confirmed_focus) } : {}),
    };
  }

  async getTimeline(classroomId: string): Promise<ClassroomTimelineEntry[]> {
    const hit = this.classrooms.get(classroomId);
    if (!hit) throw new Error('classroom_not_found');
    return structuredClone(hit.timeline);
  }

  async getSharedState(classroomId: string): Promise<ClassroomSharedState> {
    await this.ensureAllMaterialPageGeometries(classroomId);
    const hit = this.classrooms.get(classroomId);
    if (!hit) throw new Error('classroom_not_found');
    return this.sharedState(hit);
  }

  async updateTeacherView(classroomId: string, teacherView: ClassroomTeacherView, finalKey?: string, expectedBaseRevision?: number): Promise<ClassroomTeacherView> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit) throw new Error('classroom_not_found');
      if (hit.meta.status === 'ended') throw new Error('classroom_not_live');
      if (teacherView.classroom_id !== classroomId) throw new Error('teacher_view_classroom_mismatch');
      if (finalKey) {
        assertStorageId(finalKey, 'teacher_view_final_key');
        const priorRevision = hit.meta.teacher_view_final_keys?.[finalKey];
        if (priorRevision !== undefined) {
          const priorEntry = hit.timeline.find((item) => item.kind === 'teacher_view' && item.teacher_view.revision === priorRevision);
          const priorView = priorEntry?.kind === 'teacher_view' ? priorEntry.teacher_view : undefined;
          if (!priorView || stableJson(priorView) !== stableJson(teacherView)) throw new Error('idempotency_conflict');
          return structuredClone(priorView);
        }
      }
      if (expectedBaseRevision !== undefined && (hit.meta.teacher_view?.revision ?? 0) !== expectedBaseRevision) throw new Error('view_stale');
      const issues = validateClassroomTeacherView(teacherView);
      if (issues.length) throw new Error(`invalid_teacher_view:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
      if ((hit.meta.materials ?? []).length > 0) {
        const material = hit.meta.materials?.find((item) => item.material_id === teacherView.material_id);
        if (!material || teacherView.page_index >= material.page_count) throw new Error('material_page_not_found');
        for (const key of Object.keys(teacherView.page_viewports ?? {})) {
          const separator = key.lastIndexOf(':');
          const keyMaterialId = key.slice(0, separator); const pageIndex = Number(key.slice(separator + 1));
          const keyMaterial = hit.meta.materials?.find((item) => item.material_id === keyMaterialId);
          if (!keyMaterial || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= keyMaterial.page_count) throw new Error('material_page_not_found');
        }
      }
      if (hit.meta.teacher_view && teacherView.revision <= hit.meta.teacher_view.revision) throw new Error('stale_teacher_view');
      const value = structuredClone(teacherView);
      const timelineEntry: ClassroomTimelineEntry = {
        schema_version: CLASSROOM_SCHEMA_VERSION,
        classroom_id: classroomId,
        timeline_sequence: hit.timeline.length + 1,
        kind: 'teacher_view',
        occurred_at: value.updated_at,
        teacher_view: value,
      };
      await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
      hit.timeline.push(timelineEntry);
      hit.meta.teacher_view = value;
      if (finalKey) hit.meta.teacher_view_final_keys = { ...(hit.meta.teacher_view_final_keys ?? {}), [finalKey]: value.revision };
      hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence;
      await this.persistMeta(hit.meta);
      return structuredClone(value);
    });
  }

  async confirmFocus(classroomId: string, focus: ClassroomConfirmedFocus): Promise<ClassroomConfirmedFocus> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit) throw new Error('classroom_not_found');
      if (hit.meta.status !== 'live') throw new Error('classroom_not_live');
      if (focus.classroom_id !== classroomId) throw new Error('confirmed_focus_classroom_mismatch');
      const issues = validateClassroomConfirmedFocus(focus);
      if (issues.length) throw new Error(`invalid_confirmed_focus:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
      if ((hit.meta.materials ?? []).length > 0) {
        const material = hit.meta.materials?.find((item) => item.material_id === focus.material_id);
        if (!material || focus.page_index >= material.page_count) throw new Error('material_page_not_found');
      }
      const value = structuredClone(focus);
      const timelineEntry: ClassroomTimelineEntry = {
        schema_version: CLASSROOM_SCHEMA_VERSION,
        classroom_id: classroomId,
        timeline_sequence: hit.timeline.length + 1,
        kind: 'confirmed_focus',
        occurred_at: value.confirmed_at,
        confirmed_focus: value,
      };
      await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
      hit.timeline.push(timelineEntry);
      hit.meta.confirmed_focus = value;
      hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence;
      await this.persistMeta(hit.meta);
      return structuredClone(value);
    });
  }

  async publishMaterial(classroomId: string, material: ClassroomMaterial, bytes: Uint8Array, idempotencyKey: string): Promise<{ material: ClassroomMaterial; inserted: boolean }> {
    assertStorageId(material.material_id, 'material_id');
    assertStorageId(idempotencyKey, 'idempotency_key');
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit) throw new Error('classroom_not_found');
      if (material.classroom_id !== classroomId) throw new Error('material_classroom_mismatch');
      const existingId = hit.meta.material_upload_keys?.[idempotencyKey];
      if (existingId && existingId !== material.material_id) throw new Error('idempotency_conflict');
      const existing = (hit.meta.materials ?? []).find((item) => item.material_id === material.material_id);
      if (existing) {
        if (stableJson(existing) !== stableJson(material)) throw new Error('idempotency_conflict');
        hit.meta.material_upload_keys = { ...(hit.meta.material_upload_keys ?? {}), [idempotencyKey]: existing.material_id };
        await this.persistMeta(hit.meta);
        return { material: structuredClone(existing), inserted: false };
      }
      const materialBytes = (hit.meta.materials ?? []).reduce((sum, item) => sum + item.byte_size, 0);
      if (materialBytes + bytes.byteLength > this.limits.maxMaterialBytes) throw new Error('material_quota_reached');
      const directory = join(this.classroomDir(classroomId), 'materials');
      await mkdir(directory, { recursive: true });
      const finalPath = join(directory, `${material.material_id}.pdf`);
      const temporaryPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporaryPath, bytes);
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      const value = structuredClone(material);
      const timelineEntry: ClassroomTimelineEntry = {
        schema_version: CLASSROOM_SCHEMA_VERSION,
        classroom_id: classroomId,
        timeline_sequence: hit.timeline.length + 1,
        kind: 'material_published',
        occurred_at: value.published_at,
        material: value,
      };
      try {
        await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
        hit.timeline.push(timelineEntry);
        hit.meta.materials = [...(hit.meta.materials ?? []), value];
        hit.meta.material_upload_keys = { ...(hit.meta.material_upload_keys ?? {}), [idempotencyKey]: value.material_id };
        hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence;
        await this.persistMeta(hit.meta);
      } catch (error) {
        if (!hit.timeline.some((item) => item.kind === 'material_published' && item.material.material_id === value.material_id)) await rm(finalPath, { force: true });
        throw error;
      }
      return { material: structuredClone(value), inserted: true };
    });
  }

  async getMaterial(classroomId: string, materialId: string): Promise<ClassroomMaterial | null> {
    assertStorageId(materialId, 'material_id');
    await this.ensureMaterialPageGeometries(classroomId, materialId);
    const hit = this.classrooms.get(classroomId);
    if (!hit) return null;
    const material = (hit.meta.materials ?? []).find((item) => item.material_id === materialId);
    return material ? structuredClone(material) : null;
  }

  async getMaterialBytes(classroomId: string, materialId: string): Promise<Uint8Array | null> {
    assertStorageId(materialId, 'material_id');
    if (!this.classrooms.get(classroomId)?.meta.materials?.some((item) => item.material_id === materialId)) return null;
    try {
      return new Uint8Array(await readFile(join(this.classroomDir(classroomId), 'materials', `${materialId}.pdf`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async ensureAllMaterialPageGeometries(classroomId: string): Promise<void> {
    const ids = this.classrooms.get(classroomId)?.meta.materials?.filter((item) => !item.page_geometries).map((item) => item.material_id) ?? [];
    for (const materialId of ids) await this.ensureMaterialPageGeometries(classroomId, materialId);
  }

  private async ensureMaterialPageGeometries(classroomId: string, materialId: string): Promise<void> {
    const hit = this.classrooms.get(classroomId);
    const material = hit?.meta.materials?.find((item) => item.material_id === materialId);
    if (!hit || !material || material.page_geometries) return;
    await this.serialize(classroomId, async () => {
      const current = hit.meta.materials?.find((item) => item.material_id === materialId);
      if (!current || current.page_geometries) return;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(this.classroomDir(classroomId), 'materials', `${materialId}.pdf`)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const { inspectPdfPageGeometries } = await import('./classroom-materials');
      const pageGeometries = await inspectPdfPageGeometries(bytes);
      if (pageGeometries.length !== current.page_count) throw new Error('material_page_count_mismatch');
      current.page_geometries = pageGeometries;
      await this.persistMeta(hit.meta);
    });
  }

  async eventsAfter(classroomId: string, sequence: number): Promise<ClassroomBoardEvent[]> {
    const hit = this.classrooms.get(classroomId);
    if (!hit) throw new Error('classroom_not_found');
    return hit.events.filter((event) => event.sequence > sequence).map((event) => structuredClone(event));
  }

  async putPrivateRecord(classroomId: string, participantId: string, recordId: string, value: unknown): Promise<void> {
    assertStorageId(participantId, 'participant_id');
    assertStorageId(recordId, 'record_id');
    await this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit?.meta.participants.some((item) => item.participant_id === participantId)) throw new Error('participant_not_found');
      const directory = join(this.classroomDir(classroomId), 'participants', participantId);
      await mkdir(directory, { recursive: true });
      await writeJsonAtomic(join(directory, `${recordId}.json`), value);
    });
  }

  async putPrivateRecordIfAbsent(classroomId: string, participantId: string, recordId: string, value: unknown): Promise<unknown | null> {
    assertStorageId(participantId, 'participant_id');
    assertStorageId(recordId, 'record_id');
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit?.meta.participants.some((item) => item.participant_id === participantId)) throw new Error('participant_not_found');
      const directory = join(this.classroomDir(classroomId), 'participants', participantId);
      const path = join(directory, `${recordId}.json`);
      const existing = await readJson(path);
      if (existing !== null) return existing;
      await mkdir(directory, { recursive: true });
      await writeJsonAtomic(path, value);
      return null;
    });
  }

  async getPrivateRecord(classroomId: string, participantId: string, recordId: string): Promise<unknown | null> {
    assertStorageId(participantId, 'participant_id');
    assertStorageId(recordId, 'record_id');
    const hit = this.classrooms.get(classroomId);
    if (!hit?.meta.participants.some((item) => item.participant_id === participantId)) return null;
    return readJson(join(this.classroomDir(classroomId), 'participants', participantId, `${recordId}.json`));
  }

  async listPrivateRecords(classroomId: string, participantId: string): Promise<unknown[]> {
    assertStorageId(participantId, 'participant_id');
    const hit = this.classrooms.get(classroomId);
    if (!hit?.meta.participants.some((item) => item.participant_id === participantId)) throw new Error('participant_not_found');
    const directory = join(this.classroomDir(classroomId), 'participants', participantId);
    let entries: string[];
    try { entries = await readdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: unknown[] = [];
    for (const name of entries.sort()) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
      const value = await readJson(join(directory, name));
      if (value !== null) records.push(value);
    }
    return records;
  }

  async putTeacherRecord(classroomId: string, recordId: string, value: unknown): Promise<void> {
    assertStorageId(recordId, 'record_id');
    await this.serialize(classroomId, async () => {
      if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
      const directory = join(this.classroomDir(classroomId), 'teacher');
      await mkdir(directory, { recursive: true });
      await writeJsonAtomic(join(directory, `${recordId}.json`), value);
    });
  }

  async putRecordingState(classroomId: string, recording: ClassroomRecordingState): Promise<ClassroomRecordingState> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId); if (!hit) throw new Error('classroom_not_found');
      const directory = join(this.classroomDir(classroomId), 'teacher'); await mkdir(directory, { recursive: true });
      await writeJsonAtomic(join(directory, 'audio_recording.json'), recording);
      const last = [...hit.timeline].reverse().find((item) => item.kind === 'recording_state');
      if (last?.kind === 'recording_state' && last.recording.state === recording.state && last.recording.health === recording.health) return structuredClone(recording);
      const occurredAt = recording.stopped_at ?? recording.interrupted_at ?? recording.started_at;
      const timelineEntry: ClassroomTimelineEntry = { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: hit.timeline.length + 1, kind: 'recording_state', occurred_at: occurredAt, recording };
      await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
      hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await this.persistMeta(hit.meta);
      return structuredClone(recording);
    });
  }

  async getRecordingState(classroomId: string): Promise<ClassroomRecordingState | null> {
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    return readJson<ClassroomRecordingState>(join(this.classroomDir(classroomId), 'teacher', 'audio_recording.json'));
  }

  async getTeacherRecord(classroomId: string, recordId: string): Promise<unknown | null> {
    assertStorageId(recordId, 'record_id');
    if (!this.classrooms.has(classroomId)) return null;
    return readJson(join(this.classroomDir(classroomId), 'teacher', `${recordId}.json`));
  }

  async getAudioChunk(classroomId: string, recordingId: string, chunkId: string): Promise<Uint8Array | null> {
    assertStorageId(recordingId, 'recording_id'); assertStorageId(chunkId, 'chunk_id');
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    try {
      return new Uint8Array(await readFile(join(this.classroomDir(classroomId), 'audio', recordingId, `${chunkId}.pcm`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async deleteAudio(classroomId: string): Promise<ClassroomTranscriptionState | null> {
    return this.serialize(classroomId, async () => {
      if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
      await rm(join(this.classroomDir(classroomId), 'audio'), { recursive: true, force: true });
      const path = join(this.classroomDir(classroomId), 'teacher', 'transcription_state.json');
      const current = await readJson<ClassroomTranscriptionState>(path);
      if (!current) return null;
      const now = new Date().toISOString();
      const next = { ...current, audio_available: false, audio_deleted_at: now, updated_at: now };
      await writeJsonAtomic(path, next);
      return structuredClone(next);
    });
  }

  async putAudioChunk(classroomId: string, recordingId: string, chunkId: string, sequence: number, bytes: Uint8Array, hash: string, metadata?: {
    classroom_generation: number; recording_generation: number; sample_rate: number; channels: number; relative_start_ms: number; relative_end_ms: number; external_transcription_opt_in?: boolean; language_hint?: 'zh' | 'en';
  }): Promise<boolean> {
    assertStorageId(recordingId, 'recording_id'); assertStorageId(chunkId, 'chunk_id');
    return this.serialize(classroomId, async () => {
      if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
      const directory = join(this.classroomDir(classroomId), 'audio', recordingId);
      await mkdir(directory, { recursive: true });
      const manifestPath = join(directory, 'chunks.json');
      const manifest = await readJson<Array<{ chunk_id: string; sequence?: number; hash: string; byte_size: number; metadata?: typeof metadata }>>(manifestPath) ?? [];
      const existing = manifest.find((item) => item.chunk_id === chunkId);
      if (existing) {
        if (existing.hash !== hash || existing.byte_size !== bytes.byteLength || (existing.sequence !== undefined && existing.sequence !== sequence)) throw new Error('audio_chunk_idempotency_conflict');
        return false;
      }
      if (manifest.some((item) => item.sequence === sequence)) throw new Error('audio_chunk_sequence_conflict');
      const audioBytes = manifest.reduce((sum, item) => sum + item.byte_size, 0);
      if (audioBytes + bytes.byteLength > this.limits.maxAudioBytes) throw new Error('audio_quota_reached');
      const finalPath = join(directory, `${chunkId}.pcm`); const temporary = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, bytes); await rename(temporary, finalPath);
      await writeJsonAtomic(manifestPath, [...manifest, { chunk_id: chunkId, sequence, hash, byte_size: bytes.byteLength, ...(metadata ? { metadata } : {}) }]);
      return true;
    });
  }

  async getAudioChunkDescriptor(classroomId: string, recordingId: string, chunkId: string): Promise<{
    chunk_id: string; sequence: number; hash: string; metadata: { classroom_generation: number; recording_generation: number; sample_rate: number; channels: number; relative_start_ms: number; relative_end_ms: number; external_transcription_opt_in?: boolean; language_hint?: 'zh' | 'en' };
  } | null> {
    assertStorageId(recordingId, 'recording_id'); assertStorageId(chunkId, 'chunk_id');
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    const manifest = await readJson<Array<{ chunk_id: string; sequence?: number; hash: string; metadata?: { classroom_generation: number; recording_generation: number; sample_rate: number; channels: number; relative_start_ms: number; relative_end_ms: number; external_transcription_opt_in?: boolean; language_hint?: 'zh' | 'en' } }>>(join(this.classroomDir(classroomId), 'audio', recordingId, 'chunks.json')) ?? [];
    const item = manifest.find((entry) => entry.chunk_id === chunkId);
    return item?.metadata && item.sequence !== undefined ? { chunk_id: item.chunk_id, sequence: item.sequence, hash: item.hash, metadata: item.metadata } : null;
  }

  async listAudioChunkDescriptors(classroomId: string, recordingId: string): Promise<Array<{
    chunk_id: string; sequence: number; hash: string; metadata: { classroom_generation: number; recording_generation: number; sample_rate: number; channels: number; relative_start_ms: number; relative_end_ms: number; external_transcription_opt_in?: boolean; language_hint?: 'zh' | 'en' };
  }>> {
    assertStorageId(recordingId, 'recording_id');
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    const manifest = await readJson<Array<{ chunk_id: string; sequence?: number; hash: string; metadata?: { classroom_generation: number; recording_generation: number; sample_rate: number; channels: number; relative_start_ms: number; relative_end_ms: number; external_transcription_opt_in?: boolean; language_hint?: 'zh' | 'en' } }>>(join(this.classroomDir(classroomId), 'audio', recordingId, 'chunks.json')) ?? [];
    return manifest.filter((item): item is { chunk_id: string; sequence: number; hash: string; metadata: NonNullable<typeof item.metadata> } => item.sequence !== undefined && item.metadata !== undefined).map((item) => structuredClone(item));
  }

  async appendRecognitionRevision(classroomId: string, revision: ClassroomRecognitionRevision): Promise<ClassroomRecognitionRevision> {
    return this.serialize(classroomId, async () => {
      if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
      const directory = join(this.classroomDir(classroomId), 'teacher');
      const path = join(directory, 'recognition_revisions.json');
      const current = await readJson<ClassroomRecognitionRevision[]>(path) ?? [];
      const history = current.filter((item) => item.recognition_id === revision.recognition_id);
      const existing = history.find((item) => item.revision === revision.revision);
      if (existing) {
        if (stableJson(existing) !== stableJson(revision)) throw new Error('recognition_revision_conflict');
        if (!this.classrooms.get(classroomId)!.timeline.some((item) => item.kind === 'recognition_revision' && item.recognition.recognition_id === revision.recognition_id && item.recognition.revision === revision.revision)) {
          const hit = this.classrooms.get(classroomId)!;
          const timelineEntry: ClassroomTimelineEntry = {
            schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: hit.timeline.length + 1,
            kind: 'recognition_revision', occurred_at: revision.created_at, recognition: revision,
          };
          await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
          hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await this.persistMeta(hit.meta);
        }
        return structuredClone(existing);
      }
      if (revision.revision !== history.length + 1) throw new Error('recognition_revision_conflict');
      await mkdir(directory, { recursive: true });
      await writeJsonAtomic(path, [...current, revision]);
      const hit = this.classrooms.get(classroomId)!;
      const timelineEntry: ClassroomTimelineEntry = {
        schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: hit.timeline.length + 1,
        kind: 'recognition_revision', occurred_at: revision.created_at, recognition: revision,
      };
      await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
      hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await this.persistMeta(hit.meta);
      return structuredClone(revision);
    });
  }

  async listRecognitionRevisions(classroomId: string): Promise<ClassroomRecognitionRevision[]> {
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    return structuredClone(await readJson<ClassroomRecognitionRevision[]>(join(this.classroomDir(classroomId), 'teacher', 'recognition_revisions.json')) ?? []);
  }

  async appendTranscriptRevision(classroomId: string, revision: ClassroomTranscriptRevision): Promise<ClassroomTranscriptRevision> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId); if (!hit) throw new Error('classroom_not_found');
      const clearMarker = await readJson<ClassroomTranscriptClearMarker>(join(this.classroomDir(classroomId), 'teacher', 'transcript_clear.json'));
      if (clearMarker?.cleared_chunks.some((item) => item.recording_id === revision.recording_id && item.chunk_id === revision.chunk_id)) throw new Error('transcript_chunk_cleared');
      if (revision.classroom_id !== classroomId) throw new Error('transcript_classroom_mismatch');
      const issues = validateClassroomTranscriptRevision(revision);
      if (issues.length) throw new Error(`invalid_transcript_revision:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
      const directory = join(this.classroomDir(classroomId), 'teacher'); const path = join(directory, 'transcript_revisions.json');
      const current = await readJson<ClassroomTranscriptRevision[]>(path) ?? [];
      const history = current.filter((item) => item.transcript_id === revision.transcript_id);
      const existing = history.find((item) => item.revision === revision.revision);
      if (existing) {
        if (stableJson(existing) !== stableJson(revision)) throw new Error('transcript_revision_conflict');
        if (!hit.timeline.some((item) => item.kind === 'transcript_revision' && item.transcript.transcript_id === revision.transcript_id && item.transcript.revision === revision.revision)) {
          const timelineEntry: ClassroomTimelineEntry = {
            schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: hit.timeline.length + 1,
            kind: 'transcript_revision', occurred_at: revision.corrected_at ?? revision.created_at, transcript: revision,
          };
          await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
          hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await this.persistMeta(hit.meta);
        }
        return structuredClone(existing);
      }
      if (revision.revision !== history.length + 1) throw new Error('transcript_revision_conflict');
      await mkdir(directory, { recursive: true }); await writeJsonAtomic(path, [...current, revision]);
      const timelineEntry: ClassroomTimelineEntry = {
        schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: hit.timeline.length + 1,
        kind: 'transcript_revision', occurred_at: revision.corrected_at ?? revision.created_at, transcript: revision,
      };
      await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
      hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await this.persistMeta(hit.meta);
      return structuredClone(revision);
    });
  }

  async listTranscriptRevisions(classroomId: string): Promise<ClassroomTranscriptRevision[]> {
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    return structuredClone(await readJson<ClassroomTranscriptRevision[]>(join(this.classroomDir(classroomId), 'teacher', 'transcript_revisions.json')) ?? []);
  }

  async getTranscriptClearMarker(classroomId: string): Promise<ClassroomTranscriptClearMarker | null> {
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    return readJson<ClassroomTranscriptClearMarker>(join(this.classroomDir(classroomId), 'teacher', 'transcript_clear.json'));
  }

  async isTranscriptChunkCleared(classroomId: string, recordingId: string, chunkId: string): Promise<boolean> {
    const marker = await this.getTranscriptClearMarker(classroomId);
    return marker?.cleared_chunks.some((item) => item.recording_id === recordingId && item.chunk_id === chunkId) ?? false;
  }

  async clearTranscriptHistory(classroomId: string): Promise<ClassroomTranscriptClearMarker> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId); if (!hit) throw new Error('classroom_not_found');
      const directory = join(this.classroomDir(classroomId), 'teacher'); await mkdir(directory, { recursive: true });
      const transcripts = await readJson<ClassroomTranscriptRevision[]>(join(directory, 'transcript_revisions.json')) ?? [];
      const recording = await readJson<ClassroomRecordingState>(join(directory, 'audio_recording.json'));
      const descriptors = recording ? await this.listAudioChunkDescriptors(classroomId, recording.recording_id) : [];
      const previous = await readJson<ClassroomTranscriptClearMarker>(join(directory, 'transcript_clear.json'));
      const cleared = new Map<string, { recording_id: string; chunk_id: string }>();
      for (const item of previous?.cleared_chunks ?? []) cleared.set(`${item.recording_id}:${item.chunk_id}`, item);
      for (const item of transcripts) cleared.set(`${item.recording_id}:${item.chunk_id}`, { recording_id: item.recording_id, chunk_id: item.chunk_id });
      for (const item of descriptors) cleared.set(`${recording!.recording_id}:${item.chunk_id}`, { recording_id: recording!.recording_id, chunk_id: item.chunk_id });
      const marker: ClassroomTranscriptClearMarker = { cleared_at: new Date().toISOString(), cleared_chunks: [...cleared.values()] };
      await writeJsonAtomic(join(directory, 'transcript_clear.json'), marker);
      await writeJsonAtomic(join(directory, 'transcript_revisions.json'), []);
      await rm(join(directory, 'transcription_state.json'), { force: true });
      const retained = hit.timeline.filter((item) => item.kind !== 'transcript_revision' && item.kind !== 'transcription_state')
        .map((item, index) => ({ ...item, timeline_sequence: index + 1 })) as ClassroomTimelineEntry[];
      await writeFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), retained.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8');
      hit.timeline = retained;
      hit.meta.latest_timeline_sequence = retained.length;
      await this.persistMeta(hit.meta);
      return structuredClone(marker);
    });
  }

  async putTranscriptionState(classroomId: string, state: ClassroomTranscriptionState): Promise<ClassroomTranscriptionState> {
    return this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId); if (!hit) throw new Error('classroom_not_found');
      if (state.classroom_id !== classroomId) throw new Error('transcription_classroom_mismatch');
      const issues = validateClassroomTranscriptionState(state);
      if (issues.length) throw new Error(`invalid_transcription_state:${issues.map((issue) => `${issue.path} ${issue.message}`).join(';')}`);
      const directory = join(this.classroomDir(classroomId), 'teacher'); await mkdir(directory, { recursive: true });
      await writeJsonAtomic(join(directory, 'transcription_state.json'), state);
      const last = [...hit.timeline].reverse().find((item) => item.kind === 'transcription_state');
      const changed = last?.kind !== 'transcription_state' || last.transcription.state !== state.state
        || last.transcription.last_error_code !== state.last_error_code || last.transcription.audio_available !== state.audio_available;
      if (changed) {
        const timelineEntry: ClassroomTimelineEntry = {
          schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroomId, timeline_sequence: hit.timeline.length + 1,
          kind: 'transcription_state', occurred_at: state.updated_at, transcription: state,
        };
        await appendFile(join(this.classroomDir(classroomId), 'timeline.jsonl'), `${JSON.stringify(timelineEntry)}\n`, 'utf8');
        hit.timeline.push(timelineEntry); hit.meta.latest_timeline_sequence = timelineEntry.timeline_sequence; await this.persistMeta(hit.meta);
      }
      return structuredClone(state);
    });
  }

  async getTranscriptionState(classroomId: string): Promise<ClassroomTranscriptionState | null> {
    if (!this.classrooms.has(classroomId)) throw new Error('classroom_not_found');
    return readJson<ClassroomTranscriptionState>(join(this.classroomDir(classroomId), 'teacher', 'transcription_state.json'));
  }

  async deleteClassroom(classroomId: string): Promise<void> {
    await this.serialize(classroomId, async () => {
      const hit = this.classrooms.get(classroomId);
      if (!hit) throw new Error('classroom_not_found');
      if (hit.meta.status !== 'ended') throw new Error('classroom_not_ended');
      const activeDirectory = this.classroomDir(classroomId);
      const tombstoneDirectory = `${activeDirectory}.deleted`;
      await rename(activeDirectory, tombstoneDirectory);
      this.unindexClassroom(hit.meta);
      this.classrooms.delete(classroomId);
      await rm(tombstoneDirectory, { recursive: true, force: true });
    });
  }
}
