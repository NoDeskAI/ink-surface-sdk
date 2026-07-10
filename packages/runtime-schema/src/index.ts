export const RUNTIME_SYNC_EVENT_SCHEMA_VERSION = 'inkloop.runtime_sync_event.v1' as const;
export const RUNTIME_SURFACE_OBJECT_SCHEMA_VERSION = 'inkloop.surface_object.v1' as const;
export const INKLOOP_AI_PEN_CONTRACT_VERSION = 'inkloop.ai_pen.v1' as const;
export const AI_GRAPH_JOB_SCHEMA_VERSION = 'inkloop.ai_graph_job.v1' as const;

export interface RuntimeSchemaValidationIssue {
  path: string;
  message: string;
}

export type RuntimeNormBBox = [number, number, number, number];

export type InkLoopSessionMode = 'teach' | 'meeting' | 'paper';

export interface RawPenFrame {
  schema_version?: typeof INKLOOP_AI_PEN_CONTRACT_VERSION;
  pen_id: string;
  session_id: string;
  surface_id?: string;
  ts_device_ms: number;
  ts_host_ms?: number;
  tip_state: 'down' | 'hover' | 'up';
  pressure?: number;
  optical?: {
    x_raw?: number;
    y_raw?: number;
    pattern_id?: string;
    quality: number;
  };
  imu?: {
    ax: number;
    ay: number;
    az: number;
    gx: number;
    gy: number;
    gz: number;
  };
  color_id?: string;
  battery?: number;
  firmware_version: string;
}

export interface InkLoopStrokePoint {
  x_norm: number;
  y_norm: number;
  t_ms: number;
  pressure?: number;
  quality?: number;
}

export interface InkLoopStroke {
  stroke_id: string;
  session_id: string;
  surface_id: string;
  pen_id: string;
  points: InkLoopStrokePoint[];
  bbox_norm: RuntimeNormBBox;
  ts_start_ms: number;
  ts_end_ms: number;
  source_frame_refs?: string[];
}

export type InkEventType = 'stroke' | 'erase' | 'gesture' | 'mode_change' | 'session_marker';

export interface InkEvent {
  schema_version?: typeof INKLOOP_AI_PEN_CONTRACT_VERSION;
  event_id: string;
  trace_id: string;
  session_id: string;
  surface_id: string;
  pen_id: string;
  event_type: InkEventType;
  stroke_refs: string[];
  bbox_norm: RuntimeNormBBox;
  ts_start_ms: number;
  ts_end_ms: number;
  source: {
    device: 'ai_pen' | 'epaper' | 'web_demo';
    localization: 'encoded_surface' | 'imu_fusion' | 'epaper_digitizer' | 'manual_mock';
    confidence: number;
  };
  metadata?: {
    color?: string;
    tool?: 'pen' | 'highlighter' | 'underline' | 'eraser';
    mode?: InkLoopSessionMode;
  };
}

export type BoardObjectType =
  | 'text'
  | 'formula'
  | 'shape'
  | 'arrow'
  | 'diagram_node'
  | 'diagram_edge'
  | 'region'
  | 'decision'
  | 'risk'
  | 'action_item'
  | 'question';

