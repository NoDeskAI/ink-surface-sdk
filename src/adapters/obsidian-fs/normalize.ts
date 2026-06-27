import type { DocumentProjection } from '../../knowledge/document-projection';
import { computeKnowledgeHash } from '../../knowledge/hash';
import { parseKnowledgeObject, type KnowledgeObject } from '../../knowledge/knowledge-object';

export async function normalizeKnowledgeObjectsForProjectionTitles(
  objects: KnowledgeObject[] | undefined,
  projections: DocumentProjection[] | undefined,
): Promise<KnowledgeObject[] | undefined> {
  if (!objects) return undefined;
  if (!projections?.length) return objects.map(parseKnowledgeObject);
  const titleByDocumentId = new Map(projections.map((projection) => [projection.document_id, projection.document_title]));

  return Promise.all(objects.map(async (raw) => {
    const object = parseKnowledgeObject(raw);
    const documentTitle = titleByDocumentId.get(object.source.document_id)?.trim();
    if (!documentTitle || documentTitle === object.source.document_title) return object;

    const { content_hash: _contentHash, ...withoutHash } = {
      ...object,
      source: {
        ...object.source,
        document_title: documentTitle,
      },
    };
    return { ...withoutHash, content_hash: await computeKnowledgeHash(withoutHash) };
  }));
}
