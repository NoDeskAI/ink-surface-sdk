export const RUNTIME_SYNC_EVENT_SCHEMA_VERSION = 'inkloop.runtime_sync_event.v1' as const;
export const RUNTIME_SURFACE_OBJECT_SCHEMA_VERSION = 'inkloop.surface_object.v1' as const;
export const INKLOOP_AI_PEN_CONTRACT_VERSION = 'inkloop.ai_pen.v1' as const;
export const AI_GRAPH_JOB_SCHEMA_VERSION = 'inkloop.ai_graph_job.v1' as const;
export const CLASSROOM_SCHEMA_VERSION = 'inkloop.classroom.v1' as const;
export const CLASSROOM_MAX_STROKE_POINTS = 4_096;
export const CLASSROOM_MAX_PREVIEW_POINTS = 256;
export const CLASSROOM_WORLD_COORDINATE_LIMIT = 1_000_000;
export const CLASSROOM_WORLD_GEOMETRY_VERSION = 'classroom_page_world_v1' as const;

export interface RuntimeSchemaValidationIssue {
  path: string;
  message: string;
}

export type RuntimeNormBBox = [number, number, number, number];
export type ClassroomWorldBBox = [number, number, number, number];

export interface ClassroomWorldPoint {
  x_world: number;
  y_world: number;
  t_ms: number;
  pressure?: number;
}

export interface ClassroomSpatialRegion {
  coordinate_space: typeof CLASSROOM_WORLD_GEOMETRY_VERSION;
  surface: ClassroomSurfaceRef;
  bbox_world: ClassroomWorldBBox;
}

export interface ClassroomPageViewport {
  center_x_world: number;
  center_y_world: number;
  zoom_scale: number;
}

export interface ClassroomPageGeometry {
  page_index: number;
  width_world: number;
  height_world: number;
  rotation: 0 | 90 | 180 | 270;
}

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
    /** Tombstones produced by an eraser/undo action. Source strokes remain in the append-only ledger. */
    erased_event_ids?: string[];
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
      spatial_region?: ClassroomSpatialRegion;
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
      type: 'material_page';
      session_id: string;
      material_id: string;
      page_index: number;
      bbox_norm?: RuntimeNormBBox;
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

export type ClassroomStatus = 'draft' | 'live' | 'ended';
export type ClassroomRole = 'teacher' | 'participant';

export interface ClassroomCapabilities {
  textbook: boolean;
  recognition: boolean;
  audio: boolean;
  transcript: boolean;
}

export type ClassroomSurfaceRef =
  | { kind: 'teacher_board' }
  | { kind: 'textbook_page'; material_id: string; page_index: number }
  | { kind: 'scratch'; scratch_id: string; linked_material_id?: string; linked_page_index?: number; linked_bbox_norm?: RuntimeNormBBox };

export interface ClassroomMaterial {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  material_id: string;
  title: string;
  mime_type: 'application/pdf';
  byte_size: number;
  content_hash: `sha256:${string}`;
  page_count: number;
  page_geometries?: ClassroomPageGeometry[];
  source: 'builtin' | 'teacher_upload';
  published_at: string;
}

export interface ClassroomTeacherView {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  material_id: string;
  page_index: number;
  zoom_mode: 'fit-page' | 'fit-width' | 'percent';
  zoom_percent: number;
  viewport?: ClassroomPageViewport;
  page_viewports?: Record<string, ClassroomPageViewport>;
  active_surface: ClassroomSurfaceRef;
  revision: number;
  updated_at: string;
}

export interface ClassroomConfirmedFocus {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  focus_id: string;
  material_id: string;
  page_index: number;
  bbox_norm?: RuntimeNormBBox;
  spatial_region?: ClassroomSpatialRegion;
  confirmed_at: string;
}

export type ClassroomRecognitionStatus = 'pending' | 'confirmed' | 'corrected' | 'dismissed' | 'failed';

export interface ClassroomRecognitionRevision {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  recognition_id: string;
  revision: number;
  status: ClassroomRecognitionStatus;
  kind: 'formula' | 'text' | 'mixed';
  text: string;
  latex?: string;
  confidence: number;
  provider: string;
  processing_mode: 'local' | 'external';
  event_ids: string[];
  surface: ClassroomSurfaceRef;
  bbox_norm?: RuntimeNormBBox;
  spatial_region?: ClassroomSpatialRegion;
  error_code?: string;
  original_revision?: number;
  created_at: string;
  reviewed_at?: string;
}

export interface ClassroomRecordingState {
  recording_id: string;
  classroom_id: string;
  classroom_generation: number;
  recording_generation: number;
  state: 'recording' | 'stopped' | 'interrupted';
  health: 'healthy' | 'incomplete';
  sample_rate?: number;
  channels?: number;
  chunk_count: number;
  byte_count: number;
  last_sequence: number;
  last_relative_end_ms: number;
  started_at: string;
  stopped_at?: string;
  interrupted_at?: string;
}

export type ClassroomTranscriptRevisionStatus = 'provisional' | 'final' | 'corrected';

export interface ClassroomTranscriptRevision {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  transcript_id: string;
  revision: number;
  status: ClassroomTranscriptRevisionStatus;
  recording_id: string;
  recording_generation: number;
  chunk_id: string;
  chunk_hash: `sha256:${string}`;
  relative_start_ms: number;
  relative_end_ms: number;
  text: string;
  confidence: number;
  language: string;
  provider: string;
  processing_mode: 'local' | 'external';
  original_revision?: number;
  created_at: string;
  corrected_at?: string;
}

