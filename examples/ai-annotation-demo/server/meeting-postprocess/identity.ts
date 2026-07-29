import { createHash } from 'node:crypto';
import type { HandwritingEvidence, MeetingUtterance } from './contracts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function safeIdentityPart(value: string, fallback: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '').slice(0, 160) || fallback;
}

export function occurrenceId(input: { platform?: string; provider_meeting_id?: string; meeting_id: string; started_at_ms?: number }): string {
  const provider = input.provider_meeting_id?.trim();
  if (provider) return `${safeIdentityPart(input.platform || 'meeting', 'meeting')}:${safeIdentityPart(provider, 'occurrence')}`;
  return `local:${sha256({ meeting_id: input.meeting_id, started_at_ms: input.started_at_ms || 0 }).slice(0, 32)}`;
}

export function utteranceId(input: Omit<MeetingUtterance, 'id' | 'revision'>): string {
  return `utt_${sha256({ speaker_id: input.speaker_id, speaker_name: input.speaker_name, start_ms: input.start_ms, end_ms: input.end_ms, text: input.text.trim(), source: input.source, source_revision: input.source_revision }).slice(0, 24)}`;
}

export function evidenceFingerprint(utterances: MeetingUtterance[], handwriting: HandwritingEvidence[]): string {
  return sha256({
    utterances: [...utterances].sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id)).map(({ id, speaker_id, speaker_name, start_ms, end_ms, text, source, source_revision, revision }) => ({ id, speaker_id, speaker_name, start_ms, end_ms, text, source, source_revision, revision })),
    handwriting: [...handwriting].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, mark_id, text, page_id, relative_time_ms, text_source, kind, mark_ids, revision, corrected_by_user }) => ({ id, mark_id, text, page_id, relative_time_ms, text_source, kind, mark_ids: [...mark_ids].sort(), revision, corrected_by_user })),
  });
}

export function runIdempotencyKey(input: { tenant_id: string; user_id: string; meeting_id: string; occurrence_id: string; artifact_kind: string; snapshot_fingerprint: string; pipeline_version: string }): string {
  return sha256(input);
}
