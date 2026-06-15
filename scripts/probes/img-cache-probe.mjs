// 图片缓存陷阱探针：把一张图放进 user message（cache_control 断点在图之后），
// 连发两次相同请求。若第二次 usage.cache_read 覆盖到图片那部分 token，说明图能进缓存；
// 若第二次仍按全量计费、cache_read 只覆盖文字，说明"图每轮重算"陷阱成立。
import { readFileSync } from 'node:fs';
const imgPath = process.argv[2];
if (!imgPath) { console.error('用法: node img-cache-probe.mjs <图片路径>'); process.exit(1); }
const buf = readFileSync(imgPath);
const b64 = buf.toString('base64');
const media = /\.jpe?g$/i.test(imgPath) ? 'image/jpeg' : 'image/png';

const url = process.env.LLM_GATEWAY_URL, key = process.env.LLM_GATEWAY_KEY, model = process.env.LLM_MODEL || 'kimi-k2.6';
const isKimi = model.startsWith('kimi');
const channel = isKimi ? 'kimi' : 'DMX';
const channel_url = isKimi ? 'https://api.moonshot.cn/anthropic/v1/messages' : 'https://www.dmxapi.cn/v1/messages';

async function call(label) {
  const body = {
    model, max_tokens: 16,
    system: [{ type: 'text', text: '你是图片识别助手。' }],
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
      { type: 'text', text: '这张图里大概是什么？一句话。', cache_control: { type: 'ephemeral' } },
    ] }],
    channel, channel_url,
  };
  const t0 = Date.now();
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  console.log(`[${label}] HTTP ${r.status} · ${Date.now() - t0}ms`);
  console.log('  usage:', JSON.stringify(d.usage ?? d.error ?? d).slice(0, 400));
}

console.log('图:', imgPath, '·', (buf.length / 1024).toFixed(0) + 'KB 原始 /', (b64.length / 1024).toFixed(0) + 'KB b64');
await call('call#1 建缓存(含图)');
await new Promise((r) => setTimeout(r, 2000));
await call('call#2 应命中(含图)');