export interface ClassroomTranscriptionState {
  classroom_id: string;
  recording_id: string;
  recording_generation: number;
  state: 'transcribing' | 'ready' | 'delayed' | 'failed';
  provider: string;
  processing_mode: 'local' | 'external';
  processed_chunk_count: number;
  failed_chunk_count: number;
  retryable_chunk_ids?: string[];
  last_error_code?: string;
  audio_available: boolean;
  audio_deleted_at?: string;
  updated_at: string;
}

export type ClassroomDeliveryMode = 'audio_with_subtitles' | 'subtitles_only' | 'textbook_board_only';

export type ClassroomTimelineEntry =
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'board_event_ref';
      occurred_at: string;
      board_sequence: number;
      event_id: string;
      surface: ClassroomSurfaceRef;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'teacher_view';
      occurred_at: string;
      teacher_view: ClassroomTeacherView;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'confirmed_focus';
      occurred_at: string;
      confirmed_focus: ClassroomConfirmedFocus;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'material_published';
      occurred_at: string;
      material: ClassroomMaterial;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'recognition_revision';
      occurred_at: string;
      recognition: ClassroomRecognitionRevision;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'recording_state';
      occurred_at: string;
      recording: ClassroomRecordingState;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'transcript_revision';
      occurred_at: string;
      transcript: ClassroomTranscriptRevision;
    }
  | {
      schema_version: typeof CLASSROOM_SCHEMA_VERSION;
      classroom_id: string;
      timeline_sequence: number;
      kind: 'transcription_state';
      occurred_at: string;
      transcription: ClassroomTranscriptionState;
    };

export interface ClassroomSharedState {
  capabilities: ClassroomCapabilities;
  timeline_sequence: number;
  materials: ClassroomMaterial[];
  teacher_view?: ClassroomTeacherView;
  confirmed_focus?: ClassroomConfirmedFocus;
  recognitions?: ClassroomRecognitionRevision[];
  recording?: ClassroomRecordingState;
  transcripts?: ClassroomTranscriptRevision[];
  transcription?: ClassroomTranscriptionState;
}

export interface ClassroomSessionSummary {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  class_code?: string;
  title?: string;
  status: ClassroomStatus;
  role: ClassroomRole;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  latest_sequence: number;
  capabilities?: ClassroomCapabilities;
}

export interface ClassroomLegacyBoardEvent {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  sequence: number;
  client_event_id: string;
  accepted_at: string;
  event: InkEvent;
  stroke: InkLoopStroke;
  surface?: ClassroomSurfaceRef;
  geometry_version?: 'normalized_v1';
}

export interface ClassroomWorldBoardEvent {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  sequence: number;
  client_event_id: string;
  accepted_at: string;
  geometry_version: typeof CLASSROOM_WORLD_GEOMETRY_VERSION;
  surface: Extract<ClassroomSurfaceRef, { kind: 'textbook_page' }>;
  event: Omit<InkEvent, 'bbox_norm'> & { bbox_world: ClassroomWorldBBox };
  stroke: Omit<InkLoopStroke, 'points' | 'bbox_norm'> & { points_world: ClassroomWorldPoint[]; bbox_world: ClassroomWorldBBox };
}

export type ClassroomBoardEvent = ClassroomLegacyBoardEvent | ClassroomWorldBoardEvent;
export type ClassroomBoardEventInput =
  | Omit<ClassroomLegacyBoardEvent, 'sequence' | 'accepted_at'>
  | Omit<ClassroomWorldBoardEvent, 'sequence' | 'accepted_at'>;

export interface ClassroomLegacyPreview {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  client_event_id: string;
  revision: number;
  points: InkLoopStrokePoint[];
  tool: 'pen' | 'highlighter' | 'underline' | 'eraser';
  color?: string;
  expires_at_ms: number;
  surface?: ClassroomSurfaceRef;
  geometry_version?: 'normalized_v1';
}

export interface ClassroomWorldPreview {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  client_event_id: string;
  revision: number;
  geometry_version: typeof CLASSROOM_WORLD_GEOMETRY_VERSION;
  points_world: ClassroomWorldPoint[];
  tool: 'pen' | 'highlighter' | 'underline' | 'eraser';
  color?: string;
  expires_at_ms: number;
  surface: Extract<ClassroomSurfaceRef, { kind: 'textbook_page' }>;
}

export type ClassroomPreview = ClassroomLegacyPreview | ClassroomWorldPreview;

export interface ClassroomSnapshot {
  schema_version: typeof CLASSROOM_SCHEMA_VERSION;
  classroom_id: string;
  classroom_status: ClassroomStatus;
  snapshot_sequence: number;
  board_events: ClassroomBoardEvent[];
  capabilities?: ClassroomCapabilities;
  timeline_sequence?: number;
  materials?: ClassroomMaterial[];
  teacher_view?: ClassroomTeacherView;
  confirmed_focus?: ClassroomConfirmedFocus;
  recognitions?: ClassroomRecognitionRevision[];
  recording?: ClassroomRecordingState;
  transcripts?: ClassroomTranscriptRevision[];
  transcription?: ClassroomTranscriptionState;
  generated_at: string;
}

