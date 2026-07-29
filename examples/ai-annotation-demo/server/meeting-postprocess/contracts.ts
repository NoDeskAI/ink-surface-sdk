import { z } from 'zod';
import { DEFAULT_MEETING_TEMPLATE_ID, MEETING_TEMPLATE_IDS, meetingTemplate } from './templates';

export const POSTPROCESS_SCHEMA_VERSION = 'inkloop.meeting-postprocess.v2' as const;

export const sourceRefSchema = z.object({
  kind: z.enum(['utterance', 'handwriting']),
  id: z.string().min(1).max(256),
  start_ms: z.number().int().nonnegative().optional(),
  end_ms: z.number().int().nonnegative().optional(),
});

export const meetingUtteranceSchema = z.object({
  id: z.string().min(1).max(256),
  speaker_id: z.string().max(160).nullable().default(null),
  speaker_name: z.string().max(160).nullable().default(null),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(32_000),
  source: z.enum(['google', 'zoom', 'feishu', 'local']).default('local'),
  source_revision: z.string().min(1).max(256).default('0'),
  confidence: z.number().min(0).max(1).optional(),
  revision: z.number().int().nonnegative().default(0),
});

export const handwritingEvidenceSchema = z.object({
  id: z.string().min(1).max(256),
  mark_id: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(4_000),
  page_id: z.string().max(256).default(''),
  relative_time_ms: z.number().int().nullable().default(null),
  text_source: z.enum(['manual', 'ocr']).default('ocr'),
  kind: z.enum(['fact', 'personal_thought', 'question', 'todo', 'hypothesis', 'emphasis']).default('personal_thought'),
  mark_ids: z.array(z.string().max(256)).max(500).default([]),
  revision: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  corrected_by_user: z.boolean().default(false),
});

const scopeSchema = z.object({
  tenant_id: z.string().min(1).max(160),
  user_id: z.string().min(1).max(160),
  meeting_id: z.string().min(1).max(256),
  occurrence_id: z.string().min(1).max(256),
});

export const meetingUserGuidanceSchema = z.object({
  source: z.literal('user_supplied').default('user_supplied'),
  conclusions: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  deepest_impressions: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  pain_points: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
}).strict().default({ source: 'user_supplied', conclusions: [], deepest_impressions: [], pain_points: [] });

export const postprocessConfigurationSchema = scopeSchema.extend({
  schema_version: z.literal(POSTPROCESS_SCHEMA_VERSION),
  configuration_id: z.string().min(1),
  revision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  template_id: z.enum(MEETING_TEMPLATE_IDS),
  template_version: z.string().min(1).max(80),
  user_guidance: meetingUserGuidanceSchema,
  submitted_at: z.string().datetime(),
});

export const evidenceSnapshotSchema = scopeSchema.extend({
  schema_version: z.literal(POSTPROCESS_SCHEMA_VERSION),
  snapshot_id: z.string().min(1),
  meeting_title: z.string().trim().min(1).max(300),
  revision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  finality: z.enum(['provisional', 'final']),
  transcript_converged: z.boolean().default(false),
  template_id: z.enum(MEETING_TEMPLATE_IDS).default(DEFAULT_MEETING_TEMPLATE_ID),
  template_version: z.string().min(1).max(80).default(meetingTemplate().version),
  user_guidance: meetingUserGuidanceSchema,
  missing_reasons: z.array(z.enum(['transcript_pending', 'transcript_partial', 'ocr_pending', 'ocr_failed'])).default([]),
  missing_chunk_ids: z.array(z.string().min(1).max(256)).max(10_000).default([]),
  started_at_ms: z.number().int().nullable().default(null),
  ended_at_ms: z.number().int().nullable().default(null),
  utterances: z.array(meetingUtteranceSchema),
  handwriting: z.array(handwritingEvidenceSchema),
  created_at: z.string().datetime(),
});

