import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseKnowledgeObject, type KnowledgeObject } from '../../knowledge/knowledge-object';
import { findInkloopSections, replaceControlledSection } from './controlled-section';
import { sanitizeFileName } from './file-name';
import { parseFrontmatter } from './frontmatter';
import { renderKnowledgeObjectMarkdown } from './render-knowledge-object';

async function fixtureObjects(): Promise<KnowledgeObject[]> {
  const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/knowledge-objects.json', 'utf8')) as { objects: unknown[] };
  return raw.objects.map(parseKnowledgeObject);
}

describe('adapter markdown renderer', () => {
  it('renders AI notes with required frontmatter, quote, source link, and controlled markers', async () => {
    const [aiNote] = await fixtureObjects();
    const rendered = await renderKnowledgeObjectMarkdown(aiNote);
    expect(rendered.markdown).toContain('inkloop_id: "ko_01JZ7D5E7WJK4F5NTAT9QCJBW2"');
    expect(rendered.markdown).toContain('inkloop_content_hash: "sha256:55231bd8950514f2ecc626b65aa426a9a97b1dfb55d7adeb225af31c3973ff70"');
    expect(rendered.markdown).toContain('> [!quote] Source quote');
    expect(rendered.markdown).toContain('> [!note] InkLoop');
    expect(rendered.markdown).toContain('[[量子力学导论 - doc_3f9a1c2b7e04|量子力学导论]], p14');
    expect(rendered.markdown).toContain('<!-- inkloop:begin ko=ko_01JZ7D5E7WJK4F5NTAT9QCJBW2');
    expect(parseFrontmatter(rendered.markdown)?.frontmatter.inkloop_id).toBe(aiNote.ko_id);
  });

  it('renders excerpt fixtures as quote callouts', async () => {
    const [, excerpt] = await fixtureObjects();
    const rendered = await renderKnowledgeObjectMarkdown(excerpt);
    expect(rendered.markdown).toContain('> [!quote] InkLoop');
  });

  it('sanitizes cross-platform unsafe file names', () => {
    expect(sanitizeFileName('  a/b:c*?"<>|#^[].md  ')).toBe('a b c .md');
    expect(sanitizeFileName('...')).toBe('Untitled');
  });

  it('detects controlled section edits instead of silently replacing them', async () => {
    const [aiNote] = await fixtureObjects();
    const rendered = await renderKnowledgeObjectMarkdown(aiNote);
    const sections = findInkloopSections(rendered.markdown, aiNote.ko_id);
    expect(sections).toHaveLength(1);

    const edited = rendered.markdown.replace('强相关', '用户改过强相关');
    const result = await replaceControlledSection({
      existingMarkdown: edited,
      koId: aiNote.ko_id,
      oldRenderBodyHash: rendered.render_body_hash,
      newSection: rendered.controlled_section,
    });
    expect(result.type).toBe('controlled_section_modified');
  });
});
