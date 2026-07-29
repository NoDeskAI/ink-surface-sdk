import {
  finalizeTranscript,
  type MeetingChunkDeliveryState,
  type MeetingTranscriptState,
  type MeetingUtterance,
} from '../../../../packages/meeting-media-core/src/index';

export const FORMAL_TRANSCRIPT_ARTIFACT_SCHEMA_VERSION = 'inkloop.formal_transcript_artifact.v1' as const;

export type DuplicateSignal = 'aec' | 'acoustic_similarity' | 'text_similarity' | 'time_overlap';

/**
 * An assessment is produced by a replaceable DSP/dedupe adapter. The
 * finalizer applies and audits the decision; it does not invent thresholds.
 * Unit 0 real-device evaluation must calibrate the assessment producer.
 */
export interface CrossTrackDuplicateAssessment {
  primary_utterance_id: string;
  candidate_utterance_id: string;
  disposition: 'suppress_derived_duplicate' | 'retain_conflict';
  confidence: number;
  signals: DuplicateSignal[];
}

export interface AppliedDuplicateAssessment extends CrossTrackDuplicateAssessment {
  /** Optional for artifacts written before decision provenance was recorded. */
  source?: 'external_adapter' | 'text_fallback';
  applied: boolean;
  reason?: 'utterance_not_found' | 'same_track' | 'invalid_confidence' | 'no_signal';
}

export interface SpeakerIdentityMatch {
  speaker_cluster_id: string;
  display_name: string;
  confidence: number;
  source: 'provider_participant' | 'calendar_participant' | 'voice_profile';
}

export interface AppliedSpeakerIdentityMatch extends SpeakerIdentityMatch {
  applied: boolean;
  reason?: 'cluster_not_found' | 'low_confidence';
}

export interface TranscriptDedupeMetrics {
  raw_utterance_count: number;
  derived_utterance_count: number;
  assessed_pair_count: number;
  suppressed_duplicate_count: number;
  retained_conflict_count: number;
  rejected_assessment_count: number;
  external_assessment_count: number;
  inferred_assessment_count: number;
}

export interface FormalTranscriptArtifact {
  schema_version: typeof FORMAL_TRANSCRIPT_ARTIFACT_SCHEMA_VERSION;
  session_id: string;
  finality: 'final' | 'partial';
  /** All formal utterances remain available for audit and raw replay. */
  raw_utterances: MeetingUtterance[];
  /** Duplicate-suppressed projection used by summaries and speaker display. */
  derived_utterances: MeetingUtterance[];
  duplicate_assessments: AppliedDuplicateAssessment[];
  /** Operational counts only. Quality rates require a separately labeled sample. */
  /** Optional for backward compatibility with earlier v1 artifacts. */
  dedupe_metrics?: TranscriptDedupeMetrics;
  /** Optional for backward compatibility with v1 artifacts written before identity matching shipped. */
  speaker_identity_matches?: AppliedSpeakerIdentityMatch[];
  missing_chunk_ids: string[];
  finalized_at_ms: number;
}

export interface FinalizeMeetingTranscriptInput {
  provisional: MeetingTranscriptState;
  delivery: MeetingChunkDeliveryState;
  provider_pending_chunk_ids?: string[];
  known_missing_chunk_ids?: string[];
  duplicate_assessments?: CrossTrackDuplicateAssessment[];
  speaker_identity_matches?: SpeakerIdentityMatch[];
  finalized_at_ms?: number;
}

function normalizedDuplicateText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function overlapRatio(left: MeetingUtterance, right: MeetingUtterance): number {
  const overlap = Math.max(0, Math.min(left.end_ms, right.end_ms) - Math.max(left.start_ms, right.start_ms));
  const shorterDuration = Math.max(1, Math.min(left.end_ms - left.start_ms, right.end_ms - right.start_ms));
  return overlap / shorterDuration;
}

/**
 * Conservative server-side fallback for the common speaker-mode echo case.
 * It only suppresses exact normalized text with substantial time overlap and
 * enough information content. Acoustic/AEC adapters can provide an explicit
 * assessment for every ambiguous pair and take precedence below.
 */
export function inferCrossTrackDuplicateAssessments(
  utterances: readonly MeetingUtterance[],
): CrossTrackDuplicateAssessment[] {
  const inferred: CrossTrackDuplicateAssessment[] = [];
  const sorted = [...utterances].sort((left, right) => left.start_ms - right.start_ms || left.utterance_id.localeCompare(right.utterance_id));
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex];
    const leftText = normalizedDuplicateText(left.text);
    if (leftText.length < 6) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = sorted[rightIndex];
      if (right.start_ms > left.end_ms) break;
      if (left.track === right.track) continue;
      if (leftText !== normalizedDuplicateText(right.text) || overlapRatio(left, right) < 0.7) continue;
      // Remote is the clean reference for meeting playback; a duplicate Mic
      // copy is the likely loudspeaker pickup. Raw utterances are retained.
      const primary = left.track === 'remote' ? left : right;
      const candidate = primary === left ? right : left;
      inferred.push({
        primary_utterance_id: primary.utterance_id,
        candidate_utterance_id: candidate.utterance_id,
        disposition: 'suppress_derived_duplicate',
        confidence: 0.9,
        signals: ['text_similarity', 'time_overlap'],
      });
    }
  }
  return inferred;
}

