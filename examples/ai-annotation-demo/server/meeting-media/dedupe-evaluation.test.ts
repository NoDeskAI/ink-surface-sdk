import { describe, expect, it } from 'vitest';
import type { FormalTranscriptArtifact } from './transcript-finalizer';
import { evaluateTranscriptDedupe, type LabeledDedupePair } from './dedupe-evaluation';

function artifact(suppressedPairs: Array<[string, string]>): FormalTranscriptArtifact {
  const utterance = (utterance_id: string, track: 'mic' | 'remote') => ({
    utterance_id,
    session_id: 'evaluation-session',
    track,
    start_ms: 0,
    end_ms: 1_000,
    text: utterance_id,
    revision: 1,
    stability: 'formal' as const,
    source_chunk_ids: [`chunk-${utterance_id}`],
  });
  const raw = [utterance('mic-a', 'mic'), utterance('remote-a', 'remote'), utterance('mic-b', 'mic'), utterance('remote-b', 'remote')];
  const suppressed = new Set(suppressedPairs.map(([, candidate]) => candidate));
  return {
    schema_version: 'inkloop.formal_transcript_artifact.v1',
    session_id: 'evaluation-session',
    finality: 'final',
    raw_utterances: raw,
    derived_utterances: raw.filter((item) => !suppressed.has(item.utterance_id)),
    duplicate_assessments: suppressedPairs.map(([primary_utterance_id, candidate_utterance_id]) => ({
      primary_utterance_id,
      candidate_utterance_id,
      disposition: 'suppress_derived_duplicate',
      confidence: 0.9,
      signals: ['text_similarity', 'time_overlap'],
      source: 'text_fallback',
      applied: true,
    })),
    dedupe_metrics: {
      raw_utterance_count: 4,
      derived_utterance_count: 4 - suppressed.size,
      assessed_pair_count: suppressedPairs.length,
      suppressed_duplicate_count: suppressed.size,
      retained_conflict_count: 0,
      rejected_assessment_count: 0,
      external_assessment_count: 0,
      inferred_assessment_count: suppressedPairs.length,
    },
    missing_chunk_ids: [],
    finalized_at_ms: 1,
  };
}

const labels: LabeledDedupePair[] = [
  { left_utterance_id: 'mic-a', right_utterance_id: 'remote-a', expected_duplicate: true },
  { left_utterance_id: 'mic-b', right_utterance_id: 'remote-b', expected_duplicate: false },
];

describe('transcript dedupe evaluation', () => {
  it('reports residual duplicate and false suppression rates from labeled pairs', () => {
    const result = evaluateTranscriptDedupe(artifact([
      ['remote-a', 'mic-a'],
      ['remote-b', 'mic-b'],
    ]), labels);

    expect(result).toEqual({
      labeled_pair_count: 2,
      expected_duplicate_count: 1,
      expected_distinct_count: 1,
      true_suppression_count: 1,
      false_suppression_count: 1,
      missed_duplicate_count: 0,
      retained_distinct_count: 0,
      residual_duplicate_rate: 0,
      false_suppression_rate: 1,
      suppression_precision: 0.5,
      duplicate_recall: 1,
    });
  });

  it('counts an expected but retained pair as a residual duplicate', () => {
    expect(evaluateTranscriptDedupe(artifact([]), labels)).toMatchObject({
      missed_duplicate_count: 1,
      retained_distinct_count: 1,
      residual_duplicate_rate: 1,
      false_suppression_rate: 0,
      suppression_precision: 1,
      duplicate_recall: 0,
    });
  });

  it('rejects duplicate or unknown pair labels instead of producing misleading metrics', () => {
    expect(() => evaluateTranscriptDedupe(artifact([]), [labels[0], { ...labels[0] }]))
      .toThrow('dedupe_evaluation_duplicate_pair');
    expect(() => evaluateTranscriptDedupe(artifact([]), [{
      left_utterance_id: 'unknown', right_utterance_id: 'remote-a', expected_duplicate: true,
    }])).toThrow('dedupe_evaluation_utterance_not_found');
  });
});
