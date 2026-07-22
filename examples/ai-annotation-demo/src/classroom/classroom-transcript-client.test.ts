import { describe, expect, it } from 'vitest';
import type { ClassroomTranscriptRevision } from 'ink-surface-sdk/runtime-schema';
import { classroomDeliveryLabel, classroomDeliveryMode, formatTranscriptTime, latestTranscriptProjection } from './classroom-transcript-client';

const base: ClassroomTranscriptRevision = {
  schema_version: 'inkloop.classroom.v1', classroom_id: 'classroom_1', transcript_id: 'transcript_1', revision: 1,
  status: 'provisional', recording_id: 'recording_1', recording_generation: 1, chunk_id: 'chunk_1', chunk_hash: `sha256:${'a'.repeat(64)}`,
  relative_start_ms: 100, relative_end_ms: 500, text: '正二', confidence: 0.4, language: 'zh-CN', provider: 'fixture', processing_mode: 'local', created_at: '2026-07-19T00:00:00Z',
};

describe('classroom transcript projection', () => {
  it('projects the latest revision in recording order', () => {
    expect(latestTranscriptProjection([{ ...base, revision: 2, status: 'corrected', text: '正负二', original_revision: 1, corrected_at: 'now' }, base])).toMatchObject([{ revision: 2, text: '正负二' }]);
  });

  it('formats recording offsets like a compact player timestamp', () => {
    expect(formatTranscriptTime(12_900)).toBe('00:12');
    expect(formatTranscriptTime(65_000)).toBe('01:05');
    expect(formatTranscriptTime(3_661_000)).toBe('01:01:01');
  });

  it('labels all three delivery modes explicitly', () => {
    const ready = { classroom_id: 'c', recording_id: 'r', recording_generation: 1, state: 'ready' as const, provider: 'p', processing_mode: 'local' as const, processed_chunk_count: 1, failed_chunk_count: 0, audio_available: true, updated_at: 'now' };
    expect(classroomDeliveryMode({ audioPlaying: true, transcription: ready })).toBe('audio_with_subtitles');
    expect(classroomDeliveryMode({ audioPlaying: false, transcription: ready })).toBe('subtitles_only');
    expect(classroomDeliveryMode({ audioPlaying: false, transcription: { ...ready, state: 'failed', last_error_code: 'offline' } })).toBe('textbook_board_only');
    expect(classroomDeliveryLabel('subtitles_only')).toContain('仅字幕');
  });
});