export function buildFormalTranscriptArtifact(input: FinalizeMeetingTranscriptInput): FormalTranscriptArtifact {
  if (input.provisional.status !== 'provisional') throw new Error('formal convergence requires a provisional transcript');
  const finalizedAt = input.finalized_at_ms ?? Date.now();
  const additionalMissing = [
    ...(input.provider_pending_chunk_ids || []),
    ...(input.known_missing_chunk_ids || []),
  ];
  const formal = finalizeTranscript(input.provisional, input.delivery, finalizedAt, additionalMissing);
  const utterances = formal.utterances.map((utterance) => ({ ...utterance, source_chunk_ids: [...utterance.source_chunk_ids] }));
  const byId = new Map(utterances.map((utterance) => [utterance.utterance_id, utterance]));
  const suppressed = new Set<string>();
  const externalAssessments = input.duplicate_assessments || [];
  const externallyAssessedPairs = new Set(externalAssessments.map((assessment) => [
    assessment.primary_utterance_id,
    assessment.candidate_utterance_id,
  ].sort().join('\u0000')));
  const assessmentsToApply: Array<CrossTrackDuplicateAssessment & { source: AppliedDuplicateAssessment['source'] }> = [
    ...externalAssessments.map((assessment) => ({ ...assessment, source: 'external_adapter' as const })),
    ...inferCrossTrackDuplicateAssessments(utterances).filter((assessment) => !externallyAssessedPairs.has([
      assessment.primary_utterance_id,
      assessment.candidate_utterance_id,
    ].sort().join('\u0000'))).map((assessment) => ({ ...assessment, source: 'text_fallback' as const })),
  ];
  const assessments = assessmentsToApply.map((assessment): AppliedDuplicateAssessment => {
    const primary = byId.get(assessment.primary_utterance_id);
    const candidate = byId.get(assessment.candidate_utterance_id);
    if (!primary || !candidate) return { ...assessment, applied: false, reason: 'utterance_not_found' };
    if (primary.track === candidate.track) return { ...assessment, applied: false, reason: 'same_track' };
    if (!Number.isFinite(assessment.confidence) || assessment.confidence < 0 || assessment.confidence > 1) {
      return { ...assessment, applied: false, reason: 'invalid_confidence' };
    }
    if (assessment.signals.length === 0) return { ...assessment, applied: false, reason: 'no_signal' };
    if (assessment.disposition === 'suppress_derived_duplicate') {
      candidate.duplicate_of = primary.utterance_id;
      suppressed.add(candidate.utterance_id);
    }
    return { ...assessment, signals: [...assessment.signals], applied: true };
  });
  const identityMatches = (input.speaker_identity_matches || []).map((match): AppliedSpeakerIdentityMatch => {
    const clusterUtterances = utterances.filter((utterance) => utterance.speaker_cluster_id === match.speaker_cluster_id);
    if (!clusterUtterances.length) return { ...match, applied: false, reason: 'cluster_not_found' };
    if (!Number.isFinite(match.confidence) || match.confidence < 0.85) return { ...match, applied: false, reason: 'low_confidence' };
    return { ...match, display_name: match.display_name.trim(), applied: !!match.display_name.trim() };
  });

  return {
    schema_version: FORMAL_TRANSCRIPT_ARTIFACT_SCHEMA_VERSION,
    session_id: formal.session_id,
    finality: formal.finality || 'partial',
    raw_utterances: utterances,
    derived_utterances: utterances.filter((utterance) => !suppressed.has(utterance.utterance_id)),
    duplicate_assessments: assessments,
    dedupe_metrics: {
      raw_utterance_count: utterances.length,
      derived_utterance_count: utterances.length - suppressed.size,
      assessed_pair_count: assessments.length,
      suppressed_duplicate_count: suppressed.size,
      retained_conflict_count: assessments.filter((assessment) => assessment.applied
        && assessment.disposition === 'retain_conflict').length,
      rejected_assessment_count: assessments.filter((assessment) => !assessment.applied).length,
      external_assessment_count: assessments.filter((assessment) => assessment.source === 'external_adapter').length,
      inferred_assessment_count: assessments.filter((assessment) => assessment.source === 'text_fallback').length,
    },
    speaker_identity_matches: identityMatches,
    missing_chunk_ids: [...formal.missing_chunks],
    finalized_at_ms: finalizedAt,
  };
}
