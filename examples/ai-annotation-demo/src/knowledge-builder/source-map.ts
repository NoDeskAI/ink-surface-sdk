import { buildInkloopPageUri } from '../knowledge/uri';
import type { KnowledgeObject } from '../knowledge/knowledge-object';
import type { InkLoopAiTurn, InkLoopDoc, InkLoopMark } from './types';
import { documentDisplayTitle } from './document-title';

export function findPrimaryMark(aiTurn: InkLoopAiTurn | undefined, marks: InkLoopMark[]): InkLoopMark | undefined {
  const ids = aiTurn?.anchor?.mark_ids ?? [];
  return marks.find((mark) => ids.includes(mark.mark_id));
}

export function buildSource(input: {
  doc: InkLoopDoc;
  mark?: InkLoopMark;
  aiTurn?: InkLoopAiTurn;
}): KnowledgeObject['source'] {
  const mark = input.mark;
  const objectRefs = mark?.hmp?.target_object_refs ?? mark?.hmp?.object_refs ?? input.aiTurn?.anchor?.object_refs ?? [];
  const anchorObjectId = objectRefs[0];
  const pageIndex = mark?.page_index ?? input.aiTurn?.page_index;

  return {
    document_id: input.doc.document_id,
    document_title: documentDisplayTitle(input.doc),
    page_id: mark?.page_id ?? input.aiTurn?.page_id,
    page_index: pageIndex,
    object_refs: objectRefs,
    anchor_bbox: mark?.bbox ?? mark?.hmp?.anchor_bbox ?? input.aiTurn?.inference_view?.anchor_bbox,
    quote: mark?.marked_text || undefined,
    inkloop_uri: pageIndex === undefined
      ? `inkloop://doc/${encodeURIComponent(input.doc.document_id)}`
      : buildInkloopPageUri({
          documentId: input.doc.document_id,
          pageIndex,
          anchorObjectId,
        }),
  };
}
