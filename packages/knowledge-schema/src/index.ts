import {
  validateInkLoopSourceRefs,
  type InkLoopSourceRef,
  type LessonGraph,
  type MeetingGraph,
} from 'ink-surface-sdk/runtime-schema';

export type ISODateTime = string;
export type Sha256 = `sha256:${string}`;
export type NormBBox = [number, number, number, number];

export type KnowledgeKind =
  | 'source_document'
  | 'reading_note'
  | 'highlight'
  | 'excerpt'
  | 'annotation'
  | 'ai_note'
  | 'qa'
  | 'summary'
  | 'task'
  | 'decision'
  | 'risk'
  | 'lesson_note'
  | 'formula_step'
  | 'meeting_action'
  | 'meeting_decision'
  | 'meeting_risk'
  | 'diagram'
  | 'concept';

export type KnowledgeStatus =
  | 'inbox'
  | 'accepted'
  | 'edited'
  | 'follow_up'
  | 'dismissed'
  | 'export_ready'
  | 'exported'
  | 'archived';

export type Privacy = 'local_only' | 'export_allowed';
export type MarkdownCallout = 'note' | 'quote' | 'question' | 'todo' | 'summary' | 'tip' | 'warning';
export type KnowledgeRiskStatus = 'open' | 'watching' | 'mitigated' | 'closed';

export const KO_SCHEMA_VERSION = 'inkloop.knowledge_object.v1' as const;
export const KNOWLEDGE_EXPORT_SCHEMA_VERSION = 'inkloop.knowledge_export.v1' as const;
export const DOCUMENT_PROJECTION_SCHEMA_VERSION = 'inkloop.document_projection.v1' as const;
export const DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION = 'inkloop.document_projection.export.v1' as const;
export const MEETING_SESSION_SCHEMA_VERSION = 'inkloop.meeting_session.v1' as const;
export const MEETING_EVENT_MARK_SCHEMA_VERSION = 'inkloop.meeting_event_mark.v1' as const;
export const SCHEMA_ALIGNED_EVENT_SCHEMA_VERSION = 'inkloop.schema_aligned_event.v1' as const;
export const POST_PROCESS_CONTEXT_SCHEMA_VERSION = 'inkloop.post_process_context.v1' as const;
export const POST_PROCESS_RESULT_SCHEMA_VERSION = 'inkloop.post_process_result.v1' as const;

export type MeetingAxisSource =
  | 'lark_direct_event'
  | 'lark_join_event'
  | 'lark_passive_meeting_scan'
  | 'lark_tenant_passive_meeting_scan'
  | 'open_meeting_session'
  | 'annotation_fallback';

export type MeetingMarkKind =
  | 'question'
  | 'risk'
  | 'action'
  | 'decision'
  | 'attention'
  | 'note';

export type MeetingEventType =
  | 'meeting.question_mark'
  | 'meeting.risk_mark'
  | 'meeting.action_mark'
  | 'meeting.decision_mark'
  | 'meeting.attention_mark'
  | 'meeting.note_mark';

export type PostProcessResultType =
  | 'task'
  | 'decision'
  | 'risk'
  | 'question'
  | 'knowledge_note';