export interface ClassroomEvidenceCheckpoint {
  checkpoint_id: string;
  classroom_id: string;
  sequence_start: number;
  sequence_end: number;
  time_start_ms: number;
  time_end_ms: number;
  selection_bbox_norm?: RuntimeNormBBox;
  selection_region?: ClassroomSpatialRegion;
  source_refs: InkLoopSourceRef[];
  recognition_revision_fingerprint?: string;
  transcript_revision_fingerprint?: string;
  evidence_revision_fingerprint?: string;
}

export type ClassroomEvidenceIntent = 'current_step' | 'selected_region' | 'missed_segment' | 'class_summary' | 'practice' | 'lesson_graph';
export type ClassroomEvidenceTrustStatus = 'trusted' | 'needs_confirmation' | 'insufficient';

export interface ClassroomEvidenceBundle {
  intent: ClassroomEvidenceIntent;
  classroom_id: string;
  checkpoint: ClassroomEvidenceCheckpoint;
  fingerprint: string;
  trust_status: ClassroomEvidenceTrustStatus;
  missing_sources: Array<'material' | 'trusted_formula' | 'trusted_transcript'>;
  material?: {
    material_id: string;
    title: string;
    page_index: number;
    bbox_norm?: RuntimeNormBBox;
  };
  events: ClassroomBoardEvent[];
  recognitions: ClassroomRecognitionRevision[];
  transcripts: ClassroomTranscriptRevision[];
  source_refs: InkLoopSourceRef[];
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

function validateNonEmptyString(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (typeof value !== 'string' || value.trim() === '') issues.push({ path, message: 'must be a non-empty string' });
}

function validateIntegerAtLeast(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[], minimum: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    issues.push({ path, message: `must be an integer greater than or equal to ${minimum}` });
  }
}

function validateNormBBox(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 4) {
    issues.push({ path, message: 'must be a normalized [x, y, width, height] tuple' });
    return;
  }
  if (value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1)) {
    issues.push({ path, message: 'all values must be finite numbers between 0 and 1' });
    return;
  }
  if (value[0] + value[2] > 1 || value[1] + value[3] > 1) {
    issues.push({ path, message: 'rectangle must remain inside normalized bounds' });
  }
}

function validateWorldBBox(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 4) {
    issues.push({ path, message: 'must be a world [x, y, width, height] tuple' });
    return;
  }
  if (value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    issues.push({ path, message: 'all values must be finite numbers' });
    return;
  }
  if (Math.abs(value[0]) > CLASSROOM_WORLD_COORDINATE_LIMIT || Math.abs(value[1]) > CLASSROOM_WORLD_COORDINATE_LIMIT
    || value[2] < 0 || value[3] < 0 || value[2] > CLASSROOM_WORLD_COORDINATE_LIMIT || value[3] > CLASSROOM_WORLD_COORDINATE_LIMIT
    || Math.abs(value[0] + value[2]) > CLASSROOM_WORLD_COORDINATE_LIMIT || Math.abs(value[1] + value[3]) > CLASSROOM_WORLD_COORDINATE_LIMIT) {
    issues.push({ path, message: `must remain within ±${CLASSROOM_WORLD_COORDINATE_LIMIT} world units with non-negative size` });
  }
}

function validateWorldPoint(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) { issues.push({ path, message: 'must be an object' }); return; }
  validateNumberRange(value.x_world, `${path}.x_world`, issues, -CLASSROOM_WORLD_COORDINATE_LIMIT, CLASSROOM_WORLD_COORDINATE_LIMIT);
  validateNumberRange(value.y_world, `${path}.y_world`, issues, -CLASSROOM_WORLD_COORDINATE_LIMIT, CLASSROOM_WORLD_COORDINATE_LIMIT);
  validateFiniteNumber(value.t_ms, `${path}.t_ms`, issues);
  if (value.pressure !== undefined) validateNumberRange(value.pressure, `${path}.pressure`, issues, 0, 1);
}

function validateClassroomPoint(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  validateNumberRange(value.x_norm, `${path}.x_norm`, issues, 0, 1);
  validateNumberRange(value.y_norm, `${path}.y_norm`, issues, 0, 1);
  validateFiniteNumber(value.t_ms, `${path}.t_ms`, issues);
  if (value.pressure !== undefined) validateNumberRange(value.pressure, `${path}.pressure`, issues, 0, 1);
}

function validateClassroomSurface(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) { issues.push({ path, message: 'must be an object' }); return; }
  if (value.kind === 'teacher_board') return;
  if (value.kind === 'textbook_page') {
    validateNonEmptyString(value.material_id, `${path}.material_id`, issues);
    validateIntegerAtLeast(value.page_index, `${path}.page_index`, issues, 0);
    return;
  }
  if (value.kind === 'scratch') {
    validateNonEmptyString(value.scratch_id, `${path}.scratch_id`, issues);
    if (value.linked_material_id !== undefined) validateNonEmptyString(value.linked_material_id, `${path}.linked_material_id`, issues);
    if (value.linked_page_index !== undefined) validateIntegerAtLeast(value.linked_page_index, `${path}.linked_page_index`, issues, 0);
    if (value.linked_bbox_norm !== undefined) validateNormBBox(value.linked_bbox_norm, `${path}.linked_bbox_norm`, issues);
    return;
  }
  issues.push({ path: `${path}.kind`, message: 'must be teacher_board, textbook_page, or scratch' });
}

