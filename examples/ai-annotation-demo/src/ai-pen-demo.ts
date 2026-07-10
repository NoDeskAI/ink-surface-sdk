import './ai-pen-demo.css';
import {
  AI_GRAPH_JOB_SCHEMA_VERSION,
  INKLOOP_AI_PEN_CONTRACT_VERSION,
  validateAiGraphJob,
  validateLessonGraphSourceRefs,
  validateMeetingGraphSourceRefs,
  type AiGraphJob,
  type AiGraphJobStatus,
  type BoardObject,
  type InkEvent,
  type InkLoopSourceRef,
  type InkLoopStroke,
  type InkLoopStrokePoint,
  type InkLoopSessionMode,
  type LessonGraph,
  type MeetingGraph,
  type RawPenFrame,
  type RuntimeNormBBox,
  type RuntimeSchemaValidationIssue,
} from 'ink-surface-sdk/runtime-schema';
import {
  createRawPenFrameBridge,
  groupRawFramesIntoStrokes,
  parseAndValidateRawFrameRecords,
  pointFromRawFrame,
  RAW_PEN_FRAME_BRIDGE_NAME,
  validatorMessages,
  type RawPenFrameBridge,
} from './capture/raw-pen-stream';
import {
  buildLessonGraphKnowledgeObjects,
  buildMeetingGraphKnowledgeObjects,
  type KnowledgeObject,
  type KnowledgeStatus,
} from 'ink-surface-sdk/knowledge-schema';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';

type Scenario = Extract<InkLoopSessionMode, 'teach' | 'meeting'>;
type ReviewStatus = 'accepted' | 'edited' | 'dismissed';

interface ReviewDecision {
  status: ReviewStatus;
  editedText?: string;
}

interface DemoStroke {
  stroke: InkLoopStroke;
  event: InkEvent;
  path: string;
}

interface DemoState {
  scenario: Scenario;
  running: boolean;
  replaying: boolean;
  startedAt: number;
  strokes: DemoStroke[];
  objects: BoardObject[];
  lesson: LessonGraph | null;
  meeting: MeetingGraph | null;
  aiJob: AiGraphJob | null;
  validatorIssues: string[];
  reviewed: Record<string, ReviewDecision>;
  projectionMarkdown: string;
  projectionError: string | null;
  importSummary: string | null;
  bridgeSummary: string | null;
}

const appRoot = document.querySelector<HTMLDivElement>('#ai-pen-app');
if (!appRoot) throw new Error('missing #ai-pen-app');
const app = appRoot;

const state: DemoState = {
  scenario: 'teach',
  running: false,
  replaying: false,
  startedAt: Date.now(),
  strokes: [],
  objects: [],
  lesson: null,
  meeting: null,
  aiJob: null,
  validatorIssues: [],
  reviewed: {},
  projectionMarkdown: '',
  projectionError: null,
  importSummary: null,
  bridgeSummary: null,
};

