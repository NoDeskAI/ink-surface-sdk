import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { EvidenceSnapshot, PostprocessArtifact, PostprocessConfiguration, PostprocessEvent, PostprocessRun } from './contracts';
import { evidenceSnapshotSchema, POSTPROCESS_SCHEMA_VERSION, postprocessArtifactSchema, postprocessConfigurationSchema, postprocessEventSchema, postprocessRunSchema } from './contracts';
import { safeIdentityPart, sha256 } from './identity';

interface CachedExtraction { occurrence_id: string; value: unknown }
interface MeetingDeletionReceipt {
  meeting_id: string;
  command_id: string;
  status: 'requested' | 'completed';
  requested_at: string;
  deleted_at?: string;
  counts?: {
    runs: number;
    snapshots: number;
    configurations: number;
    artifacts: number;
    events: number;
    chunk_cache: number;
    registrations: number;
  };
}
interface State { schema_version: typeof POSTPROCESS_SCHEMA_VERSION; tenant_id: string; user_id: string; next_event_id: number; runs: PostprocessRun[]; snapshots: EvidenceSnapshot[]; configurations: PostprocessConfiguration[]; artifacts: PostprocessArtifact[]; events: PostprocessEvent[]; chunk_cache: Record<string, CachedExtraction>; current_snapshots: Record<string, string>; current_configurations: Record<string, string>; meeting_deletions: Record<string, MeetingDeletionReceipt> }
const MAX_EVENTS = 5_000;
const MAX_CHUNK_CACHE_ENTRIES = 500;

export interface PostprocessScope { tenant_id: string; user_id: string; meeting_id: string; occurrence_id?: string }

export class MeetingPostprocessStore {
  private static locks = new Map<string, Promise<unknown>>();
  readonly path: string;
  private readonly identity: Pick<PostprocessScope, 'tenant_id' | 'user_id'>;
  constructor(root: string, scope: Pick<PostprocessScope, 'tenant_id' | 'user_id'>) {
    this.identity = scope;
    this.path = resolve(root, namespacePart(scope.tenant_id, 'tenant'), namespacePart(scope.user_id, 'user'), 'meeting-postprocess-v2.json');
  }

