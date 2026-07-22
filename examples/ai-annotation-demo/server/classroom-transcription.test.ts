import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClassroomService } from './classroom-service';
import { JsonClassroomStore } from './classroom-store';
import { ClassroomTranscriptionService, resolveClassroomDeliveryMode, validateTranscriptionProviderUrl } from './classroom-transcription';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'classroom-transcription-'));
  const store = await JsonClassroomStore.open(root);
  const created = await store.createClassroom('Transcript'); const classroomId = created.classroom.classroom_id;
  await store.transition(classroomId, 'live');
  await store.putRecordingState(classroomId, {
    recording_id: 'recording_1', classroom_id: classroomId, classroom_generation: 2, recording_generation: 1,
    state: 'recording', health: 'healthy', chunk_count: 0, byte_count: 0, last_sequence: 0, last_relative_end_ms: 0,
    started_at: '2026-07-19T00:00:00.000Z',
  });
  return { root, store, service: new ClassroomService(store), classroomId };
}

const chunk = {
  recording_id: 'recording_1', recording_generation: 1, classroom_generation: 2, chunk_id: 'chunk_1',
  chunk_hash: `sha256:${'a'.repeat(64)}` as const, sequence: 1, sample_rate: 16_000, channels: 1,
  relative_start_ms: 0, relative_end_ms: 2_000, pcm_s16le: new Uint8Array(64_000),
};

