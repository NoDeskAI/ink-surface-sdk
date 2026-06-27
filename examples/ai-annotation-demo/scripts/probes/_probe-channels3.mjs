/** 逐渠道枚举模型（最终轮）。node --env-file=.env scripts/probes/_probe-channels3.mjs */
const url = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

async function probe(channel, channel_url, model) {
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: '回复两字：你好' }], channel, channel_url };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (r.status === 200) {
      const txt = (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 24);
      return `✅ ${ms}ms "${txt}"`;
    }
    return `❌ ${r.status} ${String(d?.error?.message || JSON.stringify(d)).slice(0, 95)}`;
  } catch (e) { return `❌ ERR ${String(e.message).slice(0, 60)}`; }
}
const run = async (label, channel, curl, models) => {
  console.log(`\n=== ${label} (channel=${channel}) ===`);
  for (const m of models) console.log(`  ${m.padEnd(26)} →`, await probe(channel, curl, m));
};

await run('DMX 转售', 'DMX', 'https://www.dmxapi.cn/v1/messages',
  ['claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-4o-mini', 'gpt-5-mini', 'deepseek-chat', 'gemini-2.5-flash']);
await run('minimax', 'minimax', 'https://api.minimaxi.com/anthropic/v1/messages',
  ['MiniMax-Text-01', 'MiniMax-M1', 'MiniMax-M2', 'abab6.5s-chat', 'abab6.5-chat', 'abab7-chat-preview', 'MiniMax-VL-01']);
await run('stepfun', 'stepfun', 'https://api.stepfun.com/v1/messages',
  ['step-1-8k', 'step-1-32k', 'step-2-16k', 'step-2-mini', 'step-3', 'step-2']);
await run('kimi（补全）', 'kimi', 'https://api.moonshot.cn/anthropic/v1/messages',
  ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2', 'moonshot-v1-8k', 'kimi-k1.5']);

console.log('\n=== 渠道名变体探测（找正确的 channel 字符串）===');
for (const c of ['dmx', 'DMX', '302api', '302', '302ai', '302.ai', 'onerouter', 'OneRouter', 'ucloud', 'UCloud', 'aws', 'AWS', 'wavespeed'])
  console.log(`  channel=${c.padEnd(10)} →`, await probe(c, 'https://www.dmxapi.cn/v1/messages', 'gpt-4o-mini'));
