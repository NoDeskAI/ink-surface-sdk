export const RUNTIME_SYNC_EVENT_SCHEMA_VERSION = 'inkloop.runtime_sync_event.v1' as const;
export const RUNTIME_SURFACE_OBJECT_SCHEMA_VERSION = 'inkloop.surface_object.v1' as const;

export interface RuntimeSchemaValidationIssue {
  path: string;
  message: string;
}

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
  tool?: 'pen' | 'highlighter';
  color?: string;
  opacity?: number;
  points: RuntimeStrokePoint[];
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

export interface RuntimeDocumentSnapshot {
  doc_id: string;
  doc_dir: string;
  document: RuntimeDocumentRecord;
  source: RuntimeSourceRef;
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
  operation: 'block.update' | 'annotation.update' | 'annotation.add' | 'canvas.node.add';
  target: {
    type: 'document' | 'block' | 'annotation' | 'canvas_node';
    id?: string;
    block_id?: string;
  };
  payload: Record<string, unknown>;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, issues: RuntimeSchemaValidationIssue[]): void {
  if (typeof value[key] !== 'string' || value[key] === '') issues.push({ path: key, message: 'must be a non-empty string' });
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

  if (!['block.update', 'annotation.update', 'annotation.add', 'canvas.node.add'].includes(String(value.operation))) {
    issues.push({ path: 'operation', message: 'must be a supported runtime operation' });
  }
  if (!['pending', 'sent', 'failed'].includes(String(value.status))) {
    issues.push({ path: 'status', message: 'must be pending, sent, or failed' });
  }
  if (!isRecord(value.target)) {
    issues.push({ path: 'target', message: 'must be an object' });
  } else if (!['document', 'block', 'annotation', 'canvas_node'].includes(String(value.target.type))) {
    issues.push({ path: 'target.type', message: 'must be a supported target type' });
  }
  if (!isRecord(value.payload)) issues.push({ path: 'payload', message: 'must be an object' });

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