export interface BoardObject {
  object_id: string;
  session_id: string;
  surface_id: string;
  type: BoardObjectType;
  bbox_norm: RuntimeNormBBox;
  stroke_refs: string[];
  hmp_refs: string[];
  text_candidate?: string;
  normalized_text?: string;
  confidence: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export type BoardGraphRelation =
  | 'contains'
  | 'points_to'
  | 'next_step'
  | 'depends_on'
  | 'contrasts_with'
  | 'assigned_to'
  | 'causes'
  | 'supports'
  | 'replaces'
  | 'nearby';

export interface BoardGraph {
  schema_version?: typeof INKLOOP_AI_PEN_CONTRACT_VERSION;
  graph_id: string;
  session_id: string;
  surface_id: string;
  version: string;
  nodes: BoardObject[];
  edges: Array<{
    edge_id: string;
    from: string;
    to: string;
    relation: BoardGraphRelation;
    evidence_refs: string[];
    confidence: number;
  }>;
  updated_at_ms: number;
}

export type InkLoopSourceRef =
  | {
      type: 'ink_event';
      session_id: string;
      event_id: string;
      ts_start_ms: number;
      ts_end_ms: number;
      bbox_norm?: RuntimeNormBBox;
    }
  | {
      type: 'board_object';
      session_id: string;
      object_id: string;
      object_type: BoardObjectType | string;
      bbox_norm: RuntimeNormBBox;
    }
  | {
      type: 'audio_segment';
      session_id: string;
      start_ms: number;
      end_ms: number;
      speaker?: string;
      transcript_ref?: string;
    }
  | {
      type: 'project_memory';
      memory_id: string;
      kind: string;
      title: string;
    };

export interface SceneView {
  schema_version?: typeof INKLOOP_AI_PEN_CONTRACT_VERSION;
  scene_id: string;
  session_id: string;
  mode: InkLoopSessionMode;
  narrative: string;
  anchors: Array<{
    anchor_id: string;
    object_refs: string[];
    bbox_norm: RuntimeNormBBox;
    label?: string;
  }>;
  marked: Array<{
    object_ref: string;
    text?: string;
    object_type: string;
    confidence: number;
  }>;
  graph_summary: {
    node_count: number;
    edge_count: number;
    key_relations: string[];
  };
  time_window: {
    start_ms: number;
    end_ms: number;
  };
  recall?: Array<{
    source: 'session' | 'course_history' | 'project_memory';
    title: string;
    snippet: string;
    source_ref: string;
  }>;
  source_refs: InkLoopSourceRef[];
}

export interface LessonGraph {
  schema_version?: typeof INKLOOP_AI_PEN_CONTRACT_VERSION;
  lesson_id: string;
  session_id: string;
  title?: string;
  steps: Array<{
    step_id: string;
    order: number;
    kind: 'definition' | 'example' | 'derivation' | 'formula' | 'diagram' | 'conclusion';
    content: string;
    latex?: string;
    board_object_refs: string[];
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;
  concepts: Array<{
    concept_id: string;
    name: string;
    explanation: string;
    source_refs: InkLoopSourceRef[];
  }>;
  exports?: {
    markdown?: string;
    pdf_ref?: string;
  };
}

export interface MeetingGraph {
  schema_version?: typeof INKLOOP_AI_PEN_CONTRACT_VERSION;
  meeting_id: string;
  session_id: string;
  title?: string;
  decisions: Array<{
    decision_id: string;
    content: string;
    alternatives?: string[];
    rationale?: string;
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;
  actions: Array<{
    action_id: string;
    content: string;
    owner?: string;
    due_date?: string;
    status: 'candidate' | 'confirmed' | 'dismissed';
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;
  risks: Array<{
    risk_id: string;
    content: string;
    severity?: 'low' | 'medium' | 'high';
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;
  diagrams: Array<{
    diagram_id: string;
    type: 'architecture' | 'flowchart' | 'timeline' | 'unknown';
    mermaid?: string;
    svg_ref?: string;
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;
}

export type AiGraphJobMode = Extract<InkLoopSessionMode, 'teach' | 'meeting'>;
export type AiGraphJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked';

export interface AiGraphJob {
  schema_version: typeof AI_GRAPH_JOB_SCHEMA_VERSION;
  job_id: string;
  session_id: string;
  surface_id: string;
  mode: AiGraphJobMode;
  status: AiGraphJobStatus;
  input: {
    ink_events: InkEvent[];
    board_objects: BoardObject[];
    scene_view?: SceneView;
    optional_context?: {
      transcript_ref?: string;
      audio_segment_refs?: InkLoopSourceRef[];
      project_memory_refs?: InkLoopSourceRef[];
    };
  };
  output?: {
    lesson_graph?: LessonGraph;
    meeting_graph?: MeetingGraph;
    validator_issues?: RuntimeSchemaValidationIssue[];
  };
  created_at: string;
  updated_at: string;
  completed_at?: string;
  error?: string;
}

export type InkLoopAiResultKind =
  | 'lesson_step'
  | 'formula_explanation'
  | 'meeting_decision'
  | 'meeting_action'
  | 'meeting_risk'
  | 'diagram_export';

export type RuntimeChangeSource =
  | 'web_lab'
  | 'obsidian_plugin'
  | 'inkloop_web'
  | 'inkloop_device'
  | 'cloud'
  | 'test';

export interface RuntimeLineRange {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export interface RuntimeStrokePoint {
  x: number;
  y: number;
  t?: number;
  pressure?: number;
}

export interface RuntimeVisualStroke {
  tool?: 'pen' | 'aipen' | 'highlighter' | 'underline';
  color?: string;
  opacity?: number;
  coord_space?: string;
  capture_surface?: string;
  layout_id?: string;
  bbox?: readonly number[];
  points: RuntimeStrokePoint[];
}

export interface RuntimeSurfaceStroke extends RuntimeVisualStroke {
  capture_surface: string;
  coord_space: string;
}

export interface RuntimeAnnotation extends Record<string, unknown> {
  ko_id: string;
  kind?: string;
  title?: string;
  body_md?: string;
  status?: string;
  render_mode?: 'stroke_only' | 'margin_note' | string;
  visual_bbox?: [number, number, number, number];
  visual_strokes?: RuntimeVisualStroke[];
  surface_strokes?: RuntimeSurfaceStroke[];
  created_at?: string;
  updated_at?: string;
}

export interface RuntimeSurfaceBlock extends Record<string, unknown> {
  object_id: string;
  doc_id?: string;
  text?: string;
  source_anchor?: {
    quote?: string;
    range?: RuntimeLineRange;
    [key: string]: unknown;
  };
  projection?: {
    block_id?: string;
    kind?: string;
    region?: string;
    page_index?: number;
    knowledge_object_ids?: string[];
    [key: string]: unknown;
  };
  fingerprint?: Record<string, unknown>;
  annotations?: RuntimeAnnotation[];
}

export interface RuntimeDocumentRecord extends Record<string, unknown> {
  doc_id: string;
  title?: string;
  source_type?: string;
  updated_at?: string;
}

export interface RuntimeSourceRef extends Record<string, unknown> {
  source_ref_id?: string;
  doc_id?: string;
  kind?: string;
  vault_file?: {
    path: string;
    extension?: string;
    [key: string]: unknown;
  };
  identity?: Record<string, unknown>;
}

export type RuntimeDocumentSourceKind = 'imported_pdf' | 'native_markdown' | 'inkloop_created';

export interface RuntimeDocumentIdentity extends Record<string, unknown> {
  schema_version: 'inkloop.runtime_document_identity.v1';
  doc_id: string;
  source_kind: RuntimeDocumentSourceKind;
  source_ref_id?: string;
  stable_key: string;
  source_path?: string;
  file_hash?: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeSourceRevision extends Record<string, unknown> {
  revision_id?: string;
  content_hash?: string;
  source_path?: string;
  updated_at?: string;
}

export interface RuntimeReadingProgress extends Record<string, unknown> {
  page_index?: number;
  block_id?: string;
  scroll_ratio?: number;
  updated_at: string;
}

export interface RuntimeSyncEventOrigin extends Record<string, unknown> {
  device_id: string;
  client_id?: string;
  session_id?: string;
}

export interface RuntimeConflictRecord extends Record<string, unknown> {
  conflict_id: string;
  event_id: string;
  doc_id: string;
  reason: string;
  created_at: string;
  local_revision?: RuntimeSourceRevision;
  remote_revision?: RuntimeSourceRevision;
}

export interface RuntimeDocumentSnapshot {
  doc_id: string;
  doc_dir: string;
  document: RuntimeDocumentRecord;
  identity?: RuntimeDocumentIdentity;
  source: RuntimeSourceRef;
  source_revision?: RuntimeSourceRevision;
  reading_progress?: RuntimeReadingProgress;
  conflicts?: RuntimeConflictRecord[];
  blocks: RuntimeSurfaceBlock[];
  nodes: Record<string, unknown>[];
}

export type RuntimeCommitTarget =
  | { type: 'sidecar_only' }
  | { type: 'markdown_source_patch' };

export interface RuntimeSyncEvent {
  schema_version: typeof RUNTIME_SYNC_EVENT_SCHEMA_VERSION;
  event_id: string;
  source: RuntimeChangeSource;
  doc_id: string;
  operation:
    | 'runtime.bootstrap'
    | 'block.update'
    | 'annotation.update'
    | 'annotation.add'
    | 'annotation.delete'
    | 'knowledge.update'
    | 'canvas.node.add'
    | 'canvas.node.delete'
    | 'progress.update'
    | 'source.rename';
  target: {
    type: 'document' | 'block' | 'annotation' | 'knowledge_object' | 'canvas_node' | 'progress' | 'source';
    id?: string;
    block_id?: string;
  };
  payload: Record<string, unknown>;
  origin?: RuntimeSyncEventOrigin;
  base_revision?: RuntimeSourceRevision;
  source_revision?: RuntimeSourceRevision;
  status: 'pending' | 'sent' | 'failed';
  dedupe_key: string;
  created_at: string;
  updated_at: string;
  attempt_count?: number;
  last_error?: string;
  next_retry_at?: string;
  sent_at?: string;
  ack_id?: string;
  deduped_by_event_id?: string;
}

export interface RuntimeMutationResult {
  doc_id: string;
  source_path?: string;
  block_id?: string;
  ko_id?: string;
  annotation?: RuntimeAnnotation;
  sync_event: RuntimeSyncEvent;
  updated_at: string;
}

export interface UpdateRuntimeBlockContentInput {
  doc_id: string;
  block_id: string;
  content: string;
  source: RuntimeChangeSource;
  commit_target?: RuntimeCommitTarget;
}

export interface UpdateRuntimeAnnotationInput {
  doc_id: string;
  ko_id: string;
  patch: Record<string, unknown>;
  source: RuntimeChangeSource;
}

export interface AddRuntimeAnnotationInput {
  doc_id: string;
  block_id: string;
  source: RuntimeChangeSource;
  annotation?: Partial<RuntimeAnnotation>;
  kind?: string;
  title?: string;
  body_md?: string;
  render_mode?: RuntimeAnnotation['render_mode'];
  visual_bbox?: RuntimeAnnotation['visual_bbox'];
  visual_strokes?: RuntimeVisualStroke[];
}

export interface DeleteRuntimeAnnotationInput {
  doc_id: string;
  ko_id: string;
  source: RuntimeChangeSource;
}

export interface UpdateRuntimeProgressInput {
  doc_id: string;
  progress: RuntimeReadingProgress;
  source: RuntimeChangeSource;
}

export interface RuntimeOutboxPort {
  listOutboxEvents(): Promise<RuntimeSyncEvent[]>;
  writeOutboxEvents(events: RuntimeSyncEvent[]): Promise<void>;
  appendSyncEvent(event: RuntimeSyncEvent): Promise<void>;
}

export interface RuntimeStorePort extends RuntimeOutboxPort {
  loadDocument(docId: string): Promise<RuntimeDocumentSnapshot | null>;
  updateBlockContent(input: UpdateRuntimeBlockContentInput): Promise<RuntimeMutationResult>;
  updateAnnotation(input: UpdateRuntimeAnnotationInput): Promise<RuntimeMutationResult>;
  addAnnotation(input: AddRuntimeAnnotationInput): Promise<RuntimeMutationResult>;
  deleteAnnotation?(input: DeleteRuntimeAnnotationInput): Promise<RuntimeMutationResult>;
  updateReadingProgress?(input: UpdateRuntimeProgressInput): Promise<RuntimeMutationResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (typeof value[key] !== 'string' || value[key] === '') issues.push({ path: key, message: 'must be a non-empty string' });
}

function requireStringAt(value: Record<string, unknown>, key: string, issues: RuntimeSchemaValidationIssue[], path: string): void {
  if (typeof value[key] !== 'string' || value[key] === '') issues.push({ path, message: 'must be a non-empty string' });
}

function validateOptionalString(value: Record<string, unknown>, key: string, issues: RuntimeSchemaValidationIssue[], path = key): void {
  if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key] === '')) {
    issues.push({ path, message: 'must be a non-empty string when present' });
  }
}

function validateFiniteNumber(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) issues.push({ path, message: 'must be a finite number' });
}

function validateNumberRange(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[], min: number, max: number): void {
  validateFiniteNumber(value, path, issues);
  if (typeof value === 'number' && Number.isFinite(value) && (value < min || value > max)) {
    issues.push({ path, message: `must be between ${min} and ${max}` });
  }
}

function requireRecord(value: Record<string, unknown>, key: string, issues: RuntimeSchemaValidationIssue[]): Record<string, unknown> | null {
  if (!isRecord(value[key])) {
    issues.push({ path: key, message: 'must be an object' });
    return null;
  }
  return value[key];
}

function validateRuntimeSnapshot(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  if (typeof value.doc_id !== 'string' || value.doc_id === '') issues.push({ path: `${path}.doc_id`, message: 'must be a non-empty string' });
  if (!isRecord(value.document)) issues.push({ path: `${path}.document`, message: 'must be an object' });
  if (!isRecord(value.source)) issues.push({ path: `${path}.source`, message: 'must be an object' });
  if (!Array.isArray(value.blocks)) issues.push({ path: `${path}.blocks`, message: 'must be an array' });
  if (!Array.isArray(value.nodes)) issues.push({ path: `${path}.nodes`, message: 'must be an array' });
}

function validateOrigin(value: unknown, issues: RuntimeSchemaValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path: 'origin', message: 'must be an object' });
    return;
  }
  if (typeof value.device_id !== 'string' || value.device_id === '') {
    issues.push({ path: 'origin.device_id', message: 'must be a non-empty string' });
  }
}

function hasInkOrBoardRef(sourceRefs: readonly InkLoopSourceRef[]): boolean {
  return sourceRefs.some((ref) => ref.type === 'ink_event' || ref.type === 'board_object');
}

function hasBoardObjectType(sourceRefs: readonly InkLoopSourceRef[], types: readonly string[]): boolean {
  return sourceRefs.some((ref) => ref.type === 'board_object' && types.includes(String(ref.object_type)));
}

function diagramEvidenceCount(sourceRefs: readonly InkLoopSourceRef[]): number {
  return sourceRefs.filter((ref) => {
    if (ref.type === 'ink_event') return true;
    if (ref.type !== 'board_object') return false;
    return ['diagram_node', 'diagram_edge', 'arrow', 'shape'].includes(String(ref.object_type));
  }).length;
}

export function validateRawPenFrame(value: unknown, path = 'frame'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];