function validateClassroomSpatialRegion(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) { issues.push({ path, message: 'must be an object' }); return; }
  if (value.coordinate_space !== CLASSROOM_WORLD_GEOMETRY_VERSION) issues.push({ path: `${path}.coordinate_space`, message: `must be ${CLASSROOM_WORLD_GEOMETRY_VERSION}` });
  validateClassroomSurface(value.surface, `${path}.surface`, issues);
  validateWorldBBox(value.bbox_world, `${path}.bbox_world`, issues);
}

function validateClassroomPageViewport(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) { issues.push({ path, message: 'must be an object' }); return; }
  validateNumberRange(value.center_x_world, `${path}.center_x_world`, issues, -CLASSROOM_WORLD_COORDINATE_LIMIT, CLASSROOM_WORLD_COORDINATE_LIMIT);
  validateNumberRange(value.center_y_world, `${path}.center_y_world`, issues, -CLASSROOM_WORLD_COORDINATE_LIMIT, CLASSROOM_WORLD_COORDINATE_LIMIT);
  validateNumberRange(value.zoom_scale, `${path}.zoom_scale`, issues, 0.5, 4);
}

export function validateClassroomTeacherView(value: unknown, path = 'teacher_view'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateNonEmptyString(value.material_id, `${path}.material_id`, issues);
  validateIntegerAtLeast(value.page_index, `${path}.page_index`, issues, 0);
  if (!['fit-page', 'fit-width', 'percent'].includes(String(value.zoom_mode))) issues.push({ path: `${path}.zoom_mode`, message: 'must be fit-page, fit-width, or percent' });
  validateNumberRange(value.zoom_percent, `${path}.zoom_percent`, issues, 50, 400);
  if (value.viewport !== undefined) validateClassroomPageViewport(value.viewport, `${path}.viewport`, issues);
  if (value.page_viewports !== undefined) {
    if (!isRecord(value.page_viewports)) issues.push({ path: `${path}.page_viewports`, message: 'must be an object' });
    else for (const [key, viewport] of Object.entries(value.page_viewports)) {
      if (!/^[A-Za-z0-9_-]+:[0-9]+$/.test(key)) issues.push({ path: `${path}.page_viewports.${key}`, message: 'must use material_id:page_index keys' });
      validateClassroomPageViewport(viewport, `${path}.page_viewports.${key}`, issues);
    }
  }
  validateClassroomSurface(value.active_surface, `${path}.active_surface`, issues);
  if (isRecord(value.active_surface) && value.active_surface.kind === 'textbook_page'
    && (value.active_surface.material_id !== value.material_id || value.active_surface.page_index !== value.page_index)) {
    issues.push({ path: `${path}.active_surface`, message: 'must match teacher_view material_id and page_index' });
  }
  validateIntegerAtLeast(value.revision, `${path}.revision`, issues, 1);
  validateNonEmptyString(value.updated_at, `${path}.updated_at`, issues);
  return issues;
}

export function validateClassroomConfirmedFocus(value: unknown, path = 'confirmed_focus'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateNonEmptyString(value.focus_id, `${path}.focus_id`, issues);
  validateNonEmptyString(value.material_id, `${path}.material_id`, issues);
  validateIntegerAtLeast(value.page_index, `${path}.page_index`, issues, 0);
  if (value.bbox_norm === undefined && value.spatial_region === undefined) issues.push({ path, message: 'must include bbox_norm or spatial_region' });
  if (value.bbox_norm !== undefined) validateNormBBox(value.bbox_norm, `${path}.bbox_norm`, issues);
  if (value.spatial_region !== undefined) validateClassroomSpatialRegion(value.spatial_region, `${path}.spatial_region`, issues);
  if (isRecord(value.spatial_region) && isRecord(value.spatial_region.surface) && value.spatial_region.surface.kind === 'textbook_page'
    && (value.spatial_region.surface.material_id !== value.material_id || value.spatial_region.surface.page_index !== value.page_index)) {
    issues.push({ path: `${path}.spatial_region.surface`, message: 'must match confirmed focus material_id and page_index' });
  }
  validateNonEmptyString(value.confirmed_at, `${path}.confirmed_at`, issues);
  return issues;
}

