/**
 * 多图链路探针：往运行中的 dev server /api/infer 打一发"笔迹/原文/合成"三图请求，
 * 验证 ① NoDesk 网关(Kimi)吃不吃单条消息里的多张图 ② 服务端 image_roles 三张到位。
 * 用法：dev server 跑着(npm run dev, :8765) → node scripts/probes/_probe-multi-image.mjs
 */
import zlib from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
/** 生成一张 size×size 纯色 RGB PNG 的 dataURL（真实可解码的图，避开 1×1 的尺寸边界）。 */
function solidPngDataUrl(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, color type 2 (RGB)
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const off = y * (size * 3 + 1); raw[off] = 0;
    for (let x = 0; x < size; x++) { const p = off + 1 + x * 3; raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; }
  }
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const ink = solidPngDataUrl(64, 250, 250, 250);       // 近白底（笔迹层）
const page = solidPngDataUrl(64, 200, 200, 200);      // 灰（原文层）
const composite = solidPngDataUrl(64, 230, 230, 230); // 浅灰（合成层）

const body = {
  request_id: 'req_probe', trace_id: 'tr_probe', event_id: 'ev_probe',
  annotation_event: { event_type: 'margin_note', page_id: 'p1', geometry: { bbox: [0.1, 0.1, 0.2, 0.05] } },
  ocr_blocks: [], nearby_text: null,
  output_modes: ['inspiration', 'question', 'connection'],
  page_text: '测试页：这是一段用于验证多图推理链路是否打通的整页文字内容。',
  focus: '测试焦点行',
  images: [{ role: 'ink', data: ink }, { role: 'page', data: page }, { role: 'composite', data: composite }],
};

const PORT = process.env.PROBE_PORT || 8765;
const t0 = Date.now();
const resp = await fetch(`http://localhost:${PORT}/api/infer`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const j = await resp.json();
console.log('HTTP', resp.status, `· ${Date.now() - t0}ms`);
console.log('result_type :', j.result_type);
console.log('content     :', j.content);
console.log('model       :', j.model_name);
console.log('has_image   :', j._debug?.has_image);
console.log('image_roles :', JSON.stringify(j._debug?.image_roles));
console.log('mode        :', j._debug?.mode);
if (j.error) console.log('ERROR       :', j.error);
