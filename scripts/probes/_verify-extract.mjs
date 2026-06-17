/** 拿遥测里"坏 JSON"（content 被当整段 JSON 的）喂新 extractJson，验证正则兜底。
 * node scripts/probes/_verify-extract.mjs */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// —— 与 session-manager / infer 中一致的新 extractJson ——
function extractJson(text) {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { content: text };
  try { return JSON.parse(m[0]); } catch { /* 半角引号破坏 → 正则兜底 */ }
  const b = m[0];
  const rt = b.match(/"result_type"\s*:\s*"([^"]*)"/);
  const cf = b.match(/"confidence"\s*:\s*([0-9.]+)/);
  const cm = b.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"confidence"|\}\s*$)/);
  if (!cm && !rt) return { content: text };
  return { result_type: rt ? rt[1] : undefined, content: cm ? cm[1] : text, confidence: cf ? Number(cf[1]) : undefined };
}

const FILE = resolve(process.cwd(), '.dev-telemetry.jsonl');
const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
let n = 0;
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (typeof e.content === 'string' && e.content.trim().startsWith('{')) {
    n++;
    const r = extractJson(e.content);
    const clean = typeof r.content === 'string' && !r.content.trim().startsWith('{');
    console.log(`${clean ? '✅' : '❌'} result_type=${r.result_type} confidence=${r.confidence}`);
    console.log(`   content: ${r.content}\n`);
  }
}
console.log(n ? `共 ${n} 条坏 JSON，上面 ✅ = 成功抽出干净 content` : '遥测里没有坏 JSON（可能还没用 Claude 标注过）');