  if (value.schema_version !== undefined && value.schema_version !== INKLOOP_AI_PEN_CONTRACT_VERSION) {
    issues.push({ path: `${path}.schema_version`, message: `must be ${INKLOOP_AI_PEN_CONTRACT_VERSION}` });
  }
  requireStringAt(value, 'pen_id', issues, `${path}.pen_id`);
  requireStringAt(value, 'session_id', issues, `${path}.session_id`);
  validateOptionalString(value, 'surface_id', issues, `${path}.surface_id`);
  validateFiniteNumber(value.ts_device_ms, `${path}.ts_device_ms`, issues);
  if (value.ts_host_ms !== undefined) validateFiniteNumber(value.ts_host_ms, `${path}.ts_host_ms`, issues);
  if (!['down', 'hover', 'up'].includes(String(value.tip_state))) {
    issues.push({ path: `${path}.tip_state`, message: 'must be down, hover, or up' });
  }
  if (value.pressure !== undefined) validateNumberRange(value.pressure, `${path}.pressure`, issues, 0, 1);
  if (value.battery !== undefined) validateNumberRange(value.battery, `${path}.battery`, issues, 0, 1);
  requireStringAt(value, 'firmware_version', issues, `${path}.firmware_version`);

  if (value.optical !== undefined) {
    if (!isRecord(value.optical)) {
      issues.push({ path: `${path}.optical`, message: 'must be an object' });
    } else {
      if (value.optical.x_raw !== undefined) validateFiniteNumber(value.optical.x_raw, `${path}.optical.x_raw`, issues);
      if (value.optical.y_raw !== undefined) validateFiniteNumber(value.optical.y_raw, `${path}.optical.y_raw`, issues);
      validateOptionalString(value.optical, 'pattern_id', issues, `${path}.optical.pattern_id`);
      validateNumberRange(value.optical.quality, `${path}.optical.quality`, issues, 0, 1);
    }
  }

