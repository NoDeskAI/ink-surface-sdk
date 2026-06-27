import { describe, expect, it } from 'vitest';
import { appendInkLoopAnnotation, parseInkLoopVisualModel, replaceInkLoopBlockContent, updateInkLoopAnnotation } from './index';

const projectionMarkdown = `---
inkloop_projection_id: "dp_demo"
---

# Demo Document

<!-- inkloop:document-begin projection=dp_demo body_hash=sha256:a mapping=inkloop.obsidian.mapping.v1 -->

<!-- inkloop:page id=pg_0 index=0 -->

## Page 1

<!-- inkloop:block-begin id=blk_1 hash=sha256:b region=editable page=0 bbox=0.1,0.2,0.3,0.4 kind=paragraph mapping=inkloop.obsidian.mapping.v1 -->

Marked paragraph.

<!-- inkloop:block-end id=blk_1 -->

<!-- inkloop:annotations-begin block=blk_1 mapping=inkloop.obsidian.mapping.v1 -->
<div class="inkloop-annotation-fallback" data-inkloop-block="blk_1">
<!-- inkloop:annotation-json %7B%22ko_id%22%3A%22ko_1%22%2C%22kind%22%3A%22qa%22%2C%22title%22%3A%22Question%22%2C%22body_md%22%3A%22Answer%22%7D -->
<strong>InkLoop annotations</strong>
<ul>
<li>Question</li>
</ul>
</div>
<!-- inkloop:annotations-end block=blk_1 -->

<!-- inkloop:document-end projection=dp_demo -->
`;

describe('InkLoop surface SDK', () => {
  it('parses document projection blocks and annotation metadata for visual rendering', () => {
    const model = parseInkLoopVisualModel(projectionMarkdown);

    expect(model?.documentTitle).toBe('Demo Document');
    expect(model?.blocks).toHaveLength(1);
    expect(model?.blocks[0]).toMatchObject({
      id: 'blk_1',
      kind: 'paragraph',
      region: 'editable',
      page: '0',
      bbox: '0.1,0.2,0.3,0.4',
      content: 'Marked paragraph.',
    });
    expect(model?.blocks[0].annotations).toEqual([
      {
        ko_id: 'ko_1',
        kind: 'qa',
        title: 'Question',
        body_md: 'Answer',
      },
    ]);
  });

  it('replaces one editable projection block without touching metadata', () => {
    const next = replaceInkLoopBlockContent(projectionMarkdown, 'blk_1', 'Edited in Web.\nSecond line.');
    const model = parseInkLoopVisualModel(next);

    expect(model?.blocks[0].content).toBe('Edited in Web.\nSecond line.');
    expect(next).toContain('inkloop_projection_id: "dp_demo"');
    expect(next).toContain('<!-- inkloop:annotation-json ');
    expect(next).not.toContain('Marked paragraph.');
  });

  it('updates annotation metadata and keeps the fallback list in sync', () => {
    const next = updateInkLoopAnnotation(projectionMarkdown, 'ko_1', {
      kind: 'annotation',
      title: 'Edited title',
      body_md: 'Edited body',
    });
    const model = parseInkLoopVisualModel(next);

    expect(model?.blocks[0].annotations).toEqual([
      {
        ko_id: 'ko_1',
        kind: 'annotation',
        title: 'Edited title',
        body_md: 'Edited body',
      },
    ]);
    expect(next).toContain('<li>Edited title</li>');
    expect(next).not.toContain('<li>Question</li>');
  });

  it('appends a hand-drawn annotation into an existing block annotation section', () => {
    const next = appendInkLoopAnnotation(projectionMarkdown, 'blk_1', {
      ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9DRAWA1',
      kind: 'annotation',
      title: 'Hand-drawn box',
      body_md: 'Created in mark mode.',
      status: 'edited',
      visual_bbox: [0.1, 0.2, 0.5, 0.3],
      visual_strokes: [{ tool: 'pen', color: '#38bdf8', opacity: 0.92, points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.5 }] }],
    });
    const model = parseInkLoopVisualModel(next);

    expect(model?.blocks[0].annotations).toHaveLength(2);
    expect(model?.blocks[0].annotations[1]).toMatchObject({
      ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9DRAWA1',
      title: 'Hand-drawn box',
      visual_bbox: [0.1, 0.2, 0.5, 0.3],
      visual_strokes: [{ tool: 'pen', color: '#38bdf8', opacity: 0.92, points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.5 }] }],
    });
    expect(next).toContain('<li>Question</li>');
    expect(next).toContain('<li>Hand-drawn box</li>');
  });

  it('keeps stroke-only annotations out of fallback list items', () => {
    const next = appendInkLoopAnnotation(projectionMarkdown, 'blk_1', {
      ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9DRAWA2',
      kind: 'annotation',
      title: 'Hidden pen stroke',
      body_md: '',
      status: 'edited',
      render_mode: 'stroke_only',
      visual_strokes: [{ tool: 'pen', points: [{ x: -0.1, y: 0.2 }, { x: 1.2, y: 0.4 }] }],
    });
    const model = parseInkLoopVisualModel(next);

    expect(model?.blocks[0].annotations[1]).toMatchObject({
      ko_id: 'ko_01JZ7D5E7WJK4F5NTAT9DRAWA2',
      render_mode: 'stroke_only',
    });
    expect(next).not.toContain('<li>Hidden pen stroke</li>');
  });
});