describe('ClassroomTranscriptionService', () => {
  it('keeps the final ASR revision and appends a separate safe stabilized revision', async () => {
    const setup = await fixture();
    const transcription = new ClassroomTranscriptionService(setup.store, setup.service, {
      provider: async () => ({
        provider: 'fixture_streaming', processing_mode: 'local', language: 'zh-en', stream_id: 'stream_1',
        segments: [{ segment_id: 'utterance_1', status: 'final', relative_start_ms: 0, relative_end_ms: 500, text: '得到完全平房', confidence: 0.82 }],
      }),
      stabilizer: async () => ({ text: '得到完全平方。', reasons: ['context_term', 'terminal_punctuation'] }),
    });
    await transcription.transcribeChunk(setup.classroomId, chunk);
    expect(await setup.store.listTranscriptRevisions(setup.classroomId)).toMatchObject([
      { revision: 1, status: 'final', text: '得到完全平房', provider: 'fixture_streaming' },
      { revision: 2, status: 'corrected', text: '得到完全平方。', provider: 'fixture_streaming_stabilizer', original_revision: 1 },
    ]);
  });

  it('turns durable PCM into ordered provisional/final revisions without exposing raw audio', async () => {
    const setup = await fixture();
    const transcription = new ClassroomTranscriptionService(setup.store, setup.service, { provider: async (input) => {
      expect(input.wav_bytes.slice(0, 4)).toEqual(Uint8Array.from([82, 73, 70, 70]));
      return { provider: 'fixture_whisper', processing_mode: 'local', segments: [
        { segment_id: 'step_1', status: 'provisional', relative_start_ms: 100, relative_end_ms: 800, text: '两边加九', confidence: 0.71 },
        { segment_id: 'step_1', status: 'final', relative_start_ms: 100, relative_end_ms: 900, text: '两边加九，得到完全平方', confidence: 0.94 },
      ] };
    } });
    await transcription.transcribeChunk(setup.classroomId, chunk);
    const history = await setup.store.listTranscriptRevisions(setup.classroomId);
    expect(history.map((item) => [item.status, item.revision, item.text])).toEqual([
      ['provisional', 1, '两边加九'], ['final', 2, '两边加九，得到完全平方'],
    ]);
    expect(await setup.store.getTranscriptionState(setup.classroomId)).toMatchObject({ state: 'ready', processed_chunk_count: 1, failed_chunk_count: 0 });
    expect(JSON.stringify(await setup.store.getTimeline(setup.classroomId))).not.toMatch(/pcm_s16le|wav_bytes|base64/i);
  });

  it('deduplicates overlapping final text and lets the teacher append a correction', async () => {
    const setup = await fixture();
    const provider = vi.fn(async () => ({ provider: 'fixture_whisper', processing_mode: 'local' as const, segments: [
      { segment_id: 'overlap', status: 'final' as const, relative_start_ms: 1_200, relative_end_ms: 1_900, text: '正二', confidence: 0.42 },
    ] }));
    const transcription = new ClassroomTranscriptionService(setup.store, setup.service, { provider });
    await transcription.transcribeChunk(setup.classroomId, chunk);
    await transcription.transcribeChunk(setup.classroomId, { ...chunk, chunk_id: 'chunk_2', chunk_hash: `sha256:${'b'.repeat(64)}`, sequence: 2, relative_start_ms: 1_000, relative_end_ms: 3_000 });
    expect((await setup.store.listTranscriptRevisions(setup.classroomId)).filter((item) => item.status === 'final')).toHaveLength(1);
    const corrected = await transcription.correct(setup.classroomId, (await setup.store.listTranscriptRevisions(setup.classroomId))[0].transcript_id, '正负二');
    expect(corrected).toMatchObject({ status: 'corrected', revision: 2, text: '正负二', original_revision: 1 });
    expect((await setup.store.listTranscriptRevisions(setup.classroomId))).toHaveLength(2);
  });

  it('preserves audio and records retryable failure state when the provider fails', async () => {
    const setup = await fixture(); let fail = true;
    const transcription = new ClassroomTranscriptionService(setup.store, setup.service, { provider: async () => {
      if (fail) throw new Error('provider_timeout');
      return { provider: 'fixture_whisper', processing_mode: 'local', segments: [{ segment_id: 'retry', status: 'final', relative_start_ms: 0, relative_end_ms: 500, text: '移项', confidence: 0.9 }] };
    } });
    await expect(transcription.transcribeChunk(setup.classroomId, chunk)).rejects.toThrow('provider_timeout');
    expect(await setup.store.getTranscriptionState(setup.classroomId)).toMatchObject({ state: 'delayed', failed_chunk_count: 1, last_error_code: 'provider_timeout' });
    fail = false; await transcription.retryChunk(setup.classroomId, chunk.chunk_id);
    expect(await setup.store.getTranscriptionState(setup.classroomId)).toMatchObject({ state: 'ready', processed_chunk_count: 1 });
    await transcription.retryChunk(setup.classroomId, chunk.chunk_id);
    expect(await setup.store.getTranscriptionState(setup.classroomId)).toMatchObject({ state: 'ready', processed_chunk_count: 1 });
  });

  it('rebuilds a failed job from durable PCM after restart and can delete audio without deleting transcripts', async () => {
    const setup = await fixture();
    await setup.store.putAudioChunk(setup.classroomId, chunk.recording_id, chunk.chunk_id, chunk.sequence, chunk.pcm_s16le, chunk.chunk_hash.slice(7));
    const failed = new ClassroomTranscriptionService(setup.store, setup.service, { provider: async () => { throw new Error('provider_timeout'); } });
    await expect(failed.transcribeChunk(setup.classroomId, chunk)).rejects.toThrow('provider_timeout');
    const restartedStore = await JsonClassroomStore.open(setup.root); const restartedService = new ClassroomService(restartedStore);
    const restarted = new ClassroomTranscriptionService(restartedStore, restartedService, { provider: async () => ({
      provider: 'fixture_whisper', processing_mode: 'local', segments: [{ segment_id: 'restart', status: 'final', relative_start_ms: 0, relative_end_ms: 500, text: '完全平方', confidence: 0.9 }],
    }) });
    await restarted.retryChunk(setup.classroomId, chunk.chunk_id);
    expect(await restartedStore.listTranscriptRevisions(setup.classroomId)).toMatchObject([{ text: '完全平方' }]);
    expect(await restartedStore.deleteAudio(setup.classroomId)).toMatchObject({ audio_available: false });
    expect(await restartedStore.listTranscriptRevisions(setup.classroomId)).toHaveLength(1);
    await expect(restartedStore.getAudioChunk(setup.classroomId, chunk.recording_id, chunk.chunk_id)).resolves.toBeNull();
  });

  it('automatically retries a durable failed job after the provider is restored', async () => {
    const setup = await fixture();
    await setup.store.putAudioChunk(setup.classroomId, chunk.recording_id, chunk.chunk_id, chunk.sequence, chunk.pcm_s16le, chunk.chunk_hash.slice(7), {
      classroom_generation: 2, recording_generation: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 2_000,
    });
    const unavailable = new ClassroomTranscriptionService(setup.store, setup.service, { provider: async () => { throw new Error('transcription_provider_unavailable'); } });
    await expect(unavailable.transcribeChunk(setup.classroomId, chunk)).rejects.toThrow('transcription_provider_unavailable');
    const restartedStore = await JsonClassroomStore.open(setup.root);
    const restored = new ClassroomTranscriptionService(restartedStore, new ClassroomService(restartedStore), { provider: async () => ({
      provider: 'fixture_whisper', processing_mode: 'local', segments: [{ segment_id: 'restored', status: 'final', relative_start_ms: 0, relative_end_ms: 500, text: '服务恢复', confidence: 0.9 }],
    }) });
    await restored.recover();
    for (let index = 0; index < 20 && (await restartedStore.listTranscriptRevisions(setup.classroomId)).length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await restartedStore.listTranscriptRevisions(setup.classroomId)).toMatchObject([{ text: '服务恢复' }]);
  });

  it('recovers a manifest-only crash window and transcribes it after service restart', async () => {
    const setup = await fixture();
    await setup.store.putAudioChunk(setup.classroomId, chunk.recording_id, 'chunk_orphan', 1, chunk.pcm_s16le, 'c'.repeat(64), {
      classroom_generation: 2, recording_generation: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 2_000,
    });
    const restartedStore = await JsonClassroomStore.open(setup.root); const restartedService = new ClassroomService(restartedStore);
    const restarted = new ClassroomTranscriptionService(restartedStore, restartedService, { provider: async () => ({
      provider: 'fixture_whisper', processing_mode: 'local', segments: [{ segment_id: 'orphan', status: 'final', relative_start_ms: 0, relative_end_ms: 500, text: '移项', confidence: 0.9 }],
    }) });
    await restarted.recover();
    for (let index = 0; index < 20 && (await restartedStore.listTranscriptRevisions(setup.classroomId)).length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await restartedStore.listTranscriptRevisions(setup.classroomId)).toMatchObject([{ chunk_id: 'chunk_orphan', text: '移项' }]);
  });

  it('does not requeue a completed silent chunk after restart', async () => {
    const setup = await fixture();
    await setup.store.putAudioChunk(setup.classroomId, chunk.recording_id, 'chunk_silent', 1, chunk.pcm_s16le, 'd'.repeat(64), {
      classroom_generation: 2, recording_generation: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 2_000, language_hint: 'zh',
    });
    await setup.store.putTeacherRecord(setup.classroomId, 'transcription_job_chunk_silent', { status: 'completed' });
    const restartedStore = await JsonClassroomStore.open(setup.root); const provider = vi.fn(async () => ({
      provider: 'fixture', processing_mode: 'local' as const, segments: [],
    }));
    await new ClassroomTranscriptionService(restartedStore, new ClassroomService(restartedStore), { provider }).recover();
    expect(provider).not.toHaveBeenCalled();
  });

  it('clears stale retry buttons when those jobs already completed', async () => {
    const setup = await fixture();
    await setup.store.putTeacherRecord(setup.classroomId, 'transcription_job_chunk_done', { status: 'completed' });
    await setup.store.putTranscriptionState(setup.classroomId, {
      classroom_id: setup.classroomId, recording_id: chunk.recording_id, recording_generation: 1, state: 'delayed', provider: 'fixture', processing_mode: 'local',
      processed_chunk_count: 1, failed_chunk_count: 1, retryable_chunk_ids: ['chunk_done'], last_error_code: 'transcription_queue_full', audio_available: true, updated_at: 'now',
    });
    await new ClassroomTranscriptionService(setup.store, setup.service, { provider: vi.fn() }).recover();
    expect(await setup.store.getTranscriptionState(setup.classroomId)).toMatchObject({ state: 'ready', failed_chunk_count: 0, retryable_chunk_ids: [] });
  });

  it('passes the selected classroom language to the provider', async () => {
    const setup = await fixture(); const provider = vi.fn(async (input) => ({
      provider: 'fixture', processing_mode: 'local' as const, language: input.language_hint, segments: [],
    }));
    await new ClassroomTranscriptionService(setup.store, setup.service, { provider }).transcribeChunk(setup.classroomId, { ...chunk, language_hint: 'en' });
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ language_hint: 'en' }), expect.any(AbortSignal));
  });

  it('waits for queued audio before finalizing the streaming recognizer', async () => {
    const setup = await fixture();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: Array<{ sequence: number; finalize?: boolean }> = [];
    const transcription = new ClassroomTranscriptionService(setup.store, setup.service, { provider: async (input) => {
      calls.push({ sequence: input.sequence, finalize: input.finalize });
      if (!input.finalize) await firstBlocked;
      return { provider: 'fixture', processing_mode: 'local', segments: [] };
    } });
    void transcription.enqueueChunk(setup.classroomId, chunk);
    for (let index = 0; index < 20 && calls.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    const finalizing = transcription.finalizeRecording(setup.classroomId, chunk.recording_id, chunk.recording_generation);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual([{ sequence: 1, finalize: false }]);
    releaseFirst();
    await finalizing;
    expect(calls).toEqual([{ sequence: 1, finalize: false }, { sequence: 1, finalize: true }]);
  });

  it('does not resurrect cleared audio chunks after restart and still transcribes new speech', async () => {
    const setup = await fixture();
    await setup.store.putAudioChunk(setup.classroomId, chunk.recording_id, chunk.chunk_id, chunk.sequence, chunk.pcm_s16le, chunk.chunk_hash.slice(7), {
      classroom_generation: 2, recording_generation: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 2_000,
    });
    await setup.store.clearTranscriptHistory(setup.classroomId);
    const restartedStore = await JsonClassroomStore.open(setup.root); const provider = vi.fn(async () => ({
      provider: 'fixture_whisper', processing_mode: 'local' as const, segments: [{ segment_id: 'new', status: 'final' as const, relative_start_ms: 2_000, relative_end_ms: 2_500, text: '新的讲解', confidence: 0.9 }],
    }));
    const restarted = new ClassroomTranscriptionService(restartedStore, new ClassroomService(restartedStore), { provider });
    await restarted.recover();
    expect(provider).not.toHaveBeenCalled();
    const next = { ...chunk, chunk_id: 'chunk_2', chunk_hash: `sha256:${'c'.repeat(64)}` as const, sequence: 2, relative_start_ms: 2_000, relative_end_ms: 4_000 };
    await restarted.transcribeChunk(setup.classroomId, next);
    expect(await restartedStore.listTranscriptRevisions(setup.classroomId)).toMatchObject([{ chunk_id: 'chunk_2', text: '新的讲解' }]);
  });

  it('rejects unsafe provider destinations and invalid or late output', async () => {
    await expect(validateTranscriptionProviderUrl('http://127.0.0.1:8178/v1/transcribe', 'local', false)).resolves.toBeInstanceOf(URL);
    await expect(validateTranscriptionProviderUrl('http://192.168.1.8:8178/v1/transcribe', 'local', false)).rejects.toThrow('transcription_provider_loopback_required');
    await expect(validateTranscriptionProviderUrl('http://example.com/v1/transcribe', 'external', true)).rejects.toThrow('transcription_provider_https_required');
    await expect(validateTranscriptionProviderUrl('https://192.168.1.8/v1/transcribe', 'external', true)).rejects.toThrow('transcription_provider_private_address');
    await expect(validateTranscriptionProviderUrl('https://api.example.com/v1/transcribe', 'external', false)).rejects.toThrow('transcription_external_opt_in_required');
    const setup = await fixture();
    const transcription = new ClassroomTranscriptionService(setup.store, setup.service, { provider: async () => ({ provider: 'bad', processing_mode: 'local', segments: [
      { segment_id: 'outside', status: 'final', relative_start_ms: 0, relative_end_ms: 9_000, text: 'invalid', confidence: 1 },
    ] }) });
    await expect(transcription.transcribeChunk(setup.classroomId, chunk)).rejects.toThrow('transcription_segment_time_invalid');
    await setup.store.transition(setup.classroomId, 'ended'); await setup.store.deleteClassroom(setup.classroomId);
    await expect(transcription.transcribeChunk(setup.classroomId, chunk)).rejects.toThrow('classroom_not_found');
  });
});

describe('resolveClassroomDeliveryMode', () => {
  it('expresses all three degradation modes without implying student capture', () => {
    expect(resolveClassroomDeliveryMode({ audioPlaying: true, transcriptReady: true, teacherCaptureAvailable: true })).toBe('audio_with_subtitles');
    expect(resolveClassroomDeliveryMode({ audioPlaying: false, transcriptReady: true, teacherCaptureAvailable: true })).toBe('subtitles_only');
    expect(resolveClassroomDeliveryMode({ audioPlaying: false, transcriptReady: false, teacherCaptureAvailable: false })).toBe('textbook_board_only');
  });
});
