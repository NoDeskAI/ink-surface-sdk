/**
 * 极简 AsyncQueue:作为 Claude Agent SDK query({prompt}) 的 streamInput 源
 * （AsyncIterable<SDKUserMessage>）。push 一条 = 长驻会话里追加一轮用户输入；
 * close() 结束会话（for-await 自然退出）。改编自 Nodesign server/lib/async-queue.js。
 */
export class AsyncQueue {
  constructor() { this._items = []; this._resolvers = []; this._closed = false; }

  push(item) {
    if (this._closed) return;
    const r = this._resolvers.shift();
    if (r) r({ value: item, done: false });
    else this._items.push(item);
  }

  close() {
    this._closed = true;
    let r;
    while ((r = this._resolvers.shift())) r({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._items.length) return Promise.resolve({ value: this._items.shift(), done: false });
        if (this._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this._resolvers.push(resolve));
      },
    };
  }
}

/** 包成 SDK 期望的 user message 形态。 */
export function userTurn(content) {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}