  if (value.imu !== undefined) {
    if (!isRecord(value.imu)) {
      issues.push({ path: `${path}.imu`, message: 'must be an object' });
    } else {
      for (const key of ['ax', 'ay', 'az', 'gx', 'gy', 'gz']) {
        validateFiniteNumber(value.imu[key], `${path}.imu.${key}`, issues);
      }
    }
  }

  return issues;
}

export function isRawPenFrame(value: unknown): value is RawPenFrame {
  return validateRawPenFrame(value).length === 0;
}

export function validateInkLoopSourceRefs(
  kind: InkLoopAiResultKind,
  sourceRefs: readonly InkLoopSourceRef[],
  path = 'source_refs',
): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];

  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
    issues.push({ path, message: 'must contain at least one source reference' });
    return issues;
  }

  if (kind === 'lesson_step' && !hasInkOrBoardRef(sourceRefs)) {
    issues.push({ path, message: 'lesson steps must reference at least one ink_event or board_object' });
  }

  if (kind === 'formula_explanation' && !hasBoardObjectType(sourceRefs, ['formula', 'text']) && !sourceRefs.some((ref) => ref.type === 'ink_event')) {
    issues.push({ path, message: 'formula explanations must reference formula, text, or ink evidence' });
  }

  if ((kind === 'meeting_decision' || kind === 'meeting_action' || kind === 'meeting_risk') && !hasInkOrBoardRef(sourceRefs)) {
    issues.push({ path, message: 'meeting results must include ink_event or board_object evidence, not audio/project memory alone' });
  }

  if (kind === 'diagram_export' && diagramEvidenceCount(sourceRefs) < 2) {
    issues.push({ path, message: 'diagram exports must reference at least two diagram, arrow, shape, or ink evidence items' });
  }

  return issues;
}