const evidenceRefsSchema = z.array(z.string().min(1).max(256)).min(1).max(32);
export const keyPointSchema = z.object({ id: z.string().min(1).max(256), text: z.string().trim().min(1).max(4_000), evidence_refs: evidenceRefsSchema }).strict();
export const decisionSchema = z.object({ id: z.string().min(1).max(256), text: z.string().trim().min(1).max(4_000), status: z.enum(['confirmed', 'tentative']), evidence_refs: evidenceRefsSchema }).strict();
export const actionItemSchema = z.object({ id: z.string().min(1).max(256), task: z.string().trim().min(1).max(4_000), owner: z.string().trim().min(1).max(160).nullable().default(null), due_at: z.string().trim().min(1).max(160).nullable().default(null), commitment: z.enum(['explicit', 'proposed']), evidence_refs: evidenceRefsSchema }).strict();
export const highlightSchema = keyPointSchema;
export const riskSchema = z.object({ id: z.string().min(1).max(256), text: z.string().trim().min(1).max(4_000), mitigation: z.string().trim().min(1).max(4_000).nullable().default(null), evidence_refs: evidenceRefsSchema }).strict();
export const openQuestionSchema = keyPointSchema;
export const personalNoteSchema = z.object({ id: z.string().min(1).max(256), text: z.string().trim().min(1).max(4_000), kind: z.enum(['thought', 'question', 'todo', 'emphasis']), mark_refs: z.array(z.string().min(1).max(256)).min(1).max(32), supporting_utterance_refs: z.array(z.string().min(1).max(256)).max(32) }).strict();

export const meetingTemplateSectionItemSchema = z.object({
  id: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(4_000),
  label: z.string().trim().min(1).max(160).nullable().default(null),
  speaker: z.string().trim().min(1).max(160).nullable().default(null),
  evidence_refs: evidenceRefsSchema,
}).strict();

/** Additive template-owned presentation data. Legacy cards without it remain readable. */
export const meetingTemplateSectionSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(2_000).nullable().default(null),
  items: z.array(meetingTemplateSectionItemSchema).max(12).default([]),
}).strict();

export const meetingSectionTitlesSchema = z.object({
  background: z.string().trim().min(1).max(40).default('背景与概览'),
  discussion: z.string().trim().min(1).max(40).default('关键讨论要点'),
  next_steps: z.string().trim().min(1).max(40).default('后续步骤与提醒'),
}).strict().default({ background: '背景与概览', discussion: '关键讨论要点', next_steps: '后续步骤与提醒' });

export const meetingMetadataSchema = z.object({
  started_at: z.string().datetime().nullable().default(null),
  duration_ms: z.number().int().nonnegative().nullable().default(null),
  participants: z.array(z.string().trim().min(1).max(160)).max(200).default([]),
}).strict().default({ started_at: null, duration_ms: null, participants: [] });

export const meetingSummaryExtractionSchema = z.object({
  theme: z.string().trim().max(300).default(''),
  overview: z.string().trim().max(2_000).default(''),
  section_titles: meetingSectionTitlesSchema,
  key_points: z.array(keyPointSchema).max(30).default([]),
  decisions: z.array(decisionSchema).max(30).default([]),
  action_items: z.array(actionItemSchema).max(50).default([]),
  highlights: z.array(highlightSchema).max(30).default([]),
  risks: z.array(riskSchema).max(30).default([]),
  open_questions: z.array(openQuestionSchema).max(30).default([]),
  personal_notes: z.array(personalNoteSchema).max(50).default([]),
  template_sections: z.array(meetingTemplateSectionSchema).max(16).default([]),
}).strict();

export const meetingSummaryCardsV2Schema = meetingSummaryExtractionSchema.extend({
  schema_version: z.literal('2.0'),
  template_id: z.enum(MEETING_TEMPLATE_IDS).default(DEFAULT_MEETING_TEMPLATE_ID),
  template_version: z.string().min(1).max(80).default(meetingTemplate().version),
  meeting_metadata: meetingMetadataSchema,
  artifact_state: z.enum(['provisional', 'final', 'partial']),
  coverage: z.object({
    utterances: z.enum(['complete', 'partial']),
    handwriting_ocr: z.enum(['complete', 'partial', 'failed']),
    started_at_ms: z.number().int().nullable(),
    ended_at_ms: z.number().int().nullable(),
  }).strict(),
}).strict();

export const meetingMindMapNodeSchema = z.object({
  id: z.string().min(1).max(256),
  parent_id: z.string().min(1).max(256).nullable(),
  kind: z.enum(['root', 'section', 'point', 'decision', 'action', 'risk', 'question', 'note']),
  label: z.string().trim().min(1).max(4_000),
  evidence_refs: z.array(z.string().min(1).max(256)).max(32),
}).strict();

