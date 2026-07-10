import { describe, expect, it } from 'vitest';
import type { KnowledgeKind, KnowledgeObject, MarkdownCallout } from 'ink-surface-sdk/knowledge-schema';
import { buildInkloopDocUri } from 'ink-surface-sdk/knowledge-schema';
import { parseObsidianControlledKnowledgeEdit, renderVaultMarkdown } from './index';

function ko(kind: KnowledgeKind, title: string, callout?: MarkdownCallout): KnowledgeObject {
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: `ko_${kind}`,
    kind,
    title,
    body_md: `${title} body\n\nBacklink: ${buildInkloopDocUri('doc_ai_pen')}`,
    source: {
      document_id: 'doc_ai_pen',
      document_title: 'AI Pen Demo',
      object_refs: ['evt_demo'],
      inkloop_uri: buildInkloopDocUri('doc_ai_pen'),
    },
    provenance: { created_from: 'ai_turn', ai_turn_ids: ['turn_demo'] },
    tags: ['inkloop', `inkloop/${kind}`],
    status: 'export_ready',
    privacy: 'export_allowed',
    ...(callout ? { render_hints: { markdown_callout: callout } } : {}),
    content_hash: 'sha256:demo',
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
  };
}

describe('adapter-obsidian V1 knowledge projection', () => {
  it('renders AI Pen lesson and meeting knowledge kinds with specific callouts and backlinks', () => {
    const files = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'meeting',
        dates: ['2026-07-02'],
        knowledgeObjects: [
          ko('reading_note', 'Reading Note'),
          ko('highlight', 'Highlight'),
          ko('task', 'Task'),
          ko('decision', 'Decision'),
          ko('risk', 'Risk'),
          ko('lesson_note', 'Lesson Note'),
          ko('meeting_action', 'Action Candidate'),
          ko('meeting_decision', 'Decision Candidate'),
          ko('meeting_risk', 'Risk Candidate'),
          ko('diagram', 'Diagram Export'),
        ],
        documentProjections: [],
      }],
    });

    const markdown = files.map((file) => file.markdown).join('\n');
    expect(markdown).toContain('inkloop_projection_role: "source_file_unit"');
    expect(markdown).toContain('## Source File');
    expect(markdown).toContain('- Unit: source file/session; Obsidian notes below are reviewed projections derived from this unit.');
    expect(markdown).toContain('inkloop_projection_role: "knowledge_projection"');
    expect(markdown).toContain('inkloop_projection_scope: "reviewed_knowledge_only"');
    expect(markdown).toContain('> [!summary] Reading Note');
    expect(markdown).toContain('> [!quote] Highlight');
    expect(markdown).toContain('> [!todo] Task');
    expect(markdown).toContain('> [!tip] Decision');
    expect(markdown).toContain('> [!warning] Risk');
    expect(markdown).toContain('> [!summary] Lesson Note');
    expect(markdown).toContain('> [!todo] Action Candidate');
    expect(markdown).toContain('> [!tip] Decision Candidate');
    expect(markdown).toContain('> [!warning] Risk Candidate');
    expect(markdown).toContain('> [!tip] Diagram Export');
    expect(markdown).toContain('inkloop://doc/doc_ai_pen');
  });

  it('lets explicit render hints override the default V1 callout mapping', () => {
    const [file] = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'meeting',
        knowledgeObjects: [ko('meeting_decision', 'Decision', 'note')],
        documentProjections: [],
      }],
    }).filter((candidate) => candidate.path.includes('Decision'));

    expect(file.markdown).toContain('> [!note] Decision');
  });

  it('strips source-file extensions from Reading folder and hub note names', () => {
    const files = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_markdown_source',
        documentTitle: 'AI 时代的 UX 范式.md',
        mode: 'reading',
        knowledgeObjects: [ko('highlight', 'Highlight')],
        documentProjections: [],
      }],
    });

    expect(files.some((file) => file.path === 'InkLoop/Reading/AI 时代的 UX 范式/AI 时代的 UX 范式.md')).toBe(true);
    expect(files.every((file) => !file.path.includes('.md/'))).toBe(true);
    expect(files.every((file) => !file.path.endsWith('.md.md'))).toBe(true);
  });

  it('deduplicates mirrored visual and surface strokes in Obsidian SVG output', () => {
    const readingNote = ko('reading_note', 'Reading Note');
    const stroke = {
      tool: 'pen' as const,
      color: '#1A1A1A',
      opacity: 1,
      points: [
        { x: 0.1, y: 0.2, pressure: 0.5 },
        { x: 0.3, y: 0.4, pressure: 0.6 },
      ],
    };
    const [file] = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'reading',
        knowledgeObjects: [readingNote],
        documentProjections: [],
        visualModel: {
          documentTitle: 'AI Pen Demo',
          blocks: [{
            id: 'blk_demo',
            kind: 'paragraph',
            region: 'generated',
            content: 'Demo block',
            annotations: [{
              ko_id: readingNote.ko_id,
              kind: readingNote.kind,
              title: readingNote.title,
              visual_strokes: [stroke],
              surface_strokes: [stroke],
            }],
          }],
        },
      }],
    }).filter((candidate) => candidate.path.includes('Reading Note'));

    expect(file.markdown).toContain('class="inkloop-cloud-mark-layer"');
    expect(file.markdown.match(/<path class="inkloop-cloud-mark-freehand/g)?.length).toBe(1);
  });

  it('keeps plain meeting handwriting as one original page section instead of one note per stroke mark', () => {
    const plainMark = ko('annotation', '出海创新周例会 · p1');
    const decision = ko('meeting_decision', '确认硬件选型路径');
    const files = renderVaultMarkdown({
      entities: [{
        documentId: 'mtgdoc_demo',
        documentTitle: '出海创新周例会',
        mode: 'meeting',
        dates: ['2026-07-09'],
        knowledgeObjects: [plainMark, decision],
        documentProjections: [],
        visualModel: {
          documentTitle: '出海创新周例会',
          blocks: [{
            id: 'blk_mtg',
            kind: 'heading',
            region: 'generated',
            page: '0',
            content: '会议手记',
            annotations: [{
              ko_id: plainMark.ko_id,
              kind: plainMark.kind,
              title: plainMark.title,
              render_mode: 'stroke_only',
              page_index: 0,
              visual_strokes: [{
                tool: 'pen',
                color: '#1A1A1A',
                coord_space: 'page_norm',
                points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.4 }],
              }],
            }],
          }],
        },
      }],
    });

    const paths = files.map((file) => file.path);
    const hub = files.find((file) => file.path.endsWith('/出海创新周例会.md'))?.markdown ?? '';
    expect(paths.some((path) => path.includes('出海创新周例会 · p1'))).toBe(false);
    expect(paths.some((path) => path.includes('确认硬件选型路径'))).toBe(true);
    expect(hub).toContain('## 手写记录');
    expect(hub).toContain('class="inkloop-meeting-ink-page"');
    expect(hub).toContain('## 笔记');
    expect(hub).not.toContain('[[出海创新周例会 · p1');
  });

  it('does not render meeting-only task decision risk objects inside Reading projections', () => {
    const files = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'reading',
        knowledgeObjects: [
          ko('reading_note', 'Reading Note'),
          ko('highlight', 'Highlight'),
          ko('task', 'Task'),
          ko('decision', 'Decision'),
          ko('risk', 'Risk'),
          ko('meeting_action', 'Meeting Action'),
          ko('meeting_decision', 'Meeting Decision'),
          ko('meeting_risk', 'Meeting Risk'),
        ],
        documentProjections: [],
      }],
    });

    const markdown = files.map((file) => file.markdown).join('\n');
    expect(markdown).toContain('> [!summary] Reading Note');
    expect(markdown).toContain('> [!quote] Highlight');
    expect(markdown).not.toContain('> [!todo] Task');
    expect(markdown).not.toContain('> [!tip] Decision');
    expect(markdown).not.toContain('> [!warning] Risk');
    expect(files.map((file) => file.path)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('Task'),
      expect.stringContaining('Decision'),
      expect.stringContaining('Risk'),
    ]));
  });

  it('preserves structured meeting source_refs visibly and as JSON', () => {
    const action = {
      ...ko('meeting_action', 'Follow up action'),
      source_refs: [
        {
          ref_type: 'document',
          document_id: 'doc_ai_pen',
          page_id: 'pg_1',
          page_index: 0,
          object_refs: ['ann_1'],
          confidence: 0.91,
          quote: 'Follow up',
        },
        {
          ref_type: 'meeting_mark',
          meeting_id: 'mtg_1',
          meeting_mark_id: 'ann_action',
          time_ms: 14_000,
          captured_at_ms: 1_700_000_014_000,
          kind: 'action',
          source: 'hanwang_epaper',
        },
      ],
    } satisfies KnowledgeObject;

    const [file] = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'meeting',
        knowledgeObjects: [action],
        documentProjections: [],
      }],
    }).filter((candidate) => candidate.path.includes('Follow up action'));

    expect(file.markdown).toContain('## Source Refs');
    expect(file.markdown).toContain('- document doc_ai_pen page 1 - Follow up');
    expect(file.markdown).toContain('- meeting_mark mtg_1/ann_action @14s');
    expect(file.markdown).toContain('"ref_type": "meeting_mark"');
  });

  it('renders and parses controlled task fields without reverse-parsing arbitrary Markdown', () => {
    const [file] = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'meeting',
        knowledgeObjects: [ko('task', 'Follow up task')],
        documentProjections: [],
      }],
    }).filter((candidate) => candidate.path.includes('Follow up task'));

    expect(file.markdown).toContain('<!-- inkloop:controlled-fields v1 -->');
    expect(file.markdown).toContain('- [ ] Task done');

    const changed = file.markdown
      .replace('- [ ] Task done', '- [x] Task done')
      .replace('- Status: export_ready', '- Status: archived');

    expect(parseObsidianControlledKnowledgeEdit(changed)).toMatchObject({
      schema_version: 'inkloop.obsidian_controlled_knowledge_edit.v1',
      document_id: 'doc_ai_pen',
      ko_id: 'ko_task',
      kind: 'task',
      patch: {
        status: 'archived',
        tags: ['inkloop', 'inkloop/task'],
        task_done: true,
      },
      source: 'obsidian_controlled_fields',
    });
    expect(parseObsidianControlledKnowledgeEdit(file.markdown.replace('<!-- inkloop:controlled-fields v1 -->', ''))).toBeNull();
  });

  it('parses controlled risk status, note, tags, and highlight comment', () => {
    const risk = {
      ...ko('meeting_risk', 'Launch risk'),
      controlled_fields: { risk_status: 'watching' as const, risk_note: 'Owner check pending' },
    };
    const highlight = {
      ...ko('highlight', 'Important highlight'),
      controlled_fields: { comment_md: 'Worth reviewing in the next planning pass.' },
    };
    const files = renderVaultMarkdown({
      entities: [{
        documentId: 'doc_ai_pen',
        documentTitle: 'AI Pen Demo',
        mode: 'meeting',
        knowledgeObjects: [risk, highlight],
        documentProjections: [],
      }],
    });

    const riskMarkdown = files.find((file) => file.path.includes('Launch risk'))?.markdown ?? '';
    const highlightMarkdown = files.find((file) => file.path.includes('Important highlight'))?.markdown ?? '';

    expect(parseObsidianControlledKnowledgeEdit(riskMarkdown.replace('- Risk status: watching', '- Risk status: mitigated'))?.patch).toMatchObject({
      tags: ['inkloop', 'inkloop/meeting_risk'],
      risk_status: 'mitigated',
      risk_note: 'Owner check pending',
    });
    expect(parseObsidianControlledKnowledgeEdit(highlightMarkdown.replace('- Comment: Worth reviewing in the next planning pass.', '- Comment: Keep for demo script.'))?.patch).toMatchObject({
      tags: ['inkloop', 'inkloop/highlight'],
      comment_md: 'Keep for demo script.',
    });
  });
});
