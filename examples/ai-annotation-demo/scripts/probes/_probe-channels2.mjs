/**
 * 渠道机制 + 真渠道实打。
 *  A) 网关用不用我给的 channel_url？（kimi + 假 url；若仍 200 → 按渠道名路由、url 只是占位）
 *  B) 我有把握 url 的渠道逐个打代表模型。
 * 用法：node --env-file=.env scripts/probes/_probe-channels2.mjs
 */
const url = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

async function probe(channel, channel_url, model) {
  const body = { model, max_tokens: 20, messages: [{ role: 'user', content: '回复两字：你好' }], channel, channel_url };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (r.status === 200) {
      const txt = (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 30);
      return `✅ 200 ${ms}ms "${txt}"`;
    }
    return `❌ ${r.status} ${String(d?.error?.message || JSON.stringify(d)).slice(0, 110)}`;
  } catch (e) { return `❌ ERR ${e.message}`; }
}

console.log('=== A) channel_url 是否被真正使用 ===');
console.log('  kimi + 真 url   →', await probe('kimi', 'https://api.moonshot.cn/anthropic/v1/messages', 'kimi-k2.6'));
console.log('  kimi + 假 url   →', await probe('kimi', 'https://nd-routing-test.invalid/v1/messages', 'kimi-k2.6'));

console.log('\n=== B) 真渠道实打（channel / channel_url / model）===');
const TESTS = [
  ['dmx', 'https://www.dmxapi.cn/v1/messages', ['claude-sonnet-4-6', 'gpt-4o-mini', 'deepseek-chat', 'gemini-2.5-flash']],
  ['zhipu', 'https://open.bigmodel.cn/api/anthropic/v1/messages', ['glm-4.6', 'glm-4.5', 'glm-4.5-air']],
  ['302api', 'https://api.302.ai/v1/messages', ['claude-sonnet-4-6', 'gpt-4o-mini']],
  ['minimax', 'https://api.minimaxi.com/anthropic/v1/messages', ['MiniMax-Text-01', 'abab6.5s-chat']],
  ['volcengine', 'https://ark.cn-beijing.volces.com/api/v3/messages', ['doubao-pro-32k', 'doubao-seed-1-6-250615']],
  ['aliyun', 'https://dashscope.aliyuncs.com/api/v2/apps/claude/v1/messages', ['qwen-max', 'qwen-plus']],
  ['stepfun', 'https://api.stepfun.com/v1/messages', ['step-2', 'step-1v-8k']],
];
for (const [ch, curl, models] of TESTS) {
  for (const m of models) {
    console.log(`  ${ch.padEnd(11)} ${m.padEnd(24)} →`, await probe(ch, curl, m));
  }
}
