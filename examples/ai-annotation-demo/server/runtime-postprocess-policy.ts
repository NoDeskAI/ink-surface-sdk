import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function isMeetingRuntimeDocumentId(documentId: string): boolean {
  return documentId.startsWith('mtgdoc_');
}

export function shouldPostprocessRuntimeAnnotation(event: RuntimeSyncEvent): boolean {
  // update（revision：几何修改/撤销复活）与 add 同等进入后处理判定——否则删除后复活的 mark
  // 在 Cloud Knowledge 里永远缺席。update 的注解体在 payload.patch。
  if (event.operation !== 'annotation.add' && event.operation !== 'annotation.update') return false;
  if (isMeetingRuntimeDocumentId(event.doc_id)) return true;

  const payload = recordOf(event.payload);
  const annotation = recordOf(event.operation === 'annotation.update' ? payload.patch : payload.annotation);
  if (payload.ai_eligible === true || annotation.ai_eligible === true) return true;
  if (payload.ai_eligible === false || annotation.ai_eligible === false) return false;

  const raw = [
    payload.kind,
    payload.feature_type,
    payload.tool,
    payload.origin,
    payload.scored_type,
    payload.hmp_action,
    annotation.kind,
    annotation.title,
    annotation.render_mode,
  ].map(textOf).join(' ');
  if (/\b(ai_pen|aipen|ai_note|ai_response|qa|question)\b/.test(raw)) return true;
  if (/\b(pen|highlighter|highlight|underline|stroke|drawing)\b/.test(raw)) return false;
  return false;
}

export function shouldExportCloudAiTurn(turn: { metadata?: Record<string, unknown>; status?: string } | null | undefined): boolean {
  if (!turn) return false;
  if (turn.metadata?.classifier_respond === false) return false;
  return true;
}
