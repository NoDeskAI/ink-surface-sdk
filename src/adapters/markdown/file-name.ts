import type { KnowledgeKind, KnowledgeObject } from '../../knowledge/knowledge-object';

export function sanitizeFileName(input: string): string {
  return (
    input
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '') || 'Untitled'
  );
}

export function kindToFileLabel(kind: KnowledgeKind): string {
  switch (kind) {
    case 'source_document':
      return 'Source';
    case 'excerpt':
      return 'Excerpt';
    case 'annotation':
      return 'Annotation';
    case 'ai_note':
      return 'AI Note';
    case 'qa':
      return 'QA';
    case 'summary':
      return 'Summary';
    case 'task':
      return 'Task';
    case 'concept':
      return 'Concept';
  }
}

export function makeObsidianFileName(ko: KnowledgeObject): string {
  const date = ko.created_at.slice(0, 10);
  const kindLabel = kindToFileLabel(ko.kind);
  const title = sanitizeFileName(ko.source.document_title || ko.title).slice(0, 80);
  const page = ko.source.page_index === undefined ? '' : ` p${ko.source.page_index + 1}`;
  const tail = ko.ko_id.slice(-6);
  return `${date} ${kindLabel} - ${title}${page} - ${tail}.md`;
}

export function sourceNoteFileName(documentTitle: string, documentId: string): string {
  return `${sanitizeFileName(documentTitle).slice(0, 100)} - ${sanitizeFileName(documentId)}.md`;
}

export function sourceNoteBaseName(documentTitle: string, documentId: string): string {
  return sourceNoteFileName(documentTitle, documentId).replace(/\.md$/, '');
}
