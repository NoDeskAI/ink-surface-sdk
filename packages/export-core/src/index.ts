import type { EntityMembership, KnowledgeEntity, KnowledgeObject, KoRelationGroup } from 'ink-surface-sdk/knowledge-schema';

export type EntityMode = 'reading' | 'diary' | 'meeting';

export interface ConceptHub {
  title: string;
  entity_id?: string;
}

export interface ConceptRelation {
  relation_id: string;
  kind: KoRelationGroup['kind'];
  source?: KoRelationGroup['source'];
  confidence?: KoRelationGroup['confidence'];
  ko_id: string;
}

export interface ConceptLayer {
  concepts: KnowledgeObject[];
  hubs?: ConceptHub[];
  assignmentsByKo: Record<string, string[]>;
  membersByConcept: Record<string, string[]>;
  localByKo: Record<string, string[]>;
  entityIdsByKo?: Record<string, string[]>;
  membersByEntity?: Record<string, string[]>;
  relationGroups?: KoRelationGroup[];
  relationsByKo?: Record<string, ConceptRelation[]>;
}

export type ConceptExtractFn = (ko: KnowledgeObject) => Promise<string[]> | string[];

export interface ConceptKnowledgeObjectDraft {
  stableKey: string;
  documentId: string;
  documentTitle: string;
  displayName: string;
  memberKoIds: string[];
  bodyMarkdown: string;
  createdAt: string;
}

export type ConceptKnowledgeObjectFactory = (draft: ConceptKnowledgeObjectDraft) => Promise<KnowledgeObject> | KnowledgeObject;

function dayOf(isoDate?: string): string | undefined {
  return isoDate && /^\d{4}-\d{2}-\d{2}/.test(isoDate) ? isoDate.slice(0, 10) : undefined;
}

