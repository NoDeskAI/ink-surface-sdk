import { describe, expect, it } from 'vitest';
import type { KnowledgeKind, KnowledgeObject } from '../../knowledge-schema/src/index';
import {
  buildConceptLayer,
  CONCEPT_DOC_ID,
  normConcept,
  type ConceptExtractFn,
  type ConceptKnowledgeObjectDraft,
  type ConceptKnowledgeObjectFactory,
} from './concept-layer';

const ZERO_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const;

function testKoId(index: number): string {
  return `ko_${String(index).padStart(26, '0')}`;
}

function stableKoId(seed: string): string {
  let acc = 0;
  for (const char of seed) acc = (acc * 131 + (char.codePointAt(0) ?? 0)) % 1_000_000_000_000;
  return testKoId(acc);
}

function mkKo(
  index: number,
  documentId: string,
  body: string,
  createdAt = '2026-06-29T10:00:00.000Z',
  kind: KnowledgeKind = 'annotation',
): KnowledgeObject {
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: testKoId(index),
    kind,
    title: body.trim() || `KO ${index}`,
    body_md: body,
    source: {
      document_id: documentId,
      document_title: documentId,
      object_refs: [`ref_${index}`],
      inkloop_uri: `inkloop://documents/${documentId}/objects/${index}`,
    },
    provenance: {
      created_from: 'mark',
      mark_ids: [`mark_${index}`],
    },
    tags: [],
    status: 'export_ready',
    privacy: 'export_allowed',
    content_hash: ZERO_HASH,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeConceptFactory(drafts: ConceptKnowledgeObjectDraft[] = []): ConceptKnowledgeObjectFactory {
  return async (draft) => {
    drafts.push({
      ...draft,
      memberKoIds: [...draft.memberKoIds],
      sourceDocumentIds: [...draft.sourceDocumentIds],
    });

    return {
      schema_version: 'inkloop.knowledge_object.v1',
      ko_id: stableKoId(draft.stableKey),
      kind: 'concept',
      title: draft.displayName,
      body_md: draft.bodyMarkdown,
      source: {
        document_id: draft.documentId,
        document_title: draft.documentTitle,
        object_refs: [...draft.memberKoIds],
        inkloop_uri: `inkloop://concepts/${encodeURIComponent(draft.normalizedName)}`,
      },
      provenance: {
        created_from: 'manual',
      },
      tags: [`concept:${draft.normalizedName}`],
      status: 'export_ready',
      privacy: 'export_allowed',
      content_hash: ZERO_HASH,
      created_at: draft.createdAt,
      updated_at: draft.createdAt,
    };
  };
}

const lookupExtract = (table: Record<string, readonly string[]>): ConceptExtractFn => async (ko) => table[ko.body_md] ?? [];

describe('buildConceptLayer', () => {
  it('两级门槛：跨文档 primary 建 hub，同文档 local 只标叶子，单笔丢弃', async () => {
    const bridgeA = mkKo(1, 'doc_csapp', 'MESI 缓存一致性', '2026-06-29T10:00:00.000Z');
    const bridgeB = mkKo(2, 'doc_ddia', '复制一致性', '2026-06-29T11:00:00.000Z');
    const localA = mkKo(3, 'doc_csapp', '局部性 A', '2026-06-29T12:00:00.000Z');
    const localB = mkKo(4, 'doc_csapp', '局部性 B', '2026-06-29T13:00:00.000Z');
    const singleton = mkKo(5, 'doc_csapp', '虚拟内存', '2026-06-29T14:00:00.000Z');

    const drafts: ConceptKnowledgeObjectDraft[] = [];
    const layer = await buildConceptLayer(
      [singleton, localB, bridgeB, localA, bridgeA],
      lookupExtract({
        'MESI 缓存一致性': ['缓存一致性', 'MESI'],
        复制一致性: ['缓存一致性', '复制'],
        '局部性 A': ['局部性'],
        '局部性 B': ['局部性'],
        虚拟内存: ['虚拟内存'],
      }),
      makeConceptFactory(drafts),
    );

    expect(layer.concepts.map((ko) => ko.title)).toEqual(['缓存一致性']);
    expect(layer.concepts[0]).toMatchObject({
      kind: 'concept',
      title: '缓存一致性',
      source: { document_id: CONCEPT_DOC_ID },
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      stableKey: 'concept:缓存一致性',
      normalizedName: '缓存一致性',
      displayName: '缓存一致性',
      documentId: CONCEPT_DOC_ID,
      documentTitle: '缓存一致性',
      bodyMarkdown: '缓存一致性',
      memberKoIds: [bridgeA.ko_id, bridgeB.ko_id],
      sourceDocumentIds: ['doc_csapp', 'doc_ddia'],
      createdAt: bridgeA.created_at,
    });

    expect(layer.membersByConcept['缓存一致性']).toEqual([bridgeA.ko_id, bridgeB.ko_id]);

    expect(layer.assignmentsByKo[bridgeA.ko_id]).toEqual(['缓存一致性']);
    expect(layer.assignmentsByKo[bridgeB.ko_id]).toEqual(['缓存一致性']);
    expect(Object.keys(layer.assignmentsByKo).sort()).toEqual([bridgeA.ko_id, bridgeB.ko_id].sort());

    expect(layer.localByKo[localA.ko_id]).toEqual(['局部性']);
    expect(layer.localByKo[localB.ko_id]).toEqual(['局部性']);
    expect(Object.keys(layer.localByKo).sort()).toEqual([localA.ko_id, localB.ko_id].sort());

    expect(layer.assignmentsByKo[localA.ko_id]).toBeUndefined();
    expect(layer.localByKo[singleton.ko_id]).toBeUndefined();
  });

  it('确定性排序：concept 按 earliest/display/key，成员按 KO 顺序，不随输入顺序漂移', async () => {
    const alphaA = mkKo(11, 'doc_a', 'alpha a', '2026-06-29T09:00:00.000Z');
    const betaA = mkKo(12, 'doc_c', 'beta a', '2026-06-29T09:00:00.000Z');
    const alphaB = mkKo(13, 'doc_b', 'alpha b', '2026-06-29T10:00:00.000Z');
    const betaB = mkKo(14, 'doc_d', 'beta b', '2026-06-29T10:00:00.000Z');

    const extract = lookupExtract({
      'alpha a': ['Alpha'],
      'alpha b': ['Alpha'],
      'beta a': ['Beta'],
      'beta b': ['Beta'],
    });

    const layer = await buildConceptLayer([betaB, alphaB, betaA, alphaA], extract, makeConceptFactory());
    const again = await buildConceptLayer([alphaB, betaA, alphaA, betaB], extract, makeConceptFactory());

    expect(layer.concepts.map((ko) => ko.title)).toEqual(['Alpha', 'Beta']);
    expect(layer.membersByConcept.Alpha).toEqual([alphaA.ko_id, alphaB.ko_id]);
    expect(layer.membersByConcept.Beta).toEqual([betaA.ko_id, betaB.ko_id]);

    expect(again.concepts.map((ko) => ko.title)).toEqual(layer.concepts.map((ko) => ko.title));
    expect(again.concepts.map((ko) => ko.ko_id)).toEqual(layer.concepts.map((ko) => ko.ko_id));
  });

  it('stableKey 使用规范名，大小写和空白归并后稳定', async () => {
    const early = mkKo(21, 'doc_1', 'x', '2026-06-29T10:00:00.000Z');
    const late = mkKo(22, 'doc_2', 'y', '2026-06-29T11:00:00.000Z');
    const extract = lookupExtract({
      x: ['Cache Coherence'],
      y: ['cache  coherence'],
    });

    const draftsA: ConceptKnowledgeObjectDraft[] = [];
    const draftsB: ConceptKnowledgeObjectDraft[] = [];

    const layerA = await buildConceptLayer([late, early], extract, makeConceptFactory(draftsA));
    const layerB = await buildConceptLayer([early, late], extract, makeConceptFactory(draftsB));

    expect(draftsA[0]).toMatchObject({
      stableKey: 'concept:cache coherence',
      normalizedName: 'cache coherence',
      displayName: 'Cache Coherence',
    });
    expect(draftsB[0].stableKey).toBe(draftsA[0].stableKey);
    expect(layerA.concepts[0].ko_id).toBe(layerB.concepts[0].ko_id);
  });

  it('merge seam：alias 并进 canonical，成员和 assignments 一起重映射', async () => {
    const a = mkKo(31, 'doc_1', 'm1', '2026-06-29T10:00:00.000Z');
    const b = mkKo(32, 'doc_2', 'm2', '2026-06-29T11:00:00.000Z');
    const extract = lookupExtract({
      m1: ['语义层', '抽象层级'],
      m2: ['语义层', '抽象层级'],
    });

    const noMerge = await buildConceptLayer([a, b], extract, makeConceptFactory());
    expect(noMerge.concepts.map((ko) => ko.title).sort()).toEqual(['抽象层级', '语义层'].sort());

    const drafts: ConceptKnowledgeObjectDraft[] = [];
    const merged = await buildConceptLayer([a, b], extract, makeConceptFactory(drafts), {
      merge: () => new Map([['抽象层级', '语义层']]),
    });

    expect(merged.concepts.map((ko) => ko.title)).toEqual(['语义层']);
    expect(drafts[0].stableKey).toBe('concept:语义层');
    expect(merged.membersByConcept['语义层']).toEqual([a.ko_id, b.ko_id]);
    expect(merged.assignmentsByKo[a.ko_id]).toEqual(['语义层']);
    expect(merged.assignmentsByKo[b.ko_id]).toEqual(['语义层']);
  });

  it('占位正文不调用 extract，也不会生成概念或边', async () => {
    const shape = mkKo(41, 'doc_1', '（图形标注 / 圈画）');
    const handwriting = mkKo(42, 'doc_2', '（未识别手写）');
    const timedShape = mkKo(43, 'mtgdoc_1', '（图形标注 / 圈画）　（约 0:16 处手写）');

    let called = 0;
    const drafts: ConceptKnowledgeObjectDraft[] = [];
    const layer = await buildConceptLayer(
      [shape, handwriting, timedShape],
      async () => {
        called += 1;
        return ['噪声'];
      },
      makeConceptFactory(drafts),
    );

    expect(called).toBe(0);
    expect(drafts).toEqual([]);
    expect(layer.concepts).toEqual([]);
    expect(Object.keys(layer.assignmentsByKo)).toEqual([]);
    expect(Object.keys(layer.membersByConcept)).toEqual([]);
    expect(Object.keys(layer.localByKo)).toEqual([]);
  });

  it('normConcept 做 NFKC、压空白、折大小写', () => {
    expect(normConcept('  Ｃache   Coherence ')).toBe('cache coherence');
    expect(normConcept('缓存一致性')).toBe('缓存一致性');
  });
});
