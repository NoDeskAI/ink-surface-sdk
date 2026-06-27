/**
 * 逐渠道探模型：① 原始 /v1/models 结构 ② /v1/models?channel=<名> 是否按渠道列模型
 * ③ 路由机制（只给 channel 名、不给 channel_url 行不行）。
 * 用法：node --env-file=.env scripts/probes/_probe-channels.mjs
 */
const url = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
const origin = new URL(url).origin;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

const CHANNELS = ['dmx', 'onerouter', 'wavespeed', '302api', 'ucloud', 'aliyun', 'volcengine', 'AWS', 'zhipu', 'stepfun', 'minimax', 'kimi'];

console.log('=== ① 原始 GET /v1/models 结构 ===');
{
  const r = await fetch(`${origin}/v1/models`, { headers: H });
  const t = await r.text();
  console.log(`  ${r.status} · ${t.slice(0, 500)}`);
}

console.log('\n=== ② GET /v1/models?channel=<名>（看是否按渠道列） ===');
for (const c of CHANNELS) {
  try {
    const r = await fetch(`${origin}/v1/models?channel=${encodeURIComponent(c)}`, { headers: { ...H, channel: c } });
    const t = await r.text();
    let info = t.slice(0, 200).replace(/\s+/g, ' ');
    try { const j = JSON.parse(t); if (Array.isArray(j?.data)) info = `[${j.data.length}] ${j.data.slice(0, 30).map((m) => m.id || m).join(', ')}`; } catch { /* */ }
    console.log(`  ${c.padEnd(12)} ${r.status} · ${info}`);
  } catch (e) { console.log(`  ${c.padEnd(12)} ERR ${e.message}`); }
}

console.log('\n=== ③ 路由机制：POST /v1/messages channel=kimi，不给 channel_url ===');
async function postMsg(body) {
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  const txt = (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 40);
  return `${r.status} ${Date.now() - t0}ms ${r.status === 200 ? '"' + txt + '"' : JSON.stringify(d?.error?.message || d).slice(0, 120)}`;
}
const baseMsg = { model: 'kimi-k2.6', max_tokens: 30, messages: [{ role: 'user', content: '回复：好' }] };
console.log('  无 channel_url   →', await postMsg({ ...baseMsg, channel: 'kimi' }));
console.log('  有 channel_url   →', await postMsg({ ...baseMsg, channel: 'kimi', channel_url: 'https://api.moonshot.cn/anthropic/v1/messages' }));
console.log('  全不给(默认路由) →', await postMsg({ ...baseMsg }));