function slug(input: string): string {
  return input.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

export function entityModeOf(documentId: string): EntityMode {
  if (/^(mtgdoc|meeting|mtg)[_-]/.test(documentId)) return 'meeting';
  if (/^(diary|journal)[_-]/.test(documentId)) return 'diary';
  return 'reading';
}

export function taxonomyTags(input: {
  documentId: string;
  documentTitle?: string;
  isoDate?: string;
  date?: string;
  mode?: EntityMode;
  entitySlug?: string;
}): string[] {
  const mode = input.mode ?? entityModeOf(input.documentId);
  const date = dayOf(input.date) ?? dayOf(input.isoDate);
  const tags = [`inkloop/${mode}`];
  if (mode === 'reading') tags.push(`inkloop/book/${input.entitySlug ?? slug(input.documentTitle || input.documentId)}`);
  if (mode === 'diary' && date) tags.push(`inkloop/diary/${date}`);
  if (mode === 'meeting') tags.push(`inkloop/meeting/${input.entitySlug ?? slug(input.documentTitle || input.documentId)}`);
  if (date) tags.push(`inkloop/date/${date}`);
  return tags;
}

function pushUnique(record: Record<string, string[]>, key: string, value: string): void {
  const bucket = (record[key] ??= []);
  if (!bucket.includes(value)) bucket.push(value);
}

function emptyLayer(): ConceptLayer {
  return { concepts: [], assignmentsByKo: {}, membersByConcept: {}, localByKo: {} };
}

export async function buildConceptLayer(
  kos: readonly KnowledgeObject[],
  extract: ConceptExtractFn,
  createConceptKo?: ConceptKnowledgeObjectFactory,
): Promise<ConceptLayer | undefined> {
  const layer = emptyLayer();
  const normalizedTitle = new Map<string, string>();

  for (const ko of kos) {
    let concepts: string[];
    try {
      concepts = await extract(ko);
    } catch {
      concepts = [];
    }
    for (const raw of concepts) {
      const title = raw.normalize('NFKC').trim();
      if (!title) continue;
      const key = title.toLocaleLowerCase('en-US');
      const canonical = normalizedTitle.get(key) ?? title;
      normalizedTitle.set(key, canonical);
      pushUnique(layer.assignmentsByKo, ko.ko_id, canonical);
      pushUnique(layer.membersByConcept, canonical, ko.ko_id);
      pushUnique(layer.localByKo, ko.ko_id, canonical);
    }
  }

  const hubs = [...normalizedTitle.values()].sort().map((title) => ({ title }));
  if (hubs.length) layer.hubs = hubs;

  if (createConceptKo) {
    for (const hub of hubs) {
      const members = layer.membersByConcept[hub.title] ?? [];
      layer.concepts.push(await createConceptKo({
        stableKey: `concept:${hub.title}`,
        documentId: 'concepts',
        documentTitle: 'Concepts',
        displayName: hub.title,
        memberKoIds: members,
        bodyMarkdown: members.map((id) => `- [[${id}]]`).join('\n') || hub.title,
        createdAt: kos[0]?.created_at ?? new Date(0).toISOString(),
      }));
    }
  }

  return hubs.length || layer.concepts.length ? layer : undefined;
}

export function buildConceptLayerFromStoredMemberships(
  kos: readonly Pick<KnowledgeObject, 'ko_id'>[],
  entities: readonly KnowledgeEntity[],
  memberships: readonly EntityMembership[],
  relationGroups: readonly KoRelationGroup[] = [],
): ConceptLayer {
  const koIds = new Set(kos.map((ko) => ko.ko_id));
  const entityById = new Map(entities.map((entity) => [entity.entity_id, entity] as const));
  const layer = emptyLayer();

  const activeMemberships = memberships.filter((membership) => koIds.has(membership.ko_id));
  for (const membership of activeMemberships) {
    const entity = entityById.get(membership.entity_id);
    const title = entity?.display ?? membership.entity_id;
    pushUnique(layer.assignmentsByKo, membership.ko_id, title);
    pushUnique(layer.membersByConcept, title, membership.ko_id);
    pushUnique(layer.localByKo, membership.ko_id, title);
    pushUnique((layer.entityIdsByKo ??= {}), membership.ko_id, membership.entity_id);
    pushUnique((layer.membersByEntity ??= {}), membership.entity_id, membership.ko_id);
  }

  const referencedEntityIds = new Set(activeMemberships.map((membership) => membership.entity_id));
  const hubs = [...referencedEntityIds]
    .sort()
    .map((entityId) => ({ entity_id: entityId, title: entityById.get(entityId)?.display ?? entityId }));
  if (hubs.length) layer.hubs = hubs;

  const activeRelationGroups = relationGroups
    .map((group) => ({ ...group, ko_ids: group.ko_ids.filter((id) => koIds.has(id)) }))
    .filter((group) => group.ko_ids.length >= 2);
  if (activeRelationGroups.length) {
    layer.relationGroups = activeRelationGroups;
    const relationsByKo: Record<string, ConceptRelation[]> = {};
    for (const group of activeRelationGroups) {
      for (const koId of group.ko_ids) {
        for (const peerId of group.ko_ids) {
          if (peerId === koId) continue;
          (relationsByKo[koId] ??= []).push({
            relation_id: group.relation_id,
            kind: group.kind,
            source: group.source,
            confidence: group.confidence,
            ko_id: peerId,
          });
        }
      }
    }
    layer.relationsByKo = relationsByKo;
  }

  for (const [entityId, members] of Object.entries(layer.membersByEntity ?? {})) {
    if (members.length < 2) continue;
    const relationId = `rel:same_entity:${entityId}`;
    for (const koId of members) {
      const bucket = (layer.relationsByKo ??= {})[koId] ??= [];
      for (const peerId of members) {
        if (peerId === koId) continue;
        bucket.push({ relation_id: relationId, kind: 'same_entity', source: 'entity_membership', confidence: 'deterministic', ko_id: peerId });
      }
    }
  }

  return layer;
}
