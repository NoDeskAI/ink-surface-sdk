import type { EvidenceSnapshot, HandwritingEvidence, MeetingUserGuidance, MeetingUtterance } from './contracts';
import { evidenceSnapshotSchema, handwritingEvidenceSchema, meetingUserGuidanceSchema, meetingUtteranceSchema, POSTPROCESS_SCHEMA_VERSION } from './contracts';
import { evidenceFingerprint, sha256, utteranceId } from './identity';
import { DEFAULT_MEETING_TEMPLATE_ID, meetingTemplate, type MeetingTemplateId } from './templates';
import type { FormalTranscriptArtifact } from '../meeting-media/transcript-finalizer';

export interface SnapshotInput {
  tenant_id: string;
  user_id: string;
  meeting_id: string;
  occurrence_id: string;
  meeting_title?: string;
  revision?: number;
  transcript_final?: boolean;
  transcript_converged?: boolean;
  transcript_missing_chunk_ids?: string[];
  template_id?: MeetingTemplateId;
  user_guidance?: Partial<MeetingUserGuidance>;
  ocr_status?: 'ready' | 'pending' | 'failed' | 'not_applicable';
  started_at_ms?: number;
  ended_at_ms?: number;
  utterances: Array<Partial<MeetingUtterance> & Pick<MeetingUtterance, 'start_ms' | 'end_ms' | 'text'>>;
  handwriting?: Array<Partial<HandwritingEvidence> & Pick<HandwritingEvidence, 'id' | 'text' | 'revision'>>;
  now?: Date;
}

function stableSpeakerLabel(speakerId: string | undefined, track?: string): string | null {
  if (track === 'mic') return '本机发言人';
  const cluster = speakerId?.trim();
  if (!cluster) return track === 'remote' ? '远端发言人' : null;
  if (/^(?:远端发言人|remote speaker)\b/iu.test(cluster)) return cluster;
  const digest = sha256(cluster).slice(0, 4).toUpperCase();
  return `远端发言人 ${digest}`;
}

function normalizedSpeakerIdentity(value: string | null | undefined): { speaker_id: string | null; speaker_name: string | null } {
  const speaker = value?.trim() || null;
  if (!speaker) return { speaker_id: null, speaker_name: null };
  if (/^(?:说话人|speaker)\s*\d+$/iu.test(speaker)) {
    return { speaker_id: speaker, speaker_name: stableSpeakerLabel(speaker, 'remote') };
  }
  return { speaker_id: null, speaker_name: speaker };
}

export function formalTranscriptUtterances(transcript: FormalTranscriptArtifact): SnapshotInput['utterances'] {
  const identities = new Map(transcript.speaker_identity_matches?.filter((match) => match.applied).map((match) => [match.speaker_cluster_id, match.display_name]) || []);
  return transcript.derived_utterances.map((utterance) => ({
    id: utterance.utterance_id,
    speaker_id: utterance.speaker_cluster_id || null,
    speaker_name: utterance.speaker_cluster_id && identities.get(utterance.speaker_cluster_id) || stableSpeakerLabel(utterance.speaker_cluster_id, utterance.track),
    start_ms: utterance.start_ms,
    end_ms: utterance.end_ms,
    text: utterance.text,
    source: 'local' as const,
    source_revision: String(utterance.revision),
    confidence: utterance.confidence,
    revision: utterance.revision,
  }));
}

export function buildEvidenceSnapshot(input: SnapshotInput): EvidenceSnapshot {
  const utterances = input.utterances.flatMap((raw) => {
    const text = raw.text.trim();
    if (!text) return [];
    const legacySpeaker = (raw as Partial<MeetingUtterance> & { speaker?: string }).speaker?.trim() || null;
    const normalized = normalizedSpeakerIdentity(raw.speaker_name || legacySpeaker);
    const candidate = { speaker_id: raw.speaker_id || normalized.speaker_id, speaker_name: normalized.speaker_name, start_ms: raw.start_ms, end_ms: Math.max(raw.start_ms, raw.end_ms), text, source: raw.source || 'local', source_revision: raw.source_revision || String(raw.revision || 0), confidence: raw.confidence, revision: raw.revision || 0 };
    return [meetingUtteranceSchema.parse({ ...candidate, id: raw.id || utteranceId(candidate) })];
  });
  const handwriting = (input.handwriting || []).map((item) => handwritingEvidenceSchema.parse({ ...item, mark_ids: item.mark_ids || [], mark_id: item.mark_id || item.mark_ids?.[0] || item.id, text_source: item.text_source || (item.corrected_by_user ? 'manual' : 'ocr') }));
  const contentFingerprint = evidenceFingerprint(utterances, handwriting);
  const missing_reasons: EvidenceSnapshot['missing_reasons'] = [];
  const missing_chunk_ids = [...new Set(input.transcript_missing_chunk_ids || [])].sort();
  if (!input.transcript_final || missing_chunk_ids.length > 0) missing_reasons.push(utterances.length ? 'transcript_partial' : 'transcript_pending');
  if (input.ocr_status === 'pending') missing_reasons.push('ocr_pending');
  if (input.ocr_status === 'failed') missing_reasons.push('ocr_failed');
  const created_at = (input.now || new Date()).toISOString();
  const meeting_title = input.meeting_title?.trim() || '(未命名会议)';
  const template = meetingTemplate(input.template_id || DEFAULT_MEETING_TEMPLATE_ID);
  const user_guidance = meetingUserGuidanceSchema.parse(input.user_guidance || {});
  const transcript_converged = input.transcript_converged === true || input.transcript_final === true;
  const fingerprint = sha256({ content_fingerprint: contentFingerprint, transcript_final: input.transcript_final === true, transcript_converged, missing_chunk_ids, ocr_status: input.ocr_status || 'pending', meeting_title, template_id: template.id, template_version: template.version, user_guidance, started_at_ms: Number.isFinite(input.started_at_ms) ? input.started_at_ms : null, ended_at_ms: Number.isFinite(input.ended_at_ms) ? input.ended_at_ms : null });
  return evidenceSnapshotSchema.parse({
    schema_version: POSTPROCESS_SCHEMA_VERSION,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    meeting_id: input.meeting_id,
    occurrence_id: input.occurrence_id,
    snapshot_id: `snapshot_${sha256({ tenant_id: input.tenant_id, user_id: input.user_id, meeting_id: input.meeting_id, occurrence_id: input.occurrence_id, fingerprint }).slice(0, 24)}`,
    meeting_title,
    revision: input.revision || 1,
    fingerprint,
    finality: missing_reasons.length ? 'provisional' : 'final',
    transcript_converged,
    template_id: template.id,
    template_version: template.version,
    user_guidance,
    missing_reasons,
    missing_chunk_ids,
    started_at_ms: Number.isFinite(input.started_at_ms) ? input.started_at_ms : null,
    ended_at_ms: Number.isFinite(input.ended_at_ms) ? input.ended_at_ms : null,
    utterances,
    handwriting,
    created_at,
  });
}

export function buildEvidenceSnapshotFromFormalTranscript(
  input: Omit<SnapshotInput, 'utterances' | 'transcript_final' | 'transcript_missing_chunk_ids'> & {
    transcript: FormalTranscriptArtifact;
  },
): EvidenceSnapshot {
  return buildEvidenceSnapshot({
    ...input,
    transcript_final: input.transcript.finality === 'final',
    transcript_converged: true,
    transcript_missing_chunk_ids: input.transcript.missing_chunk_ids,
    utterances: formalTranscriptUtterances(input.transcript),
  });
}
