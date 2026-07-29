import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { describe, expect, it } from 'vitest';
import { enqueueRegisteredProviderEvidence } from './provider-trigger'; import { MeetingPostprocessStore } from './store'; import { enqueueEndedMeeting } from './service'; import { POSTPROCESS_SCHEMA_VERSION, postprocessConfigurationSchema } from './contracts'; import { meetingTemplate } from './templates'; import { sha256 } from './identity';

const response = { theme: 'T', overview: 'O', key_points: [], decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [] };
describe('registered provider offline trigger', () => {
  it('discards platform transcript while preserving prior InkLoop handwriting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-trigger-')); const identity = { tenant_id: 't', user_id: 'u' };
    const registration = { schema_version: '1.0' as const, ...identity, meeting_id: 'local', provider: 'google' as const, title: 'Planning', provider_calendar_event_id: 'event', meeting_code: 'abc', scheduled_at: '2026-07-21T01:00:00.000Z', status: 'ended' as const, updated_at: '2026-07-21T02:00:00.000Z' };
    const options = { root, generate: async () => response };
    const store = new MeetingPostprocessStore(root, identity);
    const initial = await enqueueEndedMeeting({ options, identity, meeting_id: 'local', title: 'Planning', platform: 'google_meet', provider_meeting_id: 'event', source: 'google', transcript_final: false, ocr_status: 'ready', handwriting: [{ id: 'h1', mark_id: 'h1', text: 'ink', page_id: '', relative_time_ms: null, text_source: 'ocr', kind: 'personal_thought', revision: 1, mark_ids: ['h1'], confidence: null, corrected_by_user: false }] });
    const template = meetingTemplate('meeting_expert'); const user_guidance = { source: 'user_supplied' as const, conclusions: [], deepest_impressions: [], pain_points: [] }; const fingerprint = sha256({ template_id: template.id, template_version: template.version, user_guidance });
    await store.saveConfiguration(postprocessConfigurationSchema.parse({ ...identity, meeting_id: 'local', occurrence_id: initial.occurrence_id, schema_version: POSTPROCESS_SCHEMA_VERSION, configuration_id: `configuration_${fingerprint.slice(0, 24)}`, revision: 1, fingerprint, template_id: template.id, template_version: template.version, user_guidance, submitted_at: new Date().toISOString() }));
    await enqueueRegisteredProviderEvidence({ options, registration, evidence: { status: 'ready', utterances: [{ start_ms: 0, end_ms: 1, text: 'final transcript' }] } });
    expect(store.listRuns({ meeting_id: 'local' })).toEqual([]);
    const latest = store.listSnapshots({ meeting_id: 'local' }).at(-1)!;
    expect(latest.handwriting[0]?.text).toBe('ink');
    expect(latest.utterances).toEqual([]);
    expect(latest.transcript_converged).toBe(false);
  });
  it('does not invoke the summary model when the provider confirms that no record exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-trigger-empty-')); const identity = { tenant_id: 't', user_id: 'u' };
    const registration = { schema_version: '1.0' as const, ...identity, meeting_id: 'empty', provider: 'zoom' as const, title: 'Empty', provider_meeting_id: 'empty-id', scheduled_at: '2026-07-21T01:00:00.000Z', status: 'ended' as const, updated_at: '2026-07-21T02:00:00.000Z' };
    let generated = 0; const options = { root, generate: async () => { generated += 1; return response; } };
    const first = await enqueueRegisteredProviderEvidence({ options, registration, evidence: { status: 'pending' } });
    const template = meetingTemplate('meeting_expert'); const user_guidance = { source: 'user_supplied' as const, conclusions: [], deepest_impressions: [], pain_points: [] }; const fingerprint = sha256({ template_id: template.id, template_version: template.version, user_guidance });
    await new MeetingPostprocessStore(root, identity).saveConfiguration(postprocessConfigurationSchema.parse({ ...identity, meeting_id: 'empty', occurrence_id: first.occurrence_id, schema_version: POSTPROCESS_SCHEMA_VERSION, configuration_id: 'configuration-empty', revision: 1, fingerprint, template_id: template.id, template_version: template.version, user_guidance, submitted_at: new Date().toISOString() }));
    const settled = await enqueueRegisteredProviderEvidence({ options, registration, evidence: { status: 'no_record' } });
    expect(settled).toMatchObject({ status: 'awaiting_transcript' });
    expect(new MeetingPostprocessStore(root, identity).listRuns({ meeting_id: 'empty' })).toEqual([]);
    expect(generated).toBe(0);
  });
  it('uses the scheduled logical occurrence instead of merging recurring rooms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-trigger-recurring-'));
    const identity = { tenant_id: 't', user_id: 'u' };
    const options = { root, generate: async () => response };
    const base = {
      schema_version: '1.0' as const,
      ...identity,
      meeting_id: 'recurring-room',
      provider: 'google' as const,
      title: 'Weekly planning',
      provider_space_name: 'spaces/weekly-room',
      status: 'ended' as const,
      updated_at: '2026-07-28T02:00:00.000Z',
    };
    const first = await enqueueRegisteredProviderEvidence({
      options,
      registration: { ...base, scheduled_at: '2026-07-21T01:00:00.000Z' },
      evidence: { status: 'pending' },
    });
    const second = await enqueueRegisteredProviderEvidence({
      options,
      registration: { ...base, scheduled_at: '2026-07-28T01:00:00.000Z' },
      evidence: { status: 'pending' },
    });
    expect(first.occurrence_id).not.toBe(second.occurrence_id);
  });
});
