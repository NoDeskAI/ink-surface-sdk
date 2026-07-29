import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapMeetingPostprocess, bootstrapMeetingPostprocessConfigurationGates, createMeetingPostprocessService, enqueueEndedMeeting } from './service';
import { buildEvidenceSnapshot } from './evidence-snapshot';
import { MeetingPostprocessStore } from './store';
import { meetingTemplate } from './templates';
import { POSTPROCESS_SCHEMA_VERSION, postprocessConfigurationSchema, postprocessRunSchema } from './contracts';
import { sha256 } from './identity';

const closers: Array<() => Promise<void>> = [];
const hosted = new Map<string, { root: string; identity: { tenant_id: string; user_id: string } }>();
afterEach(async () => { hosted.clear(); await Promise.all(closers.splice(0).map((close) => close())); });

const generatedResponse = { theme: 'M1', overview: 'Ship', key_points: [], decisions: [{ id: 'd1', text: 'Ship', status: 'confirmed', evidence_refs: ['u1'] }], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [] };
async function host(identity = { tenant_id: 'tenant', user_id: 'user' }, root = mkdtempSync(join(tmpdir(), 'postprocess-service-')), overrides: Partial<Parameters<typeof createMeetingPostprocessService>[0]> = {}) {
  const handler = createMeetingPostprocessService({ root, generate: async () => generatedResponse, readBody: async (req, max = 1024 * 1024) => await new Promise<string>((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > max) reject(Object.assign(new Error('too_large'), { status: 413 })); }); req.on('end', () => resolve(body)); }), resolveIdentity: async () => identity, ...overrides });
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.statusCode = 404; res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  hosted.set(base, { root, identity });
  return base;
}

async function configure(base: string, meetingId: string, occurrenceId: string, templateId = 'meeting_expert', userGuidance = {}): Promise<{ status: number; json: any }> {
  return await call(`${base}/api/meeting-postprocess/configuration`, 'POST', { meeting_id: meetingId, occurrence_id: occurrenceId, template_id: templateId, user_guidance: userGuidance });
}

async function call(url: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> { return await new Promise((resolve, reject) => { const target = new URL(url); const req = request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => { let text = ''; res.on('data', (x) => text += x); res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(text || '{}') })); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }

async function submitFormal(base: string, body: Record<string, any>): Promise<{ status: number; json: any }> {
  const context = hosted.get(base); if (!context) throw new Error('unknown_test_host');
  const result = await enqueueEndedMeeting({
    options: { root: context.root, generate: async () => generatedResponse }, identity: context.identity,
    meeting_id: body.meeting_id, title: body.title || '(未命名会议)', platform: body.platform, provider_meeting_id: body.provider_meeting_id,
    started_at_ms: body.started_at_ms, ended_at_ms: body.ended_at_ms, source: body.source || 'local', transcript_origin: 'inkloop_media', transcript_final: body.transcript_final === true,
    transcript_converged: body.transcript_converged === true, transcript_missing_chunk_ids: body.transcript_missing_chunk_ids,
    ocr_status: body.ocr_status, utterances: body.utterances, handwriting: body.handwriting,
  });
  const store = new MeetingPostprocessStore(context.root, context.identity);
  const snapshot = store.getSnapshot(result.snapshot_id);
  return { status: 202, json: { status: result.status, occurrence_id: result.occurrence_id, run: result.run_id ? store.getRun(result.run_id) : undefined, snapshot } };
}

async function waitForArtifact(base: string, meetingId: string, kind: string, matches: (artifact: any) => boolean = () => true, occurrenceId?: string): Promise<any> {
  if (!occurrenceId) throw new Error('occurrence_id_required');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const artifacts = await call(`${base}/api/meeting-postprocess/artifacts?meeting_id=${meetingId}&occurrence_id=${encodeURIComponent(occurrenceId)}`);
    const artifact = artifacts.json.artifacts.find((item: any) => item.kind === kind);
    if (artifact && matches(artifact)) return artifact;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`artifact_not_ready:${kind}`);
}