export function validateClassroomRecognitionRevision(value: unknown, path = 'recognition'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateNonEmptyString(value.recognition_id, `${path}.recognition_id`, issues);
  validateIntegerAtLeast(value.revision, `${path}.revision`, issues, 1);
  if (!['pending', 'confirmed', 'corrected', 'dismissed', 'failed'].includes(String(value.status))) issues.push({ path: `${path}.status`, message: 'must be a supported recognition status' });
  if (!['formula', 'text', 'mixed'].includes(String(value.kind))) issues.push({ path: `${path}.kind`, message: 'must be formula, text, or mixed' });
  if (value.status !== 'failed' && value.status !== 'dismissed') validateNonEmptyString(value.text, `${path}.text`, issues);
  else if (typeof value.text !== 'string') issues.push({ path: `${path}.text`, message: 'must be a string' });
  if (value.latex !== undefined && typeof value.latex !== 'string') issues.push({ path: `${path}.latex`, message: 'must be a string' });
  validateNumberRange(value.confidence, `${path}.confidence`, issues, 0, 1);
  validateNonEmptyString(value.provider, `${path}.provider`, issues);
  if (!['local', 'external'].includes(String(value.processing_mode))) issues.push({ path: `${path}.processing_mode`, message: 'must be local or external' });
  if (!Array.isArray(value.event_ids) || value.event_ids.length === 0 || value.event_ids.length > 24) issues.push({ path: `${path}.event_ids`, message: 'must contain 1 to 24 event IDs' });
  else value.event_ids.forEach((eventId, index) => validateNonEmptyString(eventId, `${path}.event_ids.${index}`, issues));
  validateClassroomSurface(value.surface, `${path}.surface`, issues);
  if (value.bbox_norm === undefined && value.spatial_region === undefined) issues.push({ path, message: 'must include bbox_norm or spatial_region' });
  if (value.bbox_norm !== undefined) validateNormBBox(value.bbox_norm, `${path}.bbox_norm`, issues);
  if (value.spatial_region !== undefined) validateClassroomSpatialRegion(value.spatial_region, `${path}.spatial_region`, issues);
  if (value.original_revision !== undefined) validateIntegerAtLeast(value.original_revision, `${path}.original_revision`, issues, 1);
  validateNonEmptyString(value.created_at, `${path}.created_at`, issues);
  if (['confirmed', 'corrected', 'dismissed'].includes(String(value.status))) validateNonEmptyString(value.reviewed_at, `${path}.reviewed_at`, issues);
  if (value.status === 'failed') validateNonEmptyString(value.error_code, `${path}.error_code`, issues);
  return issues;
}

export function validateClassroomRecordingState(value: unknown, path = 'recording'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  validateNonEmptyString(value.recording_id, `${path}.recording_id`, issues);
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateIntegerAtLeast(value.classroom_generation, `${path}.classroom_generation`, issues, 1);
  validateIntegerAtLeast(value.recording_generation, `${path}.recording_generation`, issues, 1);
  if (!['recording', 'stopped', 'interrupted'].includes(String(value.state))) issues.push({ path: `${path}.state`, message: 'must be recording, stopped, or interrupted' });
  if (!['healthy', 'incomplete'].includes(String(value.health))) issues.push({ path: `${path}.health`, message: 'must be healthy or incomplete' });
  if (value.sample_rate !== undefined && ![16_000, 24_000, 44_100, 48_000].includes(Number(value.sample_rate))) issues.push({ path: `${path}.sample_rate`, message: 'must be a supported PCM sample rate' });
  if (value.channels !== undefined && ![1, 2].includes(Number(value.channels))) issues.push({ path: `${path}.channels`, message: 'must be mono or stereo' });
  for (const key of ['chunk_count', 'byte_count', 'last_sequence', 'last_relative_end_ms']) validateIntegerAtLeast(value[key], `${path}.${key}`, issues, 0);
  validateNonEmptyString(value.started_at, `${path}.started_at`, issues);
  if (value.stopped_at !== undefined) validateNonEmptyString(value.stopped_at, `${path}.stopped_at`, issues);
  if (value.interrupted_at !== undefined) validateNonEmptyString(value.interrupted_at, `${path}.interrupted_at`, issues);
  if (value.state === 'stopped' && value.stopped_at === undefined) issues.push({ path: `${path}.stopped_at`, message: 'is required when recording is stopped' });
  if (value.state === 'interrupted' && value.interrupted_at === undefined) issues.push({ path: `${path}.interrupted_at`, message: 'is required when recording is interrupted' });
  return issues;
}

export function validateClassroomTranscriptRevision(value: unknown, path = 'transcript'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  for (const key of ['classroom_id', 'transcript_id', 'recording_id', 'chunk_id', 'text', 'language', 'provider', 'created_at']) validateNonEmptyString(value[key], `${path}.${key}`, issues);
  validateIntegerAtLeast(value.revision, `${path}.revision`, issues, 1);
  validateIntegerAtLeast(value.recording_generation, `${path}.recording_generation`, issues, 1);
  if (!['provisional', 'final', 'corrected'].includes(String(value.status))) issues.push({ path: `${path}.status`, message: 'must be provisional, final, or corrected' });
  if (typeof value.chunk_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.chunk_hash)) issues.push({ path: `${path}.chunk_hash`, message: 'must be a sha256 content hash' });
  validateIntegerAtLeast(value.relative_start_ms, `${path}.relative_start_ms`, issues, 0);
  validateIntegerAtLeast(value.relative_end_ms, `${path}.relative_end_ms`, issues, 1);
  if (typeof value.relative_start_ms === 'number' && typeof value.relative_end_ms === 'number' && value.relative_end_ms <= value.relative_start_ms) issues.push({ path: `${path}.relative_end_ms`, message: 'must be after relative_start_ms' });
  validateNumberRange(value.confidence, `${path}.confidence`, issues, 0, 1);
  if (!['local', 'external'].includes(String(value.processing_mode))) issues.push({ path: `${path}.processing_mode`, message: 'must be local or external' });
  if (value.original_revision !== undefined) validateIntegerAtLeast(value.original_revision, `${path}.original_revision`, issues, 1);
  if (value.status === 'corrected') {
    if (value.original_revision === undefined) issues.push({ path: `${path}.original_revision`, message: 'is required for corrected transcripts' });
    validateNonEmptyString(value.corrected_at, `${path}.corrected_at`, issues);
  }
  return issues;
}