function nowMs(): number {
  return Date.now() - state.startedAt;
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function bbox(points: readonly InkLoopStrokePoint[]): RuntimeNormBBox {
  const xs = points.map((p) => p.x_norm);
  const ys = points.map((p) => p.y_norm);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}

function pathFromPoints(points: readonly InkLoopStrokePoint[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x_norm.toFixed(4)} ${p.y_norm.toFixed(4)}`).join(' ');
}

function createFrame(point: InkLoopStrokePoint, tipState: RawPenFrame['tip_state']): RawPenFrame {
  return {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    pen_id: 'pen_kickstarter_p0',
    session_id: sessionId(),
    surface_id: 'capture_surface_a2_demo',
    ts_device_ms: point.t_ms,
    ts_host_ms: point.t_ms + 12,
    tip_state: tipState,
    pressure: point.pressure ?? 0.7,
    optical: {
      x_raw: Math.round(point.x_norm * 4096),
      y_raw: Math.round(point.y_norm * 2560),
      pattern_id: 'a2_grid_demo',
      quality: point.quality ?? 0.92,
    },
    firmware_version: '0.1.0',
  };
}

function sessionId(): string {
  return state.scenario === 'teach' ? 'sess_teacher_kickstarter' : 'sess_meeting_kickstarter';
}

function addStroke(points: InkLoopStrokePoint[], objectType?: BoardObject['type'], text?: string): DemoStroke {
  const strokeId = id('stroke');
  const stroke: InkLoopStroke = {
    stroke_id: strokeId,
    session_id: sessionId(),
    surface_id: 'capture_surface_a2_demo',
    pen_id: 'pen_kickstarter_p0',
    points,
    bbox_norm: bbox(points),
    ts_start_ms: points[0]?.t_ms ?? 0,
    ts_end_ms: points.at(-1)?.t_ms ?? 0,
    source_frame_refs: [
      createFrame(points[0], 'down').ts_device_ms.toString(),
      createFrame(points.at(-1) ?? points[0], 'up').ts_device_ms.toString(),
    ],
  };
  const event: InkEvent = {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    event_id: id('evt'),
    trace_id: id('trace'),
    session_id: stroke.session_id,
    surface_id: stroke.surface_id,
    pen_id: stroke.pen_id,
    event_type: 'stroke',
    stroke_refs: [stroke.stroke_id],
    bbox_norm: stroke.bbox_norm,
    ts_start_ms: stroke.ts_start_ms,
    ts_end_ms: stroke.ts_end_ms,
    source: { device: 'ai_pen', localization: 'encoded_surface', confidence: 0.92 },
    metadata: { mode: state.scenario, tool: 'pen' },
  };
  const item = { stroke, event, path: pathFromPoints(points) };
  state.strokes.push(item);

  if (objectType) {
    state.objects.push({
      object_id: id('obj'),
      session_id: stroke.session_id,
      surface_id: stroke.surface_id,
      type: objectType,
      bbox_norm: stroke.bbox_norm,
      stroke_refs: [stroke.stroke_id],
      hmp_refs: [id('hmp')],
      text_candidate: text,
      normalized_text: text?.toLowerCase(),
      confidence: 0.8,
      created_at_ms: stroke.ts_start_ms,
      updated_at_ms: stroke.ts_end_ms,
    });
  }

  return item;
}

function addImportedStroke(frames: RawPenFrame[], objectType?: BoardObject['type'], text?: string): DemoStroke | null {
  const points = frames
    .map((frame) => pointFromRawFrame(frame))
    .filter((point): point is InkLoopStrokePoint => Boolean(point));
  if (points.length < 2) return null;
  const firstFrame = frames[0];
  if (!firstFrame) return null;
  const strokeId = id('stroke');
  const surfaceId = firstFrame.surface_id || 'capture_surface_imported';
  const stroke: InkLoopStroke = {
    stroke_id: strokeId,
    session_id: firstFrame.session_id,
    surface_id: surfaceId,
    pen_id: firstFrame.pen_id,
    points,
    bbox_norm: bbox(points),
    ts_start_ms: points[0]?.t_ms ?? firstFrame.ts_device_ms,
    ts_end_ms: points.at(-1)?.t_ms ?? firstFrame.ts_device_ms,
    source_frame_refs: frames.map((frame) => String(frame.ts_device_ms)),
  };
  const qualityValues = frames.map((frame) => frame.optical?.quality).filter((value): value is number => typeof value === 'number');
  const confidence = qualityValues.length
    ? qualityValues.reduce((sum, value) => sum + value, 0) / qualityValues.length
    : 0.75;
  const event: InkEvent = {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    event_id: id('evt'),
    trace_id: id('trace'),
    session_id: stroke.session_id,
    surface_id: stroke.surface_id,
    pen_id: stroke.pen_id,
    event_type: 'stroke',
    stroke_refs: [stroke.stroke_id],
    bbox_norm: stroke.bbox_norm,
    ts_start_ms: stroke.ts_start_ms,
    ts_end_ms: stroke.ts_end_ms,
    source: { device: 'ai_pen', localization: 'encoded_surface', confidence },
    metadata: { mode: state.scenario, tool: 'pen' },
  };
  const item = { stroke, event, path: pathFromPoints(points) };
  state.strokes.push(item);

  if (objectType) {
    state.objects.push({
      object_id: id('obj'),
      session_id: stroke.session_id,
      surface_id: stroke.surface_id,
      type: objectType,
      bbox_norm: stroke.bbox_norm,
      stroke_refs: [stroke.stroke_id],
      hmp_refs: [id('hmp')],
      text_candidate: text,
      normalized_text: text?.toLowerCase(),
      confidence: Math.max(0.55, Math.min(0.98, confidence)),
      created_at_ms: stroke.ts_start_ms,
      updated_at_ms: stroke.ts_end_ms,
    });
  }

  return item;
}

function line(points: Array<[number, number]>, start = nowMs()): InkLoopStrokePoint[] {
  return points.map(([x, y], i) => ({
    x_norm: x,
    y_norm: y,
    t_ms: start + i * 38,
    pressure: 0.66 + (i % 3) * 0.06,
    quality: 0.9,
  }));
}

function sourceRefForEvent(event: InkEvent): InkLoopSourceRef {
  return {
    type: 'ink_event',
    session_id: event.session_id,
    event_id: event.event_id,
    ts_start_ms: event.ts_start_ms,
    ts_end_ms: event.ts_end_ms,
    bbox_norm: event.bbox_norm,
  };
}

function sourceRefForObject(object: BoardObject): InkLoopSourceRef {
  return {
    type: 'board_object',
    session_id: object.session_id,
    object_id: object.object_id,
    object_type: object.type,
    bbox_norm: object.bbox_norm,
  };
}

function meetingAudioContextRef(): InkLoopSourceRef {
  return {
    type: 'audio_segment',
    session_id: sessionId(),
    start_ms: 900,
    end_ms: 6200,
    speaker: 'Facilitator',
    transcript_ref: 'demo_meeting_context',
  };
}

function currentJobInput(): AiGraphJob['input'] {
  const sourceRefs = state.strokes.map((item) => sourceRefForEvent(item.event));
  const eventWindow = state.strokes.length > 0
    ? {
        start_ms: Math.min(...state.strokes.map((item) => item.event.ts_start_ms)),
        end_ms: Math.max(...state.strokes.map((item) => item.event.ts_end_ms)),
      }
    : { start_ms: 0, end_ms: 0 };
  return {
    ink_events: state.strokes.map((item) => item.event),
    board_objects: [...state.objects],
    scene_view: {
      schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
      scene_id: `scene_${sessionId()}`,
      session_id: sessionId(),
      mode: state.scenario,
      narrative: state.scenario === 'teach'
        ? 'Teacher board marks are converted into lesson step candidates.'
        : 'Meeting board marks are converted into decisions, actions, risks, and diagram candidates.',
      anchors: state.objects.map((object) => ({
        anchor_id: `anchor_${object.object_id}`,
        object_refs: [object.object_id],
        bbox_norm: object.bbox_norm,
        label: object.text_candidate,
      })),
      marked: state.objects.map((object) => ({
        object_ref: object.object_id,
        text: object.text_candidate,
        object_type: object.type,
        confidence: object.confidence,
      })),
      graph_summary: {
        node_count: state.objects.length,
        edge_count: Math.max(0, state.objects.length - 1),
        key_relations: state.scenario === 'teach' ? ['lesson_step_sequence'] : ['meeting_board_sequence'],
      },
      time_window: eventWindow,
      source_refs: sourceRefs,
    },
    optional_context: state.scenario === 'meeting'
      ? {
          transcript_ref: 'demo_meeting_context',
          audio_segment_refs: [meetingAudioContextRef()],
        }
      : undefined,
  };
}

function createAiGraphJob(status: AiGraphJobStatus): AiGraphJob {
  const timestamp = new Date().toISOString();
  return {
    schema_version: AI_GRAPH_JOB_SCHEMA_VERSION,
    job_id: id('job_ai_graph'),
    session_id: sessionId(),
    surface_id: 'capture_surface_a2_demo',
    mode: state.scenario,
    status,
    input: currentJobInput(),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function completeAiGraphJob(validatorIssues: RuntimeSchemaValidationIssue[]): AiGraphJob {
  const timestamp = new Date().toISOString();
  return {
    ...(state.aiJob ?? createAiGraphJob('running')),
    status: 'completed',
    output: {
      lesson_graph: state.lesson ?? undefined,
      meeting_graph: state.meeting ?? undefined,
      validator_issues: validatorIssues,
    },
    updated_at: timestamp,
    completed_at: timestamp,
  };
}

function objectTypeForImportedStroke(index: number): BoardObject['type'] {
  const teachTypes: BoardObject['type'][] = ['text', 'formula', 'formula', 'region'];
  const meetingTypes: BoardObject['type'][] = ['diagram_node', 'arrow', 'diagram_node', 'action_item', 'risk'];
  const types = state.scenario === 'teach' ? teachTypes : meetingTypes;
  return types[index] ?? (state.scenario === 'teach' ? 'text' : 'diagram_node');
}

function importedTextForObject(type: BoardObject['type'], index: number): string {
  if (state.scenario === 'teach') {
    if (type === 'formula') return index === 1 ? 'imported formula candidate' : 'imported solution candidate';
    if (type === 'region') return 'imported conclusion region';
    return 'imported lesson mark';
  }
  if (type === 'action_item') return 'imported action mark';
  if (type === 'risk') return 'imported risk mark';
  if (type === 'arrow') return 'imported relationship arrow';
  return 'imported diagram mark';
}

function importRawFrames(frames: RawPenFrame[], sourceName: string): void {
  state.startedAt = Date.now();
  state.strokes = [];
  state.objects = [];
  state.lesson = null;
  state.meeting = null;
  state.aiJob = null;
  state.validatorIssues = [];
  state.reviewed = {};
  state.projectionMarkdown = '';
  state.projectionError = null;
  state.running = false;
  state.replaying = false;
  state.bridgeSummary = state.bridgeSummary ?? `${RAW_PEN_FRAME_BRIDGE_NAME} ready`;
  const groups = groupRawFramesIntoStrokes(frames);
  groups.forEach((group, index) => {
    const objectType = objectTypeForImportedStroke(index);
    addImportedStroke(group, objectType, importedTextForObject(objectType, index));
  });
  state.importSummary = `imported ${state.strokes.length} InkEvents from ${sourceName}`;
  if (state.strokes.length === 0) {
    state.validatorIssues = ['RawPenFrame import did not contain complete down/up strokes with optical coordinates.'];
  }
}

async function importRawFrameFile(file: File): Promise<void> {
  const { records, issues } = parseAndValidateRawFrameRecords(await file.text());
  if (issues.length > 0) {
    state.validatorIssues = validatorMessages(issues).slice(0, 6);
    state.importSummary = `raw log import failed: ${file.name}`;
    render();
    return;
  }
  importRawFrames(records, file.name);
  render();
}

function installRawPenFrameBridge(): void {
  const bridge = createRawPenFrameBridge((frames, meta) => {
    importRawFrames(frames, `${meta.sourceName} (${meta.sourceKind})`);
    state.bridgeSummary = `${meta.sourceKind} accepted ${frames.length} RawPenFrames`;
    render();
  });
  const host = window as unknown as Window & Record<typeof RAW_PEN_FRAME_BRIDGE_NAME, RawPenFrameBridge>;
  host[RAW_PEN_FRAME_BRIDGE_NAME] = bridge;
  state.bridgeSummary = `${RAW_PEN_FRAME_BRIDGE_NAME} ready`;
}

function reset(): void {
  state.startedAt = Date.now();
  state.strokes = [];
  state.objects = [];
  state.lesson = null;
  state.meeting = null;
  state.aiJob = null;
  state.validatorIssues = [];
  state.reviewed = {};
  state.projectionMarkdown = '';
  state.projectionError = null;
  state.importSummary = null;
  state.bridgeSummary = `${RAW_PEN_FRAME_BRIDGE_NAME} ready`;
  state.running = false;
  state.replaying = false;
  render();
}

function runScenario(): void {
  reset();
  state.running = true;

  const schedule = state.scenario === 'teach'
    ? [
        () => addStroke(line([[0.12, 0.18], [0.28, 0.18], [0.42, 0.18]]), 'text', 'Complete the square'),
        () => addStroke(line([[0.16, 0.34], [0.24, 0.32], [0.34, 0.36], [0.45, 0.34]]), 'formula', 'x^2 + 2x + 1'),
        () => addStroke(line([[0.18, 0.48], [0.3, 0.48], [0.42, 0.48], [0.52, 0.48]]), 'formula', '(x+1)^2'),
        () => addStroke(line([[0.12, 0.62], [0.58, 0.62]]), 'region', 'boxed conclusion'),
      ]
    : [
        () => addStroke(line([[0.14, 0.22], [0.28, 0.22], [0.28, 0.34], [0.14, 0.34], [0.14, 0.22]]), 'diagram_node', 'Web Host'),
        () => addStroke(line([[0.35, 0.28], [0.55, 0.28], [0.52, 0.25], [0.55, 0.28], [0.52, 0.31]]), 'arrow', 'sync path'),
        () => addStroke(line([[0.62, 0.22], [0.78, 0.22], [0.78, 0.34], [0.62, 0.34], [0.62, 0.22]]), 'diagram_node', 'Event Ledger'),
        () => addStroke(line([[0.16, 0.56], [0.34, 0.56], [0.48, 0.56]]), 'action_item', 'next: lock schema'),
        () => addStroke(line([[0.62, 0.55], [0.82, 0.55]]), 'risk', 'risk: surface glare'),
      ];

  schedule.forEach((fn, index) => {
    window.setTimeout(() => {
      fn();
      if (index === schedule.length - 1) state.running = false;
      render();
    }, index * 380);
  });
}

function generateAi(): void {
  if (state.strokes.length === 0) runScenario();
  state.aiJob = null;
  state.validatorIssues = [];
  render();
  window.setTimeout(() => {
    state.aiJob = createAiGraphJob('running');
    render();
    window.setTimeout(() => {
      const sourceIssues = state.scenario === 'teach' ? generateLesson() : generateMeeting();
      state.aiJob = completeAiGraphJob(sourceIssues);
      const jobIssues = validateAiGraphJob(state.aiJob);
      state.validatorIssues = validatorMessages([...sourceIssues, ...jobIssues]);
      render();
    }, 120);
  }, state.running ? 1800 : 0);
}

function generateLesson(): RuntimeSchemaValidationIssue[] {
  state.reviewed = {};
  state.projectionMarkdown = '';
  state.projectionError = null;
  const refs = state.strokes.map((s) => sourceRefForEvent(s.event));
  const formulaObject = state.objects.find((o) => o.type === 'formula');
  const formulaRefs = formulaObject ? [sourceRefForObject(formulaObject)] : refs.slice(0, 1);
  state.lesson = {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    lesson_id: 'lesson_kickstarter_demo',
    session_id: sessionId(),
    title: 'Completing the square',
    steps: [
      {
        step_id: 'step_define',
        order: 1,
        kind: 'definition',
        content: 'Identify the quadratic expression and keep the original board trace visible for replay.',
        board_object_refs: state.objects.slice(0, 1).map((o) => o.object_id),
        source_refs: refs.slice(0, 1),
        confidence: 0.86,
      },
      {
        step_id: 'step_formula',
        order: 2,
        kind: 'formula',
        content: 'Convert x^2 + 2x + 1 into (x + 1)^2. Mark as editable because formula recognition is reviewable.',
        latex: '(x + 1)^2',
        board_object_refs: formulaObject ? [formulaObject.object_id] : [],
        source_refs: formulaRefs,
        confidence: 0.76,
      },
    ],
    concepts: [{
      concept_id: 'concept_square',
      name: 'Completing the square',
      explanation: 'A reversible algebra step captured from the board sequence.',
      source_refs: refs.slice(0, 2),
    }],
    exports: { markdown: '# Completing the square\n\n- Editable lesson notes\n- Stroke replay retained' },
  };
  const issues = validateLessonGraphSourceRefs(state.lesson);
  state.validatorIssues = validatorMessages(issues);
  return issues;
}

function generateMeeting(): RuntimeSchemaValidationIssue[] {
  state.reviewed = {};
  state.projectionMarkdown = '';
  state.projectionError = null;
  const refs = state.strokes.map((s) => sourceRefForEvent(s.event));
  const action = state.objects.find((o) => o.type === 'action_item');
  const risk = state.objects.find((o) => o.type === 'risk');
  const audioContext = meetingAudioContextRef();
  const diagramRefs = state.objects
    .filter((o) => ['diagram_node', 'arrow', 'shape'].includes(o.type))
    .slice(0, 3)
    .map(sourceRefForObject);

  state.meeting = {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    meeting_id: 'meeting_kickstarter_demo',
    session_id: sessionId(),
    title: 'Architecture whiteboard review',
    decisions: [{
      decision_id: 'decision_event_ledger',
      content: 'Use the event ledger as the system source of truth.',
      source_refs: refs.slice(0, 3),
      confidence: 0.84,
    }],
    actions: [{
      action_id: 'action_schema',
      content: 'Lock PenFrame / InkEvent schema before firmware and host integration.',
      owner: 'Runtime',
      status: 'candidate',
      source_refs: action ? [sourceRefForObject(action), audioContext] : [...refs.slice(0, 1), audioContext],
      confidence: 0.82,
    }],
    risks: [{
      risk_id: 'risk_surface_glare',
      content: 'Surface glare can lower optical quality and must stay on the material test board.',
      severity: 'high',
      source_refs: risk ? [sourceRefForObject(risk)] : refs.slice(-1),
      confidence: 0.74,
    }],
    diagrams: [{
      diagram_id: 'diagram_runtime',
      type: 'architecture',
      mermaid: 'flowchart LR\n  Host --> Ledger\n  Ledger --> InkGraph\n  InkGraph --> Actions',
      source_refs: diagramRefs.length >= 2 ? diagramRefs : refs.slice(0, 2),
      confidence: 0.72,
    }],
  };
  const issues = validateMeetingGraphSourceRefs(state.meeting);
  state.validatorIssues = validatorMessages(issues);
  return issues;
}
function replay(): void {
  if (state.strokes.length === 0) return;
  state.replaying = true;
  const saved = [...state.strokes];
  state.strokes = [];
  state.objects = [];
  state.lesson = null;
  state.meeting = null;
  state.aiJob = null;
  state.validatorIssues = [];
  state.reviewed = {};
  state.projectionMarkdown = '';
  state.projectionError = null;
  render();
  saved.forEach((item, index) => {
    window.setTimeout(() => {
      state.strokes.push(item);
      if (index === saved.length - 1) state.replaying = false;
      render();
    }, index * 320);
  });
}

function statusText(): string {
  if (state.running) return 'capturing pen stream';
  if (state.replaying) return 'replaying session';
  if (state.importSummary) return state.importSummary;
  if (state.strokes.length > 0) return 'session recorded';
  return 'ready';
}

function renderResults(): string {
  if (state.scenario === 'teach') {
    if (!state.lesson) return '<div class="empty">运行 Teacher Demo 后生成 LessonGraph 候选讲义。每个 step 必须保留 source_refs。</div>';
    return `
      <div class="section"><h3>LessonGraph</h3>
        ${state.lesson.steps.map((step) => `
          <article class="result ${step.confidence < 0.8 ? 'warn' : ''}">
            <h4>${step.order}. ${step.kind}</h4>
            <p>${step.content}</p>
            <div class="refs">${step.source_refs.map(renderRef).join('')}</div>
            ${renderReviewControls(step.step_id)}
          </article>
        `).join('')}
      </div>
      <div class="section"><h3>Export Preview</h3><article class="result"><p>${state.lesson.exports?.markdown ?? 'Markdown export pending'}</p></article></div>
    `;
  }
  if (!state.meeting) return '<div class="empty">运行 Meeting Demo 后生成 MeetingGraph 候选行动项、决策、风险和图解。</div>';
  return `
    <div class="section"><h3>MeetingGraph</h3>
      ${state.meeting.decisions.map((item) => renderResult(item.decision_id, 'Decision', item.content, item.source_refs, item.confidence)).join('')}
      ${state.meeting.actions.map((item) => renderResult(item.action_id, 'Action candidate', item.content, item.source_refs, item.confidence)).join('')}
      ${state.meeting.risks.map((item) => renderResult(item.risk_id, 'Risk', item.content, item.source_refs, item.confidence)).join('')}
      ${state.meeting.diagrams.map((item) => renderResult(item.diagram_id, 'Diagram beta', item.mermaid ?? 'Diagram export pending', item.source_refs, item.confidence)).join('')}
    </div>
  `;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderResult(key: string, title: string, content: string, refs: InkLoopSourceRef[], confidence: number): string {
  return `
    <article class="result ${confidence < 0.8 ? 'warn' : ''}">
      <h4>${title} · ${(confidence * 100).toFixed(0)}%</h4>
      <p>${content}</p>
      <div class="refs">${refs.map(renderRef).join('')}</div>
      ${renderReviewControls(key)}
    </article>
  `;
}

function renderReviewControls(key: string): string {
  const decision = state.reviewed[key];
  const status = decision?.status;
  const statusText = status
    ? status === 'dismissed'
      ? 'Dismissed. Not promoted to KnowledgeObject.'
      : `KnowledgeObject ${status}. Obsidian projection ready.`
    : 'Candidate only. Review before KnowledgeObject promotion.';
  const editor = status === 'edited'
    ? `
      <label class="edited-copy">
        <strong>Edited body</strong>
        <textarea data-review-edit-key="${escapeHtml(key)}" rows="4">${escapeHtml(decision?.editedText ?? '')}</textarea>
      </label>
      <button type="button" data-review-save-key="${escapeHtml(key)}">Apply Edit</button>
    `
    : '';
  return `
    <div class="review" data-status="${status ?? 'candidate'}">
      <span>${statusText}</span>
      ${editor}
      <button type="button" data-review-key="${key}" data-review-action="accepted">Accept</button>
      <button type="button" data-review-key="${key}" data-review-action="edited">Edit</button>
      <button type="button" data-review-key="${key}" data-review-action="dismissed">Dismiss</button>
    </div>
  `;
}

function reviewedStatusById(): Partial<Record<string, KnowledgeStatus>> {
  return Object.fromEntries(
    Object.entries(state.reviewed).map(([key, decision]) => [key, decision.status]),
  );
}

function editedBodyById(): Partial<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(state.reviewed)
      .filter(([, decision]) => decision.status === 'edited' && decision.editedText)
      .map(([key, decision]) => [key, decision.editedText ?? '']),
  );
}

function demoEditedText(key: string): string | undefined {
  if (key === 'step_formula') {
    return [
      'Edited: Complete the square by rewriting x^2 + 2x + 1 as (x + 1)^2, then keep the original stroke replay as evidence.',
      '',
      'Formula: (x + 1)^2',
    ].join('\n');
  }
  if (key === 'action_schema') {
    return [
      'Edited: Lock PenFrame and InkEvent schema before firmware integration, then freeze the host projection contract for the MVP smoke test.',
      '',
      'Owner: Runtime',
    ].join('\n');
  }
  if (key.startsWith('decision_')) return 'Edited: Decision reviewed and retained with the original marked board evidence.';
  if (key.startsWith('risk_')) return 'Edited: Risk reviewed and retained with marked board evidence.';
  if (key.startsWith('diagram_')) return 'Edited: Diagram retained as a follow-up candidate with source refs.';
  if (key.startsWith('step_')) return 'Edited: Lesson step reviewed and retained with the original stroke evidence.';
  if (key.startsWith('concept_')) return 'Edited: Concept reviewed and retained with the original lesson evidence.';
  return undefined;
}

async function refreshProjectionPreview(): Promise<void> {
  const documentId = state.scenario === 'teach' ? 'doc_ai_pen_lesson_demo' : 'doc_ai_pen_meeting_demo';
  const documentTitle = state.scenario === 'teach' ? 'AI Pen Education Demo' : 'AI Pen Meeting Demo';
  const options = {
    documentId,
    documentTitle,
    now: new Date().toISOString(),
    statusById: reviewedStatusById(),
    bodyOverridesById: editedBodyById(),
  };
  try {
    const knowledgeObjects: KnowledgeObject[] = state.scenario === 'teach' && state.lesson
      ? await buildLessonGraphKnowledgeObjects(state.lesson, options)
      : state.scenario === 'meeting' && state.meeting
        ? await buildMeetingGraphKnowledgeObjects(state.meeting, options)
        : [];
    const files = knowledgeObjects.length
      ? renderVaultMarkdown({
          entities: [{
            documentId,
            documentTitle,
            mode: state.scenario === 'meeting' ? 'meeting' : 'reading',
            dates: [new Date().toISOString().slice(0, 10)],
            knowledgeObjects,
            documentProjections: [],
          }],
        })
      : [];
    state.projectionMarkdown = files.length
      ? files.map((file) => `// ${file.path}\n${file.markdown.trim()}`).join('\n\n---\n\n')
      : 'No accepted or edited KnowledgeObjects yet.';
    state.projectionError = null;
  } catch (error) {
    state.projectionMarkdown = '';
    state.projectionError = String((error as Error)?.message || error);
  }
}

