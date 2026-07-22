import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLASSROOM_SCHEMA_VERSION } from 'ink-surface-sdk/runtime-schema';
import { createClassroomHandler } from './classroom-handler';
import { ClassroomService } from './classroom-service';
import { JsonClassroomStore } from './classroom-store';
import { ClassroomAiService } from './classroom-ai';
import { ClassroomMaterialService } from './classroom-materials';
import { ClassroomRecognitionService } from './classroom-recognition';
import { ClassroomAudioService } from './classroom-audio';
import { ClassroomTranscriptionService } from './classroom-transcription';

let server: Server | null = null;

async function start(): Promise<string> {
  const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-handler-')));
  const service = new ClassroomService(store);
  const transcription = new ClassroomTranscriptionService(store, service, { provider: async () => ({
    provider: 'handler_transcription_fixture', processing_mode: 'local',
    segments: [{ segment_id: 'step_1', status: 'final', relative_start_ms: 0, relative_end_ms: 20, text: '两边加九', confidence: 0.91 }],
  }) });
  const handler = createClassroomHandler({
    store, service,
    materials: new ClassroomMaterialService(store, service),
    recognition: new ClassroomRecognitionService(store, async () => ({ kind: 'formula', text: 'x² + 4x = 5', latex: 'x^2+4x=5', confidence: 0.81, provider: 'handler_fixture' })),
    audio: new ClassroomAudioService(store, transcription), transcription,
    allowInsecureAudio: true,
    ai: new ClassroomAiService(store, { gateway: async (input) => ({ title: 'Private', sections: [{ content: 'Scoped result', event_ids: [input.evidence[0].event_id] }] }) }),
    allowOrigins: ['http://teacher.local'],
  });
  server = createServer((req, res) => void handler(req, res).then((handled) => {
    if (!handled) { res.statusCode = 404; res.end('not found'); }
  }));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

function json(base: string, path: string, method = 'GET', token?: string, body?: unknown, origin = 'http://teacher.local'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function pdf(base: string, path: string, token: string, bytes: Uint8Array, key: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { origin: 'http://teacher.local', authorization: `Bearer ${token}`, 'content-type': 'application/pdf', 'idempotency-key': key, 'x-material-title': encodeURIComponent('课堂课本') },
    body: Buffer.from(bytes),
  });
}

function boardInput(id: string): unknown {
  return {
    schema_version: CLASSROOM_SCHEMA_VERSION,
    client_event_id: id,
    event: {
      event_id: `ink_${id}`, trace_id: `trace_${id}`, session_id: 'client_value', surface_id: 'board', pen_id: 'teacher',
      event_type: 'stroke', stroke_refs: [`stroke_${id}`], bbox_norm: [0.1, 0.1, 0.1, 0.1], ts_start_ms: 1, ts_end_ms: 2,
      source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: 'pen' },
    },
    stroke: { stroke_id: `stroke_${id}`, session_id: 'client_value', surface_id: 'board', pen_id: 'teacher', points: [{ x_norm: 0.1, y_norm: 0.1, t_ms: 1 }], bbox_norm: [0.1, 0.1, 0.1, 0.1], ts_start_ms: 1, ts_end_ms: 2 },
  };
}

const sseReaders = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, { decoder: TextDecoder; buffer: string }>();

