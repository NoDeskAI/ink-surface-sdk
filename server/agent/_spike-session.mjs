/**
 * P3.1 验证:streamInput 长驻会话跨轮记住上下文(per-book 会话的核心)。
 * 轮1 告诉它一个事实 → 轮2 不重复事实、只问它 → 看它是否记得。
 * 用法: node --env-file=.env server/agent/_spike-session.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartProxy, stopProxy } from './gateway-proxy.mjs';
import { AsyncQueue, userTurn } from './async-queue.mjs';

const gatewayUrl = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
const realModel = process.env.LLM_MODEL || 'kimi-k2.6';
if (!gatewayUrl || !key) { console.error('缺 env'); process.exit(1); }

const proxy = await getOrStartProxy({ gatewayUrl, realModel });
const sessionId = 'inkloop-session-spike-1';
const baseUrlForBinary = `${proxy.baseUrl}/__nd/${encodeURIComponent(sessionId)}`;

const inputQueue = new AsyncQueue();
const answers = [];
let turn = 0, cur = '';

const stream = query({
  prompt: inputQueue,
  options: {
    model: 'claude-opus-4-7[1m]',
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
    settingSources: [],
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrlForBinary, ANTHROPIC_API_KEY: key },
  },
});

// 轮1:给事实
inputQueue.push(userTurn('我在读一本科幻小说，主角叫"阿杰"。请只回"记住了"。'));
turn = 1; console.log('→ 轮1 推入（告知事实:主角叫阿杰）');

try {
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (t) cur += t;
    }
    if (msg.type === 'result') {
      answers.push(cur.trim()); console.log(`  [轮${turn} 回复]`, cur.trim()); cur = '';
      if (turn === 1) {
        turn = 2; console.log('→ 轮2 推入（只问，不重述事实）');
        inputQueue.push(userTurn('我刚说的主角叫什么名字？只回名字。'));
      } else {
        inputQueue.close(); break;
      }
    }
  }
} catch (e) {
  console.error('失败:', e?.stack || e);
} finally {
  await stopProxy();
}

const remembered = (answers[1] || '').includes('阿杰');
console.log(remembered ? '✅ 跨轮上下文保持:轮2 记得"阿杰"（长驻会话成立）' : `❌ 轮2 未记得（answers=${JSON.stringify(answers)}）`);
process.exit(remembered ? 0 : 1);