export const meetingMindMapV1Schema = z.object({
  schema_version: z.literal('1.0'),
  source: z.literal('meeting.summary_cards'),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(meetingMindMapNodeSchema).min(1).max(500),
}).strict();

export const postprocessArtifactSchema = scopeSchema.extend({
  schema_version: z.literal(POSTPROCESS_SCHEMA_VERSION),
  artifact_id: z.string().min(1),
  // mind_map/full_report remain parseable only so historical stores can be read and retired safely.
  kind: z.enum(['meeting.summary_cards', 'meeting.summary', 'meeting.interview_archive_html', 'meeting.mind_map', 'meeting.full_report']),
  revision: z.number().int().positive(),
  snapshot_id: z.string().min(1),
  snapshot_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pipeline_version: z.string().min(1).max(80),
  prompt_version: z.string().min(1).max(80),
  finality: z.enum(['provisional', 'final']),
  status: z.enum(['ready', 'failed', 'superseded']),
  content: z.unknown(),
  error_code: z.string().max(160).optional(),
  created_at: z.string().datetime(),
});

/** @deprecated Historical read compatibility only. New postprocess runs never generate this artifact. */
export const meetingFullReportV2Schema = z.object({
  schema_version: z.literal('2.0'),
  status: z.enum(['queued', 'generating', 'completed', 'failed', 'stale']),
  markdown: z.string().nullable(),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_version: z.string().min(1).max(80),
  generated_at: z.string().datetime().nullable(),
}).strict();

export const postprocessRunSchema = scopeSchema.extend({
  schema_version: z.literal(POSTPROCESS_SCHEMA_VERSION),
  run_id: z.string().min(1),
  idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
  // full_report remains in the enum so startup can parse and cancel legacy queued/running runs.
  artifact_kind: z.enum(['meeting.summary_cards', 'meeting.interview_archive_html', 'meeting.full_report']),
  meeting_title: z.string().trim().min(1).max(300).default('(未命名会议)'),
  /** @deprecated Historical read compatibility only; new values are always false. */
  enqueue_full_report: z.boolean().default(false),
  snapshot_id: z.string().min(1),
  pipeline_version: z.string().min(1).max(80),
  status: z.enum(['queued', 'collecting_evidence', 'running', 'succeeded', 'failed', 'cancelled', 'superseded']),
  attempt: z.number().int().nonnegative(),
  priority: z.number().int(),
  available_at: z.string().datetime(),
  lease_expires_at: z.string().datetime().optional(),
  error_code: z.string().max(160).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const postprocessEventSchema = scopeSchema.extend({
  schema_version: z.literal(POSTPROCESS_SCHEMA_VERSION),
  event_id: z.number().int().positive(),
  type: z.enum(['run.queued', 'run.collecting_evidence', 'run.started', 'run.retrying', 'run.failed', 'card.ready', 'artifact.ready', 'artifact.superseded', 'ocr.progress', 'stage.metric']),
  run_id: z.string().optional(),
  artifact_id: z.string().optional(),
  data: z.record(z.unknown()).default({}),
  created_at: z.string().datetime(),
});

export type MeetingUtterance = z.infer<typeof meetingUtteranceSchema>;
export type HandwritingEvidence = z.infer<typeof handwritingEvidenceSchema>;
export type MeetingUserGuidance = z.infer<typeof meetingUserGuidanceSchema>;
export type PostprocessConfiguration = z.infer<typeof postprocessConfigurationSchema>;
export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;
export type MeetingSummaryExtraction = z.infer<typeof meetingSummaryExtractionSchema>;
export type MeetingSummaryCardsV2 = z.infer<typeof meetingSummaryCardsV2Schema>;
export type MeetingMindMapV1 = z.infer<typeof meetingMindMapV1Schema>;
export type MeetingFullReportV2 = z.infer<typeof meetingFullReportV2Schema>;
export type PostprocessArtifact = z.infer<typeof postprocessArtifactSchema>;
export type PostprocessRun = z.infer<typeof postprocessRunSchema>;
export type PostprocessEvent = z.infer<typeof postprocessEventSchema>;