  private read(): State {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as State;
      const chunk_cache = Object.fromEntries(Object.entries(value.chunk_cache || {}).flatMap(([key, cached]) => cached && typeof cached === 'object' && 'occurrence_id' in cached && 'value' in cached ? [[key, cached as CachedExtraction]] : []));
      const state = { schema_version: POSTPROCESS_SCHEMA_VERSION, tenant_id: value.tenant_id || this.identity.tenant_id, user_id: value.user_id || this.identity.user_id, next_event_id: Math.max(1, value.next_event_id || 1), runs: (value.runs || []).map((x) => postprocessRunSchema.parse(x)), snapshots: (value.snapshots || []).map((x) => {
        const legacy = x as EvidenceSnapshot & { transcript_converged?: boolean };
        return evidenceSnapshotSchema.parse({ ...legacy, transcript_converged: legacy.transcript_converged ?? !legacy.missing_reasons?.some((reason) => reason === 'transcript_pending' || reason === 'transcript_partial') });
      }), configurations: (value.configurations || []).map((x) => postprocessConfigurationSchema.parse(x)), artifacts: (value.artifacts || []).map((x) => postprocessArtifactSchema.parse(x)), events: (value.events || []).map((x) => postprocessEventSchema.parse(x)), chunk_cache, current_snapshots: value.current_snapshots || {}, current_configurations: value.current_configurations || {}, meeting_deletions: Object.fromEntries(Object.entries(value.meeting_deletions || {}).map(([meetingId, receipt]) => [meetingId, {
        ...receipt,
        status: receipt.status || 'completed',
        requested_at: receipt.requested_at || receipt.deleted_at || new Date(0).toISOString(),
      }])) };
      for (const snapshot of state.snapshots) {
        const key = occurrenceStateKey(snapshot.meeting_id, snapshot.occurrence_id);
        if (state.current_snapshots[key]) continue;
        const readyCards = state.artifacts.filter((artifact) => artifact.meeting_id === snapshot.meeting_id && artifact.occurrence_id === snapshot.occurrence_id && artifact.kind === 'meeting.summary_cards' && artifact.status === 'ready').at(-1);
        const latest = state.snapshots.filter((item) => item.meeting_id === snapshot.meeting_id && item.occurrence_id === snapshot.occurrence_id).sort((a, b) => a.revision - b.revision || a.created_at.localeCompare(b.created_at)).at(-1);
        state.current_snapshots[key] = readyCards?.snapshot_id || latest?.snapshot_id || snapshot.snapshot_id;
      }
      for (const configuration of state.configurations) {
        const key = occurrenceStateKey(configuration.meeting_id, configuration.occurrence_id);
        if (state.current_configurations[key]) continue;
        const latest = state.configurations.filter((item) => item.meeting_id === configuration.meeting_id && item.occurrence_id === configuration.occurrence_id).sort((a, b) => a.revision - b.revision || a.submitted_at.localeCompare(b.submitted_at)).at(-1);
        if (latest) state.current_configurations[key] = latest.configuration_id;
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: POSTPROCESS_SCHEMA_VERSION, ...this.identity, next_event_id: 1, runs: [], snapshots: [], configurations: [], artifacts: [], events: [], chunk_cache: {}, current_snapshots: {}, current_configurations: {}, meeting_deletions: {} };
      throw error;
    }
  }

  private write(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private mutate<T>(fn: (state: State) => T): Promise<T> {
    const tail = MeetingPostprocessStore.locks.get(this.path) || Promise.resolve();
    const next = tail.then(() => { const state = this.read(); const output = fn(state); this.write(state); return output; });
    MeetingPostprocessStore.locks.set(this.path, next.catch(() => undefined));
    return next;
  }

  listRuns(scope?: Partial<PostprocessScope>): PostprocessRun[] { return this.read().runs.filter((x) => matches(x, scope)); }
  getRun(runId: string): PostprocessRun | undefined { return this.read().runs.find((x) => x.run_id === runId); }
  listSnapshots(scope?: Partial<PostprocessScope>): EvidenceSnapshot[] { return this.read().snapshots.filter((x) => matches(x, scope)); }
  listConfigurations(scope?: Partial<PostprocessScope>): PostprocessConfiguration[] { return this.read().configurations.filter((x) => matches(x, scope)); }
  getCurrentConfiguration(scope: PostprocessScope): PostprocessConfiguration | undefined {
    const state = this.read();
    const id = state.current_configurations[occurrenceStateKey(scope.meeting_id, scope.occurrence_id || '')];
    return id ? state.configurations.find((configuration) => configuration.configuration_id === id && matches(configuration, scope)) : undefined;
  }
  listCurrentConfigurations(): PostprocessConfiguration[] {
    const state = this.read();
    return Object.values(state.current_configurations).flatMap((id) => {
      const configuration = state.configurations.find((item) => item.configuration_id === id);
      return configuration ? [configuration] : [];
    });
  }
  listArtifacts(scope?: Partial<PostprocessScope>): PostprocessArtifact[] { return this.read().artifacts.filter((x) => matches(x, scope)); }
  listEvents(scope: PostprocessScope, after = 0): PostprocessEvent[] { return this.read().events.filter((x) => matches(x, scope) && x.event_id > after); }
  getSnapshot(id: string): EvidenceSnapshot | undefined { return this.read().snapshots.find((x) => x.snapshot_id === id); }
  getCurrentSnapshot(scope: PostprocessScope): EvidenceSnapshot | undefined {
    const state = this.read();
    const id = state.current_snapshots[occurrenceStateKey(scope.meeting_id, scope.occurrence_id || '')];
    return id ? state.snapshots.find((snapshot) => snapshot.snapshot_id === id) : undefined;
  }
  isCurrentSnapshot(scope: PostprocessScope, snapshotId: string): boolean {
    return this.read().current_snapshots[occurrenceStateKey(scope.meeting_id, scope.occurrence_id || '')] === snapshotId;
  }
  getChunkExtraction(key: string): unknown { return this.read().chunk_cache[key]?.value; }
  getMeetingDeletion(meetingId: string): MeetingDeletionReceipt | undefined { return this.read().meeting_deletions[meetingId]; }
  isMeetingDeleted(meetingId: string): boolean { return !!this.getMeetingDeletion(meetingId); }
  requestMeetingDeletion(meetingId: string, commandId: string): Promise<MeetingDeletionReceipt> {
    return this.mutate((state) => {
      const prior = state.meeting_deletions[meetingId];
      if (prior) return prior;
      const receipt: MeetingDeletionReceipt = {
        meeting_id: meetingId,
        command_id: commandId,
        status: 'requested',
        requested_at: new Date().toISOString(),
      };
      state.meeting_deletions[meetingId] = receipt;
      return receipt;
    });
  }
  saveChunkExtraction(key: string, occurrenceId: string, value: unknown): Promise<void> { return this.mutate((state) => {
    delete state.chunk_cache[key]; // refresh insertion order for the bounded LRU-like cache
    state.chunk_cache[key] = { occurrence_id: occurrenceId, value };
    const overflow = Object.keys(state.chunk_cache).length - MAX_CHUNK_CACHE_ENTRIES;
    if (overflow > 0) for (const stale of Object.keys(state.chunk_cache).slice(0, overflow)) delete state.chunk_cache[stale];
  }); }

  saveSnapshot(snapshot: EvidenceSnapshot): Promise<EvidenceSnapshot> { return this.mutate((state) => { const found = state.snapshots.find((x) => x.snapshot_id === snapshot.snapshot_id); if (found) return found; const parsed = evidenceSnapshotSchema.parse(snapshot); state.snapshots.push(parsed); return parsed; }); }
  saveConfiguration(configuration: PostprocessConfiguration): Promise<PostprocessConfiguration> { return this.mutate((state) => {
    const found = state.configurations.find((x) => x.configuration_id === configuration.configuration_id);
    const saved = found || postprocessConfigurationSchema.parse(configuration);
    if (!found) state.configurations.push(saved);
    state.current_configurations[occurrenceStateKey(saved.meeting_id, saved.occurrence_id)] = saved.configuration_id;
    return saved;
  }); }
  selectCurrentSnapshot(scope: PostprocessScope, snapshotId: string): Promise<number> { return this.mutate((state) => {
    const snapshot = state.snapshots.find((item) => item.snapshot_id === snapshotId && matches(item, scope));
    if (!snapshot) throw Object.assign(new Error('meeting_evidence_snapshot_not_found'), { status: 409 });
    state.current_snapshots[occurrenceStateKey(snapshot.meeting_id, snapshot.occurrence_id)] = snapshot.snapshot_id;
    const now = new Date().toISOString();
    for (const run of state.runs.filter((item) => item.meeting_id === snapshot.meeting_id && item.occurrence_id === snapshot.occurrence_id && item.snapshot_id !== snapshot.snapshot_id && ['queued', 'collecting_evidence', 'running'].includes(item.status))) {
      run.status = 'superseded'; run.updated_at = now; delete run.lease_expires_at;
    }
    let activated = 0;
    for (const artifact of state.artifacts.filter((item) => item.meeting_id === snapshot.meeting_id && item.occurrence_id === snapshot.occurrence_id)) {
      if (artifact.snapshot_id === snapshot.snapshot_id && artifact.status === 'superseded') {
        artifact.status = 'ready'; activated += 1;
        appendEvent(state, artifact, 'artifact.ready', { kind: artifact.kind, finality: artifact.finality, reactivated: true });
      } else if (artifact.snapshot_id !== snapshot.snapshot_id && artifact.status === 'ready') {
        artifact.status = 'superseded';
        appendEvent(state, artifact, 'artifact.superseded', { replacement_snapshot_id: snapshot.snapshot_id });
      }
    }
    return activated;
  }); }
  enqueue(run: PostprocessRun): Promise<PostprocessRun> { return this.mutate((state) => { const found = state.runs.find((x) => x.idempotency_key === run.idempotency_key); if (found) { if (found.status === 'failed' && state.current_snapshots[occurrenceStateKey(found.meeting_id, found.occurrence_id)] === found.snapshot_id) { found.status = 'queued'; found.available_at = run.available_at; found.updated_at = run.updated_at; delete found.error_code; } return found; } const active = state.runs.filter((x) => x.meeting_id === run.meeting_id && x.occurrence_id === run.occurrence_id && x.artifact_kind === run.artifact_kind && !['cancelled', 'superseded'].includes(x.status)); for (const old of active) { old.status = 'superseded'; old.updated_at = new Date().toISOString(); } const parsed = postprocessRunSchema.parse(run); state.runs.push(parsed); appendEvent(state, parsed, 'run.queued', { artifact_kind: run.artifact_kind }); return parsed; }); }
  updateRun(runId: string, patch: Partial<PostprocessRun>, eventType?: PostprocessEvent['type']): Promise<PostprocessRun> { return this.mutate((state) => { const index = state.runs.findIndex((x) => x.run_id === runId); if (index < 0) throw new Error('postprocess_run_not_found'); const current = state.runs[index]; if (['cancelled', 'superseded'].includes(current.status) && patch.status && patch.status !== current.status) return current; const run = postprocessRunSchema.parse({ ...current, ...patch, updated_at: patch.updated_at || new Date().toISOString() }); state.runs[index] = run; if (eventType) appendEvent(state, run, eventType, patch.error_code ? { error_code: patch.error_code } : {}); return run; }); }
  saveArtifact(artifact: PostprocessArtifact, runId?: string): Promise<PostprocessArtifact> { return this.mutate((state) => {
    const key = occurrenceStateKey(artifact.meeting_id, artifact.occurrence_id);
    const run = runId ? state.runs.find((item) => item.run_id === runId) : undefined;
    if (runId && (state.current_snapshots[key] !== artifact.snapshot_id || !run || run.snapshot_id !== artifact.snapshot_id || run.status !== 'running')) throw new Error('postprocess_run_superseded');
    const found = state.artifacts.find((x) => x.artifact_id === artifact.artifact_id); if (found) return found;
    for (const old of state.artifacts.filter((x) => x.meeting_id === artifact.meeting_id && x.occurrence_id === artifact.occurrence_id && x.kind === artifact.kind && x.status === 'ready')) { old.status = 'superseded'; appendEvent(state, old, 'artifact.superseded', { replacement_id: artifact.artifact_id }); }
    const parsed = postprocessArtifactSchema.parse(artifact); state.artifacts.push(parsed); appendEvent(state, parsed, 'artifact.ready', { kind: artifact.kind, finality: artifact.finality }); return parsed;
  }); }
  append(scope: PostprocessScope, type: PostprocessEvent['type'], data: Record<string, unknown>, refs: { run_id?: string; artifact_id?: string } = {}): Promise<PostprocessEvent> { return this.mutate((state) => appendEvent(state, { ...scope, ...refs }, type, data)); }
  appendForCurrentRun(runId: string, type: PostprocessEvent['type'], data: Record<string, unknown>, refs: { artifact_id?: string } = {}): Promise<PostprocessEvent> { return this.mutate((state) => {
    const run = state.runs.find((item) => item.run_id === runId);
    if (!run || run.status !== 'running' || state.current_snapshots[occurrenceStateKey(run.meeting_id, run.occurrence_id)] !== run.snapshot_id) throw new Error('postprocess_run_superseded');
    return appendEvent(state, { ...run, ...refs }, type, data);
  }); }
  appendManyForCurrentRun(runId: string, values: Array<{ type: PostprocessEvent['type']; data: Record<string, unknown>; refs?: { artifact_id?: string } }>): Promise<PostprocessEvent[]> { return this.mutate((state) => {
    const run = state.runs.find((item) => item.run_id === runId);
    if (!run || run.status !== 'running' || state.current_snapshots[occurrenceStateKey(run.meeting_id, run.occurrence_id)] !== run.snapshot_id) throw new Error('postprocess_run_superseded');
    return values.map((value) => appendEvent(state, { ...run, ...(value.refs || {}) }, value.type, value.data));
  }); }
  pruneEvents(before: Date): Promise<number> { return this.mutate((state) => { const prior = state.events.length; state.events = state.events.filter((x) => Date.parse(x.created_at) >= before.getTime()); return prior - state.events.length; }); }
  recoverExpired(now = new Date()): Promise<number> { return this.mutate((state) => { let recovered = 0; for (const run of state.runs) { if (run.status === 'running' && (!run.lease_expires_at || Date.parse(run.lease_expires_at) <= now.getTime())) { run.status = 'queued'; run.available_at = now.toISOString(); run.updated_at = now.toISOString(); delete run.lease_expires_at; recovered += 1; appendEvent(state, run, 'run.retrying', { reason: 'lease_expired' }); } } return recovered; }); }
  deleteMeeting(meetingId: string, input?: { command_id: string; registrations: number }): Promise<{ runs: number; snapshots: number; configurations: number; artifacts: number; events: number; chunk_cache: number; registrations: number }> { return this.mutate((state) => { const prior = state.meeting_deletions[meetingId]; if (prior?.status === 'completed' && prior.counts) return prior.counts; const occurrenceIds = new Set([...state.runs, ...state.snapshots, ...state.configurations, ...state.artifacts, ...state.events].filter((x) => x.meeting_id === meetingId).map((x) => x.occurrence_id)); const cacheKeys = Object.keys(state.chunk_cache).filter((key) => occurrenceIds.has(state.chunk_cache[key].occurrence_id)); const result = { runs: state.runs.filter((x) => x.meeting_id === meetingId).length, snapshots: state.snapshots.filter((x) => x.meeting_id === meetingId).length, configurations: state.configurations.filter((x) => x.meeting_id === meetingId).length, artifacts: state.artifacts.filter((x) => x.meeting_id === meetingId).length, events: state.events.filter((x) => x.meeting_id === meetingId).length, chunk_cache: cacheKeys.length, registrations: input?.registrations || 0 }; state.runs = state.runs.filter((x) => x.meeting_id !== meetingId); state.snapshots = state.snapshots.filter((x) => x.meeting_id !== meetingId); state.configurations = state.configurations.filter((x) => x.meeting_id !== meetingId); state.artifacts = state.artifacts.filter((x) => x.meeting_id !== meetingId); state.events = state.events.filter((x) => x.meeting_id !== meetingId); for (const key of Object.keys(state.current_snapshots)) if (key.startsWith(`${meetingId}\u001f`)) delete state.current_snapshots[key]; for (const key of Object.keys(state.current_configurations)) if (key.startsWith(`${meetingId}\u001f`)) delete state.current_configurations[key]; for (const key of cacheKeys) delete state.chunk_cache[key]; if (input) state.meeting_deletions[meetingId] = { meeting_id: meetingId, command_id: input.command_id, status: 'completed', requested_at: prior?.requested_at || new Date().toISOString(), deleted_at: new Date().toISOString(), counts: result }; return result; }); }
}