export function validateClassroomTranscriptionState(value: unknown, path = 'transcription'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  for (const key of ['classroom_id', 'recording_id', 'provider', 'updated_at']) validateNonEmptyString(value[key], `${path}.${key}`, issues);
  validateIntegerAtLeast(value.recording_generation, `${path}.recording_generation`, issues, 1);
  if (!['transcribing', 'ready', 'delayed', 'failed'].includes(String(value.state))) issues.push({ path: `${path}.state`, message: 'must be a supported transcription state' });
  if (!['local', 'external'].includes(String(value.processing_mode))) issues.push({ path: `${path}.processing_mode`, message: 'must be local or external' });
  validateIntegerAtLeast(value.processed_chunk_count, `${path}.processed_chunk_count`, issues, 0);
  validateIntegerAtLeast(value.failed_chunk_count, `${path}.failed_chunk_count`, issues, 0);
  if (value.retryable_chunk_ids !== undefined) {
    if (!Array.isArray(value.retryable_chunk_ids) || value.retryable_chunk_ids.length > 64) issues.push({ path: `${path}.retryable_chunk_ids`, message: 'must be an array with at most 64 chunk IDs' });
    else value.retryable_chunk_ids.forEach((chunkId, index) => validateNonEmptyString(chunkId, `${path}.retryable_chunk_ids.${index}`, issues));
  }
  if (typeof value.audio_available !== 'boolean') issues.push({ path: `${path}.audio_available`, message: 'must be boolean' });
  if (value.audio_deleted_at !== undefined) validateNonEmptyString(value.audio_deleted_at, `${path}.audio_deleted_at`, issues);
  if (value.audio_available === false && value.audio_deleted_at === undefined) issues.push({ path: `${path}.audio_deleted_at`, message: 'is required when audio is unavailable' });
  if (['delayed', 'failed'].includes(String(value.state))) validateNonEmptyString(value.last_error_code, `${path}.last_error_code`, issues);
  return issues;
}

export function validateClassroomTimelineEntry(value: unknown, path = 'timeline'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateIntegerAtLeast(value.timeline_sequence, `${path}.timeline_sequence`, issues, 1);
  validateNonEmptyString(value.occurred_at, `${path}.occurred_at`, issues);
  if (value.kind === 'board_event_ref') {
    validateIntegerAtLeast(value.board_sequence, `${path}.board_sequence`, issues, 1);
    validateNonEmptyString(value.event_id, `${path}.event_id`, issues);
    validateClassroomSurface(value.surface, `${path}.surface`, issues);
  } else if (value.kind === 'teacher_view') {
    issues.push(...validateClassroomTeacherView(value.teacher_view, `${path}.teacher_view`));
  } else if (value.kind === 'confirmed_focus') {
    issues.push(...validateClassroomConfirmedFocus(value.confirmed_focus, `${path}.confirmed_focus`));
  } else if (value.kind === 'material_published') {
    validateClassroomMaterial(value.material, `${path}.material`, issues);
  } else if (value.kind === 'recognition_revision') {
    issues.push(...validateClassroomRecognitionRevision(value.recognition, `${path}.recognition`));
  } else if (value.kind === 'recording_state') {
    issues.push(...validateClassroomRecordingState(value.recording, `${path}.recording`));
  } else if (value.kind === 'transcript_revision') {
    issues.push(...validateClassroomTranscriptRevision(value.transcript, `${path}.transcript`));
  } else if (value.kind === 'transcription_state') {
    issues.push(...validateClassroomTranscriptionState(value.transcription, `${path}.transcription`));
  } else issues.push({ path: `${path}.kind`, message: 'must be a supported timeline kind' });
  if ('points' in value || 'stroke' in value) issues.push({ path, message: 'timeline entries must reference board events without copying stroke points' });
  return issues;
}

function validateClassroomMaterial(value: unknown, path: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (!isRecord(value)) { issues.push({ path, message: 'must be an object' }); return; }
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateNonEmptyString(value.material_id, `${path}.material_id`, issues);
  validateNonEmptyString(value.title, `${path}.title`, issues);
  if (value.mime_type !== 'application/pdf') issues.push({ path: `${path}.mime_type`, message: 'must be application/pdf' });
  validateIntegerAtLeast(value.byte_size, `${path}.byte_size`, issues, 1);
  if (typeof value.content_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.content_hash)) issues.push({ path: `${path}.content_hash`, message: 'must be a sha256 content hash' });
  validateIntegerAtLeast(value.page_count, `${path}.page_count`, issues, 1);
  if (value.page_geometries !== undefined) {
    if (!Array.isArray(value.page_geometries) || value.page_geometries.length !== value.page_count) issues.push({ path: `${path}.page_geometries`, message: 'must contain exactly one geometry per page' });
    else value.page_geometries.forEach((geometry, index) => {
      if (!isRecord(geometry)) { issues.push({ path: `${path}.page_geometries.${index}`, message: 'must be an object' }); return; }
      if (geometry.page_index !== index) issues.push({ path: `${path}.page_geometries.${index}.page_index`, message: 'must match array index' });
      validateNumberRange(geometry.width_world, `${path}.page_geometries.${index}.width_world`, issues, 1, CLASSROOM_WORLD_COORDINATE_LIMIT);
      validateNumberRange(geometry.height_world, `${path}.page_geometries.${index}.height_world`, issues, 1, CLASSROOM_WORLD_COORDINATE_LIMIT);
      if (![0, 90, 180, 270].includes(Number(geometry.rotation))) issues.push({ path: `${path}.page_geometries.${index}.rotation`, message: 'must be 0, 90, 180, or 270' });
    });
  }
  if (!['builtin', 'teacher_upload'].includes(String(value.source))) issues.push({ path: `${path}.source`, message: 'must be builtin or teacher_upload' });
  validateNonEmptyString(value.published_at, `${path}.published_at`, issues);
}

