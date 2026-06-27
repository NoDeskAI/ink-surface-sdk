import type { InkLoopDoc } from './types';

export function documentDisplayTitle(doc: Pick<InkLoopDoc, 'title' | 'filename'>): string {
  return doc.title?.trim() || doc.filename?.trim() || 'Untitled document';
}
