import type { HandwritingEvidence } from './contracts';
import { enqueueEndedMeeting, type MeetingPostprocessServiceOptions } from './service';
import {
  providerOccurrenceReference,
  type ProviderMeetingRegistration,
} from './provider-registry';

export interface ProviderTranscriptEvidence { status: 'ready' | 'pending' | 'not_generated' | 'no_record'; started_at?: string; ended_at?: string; utterances?: Array<{ speaker?: string; start_ms: number; end_ms: number; text: string }> }

/** Platform workers only reconcile occurrence/end state. Their transcript is deliberately discarded. */
export async function enqueueRegisteredProviderEvidence(input: { options: Pick<MeetingPostprocessServiceOptions, 'root' | 'generate'>; registration: ProviderMeetingRegistration; evidence: ProviderTranscriptEvidence }): Promise<{ status: 'queued' | 'awaiting_configuration' | 'awaiting_transcript'; occurrence_id: string; run_id?: string; snapshot_id: string }> {
  const registration = input.registration;
  return enqueueEndedMeeting({
    options: input.options, identity: { tenant_id: registration.tenant_id, user_id: registration.user_id }, meeting_id: registration.meeting_id, title: registration.title,
    platform: registration.provider === 'google' ? 'google_meet' : registration.provider,
    provider_meeting_id: providerOccurrenceReference(registration),
    started_at_ms: Date.parse(input.evidence.started_at || registration.started_at || registration.scheduled_at), ended_at_ms: Date.parse(input.evidence.ended_at || registration.ended_at || '') || undefined,
    source: registration.provider, transcript_final: false, transcript_converged: false, utterances: [], ocr_status: 'not_applicable',
  });
}

export type PreservedHandwriting = HandwritingEvidence;
