/**
 * P3.0 去风险 spike:验证 Claude Agent SDK → 本地代理 → NoDesk 网关 → Kimi 单轮跑通。
 * 用法: node --env-file=.env server/agent/_spike.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartProxy, stopProxy } from './gateway-proxy.mjs';

const gatewayUrl = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
const realModel = process.env.LLM_MODEL || 'kimi-k2.6';
if (!gatewayUrl || !key) { console.error('缺 LLM_GATEWAY_URL / LLM_GATEWAY_KEY'); process.exit(1); }

const proxy = await getOrStartProxy({ gatewayUrl, realModel });
const sessionId = 'inkloop-spike-1';
const baseUrlForBinary = `${proxy.baseUrl}/__nd/${encodeURIComponent(sessionId)}`;

console.log('→ 起 query()（spoof model=claude-opus-4-7[1m]，出口代理改回 kimi）');
const t0 = Date.now();
let answered = false;

try {
  const stream = query({
    prompt: '用一句话解释"心流(flow)"是什么。只回这一句。',
    options: {
      model: 'claude-opus-4-7[1m]',           // spoof：让 SDK 内部按 1M context 算
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      maxTurns: 1,
      settingSources: [],                       // 不加载本机 CLAUDE.md/settings，保持干净
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrlForBinary,
        ANTHROPIC_API_KEY: key,
      },
    },
  });

  for await (const msg of stream) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log('  [init] session=', msg.session_id, '| model=', msg.model, '| tools=', (msg.tools || []).length);
    }
    if (msg.type === 'assistant') {
      const text = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text) { console.log('  [assistant]', text); answered = true; }
    }
    if (msg.type === 'result') {
      console.log('  [result]', msg.subtype, '| turns=', msg.num_turns, '| cost=$', msg.total_cost_usd, '|', Date.now() - t0, 'ms');
      break;
    }
  }
} catch (e) {
  console.error('SPIKE 失败:', e?.stack || e);
} finally {
  await stopProxy();
}

console.log(answered ? '✅ SDK↔代理↔Kimi 单轮跑通' : '❌ 没拿到回复');
process.exit(answered ? 0 : 1);