async function firstSseEvent(url: string, lastEventId = 0): Promise<{ id: number; body: any }> { return await new Promise((resolve, reject) => { const target = new URL(url); const req = request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: { accept: 'text/event-stream', 'last-event-id': String(lastEventId) } }, (res) => { let text = ''; res.on('data', (chunk) => { text += chunk; const match = text.match(/id: (\d+)[\s\S]*?data: (\{.*\})\n\n/); if (!match) return; req.destroy(); resolve({ id: Number(match[1]), body: JSON.parse(match[2]) }); }); }); req.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); }); req.end(); }); }

describe('meeting postprocess service', () => {
  it.each(['google', 'zoom', 'lark', 'mtl'] as const)('never accepts %s platform transcript as postprocess evidence', async (source) => {
    const root = mkdtempSync(join(tmpdir(), `postprocess-platform-${source}-`));
    const identity = { tenant_id: 'tenant', user_id: 'user' };
    const result = await enqueueEndedMeeting({ options: { root, generate: async () => generatedResponse }, identity, meeting_id: `m-${source}`, title: source, platform: source, provider_meeting_id: 'occ', source, transcript_final: true, transcript_converged: true, ocr_status: 'not_applicable', utterances: [{ id: 'platform-u1', start_ms: 0, end_ms: 1, text: 'must be discarded' }] });
    const store = new MeetingPostprocessStore(root, identity);
    expect(result.status).toBe('awaiting_configuration');
    expect(store.getSnapshot(result.snapshot_id)).toMatchObject({ transcript_converged: false, utterances: [] });
    expect(store.listRuns({ meeting_id: `m-${source}` })).toEqual([]);
  });

  it('cancels an active legacy report during startup without invoking the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'postprocess-bootstrap-report-'));
    const identity = { tenant_id: 'tenant-bootstrap', user_id: 'user-bootstrap' };
    const store = new MeetingPostprocessStore(root, identity);
    const snapshot = buildEvidenceSnapshot({ ...identity, meeting_id: 'm-bootstrap-report', occurrence_id: 'zoom:bootstrap-report', transcript_final: true, transcript_converged: true, ocr_status: 'not_applicable', utterances: [{ start_ms: 0, end_ms: 1, text: 'legacy evidence' }] });
    await store.saveSnapshot(snapshot);
    const now = new Date().toISOString();
    await store.enqueue(postprocessRunSchema.parse({ ...snapshot, schema_version: POSTPROCESS_SCHEMA_VERSION, run_id: 'legacy-running-report', idempotency_key: 'e'.repeat(64), artifact_kind: 'meeting.full_report', meeting_title: 'Legacy report', enqueue_full_report: true, snapshot_id: snapshot.snapshot_id, pipeline_version: 'v2:legacy', status: 'running', attempt: 1, priority: 10, available_at: now, lease_expires_at: '2099-01-01T00:00:00.000Z', created_at: now, updated_at: now }));
    const generate = vi.fn(async () => generatedResponse);

    expect(bootstrapMeetingPostprocess({ root, generate })).toBe(1);
    await vi.waitFor(() => expect(store.getRun('legacy-running-report')).toMatchObject({ status: 'cancelled', error_code: 'full_report_retired' }));
    expect(store.getRun('legacy-running-report')).not.toHaveProperty('lease_expires_at');
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps device evidence provisional even when a client tries to attest finality', async () => {
    const identity = { tenant_id: 'tenant', user_id: 'user' };
    const root = mkdtempSync(join(tmpdir(), 'postprocess-device-trust-'));
    const base = await host(identity, root);
    const created = await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-device', provider_meeting_id: 'occ-device', source: 'local', transcript_final: true, transcript_converged: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'untrusted final' }] });
    expect(created.json).toMatchObject({ status: 'awaiting_configuration', snapshot: { finality: 'provisional', transcript_converged: false } });
    expect((await configure(base, 'm-device', created.json.occurrence_id)).json.status).toBe('awaiting_transcript');
    expect(new MeetingPostprocessStore(root, identity).listRuns({ meeting_id: 'm-device' })).toEqual([]);
  });

  it('does not let a late device upload downgrade or replace a trusted formal transcript', async () => {
    const identity = { tenant_id: 'tenant-late', user_id: 'user-late' };
    const root = mkdtempSync(join(tmpdir(), 'postprocess-device-late-'));
    const base = await host(identity, root);
    const formal = await enqueueEndedMeeting({ options: { root, generate: async () => generatedResponse }, identity, meeting_id: 'm-late', title: 'Late', provider_meeting_id: 'occ-late', source: 'local', transcript_final: true, ocr_status: 'pending', utterances: [{ id: 'formal-u1', start_ms: 0, end_ms: 1, text: 'trusted formal' }] });
    await configure(base, 'm-late', formal.occurrence_id);
    const late = await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-late', title: 'Late', provider_meeting_id: 'occ-late', source: 'local', transcript_final: false, ocr_status: 'ready', utterances: [{ id: 'stale-u1', start_ms: 0, end_ms: 1, text: 'stale device cue' }], handwriting: [{ id: 'h1', text: 'new board evidence', revision: 1, mark_ids: ['h1'] }] });
    expect(late.json).toMatchObject({ status: 'queued', snapshot: { finality: 'final', transcript_converged: true } });
    const store = new MeetingPostprocessStore(root, identity);
    const snapshot = store.getSnapshot(late.json.snapshot.snapshot_id);
    expect(snapshot?.utterances.map((item) => item.text)).toEqual(['trusted formal']);
    expect(snapshot?.handwriting.map((item) => item.text)).toEqual(['new board evidence']);
  });

  it('accepts server-side formal evidence and exposes artifact-first results', async () => {
    const identity = { tenant_id: 'tenant', user_id: 'user' };
    const root = mkdtempSync(join(tmpdir(), 'postprocess-formal-'));
    const base = await host(identity, root);
    const created = await enqueueEndedMeeting({ options: { root, generate: async () => generatedResponse }, identity, meeting_id: 'm1', title: 'M1', provider_meeting_id: 'occ1', platform: 'zoom', source: 'zoom', transcript_origin: 'inkloop_media', transcript_final: true, ocr_status: 'ready', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'ship' }] });
    expect(created.status).toBe('awaiting_configuration');
    await configure(base, 'm1', created.occurrence_id);
    await call(`${base}/api/meeting-postprocess/drain`, 'POST', { title: 'M1' });
    const artifacts = await call(`${base}/api/meeting-postprocess/artifacts?meeting_id=m1&occurrence_id=${encodeURIComponent(created.occurrence_id)}`);
    expect(artifacts.json.artifacts.map((x: any) => x.kind)).toEqual(['meeting.summary_cards', 'meeting.summary']);
  });

  it('returns a permanent retirement response for the legacy full-report endpoint', async () => {
    const base = await host();
    const response = await call(`${base}/api/meeting-postprocess/full-report`, 'POST', { meeting_id: 'missing', occurrence_id: 'local:missing' });
    expect(response).toMatchObject({ status: 410, json: { error: { code: 'full_report_retired' } } });
  });

  it('gates formal postprocess on both configuration and transcript convergence', async () => {
    const base = await host();
    const partial = await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-gate', provider_meeting_id: 'occ-gate', source: 'local', transcript_final: false, transcript_converged: false, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'partial' }] });
    expect(partial.json).toMatchObject({ status: 'awaiting_configuration' });
    expect((await call(`${base}/api/meeting-postprocess/runs?meeting_id=m-gate&occurrence_id=${encodeURIComponent(partial.json.occurrence_id)}`)).json.runs).toEqual([]);
    const configured = await configure(base, 'm-gate', partial.json.occurrence_id, 'interview_memo', { conclusions: ['用户认为应优先解决延迟'], deepest_impressions: ['讨论很发散'], pain_points: ['生成太慢'] });
    expect(configured.json.status).toBe('awaiting_transcript');
    expect((await call(`${base}/api/meeting-postprocess/runs?meeting_id=m-gate&occurrence_id=${encodeURIComponent(partial.json.occurrence_id)}`)).json.runs).toEqual([]);
    const forged = await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-gate', provider_meeting_id: 'occ-gate', source: 'local', transcript_final: false, transcript_converged: true, transcript_missing_chunk_ids: ['missing-1'], ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'partial' }] });
    expect(forged.json.status).toBe('awaiting_transcript');
    expect(forged.json.snapshot).toMatchObject({ finality: 'provisional', transcript_converged: false });
    const formal = await submitFormal(base, { meeting_id: 'm-gate', provider_meeting_id: 'occ-gate', source: 'local', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'formal' }] });
    expect(formal.json.status).toBe('queued');
    const runs = (await call(`${base}/api/meeting-postprocess/runs?meeting_id=m-gate&occurrence_id=${encodeURIComponent(partial.json.occurrence_id)}`)).json.runs;
    expect(runs).toHaveLength(1);
    const configuration = await call(`${base}/api/meeting-postprocess/configuration?meeting_id=m-gate&occurrence_id=${encodeURIComponent(partial.json.occurrence_id)}`);
    expect(configuration.json).toMatchObject({ status: 'configured', configuration: { template_id: 'interview_memo', user_guidance: { source: 'user_supplied', pain_points: ['生成太慢'] } } });
  });

  it('clears provisional evidence when a formal caller supplies explicit empty arrays', async () => {
    const base = await host();
    const provisional = await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-clear', provider_meeting_id: 'occ-clear', source: 'local', transcript_final: false, ocr_status: 'ready', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'stale' }], handwriting: [{ id: 'h1', text: 'stale ink', revision: 1, mark_ids: ['h1'] }] });
    const cleared = await submitFormal(base, { meeting_id: 'm-clear', provider_meeting_id: 'occ-clear', source: 'local', transcript_final: true, ocr_status: 'not_applicable', utterances: [], handwriting: [] });
    expect(cleared.json.snapshot.snapshot_id).not.toBe(provisional.json.snapshot.snapshot_id);
    await configure(base, 'm-clear', cleared.json.occurrence_id);
    expect((await call(`${base}/api/meeting-postprocess/artifacts?meeting_id=m-clear&occurrence_id=${encodeURIComponent(cleared.json.occurrence_id)}`)).json.artifacts).toEqual([]);
  });

  it('keeps evidence revisions waiting until configured, then deduplicates formal evidence', async () => {
    const base = await host();
    const input = { meeting_id: 'm-revision', provider_meeting_id: 'occ-revision', platform: 'zoom', source: 'zoom', title: 'Initial', transcript_final: false, ocr_status: 'pending', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'same evidence' }] };
    const first = await call(`${base}/api/meeting-postprocess/runs`, 'POST', input);
    const replay = await call(`${base}/api/meeting-postprocess/runs`, 'POST', input);
    expect(first.json.status).toBe('awaiting_configuration');
    expect(replay.json.status).toBe('awaiting_configuration');
    expect((await configure(base, 'm-revision', first.json.occurrence_id)).json.status).toBe('awaiting_transcript');
    const final = await submitFormal(base, { ...input, transcript_final: true, ocr_status: 'ready' });
    expect(final.json.run.run_id).toBeTruthy();
    expect(final.json.snapshot.finality).toBe('final');
    const renamed = await submitFormal(base, { ...input, title: 'Renamed', transcript_final: true, ocr_status: 'ready' });
    expect(renamed.json.run.run_id).not.toBe(final.json.run.run_id);
  });

  it('reprocesses the same evidence with a selected scene template', async () => {
    const base = await host();
    const initial = await submitFormal(base, { meeting_id: 'm-template', provider_meeting_id: 'occ-template', source: 'local', title: 'Template', transcript_final: true, ocr_status: 'ready', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'same source' }], handwriting: [{ id: 'h-source', text: 'board fact', revision: 1, mark_ids: ['h-source'] }] });
    const configured = await configure(base, 'm-template', initial.json.occurrence_id);
    await waitForArtifact(base, 'm-template', 'meeting.summary_cards', () => true, initial.json.occurrence_id);
    const occurrence_id = initial.json.occurrence_id;
    const changed = await call(`${base}/api/meeting-postprocess/template`, 'POST', { meeting_id: 'm-template', occurrence_id, template_id: 'interactive_classroom' });
    expect(changed).toMatchObject({ status: 202, json: { snapshot: { template_id: 'interactive_classroom', template_version: 'interactive_classroom.v3', finality: 'final' } } });
    expect(changed.json.run.run_id).not.toBe(configured.json.run.run_id);

    const replay = await call(`${base}/api/meeting-postprocess/template`, 'POST', { meeting_id: 'm-template', occurrence_id, template_id: 'interactive_classroom' });
    expect(replay.json.run.run_id).toBe(changed.json.run.run_id);
    const cards = await waitForArtifact(base, 'm-template', 'meeting.summary_cards', (artifact) => artifact.content?.template_id === 'interactive_classroom', occurrence_id);
    expect(cards.content).toMatchObject({ template_id: 'interactive_classroom', template_version: 'interactive_classroom.v3' });

    const restored = await call(`${base}/api/meeting-postprocess/template`, 'POST', { meeting_id: 'm-template', occurrence_id, template_id: 'meeting_expert' });
    expect(restored.json.reused_artifacts).toBeGreaterThan(0);
    const restoredCards = (await call(`${base}/api/meeting-postprocess/artifacts?meeting_id=m-template&occurrence_id=${encodeURIComponent(occurrence_id)}`)).json.artifacts.find((item: any) => item.kind === 'meeting.summary_cards');
    expect(restoredCards.content).toMatchObject({ template_id: 'meeting_expert' });

  });

  it('bootstraps only the current configuration after an A to B to A selection history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'postprocess-gate-bootstrap-'));
    const identity = { tenant_id: 'tenant-bootstrap', user_id: 'user-bootstrap' };
    const options = { root, generate: async () => generatedResponse };
    const ended = await enqueueEndedMeeting({ options, identity, meeting_id: 'm-bootstrap', provider_meeting_id: 'occ-bootstrap', source: 'local', title: 'Bootstrap', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'formal evidence' }] });
    const store = new MeetingPostprocessStore(root, identity);
    const saveConfiguration = async (revision: number, templateId: 'meeting_expert' | 'interview_memo') => {
      const template = meetingTemplate(templateId);
      const user_guidance = { source: 'user_supplied' as const, conclusions: [], deepest_impressions: [], pain_points: [] };
      const fingerprint = sha256({ template_id: template.id, template_version: template.version, user_guidance });
      await store.saveConfiguration(postprocessConfigurationSchema.parse({ ...identity, meeting_id: 'm-bootstrap', occurrence_id: ended.occurrence_id, schema_version: POSTPROCESS_SCHEMA_VERSION, configuration_id: `configuration-${revision}`, revision, fingerprint, template_id: template.id, template_version: template.version, user_guidance, submitted_at: new Date(revision * 1_000).toISOString() }));
    };
    await saveConfiguration(1, 'meeting_expert');
    await saveConfiguration(2, 'interview_memo');
    await saveConfiguration(3, 'meeting_expert');

    expect(bootstrapMeetingPostprocessConfigurationGates(options)).toBe(1);
    for (let attempt = 0; attempt < 50 && store.listRuns({ meeting_id: 'm-bootstrap' }).length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const runs = store.listRuns({ meeting_id: 'm-bootstrap' });
    expect(runs).toHaveLength(1);
    expect(store.getSnapshot(runs[0].snapshot_id)).toMatchObject({ template_id: 'meeting_expert' });
    expect(store.getCurrentConfiguration({ ...identity, meeting_id: 'm-bootstrap', occurrence_id: ended.occurrence_id })).toMatchObject({ configuration_id: 'configuration-3' });
  });

  it('requires occurrence scope so a recurring meeting template change cannot target another event', async () => {
    const base = await host();
    await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-recurring', provider_meeting_id: 'occ-1', source: 'local', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'first occurrence' }] });
    await call(`${base}/api/meeting-postprocess/runs`, 'POST', { meeting_id: 'm-recurring', provider_meeting_id: 'occ-2', source: 'local', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u2', start_ms: 0, end_ms: 1, text: 'second occurrence' }] });
    expect(await call(`${base}/api/meeting-postprocess/template`, 'POST', { meeting_id: 'm-recurring', template_id: 'interview_memo' })).toMatchObject({ status: 400, json: { error: { code: 'occurrence_id_required' } } });
  });

  it('rejects template changes without a reusable evidence snapshot', async () => {
    const base = await host();
    expect(await call(`${base}/api/meeting-postprocess/template`, 'POST', { meeting_id: 'missing', occurrence_id: 'local:missing', template_id: 'meeting_expert' })).toMatchObject({ status: 409, json: { error: { code: 'meeting_evidence_snapshot_required' } } });
    expect(await call(`${base}/api/meeting-postprocess/template`, 'POST', { meeting_id: 'missing', template_id: 'invented' })).toMatchObject({ status: 400, json: { error: { code: 'meeting_template_invalid' } } });
  });

  it('exposes OCR failure and no-handwriting finality explicitly', async () => {
    const base = await host();
    const failed = await submitFormal(base, { meeting_id: 'm-ocr-failed', provider_meeting_id: 'occ-failed', source: 'local', transcript_final: true, ocr_status: 'failed', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'spoken evidence' }] });
    expect(failed.json.snapshot).toMatchObject({ finality: 'provisional', missing_reasons: ['ocr_failed'] });
    const none = await submitFormal(base, { meeting_id: 'm-no-handwriting', provider_meeting_id: 'occ-none', source: 'local', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'spoken evidence' }] });
    expect(none.json.snapshot).toMatchObject({ finality: 'final', missing_reasons: [] });
  });

  it('registers provider identity and deletes the complete lifecycle', async () => {
    const base = await host();
    const registered = await call(`${base}/api/meeting-postprocess/provider-registrations`, 'POST', { meetings: [{ meeting_id: 'm-delete', provider: 'google', title: 'Delete', provider_calendar_event_id: 'event-delete', meeting_code: 'abc', scheduled_at: '2026-07-21T01:00:00.000Z', status: 'ended' }] });
    expect(registered.status).toBe(200);
    const ended = await submitFormal(base, { meeting_id: 'm-delete', provider_meeting_id: 'event-delete', source: 'google', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'delete me' }] });
    await configure(base, 'm-delete', ended.json.occurrence_id);
    const deleted = await call(`${base}/api/meeting-postprocess/artifacts?meeting_id=m-delete`, 'DELETE');
    expect(deleted.json.deleted).toMatchObject({ registrations: 1, runs: 1, snapshots: 1 });
    const afterDelete = await call(`${base}/api/meeting-postprocess/runs?meeting_id=m-delete&occurrence_id=${encodeURIComponent(ended.json.occurrence_id)}`);
    expect(afterDelete).toMatchObject({ status: 200, json: { runs: [] } });
  });

  it('uses a distinct tombstoned endpoint for whole-meeting deletion', async () => {
    const deleteMeetingMedia = vi.fn()
      .mockResolvedValueOnce({ command_id: 'meeting_delete_test', cloud_sessions_deleted: 1, pending_companion: true })
      .mockResolvedValueOnce({ command_id: 'meeting_delete_test', cloud_sessions_deleted: 0, pending_companion: false });
    const deleteMeetingRuntime = vi.fn(async () => ({ runtime_events: 2, knowledge_records: 3 }));
    const base = await host(undefined, undefined, { deleteMeetingMedia, deleteMeetingRuntime });
    const ended = await submitFormal(base, { meeting_id: 'm-whole-delete', provider_meeting_id: 'occ-delete', source: 'local', transcript_final: true, transcript_converged: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'delete me' }] });
    await configure(base, 'm-whole-delete', ended.json.occurrence_id);

    const first = await call(`${base}/api/meeting-postprocess/meeting?meeting_id=m-whole-delete`, 'DELETE');
    expect(first).toMatchObject({ status: 200, json: { command_id: 'meeting_delete_test', pending_companion: true, cloud_sessions_deleted: 1, runtime_deleted: { runtime_events: 2, knowledge_records: 3 }, replay: false } });
    expect(deleteMeetingMedia).toHaveBeenCalledTimes(1);
    expect(deleteMeetingRuntime).toHaveBeenCalledTimes(1);
    expect(await call(`${base}/api/meeting-postprocess/runs?meeting_id=m-whole-delete&occurrence_id=${encodeURIComponent(ended.json.occurrence_id)}`)).toMatchObject({ status: 410, json: { error: { code: 'meeting_deleted' } } });

    const replay = await call(`${base}/api/meeting-postprocess/meeting?meeting_id=m-whole-delete`, 'DELETE');
    expect(replay).toMatchObject({ status: 200, json: { command_id: 'meeting_delete_test', pending_companion: false, replay: true } });
    expect(deleteMeetingMedia).toHaveBeenCalledTimes(2);
    expect(deleteMeetingRuntime).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent whole-meeting deletion side effects', async () => {
    let releaseMedia!: () => void;
    const mediaGate = new Promise<void>((resolve) => { releaseMedia = resolve; });
    const deleteMeetingMedia = vi.fn(async () => {
      await mediaGate;
      return { command_id: 'meeting_delete_concurrent', cloud_sessions_deleted: 1, pending_companion: true };
    });
    const deleteMeetingRuntime = vi.fn(async () => ({ runtime_events: 1, knowledge_records: 1 }));
    const base = await host(undefined, undefined, { deleteMeetingMedia, deleteMeetingRuntime });

    const first = call(`${base}/api/meeting-postprocess/meeting?meeting_id=m-concurrent-delete`, 'DELETE');
    const second = call(`${base}/api/meeting-postprocess/meeting?meeting_id=m-concurrent-delete`, 'DELETE');
    await vi.waitFor(() => expect(deleteMeetingMedia).toHaveBeenCalledTimes(1));
    releaseMedia();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.filter((result) => result.json.replay === false)).toHaveLength(1);
    expect(results.filter((result) => result.json.replay === true)).toHaveLength(1);
    expect(deleteMeetingRuntime).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed whole-meeting deletion fail-closed and resumes it on retry', async () => {
    const deleteMeetingMedia = vi.fn()
      .mockResolvedValueOnce({
        command_id: 'meeting_delete_resume',
        cloud_sessions_deleted: 1,
        pending_companion: true,
      })
      .mockResolvedValueOnce({
        command_id: 'meeting_delete_resume',
        cloud_sessions_deleted: 0,
        pending_companion: false,
      });
    const deleteMeetingRuntime = vi.fn()
      .mockRejectedValueOnce(new Error('runtime_delete_temporarily_unavailable'))
      .mockResolvedValueOnce({ runtime_events: 1, knowledge_records: 2 });
    const base = await host(undefined, undefined, { deleteMeetingMedia, deleteMeetingRuntime });
    const ended = await submitFormal(base, {
      meeting_id: 'm-delete-resume',
      provider_meeting_id: 'occ-delete-resume',
      source: 'local',
      transcript_final: true,
      transcript_converged: true,
      ocr_status: 'not_applicable',
      utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'delete me safely' }],
    });
    await configure(base, 'm-delete-resume', ended.json.occurrence_id);

    const failed = await call(
      `${base}/api/meeting-postprocess/meeting?meeting_id=m-delete-resume`,
      'DELETE',
    );
    expect(failed).toMatchObject({
      status: 500,
      json: { error: { code: 'runtime_delete_temporarily_unavailable' } },
    });
    expect(await call(
      `${base}/api/meeting-postprocess/runs?meeting_id=m-delete-resume&occurrence_id=${encodeURIComponent(ended.json.occurrence_id)}`,
    )).toMatchObject({
      status: 410,
      json: { error: { code: 'meeting_deleted' } },
    });

    const resumed = await call(
      `${base}/api/meeting-postprocess/meeting?meeting_id=m-delete-resume`,
      'DELETE',
    );
    expect(resumed).toMatchObject({
      status: 200,
      json: {
        command_id: 'meeting_delete_resume',
        pending_companion: false,
        runtime_deleted: { runtime_events: 1, knowledge_records: 2 },
        replay: false,
      },
    });
    expect(deleteMeetingMedia).toHaveBeenCalledTimes(2);
    expect(deleteMeetingRuntime).toHaveBeenCalledTimes(2);
  });

  it('requires meeting scope on reads', async () => {
    const base = await host();
    expect((await call(`${base}/api/meeting-postprocess/artifacts`)).status).toBe(400);
    expect((await call(`${base}/api/meeting-postprocess/artifacts?meeting_id=m`)).json.error.code).toBe('occurrence_id_required');
  });

  it('resumes the real HTTP SSE stream after Last-Event-ID', async () => {
    const base = await host();
    const ended = await submitFormal(base, { meeting_id: 'm-sse', provider_meeting_id: 'occ-sse', platform: 'zoom', source: 'zoom', transcript_final: true, ocr_status: 'ready', utterances: [{ id: 'u1', start_ms: 0, end_ms: 1, text: 'ship' }] });
    await configure(base, 'm-sse', ended.json.occurrence_id);
    await call(`${base}/api/meeting-postprocess/drain`, 'POST');
    const eventsUrl = `${base}/api/meeting-postprocess/events?meeting_id=m-sse&occurrence_id=${encodeURIComponent(ended.json.occurrence_id)}`;
    const first = await firstSseEvent(eventsUrl);
    const next = await firstSseEvent(eventsUrl, first.id);
    expect(next.id).toBeGreaterThan(first.id);
    expect(next.body.event_id).toBe(next.id);
  });
});
