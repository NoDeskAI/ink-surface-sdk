/**
 * 网关探针：① 候选 kimi 模型可用性 + 延迟 ② thinking 开/关对延迟的影响。
 * 直打 NoDesk 网关（绕过 app/SDK），隔离"模型/思维链"本身的耗时。
 * 用法：node --env-file=.env scripts/probes/_probe-gateway-models.mjs
 */
const url = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
if (!url || !key) { console.log('缺 LLM_GATEWAY_URL / LLM_GATEWAY_KEY —— 用 node --env-file=.env 跑'); process.exit(1); }

const CHANNEL = { channel: 'kimi', channel_url: 'https://api.moonshot.cn/anthropic/v1/messages' };

async function call({ model, thinking, system = '你是简洁的助手。', user = '回复两个字：你好', maxTokens = 60 }) {
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], ...CHANNEL };
  if (thinking) body.thinking = { type: 'enabled', budget_tokens: 1024 };
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ms: Date.now() - t0, status: r.status, data };
  } catch (e) { return { ms: Date.now() - t0, err: String(e?.message || e) }; }
}

function summarize(r) {
  if (r.err) return `ERR ${r.err}`;
  if (r.status !== 200) return `HTTP ${r.status} · ${String(r.data?.error?.message || JSON.stringify(r.data)).slice(0, 140)}`;
  const blocks = r.data?.content || [];
  const think = blocks.find((b) => b.type === 'thinking');
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 50);
  const u = r.data?.usage || {};
  const cache = u.cache_read_input_tokens ? ` cacheR=${u.cache_read_input_tokens}` : '';
  const tk = think ? ` · THINK(${(think.thinking || '').length}字)` : ' · no-think';
  return `OK ${String(r.ms).padStart(6)}ms · in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'}${cache}${tk} · "${text}"`;
}

console.log('=== A) 候选模型可用性 + 延迟（同一小请求，无 thinking）===');
const MODELS = ['kimi-k2.6', 'kimi-k2.7', 'kimi-2.7-highspeed', 'kimi-k2-turbo', 'kimi-k2-turbo-preview', 'kimi-k2.6-turbo', 'kimi-k2.5', 'kimi-latest', 'kimi-thinking-preview'];
for (const m of MODELS) {
  const r = await call({ model: m, thinking: false });
  console.log(`  ${m.padEnd(22)} → ${summarize(r)}`);
}

console.log('\n=== B) thinking 开/关 对延迟的影响（baseline，带一点真实任务量）===');
const base = process.env.LLM_MODEL || 'kimi-k2.6';
const task = '这一页讲主角穿越到未来、看到柴油车冒黑烟。用户圈了"柴油车喷黑烟"。用一句话给页边旁注，别编造原文没有的细节。';
for (const th of [false, true]) {
  const r = await call({ model: base, thinking: th, user: task, maxTokens: 400 });
  console.log(`  ${base} thinking=${th ? 'on(1024)' : 'off    '} → ${summarize(r)}`);
}
