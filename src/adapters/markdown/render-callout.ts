export type MarkdownCallout = 'note' | 'quote' | 'question' | 'todo' | 'summary' | 'tip';

export function renderCallout(type: MarkdownCallout, title: string, body: string): string {
  const lines = body.trim().length > 0 ? body.trim().split('\n') : [''];
  return [`> [!${type}] ${title}`, ...lines.map((line) => `> ${line}`)].join('\n');
}
