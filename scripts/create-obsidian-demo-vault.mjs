import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const vaultRoot = path.join(root, 'test-results/obsidian-demo-vault');
const allowedFlags = new Set(['--skip-build']);

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--') && !allowedFlags.has(arg)) fail(`unknown option: ${arg}`);
}

const skipBuild = process.argv.includes('--skip-build');

function fail(message) {
  console.error(`Obsidian demo vault failed: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
  });
  if (result.error) fail(`${command} ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

function writeVaultFile(relativePath, body) {
  const target = path.join(vaultRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, 'utf8');
}

function inkRef(eventId, bbox = [0.1, 0.2, 0.3, 0.1]) {
  return {
    type: 'ink_event',
    session_id: 'sess_obsidian_demo',
    event_id: eventId,
    ts_start_ms: 100,
    ts_end_ms: 260,
    bbox_norm: bbox,
  };
}

function boardRef(objectId, objectType, bbox = [0.2, 0.3, 0.3, 0.1]) {
  return {
    type: 'board_object',
    session_id: 'sess_obsidian_demo',
    object_id: objectId,
    object_type: objectType,
    bbox_norm: bbox,
  };
}

function documentProjection({ projectionId, documentId, documentTitle, blocks }) {
  const now = '2026-07-03T00:00:00.000Z';
  return {
    schema_version: 'inkloop.document_projection.v1',
    projection_id: projectionId,
    document_id: documentId,
    document_title: documentTitle,
    document_uri: `inkloop://doc/${encodeURIComponent(documentId)}`,
    revision_id: 'demo-rev-1',
    generated_at: now,
    source: { app: 'inkloop-ai-pen-demo', app_version: '0.1.0' },
    privacy: 'export_allowed',
    export_policy: {
      include_full_text: true,
      include_pdf_asset: false,
      include_raw_strokes: false,
      include_debug_evidence: false,
    },
    blocks,
    body_hash: 'sha256:demo',
    content_hash: 'sha256:demo',
    created_at: now,
    updated_at: now,
  };
}

if (!skipBuild) run('npm', ['run', 'build']);

rmSync(vaultRoot, { recursive: true, force: true });
mkdirSync(vaultRoot, { recursive: true });

run('node', ['scripts/install-obsidian-plugin.mjs', '--vault', vaultRoot]);

const {
  buildLessonGraphKnowledgeObjects,
  buildMeetingGraphKnowledgeObjects,
  buildInkloopDocUri,
} = await import('ink-surface-sdk/knowledge-schema');
const { renderVaultMarkdown } = await import('ink-surface-sdk/adapters/obsidian');

function manualKnowledgeObject({ id, kind, title, body, documentId, documentTitle, sourceRefs, status = 'accepted' }) {
  const uri = buildInkloopDocUri(documentId);
  const refs = sourceRefs.map((ref) => {
    if (ref.type === 'ink_event') return `ink_event:${ref.event_id}`;
    if (ref.type === 'board_object') return `${ref.object_type}:${ref.object_id}`;
    if (ref.type === 'audio_segment') return `audio:${ref.start_ms}-${ref.end_ms}${ref.speaker ? ` ${ref.speaker}` : ''}`;
    return `memory:${ref.title}`;
  }).join('\n');
  const objectRefs = sourceRefs.map((ref) => {
    if (ref.type === 'ink_event') return ref.event_id;
    if (ref.type === 'board_object') return ref.object_id;
    if (ref.type === 'audio_segment') return `audio_${ref.start_ms}_${ref.end_ms}`;
    return ref.memory_id;
  });
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: `ko_${id}`,
    kind,
    title,
    body_md: `${body}\n\n**Source refs**\n${refs}\n\nBacklink: ${uri}`,
    source: {
      document_id: documentId,
      document_title: documentTitle,
      object_refs: [...new Set(objectRefs)],
      anchor_bbox: sourceRefs.find((ref) => ref.bbox_norm)?.bbox_norm,
      inkloop_uri: uri,
    },
    provenance: { created_from: 'manual', mark_ids: objectRefs },
    tags: ['inkloop', `inkloop/${kind}`],
    status,
    privacy: 'export_allowed',
    content_hash: 'sha256:demo',
    created_at: '2026-07-03T00:00:00.000Z',
    updated_at: '2026-07-03T00:00:00.000Z',
  };
}

const lessonGraph = {
  lesson_id: 'lesson_obsidian_demo',
  session_id: 'sess_obsidian_demo',
  title: 'Completing the square',
  steps: [{
    step_id: 'step_formula_square',
    order: 1,
    kind: 'formula',
    content: 'Convert x^2 + 2x + 1 into (x + 1)^2.',
    latex: '(x + 1)^2',
    board_object_refs: ['obj_formula_square'],
    source_refs: [inkRef('evt_lesson_formula', [0.12, 0.2, 0.35, 0.1])],
    confidence: 0.82,
  }],
  concepts: [{
    concept_id: 'concept_completing_square',
    name: 'Completing the square',
    explanation: 'A reversible algebra step that turns a quadratic expression into a squared binomial form.',
    source_refs: [inkRef('evt_lesson_concept', [0.16, 0.36, 0.32, 0.12])],
  }],
};

const meetingGraph = {
  meeting_id: 'meeting_obsidian_demo',
  session_id: 'sess_obsidian_demo',
  title: 'AI Pen architecture review',
  decisions: [{
    decision_id: 'decision_runtime_ledger',
    content: 'Use the event ledger as the source of truth.',
    source_refs: [inkRef('evt_meeting_decision', [0.1, 0.15, 0.4, 0.12])],
    confidence: 0.86,
  }],
  actions: [{
    action_id: 'action_schema_lock',
    content: 'Lock PenFrame and InkEvent schema before firmware integration.',
    owner: 'Runtime',
    status: 'candidate',
    source_refs: [boardRef('obj_action_schema', 'action_item', [0.2, 0.45, 0.42, 0.1])],
    confidence: 0.83,
  }],
  risks: [{
    risk_id: 'risk_surface_glare',
    content: 'Surface glare can lower optical capture quality.',
    severity: 'medium',
    source_refs: [boardRef('obj_risk_glare', 'risk', [0.58, 0.45, 0.28, 0.12])],
    confidence: 0.74,
  }, {
    risk_id: 'risk_schema_drift',
    content: 'Schema drift between PenFrame, InkEvent, and Obsidian projection can break the demo handoff.',
    severity: 'high',
    source_refs: [boardRef('obj_risk_schema_drift', 'risk', [0.52, 0.58, 0.34, 0.1])],
    confidence: 0.79,
  }],
  diagrams: [{
    diagram_id: 'diagram_runtime_path',
    type: 'architecture',
    mermaid: 'flowchart LR\n  Pen --> Host\n  Host --> Ledger\n  Ledger --> Obsidian',
    source_refs: [
      boardRef('obj_diagram_node_host', 'diagram_node', [0.24, 0.22, 0.18, 0.1]),
      boardRef('obj_diagram_arrow', 'arrow', [0.42, 0.23, 0.2, 0.08]),
    ],
    confidence: 0.78,
  }],
};

const lessonObjects = await buildLessonGraphKnowledgeObjects(lessonGraph, {
  documentId: 'doc_ai_pen_lesson_demo',
  documentTitle: 'AI Pen Lesson Demo',
  now: '2026-07-03T00:00:00.000Z',
  statusById: {
    step_formula_square: 'accepted',
    concept_completing_square: 'edited',
  },
  bodyOverridesById: {
    concept_completing_square: 'Edited: Completing the square is the move that creates a reusable squared-binomial pattern.',
  },
});

const meetingObjects = await buildMeetingGraphKnowledgeObjects(meetingGraph, {
  documentId: 'doc_ai_pen_meeting_demo',
  documentTitle: 'AI Pen Meeting Demo',
  now: '2026-07-03T00:00:00.000Z',
  statusById: {
    decision_runtime_ledger: 'accepted',
    action_schema_lock: 'edited',
    risk_surface_glare: 'dismissed',
    risk_schema_drift: 'accepted',
    diagram_runtime_path: 'follow_up',
  },
  titleOverridesById: {
    action_schema_lock: 'Edited Action: Lock AI Pen schema',
  },
  bodyOverridesById: {
    action_schema_lock: 'Edited: Lock PenFrame and InkEvent schema before firmware integration.',
  },
});

const readingProjectionObjects = [
  manualKnowledgeObject({
    id: 'reading_note_source_unit',
    kind: 'reading_note',
    title: 'Reading Note: Source unit boundary',
    body: 'Keep each imported file as the source unit so the Paper reader, Web host, and Obsidian projection stay aligned.',
    documentId: 'doc_ai_pen_lesson_demo',
    documentTitle: 'AI Pen Lesson Demo',
    sourceRefs: [inkRef('evt_reading_note', [0.08, 0.12, 0.42, 0.1])],
    status: 'accepted',
  }),
  manualKnowledgeObject({
    id: 'highlight_traceable_quote',
    kind: 'highlight',
    title: 'Highlight: Traceable source refs',
    body: 'Every projected note keeps the source refs and an inkloop://doc backlink instead of becoming detached Markdown.',
    documentId: 'doc_ai_pen_lesson_demo',
    documentTitle: 'AI Pen Lesson Demo',
    sourceRefs: [inkRef('evt_highlight_traceable_quote', [0.16, 0.28, 0.4, 0.08])],
    status: 'accepted',
  }),
  manualKnowledgeObject({
    id: 'annotation_review_export',
    kind: 'annotation',
    title: 'Handwritten thought: Review projection before export',
    body: 'Before sending to Obsidian, accept or edit the candidate note so dismissed/debug-only content is not promoted.',
    documentId: 'doc_ai_pen_lesson_demo',
    documentTitle: 'AI Pen Lesson Demo',
    sourceRefs: [inkRef('evt_annotation_review_export', [0.2, 0.42, 0.36, 0.1])],
    status: 'edited',
  }),
];

const files = renderVaultMarkdown({
  entities: [
    {
      documentId: 'doc_ai_pen_lesson_demo',
      documentTitle: 'AI Pen Lesson Demo',
      mode: 'reading',
      dates: ['2026-07-03'],
      knowledgeObjects: [...readingProjectionObjects, ...lessonObjects],
      documentProjections: [documentProjection({
        projectionId: 'proj_ai_pen_lesson_demo',
        documentId: 'doc_ai_pen_lesson_demo',
        documentTitle: 'AI Pen Lesson Demo',
        blocks: [
          {
            block_id: 'blk_lesson_intro',
            kind: 'heading',
            heading_level: 2,
            text_md: 'Lesson projection',
            region: 'generated',
            source: { page_id: 'board', page_index: 0, object_refs: ['evt_lesson_formula'] },
            knowledge_object_ids: lessonObjects.map((ko) => ko.ko_id),
          },
          {
            block_id: 'blk_lesson_body',
            kind: 'paragraph',
            text_md: 'Accepted and edited reading notes, highlights, handwritten thoughts, and education candidates from the AI Pen V1 demo.',
            region: 'generated',
            source: { page_id: 'board', page_index: 0, object_refs: ['evt_lesson_formula', 'evt_lesson_concept'] },
            knowledge_object_ids: [...readingProjectionObjects, ...lessonObjects].map((ko) => ko.ko_id),
          },
        ],
      })],
    },
    {
      documentId: 'doc_ai_pen_meeting_demo',
      documentTitle: 'AI Pen Meeting Demo',
      mode: 'meeting',
      dates: ['2026-07-03'],
      knowledgeObjects: meetingObjects,
      documentProjections: [documentProjection({
        projectionId: 'proj_ai_pen_meeting_demo',
        documentId: 'doc_ai_pen_meeting_demo',
        documentTitle: 'AI Pen Meeting Demo',
        blocks: [
          {
            block_id: 'blk_meeting_intro',
            kind: 'heading',
            heading_level: 2,
            text_md: 'Meeting projection',
            region: 'generated',
            source: { page_id: 'board', page_index: 0, object_refs: ['evt_meeting_decision'] },
            knowledge_object_ids: meetingObjects.map((ko) => ko.ko_id),
          },
          {
            block_id: 'blk_meeting_body',
            kind: 'paragraph',
            text_md: 'Accepted, edited, and follow-up meeting decisions, actions, risks, and diagrams from marked board events. One dismissed risk is intentionally absent.',
            region: 'generated',
            source: { page_id: 'board', page_index: 0, object_refs: ['evt_meeting_decision', 'obj_action_schema'] },
            knowledge_object_ids: meetingObjects.map((ko) => ko.ko_id),
          },
        ],
      })],
    },
  ],
});

for (const file of files) writeVaultFile(file.path, file.markdown);

writeVaultFile('README.md', `# InkLoop AI Pen V1 Obsidian Demo Vault

This vault is generated by \`npm run obsidian:demo-vault\`.

## What To Open

- \`InkLoop/Reading/AI Pen Lesson Demo/AI Pen Lesson Demo.md\`
- \`InkLoop/Meetings/2026-07-03 AI Pen Meeting Demo/AI Pen Meeting Demo.md\`

## What This Shows

- Education candidates become clean Obsidian Markdown projections after review.
- Reading notes, highlights, handwritten thoughts, and AI brush responses are projected from the source file unit.
- Meeting decisions, actions, risks, and diagrams are projected from marked board events.
- Each reading or meeting hub is a source file unit with \`inkloop_document_id\`, \`inkloop_document_uri\`, and \`inkloop_projection_role: "source_file_unit"\` frontmatter.
- The dismissed meeting risk is not exported.
- Notes preserve \`inkloop://doc/...\` backlinks for returning to the InkLoop source document/session.
- The \`inkloop-sync\` plugin is installed and enabled for Runtime Sync sidecar settings.

## Non-Claims

- This vault uses demo data and does not prove real AI Pen BLE/firmware ingestion.
- This vault does not prove physical Capture Surface calibration.
- This vault does not prove Kickstarter launch readiness.
`);

writeVaultFile('manifest.json', `${JSON.stringify({
  schema: 'inkloop.obsidian_demo_vault.v1',
  generated_at: new Date().toISOString(),
  status: 'ready',
  vault_root: vaultRoot,
  plugin_id: 'inkloop-sync',
  markdown_file_count: files.length,
  lesson_object_count: lessonObjects.length,
  reading_projection_object_count: readingProjectionObjects.length,
  meeting_object_count: meetingObjects.length,
  source_file_unit_frontmatter: true,
  excluded_outputs: ['risk_surface_glare'],
  required_projection_kinds: ['reading_note', 'highlight', 'annotation', 'meeting_decision', 'meeting_risk'],
  entrypoints: [
    'InkLoop/Reading/AI Pen Lesson Demo/AI Pen Lesson Demo.md',
    'InkLoop/Meetings/2026-07-03 AI Pen Meeting Demo/AI Pen Meeting Demo.md',
  ],
}, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  vault_root: vaultRoot,
  markdown_file_count: files.length,
  lesson_object_count: lessonObjects.length,
  meeting_object_count: meetingObjects.length,
  entrypoints: [
    path.join(vaultRoot, 'InkLoop/Reading/AI Pen Lesson Demo/AI Pen Lesson Demo.md'),
    path.join(vaultRoot, 'InkLoop/Meetings/2026-07-03 AI Pen Meeting Demo/AI Pen Meeting Demo.md'),
  ],
}, null, 2));
