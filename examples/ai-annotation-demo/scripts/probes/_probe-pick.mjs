/** 探指定模型在 DMX 上是否可用。node --env-file=.env scripts/probes/_probe-pick.mjs */
const url = process.env.LLM_GATEWAY_URL, key = process.env.LLM_GATEWAY_KEY;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
async function probe(model) {
  const body = { model, max_tokens: 16, messages: [{ role: 'user', content: '回复两字：你好' }], channel: 'DMX', channel_url: 'https://www.dmxapi.cn/v1/messages' };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (r.status === 200) {
      const txt = (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 24);
      return `✅ ${ms}ms "${txt}"`;
    }
    return `❌ ${r.status} ${String(d?.error?.message || JSON.stringify(d)).slice(0, 90)}`;
  } catch (e) { return `❌ ERR ${String(e.message).slice(0, 50)}`; }
}
const MODELS = [
  'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
  'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.0-flash', 'gemini-3-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash',
];
for (const m of MODELS) console.log(`  ${m.padEnd(24)} →`, await probe(m));
