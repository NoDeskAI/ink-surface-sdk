import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalJson,
  sha256ContentHash,
  type DocumentProjection,
  type KnowledgeObject,
  type KnowledgeRiskStatus,
  type KnowledgeStatus,
} from '../../../packages/knowledge-schema/src/index';

export interface CloudKnowledgeNamespace {
  tenant_id?: string;
  user_id?: string;
}

export interface CloudAiTurnRecord {
  schema_version: 'inkloop.cloud_hub.ai_turn.v1';
  ai_turn_id: string;
  document_id: string;
  mark_ids?: string[];
  prompt_md: string;
  response_md: string;
  status: 'accepted' | 'edited' | 'dismissed' | 'inbox';
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface CloudKnowledgeIndex {
  schema_version: 'inkloop.cloud_hub.knowledge_index.v1';
  tenant_id?: string;
  user_id?: string;
  updated_at: string;
  ai_turns: CloudAiTurnRecord[];
  knowledge_objects: KnowledgeObject[];
  document_projections: DocumentProjection[];
}

export interface CloudKnowledgeObjectPatch {
  title?: string;
  body_md?: string;
  status?: KnowledgeStatus;
  tags?: string[];
  task_done?: boolean;
  risk_status?: KnowledgeRiskStatus;
  risk_note?: string;
  comment_md?: string;
}

export interface CloudKnowledgeDeleteByRuntimeRefInput {
  document_id: string;
  mark_ids?: string[];
  ko_ids?: string[];
}

export interface CloudKnowledgeDeleteByRuntimeRefResult {
  ai_turns_removed: number;
  knowledge_objects_removed: number;
  document_projections_removed: number;
  projection_blocks_removed: number;
}

function safeSegment(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim() || fallback;
  return encodeURIComponent(raw).replace(/%/g, '_');
}

function emptyIndex(namespace: CloudKnowledgeNamespace): CloudKnowledgeIndex {
  return {
    schema_version: 'inkloop.cloud_hub.knowledge_index.v1',
    tenant_id: namespace.tenant_id,
    user_id: namespace.user_id,
    updated_at: new Date().toISOString(),
    ai_turns: [],
    knowledge_objects: [],
    document_projections: [],
  };
}

function byDocumentId<T extends { document_id: string }>(items: readonly T[], documentId?: string): T[] {
  return documentId ? items.filter((item) => item.document_id === documentId) : [...items];
}

function intersects(values: unknown, candidates: ReadonlySet<string>): boolean {
  if (!candidates.size || !Array.isArray(values)) return false;
  return values.some((value) => candidates.has(String(value)));
}

function uniqueStrings(...groups: Array<unknown>): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function mergeKnowledgeObject(existing: KnowledgeObject | undefined, incoming: KnowledgeObject): KnowledgeObject {
  if (!existing) return incoming;
  const markIds = uniqueStrings(existing.provenance?.mark_ids, incoming.provenance?.mark_ids);
  const aiTurnIds = uniqueStrings(existing.provenance?.ai_turn_ids, incoming.provenance?.ai_turn_ids);
  const createdFrom = existing.provenance?.created_from === 'ai_turn' || incoming.provenance?.created_from === 'ai_turn'
    ? 'ai_turn'
    : incoming.provenance?.created_from || existing.provenance?.created_from;
  return {
    ...incoming,
    provenance: {
      ...existing.provenance,
      ...incoming.provenance,
      created_from: createdFrom,
      ...(markIds.length ? { mark_ids: markIds } : {}),
      ...(aiTurnIds.length ? { ai_turn_ids: aiTurnIds } : {}),
    },
  };
}

async function patchedKnowledgeObject(existing: KnowledgeObject, patch: CloudKnowledgeObjectPatch, updatedAt: string): Promise<KnowledgeObject> {
  const controlledPatch = Object.fromEntries(Object.entries({
    task_done: patch.task_done,
    risk_status: patch.risk_status,
    risk_note: patch.risk_note,
    comment_md: patch.comment_md,
  }).filter(([, value]) => value !== undefined));
  const nextObject: KnowledgeObject = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body_md !== undefined ? { body_md: patch.body_md } : {}),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.tags ? { tags: patch.tags } : {}),
    ...(Object.keys(controlledPatch).length
      ? { controlled_fields: { ...(existing.controlled_fields || {}), ...controlledPatch } }
      : {}),
    updated_at: updatedAt,
  };
  if (patch.title === undefined && patch.body_md === undefined && patch.status === undefined) return nextObject;
  const extended = nextObject as KnowledgeObject & { visual_strokes?: unknown; surface_strokes?: unknown };
  return {
    ...nextObject,
    content_hash: await sha256ContentHash(canonicalJson({
      kind: nextObject.kind,
      title: nextObject.title,
      body_md: nextObject.body_md,
      source: nextObject.source,
      ...(nextObject.source_refs ? { source_refs: nextObject.source_refs } : {}),
      status: nextObject.status,
      ...(extended.visual_strokes ? { visual_strokes: extended.visual_strokes } : {}),
      ...(extended.surface_strokes ? { surface_strokes: extended.surface_strokes } : {}),
    })),
  };
}

