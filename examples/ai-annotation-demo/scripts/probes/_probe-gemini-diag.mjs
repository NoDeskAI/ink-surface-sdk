/**
 * 诊断 gemini 经 DMX 为何返回空 + 探 sonnet 各版本。
 * 拉满 max_tokens、dump 完整响应结构（content blocks 类型 / stop_reason / usage）。
 * node --env-file=.env scripts/probes/_probe-gemini-diag.mjs
 */
import zlib from 'node:zlib';
const url = process.env.LLM_GATEWAY_URL, key = process.env.LLM_GATEWAY_KEY;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(Buffer.concat([T, d])) >>> 0); return Buffer.concat([l, T, d, c]); }
function tbwPng(s = 96) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ih = Buffer.alloc(13);
  ih.writeUInt32BE(s, 0); ih.writeUInt32BE(s, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((s * 3 + 1) * s);
  for (let y = 0; y < s; y++) { const o = y * (s * 3 + 1); raw[o] = 0; const v = y < s / 2 ? 0 : 255; for (let x = 0; x < s; x++) { const p = o + 1 + x * 3; raw[p] = raw[p + 1] = raw[p + 2] = v; } }
  return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function raw(model, { maxTokens = 2000, image = false, thinking } = {}) {
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tbwPng() } }, { type: 'text', text: '这张图上半还是下半更暗？一句话。' }]
    : '用一句话说明天空为什么是蓝色。';
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }], channel: 'DMX', channel_url: 'https://www.dmxapi.cn/v1/messages' };
  if (thinking !== undefined) body.thinking = thinking;
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ms: Date.now() - t0, status: r.status, d };
}
function show(label, r) {
  if (r.status !== 200) { console.log(`  ${label}: ❌ ${r.status} ${String(r.d?.error?.message || JSON.stringify(r.d)).slice(0, 120)}`); return; }
  const blocks = (r.d?.content || []).map((b) => `${b.type}(${(b.text || b.thinking || '').length}字)`).join('+') || '空content';
  const txt = (r.d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 50);
  console.log(`  ${label}: ✅ ${r.ms}ms stop=${r.d?.stop_reason} blocks=[${blocks}] usage=${JSON.stringify(r.d?.usage || {})}`);
  console.log(`      text: "${txt}"`);
}

console.log('=== gemini 诊断（max_tokens=2000）===');
show('gemini-3.5-flash 文本', await raw('gemini-3.5-flash'));
show('gemini-3.5-flash 看图', await raw('gemini-3.5-flash', { image: true }));
show('gemini-3.1-flash-lite 文本', await raw('gemini-3.1-flash-lite'));
show('gemini-3.1-flash-lite 看图', await raw('gemini-3.1-flash-lite', { image: true }));
show('gemini-3.5-flash thinking=disabled', await raw('gemini-3.5-flash', { thinking: { type: 'disabled' } }));

console.log('\n=== sonnet 各版本 ===');
for (const m of ['claude-sonnet-4-6', 'claude-sonnet-4-7', 'claude-sonnet-4-8']) show(m, await raw(m, { maxTokens: 100 }));
