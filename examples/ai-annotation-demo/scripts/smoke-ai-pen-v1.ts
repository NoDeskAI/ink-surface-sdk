/**
 * AI Pen V1 smoke:
 * - verifies the built multi-page demo entries exist
 * - exercises the Education and Meeting graph -> KnowledgeObject -> Obsidian Markdown path
 * - locks the meeting context boundary: audio/project memory cannot promote without ink/board evidence
 *
 * Usage:
 *   npm run build
 *   npx tsx scripts/smoke-ai-pen-v1.ts
 */
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderVaultMarkdown } from 'ink-surface-sdk/adapters/obsidian';
import {
  buildLessonGraphKnowledgeObjects,
  buildMeetingGraphKnowledgeObjects,
} from 'ink-surface-sdk/knowledge-schema';
import {
  validateLessonGraphSourceRefs,
  validateMeetingGraphSourceRefs,
  type InkLoopSourceRef,
  type LessonGraph,
  type MeetingGraph,
} from 'ink-surface-sdk/runtime-schema';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertBuiltEntry(path: string, pattern?: RegExp): Promise<void> {
  await access(path);
  if (!pattern) return;
  const html = await readFile(path, 'utf8');
  assert(pattern.test(html), `${path} did not contain expected asset reference`);
}

const inkRef: InkLoopSourceRef = {
  type: 'ink_event',
  session_id: 'sess_ai_pen_v1_smoke',
  event_id: 'evt_formula_mark',
  ts_start_ms: 100,
  ts_end_ms: 420,
  bbox_norm: [0.1, 0.2, 0.3, 0.1],
};

const formulaRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_v1_smoke',
  object_id: 'obj_formula',
  object_type: 'formula',
  bbox_norm: [0.15, 0.3, 0.35, 0.12],
};

const actionRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_v1_smoke',
  object_id: 'obj_action',
  object_type: 'action_item',
  bbox_norm: [0.2, 0.56, 0.3, 0.08],
};

const diagramNodeRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_v1_smoke',
  object_id: 'obj_node',
  object_type: 'diagram_node',
  bbox_norm: [0.14, 0.22, 0.16, 0.12],
};

const arrowRef: InkLoopSourceRef = {
  type: 'board_object',
  session_id: 'sess_ai_pen_v1_smoke',
  object_id: 'obj_arrow',
  object_type: 'arrow',
  bbox_norm: [0.35, 0.28, 0.2, 0.05],
};

const audioRef: InkLoopSourceRef = {
  type: 'audio_segment',
  session_id: 'sess_ai_pen_v1_smoke',
  start_ms: 1_000,
  end_ms: 5_000,
  speaker: 'Alex',
  transcript_ref: 'transcript_v1_smoke',
};

const memoryRef: InkLoopSourceRef = {
  type: 'project_memory',
  memory_id: 'mem_v1_prior_decision',
  kind: 'prior_decision',
  title: 'Prior architecture notes',
};

async function smokeEducation(): Promise<{ objectKinds: string[]; markdownPaths: string[] }> {
  const lesson: LessonGraph = {
    lesson_id: 'lesson_v1_smoke',
    session_id: 'sess_ai_pen_v1_smoke',
    title: 'Completing the square',
    steps: [{
      step_id: 'step_formula',
      order: 1,
      kind: 'formula',
      content: 'Convert x^2 + 2x + 1 into (x + 1)^2.',
      latex: '(x + 1)^2',
      board_object_refs: ['obj_formula'],
      source_refs: [formulaRef],
      confidence: 0.82,
    }],
    concepts: [{
      concept_id: 'concept_square',
      name: 'Completing the square',
      explanation: 'A reversible algebra operation captured from the board.',
      source_refs: [inkRef],
    }],
  };

  const validationIssues = validateLessonGraphSourceRefs(lesson);
  assert(validationIssues.length === 0, `lesson validation failed: ${JSON.stringify(validationIssues)}`);

  const objects = await buildLessonGraphKnowledgeObjects(lesson, {
    documentId: 'doc_ai_pen_lesson_smoke',
    documentTitle: 'AI Pen Lesson Smoke',
    now: '2026-07-03T00:00:00.000Z',
    statusById: { step_formula: 'accepted', concept_square: 'accepted' },
  });
  assert(objects.map((ko) => ko.kind).join(',') === 'formula_step,concept', 'lesson objects were not promoted as expected');

  const files = renderVaultMarkdown({
    entities: [{
      documentId: 'doc_ai_pen_lesson_smoke',
      documentTitle: 'AI Pen Lesson Smoke',
      mode: 'reading',
      dates: ['2026-07-03'],
      knowledgeObjects: objects,
      documentProjections: [],
    }],
  });
  const markdown = files.map((file) => file.markdown).join('\n');
  assert(markdown.includes('> [!tip]'), 'lesson formula step did not render as tip callout');
  assert(markdown.includes('inkloop://doc/doc_ai_pen_lesson_smoke'), 'lesson backlink missing');

  return { objectKinds: objects.map((ko) => ko.kind), markdownPaths: files.map((file) => file.path) };
}

