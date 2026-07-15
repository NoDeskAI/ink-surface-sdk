import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type {
  CloudKnowledgeDeleteByRuntimeRefInput,
  CloudKnowledgeNamespace,
  CloudKnowledgeObjectPatch,
  JsonCloudKnowledgeStore,
} from './cloud-knowledge-store';

type RuntimeAnnotationPostprocessStore = Pick<JsonCloudKnowledgeStore, 'deleteByRuntimeRefs' | 'patchKnowledgeObject'>;

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasMarkSequence(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim().length > 0);
}

export function isRuntimeAnnotationRevisionUpdate(event: RuntimeSyncEvent): boolean {
  if (event.operation !== 'annotation.update') return false;
  const payload = recordOf(event.payload);
  const patch = recordOf(payload.patch);
  return !!textOf(payload.mark_id) && (hasMarkSequence(payload.mark_seq) || !!textOf(patch.ko_id));
}

function knowledgeObjectPatch(event: RuntimeSyncEvent): CloudKnowledgeObjectPatch {
  const patch = recordOf(recordOf(event.payload).patch);
  return {
    ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    ...(typeof patch.body_md === 'string' ? { body_md: patch.body_md } : {}),
  };
}

export async function prepareRuntimeAnnotationUpdate(
  event: RuntimeSyncEvent,
  namespace: CloudKnowledgeNamespace,
  store: RuntimeAnnotationPostprocessStore,
): Promise<'not_update' | 'patched' | 'rebuild'> {
  if (event.operation !== 'annotation.update') return 'not_update';
  const payload = recordOf(event.payload);
  const koId = textOf(payload.ko_id) || textOf(event.target?.id);
  if (!koId) throw Object.assign(new Error('annotation_update_missing_ko_id'), { status: 400 });

  if (isRuntimeAnnotationRevisionUpdate(event)) {
    const refs: CloudKnowledgeDeleteByRuntimeRefInput = {
      document_id: event.doc_id,
      mark_ids: [textOf(payload.mark_id)],
      ko_ids: [koId],
    };
    await store.deleteByRuntimeRefs(namespace, refs);
    return 'rebuild';
  }

  const patch = knowledgeObjectPatch(event);
  if (Object.keys(patch).length) await store.patchKnowledgeObject(namespace, koId, patch, event.updated_at);
  return 'patched';
}