export function validateLessonGraphSourceRefs(value: LessonGraph): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  value.steps.forEach((step, index) => {
    issues.push(...validateInkLoopSourceRefs(
      step.kind === 'formula' ? 'formula_explanation' : 'lesson_step',
      step.source_refs,
      `steps.${index}.source_refs`,
    ));
  });
  return issues;
}

export function validateMeetingGraphSourceRefs(value: MeetingGraph): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  value.decisions.forEach((decision, index) => {
    issues.push(...validateInkLoopSourceRefs('meeting_decision', decision.source_refs, `decisions.${index}.source_refs`));
  });
  value.actions.forEach((action, index) => {
    issues.push(...validateInkLoopSourceRefs('meeting_action', action.source_refs, `actions.${index}.source_refs`));
  });
  value.risks.forEach((risk, index) => {
    issues.push(...validateInkLoopSourceRefs('meeting_risk', risk.source_refs, `risks.${index}.source_refs`));
  });
  value.diagrams.forEach((diagram, index) => {
    issues.push(...validateInkLoopSourceRefs('diagram_export', diagram.source_refs, `diagrams.${index}.source_refs`));
  });
  return issues;
}

export function validateAiGraphJob(value: unknown, path = 'job'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];

  if (value.schema_version !== AI_GRAPH_JOB_SCHEMA_VERSION) {
    issues.push({ path: `${path}.schema_version`, message: `must be ${AI_GRAPH_JOB_SCHEMA_VERSION}` });
  }
  requireStringAt(value, 'job_id', issues, `${path}.job_id`);
  requireStringAt(value, 'session_id', issues, `${path}.session_id`);
  requireStringAt(value, 'surface_id', issues, `${path}.surface_id`);
  requireStringAt(value, 'created_at', issues, `${path}.created_at`);
  requireStringAt(value, 'updated_at', issues, `${path}.updated_at`);

  if (!['teach', 'meeting'].includes(String(value.mode))) {
    issues.push({ path: `${path}.mode`, message: 'must be teach or meeting' });
  }
  if (!['queued', 'running', 'completed', 'failed', 'blocked'].includes(String(value.status))) {
    issues.push({ path: `${path}.status`, message: 'must be queued, running, completed, failed, or blocked' });
  }

  const input = isRecord(value.input) ? value.input : null;
  if (!input) {
    issues.push({ path: `${path}.input`, message: 'must be an object' });
  } else {
    if (!Array.isArray(input.ink_events)) issues.push({ path: `${path}.input.ink_events`, message: 'must be an array' });
    if (!Array.isArray(input.board_objects)) issues.push({ path: `${path}.input.board_objects`, message: 'must be an array' });
    const inkEventCount = Array.isArray(input.ink_events) ? input.ink_events.length : 0;
    const boardObjectCount = Array.isArray(input.board_objects) ? input.board_objects.length : 0;
    if (inkEventCount + boardObjectCount === 0) {
      issues.push({ path: `${path}.input`, message: 'must include ink_event or board_object evidence' });
    }
  }

  if (value.status === 'completed') {
    const output = isRecord(value.output) ? value.output : null;
    if (!output) {
      issues.push({ path: `${path}.output`, message: 'must be present when status is completed' });
    } else if (value.mode === 'teach') {
      if (!isRecord(output.lesson_graph)) {
        issues.push({ path: `${path}.output.lesson_graph`, message: 'must be present for completed teach jobs' });
      } else {
        issues.push(...validateLessonGraphSourceRefs(output.lesson_graph as unknown as LessonGraph).map((issue) => ({
          ...issue,
          path: `${path}.output.lesson_graph.${issue.path}`,
        })));
      }
    } else if (value.mode === 'meeting') {
      if (!isRecord(output.meeting_graph)) {
        issues.push({ path: `${path}.output.meeting_graph`, message: 'must be present for completed meeting jobs' });
      } else {
        issues.push(...validateMeetingGraphSourceRefs(output.meeting_graph as unknown as MeetingGraph).map((issue) => ({
          ...issue,
          path: `${path}.output.meeting_graph.${issue.path}`,
        })));
      }
    }
  }

  return issues;
}