async function smokeMeeting(): Promise<{
  objectKinds: string[];
  markdownPaths: string[];
  invalidContextIssues: string[];
}> {
  const meeting: MeetingGraph = {
    meeting_id: 'meeting_v1_smoke',
    session_id: 'sess_ai_pen_v1_smoke',
    title: 'Architecture whiteboard review',
    decisions: [{
      decision_id: 'decision_ledger',
      content: 'Use the event ledger as the source of truth.',
      source_refs: [inkRef],
      confidence: 0.86,
    }],
    actions: [{
      action_id: 'action_schema',
      content: 'Lock the PenFrame / InkEvent schema.',
      owner: 'Runtime',
      status: 'candidate',
      source_refs: [actionRef, audioRef],
      confidence: 0.83,
    }],
    risks: [{
      risk_id: 'risk_surface_glare',
      content: 'Surface glare can lower optical localization quality.',
      severity: 'high',
      source_refs: [diagramNodeRef],
      confidence: 0.74,
    }],
    diagrams: [{
      diagram_id: 'diagram_runtime',
      type: 'architecture',
      mermaid: 'flowchart LR\n  Host --> Ledger\n  Ledger --> InkGraph',
      source_refs: [diagramNodeRef, arrowRef],
      confidence: 0.76,
    }],
  };

  const validationIssues = validateMeetingGraphSourceRefs(meeting);
  assert(validationIssues.length === 0, `meeting validation failed: ${JSON.stringify(validationIssues)}`);

  const objects = await buildMeetingGraphKnowledgeObjects(meeting, {
    documentId: 'doc_ai_pen_meeting_smoke',
    documentTitle: 'AI Pen Meeting Smoke',
    now: '2026-07-03T00:00:00.000Z',
    statusById: {
      decision_ledger: 'accepted',
      action_schema: 'edited',
      risk_surface_glare: 'dismissed',
      diagram_runtime: 'follow_up',
    },
  });
  assert(objects.map((ko) => ko.kind).join(',') === 'meeting_decision,meeting_action,diagram', 'meeting objects were not promoted as expected');

  const files = renderVaultMarkdown({
    entities: [{
      documentId: 'doc_ai_pen_meeting_smoke',
      documentTitle: 'AI Pen Meeting Smoke',
      mode: 'meeting',
      dates: ['2026-07-03'],
      knowledgeObjects: objects,
      documentProjections: [],
    }],
  });
  const markdown = files.map((file) => file.markdown).join('\n');
  const paths = files.map((file) => file.path).join('\n');
  assert(paths.includes('InkLoop/Meetings/2026-07-03 AI Pen Meeting Smoke'), 'meeting folder path missing');
  assert(markdown.includes('> [!todo] Action: Lock the PenFrame / InkEvent schema.'), 'meeting action callout missing');
  assert(markdown.includes('audio:1000-5000 Alex'), 'meeting audio context was not retained as context');
  assert(!markdown.includes('Surface glare can lower optical localization quality.'), 'dismissed meeting risk was promoted');
  assert(markdown.includes('inkloop://doc/doc_ai_pen_meeting_smoke'), 'meeting backlink missing');

  const invalidMeeting: MeetingGraph = {
    meeting_id: 'meeting_invalid_context_smoke',
    session_id: 'sess_ai_pen_v1_smoke',
    decisions: [{
      decision_id: 'decision_audio_only',
      content: 'Audio-only context must not become a meeting decision.',
      source_refs: [audioRef, memoryRef],
      confidence: 0.91,
    }],
    actions: [],
    risks: [],
    diagrams: [],
  };
  const invalidIssues = validateMeetingGraphSourceRefs(invalidMeeting).map((issue) => issue.message);
  assert(invalidIssues.includes('meeting results must include ink_event or board_object evidence, not audio/project memory alone'), 'audio-only meeting boundary was not enforced');

  const invalidObjects = await buildMeetingGraphKnowledgeObjects(invalidMeeting, {
    documentId: 'doc_ai_pen_meeting_smoke',
    documentTitle: 'AI Pen Meeting Smoke',
    now: '2026-07-03T00:00:00.000Z',
    statusById: { decision_audio_only: 'accepted' },
  });
  assert(invalidObjects.length === 0, 'audio-only meeting output was promoted');

  return { objectKinds: objects.map((ko) => ko.kind), markdownPaths: files.map((file) => file.path), invalidContextIssues: invalidIssues };
}

async function main(): Promise<void> {
  await assertBuiltEntry(join(process.cwd(), 'dist/ai-pen-demo.html'), /assets\/aiPen-[^"']+\.js/);
  await assertBuiltEntry(join(process.cwd(), 'dist/index.html'), /assets\/main-[^"']+\.js/);
  await assertBuiltEntry(join(process.cwd(), 'dist/mobile.html'), /assets\/mobile-[^"']+\.js/);

  const education = await smokeEducation();
  const meeting = await smokeMeeting();
  console.log(JSON.stringify({
    ok: true,
    checked_entries: ['dist/ai-pen-demo.html', 'dist/index.html', 'dist/mobile.html'],
    education,
    meeting,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