function renderRef(ref: InkLoopSourceRef): string {
  if (ref.type === 'ink_event') return `<span class="ref">ink:${ref.event_id.slice(-6)}</span>`;
  if (ref.type === 'board_object') return `<span class="ref">${ref.object_type}:${ref.object_id.slice(-6)}</span>`;
  if (ref.type === 'audio_segment') return '<span class="ref">audio</span>';
  return '<span class="ref">memory</span>';
}

function reviewCount(status: ReviewStatus): number {
  return Object.values(state.reviewed).filter((decision) => decision.status === status).length;
}

function renderLaunchReadiness(): string {
  const promoted = reviewCount('accepted') + reviewCount('edited');
  const dismissed = reviewCount('dismissed');
  const captureState = state.importSummary
    ? 'RawPenFrame log imported'
    : state.strokes.length > 0
      ? 'Demo stream recorded'
      : 'Ready for capture';
  const bridgeState = state.bridgeSummary ?? `${RAW_PEN_FRAME_BRIDGE_NAME} ready`;
  const outputState = state.scenario === 'teach'
    ? 'Education LessonGraph'
    : 'MeetingGraph actions/decisions/risks';
  const aiJobState = state.aiJob
    ? state.aiJob.status === 'completed'
      ? `AI Graph Job completed · ${state.aiJob.job_id}`
      : `AI Graph Job ${state.aiJob.status} · ${state.aiJob.job_id}`
    : 'Waiting for Generate AI';
  const meetingEvidenceCard = state.scenario === 'meeting'
    ? `
        <div class="readiness-card" data-launch-card="meeting-evidence">
          <b>Meeting Event Marks</b>
          <span>board/ink evidence required · audio/subtitles/timeline optional context</span>
        </div>
      `
    : '';
  return `
    <div class="readiness" aria-label="V1 launch chain status">
      <div class="readiness-head">
        <span>V1 Launch Chain</span>
        <strong>${state.scenario === 'teach' ? 'Education' : 'Business Meeting'}</strong>
      </div>
      <div class="readiness-grid">
        <div class="readiness-card" data-launch-card="capture">
          <b>AI Pen + Capture Surface</b>
          <span>${captureState}</span>
        </div>
        <div class="readiness-card" data-launch-card="hardware-ingress">
          <b>Hardware Ingress</b>
          <span>${bridgeState}</span>
        </div>
        <div class="readiness-card" data-launch-card="inkgraph">
          <b>InkGraph Output</b>
          <span>${outputState}</span>
        </div>
        ${meetingEvidenceCard}
        <div class="readiness-card" data-launch-card="ai-graph-job">
          <b>AI Graph Job</b>
          <span>${aiJobState}</span>
        </div>
        <div class="readiness-card" data-launch-card="review">
          <b>User Review Gate</b>
          <span>${promoted} promoted / ${dismissed} dismissed</span>
        </div>
        <div class="readiness-card" data-launch-card="source-unit">
          <b>Source File Unit</b>
          <span>inkloop_document_id + inkloop://doc keep projections grouped</span>
        </div>
        <div class="readiness-card" data-launch-card="obsidian">
          <b>Obsidian Projection Only</b>
          <span>Backlinks keep inkloop://doc source trace</span>
        </div>
        <div class="readiness-card blocked" data-launch-card="prelaunch">
          <b>Pre-Launch / Notify me</b>
          <span>prelaunch_page_not_ready · preview URL, live URL, owner review, and GTM proof missing</span>
        </div>
        <div class="readiness-card blocked" data-launch-card="launch-ops-queue">
          <b>Launch Ops Queue</b>
          <span>86 P0 inputs · supplier, page review, pre-launch, and signoff queue</span>
        </div>
        <div class="readiness-card blocked" data-launch-card="launch-freeze">
          <b>Launch Freeze Go/No-Go</b>
          <span>0/13 gates ready · preview/legal/BOM/GTM/proof shots/human signoff missing</span>
        </div>
      </div>
    </div>
  `;
}

