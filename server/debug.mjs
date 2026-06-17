/**
 * dev-only 遥测通道：让"开发者侧的 Claude"不进浏览器也能看到一次标注真实发生了什么。
 *
 * 流向：客户端 pushInspect（dev 下）→ POST /api/__debug/event（已去 base64，只留角色+尺寸+
 *   真实 system/task/焦点/回复/计时/当前设置快照）→ 这里 落 JSONL 文件 + 存内存环。
 * 读取：① 直接 Read `.dev-telemetry.jsonl`（最省事，无需服务在跑时联网）
 *      ② GET /api/__debug/snapshot?n=20 取内存环 JSON（要服务在跑）。
 * 纯 dev：路由只挂在 vite 中间件里，生产构建不含；文件 gitignored。
 */
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const RING = [];
const MAX = 80;
let lastState = null;
const FILE = resolve(process.cwd(), '.dev-telemetry.jsonl');

/** 收一条事件：进内存环 + 追加 JSONL。kind='state' 的另存为 lastState 便于快照里直读。 */
export function debugEvent(rec) {
  const e = { t: new Date().toISOString(), ...(rec && typeof rec === 'object' ? rec : { raw: rec }) };
  RING.push(e);
  if (RING.length > MAX) RING.shift();
  if (e.kind === 'state' || e.env) lastState = e;
  appendFile(FILE, JSON.stringify(e) + '\n').catch(() => { /* 落盘失败不连累主链路 */ });
  return { ok: true, count: RING.length };
}

/** 取最近 n 条 + 最后一次设置/状态快照 + 文件路径（供外部 Read）。 */
export function debugSnapshot(n = 20) {
  const k = Math.max(1, Math.min(MAX, Number(n) || 20));
  return { file: FILE, count: RING.length, lastState, events: RING.slice(-k) };
}