export function isAiGraphJob(value: unknown): value is AiGraphJob {
  return validateAiGraphJob(value).length === 0;
}

export function assertAiGraphJob(value: unknown): asserts value is AiGraphJob {
  const issues = validateAiGraphJob(value);
  if (issues.length > 0) {
    throw new Error(`Invalid AI graph job: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
}

export function validateRuntimeSyncEvent(value: unknown): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path: '', message: 'must be an object' }];

  if (value.schema_version !== RUNTIME_SYNC_EVENT_SCHEMA_VERSION) {
    issues.push({ path: 'schema_version', message: `must be ${RUNTIME_SYNC_EVENT_SCHEMA_VERSION}` });
  }
  requireString(value, 'event_id', issues);
  requireString(value, 'source', issues);
  requireString(value, 'doc_id', issues);
  requireString(value, 'operation', issues);
  requireString(value, 'dedupe_key', issues);
  requireString(value, 'created_at', issues);
  requireString(value, 'updated_at', issues);

  const operation = String(value.operation);
  if (![
    'runtime.bootstrap',
    'block.update',
    'annotation.update',
    'annotation.add',
    'annotation.delete',
    'knowledge.update',
    'canvas.node.add',
    'canvas.node.delete',
    'progress.update',
    'source.rename',
  ].includes(operation)) {
    issues.push({ path: 'operation', message: 'must be a supported runtime operation' });
  }
  if (!['pending', 'sent', 'failed'].includes(String(value.status))) {
    issues.push({ path: 'status', message: 'must be pending, sent, or failed' });
  }
  const target = requireRecord(value, 'target', issues);
  if (target && !['document', 'block', 'annotation', 'knowledge_object', 'canvas_node', 'progress', 'source'].includes(String(target.type))) {
    issues.push({ path: 'target.type', message: 'must be a supported target type' });
  }
  const payload = requireRecord(value, 'payload', issues);
  validateOrigin(value.origin, issues);

  if (operation === 'runtime.bootstrap' && payload) validateRuntimeSnapshot(payload.snapshot, 'payload.snapshot', issues);
  if (operation === 'annotation.delete' && payload && typeof payload.ko_id !== 'string') {
    issues.push({ path: 'payload.ko_id', message: 'must be a non-empty string' });
  }
  if (operation === 'knowledge.update' && payload) {
    if (typeof payload.ko_id !== 'string' || !payload.ko_id) {
      issues.push({ path: 'payload.ko_id', message: 'must be a non-empty string' });
    }
    if (!isRecord(payload.patch)) {
      issues.push({ path: 'payload.patch', message: 'must be an object' });
    }
  }
  if (operation === 'progress.update' && payload && !isRecord(payload.progress)) {
    issues.push({ path: 'payload.progress', message: 'must be an object' });
  }
  if (operation === 'source.rename' && payload && typeof payload.source_path !== 'string') {
    issues.push({ path: 'payload.source_path', message: 'must be a non-empty string' });
  }

  return issues;
}

export function isRuntimeSyncEvent(value: unknown): value is RuntimeSyncEvent {
  return validateRuntimeSyncEvent(value).length === 0;
}

export function assertRuntimeSyncEvent(value: unknown): asserts value is RuntimeSyncEvent {
  const issues = validateRuntimeSyncEvent(value);
  if (issues.length > 0) {
    throw new Error(`Invalid runtime sync event: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
}