function render(): void {
  const latest = state.strokes.at(-1);
  const latency = latest ? Math.max(24, latest.event.ts_end_ms - latest.event.ts_start_ms + 24) : 0;
  const validatorClass = state.validatorIssues.length === 0 ? 'good' : 'bad';
  const validatorText = state.validatorIssues.length === 0
    ? 'SourceRefs validator passed. AI Graph Job contract passed. AI candidates can enter user review.'
    : state.validatorIssues.join(' / ');

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <strong>InkLoop AI Pen</strong>
          <span>Kickstarter V1 Capture Host</span>
        </div>
        <div class="actions">
          <div class="segmented" aria-label="scenario">
            <button type="button" data-scenario="teach" aria-pressed="${state.scenario === 'teach'}">Education</button>
            <button type="button" data-scenario="meeting" aria-pressed="${state.scenario === 'meeting'}">Meeting</button>
          </div>
          <button class="action primary" type="button" data-action="run">Run Demo</button>
          <button class="action" type="button" data-action="import">Import Raw Log</button>
          <input class="file-input" type="file" data-action="raw-log-file" accept=".json,.jsonl,application/json">
          <button class="action" type="button" data-action="ai">Generate AI</button>
          <button class="action" type="button" data-action="replay" ${state.strokes.length ? '' : 'disabled'}>Replay</button>
          <button class="action" type="button" data-action="clear">Clear</button>
        </div>
      </header>

      <main class="workspace">
        <section class="stage">
          <div class="stage-head">
            <div>
              <h1>${state.scenario === 'teach' ? 'Teacher Live Board' : 'Meeting Live Board'}</h1>
              <p>AI Pen stream -> InkEvent ledger -> InkGraph candidates -> validated outputs</p>
            </div>
            <div class="metric-row">
              <div class="metric"><b>${state.strokes.length}</b><span>InkEvents</span></div>
              <div class="metric"><b>${latency || '--'}ms</b><span>demo latency</span></div>
              <div class="metric"><b>${state.objects.length}</b><span>BoardObjects</span></div>
            </div>
          </div>
          <div class="board-wrap">
            <div class="board" id="board">
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Capture Surface">
                ${state.strokes.map((item, index) => `<path d="${item.path}" class="${index === state.strokes.length - 1 ? 'live' : ''}"></path>`).join('')}
              </svg>
              <div class="board-label"><span class="pulse"></span><span>${statusText()} · A2 Capture Surface simulator</span></div>
            </div>
          </div>
          <div class="timeline">
            <div class="timeline-head">
              <span class="statusline">Event Ledger</span>
              <span class="statusline">${sessionId()}</span>
            </div>
            <div class="event-list">
              ${state.strokes.slice(-4).map((item) => `
                <div class="event">
                  <strong>${item.event.event_id}</strong>
                  <span>${item.event.event_type} · ${item.event.source.localization}</span><br>
                  <span>${item.event.ts_start_ms}-${item.event.ts_end_ms} ms</span>
                </div>
              `).join('') || '<div class="empty">No events yet. Run demo or draw on the board.</div>'}
            </div>
          </div>
        </section>

        <aside class="side">
          <div class="panel-head">
            <div>
              <h2>${state.scenario === 'teach' ? 'Education Output' : 'Meeting Output'}</h2>
              <p>${state.scenario === 'teach' ? 'Lesson notes and step replay candidates' : 'Actions, decisions, risks, diagram beta'}</p>
            </div>
          </div>
          ${renderLaunchReadiness()}
          <div class="panel-body">${renderResults()}</div>
          <div class="validator ${validatorClass}">${validatorText}</div>
          <div class="projection">
            <h3>Obsidian Projection Preview</h3>
            ${state.projectionError
              ? `<div class="empty bad">${escapeHtml(state.projectionError)}</div>`
              : `<pre>${escapeHtml(state.projectionMarkdown || 'Accept or edit a candidate to render clean Obsidian Markdown.')}</pre>`}
          </div>
        </aside>
      </main>
    </div>
  `;

  bind();
}

function bind(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => {
      state.scenario = button.dataset.scenario as Scenario;
      reset();
    });
  });
  app.querySelector<HTMLButtonElement>('[data-action="run"]')?.addEventListener('click', runScenario);
  app.querySelector<HTMLButtonElement>('[data-action="import"]')?.addEventListener('click', () => {
    app.querySelector<HTMLInputElement>('[data-action="raw-log-file"]')?.click();
  });
  const rawLogInput = app.querySelector<HTMLInputElement>('[data-action="raw-log-file"]');
  rawLogInput?.addEventListener('change', () => {
    const input = rawLogInput;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void importRawFrameFile(file).catch((error) => {
      state.validatorIssues = [`RawPenFrame import failed: ${String((error as Error)?.message || error)}`];
      state.importSummary = `raw log import failed: ${file.name}`;
      render();
    });
  });
  app.querySelector<HTMLButtonElement>('[data-action="ai"]')?.addEventListener('click', generateAi);
  app.querySelector<HTMLButtonElement>('[data-action="replay"]')?.addEventListener('click', replay);
  app.querySelector<HTMLButtonElement>('[data-action="clear"]')?.addEventListener('click', reset);
  bindBoardDrawing();
  bindReviewControls();
  bindReviewEditControls();
}

function bindReviewControls(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-review-key][data-review-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.reviewKey;
      const action = button.dataset.reviewAction as ReviewStatus | undefined;
      if (!key || !action) return;
      state.reviewed[key] = action === 'edited'
        ? { status: action, editedText: demoEditedText(key) }
        : { status: action };
      void refreshProjectionPreview().then(render);
    });
  });
}

function bindReviewEditControls(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-review-save-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.reviewSaveKey;
      if (!key) return;
      const textarea = Array.from(app.querySelectorAll<HTMLTextAreaElement>('[data-review-edit-key]'))
        .find((item) => item.dataset.reviewEditKey === key);
      const editedText = textarea?.value.trim();
      if (!editedText) return;
      state.reviewed[key] = { status: 'edited', editedText };
      void refreshProjectionPreview().then(render);
    });
  });
}

function bindBoardDrawing(): void {
  const board = app.querySelector<HTMLDivElement>('#board');
  if (!board) return;
  let active: InkLoopStrokePoint[] = [];

  const point = (event: PointerEvent): InkLoopStrokePoint => {
    const rect = board.getBoundingClientRect();
    return {
      x_norm: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y_norm: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      t_ms: nowMs(),
      pressure: event.pressure || 0.65,
      quality: 0.88,
    };
  };

  board.addEventListener('pointerdown', (event) => {
    board.setPointerCapture(event.pointerId);
    active = [point(event)];
  });
  board.addEventListener('pointermove', (event) => {
    if (active.length === 0) return;
    active.push(point(event));
    const preview = addStroke(active.slice(-2));
    state.strokes.pop();
    renderPreview(preview.path);
  });
  board.addEventListener('pointerup', (event) => {
    if (active.length < 2) {
      active = [];
      return;
    }
    active.push(point(event));
    addStroke(active, state.scenario === 'teach' ? 'text' : 'diagram_node', state.scenario === 'teach' ? 'manual board writing' : 'manual meeting mark');
    active = [];
    render();
  });
}

function renderPreview(path: string): void {
  const svg = app.querySelector<SVGSVGElement>('.board svg');
  if (!svg) return;
  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  preview.setAttribute('d', path);
  preview.setAttribute('class', 'live');
  svg.appendChild(preview);
}

installRawPenFrameBridge();
render();
