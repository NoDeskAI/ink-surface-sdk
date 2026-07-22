import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClassroomAudioService } from './classroom-audio';
import { JsonClassroomStore } from './classroom-store';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'classroom-audio-'));
  const store = await JsonClassroomStore.open(root);
  const created = await store.createClassroom('Audio'); const id = created.classroom.classroom_id;
  await store.transition(id, 'live');
  const first = await store.joinClassroom(created.class_code, 'One');
  const second = await store.joinClassroom(created.class_code, 'Two');
  return { root, store, created, id, first, second };
}

describe('ClassroomAudioService', () => {
  it('scopes ephemeral signaling to teacher and one opaque participant', async () => {
    const setup = await fixture(); const audio = new ClassroomAudioService(setup.store);
    const ready = await audio.signal(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, { message_id: 'ready_1', negotiation_generation: 1, type: 'ready', payload: {} });
    expect((await audio.signals(setup.id, { role: 'teacher' }, 0)).messages).toMatchObject([{ signal_sequence: 1, participant_id: setup.first.participant_id, type: 'ready' }]);
    await expect(audio.signal(setup.id, { role: 'participant', participant_id: setup.second.participant_id }, { message_id: 'answer_bad', negotiation_generation: 1, participant_id: setup.first.participant_id, type: 'answer', payload: { sdp: 'secret' } })).rejects.toThrow('audio_signal_scope_invalid');
    await expect(audio.signal(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, { message_id: 'offer_bad', negotiation_generation: 1, type: 'offer', payload: { sdp: 'secret' } })).rejects.toThrow('audio_signal_direction_invalid');
    await audio.signal(setup.id, { role: 'teacher' }, { message_id: 'offer_1', negotiation_generation: 1, participant_id: setup.first.participant_id, type: 'offer', payload: { sdp: 'offer' } });
    await expect(audio.signal(setup.id, { role: 'participant', participant_id: setup.second.participant_id }, { message_id: 'offer_1', negotiation_generation: 1, type: 'answer', payload: { sdp: 'answer' } })).rejects.toThrow('audio_message_id_conflict');
    expect((await audio.signals(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, ready.signal_sequence)).messages).toMatchObject([{ type: 'offer', payload: { sdp: 'offer' }, sender_role: 'teacher' }]);
    expect((await audio.signals(setup.id, { role: 'participant', participant_id: setup.second.participant_id }, 0)).messages).toEqual([]);
    await audio.signal(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, { message_id: 'ready_2', negotiation_generation: 2, type: 'ready', payload: {} });
    await expect(audio.signal(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, { message_id: 'stale_ice', negotiation_generation: 1, type: 'ice', payload: { candidate: {} } })).rejects.toThrow('negotiation_generation_stale');
    expect((await audio.signals(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, 0)).messages).toEqual([]);
  });

  it('keeps signaling cursors monotonic after old mailbox entries expire', async () => {
    const setup = await fixture(); const audio = new ClassroomAudioService(setup.store);
    const first = await audio.signal(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, { message_id: 'ready_old', negotiation_generation: 1, type: 'ready', payload: {} });
    (audio as unknown as { signalMailboxes: Map<string, Array<{ expires_at_ms: number }>> }).signalMailboxes.get(setup.id)![0].expires_at_ms = 0;
    const next = await audio.signal(setup.id, { role: 'participant', participant_id: setup.first.participant_id }, { message_id: 'ready_new', negotiation_generation: 2, type: 'ready', payload: {} });
    expect(next.signal_sequence).toBe(first.signal_sequence + 1);
    expect(await audio.signals(setup.id, { role: 'teacher' }, first.signal_sequence)).toMatchObject({ cursor: next.signal_sequence, messages: [{ message_id: 'ready_new' }] });
  });

  it('persists bounded PCM chunks idempotently and exposes gaps as recording health', async () => {
    const setup = await fixture(); const audio = new ClassroomAudioService(setup.store);
    const recording = await audio.start(setup.id);
    const first = await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_1', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 100, pcm_s16le_base64: Buffer.alloc(3_200).toString('base64') });
    expect(first).toMatchObject({ inserted: true, recording: { state: 'recording', health: 'healthy', chunk_count: 1 } });
    expect((await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_1', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 100, pcm_s16le_base64: Buffer.alloc(3_200).toString('base64') })).inserted).toBe(false);
    const gapped = await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_3', sequence: 3, sample_rate: 16_000, channels: 1, relative_start_ms: 300, relative_end_ms: 400, pcm_s16le_base64: Buffer.alloc(3_200).toString('base64') });
    expect(gapped.recording).toMatchObject({ health: 'incomplete', last_sequence: 3 });
    await expect(audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'truncated', sequence: 4, sample_rate: 16_000, channels: 1, relative_start_ms: 400, relative_end_ms: 500, pcm_s16le_base64: Buffer.alloc(12).toString('base64') })).rejects.toThrow('audio_chunk_size_mismatch');
  });

  it('interrupts active recordings on restart and rejects stopped or stale generations', async () => {
    const setup = await fixture(); const audio = new ClassroomAudioService(setup.store);
    const recording = await audio.start(setup.id); await audio.stop(setup.id, recording.recording_id, recording.recording_generation);
    await expect(audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'late', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 20, pcm_s16le_base64: Buffer.alloc(640).toString('base64') })).rejects.toThrow('recording_not_active');
    const next = await audio.start(setup.id);
    const restarted = new ClassroomAudioService(await JsonClassroomStore.open(setup.root));
    expect(await restarted.current(setup.id)).toMatchObject({ recording_id: next.recording_id, state: 'interrupted' });
    expect((await (await JsonClassroomStore.open(setup.root)).getTimeline(setup.id)).at(-1)).toMatchObject({ kind: 'recording_state', recording: { state: 'interrupted', health: 'incomplete' } });
  });

  it('preserves a client-observed upload failure when stopping the recording', async () => {
    const setup = await fixture(); const audio = new ClassroomAudioService(setup.store);
    const recording = await audio.start(setup.id);
    expect(await audio.stop(setup.id, recording.recording_id, recording.recording_generation, 'incomplete')).toMatchObject({ state: 'stopped', health: 'incomplete' });
  });

  it('reconciles a durable chunk after a crash and rejects a second ID for its sequence', async () => {
    const setup = await fixture(); const audio = new ClassroomAudioService(setup.store);
    const recording = await audio.start(setup.id); const bytes = Buffer.alloc(3_200); const payload = bytes.toString('base64');
    const { createHash } = await import('node:crypto');
    await setup.store.putAudioChunk(setup.id, recording.recording_id, 'chunk_crash', 1, bytes, createHash('sha256').update(bytes).digest('hex'));
    expect(await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_crash', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 100, pcm_s16le_base64: payload })).toMatchObject({ inserted: false, recording: { chunk_count: 1, last_sequence: 1 } });
    await expect(audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_alias', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 100, pcm_s16le_base64: payload })).rejects.toThrow('audio_chunk_sequence_conflict');
  });

  it('returns a saved PCM chunk only after its transcription job is durably registered', async () => {
    const setup = await fixture(); let registered = false;
    const audio = new ClassroomAudioService(setup.store, {
      enqueueChunk: async () => { registered = true; },
    } as never);
    const recording = await audio.start(setup.id);
    await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_registered', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 20, pcm_s16le_base64: Buffer.alloc(640).toString('base64') });
    expect(registered).toBe(true);
  });

  it('defaults transcription to Chinese and accepts explicit English mode', async () => {
    const setup = await fixture(); const received: Array<{ language_hint?: string }> = [];
    const audio = new ClassroomAudioService(setup.store, { enqueueChunk: async (_id: string, input: { language_hint?: string }) => { received.push(input); } } as never);
    const recording = await audio.start(setup.id); const pcm = Buffer.alloc(640).toString('base64');
    await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_zh', sequence: 1, sample_rate: 16_000, channels: 1, relative_start_ms: 0, relative_end_ms: 20, pcm_s16le_base64: pcm });
    await audio.appendChunk(setup.id, { recording_id: recording.recording_id, recording_generation: recording.recording_generation, chunk_id: 'chunk_en', sequence: 2, sample_rate: 16_000, channels: 1, relative_start_ms: 20, relative_end_ms: 40, pcm_s16le_base64: pcm, language_hint: 'en' });
    expect(received.map((item) => item.language_hint)).toEqual(['zh', 'en']);
  });
});