function blockRefsDeletedMark(block: DocumentProjection['blocks'][number], markIds: ReadonlySet<string>, koIds: ReadonlySet<string>): boolean {
  const refs = block.source?.object_refs;
  if (intersects(refs, markIds)) return true;
  if (intersects(block.knowledge_object_ids, koIds)) return true;
  const annotations = (block as { annotations?: Array<{ ko_id?: string; source?: { object_refs?: string[] } }> }).annotations;
  if (!Array.isArray(annotations)) return false;
  return annotations.some((annotation) => koIds.has(String(annotation.ko_id || '')) || intersects(annotation.source?.object_refs, markIds));
}

function stripDeletedKnowledgeIds(block: DocumentProjection['blocks'][number], koIds: ReadonlySet<string>): DocumentProjection['blocks'][number] {
  if (!koIds.size) return block;
  const next: DocumentProjection['blocks'][number] & { annotations?: unknown[] } = {
    ...block,
    knowledge_object_ids: (block.knowledge_object_ids || []).filter((id) => !koIds.has(id)),
  };
  const annotations = (block as { annotations?: Array<{ ko_id?: string }> }).annotations;
  if (Array.isArray(annotations)) next.annotations = annotations.filter((annotation) => !koIds.has(String(annotation.ko_id || '')));
  return next;
}

export class JsonCloudKnowledgeStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  private namespaceDir(namespace: CloudKnowledgeNamespace): string {
    return join(this.rootDir, safeSegment(namespace.tenant_id, 'local'), safeSegment(namespace.user_id, 'local_demo'));
  }

  private indexPath(namespace: CloudKnowledgeNamespace): string {
    return join(this.namespaceDir(namespace), 'index.json');
  }

  private namespaceKey(namespace: CloudKnowledgeNamespace): string {
    return `${namespace.tenant_id || ''}\u0000${namespace.user_id || ''}`;
  }

  private async withWriteLock<T>(namespace: CloudKnowledgeNamespace, work: () => Promise<T>): Promise<T> {
    const key = this.namespaceKey(namespace);
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.writeQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.writeQueues.get(key) === tail) this.writeQueues.delete(key);
    }
  }

  private async readIndex(namespace: CloudKnowledgeNamespace): Promise<CloudKnowledgeIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath(namespace), 'utf8')) as CloudKnowledgeIndex;
      if (parsed?.schema_version === 'inkloop.cloud_hub.knowledge_index.v1') {
        return {
          ...emptyIndex(namespace),
          ...parsed,
          tenant_id: namespace.tenant_id,
          user_id: namespace.user_id,
          ai_turns: Array.isArray(parsed.ai_turns) ? parsed.ai_turns : [],
          knowledge_objects: Array.isArray(parsed.knowledge_objects) ? parsed.knowledge_objects : [],
          document_projections: Array.isArray(parsed.document_projections) ? parsed.document_projections : [],
        };
      }
    } catch {
      // Missing or partially written knowledge indexes should not block source-file sync.
    }
    return emptyIndex(namespace);
  }

  private async writeIndex(namespace: CloudKnowledgeNamespace, index: CloudKnowledgeIndex): Promise<void> {
    await mkdir(this.namespaceDir(namespace), { recursive: true });
    await writeFile(this.indexPath(namespace), JSON.stringify({ ...index, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  }

  async upsertAiTurn(namespace: CloudKnowledgeNamespace, turn: CloudAiTurnRecord): Promise<CloudAiTurnRecord> {
    return this.withWriteLock(namespace, async () => {
      const index = await this.readIndex(namespace);
      const next = index.ai_turns.filter((item) => item.ai_turn_id !== turn.ai_turn_id);
      next.push(turn);
      await this.writeIndex(namespace, { ...index, ai_turns: next });
      return turn;
    });
  }

  async listAiTurns(namespace: CloudKnowledgeNamespace, documentId?: string): Promise<CloudAiTurnRecord[]> {
    return byDocumentId((await this.readIndex(namespace)).ai_turns, documentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async upsertKnowledgeObject(namespace: CloudKnowledgeNamespace, object: KnowledgeObject): Promise<KnowledgeObject> {
    return this.withWriteLock(namespace, async () => {
      const index = await this.readIndex(namespace);
      const existing = index.knowledge_objects.find((item) => item.ko_id === object.ko_id);
      const nextObject = mergeKnowledgeObject(existing, object);
      const next = index.knowledge_objects.filter((item) => item.ko_id !== object.ko_id);
      next.push(nextObject);
      await this.writeIndex(namespace, { ...index, knowledge_objects: next });
      return nextObject;
    });
  }

  async patchKnowledgeObject(namespace: CloudKnowledgeNamespace, koId: string, patch: CloudKnowledgeObjectPatch, updatedAt = new Date().toISOString()): Promise<KnowledgeObject> {
    return this.withWriteLock(namespace, async () => {
      const index = await this.readIndex(namespace);
      const existing = index.knowledge_objects.find((item) => item.ko_id === koId);
      if (!existing) throw Object.assign(new Error('knowledge_object_not_found'), { status: 404 });
      const nextObject = await patchedKnowledgeObject(existing, patch, updatedAt);
      const next = index.knowledge_objects.filter((item) => item.ko_id !== koId);
      next.push(nextObject);
      await this.writeIndex(namespace, { ...index, knowledge_objects: next });
      return nextObject;
    });
  }

  async listKnowledgeObjects(namespace: CloudKnowledgeNamespace, documentId?: string): Promise<KnowledgeObject[]> {
    return (await this.readIndex(namespace)).knowledge_objects
      .filter((item) => !documentId || item.source.document_id === documentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async upsertDocumentProjection(namespace: CloudKnowledgeNamespace, projection: DocumentProjection): Promise<DocumentProjection> {
    return this.withWriteLock(namespace, async () => {
      const index = await this.readIndex(namespace);
      const next = index.document_projections.filter((item) => item.projection_id !== projection.projection_id);
      next.push(projection);
      await this.writeIndex(namespace, { ...index, document_projections: next });
      return projection;
    });
  }

  async listDocumentProjections(namespace: CloudKnowledgeNamespace, documentId?: string): Promise<DocumentProjection[]> {
    return byDocumentId((await this.readIndex(namespace)).document_projections, documentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async deleteByRuntimeRefs(namespace: CloudKnowledgeNamespace, input: CloudKnowledgeDeleteByRuntimeRefInput): Promise<CloudKnowledgeDeleteByRuntimeRefResult> {
    return this.withWriteLock(namespace, async () => {
      const index = await this.readIndex(namespace);
      const markIds = new Set((input.mark_ids || []).map(String).filter(Boolean));
      const explicitKoIds = new Set((input.ko_ids || []).map(String).filter(Boolean));

      const removedObjects = index.knowledge_objects.filter((item) => {
        if (item.source.document_id !== input.document_id) return false;
        return explicitKoIds.has(item.ko_id)
          || intersects(item.provenance?.mark_ids, markIds)
          || intersects(item.source.object_refs, markIds);
      });
      const removedKoIds = new Set([...explicitKoIds, ...removedObjects.map((item) => item.ko_id)]);

      const nextAiTurns = index.ai_turns.filter((item) =>
        item.document_id !== input.document_id || !intersects(item.mark_ids, markIds));
      const nextObjects = index.knowledge_objects.filter((item) => !removedKoIds.has(item.ko_id));
      let projectionsRemoved = 0;
      let blocksRemoved = 0;
      const nextProjections: DocumentProjection[] = [];
      for (const projection of index.document_projections) {
        if (projection.document_id !== input.document_id) {
          nextProjections.push(projection);
          continue;
        }
        const nextBlocks = projection.blocks
          .filter((block) => {
            const remove = blockRefsDeletedMark(block, markIds, removedKoIds);
            if (remove) blocksRemoved += 1;
            return !remove;
          })
          .map((block) => stripDeletedKnowledgeIds(block, removedKoIds));
        if (!nextBlocks.length) {
          projectionsRemoved += 1;
          continue;
        }
        nextProjections.push({ ...projection, blocks: nextBlocks, updated_at: new Date().toISOString() });
      }

      await this.writeIndex(namespace, {
        ...index,
        ai_turns: nextAiTurns,
        knowledge_objects: nextObjects,
        document_projections: nextProjections,
      });

      return {
        ai_turns_removed: index.ai_turns.length - nextAiTurns.length,
        knowledge_objects_removed: index.knowledge_objects.length - nextObjects.length,
        document_projections_removed: projectionsRemoved,
        projection_blocks_removed: blocksRemoved,
      };
    });
  }
}
