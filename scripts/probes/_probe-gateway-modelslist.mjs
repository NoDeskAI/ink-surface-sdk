/**
 * 探 NoDesk 网关有没有"模型列表"端点（GET /v1/models 这类）。
 * 若有 → 一把列出所有可用模型；若无 → 退回逐渠道探（_probe-channels.mjs）。
 * 用法：node --env-file=.env scripts/probes/_probe-gateway-modelslist.mjs
 */
const url = process.env.LLM_GATEWAY_URL;
const key = process.env.LLM_GATEWAY_KEY;
if (!url || !key) { console.log('缺 env，用 node --env-file=.env 跑'); process.exit(1); }

const origin = new URL(url).origin;
const dir = url.replace(/\/[^/]*$/, '');         // 去掉最后一段 passthrough → .../default
const candidates = [
  `${origin}/v1/models`,
  `${dir}/v1/models`,
  `${url}/v1/models`,
  `${origin}/models`,
  `${origin}/api/v1/models`,
  `${dir}/models`,
];

for (const u of candidates) {
  try {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } });
    const t = await r.text();
    let pretty = t.slice(0, 600).replace(/\s+/g, ' ');
    try { const j = JSON.parse(t); if (Array.isArray(j?.data)) pretty = `[${j.data.length} models] ` + j.data.slice(0, 40).map((m) => m.id || m).join(', '); } catch { /* not json */ }
    console.log(`GET ${u}\n  → ${r.status} ${r.headers.get('content-type') || ''}\n  ${pretty}\n`);
  } catch (e) { console.log(`GET ${u}\n  → ERR ${e.message}\n`); }
}
