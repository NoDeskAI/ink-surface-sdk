import path from 'node:path';
import type { DocumentProjection } from '../../knowledge/document-projection';
import type { KnowledgeKind, KnowledgeObject } from '../../knowledge/knowledge-object';
import { makeObsidianFileName, sourceNoteFileName } from '../markdown/file-name';
import type { ObsidianFsTarget } from './config';
import { toVaultRelative } from './target';

export function dirForKind(target: ObsidianFsTarget, kind: KnowledgeKind): string {
  switch (kind) {
    case 'source_document':
      return target.sources_dir;
    case 'task':
      return target.tasks_dir;
    case 'summary':
      return target.summaries_dir;
    case 'concept':
      return target.concepts_dir;
    case 'excerpt':
    case 'annotation':
    case 'ai_note':
    case 'qa':
      return target.notes_dir;
  }
}

export function pathForKnowledgeObject(target: ObsidianFsTarget, ko: KnowledgeObject): { absolutePath: string; remotePath: string } {
  const absolutePath = path.join(dirForKind(target, ko.kind), makeObsidianFileName(ko));
  return { absolutePath, remotePath: toVaultRelative(target.vault_root, absolutePath) };
}

export function pathForSourceNote(target: ObsidianFsTarget, documentTitle: string, documentId: string): { absolutePath: string; remotePath: string } {
  const absolutePath = path.join(target.sources_dir, sourceNoteFileName(documentTitle, documentId));
  return { absolutePath, remotePath: toVaultRelative(target.vault_root, absolutePath) };
}

export function pathForDocumentProjection(target: ObsidianFsTarget, projection: DocumentProjection): { absolutePath: string; remotePath: string } {
  const absolutePath = path.join(target.sources_dir, sourceNoteFileName(projection.document_title, projection.document_id));
  return { absolutePath, remotePath: toVaultRelative(target.vault_root, absolutePath) };
}