export function readPostprocessStoreIdentity(path: string): { tenant_id: string; user_id: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
    if (parsed.tenant_id && parsed.user_id) return { tenant_id: parsed.tenant_id, user_id: parsed.user_id };
    const sample = parsed.runs?.[0] || parsed.snapshots?.[0] || parsed.artifacts?.[0] || parsed.events?.[0];
    return sample?.tenant_id && sample?.user_id ? { tenant_id: sample.tenant_id, user_id: sample.user_id } : null;
  } catch { return null; }
}

function matches(value: PostprocessScope, scope?: Partial<PostprocessScope>): boolean { return !scope || (!scope.tenant_id || value.tenant_id === scope.tenant_id) && (!scope.user_id || value.user_id === scope.user_id) && (!scope.meeting_id || value.meeting_id === scope.meeting_id) && (!scope.occurrence_id || value.occurrence_id === scope.occurrence_id); }
function occurrenceStateKey(meetingId: string, occurrenceId: string): string { return `${meetingId}\u001f${occurrenceId}`; }
function appendEvent(state: State, source: PostprocessScope & { run_id?: string; artifact_id?: string }, type: PostprocessEvent['type'], data: Record<string, unknown>): PostprocessEvent { const event = postprocessEventSchema.parse({ schema_version: POSTPROCESS_SCHEMA_VERSION, event_id: state.next_event_id++, type, tenant_id: source.tenant_id, user_id: source.user_id, meeting_id: source.meeting_id, occurrence_id: source.occurrence_id || '', run_id: source.run_id, artifact_id: source.artifact_id, data: redact(data), created_at: new Date().toISOString() }); state.events.push(event); if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS); return event; }
function redact(data: Record<string, unknown>): Record<string, unknown> { const blocked = /transcript|handwriting|token|secret|content|text/i; return Object.fromEntries(Object.entries(data).filter(([key]) => !blocked.test(key)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 512) : value])); }
export function artifactId(input: { tenant_id: string; user_id: string; meeting_id: string; occurrence_id: string; kind: string; snapshot_fingerprint: string; pipeline_version: string }): string { return `artifact_${sha256(input).slice(0, 24)}`; }
function namespacePart(value: string, fallback: string): string { return `${safeIdentityPart(value, fallback).slice(0, 80)}_${sha256(value).slice(0, 12)}`; }
