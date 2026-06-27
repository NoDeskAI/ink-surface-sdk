/** 复现 gemini + thinking 无响应。dump 完整响应（blocks/stop_reason/usage/error）。
 * node --env-file=.env scripts/probes/_probe-gemini-thinking.mjs */
import zlib from 'node:zlib';
const url = process.env.LLM_GATEWAY_URL, key = process.env.LLM_GATEWAY_KEY;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(Buffer.concat([T, d])) >>> 0); return Buffer.concat([l, T, d, c]); }
function tbwPng(s = 96) { const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ih = Buffer.alloc(13); ih.writeUInt32BE(s, 0); ih.writeUInt32BE(s, 4); ih[8] = 8; ih[9] = 2; const raw = Buffer.alloc((s * 3 + 1) * s); for (let y = 0; y < s; y++) { const o = y * (s * 3 + 1); raw[o] = 0; const v = y < s / 2 ? 0 : 255; for (let x = 0; x < s; x++) { const p = o + 1 + x * 3; raw[p] = raw[p + 1] = raw[p + 2] = v; } } return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64'); }
const IMG = tbwPng();

async function probe(model, { thinking, maxTokens }) {
  const body = { model, max_tokens: maxTokens, channel: 'DMX', channel_url: 'https://www.dmxapi.cn/v1/messages',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG } }, { type: 'text', text: '这张图上半还是下半更暗？只输出 JSON：{"ans":"上或下"}' }] }] };
  if (thinking) body.thinking = { type: 'enabled', budget_tokens: 1024 };
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (r.status !== 200) return `❌ ${r.status} ${String(d?.error?.message || JSON.stringify(d)).slice(0, 140)}`;
  const blocks = (d?.content || []).map((b) => `${b.type}(${(b.text || b.thinking || '').length}字)`).join('+') || '空content!';
  const txt = (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 40);
  return `✅ ${ms}ms stop=${d?.stop_reason} blocks=[${blocks}] out=${d?.usage?.output_tokens} text="${txt}"`;
}

for (const m of ['gemini-3.1-flash-lite', 'gemini-3.5-flash']) {
  console.log(`\n=== ${m} ===`);
  console.log('  thinking ON  · max2048 →', await probe(m, { thinking: true, maxTokens: 2048 }));
  console.log('  thinking ON  · max8192 →', await probe(m, { thinking: true, maxTokens: 8192 }));
  console.log('  thinking OFF · max2048 →', await probe(m, { thinking: false, maxTokens: 2048 }));
}
