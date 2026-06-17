/**
 * 验证 DMX 渠道是否真把图片转发给 Claude/Gemini（视觉到不到）。
 * 生成上黑下白的 PNG，问"上半还是下半更暗"——答"上"=看见了。
 * node --env-file=.env scripts/probes/_probe-vision.mjs
 */
import zlib from 'node:zlib';
const url = process.env.LLM_GATEWAY_URL, key = process.env.LLM_GATEWAY_KEY;
const H = { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };

function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(Buffer.concat([T, d])) >>> 0); return Buffer.concat([l, T, d, c]); }
function topBlackBottomWhitePng(s = 128) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ih = Buffer.alloc(13);
  ih.writeUInt32BE(s, 0); ih.writeUInt32BE(s, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((s * 3 + 1) * s);
  for (let y = 0; y < s; y++) { const o = y * (s * 3 + 1); raw[o] = 0; const v = y < s / 2 ? 0 : 255; for (let x = 0; x < s; x++) { const p = o + 1 + x * 3; raw[p] = raw[p + 1] = raw[p + 2] = v; } }
  return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const img = topBlackBottomWhitePng();

async function ask(model) {
  const body = {
    model, max_tokens: 30, channel: 'DMX', channel_url: 'https://www.dmxapi.cn/v1/messages',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } },
      { type: 'text', text: '这张图上半部分和下半部分，哪个更暗（更黑）？只回答"上"或"下"。' },
    ] }],
  };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const txt = (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/\s+/g, ' ').slice(0, 40);
    return r.status === 200 ? `${Date.now() - t0}ms "${txt}" ${/上/.test(txt) ? '✅看见(上)' : '⚠️答非预期'}` : `❌ ${r.status} ${String(d?.error?.message || JSON.stringify(d)).slice(0, 80)}`;
  } catch (e) { return `❌ ERR ${e.message}`; }
}

for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'gemini-3.5-flash']) console.log(`  ${m.padEnd(20)} →`, await ask(m));
