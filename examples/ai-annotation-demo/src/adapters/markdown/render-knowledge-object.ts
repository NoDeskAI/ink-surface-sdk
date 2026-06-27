import { sha256Tagged } from '../../knowledge/hash';
import type { KnowledgeObject, Sha256 } from '../../knowledge/knowledge-object';
import { sourceNoteBaseName } from './file-name';
import { frontmatterForKnowledgeObject, renderFrontmatterObject } from './frontmatter';
import { renderCallout, type MarkdownCallout } from './render-callout';
import { renderControlledSection } from './controlled-section';

export interface RenderedKnowledgeMarkdown {
  ko_id: string;
  markdown: string;
  controlled_section: string;
  controlled_body: string;
  ko_content_hash: Sha256;
  render_body_hash: Sha256;
  frontmatter: string;
  title: string;
}

function headingTitle(ko: KnowledgeObject): string {
  const page = ko.source.page_index === undefined ? '' : ` · p${ko.source.page_index + 1}`;
  const label = ko.kind === 'ai_note' ? 'AI Note' : ko.kind.replace(/_/g, ' ');
  return `${label} · ${ko.source.document_title}${page}`;
}

function renderSourceSection(ko: KnowledgeObject): string {
  const sourceBase = sourceNoteBaseName(ko.source.document_title, ko.source.document_id);
  const page = ko.source.page_index === undefined ? '' : `, p${ko.source.page_index + 1}`;
  return [
    `**Source**: [[${sourceBase}|${ko.source.document_title}]]${page}  `,
    `<!-- inkloop:source-uri ${ko.source.inkloop_uri} -->`,
  ].join('\n');
}

export function renderKnowledgeObjectBody(ko: KnowledgeObject): string {
  const blocks: string[] = [];
  if (ko.source.quote) blocks.push(renderCallout('quote', 'Source quote', ko.source.quote));

  const callout = (ko.render_hints?.markdown_callout ?? 'note') as MarkdownCallout;
  blocks.push(renderCallout(callout, 'InkLoop', ko.body_md));
  blocks.push(renderSourceSection(ko));

  return blocks.join('\n\n');
}

export async function renderKnowledgeObjectMarkdown(ko: KnowledgeObject): Promise<RenderedKnowledgeMarkdown> {
  const controlledBody = renderKnowledgeObjectBody(ko);
  const renderBodyHash = await sha256Tagged(controlledBody.trim());
  const controlledSection = renderControlledSection({
    koId: ko.ko_id,
    renderBodyHash,
    body: controlledBody,
  });
  const frontmatter = renderFrontmatterObject(frontmatterForKnowledgeObject(ko, renderBodyHash));
  const title = headingTitle(ko);
  const markdown = [
    frontmatter.trimEnd(),
    '',
    `# ${title}`,
    '',
    controlledSection,
    '',
    '---',
    '',
    '## My notes',
    '',
  ].join('\n');

  return {
    ko_id: ko.ko_id,
    markdown,
    controlled_section: controlledSection,
    controlled_body: controlledBody,
    ko_content_hash: ko.content_hash,
    render_body_hash: renderBodyHash,
    frontmatter,
    title,
  };
}
