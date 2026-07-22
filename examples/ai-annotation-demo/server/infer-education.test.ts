import { describe, expect, it } from 'vitest';
import { educationLessonEvidencePayload, educationStructuredEvidencePayload } from './infer';

describe('educationStructuredEvidencePayload', () => {
  it('preserves textbook, trusted formula, transcript, range, and missing-source state at the real gateway boundary', () => {
    expect(educationStructuredEvidencePayload({
      kind: 'live_explanation', intent: 'missed_segment', material: { material_id: 'math', page_index: 0 },
      time_window: { start_ms: 10_000, end_ms: 30_000 }, evidence: [{ event_id: 'ink_2' }],
      recognitions: [{ text: 'x² + 4x + 4 = 9' }], transcripts: [{ text: '两边同时加四' }], missing_sources: [],
    })).toEqual({
      intent: 'missed_segment', material: { material_id: 'math', page_index: 0 },
      time_window: { start_ms: 10_000, end_ms: 30_000 }, evidence: [{ event_id: 'ink_2' }],
      trusted_recognitions: [{ text: 'x² + 4x + 4 = 9' }], trusted_transcripts: [{ text: '两边同时加四' }], missing_sources: [],
    });
  });
});

describe('educationLessonEvidencePayload', () => {
  it('publishes a deduplicated ink-event allowlist separately from multimodal evidence', () => {
    const evidence = [
      { evidence_type: 'material_page', material_id: 'math' },
      { evidence_type: 'ink_event', event_id: 'ink_1' },
      { evidence_type: 'trusted_recognition', event_ids: ['ink_1'] },
      { evidence_type: 'ink_event', event_id: 'ink_2' },
      { evidence_type: 'ink_event', event_id: 'ink_1' },
    ];
    expect(educationLessonEvidencePayload(evidence)).toEqual({ allowed_event_ids: ['ink_1', 'ink_2'], evidence });
  });
});
