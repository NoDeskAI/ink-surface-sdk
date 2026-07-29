import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEvidenceSnapshot, buildEvidenceSnapshotFromFormalTranscript } from './evidence-snapshot';
import { POSTPROCESS_SCHEMA_VERSION, postprocessConfigurationSchema } from './contracts';
import { evidenceFingerprint, occurrenceId } from './identity';
import { chunkUtterances } from './long-meeting';
import { artifactId, MeetingPostprocessStore, readPostprocessStoreIdentity } from './store';

const scope = { tenant_id: 'tenant-a', user_id: 'user-a', meeting_id: 'meeting-a', occurrence_id: 'zoom:123' };

describe('meeting postprocess contracts', () => {
  it('keeps occurrence and evidence fingerprints stable', () => {
    expect(occurrenceId({ platform: 'zoom', provider_meeting_id: '123', meeting_id: 'local' })).toBe('zoom:123');
    const a = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 2, text: 'one' }, { start_ms: 3, end_ms: 4, text: 'two' }] });
    expect(evidenceFingerprint([...a.utterances].reverse(), a.handwriting)).toBe(evidenceFingerprint(a.utterances, a.handwriting));
    expect(a.finality).toBe('final');
  });

  it('marks incomplete evidence provisional with explicit reasons', () => {
    const snapshot = buildEvidenceSnapshot({ ...scope, transcript_final: false, ocr_status: 'failed', utterances: [] });
    expect(snapshot.finality).toBe('provisional');
    expect(snapshot.missing_reasons).toEqual(['transcript_pending', 'ocr_failed']);
  });

  it('preserves formal transcript missing chunks and derived utterance IDs', () => {
    const snapshot = buildEvidenceSnapshotFromFormalTranscript({
      ...scope,
      ocr_status: 'not_applicable',
      transcript: {
        schema_version: 'inkloop.formal_transcript_artifact.v1',
        session_id: 'session-1',
        finality: 'partial',
        raw_utterances: [],
        derived_utterances: [{
          utterance_id: 'utt-local-1', session_id: 'session-1', track: 'mic', start_ms: 0, end_ms: 900,
          text: '本地正式转写', revision: 2, stability: 'formal', source_chunk_ids: ['chunk-1'],
        }],
        duplicate_assessments: [],
        speaker_identity_matches: [],
        missing_chunk_ids: ['chunk-2'],
        finalized_at_ms: 1_000,
      },
    });

    expect(snapshot).toMatchObject({
      finality: 'provisional',
      missing_reasons: ['transcript_partial'],
      missing_chunk_ids: ['chunk-2'],
      utterances: [{ id: 'utt-local-1', source: 'local', source_revision: '2', speaker_name: '本机发言人' }],
    });
  });

  it('uses stable anonymous labels for low-confidence remote speaker clusters', () => {
    const input = {
      ...scope,
      ocr_status: 'not_applicable' as const,
      transcript: {
        schema_version: 'inkloop.formal_transcript_artifact.v1' as const,
        session_id: 'session-remote', finality: 'final' as const, raw_utterances: [], duplicate_assessments: [], missing_chunk_ids: [], finalized_at_ms: 1_000,
        speaker_identity_matches: [],
        derived_utterances: [{ utterance_id: 'utt-remote-1', session_id: 'session-remote', track: 'remote' as const, start_ms: 0, end_ms: 900, text: '远端发言', revision: 1, stability: 'formal' as const, source_chunk_ids: ['chunk-1'], speaker_cluster_id: 'cluster-alpha' }],
      },
    };
    const first = buildEvidenceSnapshotFromFormalTranscript(input);
    const second = buildEvidenceSnapshotFromFormalTranscript(input);
    expect(first.utterances[0].speaker_name).toMatch(/^远端发言人 [A-F0-9]{4}$/);
    expect(second.utterances[0].speaker_name).toBe(first.utterances[0].speaker_name);
  });

  it('normalizes legacy numbered speaker labels before they reach prompts', () => {
    const snapshot = buildEvidenceSnapshot({
      ...scope,
      transcript_final: true,
      ocr_status: 'not_applicable',
      utterances: [
        { id: 'u1', speaker_name: '说话人 3', start_ms: 0, end_ms: 1, text: '匿名发言' },
        { id: 'u2', speaker_name: 'Alice', start_ms: 2, end_ms: 3, text: '实名发言' },
      ],
    });
    expect(snapshot.utterances[0]).toMatchObject({ speaker_id: '说话人 3' });
    expect(snapshot.utterances[0].speaker_name).toMatch(/^远端发言人 [A-F0-9]{4}$/);
    expect(snapshot.utterances[1]).toMatchObject({ speaker_id: null, speaker_name: 'Alice' });
  });

  it('uses only applied high-confidence speaker identity matches', () => {
    const base = {
      schema_version: 'inkloop.formal_transcript_artifact.v1' as const, session_id: 'session-identity', finality: 'final' as const, raw_utterances: [], duplicate_assessments: [], missing_chunk_ids: [], finalized_at_ms: 1_000,
      derived_utterances: [{ utterance_id: 'utt-remote', session_id: 'session-identity', track: 'remote' as const, start_ms: 0, end_ms: 1, text: 'hello', revision: 1, stability: 'formal' as const, source_chunk_ids: ['chunk'], speaker_cluster_id: 'cluster-one' }],
    };
    const named = buildEvidenceSnapshotFromFormalTranscript({ ...scope, ocr_status: 'not_applicable', transcript: { ...base, speaker_identity_matches: [{ speaker_cluster_id: 'cluster-one', display_name: 'Alice', confidence: 0.96, source: 'provider_participant' as const, applied: true }] } });
    const anonymous = buildEvidenceSnapshotFromFormalTranscript({ ...scope, ocr_status: 'not_applicable', transcript: { ...base, speaker_identity_matches: [{ speaker_cluster_id: 'cluster-one', display_name: 'Alice', confidence: 0.70, source: 'provider_participant' as const, applied: false, reason: 'low_confidence' as const }] } });
    expect(named.utterances[0].speaker_name).toBe('Alice');
    expect(anonymous.utterances[0].speaker_name).toMatch(/^远端发言人 /);
  });

  it('changes snapshot identity when the selected scene template changes', () => {
    const common = { ...scope, transcript_final: true, ocr_status: 'ready' as const, utterances: [{ start_ms: 0, end_ms: 1, text: 'same words' }] };
    const meeting = buildEvidenceSnapshot({ ...common, template_id: 'meeting_expert' });
    const classroom = buildEvidenceSnapshot({ ...common, template_id: 'interactive_classroom' });

    expect(classroom.fingerprint).not.toBe(meeting.fingerprint);
    expect(classroom).toMatchObject({ template_id: 'interactive_classroom', template_version: 'interactive_classroom.v3' });
  });

  it('keeps missing interview end time explicit', () => {
    const interview = buildEvidenceSnapshot({ ...scope, meeting_title: 'Interview', transcript_final: true, ocr_status: 'not_applicable', started_at_ms: Date.parse('2026-07-20T08:54:31Z'), template_id: 'interview_memo', utterances: [{ id: 'q1', start_ms: 0, end_ms: 0, text: 'Question', speaker_name: 'Interviewer' }, { id: 'a1', start_ms: 0, end_ms: 0, text: 'Answer', speaker_name: 'Interviewee' }] });
    expect(interview.started_at_ms).not.toBeNull();
    expect(interview.ended_at_ms).toBeNull();
  });

  it('changes snapshot identity when user-supplied guidance changes and preserves its source', () => {
    const common = { ...scope, transcript_final: true, ocr_status: 'ready' as const, utterances: [{ start_ms: 0, end_ms: 1, text: 'same words' }] };
    const first = buildEvidenceSnapshot({ ...common, user_guidance: { source: 'user_supplied', conclusions: ['关注发布'], deepest_impressions: [], pain_points: [] } });
    const second = buildEvidenceSnapshot({ ...common, user_guidance: { source: 'user_supplied', conclusions: [], deepest_impressions: [], pain_points: ['关注延迟'] } });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(first.user_guidance).toEqual({ source: 'user_supplied', conclusions: ['关注发布'], deepest_impressions: [], pain_points: [] });
  });

  it('changes snapshot identity when finality changes without text changes', () => {
    const pending = buildEvidenceSnapshot({ ...scope, transcript_final: false, ocr_status: 'pending', utterances: [{ start_ms: 0, end_ms: 1, text: 'same words' }] });
    const complete = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 1, text: 'same words' }] });
    expect(complete.fingerprint).not.toBe(pending.fingerprint);
    expect(complete.snapshot_id).not.toBe(pending.snapshot_id);
    expect(complete.finality).toBe('final');
  });

  it('scopes snapshot identity to the local meeting', () => {
    const first = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 1, text: 'same words' }] });
    const second = buildEvidenceSnapshot({ ...scope, meeting_id: 'another-local-meeting', transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 1, text: 'same words' }] });
    expect(second.snapshot_id).not.toBe(first.snapshot_id);
  });

  it('chunks all utterances including the tail', () => {
    const snapshot = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: Array.from({ length: 20 }, (_, i) => ({ start_ms: i * 10, end_ms: i * 10 + 5, text: `${i}-${'x'.repeat(80)}` })) });
    const chunks = chunkUtterances(snapshot.utterances, 350, 1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.utterances.at(-1)?.text).toContain('19-');
  });

  it('persists without leaking transcript content into events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-postprocess-'));
    const store = new MeetingPostprocessStore(root, scope);
    await store.append(scope, 'ocr.progress', { transcript: 'secret words', completed: 1 });
    expect(store.listEvents(scope)[0].data).toEqual({ completed: 1 });
    expect(readFileSync(store.path, 'utf8')).not.toContain('secret words');
  });

  it('keeps sanitized tenant namespaces collision-free', () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-postprocess-'));
    expect(new MeetingPostprocessStore(root, { tenant_id: 'a/b', user_id: 'u' }).path).not.toBe(new MeetingPostprocessStore(root, { tenant_id: 'a_b', user_id: 'u' }).path);
  });

  it('serializes writes across store instances for the same namespace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-postprocess-'));
    const first = new MeetingPostprocessStore(root, scope);
    const second = new MeetingPostprocessStore(root, scope);
    await Promise.all([first.append(scope, 'ocr.progress', { completed: 1 }), second.append(scope, 'ocr.progress', { completed: 2 })]);
    expect(first.listEvents(scope).map((event) => event.data.completed).sort()).toEqual([1, 2]);
  });

  it('persists the occurrence-scoped configuration gate across store instances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-postprocess-'));
    const first = new MeetingPostprocessStore(root, scope);
    const fingerprint = 'a'.repeat(64);
    await first.saveConfiguration(postprocessConfigurationSchema.parse({ ...scope, schema_version: POSTPROCESS_SCHEMA_VERSION, configuration_id: 'configuration-a', revision: 1, fingerprint, template_id: 'meeting_expert', template_version: 'meeting_expert.v1', user_guidance: { source: 'user_supplied', conclusions: ['ship'], deepest_impressions: [], pain_points: [] }, submitted_at: new Date().toISOString() }));
    const restored = new MeetingPostprocessStore(root, scope).getCurrentConfiguration(scope);
    expect(restored).toMatchObject({ occurrence_id: scope.occurrence_id, template_id: 'meeting_expert', user_guidance: { conclusions: ['ship'] } });
  });

  it('persists an explicit current configuration when a prior choice is selected again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-postprocess-'));
    const store = new MeetingPostprocessStore(root, scope);
    const configuration = (id: string, revision: number, template_id: 'meeting_expert' | 'interview_memo') => postprocessConfigurationSchema.parse({
      ...scope, schema_version: POSTPROCESS_SCHEMA_VERSION, configuration_id: id, revision, fingerprint: String(revision).repeat(64).slice(0, 64),
      template_id, template_version: `${template_id}.v1`, user_guidance: { source: 'user_supplied', conclusions: [], deepest_impressions: [], pain_points: [] }, submitted_at: new Date(revision * 1_000).toISOString(),
    });
    await store.saveConfiguration(configuration('configuration-a1', 1, 'meeting_expert'));
    await store.saveConfiguration(configuration('configuration-b', 2, 'interview_memo'));
    await store.saveConfiguration(configuration('configuration-a2', 3, 'meeting_expert'));

    const restored = new MeetingPostprocessStore(root, scope);
    expect(restored.getCurrentConfiguration(scope)).toMatchObject({ configuration_id: 'configuration-a2', revision: 3, template_id: 'meeting_expert' });
    expect(restored.listCurrentConfigurations()).toHaveLength(1);
  });

  it('persists namespace identity even after all meetings are deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-postprocess-'));
    const store = new MeetingPostprocessStore(root, scope);
    await store.append(scope, 'ocr.progress', { completed: 1 });
    await store.deleteMeeting(scope.meeting_id);
    expect(readPostprocessStoreIdentity(store.path)).toEqual({ tenant_id: scope.tenant_id, user_id: scope.user_id });
  });

  it('deletes all meeting-owned postprocess state', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'inkloop-postprocess-')), scope);
    const snapshot = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 1, text: 'ship' }] });
    await store.saveSnapshot(snapshot);
    await store.append(scope, 'run.queued', { kind: 'meeting.summary_cards' });
    await store.saveChunkExtraction('chunk', scope.occurrence_id, { secret: 'cached meeting extraction' });
    expect(await store.deleteMeeting(scope.meeting_id)).toMatchObject({ snapshots: 1, events: 1, chunk_cache: 1 });
    expect(store.getSnapshot(snapshot.snapshot_id)).toBeUndefined();
    expect(store.listEvents(scope)).toEqual([]);
    expect(store.getChunkExtraction('chunk')).toBeUndefined();
  });

  it('does not duplicate artifacts or ready events when the same artifact is saved twice', async () => {
    const store = new MeetingPostprocessStore(mkdtempSync(join(tmpdir(), 'inkloop-postprocess-')), scope);
    const snapshot = buildEvidenceSnapshot({ ...scope, transcript_final: true, ocr_status: 'ready', utterances: [{ start_ms: 0, end_ms: 1, text: 'ship' }] });
    const artifact = {
      ...scope,
      schema_version: POSTPROCESS_SCHEMA_VERSION,
      artifact_id: artifactId({ ...scope, kind: 'meeting.summary', snapshot_fingerprint: snapshot.fingerprint, pipeline_version: 'v2' }),
      kind: 'meeting.summary' as const,
      revision: 1,
      snapshot_id: snapshot.snapshot_id,
      snapshot_fingerprint: snapshot.fingerprint,
      pipeline_version: 'v2',
      prompt_version: 'meeting_brief_prompt_v2',
      finality: 'final' as const,
      status: 'ready' as const,
      content: '# Summary',
      created_at: new Date().toISOString(),
    };
    await store.saveArtifact(artifact); await store.saveArtifact(artifact);
    expect(store.listArtifacts(scope)).toHaveLength(1);
    expect(store.listEvents(scope).filter((event) => event.type === 'artifact.ready')).toHaveLength(1);
  });
});