export function validateClassroomBoardEvent(value: unknown, path = 'board_event'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateIntegerAtLeast(value.sequence, `${path}.sequence`, issues, 1);
  validateNonEmptyString(value.client_event_id, `${path}.client_event_id`, issues);
  validateNonEmptyString(value.accepted_at, `${path}.accepted_at`, issues);
  if (value.surface !== undefined) validateClassroomSurface(value.surface, `${path}.surface`, issues);

  const world = value.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION;
  if (value.geometry_version !== undefined && !world && value.geometry_version !== 'normalized_v1') issues.push({ path: `${path}.geometry_version`, message: 'must be normalized_v1 or classroom_page_world_v1' });
  if (world && (!isRecord(value.surface) || value.surface.kind !== 'textbook_page')) issues.push({ path: `${path}.surface`, message: 'world geometry requires a textbook_page surface' });
  if (!isRecord(value.event)) {
    issues.push({ path: `${path}.event`, message: 'must be an object' });
  } else {
    validateNonEmptyString(value.event.event_id, `${path}.event.event_id`, issues);
    validateNonEmptyString(value.event.session_id, `${path}.event.session_id`, issues);
    if (world) validateWorldBBox(value.event.bbox_world, `${path}.event.bbox_world`, issues);
    else validateNormBBox(value.event.bbox_norm, `${path}.event.bbox_norm`, issues);
    validateFiniteNumber(value.event.ts_start_ms, `${path}.event.ts_start_ms`, issues);
    validateFiniteNumber(value.event.ts_end_ms, `${path}.event.ts_end_ms`, issues);
    if (typeof value.event.ts_start_ms === 'number' && typeof value.event.ts_end_ms === 'number' && value.event.ts_end_ms < value.event.ts_start_ms) {
      issues.push({ path: `${path}.event.ts_end_ms`, message: 'must be greater than or equal to ts_start_ms' });
    }
    if (value.event.session_id !== value.classroom_id) issues.push({ path: `${path}.event.session_id`, message: 'must match classroom_id' });
  }

  if (!isRecord(value.stroke)) {
    issues.push({ path: `${path}.stroke`, message: 'must be an object' });
  } else {
    validateNonEmptyString(value.stroke.stroke_id, `${path}.stroke.stroke_id`, issues);
    validateNonEmptyString(value.stroke.session_id, `${path}.stroke.session_id`, issues);
    if (world) validateWorldBBox(value.stroke.bbox_world, `${path}.stroke.bbox_world`, issues);
    else validateNormBBox(value.stroke.bbox_norm, `${path}.stroke.bbox_norm`, issues);
    validateFiniteNumber(value.stroke.ts_start_ms, `${path}.stroke.ts_start_ms`, issues);
    validateFiniteNumber(value.stroke.ts_end_ms, `${path}.stroke.ts_end_ms`, issues);
    if (typeof value.stroke.ts_start_ms === 'number' && typeof value.stroke.ts_end_ms === 'number' && value.stroke.ts_end_ms < value.stroke.ts_start_ms) {
      issues.push({ path: `${path}.stroke.ts_end_ms`, message: 'must be greater than or equal to ts_start_ms' });
    }
    const points = world ? value.stroke.points_world : value.stroke.points;
    const pointsPath = world ? `${path}.stroke.points_world` : `${path}.stroke.points`;
    if (!Array.isArray(points) || points.length === 0) {
      issues.push({ path: pointsPath, message: 'must contain at least one point' });
    } else {
      if (points.length > CLASSROOM_MAX_STROKE_POINTS) {
        issues.push({ path: pointsPath, message: `must contain at most ${CLASSROOM_MAX_STROKE_POINTS} points` });
      }
      points.forEach((point, index) => world ? validateWorldPoint(point, `${pointsPath}.${index}`, issues) : validateClassroomPoint(point, `${pointsPath}.${index}`, issues));
    }
    if (value.stroke.session_id !== value.classroom_id) issues.push({ path: `${path}.stroke.session_id`, message: 'must match classroom_id' });
  }
  return issues;
}

