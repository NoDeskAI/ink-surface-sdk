import type { KnowledgeKind } from '../knowledge/knowledge-object';
import type { InkLoopAiTurn, InkLoopMark } from './types';

export function isTaskLike(text: string): boolean {
  return /^(TODO:|todo:|待办:|action:|Action:)/.test(text.trim());
}

export function inferKnowledgeKind(input: {
  mark?: InkLoopMark;
  aiTurn?: InkLoopAiTurn;
  hasQuestion?: boolean;
  isUserHandwritingNote?: boolean;
}): KnowledgeKind {
  const text = input.aiTurn?.ai_reply ?? input.mark?.marked_text ?? input.mark?.hmp?.text_hint ?? '';
  if (isTaskLike(text)) return 'task';

  if (input.aiTurn) {
    if (input.hasQuestion) return 'qa';
    return 'ai_note';
  }

  if (input.mark) {
    if (input.isUserHandwritingNote) return 'annotation';
    if (input.mark.marked_text?.trim()) return 'excerpt';
    return 'annotation';
  }

  return 'concept';
}
