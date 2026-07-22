import type {
  ClassroomEvidenceCheckpoint,
  InkLoopSourceRef,
  LessonGraph,
  RuntimeSchemaValidationIssue,
} from 'ink-surface-sdk/runtime-schema';

export type EducationAiJobKind = 'live_explanation' | 'class_summary' | 'practice';
export type EducationAiJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type EducationAiExecutionMode = 'real' | 'deterministic_fallback';
export type EducationAiReviewStatus = 'kept' | 'edited' | 'dismissed';

export interface EducationAiResultSection {
  section_id: string;
  content: string;
  source_refs: InkLoopSourceRef[];
}

export interface EducationAiJob {
  schema_version: 'inkloop.classroom.v1';
  job_id: string;
  classroom_id: string;
  kind: EducationAiJobKind;
  status: EducationAiJobStatus;
  evidence: ClassroomEvidenceCheckpoint;
  result?: {
    execution_mode: EducationAiExecutionMode;
    fallback_reason?: string;
    title: string;
    sections: EducationAiResultSection[];
    review_status: EducationAiReviewStatus;
    user_edit?: string;
    original_result?: { title: string; sections: EducationAiResultSection[] };
  };
  error_code?: string;
  attempt_count?: number;
  last_attempt_at?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  stale?: boolean;
}

export type TeacherLessonCandidateKind = LessonGraph['steps'][number]['kind'];
export type TeacherLessonReviewStatus = 'pending' | 'accepted' | 'edited' | 'dismissed';

export interface TeacherLessonCandidate {
  schema_version: 'inkloop.classroom.v1';
  candidate_id: string;
  classroom_id: string;
  generation_id: string;
  kind: TeacherLessonCandidateKind;
  order: number;
  content: string;
  latex?: string;
  confidence: number;
  source_refs: InkLoopSourceRef[];
  review_status: TeacherLessonReviewStatus;
  original_content?: string;
  reviewed_at?: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const issue = (issues: RuntimeSchemaValidationIssue[], path: string, message: string): void => { issues.push({ path, message }); };

function validateCheckpoint(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!record(value)) { issue(issues, path, 'must be an object'); return; }
  for (const key of ['checkpoint_id', 'classroom_id']) if (!nonEmpty(value[key])) issue(issues, `${path}.${key}`, 'must be a non-empty string');
  for (const key of ['sequence_start', 'sequence_end']) if (!Number.isInteger(value[key]) || Number(value[key]) < 1) issue(issues, `${path}.${key}`, 'must be a positive integer');
  for (const key of ['time_start_ms', 'time_end_ms']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) issue(issues, `${path}.${key}`, 'must be a finite number');
  if (Number(value.sequence_end) < Number(value.sequence_start)) issue(issues, `${path}.sequence_end`, 'must not precede sequence_start');
  if (Number(value.time_end_ms) < Number(value.time_start_ms)) issue(issues, `${path}.time_end_ms`, 'must not precede time_start_ms');
  if (!Array.isArray(value.source_refs) || value.source_refs.length === 0) issue(issues, `${path}.source_refs`, 'must contain source references');
}

export function validateEducationAiJob(value: unknown, path = 'job'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!record(value)) return [{ path, message: 'must be an object' }];
  for (const key of ['job_id', 'classroom_id', 'created_at', 'updated_at']) if (!nonEmpty(value[key])) issue(issues, `${path}.${key}`, 'must be a non-empty string');
  if (!['live_explanation', 'class_summary', 'practice'].includes(String(value.kind))) issue(issues, `${path}.kind`, 'must be a supported education job kind');
  if (!['queued', 'running', 'completed', 'failed'].includes(String(value.status))) issue(issues, `${path}.status`, 'must be a supported job status');
  validateCheckpoint(value.evidence, `${path}.evidence`, issues);
  if (value.status === 'completed') {
    if (!record(value.result)) issue(issues, `${path}.result`, 'must be present for completed jobs');
    else {
      if (!nonEmpty(value.result.title)) issue(issues, `${path}.result.title`, 'must be a non-empty string');
      if (!Array.isArray(value.result.sections) || value.result.sections.length === 0) issue(issues, `${path}.result.sections`, 'must contain source-bound sections');
      if (value.result.execution_mode === 'deterministic_fallback' && !nonEmpty(value.result.fallback_reason)) issue(issues, `${path}.result.fallback_reason`, 'must explain deterministic fallback');
      if (value.result.review_status === 'edited' && !record(value.result.original_result)) issue(issues, `${path}.result.original_result`, 'must preserve the original result when edited');
    }
  }
  return issues;
}

export function validateTeacherLessonCandidate(value: unknown, path = 'candidate'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!record(value)) return [{ path, message: 'must be an object' }];
  for (const key of ['candidate_id', 'classroom_id', 'generation_id', 'content']) if (!nonEmpty(value[key])) issue(issues, `${path}.${key}`, 'must be a non-empty string');
  if (!['definition', 'example', 'derivation', 'formula', 'diagram', 'conclusion'].includes(String(value.kind))) issue(issues, `${path}.kind`, 'must be a supported lesson step kind');
  if (!Number.isInteger(value.order) || Number(value.order) < 1) issue(issues, `${path}.order`, 'must be a positive integer');
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) issue(issues, `${path}.confidence`, 'must be between 0 and 1');
  if (!Array.isArray(value.source_refs) || value.source_refs.length === 0) issue(issues, `${path}.source_refs`, 'must contain source references');
  if (!['pending', 'accepted', 'edited', 'dismissed'].includes(String(value.review_status))) issue(issues, `${path}.review_status`, 'must be a supported review status');
  if (value.review_status === 'edited' && !nonEmpty(value.original_content)) issue(issues, `${path}.original_content`, 'must preserve the original content when edited');
  return issues;
}
