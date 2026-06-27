import { describe, expect, it } from 'vitest';
import { KnowledgeBuilder } from './builder';
import { MemoryKnowledgeIdentityStore } from './identity-index';
import type { InkLoopAiTurn, InkLoopDoc, InkLoopMark, KnowledgeBuilderStorePort, KnowledgeQuery } from './types';
import type { KnowledgeObject } from '../knowledge/knowledge-object';

class FixtureStore extends MemoryKnowledgeIdentityStore implements KnowledgeBuilderStorePort {
  objects: KnowledgeObject[] = [];

  constructor(
    private readonly docs: InkLoopDoc[],
    private readonly marks: InkLoopMark[],
    private readonly turns: InkLoopAiTurn[],
  ) {
    super();
  }

  async getDoc(documentId: string): Promise<InkLoopDoc | null> {
    return this.docs.find((doc) => doc.document_id === documentId) ?? null;
  }

  async listDocs(): Promise<InkLoopDoc[]> {
    return this.docs;
  }

  async getFoldedMarks(documentId: string): Promise<InkLoopMark[]> {
    return this.marks.filter((mark) => mark.document_id === documentId);
  }

  async getFoldedAiTurns(documentId: string): Promise<InkLoopAiTurn[]> {
    return this.turns.filter((turn) => turn.document_id === documentId);
  }

  async upsertKnowledgeObject(ko: KnowledgeObject): Promise<void> {
    this.objects = this.objects.filter((object) => object.ko_id !== ko.ko_id).concat(ko);
  }

  async listKnowledgeObjects(_query: KnowledgeQuery): Promise<KnowledgeObject[]> {
    return this.objects;
  }
}

describe('KnowledgeBuilder', () => {
  const doc: InkLoopDoc = { document_id: 'doc_builder', filename: 'Builder 测试文档' };
  const mark: InkLoopMark = {
    mark_id: 'mark_excerpt',
    document_id: 'doc_builder',
    page_id: 'pg_builder_0',
    page_index: 0,
    marked_text: '被圈出的原文',
    bbox: [0.1, 0.2, 0.3, 0.04],
    hmp: { target_object_refs: ['run_1'] },
    created_at: '2026-06-26T06:00:00.000Z',
  };
  const taskMark: InkLoopMark = {
    mark_id: 'mark_task',
    document_id: 'doc_builder',
    page_index: 2,
    marked_text: 'TODO: 整理这段的关键实验',
    hmp: { target_object_refs: [] },
  };
  const qaTurn: InkLoopAiTurn = {
    entry_id: 'turn_qa',
    document_id: 'doc_builder',
    page_id: 'pg_builder_0',
    page_index: 0,
    ai_reply: '这是因为它不能发送可控消息。',
    overlay_state: 'shown',
    user_question: '为什么不违反相对论？',
    anchor: { mark_ids: ['mark_excerpt'], object_refs: ['run_1'] },
  };
  const foldedTurn: InkLoopAiTurn = {
    entry_id: 'turn_folded',
    document_id: 'doc_builder',
    ai_reply: '不会导出',
    overlay_state: 'folded',
  };
  const dismissedTurn: InkLoopAiTurn = {
    entry_id: 'turn_dismissed',
    document_id: 'doc_builder',
    ai_reply: '默认不会导出',
    overlay_state: 'dismissed',
  };

  it('builds exportable KO from marks and ai turns with stable ids', async () => {
    const store = new FixtureStore([doc], [mark, taskMark], [qaTurn, foldedTurn, dismissedTurn]);
    const builder = new KnowledgeBuilder(store);

    const first = await builder.build({ document_id: doc.document_id, now: '2026-06-26T06:32:07.829Z' });
    expect(first.objects.map((object) => object.kind)).toEqual(['excerpt', 'task', 'qa']);
    expect(first.skipped.map((item) => item.reason)).toEqual(['folded', 'dismissed']);

    const excerpt = first.objects.find((object) => object.kind === 'excerpt')!;
    expect(excerpt.source.object_refs).toEqual(['run_1']);
    expect(excerpt.source.inkloop_uri).toBe('inkloop://doc/doc_builder/page/0?anchor=run_1');

    const qa = first.objects.find((object) => object.kind === 'qa')!;
    expect(qa.body_md).toContain('**Question:** 为什么不违反相对论？');
    expect(qa.status).toBe('export_ready');

    const second = await builder.build({ document_id: doc.document_id, now: '2026-06-26T06:33:00.000Z' });
    expect(second.objects.map((object) => object.ko_id)).toEqual(first.objects.map((object) => object.ko_id));
  });

  it('can include dismissed turns when requested', async () => {
    const store = new FixtureStore([doc], [], [dismissedTurn]);
    const builder = new KnowledgeBuilder(store);
    const result = await builder.build({ document_id: doc.document_id, include_dismissed: true });
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].status).toBe('dismissed');
  });

  it('uses the document display title consistently when title and filename differ', async () => {
    const titledDoc: InkLoopDoc = { document_id: 'doc_titled_builder', title: 'Canonical Paper Title', filename: 'upload.pdf' };
    const titledMark: InkLoopMark = {
      ...mark,
      mark_id: 'mark_titled_excerpt',
      document_id: titledDoc.document_id,
    };
    const store = new FixtureStore([titledDoc], [titledMark], []);
    const builder = new KnowledgeBuilder(store);

    const result = await builder.build({ document_id: titledDoc.document_id, now: '2026-06-26T06:32:07.829Z' });

    expect(result.objects[0].source.document_title).toBe('Canonical Paper Title');
    expect(result.objects[0].title).toBe('Canonical Paper Title p1 摘录');
  });
});
