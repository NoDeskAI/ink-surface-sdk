import type { ClassroomDeliveryMode, ClassroomTranscriptRevision, ClassroomTranscriptionState } from 'ink-surface-sdk/runtime-schema';
import type { ClassroomClient } from './classroom-client';

export function latestTranscriptProjection(history: readonly ClassroomTranscriptRevision[]): ClassroomTranscriptRevision[] {
  const latest = new Map<string, ClassroomTranscriptRevision>();
  for (const revision of history) {
    const current = latest.get(revision.transcript_id);
    if (!current || revision.revision > current.revision) latest.set(revision.transcript_id, revision);
  }
  return [...latest.values()].sort((a, b) => a.relative_start_ms - b.relative_start_ms || a.transcript_id.localeCompare(b.transcript_id));
}

export function formatTranscriptTime(relativeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(relativeMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function classroomDeliveryMode(input: { audioPlaying: boolean; transcription?: ClassroomTranscriptionState | null }): ClassroomDeliveryMode {
  const transcriptReady = input.transcription?.state === 'ready' || input.transcription?.state === 'transcribing';
  if (input.audioPlaying && transcriptReady) return 'audio_with_subtitles';
  if (transcriptReady) return 'subtitles_only';
  return 'textbook_board_only';
}

export function classroomDeliveryLabel(mode: ClassroomDeliveryMode): string {
  if (mode === 'audio_with_subtitles') return '声音 + 实时字幕';
  if (mode === 'subtitles_only') return '仅字幕 · 课本和板书继续';
  return '仅课本与板书';
}

export class ClassroomTranscriptClient {
  constructor(private readonly client: ClassroomClient, private readonly classroomId: string) {}

  list(): Promise<{ transcripts: ClassroomTranscriptRevision[]; transcription: ClassroomTranscriptionState | null; processing_mode: 'local' | 'external' }> {
    return this.client.get(`/v1/classrooms/${this.classroomId}/transcripts`);
  }

  correct(transcriptId: string, text: string): Promise<{ transcript: ClassroomTranscriptRevision }> {
    return this.client.post(`/v1/classrooms/${this.classroomId}/transcripts/${transcriptId}/correct`, { text });
  }

  retry(chunkId: string): Promise<{ transcripts: ClassroomTranscriptRevision[] }> {
    return this.client.post(`/v1/classrooms/${this.classroomId}/transcripts/${chunkId}/retry`);
  }

  clear(): Promise<{ cleared_at: string }> {
    return this.client.delete(`/v1/classrooms/${this.classroomId}/transcripts`);
  }
}