export interface MeetingSession {
  schema_version: typeof MEETING_SESSION_SCHEMA_VERSION;
  meeting_id: string;
  platform: 'feishu' | 'lark';
  title?: string;
  meeting_url?: string;
  start_time: ISODateTime;
  end_time?: ISODateTime;
  source: MeetingAxisSource;
  source_event_id?: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface MeetingEventMark {
  schema_version: typeof MEETING_EVENT_MARK_SCHEMA_VERSION;
  id: string;
  trace_id: string;
  meeting_id: string;
  time_ms: number;
  captured_at_ms: number;
  source: string;
  kind: MeetingMarkKind;
  label: string;
  intent: MeetingMarkKind;
  payload: {
    text?: string;
    mark?: {
      action?: 'underline' | 'enclosure' | 'arrow' | 'freehand' | 'highlight';
      target_text?: string;
    };
    device_id?: string;
    raw_event_id?: string;
  };
  idempotency_key: string;
  created_at: ISODateTime;
}

export interface DocumentSchemaRef {
  ref_type: 'document';
  document_id: string;
  page_id: string;
  page_index?: number;
  event_id?: string;
  trace_id?: string;
  hmp_id?: string;
  inference_view_id?: string;
  bbox?: NormBBox;
  object_refs: string[];
  quote?: string;
  confidence: number;
}

export interface MeetingSourceRef {
  ref_type: 'meeting_mark';
  meeting_id: string;
  meeting_mark_id: string;
  time_ms: number;
  captured_at_ms: number;
  kind: MeetingMarkKind;
  source: string;
}

export interface ProjectMemoryRef {
  ref_type: 'project_memory';
  memory_id: string;
  kind: 'goal' | 'milestone' | 'decision' | 'risk' | 'task' | 'knowledge_object';
  title: string;
  source_uri?: string;
}

export type MeetingContractSourceRef = DocumentSchemaRef | MeetingSourceRef | ProjectMemoryRef;

export interface SchemaAlignedEvent {
  schema_version: typeof SCHEMA_ALIGNED_EVENT_SCHEMA_VERSION;
  trace_id: string;
  event_id: string;
  meeting_id: string;
  meeting_mark_id: string;
  time_ms: number;
  event_type: MeetingEventType;
  schema_refs: DocumentSchemaRef[];
  source_refs: MeetingContractSourceRef[];
  alignment_status: 'aligned' | 'needs_repair' | 'dropped';
  failure_reason?: 'no_active_document' | 'stale_document' | 'unresolved_bbox' | 'invalid_mark' | 'permission_denied';
  payload: Record<string, unknown>;
  created_at: ISODateTime;
}

export interface PostProcessContext {
  schema_version: typeof POST_PROCESS_CONTEXT_SCHEMA_VERSION;
  trace_id: string;
  aligned_events: SchemaAlignedEvent[];
  document_refs: DocumentSchemaRef[];
  meeting_marks: MeetingSourceRef[];
  project_memory_refs: ProjectMemoryRef[];
  user_feedback?: 'accepted' | 'edited' | 'dismissed' | 'follow_up';
  created_at: ISODateTime;
}

export interface PostProcessResult {
  schema_version: typeof POST_PROCESS_RESULT_SCHEMA_VERSION;
  result_id: string;
  trace_id: string;
  result_type: PostProcessResultType;
  title: string;
  content_md: string;
  source_refs: MeetingContractSourceRef[];
  confidence: number;
  status: 'candidate' | 'accepted' | 'edited' | 'dismissed';
  created_at: ISODateTime;
}

export interface MeetingContractValidationIssue {
  path: string;
  message: string;
}

export interface KnowledgeObject {
  schema_version: typeof KO_SCHEMA_VERSION;
  ko_id: string;
  kind: KnowledgeKind;
  title: string;
  body_md: string;
  source: {
    document_id: string;
    document_title: string;
    page_id?: string;
    page_index?: number;
    object_refs: string[];
    anchor_bbox?: NormBBox;
    quote?: string;
    inkloop_uri: string;
  };
  provenance: {
    created_from: 'mark' | 'ai_turn' | 'session' | 'manual';
    mark_ids?: string[];
    ai_turn_ids?: string[];
  };
  source_refs?: Array<InkLoopSourceRef | MeetingContractSourceRef>;
  tags: string[];
  status: KnowledgeStatus;
  controlled_fields?: {
    task_done?: boolean;
    risk_status?: KnowledgeRiskStatus;
    risk_note?: string;
    comment_md?: string;
  };
  privacy: Privacy;
  render_hints?: {
    markdown_callout?: MarkdownCallout;
  };
  content_hash: Sha256;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface AiGraphKnowledgeProjectionOptions {
  documentId: string;
  documentTitle: string;
  now?: ISODateTime;
  statusById: Partial<Record<string, KnowledgeStatus>>;
  titleOverridesById?: Partial<Record<string, string>>;
  bodyOverridesById?: Partial<Record<string, string>>;
}

export interface KnowledgeObjectExportEnvelope {
  schema_version: typeof KNOWLEDGE_EXPORT_SCHEMA_VERSION | string;
  export_id: string;
  generated_at: ISODateTime;
  source: {
    app: string;
    app_version: string;
    document_id?: string;
  };
  objects: KnowledgeObject[];
}

export interface DocumentProjectionBlock {
  block_id: string;
  kind: 'heading' | 'paragraph' | 'list' | string;
  heading_level?: number;
  text_md: string;
  region: 'editable' | 'generated' | string;
  source: {
    page_id: string;
    page_index: number;
    object_refs: string[];
    source_range?: {
      start: number;
      end: number;
    };
    anchor_bbox?: NormBBox;
  };
  knowledge_object_ids: string[];
}

export interface DocumentProjection {
  schema_version: typeof DOCUMENT_PROJECTION_SCHEMA_VERSION | string;
  projection_id: string;
  document_id: string;
  document_title: string;
  document_uri: string;
  revision_id: string;
  generated_at: ISODateTime;
  source: {
    app: string;
    app_version: string;
  };
  privacy: Privacy;
  export_policy: {
    include_full_text: boolean;
    include_pdf_asset: boolean;
    include_raw_strokes: boolean;
    include_debug_evidence: boolean;
  };
  blocks: DocumentProjectionBlock[];
  body_hash: Sha256;
  content_hash: Sha256;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface DocumentProjectionExportEnvelope {
  schema_version: typeof DOCUMENT_PROJECTION_EXPORT_SCHEMA_VERSION | string;
  export_id: string;
  generated_at: ISODateTime;
  source: {
    app: string;
    app_version: string;
    document_id?: string;
  };
  document_projections: DocumentProjection[];
  external_edits: unknown[];
}

export interface KnowledgeEntity {
  schema_version: 'inkloop.knowledge_entity.v1' | string;
  entity_id: string;
  kind: string;
  display: string;
  aliases?: string[];
  provenance: {
    created_from: 'manual' | 'llm_suggestion' | 'import' | 'merge';
  };
  status?: string;
  merged_into?: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface EntityMembership {
  schema_version: 'inkloop.entity_membership.v1' | string;
  entity_id: string;
  ko_id: string;
  source: 'declared' | 'suggested' | 'imported' | string;
}

export interface KoRelationGroup {
  schema_version: 'inkloop.ko_relation_group.v1' | string;
  relation_id: string;
  kind: 'same_ai_turn' | 'same_context' | string;
  source: 'ai_turn_anchor' | 'meeting_context' | string;
  confidence: 'deterministic' | 'experimental' | string;
  ko_ids: string[];
  evidence?: Record<string, unknown>;
  created_at: ISODateTime;
}

export function buildInkloopDocUri(documentId: string): string {
  return `inkloop://doc/${encodeURIComponent(documentId)}`;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

export function buildInkloopDocUriFromDocumentRef(ref: DocumentSchemaRef): string {
  return `${buildInkloopDocUri(ref.document_id)}${queryString({
    page: ref.page_index,
    anchor: ref.event_id || ref.hmp_id || ref.inference_view_id || ref.object_refs[0],
  })}`;
}

function meetingEventType(kind: MeetingMarkKind): MeetingEventType {
  if (kind === 'question') return 'meeting.question_mark';
  if (kind === 'risk') return 'meeting.risk_mark';
  if (kind === 'action') return 'meeting.action_mark';
  if (kind === 'decision') return 'meeting.decision_mark';
  if (kind === 'attention') return 'meeting.attention_mark';
  return 'meeting.note_mark';
}

function postProcessKnowledgeKind(resultType: PostProcessResultType): KnowledgeKind {
  if (resultType === 'task') return 'meeting_action';
  if (resultType === 'decision') return 'meeting_decision';
  if (resultType === 'risk') return 'meeting_risk';
  if (resultType === 'question') return 'qa';
  return 'reading_note';
}

function calloutForPostProcessResult(resultType: PostProcessResultType): MarkdownCallout {
  if (resultType === 'task') return 'todo';
  if (resultType === 'decision') return 'tip';
  if (resultType === 'risk') return 'warning';
  if (resultType === 'question') return 'question';
  return 'summary';
}

export function buildMeetingEventMark(input: {
  id: string;
  meetingId: string;
  capturedAtMs: number;
  meetingStartMs: number;
  source: string;
  label: string;
  kind: MeetingMarkKind;
  intent?: MeetingMarkKind;
  text?: string;
  mark?: MeetingEventMark['payload']['mark'];
  deviceId?: string;
  rawEventId?: string;
  idempotencyKey?: string;
  createdAt?: ISODateTime;
}): MeetingEventMark {
  const timeMs = input.capturedAtMs - input.meetingStartMs;
  return {
    schema_version: MEETING_EVENT_MARK_SCHEMA_VERSION,
    id: input.id,
    trace_id: `trace_${safeId(`${input.meetingId}_${input.id}`)}`,
    meeting_id: input.meetingId,
    time_ms: timeMs,
    captured_at_ms: input.capturedAtMs,
    source: input.source,
    kind: input.kind,
    label: input.label,
    intent: input.intent ?? input.kind,
    payload: {
      text: input.text ?? input.label,
      mark: input.mark,
      device_id: input.deviceId,
      raw_event_id: input.rawEventId,
    },
    idempotency_key: input.idempotencyKey ?? `${input.meetingId}:${input.id}:${input.capturedAtMs}`,
    created_at: input.createdAt ?? new Date(input.capturedAtMs).toISOString(),
  };
}

export function meetingSourceRefFromMark(mark: MeetingEventMark): MeetingSourceRef {
  return {
    ref_type: 'meeting_mark',
    meeting_id: mark.meeting_id,
    meeting_mark_id: mark.id,
    time_ms: mark.time_ms,
    captured_at_ms: mark.captured_at_ms,
    kind: mark.kind,
    source: mark.source,
  };
}

export function alignMeetingEventMark(input: {
  mark: MeetingEventMark;
  documentRef?: DocumentSchemaRef | null;
  projectMemoryRefs?: ProjectMemoryRef[];
  payload?: Record<string, unknown>;
  createdAt?: ISODateTime;
}): SchemaAlignedEvent {
  const schemaRefs = input.documentRef ? [input.documentRef] : [];
  const sourceRefs: MeetingContractSourceRef[] = [
    ...schemaRefs,
    meetingSourceRefFromMark(input.mark),
    ...(input.projectMemoryRefs ?? []),
  ];
  const aligned = schemaRefs.length > 0;
  return {
    schema_version: SCHEMA_ALIGNED_EVENT_SCHEMA_VERSION,
    trace_id: input.mark.trace_id,
    event_id: `sae_${safeId(input.mark.id)}`,
    meeting_id: input.mark.meeting_id,
    meeting_mark_id: input.mark.id,
    time_ms: input.mark.time_ms,
    event_type: meetingEventType(input.mark.kind),
    schema_refs: schemaRefs,
    source_refs: sourceRefs,
    alignment_status: aligned ? 'aligned' : 'needs_repair',
    failure_reason: aligned ? undefined : 'no_active_document',
    payload: {
      label: input.mark.label,
      intent: input.mark.intent,
      meeting_payload: input.mark.payload,
      ...(input.payload ?? {}),
    },
    created_at: input.createdAt ?? input.mark.created_at,
  };
}

export function buildPostProcessContext(input: {
  traceId: string;
  alignedEvents: SchemaAlignedEvent[];
  projectMemoryRefs?: ProjectMemoryRef[];
  userFeedback?: PostProcessContext['user_feedback'];
  createdAt?: ISODateTime;
}): PostProcessContext {
  const sourceRefs = input.alignedEvents.flatMap((event) => event.source_refs);
  const documentRefs = sourceRefs.filter((ref): ref is DocumentSchemaRef => ref.ref_type === 'document');
  const meetingMarks = sourceRefs.filter((ref): ref is MeetingSourceRef => ref.ref_type === 'meeting_mark');
  const projectMemoryRefs = [
    ...sourceRefs.filter((ref): ref is ProjectMemoryRef => ref.ref_type === 'project_memory'),
    ...(input.projectMemoryRefs ?? []),
  ];
  return {
    schema_version: POST_PROCESS_CONTEXT_SCHEMA_VERSION,
    trace_id: input.traceId,
    aligned_events: input.alignedEvents,
    document_refs: [...new Map(documentRefs.map((ref) => [`${ref.document_id}:${ref.page_id}:${ref.event_id ?? ''}`, ref])).values()],
    meeting_marks: [...new Map(meetingMarks.map((ref) => [`${ref.meeting_id}:${ref.meeting_mark_id}`, ref])).values()],
    project_memory_refs: [...new Map(projectMemoryRefs.map((ref) => [ref.memory_id, ref])).values()],
    user_feedback: input.userFeedback,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}

export function validateMeetingPostProcessSourceRefs(sourceRefs: readonly MeetingContractSourceRef[]): MeetingContractValidationIssue[] {
  const issues: MeetingContractValidationIssue[] = [];
  if (!sourceRefs.some((ref) => ref.ref_type === 'document')) {
    issues.push({ path: 'source_refs', message: 'must include at least one document ref' });
  }
  if (!sourceRefs.some((ref) => ref.ref_type === 'meeting_mark')) {
    issues.push({ path: 'source_refs', message: 'must include at least one meeting_mark ref' });
  }
  sourceRefs.forEach((ref, index) => {
    if (ref.ref_type === 'document') {
      if (!ref.document_id) issues.push({ path: `source_refs.${index}.document_id`, message: 'is required' });
      if (!ref.page_id) issues.push({ path: `source_refs.${index}.page_id`, message: 'is required' });
      if (!ref.object_refs.length) issues.push({ path: `source_refs.${index}.object_refs`, message: 'must not be empty' });
      if (!Number.isFinite(ref.confidence) || ref.confidence < 0 || ref.confidence > 1) issues.push({ path: `source_refs.${index}.confidence`, message: 'must be between 0 and 1' });
    }
    if (ref.ref_type === 'meeting_mark') {
      if (!ref.meeting_id) issues.push({ path: `source_refs.${index}.meeting_id`, message: 'is required' });
      if (!ref.meeting_mark_id) issues.push({ path: `source_refs.${index}.meeting_mark_id`, message: 'is required' });
      if (!Number.isFinite(ref.time_ms)) issues.push({ path: `source_refs.${index}.time_ms`, message: 'must be finite' });
    }
    if (ref.ref_type === 'project_memory' && (!ref.memory_id || !ref.title)) {
      issues.push({ path: `source_refs.${index}`, message: 'project memory refs require memory_id and title' });
    }
  });
  return issues;
}

function meetingSourceRefLabel(ref: MeetingContractSourceRef): string {
  if (ref.ref_type === 'document') {
    const page = ref.page_index == null ? ref.page_id : `page ${ref.page_index + 1}`;
    return `document:${ref.document_id} ${page}${ref.quote ? ` "${ref.quote}"` : ''}`;
  }
  if (ref.ref_type === 'meeting_mark') {
    return `meeting_mark:${ref.meeting_id}/${ref.meeting_mark_id} ${ref.kind} @${Math.round(ref.time_ms / 1000)}s`;
  }
  return `project_memory:${ref.kind}:${ref.title}`;
}

function meetingSourceRefsMarkdown(refs: readonly MeetingContractSourceRef[]): string {
  return refs.map((ref) => `- ${meetingSourceRefLabel(ref)}`).join('\n');
}

export async function buildKnowledgeObjectFromPostProcessResult(input: {
  result: PostProcessResult;
  documentTitle: string;
  status?: Extract<KnowledgeStatus, 'accepted' | 'edited' | 'follow_up'>;
}): Promise<KnowledgeObject> {
  const issues = validateMeetingPostProcessSourceRefs(input.result.source_refs);
  if (issues.length) throw new Error(`invalid post-process source_refs: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  const primaryDocument = input.result.source_refs.find((ref): ref is DocumentSchemaRef => ref.ref_type === 'document');
  if (!primaryDocument) throw new Error('missing primary document ref');
  const uri = buildInkloopDocUriFromDocumentRef(primaryDocument);
  const status = input.status ?? (input.result.status === 'edited' ? 'edited' : 'accepted');
  const body_md = [
    input.result.content_md.trim(),
    '',
    '**Source refs**',
    meetingSourceRefsMarkdown(input.result.source_refs),
    '',
    `Backlink: ${uri}`,
  ].join('\n');
  const draft = {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: `ko_${safeId(input.result.result_id)}`,
    kind: postProcessKnowledgeKind(input.result.result_type),
    title: input.result.title,
    body_md,
    source: {
      document_id: primaryDocument.document_id,
      document_title: input.documentTitle,
      page_id: primaryDocument.page_id,
      page_index: primaryDocument.page_index,
      object_refs: primaryDocument.object_refs,
      anchor_bbox: primaryDocument.bbox,
      quote: primaryDocument.quote,
      inkloop_uri: uri,
    },
    provenance: { created_from: 'ai_turn' as const, ai_turn_ids: [input.result.result_id] },
    source_refs: input.result.source_refs,
    tags: ['inkloop', `inkloop/${postProcessKnowledgeKind(input.result.result_type)}`, 'inkloop/meeting'],
    status,
    privacy: 'export_allowed' as const,
    render_hints: { markdown_callout: calloutForPostProcessResult(input.result.result_type) },
    content_hash: 'sha256:pending' as Sha256,
    created_at: input.result.created_at,
    updated_at: input.result.created_at,
  };
  return {
    ...draft,
    content_hash: await sha256ContentHash(canonicalJson({
      kind: draft.kind,
      title: draft.title,
      body_md: draft.body_md,
      source: draft.source,
      source_refs: draft.source_refs,
      status: draft.status,
    })),
  };
}

function safeId(input: string): string {
  return input.normalize('NFKC').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'item';
}

function sourceRefKey(ref: InkLoopSourceRef): string {
  if (ref.type === 'ink_event') return ref.event_id;
  if (ref.type === 'board_object') return ref.object_id;
  if (ref.type === 'audio_segment') return `audio_${ref.start_ms}_${ref.end_ms}`;
  return ref.memory_id;
}

function sourceRefLabel(ref: InkLoopSourceRef): string {
  if (ref.type === 'ink_event') return `ink_event:${ref.event_id}`;
  if (ref.type === 'board_object') return `${ref.object_type}:${ref.object_id}`;
  if (ref.type === 'audio_segment') return `audio:${ref.start_ms}-${ref.end_ms}${ref.speaker ? ` ${ref.speaker}` : ''}`;
  return `memory:${ref.title}`;
}

function firstAnchorBBox(refs: readonly InkLoopSourceRef[]): NormBBox | undefined {
  for (const ref of refs) {
    if ((ref.type === 'ink_event' || ref.type === 'board_object') && ref.bbox_norm) return [...ref.bbox_norm] as NormBBox;
  }
  return undefined;
}

function sourceRefsMarkdown(refs: readonly InkLoopSourceRef[]): string {
  return refs.map((ref) => `- ${sourceRefLabel(ref)}`).join('\n');
}

function canPromote(status: KnowledgeStatus | undefined): status is 'accepted' | 'edited' | 'follow_up' {
  return status === 'accepted' || status === 'edited' || status === 'follow_up';
}

async function createAiGraphKnowledgeObject(input: {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  sourceRefs: InkLoopSourceRef[];
  documentId: string;
  documentTitle: string;
  status: 'accepted' | 'edited' | 'follow_up';
  aiTurnId: string;
  now: ISODateTime;
}): Promise<KnowledgeObject> {
  const uri = buildInkloopDocUri(input.documentId);
  const body_md = [
    input.body.trim(),
    '',
    '**Source refs**',
    sourceRefsMarkdown(input.sourceRefs),
    '',
    `Backlink: ${uri}`,
  ].join('\n');
  const draft = {
    schema_version: KO_SCHEMA_VERSION,
    ko_id: `ko_${safeId(input.id)}`,
    kind: input.kind,
    title: input.title,
    body_md,
    source: {
      document_id: input.documentId,
      document_title: input.documentTitle,
      object_refs: [...new Set(input.sourceRefs.map(sourceRefKey))],
      anchor_bbox: firstAnchorBBox(input.sourceRefs),
      inkloop_uri: uri,
    },
    provenance: { created_from: 'ai_turn' as const, ai_turn_ids: [input.aiTurnId] },
    tags: ['inkloop', `inkloop/${input.kind}`],
    status: input.status,
    privacy: 'export_allowed' as const,
    content_hash: 'sha256:pending' as Sha256,
    created_at: input.now,
    updated_at: input.now,
  };
  return {
    ...draft,
    content_hash: await sha256ContentHash(canonicalJson({
      kind: draft.kind,
      title: draft.title,
      body_md: draft.body_md,
      source: draft.source,
      status: draft.status,
    })),
  };
}

function titleFor(options: AiGraphKnowledgeProjectionOptions, id: string, fallback: string): string {
  return options.titleOverridesById?.[id]?.trim() || fallback;
}

function bodyFor(options: AiGraphKnowledgeProjectionOptions, id: string, fallback: string): string {
  return options.bodyOverridesById?.[id]?.trim() || fallback;
}

export async function buildLessonGraphKnowledgeObjects(
  lesson: LessonGraph,
  options: AiGraphKnowledgeProjectionOptions,
): Promise<KnowledgeObject[]> {
  const now = options.now ?? new Date().toISOString();
  const objects: KnowledgeObject[] = [];

  for (const step of lesson.steps) {
    const status = options.statusById[step.step_id];
    if (!canPromote(status)) continue;
    if (validateInkLoopSourceRefs(step.kind === 'formula' ? 'formula_explanation' : 'lesson_step', step.source_refs).length) continue;
    const kind: KnowledgeKind = step.kind === 'formula' ? 'formula_step' : 'lesson_note';
    const formula = step.latex ? `\n\nFormula: ${step.latex}` : '';
    objects.push(await createAiGraphKnowledgeObject({
      id: step.step_id,
      kind,
      title: titleFor(options, step.step_id, `${lesson.title || 'Lesson'} / ${step.order}. ${step.kind}`),
      body: bodyFor(options, step.step_id, `${step.content}${formula}`),
      sourceRefs: step.source_refs,
      documentId: options.documentId,
      documentTitle: options.documentTitle,
      status,
      aiTurnId: step.step_id,
      now,
    }));
  }

  for (const concept of lesson.concepts) {
    const status = options.statusById[concept.concept_id];
    if (!canPromote(status)) continue;
    if (validateInkLoopSourceRefs('lesson_step', concept.source_refs).length) continue;
    objects.push(await createAiGraphKnowledgeObject({
      id: concept.concept_id,
      kind: 'concept',
      title: titleFor(options, concept.concept_id, concept.name),
      body: bodyFor(options, concept.concept_id, concept.explanation),
      sourceRefs: concept.source_refs,
      documentId: options.documentId,
      documentTitle: options.documentTitle,
      status,
      aiTurnId: concept.concept_id,
      now,
    }));
  }

  return objects;
}

export async function buildMeetingGraphKnowledgeObjects(
  meeting: MeetingGraph,
  options: AiGraphKnowledgeProjectionOptions,
): Promise<KnowledgeObject[]> {
  const now = options.now ?? new Date().toISOString();
  const objects: KnowledgeObject[] = [];

  for (const decision of meeting.decisions) {
    const status = options.statusById[decision.decision_id];
    if (!canPromote(status)) continue;
    if (validateInkLoopSourceRefs('meeting_decision', decision.source_refs).length) continue;
    const rationale = decision.rationale ? `\n\nRationale: ${decision.rationale}` : '';
    objects.push(await createAiGraphKnowledgeObject({
      id: decision.decision_id,
      kind: 'meeting_decision',
      title: titleFor(options, decision.decision_id, `Decision: ${decision.content.slice(0, 56)}`),
      body: bodyFor(options, decision.decision_id, `${decision.content}${rationale}`),
      sourceRefs: decision.source_refs,
      documentId: options.documentId,
      documentTitle: options.documentTitle,
      status,
      aiTurnId: decision.decision_id,
      now,
    }));
  }

  for (const action of meeting.actions) {
    const status = options.statusById[action.action_id];
    if (!canPromote(status)) continue;
    if (validateInkLoopSourceRefs('meeting_action', action.source_refs).length) continue;
    const owner = action.owner ? `\n\nOwner: ${action.owner}` : '';
    const due = action.due_date ? `\nDue: ${action.due_date}` : '';
    objects.push(await createAiGraphKnowledgeObject({
      id: action.action_id,
      kind: 'meeting_action',
      title: titleFor(options, action.action_id, `Action: ${action.content.slice(0, 56)}`),
      body: bodyFor(options, action.action_id, `${action.content}${owner}${due}`),
      sourceRefs: action.source_refs,
      documentId: options.documentId,
      documentTitle: options.documentTitle,
      status,
      aiTurnId: action.action_id,
      now,
    }));
  }

  for (const risk of meeting.risks) {
    const status = options.statusById[risk.risk_id];
    if (!canPromote(status)) continue;
    if (validateInkLoopSourceRefs('meeting_risk', risk.source_refs).length) continue;
    const severity = risk.severity ? `\n\nSeverity: ${risk.severity}` : '';
    objects.push(await createAiGraphKnowledgeObject({
      id: risk.risk_id,
      kind: 'meeting_risk',
      title: titleFor(options, risk.risk_id, `Risk: ${risk.content.slice(0, 56)}`),
      body: bodyFor(options, risk.risk_id, `${risk.content}${severity}`),
      sourceRefs: risk.source_refs,
      documentId: options.documentId,
      documentTitle: options.documentTitle,
      status,
      aiTurnId: risk.risk_id,
      now,
    }));
  }

  for (const diagram of meeting.diagrams) {
    const status = options.statusById[diagram.diagram_id];
    if (!canPromote(status)) continue;
    if (validateInkLoopSourceRefs('diagram_export', diagram.source_refs).length) continue;
    const mermaid = diagram.mermaid ? `\n\n\`\`\`mermaid\n${diagram.mermaid}\n\`\`\`` : '';
    objects.push(await createAiGraphKnowledgeObject({
      id: diagram.diagram_id,
      kind: 'diagram',
      title: titleFor(options, diagram.diagram_id, `Diagram: ${diagram.type}`),
      body: bodyFor(options, diagram.diagram_id, `${diagram.type}${mermaid}`),
      sourceRefs: diagram.source_refs,
      documentId: options.documentId,
      documentTitle: options.documentTitle,
      status,
      aiTurnId: diagram.diagram_id,
      now,
    }));
  }

  return objects;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256HexFallback(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return sha256HexFallback(bytes);
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256ContentHash(input: string): Promise<Sha256> {
  return `sha256:${await sha256Hex(input)}`;
}

export async function computeDocumentProjectionBodyHash(blocks: readonly DocumentProjectionBlock[]): Promise<Sha256> {
  return sha256ContentHash(canonicalJson(blocks));
}

export async function computeDocumentProjectionHash(projection: Omit<DocumentProjection, 'content_hash'>): Promise<Sha256> {
  return sha256ContentHash(canonicalJson(projection));
}

export function isExportableKnowledgeObject(ko: Pick<KnowledgeObject, 'privacy' | 'status' | 'body_md'>): boolean {
  return ko.privacy === 'export_allowed'
    && ['export_ready', 'accepted', 'edited', 'follow_up', 'exported'].includes(ko.status)
    && ko.body_md.trim().length > 0;
}
