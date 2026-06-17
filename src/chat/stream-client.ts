import { appendMsg, bookMessages } from './buffer';

/**
 * 一轮网页对话式聊天（流式）：把新 user 消息入每本书 buffer，整串 messages POST /api/chat，
 * 逐段读 text/plain 增量、回调 onDelta(累计全文)，收尾把 assistant 全文回写 buffer。
 * 服务端无状态——连贯全靠这串 messages（替代退役的 Agent SDK 会话 + memorySnapshot）。
 */
export async function chatTurn(
  bookId: string,
  userContent: string,
  opts: { system: string; model: string; maxTokens?: number; onDelta?: (full: string) => void; signal?: AbortSignal },
): Promise<string> {
  appendMsg(bookId, { role: 'user', content: userContent });
  const messages = bookMessages(bookId).map((m) => ({ role: m.role, content: m.content }));
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: opts.signal,
    body: JSON.stringify({ messages, system: opts.system, model: opts.model, maxTokens: opts.maxTokens ?? 500 }),
  });
  if (!resp.ok || !resp.body) throw new Error(`/api/chat ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    full += dec.decode(value, { stream: true });
    opts.onDelta?.(full);
  }
  full = full.trim();
  appendMsg(bookId, { role: 'assistant', content: full });
  return full;
}
