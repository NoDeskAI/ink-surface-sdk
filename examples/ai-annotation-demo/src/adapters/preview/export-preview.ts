import type { ConflictRecord } from '../core/types';
import { isExportableDocumentProjection, type DocumentProjection } from '../../knowledge/document-projection';
import { isExportableKnowledgeObject, type KnowledgeObject } from '../../knowledge/knowledge-object';

export interface ExportPreviewTarget {
  provider: string;
  target_id?: string;
  vault_root?: string;
  base_dir?: string;
  documents_dir?: string;
}

export interface ExportPreview {
  document_count: number;
  full_text_document_count: number;
  document_block_count: number;
  exported_text_chars: number;
  knowledge_object_count: number;
  exportable_knowledge_object_count: number;
  local_only_count: number;
  requires_full_text_gate: boolean;
  target?: ExportPreviewTarget;
  privacy_blocked: Array<{
    id: string;
    kind: 'document_projection' | 'knowledge_object';
    reason: string;
  }>;
  warnings: string[];
  conflict_count: number;
  pending_conflict_ids: string[];
}

export function buildExportPreview(input: {
  projections?: DocumentProjection[];
  knowledgeObjects?: KnowledgeObject[];
  target?: ExportPreviewTarget;
  conflicts?: ConflictRecord[];
}): ExportPreview {
  const projections = input.projections ?? [];
  const knowledgeObjects = input.knowledgeObjects ?? [];
  const privacyBlocked: ExportPreview['privacy_blocked'] = [];
  const warnings: string[] = [];

  for (const projection of projections) {
    if (!isExportableDocumentProjection(projection)) {
      privacyBlocked.push({
        id: projection.projection_id,
        kind: 'document_projection',
        reason: projection.privacy === 'local_only' ? 'privacy=local_only' : 'full text export is not enabled',
      });
    }
    if (projection.export_policy.include_pdf_asset) warnings.push(`${projection.projection_id}: PDF asset export is enabled.`);
    if (projection.export_policy.include_raw_strokes) warnings.push(`${projection.projection_id}: raw stroke export is enabled.`);
    if (projection.export_policy.include_debug_evidence) warnings.push(`${projection.projection_id}: debug evidence export is enabled.`);
  }

  for (const object of knowledgeObjects) {
    if (!isExportableKnowledgeObject(object)) {
      privacyBlocked.push({
        id: object.ko_id,
        kind: 'knowledge_object',
        reason: object.privacy === 'local_only' ? 'privacy=local_only' : `status/body not exportable (${object.status})`,
      });
    }
  }

  const conflicts = input.conflicts ?? [];
  const openConflicts = conflicts.filter((conflict) => conflict.resolution_status === 'open');
  return {
    document_count: projections.length,
    full_text_document_count: projections.filter((projection) => projection.export_policy.include_full_text).length,
    document_block_count: projections.reduce((sum, projection) => sum + projection.blocks.length, 0),
    exported_text_chars: projections.reduce((sum, projection) => sum + projection.blocks.reduce((blockSum, block) => blockSum + block.text_md.length, 0), 0),
    knowledge_object_count: knowledgeObjects.length,
    exportable_knowledge_object_count: knowledgeObjects.filter(isExportableKnowledgeObject).length,
    local_only_count: [...projections, ...knowledgeObjects].filter((item) => item.privacy === 'local_only').length,
    requires_full_text_gate: projections.some((projection) => projection.export_policy.include_full_text),
    target: input.target,
    privacy_blocked: privacyBlocked,
    warnings,
    conflict_count: openConflicts.length,
    pending_conflict_ids: openConflicts.map((conflict) => conflict.conflict_id),
  };
}
