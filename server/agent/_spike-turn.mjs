/**
 * P3.2 验证:per-book 会话管理器。
 *  轮1 = 标注(合成图+焦点) → 旁注 + 冷启延迟;
 *  轮2 = 纯文本追问"前面圈的那句设定哪年" → 看是否记得(连贯) + 热轮延迟。
 * 用法: node --env-file=.env server/agent/_spike-turn.mjs /tmp/p1-composite.png
 */
import { readFileSync } from 'node:fs';
import { runAgentTurn, runRawTurn, closeAgentSession } from './session-manager.mjs';

const cfg = { gatewayUrl: process.env.LLM_GATEWAY_URL, key: process.env.LLM_GATEWAY_KEY, realModel: process.env.LLM_MODEL || 'kimi-k2.6' };
if (!cfg.gatewayUrl || !cfg.key) { console.error('缺 env'); process.exit(1); }
const imgPath = process.argv[2] || '/tmp/p1-composite.png';
const image = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64');

const pageText = `一
已经是公元二零三五年了，世情仍然没有变化，人类仍然落后，女人的生活，仍然乏善足陈，母亲们仍然唠叨，孩子们仍然反叛，生命的意义犹待发掘。
今日，跟一切日子一样，奇闷无比。`;
const bookId = 'spike-book-1';

try {
  console.log('→ 轮1:标注(圈第一句)');
  const r1 = await runAgentTurn(bookId, {
    gestureType: 'circle', pageText, focus: '已经是公元二零三五年了，世情仍然没有变化', image, modes: ['inspiration'],
  }, cfg);
  console.log(`  [冷启 ${r1._meta.ms}ms] type=${r1.result_type} → ${r1.content}`);

  console.log('→ 轮2:纯文本追问(不重述,考记忆)');
  const r2 = await runRawTurn(bookId, '我前面圈的那句，设定的年份是哪一年？只回年份。', cfg);
  console.log(`  [热轮 ${r2._meta.ms}ms] → ${r2.content}`);

  const remembered = /2035|二零三五|二〇三五/.test(r2.content);
  console.log(remembered ? '✅ 会话管理器 OK:轮2 记得设定年份(跨标注连贯成立)' : `⚠️ 轮2 未明确记得:${r2.content}`);
  console.log(`⏱  冷启 ${r1._meta.ms}ms vs 热轮 ${r2._meta.ms}ms`);
} catch (e) {
  console.error('失败:', e?.stack || e);
} finally {
  closeAgentSession(bookId);
}
process.exit(0);
