/**
 * 读 dev 调试通道遥测（.dev-telemetry.jsonl）→ 可读摘要。
 * 用法：node scripts/probes/_read-telemetry.mjs   （N=20 控制条数）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(process.cwd(), '.dev-telemetry.jsonl');
let lines;
try { lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean); }
catch { console.log('没有遥测文件：', FILE, '\n（确认 dev 服务已重启 + 页面刷新过 + 至少画过一条标注）'); process.exit(0); }
if (!lines.length) { console.log('遥测文件为空——还没镜像到事件。确认：① 重启了 dev 服务 ② 刷新了页面 ③ 画过标注并等过停笔窗。'); process.exit(0); }

const N = Number(process.env.N || 16);
const recent = lines.slice(-N).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const short = (t) => String(t || '').slice(11, 19);
const models = {};

console.log(`总事件 ${lines.length} 条，展开最近 ${recent.length} 条：\n`);
for (const e of recent) {
  const d = e.debug || {};
  const eng = e.env?.engine || '?';
  const model = e.model || e.env?.model || '?';
  models[model] = (models[model] || 0) + 1;
  const imgs = (e.images || []).map((im) => `${im.role}(${Math.round((im.bytes || 0) / 1000)}k)`).join(' ') || '无图';
  const ms = d.ms ? `${Math.round(d.ms)}ms` : '';
  const think = d.think_budget != null ? `think=${d.think_budget}` : '';
  console.log(`[${short(e.ts)}] 【${model}】${eng} · p${e.env?.pageIndex ?? '?'} · ${e.gesture || '?'}${e.intent ? '/' + e.intent : ''} → ${e.resultType || '?'} (conf ${e.confidence ?? '?'}) ${ms} ${d.mode ? '· ' + d.mode : ''} ${think}`);
  if (e.focus) console.log(`    focus: ${e.focus}`);
  console.log(`    imgs : ${imgs}${d.image_roles ? '  [' + JSON.stringify(d.image_roles) + ']' : ''}${d.page_text_len != null ? '  · pageText ' + d.page_text_len + '字' : ''}`);
  console.log(`    reply: ${e.content || ''}`);
  if (e.recalled?.length) console.log(`    recall: ${JSON.stringify(e.recalled)}`);
  console.log('');
}
console.log('模型分布:', JSON.stringify(models));
