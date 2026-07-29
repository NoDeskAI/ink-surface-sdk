import type { EvidenceSnapshot, MeetingSummaryCardsV2, PostprocessArtifact, PostprocessRun } from './contracts';
import { POSTPROCESS_SCHEMA_VERSION, postprocessRunSchema } from './contracts';
import { artifactId, MeetingPostprocessStore } from './store';
import { runIdempotencyKey } from './identity';
import { DEFAULT_MEETING_CHUNK_CHARS, generateBriefV2, MEETING_BRIEF_PROMPT_VERSION, type JsonGenerator } from './brief-v2';
import { renderMeetingSummary } from './summary-renderer';
import { generateInterviewArchiveHtml, INTERVIEW_ARCHIVE_PROMPT_VERSION } from './interview-archive-html';

export const MEETING_POSTPROCESS_PIPELINE_VERSION = 'v2';
const DEFAULT_EXECUTION_TIMEOUT_MS = 8 * 60_000;

export class MeetingPostprocessScheduler {
  private briefRunning = false;
  private briefRetryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private store: MeetingPostprocessStore,
    private generate: JsonGenerator,
    private now: () => Date = () => new Date(),
    private chunk_chars = DEFAULT_MEETING_CHUNK_CHARS,
    private execution_timeout_ms = DEFAULT_EXECUTION_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(execution_timeout_ms) || execution_timeout_ms <= 0) {
      throw new Error('postprocess_execution_timeout_invalid');
    }
  }

  async enqueue(snapshot: EvidenceSnapshot, kind: PostprocessRun['artifact_kind'] = 'meeting.summary_cards', options: { title?: string; select_current?: boolean } = {}): Promise<PostprocessRun> {
    if (kind === 'meeting.full_report') throw new Error('full_report_retired');
    if (kind === 'meeting.interview_archive_html' && snapshot.template_id !== 'interview_archive') throw new Error('interview_archive_template_required');
    if (options.select_current !== false) await this.store.selectCurrentSnapshot(snapshot, snapshot.snapshot_id);
    const now = this.now().toISOString();
    const prompt_version = kind === 'meeting.interview_archive_html' ? INTERVIEW_ARCHIVE_PROMPT_VERSION : MEETING_BRIEF_PROMPT_VERSION;
    const idempotency_key = runIdempotencyKey({ tenant_id: snapshot.tenant_id, user_id: snapshot.user_id, meeting_id: snapshot.meeting_id, occurrence_id: snapshot.occurrence_id, artifact_kind: kind, snapshot_fingerprint: snapshot.fingerprint, pipeline_version: `${MEETING_POSTPROCESS_PIPELINE_VERSION}:${prompt_version}` });
    return this.store.enqueue(postprocessRunSchema.parse({ ...snapshot, schema_version: POSTPROCESS_SCHEMA_VERSION, run_id: `run_${idempotency_key.slice(0, 24)}`, idempotency_key, artifact_kind: kind, meeting_title: options.title || snapshot.meeting_title, enqueue_full_report: false, snapshot_id: snapshot.snapshot_id, pipeline_version: MEETING_POSTPROCESS_PIPELINE_VERSION, status: 'queued', attempt: 0, priority: 100, available_at: now, created_at: now, updated_at: now }));
  }

  async drain(): Promise<number> {
    await this.store.recoverExpired(this.now());
    for (const legacy of this.store.listRuns().filter((run) => run.artifact_kind === 'meeting.full_report' && (run.status === 'queued' || run.status === 'running' || run.status === 'collecting_evidence'))) {
      await this.store.updateRun(legacy.run_id, { status: 'cancelled', error_code: 'full_report_retired', lease_expires_at: undefined });
    }
    return this.drainLane();
  }

  private async drainLane(): Promise<number> {
    if (this.briefRunning) return 0;
    this.briefRunning = true;
    let completed = 0;
    try {
      while (true) {
        const run = this.store.listRuns().filter((x) => x.artifact_kind !== 'meeting.full_report' && x.status === 'queued' && Date.parse(x.available_at) <= this.now().getTime()).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!run) break;
        await this.execute(run); completed += 1;
      }
      this.armRetry();
      return completed;
    } finally { this.briefRunning = false; }
  }

  private async execute(run: PostprocessRun): Promise<void> {
    const snapshot = this.store.getSnapshot(run.snapshot_id);
    if (!snapshot) { await this.store.updateRun(run.run_id, { status: 'failed', error_code: 'snapshot_not_found', attempt: run.attempt + 1 }, 'run.failed'); return; }
    if (!this.store.isCurrentSnapshot(run, run.snapshot_id)) { await this.store.updateRun(run.run_id, { status: 'superseded', lease_expires_at: undefined }, undefined); return; }
    const acquired = await this.store.updateRun(run.run_id, { status: 'running', attempt: run.attempt + 1, lease_expires_at: new Date(this.now().getTime() + 10 * 60_000).toISOString() }, 'run.started');
    if (acquired.status !== 'running') return;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('postprocess_provider_timeout')),
      this.execution_timeout_ms,
    );
    timeout.unref?.();
    const generate = abortableGenerator(this.generate, controller.signal);
    try {
      const stageStarted = Date.now();
      if (run.artifact_kind === 'meeting.interview_archive_html') {
        const archive = await generateInterviewArchiveHtml({ title: run.meeting_title, snapshot, generate });
        await this.saveArtifact(run, snapshot, 'meeting.interview_archive_html', archive, INTERVIEW_ARCHIVE_PROMPT_VERSION);
        await this.store.appendForCurrentRun(run.run_id, 'stage.metric', { stage: 'interview_archive_html', duration_ms: Math.max(0, Date.now() - stageStarted), artifact_bytes: Buffer.byteLength(archive.html, 'utf8') });
        await this.store.updateRun(run.run_id, { status: 'succeeded', lease_expires_at: undefined }, undefined);
        return;
      }
      const emitted = new Set<string>();
      const cards = await generateBriefV2({ title: run.meeting_title, snapshot, generate, chunk_chars: this.chunk_chars, getCached: (key) => this.store.getChunkExtraction(key), saveCached: (key, value) => this.store.saveChunkExtraction(key, run.occurrence_id, value), onItems: async (items) => {
        const fresh = items.filter(({ section, item }) => {
          const key = `${section}:${item.id}`;
          if (emitted.has(key)) return false;
          emitted.add(key);
          return true;
        });
        if (!fresh.length) return;
        await this.store.appendManyForCurrentRun(
          run.run_id,
          fresh.map(({ section, item }) => ({
            type: 'card.ready',
            data: { section, item_id: item.id, item },
          })),
        );
      } });
      const canonicalCards = (await this.saveArtifact(run, snapshot, 'meeting.summary_cards', cards, MEETING_BRIEF_PROMPT_VERSION)).content as MeetingSummaryCardsV2;
      await this.saveArtifact(run, snapshot, 'meeting.summary', renderMeetingSummary(canonicalCards), MEETING_BRIEF_PROMPT_VERSION);
      await this.store.appendForCurrentRun(run.run_id, 'stage.metric', { stage: 'brief', duration_ms: Math.max(0, Date.now() - stageStarted), artifact_bytes: Buffer.byteLength(JSON.stringify(canonicalCards), 'utf8') });
      await this.store.updateRun(run.run_id, { status: 'succeeded', lease_expires_at: undefined }, undefined);
    } catch (error) {
      if (!this.store.getRun(run.run_id)) return;
      if (String((error as Error)?.message || error) === 'postprocess_run_superseded') {
        const current = this.store.getRun(run.run_id);
        if (current) await this.store.updateRun(run.run_id, { status: 'superseded', lease_expires_at: undefined }, undefined);
        return;
      }
      if (this.store.getRun(run.run_id)?.status !== 'running') return;
      const attempt = run.attempt + 1; const retry = attempt < 3;
      await this.store.updateRun(run.run_id, { status: retry ? 'queued' : 'failed', attempt, available_at: new Date(this.now().getTime() + Math.min(60_000, 1000 * 2 ** attempt)).toISOString(), error_code: String((error as Error)?.message || error).slice(0, 160), lease_expires_at: undefined }, retry ? 'run.retrying' : 'run.failed');
      if (retry) this.armRetry();
    } finally {
      clearTimeout(timeout);
    }
  }

  private armRetry(): void {
    if (this.briefRetryTimer) clearTimeout(this.briefRetryTimer);
    const next = this.store.listRuns().filter((x) => x.artifact_kind !== 'meeting.full_report' && (x.status === 'queued' || x.status === 'running')).sort((a, b) => wakeAt(a).localeCompare(wakeAt(b)))[0];
    if (!next) return;
    this.briefRetryTimer = setTimeout(() => { this.briefRetryTimer = undefined; void this.drain(); }, Math.max(0, Date.parse(wakeAt(next)) - this.now().getTime()));
    this.briefRetryTimer?.unref?.();
  }

  private async saveArtifact(run: PostprocessRun, snapshot: EvidenceSnapshot, kind: PostprocessArtifact['kind'], content: unknown, prompt: string): Promise<PostprocessArtifact> {
    const created_at = this.now().toISOString();
    const revision = Math.max(0, ...this.store.listArtifacts(run).filter((x) => x.kind === kind).map((x) => x.revision)) + 1;
    return this.store.saveArtifact({ ...run, schema_version: POSTPROCESS_SCHEMA_VERSION, artifact_id: artifactId({ tenant_id: run.tenant_id, user_id: run.user_id, meeting_id: run.meeting_id, occurrence_id: run.occurrence_id, kind, snapshot_fingerprint: snapshot.fingerprint, pipeline_version: `${MEETING_POSTPROCESS_PIPELINE_VERSION}:${prompt}` }), kind, revision, snapshot_id: snapshot.snapshot_id, snapshot_fingerprint: snapshot.fingerprint, pipeline_version: MEETING_POSTPROCESS_PIPELINE_VERSION, prompt_version: prompt, finality: snapshot.finality, status: 'ready', content, created_at }, run.run_id);
  }
}

function wakeAt(run: PostprocessRun): string { return run.status === 'running' ? run.lease_expires_at || run.available_at : run.available_at; }

function abortableGenerator(generate: JsonGenerator, signal: AbortSignal): JsonGenerator {
  return async (input) => {
    if (signal.aborted) throw signal.reason;
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      generate({ ...input, signal }).then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  };
}
