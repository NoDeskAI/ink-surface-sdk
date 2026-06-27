import { buildInkloopDocUri } from '../../knowledge/uri';
import { renderFrontmatterObject } from './frontmatter';

export function renderSourceNote(input: {
  documentId: string;
  documentTitle: string;
  now: string;
}): string {
  const uri = buildInkloopDocUri(input.documentId);
  const frontmatter = renderFrontmatterObject({
    inkloop_document_id: input.documentId,
    document_title: input.documentTitle,
    inkloop_uri: uri,
    created: input.now,
    updated: input.now,
    tags: ['inkloop', 'inkloop/source'],
  });

  return [
    frontmatter.trimEnd(),
    '',
    `# ${input.documentTitle}`,
    '',
    `<!-- inkloop:document-uri ${uri} -->`,
    '',
    '## Notes exported from InkLoop',
    '',
    '<!-- InkLoop may append links here in v1.1. v1 can leave this section empty. -->',
    '',
  ].join('\n');
}