async function readSse(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<Record<string, unknown>> {
  const state = sseReaders.get(reader) ?? { decoder: new TextDecoder(), buffer: '' };
  sseReaders.set(reader, state);
  for (;;) {
    for (;;) {
      const boundary = state.buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const frame = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim() || '{}';
      if (event === expected) return JSON.parse(data) as Record<string, unknown>;
    }
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended');
    state.buffer += state.decoder.decode(value, { stream: true });
  }
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('classroom handler', () => {
  it('enforces lifecycle roles and supports snapshot plus authenticated stream replay', async () => {
    const base = await start();
    const create = await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Algebra' });
    const created = await create.json() as { classroom: { classroom_id: string }; class_code: string; teacher_credential: string };
    expect(create.status).toBe(201);
    const id = created.classroom.classroom_id;
    expect((await json(base, `/v1/classrooms/${id}/start`, 'POST', created.teacher_credential)).status).toBe(200);

    const joinedResponse = await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'Student' });
    const joined = await joinedResponse.json() as { participant_credential: string };
    expect(joinedResponse.status).toBe(201);
    expect((await json(base, `/v1/classrooms/${id}/events`, 'POST', joined.participant_credential, boardInput('forbidden'))).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/events`, 'POST', created.teacher_credential, boardInput('one'))).status).toBe(200);

    const snapshot = await json(base, `/v1/classrooms/${id}/snapshot`, 'GET', joined.participant_credential);
    expect(await snapshot.json()).toMatchObject({ snapshot_sequence: 1, board_events: [{ sequence: 1 }] });

    const controller = new AbortController();
    const stream = await fetch(`${base}/v1/classrooms/${id}/stream?cursor=0`, { headers: { authorization: `Bearer ${joined.participant_credential}`, origin: 'http://teacher.local' }, signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect(await readSse(reader, 'board_event')).toMatchObject({ sequence: 1 });
    const previewPending = readSse(reader, 'preview');
    const previewResponse = await json(base, `/v1/classrooms/${id}/preview`, 'POST', created.teacher_credential, {
      schema_version: CLASSROOM_SCHEMA_VERSION,
      client_event_id: 'preview_two', revision: 1, points: [{ x_norm: 0.2, y_norm: 0.2, t_ms: 2 }], tool: 'pen', expires_at_ms: Date.now() + 1_000,
    });
    expect(previewResponse.status).toBe(202);
    await expect(previewPending).resolves.toMatchObject({ preview: { client_event_id: 'preview_two' } });
    const pending = readSse(reader, 'board_event');
    await json(base, `/v1/classrooms/${id}/events`, 'POST', created.teacher_credential, boardInput('two'));
    await expect(pending).resolves.toMatchObject({ sequence: 2 });
    controller.abort();

    expect((await json(base, `/v1/classrooms/${id}/end`, 'POST', joined.participant_credential)).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/end`, 'POST', created.teacher_credential)).status).toBe(200);
    expect((await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'Late' })).status).toBe(409);
    const deleteController = new AbortController();
    const endedStream = await fetch(`${base}/v1/classrooms/${id}/stream?cursor=2`, { headers: { authorization: `Bearer ${joined.participant_credential}`, origin: 'http://teacher.local' }, signal: deleteController.signal });
    const endedReader = endedStream.body!.getReader();
    const deleted = readSse(endedReader, 'class_deleted');
    expect((await json(base, `/v1/classrooms/${id}`, 'DELETE', created.teacher_credential)).status).toBe(200);
    await expect(deleted).resolves.toMatchObject({ type: 'class_deleted' });
    deleteController.abort();
  });

  it('fails closed for an untrusted origin and missing credentials', async () => {
    const base = await start();
    expect((await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Nope' }, 'http://evil.local')).status).toBe(403);
    expect((await json(base, '/v1/classrooms/unknown/snapshot')).status).toBe(401);
  });

  it('rejects audio API access over an insecure transport by default', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-handler-secure-audio-')));
    const service = new ClassroomService(store);
    const handler = createClassroomHandler({ store, service, audio: new ClassroomAudioService(store), allowOrigins: ['http://teacher.local'] });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    const created = await (await json(base, '/v1/classrooms', 'POST', undefined, { title: 'HTTPS gate' })).json() as { classroom: { classroom_id: string }; teacher_credential: string };
    const response = await json(base, `/v1/classrooms/${created.classroom.classroom_id}/audio/recording`, 'GET', created.teacher_credential);
    expect(response.status).toBe(426); expect(await response.json()).toEqual({ error: 'https_required' });
  });

  it('fails closed for every classroom API route when the host requires HTTPS', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-handler-secure-all-')));
    const handler = createClassroomHandler({ store, service: new ClassroomService(store), requireSecureTransport: true });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const response = await json(`http://127.0.0.1:${address.port}`, '/v1/classrooms', 'POST', undefined, { title: 'Must use HTTPS' });
    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: 'https_required' });
    expect(store.listClassroomIds()).toEqual([]);
  });

  it('returns client errors for malformed JSON, invalid board payloads, and excessive join attempts', async () => {
    const base = await start();
    const malformed = await fetch(`${base}/v1/classrooms`, { method: 'POST', headers: { origin: 'http://teacher.local', 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'json_invalid' });

    const created = await (await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Limits' })).json() as { classroom: { classroom_id: string }; class_code: string; teacher_credential: string };
    await json(base, `/v1/classrooms/${created.classroom.classroom_id}/start`, 'POST', created.teacher_credential);
    const invalid = boardInput('oversized') as { stroke: { points: unknown[] } };
    invalid.stroke.points = Array.from({ length: 4_097 }, () => ({ x_norm: 0.1, y_norm: 0.1, t_ms: 1 }));
    expect((await json(base, `/v1/classrooms/${created.classroom.classroom_id}/events`, 'POST', created.teacher_credential, invalid)).status).toBe(400);

    const statuses: number[] = [];
    for (let index = 0; index < 13; index += 1) statuses.push((await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: `Student ${index}` })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('scopes education jobs to the bearer participant and keeps them out of the shared stream', async () => {
    const base = await start();
    const created = await (await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Education AI' })).json() as { classroom: { classroom_id: string }; class_code: string; teacher_credential: string };
    const id = created.classroom.classroom_id;
    await json(base, `/v1/classrooms/${id}/start`, 'POST', created.teacher_credential);
    const first = await (await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'One' })).json() as { participant_credential: string };
    const second = await (await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'Two' })).json() as { participant_credential: string };
    await json(base, `/v1/classrooms/${id}/events`, 'POST', created.teacher_credential, boardInput('evidence'));
    const streamController = new AbortController();
    const stream = await fetch(`${base}/v1/classrooms/${id}/stream?cursor=1`, { headers: { authorization: `Bearer ${first.participant_credential}`, origin: 'http://teacher.local' }, signal: streamController.signal });
    const reader = stream.body!.getReader();
    await readSse(reader, 'ready');

    const response = await json(base, `/v1/classrooms/${id}/education-jobs`, 'POST', first.participant_credential, { kind: 'live_explanation', client_request_id: 'private_one' });
    const payload = await response.json() as { job: { job_id: string; result: { title: string } } };
    expect(response.status).toBe(201);
    expect(payload.job.result.title).toBe('Private');
    expect((await json(base, `/v1/classrooms/${id}/education-jobs/${payload.job.job_id}`, 'GET', second.participant_credential)).status).toBe(404);
    expect(await (await json(base, `/v1/classrooms/${id}/education-jobs`, 'GET', second.participant_credential)).json()).toEqual({ jobs: [] });

    const noPrivateFrame = await Promise.race([
      readSse(reader, 'education_job').then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 75)),
    ]);
    expect(noPrivateFrame).toBe(true);
    streamController.abort();
  });

  it('allows only the teacher to publish PDF materials and authenticated classroom members to read them', async () => {
    const base = await start();
    const created = await (await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Materials' })).json() as { classroom: { classroom_id: string }; class_code: string; teacher_credential: string };
    const id = created.classroom.classroom_id;
    await json(base, `/v1/classrooms/${id}/start`, 'POST', created.teacher_credential);
    const joined = await (await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'Reader' })).json() as { participant_credential: string };
    const bytes = new Uint8Array(await readFile(join(process.cwd(), 'public/sample.pdf')));

    expect((await pdf(base, `/v1/classrooms/${id}/materials`, joined.participant_credential, bytes, 'student_upload')).status).toBe(403);
    const uploaded = await pdf(base, `/v1/classrooms/${id}/materials`, created.teacher_credential, bytes, 'teacher_upload');
    const payload = await uploaded.json() as { material: { material_id: string } };
    expect(uploaded.status).toBe(201);
    const listed = await json(base, `/v1/classrooms/${id}/materials`, 'GET', joined.participant_credential);
    expect(await listed.json()).toMatchObject({ materials: [{ material_id: payload.material.material_id }] });
    const content = await json(base, `/v1/classrooms/${id}/materials/${payload.material.material_id}`, 'GET', joined.participant_credential);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('application/pdf');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    expect((await json(base, `/v1/classrooms/${id}/materials/${payload.material.material_id}`, 'GET')).status).toBe(401);
    expect((await json(base, `/v1/classrooms/${id}/materials/material_unknown`, 'GET', joined.participant_credential)).status).toBe(404);
    const teacherView = await json(base, `/v1/classrooms/${id}/teacher-view`, 'POST', created.teacher_credential, {
      material_id: payload.material.material_id, page_index: 0, zoom_mode: 'percent', zoom_percent: 120,
      active_surface: { kind: 'textbook_page', material_id: payload.material.material_id, page_index: 0 }, revision: 1, updated_at: '2026-07-19T01:00:00.000Z',
    });
    expect(teacherView.status).toBe(200);
    expect((await json(base, `/v1/classrooms/${id}/teacher-view`, 'POST', joined.participant_credential, {})).status).toBe(403);
  });

  it('allows only teachers to submit and review recognition while students can read trust state', async () => {
    const base = await start();
    const created = await (await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Recognition API' })).json() as { classroom: { classroom_id: string }; class_code: string; teacher_credential: string };
    const id = created.classroom.classroom_id; await json(base, `/v1/classrooms/${id}/start`, 'POST', created.teacher_credential);
    const joined = await (await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'Student' })).json() as { participant_credential: string };
    await json(base, `/v1/classrooms/${id}/events`, 'POST', created.teacher_credential, { ...(boardInput('formula') as object), surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 } });
    const input = { client_request_id: 'recognize_formula', event_ids: ['ink_formula'], surface: { kind: 'textbook_page', material_id: 'material_1', page_index: 0 }, bbox_norm: [0, 0, 0.5, 0.5], processing_mode: 'local' };
    expect((await json(base, `/v1/classrooms/${id}/recognitions`, 'POST', joined.participant_credential, input)).status).toBe(403);
    const recognized = await json(base, `/v1/classrooms/${id}/recognitions`, 'POST', created.teacher_credential, input);
    const payload = await recognized.json() as { recognition: { recognition_id: string } };
    expect(recognized.status).toBe(201);
    expect(await (await json(base, `/v1/classrooms/${id}/recognitions`, 'GET', joined.participant_credential)).json()).toMatchObject({ recognitions: [{ status: 'pending' }] });
    expect((await json(base, `/v1/classrooms/${id}/recognitions/${payload.recognition.recognition_id}/review`, 'POST', joined.participant_credential, { status: 'confirmed' })).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/recognitions/${payload.recognition.recognition_id}/review`, 'POST', created.teacher_credential, { status: 'confirmed' })).status).toBe(200);
  });

  it('isolates audio signaling and recording writes by classroom role', async () => {
    const base = await start();
    const created = await (await json(base, '/v1/classrooms', 'POST', undefined, { title: 'Audio API' })).json() as { classroom: { classroom_id: string }; class_code: string; teacher_credential: string };
    const id = created.classroom.classroom_id; await json(base, `/v1/classrooms/${id}/start`, 'POST', created.teacher_credential);
    const first = await (await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'One' })).json() as { participant_credential: string };
    const second = await (await json(base, '/v1/classrooms/join', 'POST', undefined, { class_code: created.class_code, nickname: 'Two' })).json() as { participant_credential: string };
    expect((await json(base, `/v1/classrooms/${id}/audio/signals`, 'POST', first.participant_credential, { message_id: 'ready_one', negotiation_generation: 1, type: 'ready', payload: {} })).status).toBe(201);
    expect((await (await json(base, `/v1/classrooms/${id}/audio/signals?cursor=0`, 'GET', second.participant_credential)).json() as { messages: unknown[] }).messages).toEqual([]);
    expect((await (await json(base, `/v1/classrooms/${id}/audio/signals?cursor=0`, 'GET', created.teacher_credential)).json() as { messages: unknown[] }).messages).toHaveLength(1);
    expect((await json(base, `/v1/classrooms/${id}/audio/recording/start`, 'POST', first.participant_credential)).status).toBe(403);
    const started = await json(base, `/v1/classrooms/${id}/audio/recording/start`, 'POST', created.teacher_credential);
    const recording = (await started.json() as { recording: { recording_id: string; recording_generation: number } }).recording;
    expect(started.status).toBe(201);
    expect((await json(base, `/v1/classrooms/${id}/audio/recording/${recording.recording_id}/chunks`, 'POST', first.participant_credential, {})).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/audio/recording/${recording.recording_id}/chunks`, 'POST', created.teacher_credential, { recording_generation: recording.recording_generation, chunk_id: 'chunk_1', sequence: 1, sample_rate: 16000, channels: 1, relative_start_ms: 0, relative_end_ms: 20, pcm_s16le_base64: Buffer.alloc(640).toString('base64') })).status).toBe(200);
    let transcriptPayload: { transcripts: Array<{ transcript_id: string; text: string }> } = { transcripts: [] };
    for (let index = 0; index < 20 && transcriptPayload.transcripts.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      transcriptPayload = await (await json(base, `/v1/classrooms/${id}/transcripts`, 'GET', first.participant_credential)).json() as typeof transcriptPayload;
    }
    expect(transcriptPayload.transcripts).toMatchObject([{ text: '两边加九' }]);
    const transcriptId = transcriptPayload.transcripts[0].transcript_id;
    expect((await json(base, `/v1/classrooms/${id}/transcripts/${transcriptId}/correct`, 'POST', first.participant_credential, { text: '两边同时加九' })).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/transcripts/${transcriptId}/correct`, 'POST', created.teacher_credential, { text: '两边同时加九' })).status).toBe(200);
    expect((await json(base, `/v1/classrooms/${id}/transcripts`, 'DELETE', first.participant_credential)).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/transcripts`, 'DELETE', created.teacher_credential)).status).toBe(200);
    expect(await (await json(base, `/v1/classrooms/${id}/transcripts`, 'GET', first.participant_credential)).json()).toEqual({ transcripts: [], transcription: null, processing_mode: 'local' });
    expect((await json(base, `/v1/classrooms/${id}/audio/recording`, 'DELETE', first.participant_credential)).status).toBe(403);
    expect((await json(base, `/v1/classrooms/${id}/audio/recording`, 'DELETE', created.teacher_credential)).status).toBe(200);
    expect(await (await json(base, `/v1/classrooms/${id}/transcripts`, 'GET', first.participant_credential)).json()).toEqual({ transcripts: [], transcription: null, processing_mode: 'local' });
  });
});
