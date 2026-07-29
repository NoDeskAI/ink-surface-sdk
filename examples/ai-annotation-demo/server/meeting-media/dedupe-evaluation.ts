import type { FormalTranscriptArtifact } from './transcript-finalizer';

export interface LabeledDedupePair {
  left_utterance_id: string;
  right_utterance_id: string;
  expected_duplicate: boolean;
}

export interface TranscriptDedupeEvaluation {
  labeled_pair_count: number;
  expected_duplicate_count: number;
  expected_distinct_count: number;
  true_suppression_count: number;
  false_suppression_count: number;
  missed_duplicate_count: number;
  retained_distinct_count: number;
  residual_duplicate_rate: number;
  false_suppression_rate: number;
  suppression_precision: number;
  duplicate_recall: number;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000');
}

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator > 0 ? numerator / denominator : emptyValue;
}

/**
 * Evaluate a formal artifact against manually labeled cross-track pairs.
 * This deliberately lives outside the finalizer: production output records
 * decisions, while quality claims require independent ground truth.
 */
export function evaluateTranscriptDedupe(
  artifact: FormalTranscriptArtifact,
  labels: readonly LabeledDedupePair[],
): TranscriptDedupeEvaluation {
  const utterances = new Map(artifact.raw_utterances.map((utterance) => [utterance.utterance_id, utterance]));
  const suppressedPairs = new Set(artifact.duplicate_assessments
    .filter((assessment) => assessment.applied && assessment.disposition === 'suppress_derived_duplicate')
    .map((assessment) => pairKey(assessment.primary_utterance_id, assessment.candidate_utterance_id)));
  const labeledPairs = new Set<string>();
  let expectedDuplicates = 0;
  let expectedDistinct = 0;
  let trueSuppressions = 0;
  let falseSuppressions = 0;
  let missedDuplicates = 0;
  let retainedDistinct = 0;

  for (const label of labels) {
    const left = utterances.get(label.left_utterance_id);
    const right = utterances.get(label.right_utterance_id);
    if (!left || !right) throw new Error('dedupe_evaluation_utterance_not_found');
    if (left.track === right.track) throw new Error('dedupe_evaluation_pair_must_cross_tracks');
    const key = pairKey(label.left_utterance_id, label.right_utterance_id);
    if (labeledPairs.has(key)) throw new Error('dedupe_evaluation_duplicate_pair');
    labeledPairs.add(key);
    const suppressed = suppressedPairs.has(key);
    if (label.expected_duplicate) {
      expectedDuplicates += 1;
      if (suppressed) trueSuppressions += 1;
      else missedDuplicates += 1;
    } else {
      expectedDistinct += 1;
      if (suppressed) falseSuppressions += 1;
      else retainedDistinct += 1;
    }
  }

  return {
    labeled_pair_count: labels.length,
    expected_duplicate_count: expectedDuplicates,
    expected_distinct_count: expectedDistinct,
    true_suppression_count: trueSuppressions,
    false_suppression_count: falseSuppressions,
    missed_duplicate_count: missedDuplicates,
    retained_distinct_count: retainedDistinct,
    residual_duplicate_rate: ratio(missedDuplicates, expectedDuplicates, 0),
    false_suppression_rate: ratio(falseSuppressions, expectedDistinct, 0),
    suppression_precision: ratio(trueSuppressions, trueSuppressions + falseSuppressions, 1),
    duplicate_recall: ratio(trueSuppressions, expectedDuplicates, 1),
  };
}
