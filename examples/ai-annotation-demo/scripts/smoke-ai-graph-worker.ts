/**
 * Local AI Graph worker smoke.
 *
 * This is a production-shape local worker harness for the Kickstarter V1
 * LessonGraph / MeetingGraph path. It validates queued AiGraphJob records,
 * exercises retry/attempt telemetry, completes teach and meeting jobs, rejects
 * an evidence-less job, and writes a stable observability report under
 * test-results/.
 *
 * Usage:
 *   npm run smoke:ai-graph-worker
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AI_GRAPH_JOB_SCHEMA_VERSION,
  INKLOOP_AI_PEN_CONTRACT_VERSION,
  validateAiGraphJob,
  type AiGraphJob,
  type BoardObject,
  type InkEvent,
  type InkLoopSourceRef,
  type LessonGraph,
  type MeetingGraph,
  type RuntimeSchemaValidationIssue,
} from 'ink-surface-sdk/runtime-schema';

type WorkerStatus = 'completed' | 'retry_scheduled' | 'rejected';

interface AttemptRecord {
  job_id: string;
  attempt: number;
  status: WorkerStatus;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  error?: string;
  retry_after_ms?: number;
  validator_issue_count: number;
}

interface WorkerReport {
  schema: 'inkloop.ai_graph_worker_smoke.v1';
  ok: boolean;
  generated_at: string;
  output_dir: string;
  max_attempts: number;
  summary: {
    queued_jobs: number;
    completed_jobs: number;
    rejected_jobs: number;
    retried_jobs: number;
    attempt_count: number;
    lesson_jobs_completed: number;
    meeting_jobs_completed: number;
  };
  completed_job_ids: string[];
  rejected_job_ids: string[];
  attempts: AttemptRecord[];
  failures: string[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function now(): string {
  return new Date().toISOString();
}

function inkRef(event: InkEvent): InkLoopSourceRef {
  return {
    type: 'ink_event',
    session_id: event.session_id,
    event_id: event.event_id,
    ts_start_ms: event.ts_start_ms,
    ts_end_ms: event.ts_end_ms,
    bbox_norm: event.bbox_norm,
  };
}

function objectRef(object: BoardObject): InkLoopSourceRef {
  return {
    type: 'board_object',
    session_id: object.session_id,
    object_id: object.object_id,
    object_type: object.type,
    bbox_norm: object.bbox_norm,
  };
}

function event(id: string, sessionId: string, mode: 'teach' | 'meeting', startMs: number): InkEvent {
  return {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    event_id: id,
    trace_id: `trace_${id}`,
    session_id: sessionId,
    surface_id: 'surface_a2_worker_smoke',
    pen_id: 'pen_worker_smoke',
    event_type: 'stroke',
    stroke_refs: [`stroke_${id}`],
    bbox_norm: [0.1 + startMs / 10_000, 0.2, 0.24, 0.08],
    ts_start_ms: startMs,
    ts_end_ms: startMs + 180,
    source: { device: 'ai_pen', localization: 'encoded_surface', confidence: 0.91 },
    metadata: { mode, tool: 'pen' },
  };
}

function boardObject(
  id: string,
  sessionId: string,
  type: BoardObject['type'],
  strokeRef: string,
  text: string,
  x = 0.2,
): BoardObject {
  return {
    object_id: id,
    session_id: sessionId,
    surface_id: 'surface_a2_worker_smoke',
    type,
    bbox_norm: [x, 0.3, 0.22, 0.08],
    stroke_refs: [strokeRef],
    hmp_refs: [`hmp_${id}`],
    text_candidate: text,
    normalized_text: text.toLowerCase(),
    confidence: 0.82,
    created_at_ms: 100,
    updated_at_ms: 280,
  };
}

function queuedJob(input: Omit<AiGraphJob, 'schema_version' | 'status' | 'created_at' | 'updated_at'>): AiGraphJob {
  const timestamp = now();
  return {
    ...input,
    schema_version: AI_GRAPH_JOB_SCHEMA_VERSION,
    status: 'queued',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function sampleJobs(): AiGraphJob[] {
  const teachEvent = event('evt_worker_formula', 'sess_worker_teach', 'teach', 100);
  const meetingEvent = event('evt_worker_decision', 'sess_worker_meeting', 'meeting', 200);
  const retryEvent = event('evt_worker_retry_decision', 'sess_worker_retry_meeting', 'meeting', 300);
  return [
    queuedJob({
      job_id: 'job_worker_teach_1',
      session_id: 'sess_worker_teach',
      surface_id: 'surface_a2_worker_smoke',
      mode: 'teach',
      input: {
        ink_events: [teachEvent],
        board_objects: [
          boardObject('obj_worker_formula', 'sess_worker_teach', 'formula', 'stroke_evt_worker_formula', 'x^2 + 2x + 1'),
        ],
      },
    }),
    queuedJob({
      job_id: 'job_worker_meeting_retry',
      session_id: 'sess_worker_retry_meeting',
      surface_id: 'surface_a2_worker_smoke',
      mode: 'meeting',
      input: {
        ink_events: [retryEvent],
        board_objects: [
          boardObject('obj_worker_node', 'sess_worker_retry_meeting', 'diagram_node', 'stroke_evt_worker_retry_decision', 'Host', 0.16),
          boardObject('obj_worker_arrow', 'sess_worker_retry_meeting', 'arrow', 'stroke_evt_worker_retry_decision', 'sync', 0.42),
          boardObject('obj_worker_action', 'sess_worker_retry_meeting', 'action_item', 'stroke_evt_worker_retry_decision', 'Lock schema', 0.2),
          boardObject('obj_worker_risk', 'sess_worker_retry_meeting', 'risk', 'stroke_evt_worker_retry_decision', 'Surface glare', 0.62),
        ],
        optional_context: {
          transcript_ref: 'transcript_worker_retry',
          audio_segment_refs: [{
            type: 'audio_segment',
            session_id: 'sess_worker_retry_meeting',
            start_ms: 900,
            end_ms: 1800,
            speaker: 'Founder',
            transcript_ref: 'transcript_worker_retry',
          }],
        },
      },
    }),
    queuedJob({
      job_id: 'job_worker_meeting_1',
      session_id: 'sess_worker_meeting',
      surface_id: 'surface_a2_worker_smoke',
      mode: 'meeting',
      input: {
        ink_events: [meetingEvent],
        board_objects: [
          boardObject('obj_worker_meeting_node', 'sess_worker_meeting', 'diagram_node', 'stroke_evt_worker_decision', 'Ledger', 0.15),
          boardObject('obj_worker_meeting_arrow', 'sess_worker_meeting', 'arrow', 'stroke_evt_worker_decision', 'feeds', 0.4),
          boardObject('obj_worker_meeting_action', 'sess_worker_meeting', 'action_item', 'stroke_evt_worker_decision', 'Prepare reviewer CSV', 0.2),
        ],
      },
    }),
    queuedJob({
      job_id: 'job_worker_audio_only_reject',
      session_id: 'sess_worker_audio_only',
      surface_id: 'surface_a2_worker_smoke',
      mode: 'meeting',
      input: {
        ink_events: [],
        board_objects: [],
        optional_context: {
          audio_segment_refs: [{
            type: 'audio_segment',
            session_id: 'sess_worker_audio_only',
            start_ms: 0,
            end_ms: 1200,
            speaker: 'Founder',
          }],
        },
      },
    }),
  ];
}

function completeTeachJob(job: AiGraphJob): LessonGraph {
  const inkRefs = job.input.ink_events.map(inkRef);
  const formulaObject = job.input.board_objects.find((object) => object.type === 'formula');
  const formulaRefs = formulaObject ? [objectRef(formulaObject)] : inkRefs.slice(0, 1);
  return {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    lesson_id: `lesson_${job.job_id}`,
    session_id: job.session_id,
    title: 'Worker generated lesson note',
    steps: [{
      step_id: `step_${job.job_id}`,
      order: 1,
      kind: 'formula',
      content: 'Worker converted retained board evidence into a reviewable formula step.',
      latex: '(x + 1)^2',
      board_object_refs: formulaObject ? [formulaObject.object_id] : [],
      source_refs: formulaRefs,
      confidence: 0.79,
    }],
    concepts: [{
      concept_id: `concept_${job.job_id}`,
      name: 'Completing the square',
      explanation: 'Generated only from retained ink or board evidence.',
      source_refs: inkRefs.slice(0, 1),
    }],
  };
}

function completeMeetingJob(job: AiGraphJob): MeetingGraph {
  const inkRefs = job.input.ink_events.map(inkRef);
  const action = job.input.board_objects.find((object) => object.type === 'action_item');
  const risk = job.input.board_objects.find((object) => object.type === 'risk');
  const diagramRefs = job.input.board_objects
    .filter((object) => ['diagram_node', 'arrow', 'shape'].includes(object.type))
    .slice(0, 3)
    .map(objectRef);
  return {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    meeting_id: `meeting_${job.job_id}`,
    session_id: job.session_id,
    title: 'Worker generated meeting graph',
    decisions: [{
      decision_id: `decision_${job.job_id}`,
      content: 'Use the event ledger as the source of truth.',
      source_refs: inkRefs.slice(0, 1),
      confidence: 0.84,
    }],
    actions: [{
      action_id: `action_${job.job_id}`,
      content: 'Keep worker outputs candidate-only until user review.',
      owner: 'Runtime',
      status: 'candidate',
      source_refs: action ? [objectRef(action)] : inkRefs.slice(0, 1),
      confidence: 0.81,
    }],
    risks: [{
      risk_id: `risk_${job.job_id}`,
      content: 'Hosted worker deployment is still separate from this local smoke.',
      severity: 'medium',
      source_refs: risk ? [objectRef(risk)] : inkRefs.slice(0, 1),
      confidence: 0.72,
    }],
    diagrams: [{
      diagram_id: `diagram_${job.job_id}`,
      type: 'architecture',
      mermaid: 'flowchart LR\n  CaptureHost --> Worker\n  Worker --> ReviewGate',
      source_refs: diagramRefs.length >= 2 ? diagramRefs : [...diagramRefs, ...inkRefs].slice(0, 2),
      confidence: 0.76,
    }],
  };
}

function issueText(issues: RuntimeSchemaValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

async function processJob(
  job: AiGraphJob,
  attempts: AttemptRecord[],
  maxAttempts: number,
): Promise<{ completed?: AiGraphJob; rejected?: { job: AiGraphJob; issues: RuntimeSchemaValidationIssue[] } }> {
  const queuedIssues = validateAiGraphJob(job);
  if (queuedIssues.length > 0) {
    const timestamp = now();
    attempts.push({
      job_id: job.job_id,
      attempt: 1,
      status: 'rejected',
      started_at: timestamp,
      completed_at: timestamp,
      duration_ms: 0,
      error: issueText(queuedIssues).join('; '),
      validator_issue_count: queuedIssues.length,
    });
    return { rejected: { job, issues: queuedIssues } };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = now();
    if (job.job_id === 'job_worker_meeting_retry' && attempt === 1) {
      const completedAt = now();
      attempts.push({
        job_id: job.job_id,
        attempt,
        status: 'retry_scheduled',
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: 0,
        error: 'transient_model_timeout',
        retry_after_ms: 250,
        validator_issue_count: 0,
      });
      continue;
    }

    const output = job.mode === 'teach'
      ? { lesson_graph: completeTeachJob(job) }
      : { meeting_graph: completeMeetingJob(job) };
    const timestamp = now();
    const completed: AiGraphJob = {
      ...job,
      status: 'completed',
      output,
      updated_at: timestamp,
      completed_at: timestamp,
    };
    const completedIssues = validateAiGraphJob(completed);
    const completedAt = now();
    attempts.push({
      job_id: job.job_id,
      attempt,
      status: completedIssues.length === 0 ? 'completed' : 'rejected',
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      error: completedIssues.length > 0 ? issueText(completedIssues).join('; ') : undefined,
      validator_issue_count: completedIssues.length,
    });
    if (completedIssues.length === 0) return { completed };
    return { rejected: { job: completed, issues: completedIssues } };
  }

  const timeoutIssue = [{ path: 'worker', message: `exhausted ${maxAttempts} attempts` }];
  return { rejected: { job, issues: timeoutIssue } };
}

function toJsonl(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');
}

async function main(): Promise<void> {
  const root = resolve(process.cwd(), '../..');
  const outputDir = join(root, 'test-results/ai-graph-worker-smoke');
  const reportPath = join(outputDir, 'worker-report.json');
  const completedPath = join(outputDir, 'jobs.completed.jsonl');
  const rejectedPath = join(outputDir, 'jobs.rejected.jsonl');
  const readmePath = join(outputDir, 'README.md');
  const maxAttempts = 2;
  const jobs = sampleJobs();
  const attempts: AttemptRecord[] = [];
  const completedJobs: AiGraphJob[] = [];
  const rejectedJobs: Array<{ job: AiGraphJob; issues: RuntimeSchemaValidationIssue[] }> = [];

  for (const job of jobs) {
    const result = await processJob(job, attempts, maxAttempts);
    if (result.completed) completedJobs.push(result.completed);
    if (result.rejected) rejectedJobs.push(result.rejected);
  }

  const retriedJobIds = new Set(attempts.filter((attempt) => attempt.status === 'retry_scheduled').map((attempt) => attempt.job_id));
  const failures: string[] = [];
  if (completedJobs.length !== 3) failures.push(`expected 3 completed jobs, got ${completedJobs.length}`);
  if (rejectedJobs.length !== 1) failures.push(`expected 1 rejected job, got ${rejectedJobs.length}`);
  if (!retriedJobIds.has('job_worker_meeting_retry')) failures.push('retry path was not exercised');
  if (!rejectedJobs.some((item) => item.job.job_id === 'job_worker_audio_only_reject')) failures.push('audio-only job was not rejected');

  const report: WorkerReport = {
    schema: 'inkloop.ai_graph_worker_smoke.v1',
    ok: failures.length === 0,
    generated_at: now(),
    output_dir: outputDir,
    max_attempts: maxAttempts,
    summary: {
      queued_jobs: jobs.length,
      completed_jobs: completedJobs.length,
      rejected_jobs: rejectedJobs.length,
      retried_jobs: retriedJobIds.size,
      attempt_count: attempts.length,
      lesson_jobs_completed: completedJobs.filter((job) => job.mode === 'teach').length,
      meeting_jobs_completed: completedJobs.filter((job) => job.mode === 'meeting').length,
    },
    completed_job_ids: completedJobs.map((job) => job.job_id),
    rejected_job_ids: rejectedJobs.map((item) => item.job.job_id),
    attempts,
    failures,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(completedPath, toJsonl(completedJobs));
  await writeFile(rejectedPath, toJsonl(rejectedJobs.map((item) => ({
    job_id: item.job.job_id,
    issues: item.issues,
  }))));
  await writeFile(readmePath, `# AI Graph Worker Smoke

Generated at: ${report.generated_at}

Status: ${report.ok ? 'ok' : 'failed'}

This local worker smoke validates queued \`AiGraphJob\` records, completes LessonGraph and MeetingGraph jobs, exercises retry telemetry, and rejects an audio-only meeting job before it can enter KnowledgeObject review.

## Summary

| Metric | Value |
| --- | ---: |
| Queued jobs | ${report.summary.queued_jobs} |
| Completed jobs | ${report.summary.completed_jobs} |
| Rejected jobs | ${report.summary.rejected_jobs} |
| Retried jobs | ${report.summary.retried_jobs} |
| Attempts | ${report.summary.attempt_count} |

## Artifacts

- [worker-report.json](./worker-report.json)
- [jobs.completed.jsonl](./jobs.completed.jsonl)
- [jobs.rejected.jsonl](./jobs.rejected.jsonl)

## Boundary

This proves the local worker contract, retry path, and validator boundary. It does not prove hosted cloud deployment, auth, production observability, or real-session load.
`);

  assert(report.ok, `AI graph worker smoke failed: ${failures.join('; ')}`);
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
