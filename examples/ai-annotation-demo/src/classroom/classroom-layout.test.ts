import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'classroom.css'), 'utf8');

describe('classroom transcript layout', () => {
  it('keeps transcript overflow inside its strip instead of widening the teacher page', () => {
    expect(css).toMatch(/\.classroom-shell\{[^}]*min-width:0/);
    expect(css).toMatch(/\.teacher-workspace\{[^}]*min-width:0/);
    expect(css).toMatch(/\.classroom-transcript-panel\{[^}]*min-width:0/);
    expect(css).toMatch(/\.transcript-list\{[^}]*width:100%[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
    expect(css).toMatch(/\.transcript-row\{[^}]*width:100%[^}]*min-width:0/);
    expect(css).not.toMatch(/\.transcript-row\{[^}]*min-width:210px/);
    expect(css).toMatch(/\.transcript-list\{[^}]*align-content:start[^}]*grid-auto-rows:max-content/);
    expect(css).toMatch(/\.transcript-text\{[^}]*white-space:normal[^}]*overflow:visible[^}]*overflow-wrap:anywhere/);
  });

  it('keeps teacher controls compact so the teaching viewport owns the remaining height', () => {
    expect(css).toMatch(/\.teacher-studio\{display:grid;grid-template-rows:auto minmax\(0,1fr\) auto/);
    expect(css).toMatch(/\.teacher-command-header\{[^}]*min-height:52px/);
    expect(css).toMatch(/\.teacher-toolbelt\{[^}]*min-height:46px/);
    expect(css).toMatch(/\.teacher-studio-body\{display:grid;grid-template-columns:minmax\(0,1fr\) 340px/);
    expect(css).toMatch(/\.teacher-sidebar\{display:grid;grid-template-rows:minmax\(0,46%\) minmax\(0,54%\)/);
    expect(css).toMatch(/\.textbook-controls\{[^}]*min-height:42px/);
    expect(css).toMatch(/\.textbook-frame\{[^}]*height:100%[^}]*min-height:420px/);
    expect(css).toMatch(/@media\(max-width:1100px\)[\s\S]*?\.teacher-studio-body\{grid-template-columns:minmax\(0,1fr\) 280px/);
  });

  it('keeps the student player header outside the feed and shows notes above transcripts', () => {
    expect(css).toMatch(/\.student-layout\{grid-template-columns:minmax\(0,1fr\) 360px;grid-template-rows:minmax\(0,1fr\)/);
    expect(css).toMatch(/\.student-board-area\{display:grid;grid-template-rows:auto minmax\(0,1fr\);height:100%/);
    expect(css).toMatch(/\.student-player-header\{[^}]*min-height:48px[^}]*border-bottom/);
    expect(css).toMatch(/\.student-sidebar\{position:relative;grid-template-rows:minmax\(0,58%\) minmax\(0,42%\)/);
    expect(css).toMatch(/\.student-sidebar \.student-transcript-panel\{display:grid;grid-template-rows:auto minmax\(0,1fr\)/);
    expect(css).toMatch(/@media\(max-width:1100px\) and \(min-width:701px\)[\s\S]*?\.student-layout\{grid-template-columns:minmax\(0,1fr\) 300px/);
  });

  it('shows the AI evidence scope without leaking internal source references', () => {
    const source = readFileSync(resolve(__dirname, 'student-main.ts'), 'utf8');
    expect(source).toContain("'本次范围'");
    expect(source).toContain("summary.dataset.locked = String(status !== 'ended')");
    expect(source).toContain("guardPostClass(summary");
    expect(source).toContain("'根据整堂课的板书、公式和讲解生成练习'");
    expect(source).not.toContain('practice_anchor_id');
    expect(source).not.toContain('practice-anchors');
    expect(source).not.toContain('anchorButton');
    expect(source).toContain('studentFacingAiText(section.content)');
    expect(source).toContain('if (eventIds.length) renderer.showSourceAnchor(eventIds)');
    expect(source).not.toContain("element('div', 'source-links')");
    expect(source).not.toContain("element('button', 'source-link'");
    expect(source).not.toContain('在板书中标出这一步');
    expect(source).not.toContain('`来源 · ${ref.event_id}`');
    expect(css).not.toContain('.source-link');
    expect(css).not.toContain('.ai-action-feedback');
    expect(css).toMatch(/\.ai-scope\{[^}]*border-left:3px solid var\(--accent\)/);
    expect(css).toMatch(/\.ai-action\[data-locked="true"\]\{[^}]*border-style:dashed/);
  });
});
