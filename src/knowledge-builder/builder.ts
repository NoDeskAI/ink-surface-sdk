import { computeKnowledgeHash } from '../knowledge/hash';
import type { KnowledgeObject, KnowledgeObjectWithoutHash } from '../knowledge/knowledge-object';
import { defaultCallout, defaultTags } from './defaults';
import { getOrCreateKoId } from './identity-index';
import { inferKnowledgeKind, isTaskLike } from './kind-inference';
import { buildSource, findPrimaryMark } from './source-map';
import { mapOverlayStateToKnowledgeStatus } from './status-map';
import type { BuildKnowledgeObjectsInput, BuildKnowledgeObjectsResult, InkLoopAiTurn, InkLoopDoc, InkLoopMark, KnowledgeBuilderStorePort } from './types';
import { documentDisplayTitle } from './document-title';

function titleFor(input: { doc: InkLoopDoc; kind: KnowledgeObject['kind']; mark?: InkLoopMark; aiTurn?: InkLoopAiTurn }): string {
  const documentTitle = documentDisplayTitle(input.doc);
  if (input.aiTurn?.user_question) return input.aiTurn.user_question.slice(0, 200);
  if (input.aiTurn?.inference_view?.question) return input.aiTurn.inference_view.question.slice(0, 200);
  if (input.kind === 'excerpt') return `${documentTitle} p${(input.mark?.page_index ?? 0) + 1} 摘录`;
  if (input.kind === 'task') return (input.mark?.marked_text ?? input.aiTurn?.ai_reply ?? 'InkLoop task').replace(/^(TODO:|todo:|待办:|action:|Action:)\s*/, '').slice(0, 200);
  return `${input.kind.replace(/_/g, ' ')} · ${documentTitle}`.slice(0, 200);
}

function aiQuestion(aiTurn: InkLoopAiTurn): string | undefined {
  return aiTurn.user_question ?? aiTurn.inference_view?.question;
}

export class KnowledgeBuilder {
  constructor(private readonly store: KnowledgeBuilderStorePort) {}

  async build(input: BuildKnowledgeObjectsInput = {}): Promise<BuildKnowledgeObjectsResult> {
    const now = input.now ?? new Date().toISOString();
    const docs = input.document_id ? [await this.store.getDoc(input.document_id)] : await this.store.listDocs();
    const result: BuildKnowledgeObjectsResult = { objects: [], skipped: [], warnings: [] };

    for (const doc of docs) {
      if (!doc) {
        result.skipped.push({ reason: 'missing_source', source_id: input.document_id ?? 'unknown' });
        continue;
      }
      const marks = (await this.store.getFoldedMarks(doc.document_id)).filter((mark) => !mark.is_tombstone);
      const turns = await this.store.getFoldedAiTurns(doc.document_id);

      for (const mark of marks) {
        if (input.mark_ids && !input.mark_ids.includes(mark.mark_id)) continue;
        const ko = await this.buildMarkObject({ doc, mark, now });
        if (!ko.body_md.trim()) {
          result.skipped.push({ reason: 'empty_body', source_id: mark.mark_id });
          continue;
        }
        result.objects.push(ko);
        await this.store.upsertKnowledgeObject?.(ko);
      }

      for (const aiTurn of turns) {
        if (input.ai_turn_ids && !input.ai_turn_ids.includes(aiTurn.entry_id)) continue;
        const status = mapOverlayStateToKnowledgeStatus(aiTurn.overlay_state);
        if (!status) {
          result.skipped.push({ reason: 'folded', source_id: aiTurn.entry_id });
          continue;
        }
        if (status === 'dismissed' && !input.include_dismissed) {
          result.skipped.push({ reason: 'dismissed', source_id: aiTurn.entry_id });
          continue;
        }
        if (status === 'archived' && !input.include_archived) {
          result.skipped.push({ reason: 'dismissed', source_id: aiTurn.entry_id, detail: 'archived' });
          continue;
        }
        const ko = await this.buildAiTurnObject({ doc, aiTurn, marks, status, now });
        if (!ko.body_md.trim()) {
          result.skipped.push({ reason: 'empty_body', source_id: aiTurn.entry_id });
          continue;
        }
        result.objects.push(ko);
        await this.store.upsertKnowledgeObject?.(ko);
      }
    }

    return result;
  }

  private async buildMarkObject(input: { doc: InkLoopDoc; mark: InkLoopMark; now: string }): Promise<KnowledgeObject> {
    const body = input.mark.hmp?.text_hint || input.mark.marked_text || '';
    const kind = inferKnowledgeKind({
      mark: input.mark,
      isUserHandwritingNote: input.mark.feature_type === 'handwriting' || input.mark.kind === 'handwriting',
    });
    const finalKind = isTaskLike(body) ? 'task' : kind;
    const koWithoutHash: KnowledgeObjectWithoutHash = {
      schema_version: 'inkloop.knowledge_object.v1',
      ko_id: await getOrCreateKoId(this.store, `mark:${input.mark.mark_id}`),
      kind: finalKind,
      title: titleFor({ doc: input.doc, kind: finalKind, mark: input.mark }),
      body_md: body,
      source: buildSource({ doc: input.doc, mark: input.mark }),
      provenance: { created_from: 'mark', mark_ids: [input.mark.mark_id] },
      tags: defaultTags(finalKind),
      status: 'export_ready',
      privacy: 'export_allowed',
      render_hints: { markdown_callout: defaultCallout(finalKind) },
      created_at: input.mark.created_at ?? input.now,
      updated_at: input.mark.updated_at ?? input.now,
    };
    return { ...koWithoutHash, content_hash: await computeKnowledgeHash(koWithoutHash) };
  }

  private async buildAiTurnObject(input: {
    doc: InkLoopDoc;
    aiTurn: InkLoopAiTurn;
    marks: InkLoopMark[];
    status: NonNullable<ReturnType<typeof mapOverlayStateToKnowledgeStatus>>;
    now: string;
  }): Promise<KnowledgeObject> {
    const mark = findPrimaryMark(input.aiTurn, input.marks);
    const question = aiQuestion(input.aiTurn);
    const kind = inferKnowledgeKind({ aiTurn: input.aiTurn, hasQuestion: !!question });
    const body = question && kind === 'qa' ? `**Question:** ${question}\n\n${input.aiTurn.ai_reply}` : input.aiTurn.ai_reply;
    const koWithoutHash: KnowledgeObjectWithoutHash = {
      schema_version: 'inkloop.knowledge_object.v1',
      ko_id: await getOrCreateKoId(this.store, `ai_turn:${input.aiTurn.entry_id}`),
      kind,
      title: titleFor({ doc: input.doc, kind, mark, aiTurn: input.aiTurn }),
      body_md: body,
      source: buildSource({ doc: input.doc, mark, aiTurn: input.aiTurn }),
      provenance: { created_from: 'ai_turn', mark_ids: input.aiTurn.anchor?.mark_ids, ai_turn_ids: [input.aiTurn.entry_id] },
      tags: defaultTags(kind),
      status: input.status,
      privacy: 'export_allowed',
      render_hints: { markdown_callout: defaultCallout(kind) },
      created_at: input.aiTurn.created_at ?? input.now,
      updated_at: input.aiTurn.updated_at ?? input.now,
    };
    return { ...koWithoutHash, content_hash: await computeKnowledgeHash(koWithoutHash) };
  }
}
