import { occurrenceId } from './identity';

export interface MeetingEndedSignal { tenant_id: string; user_id: string; meeting_id: string; occurrence_id: string; platform: string; provider_meeting_id?: string; started_at_ms?: number; ended_at_ms?: number; strength: 'explicit' | 'reconciled' | 'inferred' }

export function normalizeMeetingEnded(input: { tenant_id: string; user_id: string; meeting_id: string; platform?: string; provider_meeting_id?: string; started_at_ms?: number; ended_at_ms?: number; source: 'mtl' | 'lark' | 'google' | 'zoom' | 'local' }): MeetingEndedSignal {
  const platform = input.platform || (input.source === 'mtl' ? 'manual' : input.source);
  return { ...input, platform, occurrence_id: occurrenceId({ platform, provider_meeting_id: input.provider_meeting_id, meeting_id: input.meeting_id, started_at_ms: input.started_at_ms }), strength: input.source === 'local' ? 'inferred' : input.source === 'google' || input.source === 'zoom' ? 'reconciled' : 'explicit' };
}
