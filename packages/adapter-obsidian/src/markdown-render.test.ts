import { describe, expect, it } from 'vitest';
import {
  buildConceptLayer,
  taxonomyTags,
  type ConceptKnowledgeObjectDraft,
  type ConceptKnowledgeObjectFactory,
  type EntityMode,
} from '../../export-core/src/index';
import type { DocumentProjection, DocumentProjectionBlock, KnowledgeKind, KnowledgeObject } from '../../knowledge-schema/src/index';
import { renderVaultMarkdown, type ObsidianVaultEntityInput } from './index';

const ZERO_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as const;

function testKoId(index: number): string {
  return `ko_${String(index).padStart(26, '0')}`;
}

function stableKoId(seed: string): string {
  let acc = 0;
  for (const char of seed) acc = (acc * 131 + (char.codePointAt(0) ?? 0)) % 1_000_000_000_000;
  return testKoId(acc);
}

function ko(documentId: string, title: string, kind: KnowledgeKind, body: string, createdAt: string, index: number): KnowledgeObject {
  return {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: testKoId(index),
    kind,
    title: body.trim() || `KO ${index}`,
    body_md: body,
    source: {
      document_id: documentId,
      document_title: title,
      object_refs: [`ref_${index}`],
      inkloop_uri: `inkloop://ko/${testKoId(index)}`,
    },
    provenance: {
      created_from: 'mark',
      mark_ids: [`mark_${index}`],
    },
    tags: taxonomyTags({ documentId, documentTitle: title, isoDate: createdAt }),
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

const block = (blockId: string, kind: DocumentProjectionBlock['kind'], textMd: string): DocumentProjectionBlock => ({
  block_id: blockId,
  kind,
  text_md: textMd,
  region: 'generated',
  knowledge_object_ids: [],
});

const projection = (blocks: readonly DocumentProjectionBlock[]): DocumentProjection[] =>
  blocks.length ? [{ blocks: [...blocks] } as DocumentProjection] : [];

const entity = (
  mode: EntityMode,
  documentId: string,
  title: string,
  kos: readonly KnowledgeObject[],
  blocks: readonly DocumentProjectionBlock[] = [],
): ObsidianVaultEntityInput => ({
  mode,
  documentId,
  documentTitle: title,
  dates: [...new Set(kos.map((item) => item.created_at.slice(0, 10)))].sort(),
  knowledgeObjects: kos,
  documentProjections: projection(blocks),
});

function build() {
  const entities = [
    entity('reading', 'doc_csapp', '深入理解计算机系统', [
      ko('doc_csapp', '深入理解计算机系统', 'annotation', '缓存一致性 MESI 这段要重读', '2026-06-28T09:00:00Z', 1),
      ko('doc_csapp', '深入理解计算机系统', 'ai_note', 'AI：和 DDIA 复制章节同源', '2026-06-29T10:00:00Z', 2),
    ]),
    entity(
      'meeting',
      'mtgdoc_v4',
      '架构评审 v4',
      [
        ko('mtgdoc_v4', '架构评审 v4', 'annotation', '两层真相边界＝命门　（约 0:16 处手写）', '2026-06-29T03:00:00Z', 3),
        ko('mtgdoc_v4', '架构评审 v4', 'summary', '会议要点：两层架构', '2026-06-29T03:00:00Z', 4),
      ],
      [
        block('blk_1', 'heading', '讨论 v4 架构'),
        block('blk_2', 'paragraph', '张宇：真相分两层。'),
        block('blk_3', 'paragraph', '# 决策 参考 [[幽灵节点]] 见下'),
      ],
    ),
    entity('diary', 'diary_0629', '6.29 日记', [
      ko('diary_0629', '6.29 日记', 'annotation', '把 B 全量感知做完了', '2026-06-29T22:00:00Z', 5),
    ]),
  ];

  return renderVaultMarkdown({ entities });
}

const baseOf = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '');

describe('renderVaultMarkdown', () => {
  it('零 sidecar：无 docs/indexes/_assets/.inkloop/manifest/state', () => {
    const files = build();

    for (const file of files) {
      expect(file.path).not.toMatch(/\/(docs|indexes|_assets)\//);
      expect(file.path).not.toContain('.inkloop');
      expect(file.path.endsWith('.md')).toBe(true);
    }
  });

  it('文件名干净：无 ko_id 尾巴、无 "p1" 噪声', () => {
    const files = build();

    for (const file of files) {
      expect(file.path).not.toMatch(/ko_[0-9A-HJKMNP-TV-Z]{6}/);
      expect(baseOf(file.path)).not.toMatch(/ - [0-9A-Z]{6}$/);
    }
  });

  it('所有 [[wikilink]] 都解析到真实文件（零 dangling·图谱连通）', () => {
    const files = build();
    const bases = new Set(files.map((file) => baseOf(file.path)));
    const links = files.flatMap((file) => [...file.markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]));
    const dangling = [...new Set(links)].filter((link) => !bases.has(link));

    expect(links.length).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
  });

  it('叶子带 callout + 来源回链 + 标签；枢纽出链到叶子（双向连通）', () => {
    const files = build();
    const leaf = files.find((file) => file.path.includes('缓存一致性'));

    expect(leaf).toBeTruthy();
    expect(leaf!.markdown).toContain('> [!note] InkLoop');
    expect(leaf!.markdown).toContain('**来源**：[[深入理解计算机系统]]');
    expect(leaf!.markdown).toMatch(/inkloop\/book\//);

    const hub = files.find((file) => file.path.endsWith('Reading/深入理解计算机系统/深入理解计算机系统.md'));
    expect(hub!.markdown).toContain('## 笔记');
    expect(hub!.markdown).toContain('[[缓存一致性 MESI 这段要重读]]');
  });

  it('会议枢纽渲染转写；每日 MOC 带日记句（跨模式）', () => {
    const files = build();
    const meeting = files.find((file) => file.path.includes('Meetings/') && file.path.endsWith('架构评审 v4.md'));

    expect(meeting!.markdown).toContain('## 讨论 v4 架构');
    expect(meeting!.markdown).toContain('张宇：真相分两层。');
    expect(meeting!.markdown).toContain('\\[\\[幽灵节点\\]\\]');
    expect(meeting!.markdown).not.toContain('[[幽灵节点]]');
    expect(meeting!.markdown).toContain('\\# 决策');

    const daily = files.find((file) => baseOf(file.path) === '2026-06-29');
    expect(daily!.markdown).toContain('inkloop/date/2026-06-29');
    expect(daily!.markdown).toMatch(/2026-06-29 .*开了 .*，写了 .*。/);

    expect(files.some((file) => baseOf(file.path) === '两层真相边界=命门')).toBe(true);
    expect(files.every((file) => !baseOf(file.path).includes('处手写'))).toBe(true);

    const annotation = files.find((file) => baseOf(file.path) === '两层真相边界=命门');
    expect(annotation!.markdown).toContain('处手写');
  });

  it('确定性：同输入 → 同文件集', () => {
    const a = build();
    const b = build();

    expect(a.map((file) => file.path).sort()).toEqual(b.map((file) => file.path).sort());
  });
});

describe('renderVaultMarkdown + 概念层', () => {
  it('概念枢纽落 Concepts/·叶子加相关概念链接+topic 标签·零 dangling', async () => {
    const entities = [
      entity('reading', 'doc_csapp', '深入理解计算机系统', [
        ko('doc_csapp', '深入理解计算机系统', 'annotation', '缓存一致性 MESI 这段要重读', '2026-06-28T09:00:00Z', 11),
      ]),
      entity('diary', 'diary_0629', '6.29 日记', [
        ko('diary_0629', '6.29 日记', 'annotation', '把一致性问题收口了', '2026-06-29T22:00:00Z', 12),
      ]),
    ];

    const kos = entities.flatMap((item) => item.knowledgeObjects);
    const conceptLayer = await buildConceptLayer(kos, async (item) => (item.body_md.includes('一致性') ? ['一致性'] : []), makeConceptFactory());
    const files = renderVaultMarkdown({ entities, conceptLayer });

    const concept = files.find((file) => file.path === 'InkLoop/Concepts/一致性.md');
    expect(concept).toBeTruthy();
    expect(concept!.markdown).toContain('inkloop/concept');
    expect(concept!.markdown).toContain('## 相关笔记');
    expect(concept!.markdown).toContain('[[缓存一致性 MESI 这段要重读]]');

    const leaf = files.find((file) => baseOf(file.path) === '缓存一致性 MESI 这段要重读');
    expect(leaf!.markdown).toContain('**相关概念**：[[一致性]]');
    expect(leaf!.markdown).toContain('inkloop/topic/一致性');

    const bases = new Set(files.map((file) => baseOf(file.path)));
    const links = files.flatMap((file) => [...file.markdown.matchAll(/(?<!\\)\[\[([^\]]+)\]\]/g)].map((match) => match[1]));
    expect([...new Set(links)].filter((link) => !bases.has(link))).toEqual([]);
  });
});
