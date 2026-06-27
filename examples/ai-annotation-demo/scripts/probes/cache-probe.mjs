// Prompt 缓存探针：对网关发两次"相同大前缀 + cache_control"的请求，看第二次是否命中缓存。
// 不打印 key。usage 里出现 cache_read_input_tokens>0 即证明命中。
const url = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
const model = process.env.LLM_MODEL || 'kimi-k2.6';
const isKimi = model.startsWith('kimi');
const channel = isKimi ? 'kimi' : 'DMX';
const channel_url = isKimi ? 'https://api.moonshot.cn/anthropic/v1/messages' : 'https://www.dmxapi.cn/v1/messages';

if (!url || !key) { console.error('缺 LLM_GATEWAY_URL / LLM_GATEWAY_KEY'); process.exit(1); }

// 稳定大前缀（>1024 token，缓存最小门槛）
const filler = '这是一段用于测试 prompt 缓存命中的稳定系统前缀。它必须足够长，超过缓存最小 token 门槛，且两次调用完全一致。'.repeat(120);

async function call(label) {
  const body = {
    model, max_tokens: 16,
    system: [{ type: 'text', text: filler, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '只回一个字：好' }],
    channel, channel_url,
  };
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;
  console.log(`[${label}] HTTP ${r.status} · ${ms}ms`);
  console.log('  usage:', JSON.stringify(d.usage ?? d.error ?? d).slice(0, 400));
}

console.log('model =', model, '| prefix chars =', filler.length);
await call('call#1 (建缓存)');
await new Promise((r) => setTimeout(r, 2000));
await call('call#2 (应命中)');
