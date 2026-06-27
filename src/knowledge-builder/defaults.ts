import type { KnowledgeKind, KnowledgeObject } from '../knowledge/knowledge-object';

export function defaultTags(kind: KnowledgeKind): string[] {
  const slug = kind.replace(/_/g, '-');
  return ['inkloop', `inkloop/${slug}`];
}

export function defaultCallout(kind: KnowledgeKind): NonNullable<KnowledgeObject['render_hints']>['markdown_callout'] {
  switch (kind) {
    case 'excerpt':
      return 'quote';
    case 'annotation':
    case 'ai_note':
      return 'note';
    case 'qa':
      return 'question';
    case 'summary':
      return 'summary';
    case 'task':
      return 'todo';
    case 'concept':
      return 'tip';
    case 'source_document':
      return 'note';
  }
}
