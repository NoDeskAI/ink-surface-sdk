import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KnowledgeObject } from 'ink-surface-sdk/knowledge-schema';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { JsonCloudKnowledgeStore, type CloudAiTurnRecord } from './cloud-knowledge-store';
import { isRuntimeAnnotationRevisionUpdate, prepareRuntimeAnnotationUpdate } from './runtime-annotation-postprocess';

const namespace = { tenant_id: 'local', user_id: 'runtime_annotation_test' };

function knowledgeObject(koId: string, documentId: string, markId: string): KnowledgeObject {
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: koId,
    kind: 'reading_note',
    title: 'Original title',
    body_md: 'Original body',
    source: {
      document_id: documentId,
      document_title: 'Runtime annotation test',
      object_refs: [markId],
      inkloop_uri: `inkloop://doc/${documentId}`,
    },
    provenance: { created_from: 'ai_turn', mark_ids: [markId], ai_turn_ids: ['turn_existing'] },
    tags: ['inkloop', 'inkloop/reading_note'],
    status: 'accepted',
    privacy: 'export_allowed',
    content_hash: 'sha256:original',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  };
}

function aiTurn(documentId: string, markId: string): CloudAiTurnRecord {
  return {
    schema_version: 'inkloop.cloud_hub.ai_turn.v1',
    ai_turn_id: 'turn_existing',
    document_id: documentId,
    mark_ids: [markId],
    prompt_md: 'Existing prompt',
    response_md: 'Existing response',
    status: 'accepted',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  };
}

function updateEvent(payload: Record<string, unknown>): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: 'evt_annotation_update',
    source: 'obsidian_plugin',
    doc_id: 'doc_annotation_update',
    operation: 'annotation.update',
    target: { type: 'annotation', id: 'ko_annotation_update', block_id: 'blk_annotation_update' },
    payload,
    status: 'sent',
    dedupe_key: 'evt_annotation_update',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:01:00.000Z',
  };
}

describe('runtime annotation update postprocess', () => {
  it('patches an Obsidian ko-only update in place without creating another KO or AI turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-runtime-annotation-'));
    try {
      const store = new JsonCloudKnowledgeStore(root);
      await store.upsertKnowledgeObject(namespace, knowledgeObject('ko_annotation_update', 'doc_annotation_update', 'mark_original'));
      await store.upsertAiTurn(namespace, aiTurn('doc_annotation_update', 'mark_original'));
      const event = updateEvent({
        ko_id: 'ko_annotation_update',
        block_id: 'blk_annotation_update',
        patch: { title: 'Edited in Obsidian', body_md: 'Edited body in Obsidian' },
      });

      expect(isRuntimeAnnotationRevisionUpdate(event)).toBe(false);
      await expect(prepareRuntimeAnnotationUpdate(event, namespace, store)).resolves.toBe('patched');

      const objects = await store.listKnowledgeObjects(namespace, 'doc_annotation_update');
      const turns = await store.listAiTurns(namespace, 'doc_annotation_update');
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatchObject({
        ko_id: 'ko_annotation_update',
        title: 'Edited in Obsidian',
        body_md: 'Edited body in Obsidian',
        updated_at: event.updated_at,
      });
      expect(objects[0].content_hash).not.toBe('sha256:original');
      expect(turns.map((turn) => turn.ai_turn_id)).toEqual(['turn_existing']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears old derived records and keeps a full mark revision on the rebuild path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-runtime-annotation-'));
    try {
      const store = new JsonCloudKnowledgeStore(root);
      await store.upsertKnowledgeObject(namespace, knowledgeObject('ko_annotation_update', 'doc_annotation_update', 'mark_revision'));
      await store.upsertAiTurn(namespace, aiTurn('doc_annotation_update', 'mark_revision'));
      const event = updateEvent({
        ko_id: 'ko_annotation_update',
        mark_id: 'mark_revision',
        mark_seq: 2,
        patch: {
          ko_id: 'ko_annotation_update',
          kind: 'reading_note',
          title: 'Complete revision',
          body_md: 'Complete revision body',
          inkloop_mark: { mark_id: 'mark_revision', mark_seq: 2 },
        },
      });

      expect(isRuntimeAnnotationRevisionUpdate(event)).toBe(true);
      await expect(prepareRuntimeAnnotationUpdate(event, namespace, store)).resolves.toBe('rebuild');
      await expect(store.listKnowledgeObjects(namespace, 'doc_annotation_update')).resolves.toEqual([]);
      await expect(store.listAiTurns(namespace, 'doc_annotation_update')).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
