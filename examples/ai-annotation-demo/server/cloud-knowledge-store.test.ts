import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentProjection, KnowledgeObject } from 'ink-surface-sdk/knowledge-schema';
import { JsonCloudKnowledgeStore, type CloudAiTurnRecord } from './cloud-knowledge-store';

function object(id = 'ko_cloud_patch', documentId = 'doc_cloud_patch', aiTurnId = 'turn_1', markId = 'mark_1'): KnowledgeObject {
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: id,
    kind: 'meeting_risk',
    title: 'Cloud patch risk',
    body_md: 'Risk body.',
    source: {
      document_id: documentId,
      document_title: 'Cloud Patch',
      object_refs: [markId],
      inkloop_uri: `inkloop://doc/${documentId}`,
    },
    provenance: { created_from: 'ai_turn', mark_ids: [markId], ai_turn_ids: [aiTurnId] },
    tags: ['inkloop', 'inkloop/meeting_risk'],
    status: 'accepted',
    privacy: 'export_allowed',
    content_hash: 'sha256:cloudpatch',
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
  };
}

function aiTurn(id: string, documentId: string, markId = `mark_${id}`): CloudAiTurnRecord {
  return {
    schema_version: 'inkloop.cloud_hub.ai_turn.v1',
    ai_turn_id: id,
    document_id: documentId,
    mark_ids: [markId],
    prompt_md: 'Prompt',
    response_md: 'Response',
    status: 'accepted',
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
  };
}

function projection(id: string, documentId: string, koId: string, markId = 'mark_1'): DocumentProjection {
  return {
    schema_version: 'inkloop.document_projection.v1',
    projection_id: id,
    document_id: documentId,
    document_title: 'Cloud Patch',
    document_uri: `inkloop://doc/${documentId}`,
    revision_id: `rev_${id}`,
    generated_at: '2026-07-04T00:00:00.000Z',
    source: { app: 'inkloop-test', app_version: '0.1.0' },
    privacy: 'export_allowed',
    export_policy: {
      include_full_text: false,
      include_pdf_asset: false,
      include_raw_strokes: false,
      include_debug_evidence: false,
    },
    blocks: [{
      block_id: `blk_${id}`,
      kind: 'paragraph',
      text_md: 'Projected text',
      region: 'generated',
      source: {
        page_id: 'pg_1',
        page_index: 0,
        object_refs: [markId],
      },
      knowledge_object_ids: [koId],
    }],
    body_hash: `sha256:body_${id}`,
    content_hash: `sha256:content_${id}`,
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
  };
}

