/**
 * 每本书一个有状态对话 buffer（v3 优先②·网页对话形态）。
 *
 * 形态即 ChatGPT/Claude 网页对话：会话状态 = 客户端持有的一串 messages，无服务端活进程。
 * 开书即 openBook（≈0ms，纯建数组——这正是"启动不慢"的来源，不是 SDK 子进程）。
 * 真相源在本地库（P5 接向量/结构库），buffer 只是工作上下文的薄缓存：滑动窗封顶、可丢弃、可重建。
 */
export interface ChatMsg { role: 'user' | 'assistant'; content: string; }

const MAX_TURNS = 24; // 滑动窗：留最近 N 条，防上下文无限增长（更久的连贯交 durable 库）
const buffers = new Map<string, ChatMsg[]>();

/** 开书：非阻塞预热（建空 buffer）。重复调用幂等。 */
export function openBook(bookId: string): void {
  if (!buffers.has(bookId)) buffers.set(bookId, []);
}

export function bookMessages(bookId: string): ChatMsg[] {
  return buffers.get(bookId) ?? [];
}

export function appendMsg(bookId: string, m: ChatMsg): void {
  const arr = buffers.get(bookId) ?? [];
  arr.push(m);
  if (arr.length > MAX_TURNS) arr.splice(0, arr.length - MAX_TURNS);
  buffers.set(bookId, arr);
}

export function resetBook(bookId: string): void {
  buffers.delete(bookId);
}
