import {
  alignMeetingEventMark,
  buildMeetingEventMark,
  buildPostProcessContext,
  type DocumentSchemaRef,
  type MeetingAxisSource,
  type MeetingEventMark,
  type MeetingMarkKind,
  type MeetingSession,
  type PostProcessContext,
  type ProjectMemoryRef,
  type SchemaAlignedEvent,
} from 'ink-surface-sdk/knowledge-schema';

export interface LarkTimelineMeetingSessionStart {
  platform?: string;
  meeting_id?: string;
  id?: string;
  title?: string;
  meeting_url?: string;
  start_time_ms?: number;
  start_time?: string;
  detector_source?: string;
  source_event_id?: string;
}

export interface LarkTimelineAnnotationIngest {
  id?: string;
  source?: string;
  captured_at_ms?: number;
  captured_at?: string;
  kind?: string;
  label?: string;
  text?: string;
  device_id?: string;
  raw_event_id?: string;
  meeting_session?: LarkTimelineMeetingSessionStart;
  mark?: MeetingEventMark['payload']['mark'];
}

export interface LarkTimelineAdapterOptions {
  nowMs?: number;
  createdAt?: string;
}

export interface LarkTimelineAlignmentInput extends LarkTimelineAdapterOptions {
  session?: MeetingSession | LarkTimelineMeetingSessionStart;
  documentRef?: DocumentSchemaRef | null;
  projectMemoryRefs?: ProjectMemoryRef[];
  payload?: Record<string, unknown>;
}

export interface LarkTimelinePostProcessInput extends LarkTimelineAdapterOptions {
  session: MeetingSession | LarkTimelineMeetingSessionStart;
  annotations: LarkTimelineAnnotationIngest[];
  documentRef?: DocumentSchemaRef | null;
  documentRefForAnnotation?: (annotation: LarkTimelineAnnotationIngest, mark: MeetingEventMark, index: number) => DocumentSchemaRef | null | undefined;
  projectMemoryRefs?: ProjectMemoryRef[];
  userFeedback?: PostProcessContext['user_feedback'];
}

export interface LarkTimelinePostProcessBundle {
  session: MeetingSession;
  meetingMarks: MeetingEventMark[];
  alignedEvents: SchemaAlignedEvent[];
  context: PostProcessContext;
}

function normalize(value: unknown): string {
  return String(value ?? '').trim();
}

function lower(value: unknown): string {
  return normalize(value).toLowerCase();
}

function safeId(value: string): string {
  return normalize(value)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72) || 'meeting';
}

function timeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function sessionStartMs(input: LarkTimelineMeetingSessionStart, nowMs: number): number {
  return timeMs(input.start_time_ms) ?? timeMs(input.start_time) ?? nowMs;
}

function annotationCapturedAtMs(annotation: LarkTimelineAnnotationIngest, nowMs: number): number {
  return timeMs(annotation.captured_at_ms) ?? timeMs(annotation.captured_at) ?? nowMs;
}

export function meetingAxisSourceFromLarkTimeline(input: LarkTimelineMeetingSessionStart): MeetingAxisSource {
  const detector = lower(input.detector_source);
  const source = lower(input.source_event_id);
  const value = `${detector} ${source}`;
  if (/tenant/.test(value) && /(scan|passive|search|probe)/.test(value)) return 'lark_tenant_passive_meeting_scan';
  if (/(passive|scan|search|probe)/.test(value)) return 'lark_passive_meeting_scan';
  if (/join/.test(value)) return 'lark_join_event';
  if (/(ws|http|event|lark_direct|meeting_start)/.test(value)) return 'lark_direct_event';
  return 'open_meeting_session';
}

export function meetingMarkKindFromLarkTimeline(annotation: LarkTimelineAnnotationIngest): MeetingMarkKind {
  const value = lower(`${annotation.kind ?? ''} ${annotation.label ?? ''} ${annotation.text ?? ''}`);
  if (/(decision|decide|决策|决定|结论)/.test(value)) return 'decision';
  if (/(action|todo|task|待办|任务|行动项)/.test(value)) return 'action';
  if (/(risk|blocker|风险|阻塞)/.test(value)) return 'risk';
  if (/(question|疑问|问题|why\?|为什么|q:|\bq\b)/.test(value)) return 'question';
  if (/(attention|关注|重点|注意)/.test(value)) return 'attention';
  return 'note';
}