describe('JsonCloudKnowledgeStore', () => {
  it('patches controlled Obsidian fields onto persisted KnowledgeObjects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-knowledge-store-'));
    try {
      const store = new JsonCloudKnowledgeStore(root);
      const namespace = { tenant_id: 'local', user_id: 'local_demo' };
      await store.upsertKnowledgeObject(namespace, object());

      const updated = await store.patchKnowledgeObject(namespace, 'ko_cloud_patch', {
        status: 'edited',
        tags: ['inkloop', 'inkloop/meeting_risk', 'mitigated'],
        risk_status: 'mitigated',
        risk_note: 'Supplier has a backup part.',
      }, '2026-07-04T00:01:00.000Z');
      const listed = await store.listKnowledgeObjects(namespace, 'doc_cloud_patch');

      expect(updated.status).toBe('edited');
      expect(updated.tags).toEqual(['inkloop', 'inkloop/meeting_risk', 'mitigated']);
      expect(updated.controlled_fields).toMatchObject({
        risk_status: 'mitigated',
        risk_note: 'Supplier has a backup part.',
      });
      expect(updated.updated_at).toBe('2026-07-04T00:01:00.000Z');
      expect(listed[0]).toMatchObject(updated);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent namespace writes so post-processing records are not lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-knowledge-store-'));
    try {
      const store = new JsonCloudKnowledgeStore(root);
      const namespace = { tenant_id: 'local', user_id: 'local_demo' };
      const documentId = 'doc_concurrent_postprocess';
      const count = 8;

      await Promise.all(Array.from({ length: count }, (_, index) => {
        const turnId = `turn_${index}`;
        const koId = `ko_${index}`;
        return Promise.all([
          store.upsertAiTurn(namespace, aiTurn(turnId, documentId)),
          store.upsertKnowledgeObject(namespace, object(koId, documentId, turnId)),
          store.upsertDocumentProjection(namespace, projection(`dp_${index}`, documentId, koId)),
        ]);
      }));

      await expect(store.listAiTurns(namespace, documentId)).resolves.toHaveLength(count);
      await expect(store.listKnowledgeObjects(namespace, documentId)).resolves.toHaveLength(count);
      await expect(store.listDocumentProjections(namespace, documentId)).resolves.toHaveLength(count);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves post-processing provenance when a runtime snapshot upserts the same KnowledgeObject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-knowledge-store-'));
    try {
      const store = new JsonCloudKnowledgeStore(root);
      const namespace = { tenant_id: 'local', user_id: 'local_demo' };
      const documentId = 'doc_duplicate_ko';

      await store.upsertKnowledgeObject(namespace, object('ko_same', documentId, 'turn_postprocess', 'mark_runtime'));
      await store.upsertKnowledgeObject(namespace, {
        ...object('ko_same', documentId, 'turn_snapshot', 'tl_1'),
        body_md: 'Runtime snapshot body.',
        provenance: { created_from: 'mark', mark_ids: ['tl_1', 'tl_2'] },
        source: {
          ...object('ko_same', documentId, 'turn_snapshot', 'tl_1').source,
          object_refs: ['tl_1', 'tl_2'],
        },
      });

      const [listed] = await store.listKnowledgeObjects(namespace, documentId);
      expect(listed.provenance.created_from).toBe('ai_turn');
      expect(listed.provenance.ai_turn_ids).toEqual(['turn_postprocess']);
      expect(listed.provenance.mark_ids).toEqual(['mark_runtime', 'tl_1', 'tl_2']);
      expect(listed.body_md).toBe('Runtime snapshot body.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes Cloud Hub post-processing records when a runtime mark is tombstoned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-knowledge-store-'));
    try {
      const store = new JsonCloudKnowledgeStore(root);
      const namespace = { tenant_id: 'local', user_id: 'local_demo' };
      const documentId = 'doc_delete_mark';

      await store.upsertAiTurn(namespace, aiTurn('turn_deleted', documentId, 'mark_deleted'));
      await store.upsertAiTurn(namespace, aiTurn('turn_kept', documentId, 'mark_kept'));
      await store.upsertKnowledgeObject(namespace, object('ko_deleted', documentId, 'turn_deleted', 'mark_deleted'));
      await store.upsertKnowledgeObject(namespace, object('ko_kept', documentId, 'turn_kept', 'mark_kept'));
      await store.upsertDocumentProjection(namespace, projection('dp_deleted', documentId, 'ko_deleted', 'mark_deleted'));
      await store.upsertDocumentProjection(namespace, projection('dp_kept', documentId, 'ko_kept', 'mark_kept'));

      const result = await store.deleteByRuntimeRefs(namespace, {
        document_id: documentId,
        mark_ids: ['mark_deleted'],
      });

      expect(result).toMatchObject({
        ai_turns_removed: 1,
        knowledge_objects_removed: 1,
        document_projections_removed: 1,
        projection_blocks_removed: 1,
      });
      expect((await store.listAiTurns(namespace, documentId)).map((item) => item.ai_turn_id)).toEqual(['turn_kept']);
      expect((await store.listKnowledgeObjects(namespace, documentId)).map((item) => item.ko_id)).toEqual(['ko_kept']);
      expect((await store.listDocumentProjections(namespace, documentId)).map((item) => item.projection_id)).toEqual(['dp_kept']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