export function validateClassroomPreview(value: unknown, path = 'preview'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  validateNonEmptyString(value.client_event_id, `${path}.client_event_id`, issues);
  validateIntegerAtLeast(value.revision, `${path}.revision`, issues, 0);
  const world = value.geometry_version === CLASSROOM_WORLD_GEOMETRY_VERSION;
  if (value.geometry_version !== undefined && !world && value.geometry_version !== 'normalized_v1') issues.push({ path: `${path}.geometry_version`, message: 'must be normalized_v1 or classroom_page_world_v1' });
  const points = world ? value.points_world : value.points;
  const pointsPath = world ? `${path}.points_world` : `${path}.points`;
  if (!Array.isArray(points) || points.length === 0) issues.push({ path: pointsPath, message: 'must contain at least one point' });
  else {
    if (points.length > CLASSROOM_MAX_PREVIEW_POINTS) issues.push({ path: pointsPath, message: `must contain at most ${CLASSROOM_MAX_PREVIEW_POINTS} points` });
    points.forEach((point, index) => world ? validateWorldPoint(point, `${pointsPath}.${index}`, issues) : validateClassroomPoint(point, `${pointsPath}.${index}`, issues));
  }
  if (!['pen', 'highlighter', 'underline', 'eraser'].includes(String(value.tool))) issues.push({ path: `${path}.tool`, message: 'must be a supported tool' });
  validateFiniteNumber(value.expires_at_ms, `${path}.expires_at_ms`, issues);
  if (value.surface !== undefined) validateClassroomSurface(value.surface, `${path}.surface`, issues);
  if (world && (!isRecord(value.surface) || value.surface.kind !== 'textbook_page')) issues.push({ path: `${path}.surface`, message: 'world geometry requires a textbook_page surface' });
  return issues;
}

export function validateClassroomSnapshot(value: unknown, path = 'snapshot'): RuntimeSchemaValidationIssue[] {
  const issues: RuntimeSchemaValidationIssue[] = [];
  if (!isRecord(value)) return [{ path, message: 'must be an object' }];
  if (value.schema_version !== CLASSROOM_SCHEMA_VERSION) issues.push({ path: `${path}.schema_version`, message: `must be ${CLASSROOM_SCHEMA_VERSION}` });
  validateNonEmptyString(value.classroom_id, `${path}.classroom_id`, issues);
  if (!['draft', 'live', 'ended'].includes(String(value.classroom_status))) issues.push({ path: `${path}.classroom_status`, message: 'must be draft, live, or ended' });
  validateIntegerAtLeast(value.snapshot_sequence, `${path}.snapshot_sequence`, issues, 0);
  if (!Array.isArray(value.board_events)) {
    issues.push({ path: `${path}.board_events`, message: 'must be an array' });
  } else {
    let previous = 0;
    value.board_events.forEach((event, index) => {
      if (!isRecord(event) || event.sequence !== previous + 1 || (typeof value.snapshot_sequence === 'number' && Number(event.sequence) > value.snapshot_sequence)) {
        issues.push({ path: `${path}.board_events.${index}`, message: 'must contain contiguous ordered events through snapshot_sequence' });
      }
      if (isRecord(event) && typeof event.sequence === 'number') previous = event.sequence;
      issues.push(...validateClassroomBoardEvent(event, `${path}.board_events.${index}`));
    });
    if (value.board_events.length === 0 && value.snapshot_sequence !== 0) issues.push({ path: `${path}.board_events`, message: 'cannot be empty when snapshot_sequence is non-zero' });
  }
  validateNonEmptyString(value.generated_at, `${path}.generated_at`, issues);
  if (value.timeline_sequence !== undefined) validateIntegerAtLeast(value.timeline_sequence, `${path}.timeline_sequence`, issues, 0);
  if (value.capabilities !== undefined) {
    if (!isRecord(value.capabilities)) issues.push({ path: `${path}.capabilities`, message: 'must be an object' });
    else for (const key of ['textbook', 'recognition', 'audio', 'transcript']) if (typeof value.capabilities[key] !== 'boolean') issues.push({ path: `${path}.capabilities.${key}`, message: 'must be boolean' });
  }
  if (value.materials !== undefined) {
    if (!Array.isArray(value.materials)) issues.push({ path: `${path}.materials`, message: 'must be an array' });
    else value.materials.forEach((material, index) => validateClassroomMaterial(material, `${path}.materials.${index}`, issues));
  }
  if (value.teacher_view !== undefined) issues.push(...validateClassroomTeacherView(value.teacher_view, `${path}.teacher_view`));
  if (value.confirmed_focus !== undefined) issues.push(...validateClassroomConfirmedFocus(value.confirmed_focus, `${path}.confirmed_focus`));
  if (value.recognitions !== undefined) {
    if (!Array.isArray(value.recognitions)) issues.push({ path: `${path}.recognitions`, message: 'must be an array' });
    else value.recognitions.forEach((recognition, index) => issues.push(...validateClassroomRecognitionRevision(recognition, `${path}.recognitions.${index}`)));
  }
  if (value.recording !== undefined) issues.push(...validateClassroomRecordingState(value.recording, `${path}.recording`));
  if (value.transcripts !== undefined) {
    if (!Array.isArray(value.transcripts)) issues.push({ path: `${path}.transcripts`, message: 'must be an array' });
    else value.transcripts.forEach((transcript, index) => issues.push(...validateClassroomTranscriptRevision(transcript, `${path}.transcripts.${index}`)));
  }
  if (value.transcription !== undefined) issues.push(...validateClassroomTranscriptionState(value.transcription, `${path}.transcription`));
  for (const forbidden of ['participant_id', 'private_jobs', 'private_results']) {
    if (forbidden in value) issues.push({ path: `${path}.${forbidden}`, message: 'private participant state is forbidden in shared snapshots' });
  }
  return issues;
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