export function meetingSessionFromLarkTimeline(
  input: LarkTimelineMeetingSessionStart,
  options: LarkTimelineAdapterOptions = {},
): MeetingSession {
  const nowMs = options.nowMs ?? Date.now();
  const startMs = sessionStartMs(input, nowMs);
  const title = normalize(input.title) || 'Lark Meeting';
  const meetingId = normalize(input.meeting_id)
    || normalize(input.id)
    || `lark_${safeId(`${title}_${input.meeting_url ?? ''}_${startMs}`)}`;
  const createdAt = options.createdAt ?? isoFromMs(nowMs);
  return {
    schema_version: 'inkloop.meeting_session.v1',
    meeting_id: meetingId,
    platform: lower(input.platform) === 'feishu' ? 'feishu' : 'lark',
    title,
    meeting_url: normalize(input.meeting_url) || undefined,
    start_time: isoFromMs(startMs),
    source: meetingAxisSourceFromLarkTimeline(input),
    source_event_id: normalize(input.source_event_id) || undefined,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function coerceSession(
  session: MeetingSession | LarkTimelineMeetingSessionStart | undefined,
  annotation: LarkTimelineAnnotationIngest,
  options: LarkTimelineAdapterOptions,
): MeetingSession {
  if (session && 'schema_version' in session) return session;
  return meetingSessionFromLarkTimeline(session ?? annotation.meeting_session ?? {}, options);
}

export function meetingEventMarkFromLarkTimeline(
  annotation: LarkTimelineAnnotationIngest,
  session?: MeetingSession | LarkTimelineMeetingSessionStart,
  options: LarkTimelineAdapterOptions = {},
): MeetingEventMark {
  const nowMs = options.nowMs ?? Date.now();
  const meetingSession = coerceSession(session, annotation, { ...options, nowMs });
  const meetingStartMs = Date.parse(meetingSession.start_time);
  const capturedAtMs = annotationCapturedAtMs(annotation, nowMs);
  const label = normalize(annotation.label) || normalize(annotation.text) || normalize(annotation.kind) || 'meeting mark';
  const id = normalize(annotation.id)
    || normalize(annotation.raw_event_id)
    || `ann_${safeId(`${meetingSession.meeting_id}_${capturedAtMs}_${label}`)}`;
  return buildMeetingEventMark({
    id,
    meetingId: meetingSession.meeting_id,
    meetingStartMs,
    capturedAtMs,
    source: normalize(annotation.source) || 'hanwang_epaper',
    kind: meetingMarkKindFromLarkTimeline(annotation),
    label,
    text: normalize(annotation.text) || label,
    mark: annotation.mark,
    deviceId: normalize(annotation.device_id) || undefined,
    rawEventId: normalize(annotation.raw_event_id) || undefined,
    createdAt: options.createdAt ?? isoFromMs(capturedAtMs),
  });
}

export function alignedEventFromLarkTimeline(
  annotation: LarkTimelineAnnotationIngest,
  input: LarkTimelineAlignmentInput = {},
): SchemaAlignedEvent {
  const session = coerceSession(input.session, annotation, input);
  const mark = meetingEventMarkFromLarkTimeline(annotation, session, input);
  return alignMeetingEventMark({
    mark,
    documentRef: input.documentRef,
    projectMemoryRefs: input.projectMemoryRefs,
    payload: input.payload,
    createdAt: input.createdAt,
  });
}

export function postProcessContextFromLarkTimeline(input: LarkTimelinePostProcessInput): LarkTimelinePostProcessBundle {
  const session = 'schema_version' in input.session
    ? input.session
    : meetingSessionFromLarkTimeline(input.session, input);
  const meetingMarks = input.annotations.map((annotation) => meetingEventMarkFromLarkTimeline(annotation, session, input));
  const alignedEvents = input.annotations.map((annotation, index) => {
    const mark = meetingMarks[index];
    const documentRef = input.documentRefForAnnotation?.(annotation, mark, index) ?? input.documentRef;
    return alignMeetingEventMark({
      mark,
      documentRef,
      projectMemoryRefs: input.projectMemoryRefs,
      payload: { sdk: 'Lark-Meeting-Timeline' },
      createdAt: input.createdAt,
    });
  });
  const context = buildPostProcessContext({
    traceId: meetingMarks[0]?.trace_id ?? `trace_${safeId(session.meeting_id)}`,
    alignedEvents,
    projectMemoryRefs: input.projectMemoryRefs,
    userFeedback: input.userFeedback,
    createdAt: input.createdAt,
  });
  return { session, meetingMarks, alignedEvents, context };
}
