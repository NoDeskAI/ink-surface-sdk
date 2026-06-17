/**
 * per-book 会话管理器:一本书 = 一个长驻 query({prompt: AsyncQueue}) 会话。
 * 每个标注 = 一轮 turn(push 合成图+焦点文字),模型记得本书之前的标注 → 跨标注连贯。
 * 挂在现有 vite 中间件里即可(SDK 自己 spawn 子进程,会话 Map 放模块级)。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartProxy } from './gateway-proxy.mjs';
import { AsyncQueue, userTurn } from './async-queue.mjs';

const PERSONA =
  '你是 InkLoop —— 嵌在 PDF 阅读器里的旁注式 AI 同读者。读者在原文上用圈/划/箭头/手写做标注，' +
  '系统会直接告诉你"读者标注命中的原文文字"——你主要依据这段命中文字、结合整页文字与你记得的本书前文，轻声给一条简短中文旁注。' +
  '**只有在系统明确附了局部图时才看图；没有附图就不要假设有图、不要索取图片、更不要描述任何并不存在的图**。' +
  '严格依据本页文字与命中的原文作答——**不要臆造未在原文出现的具体事实**(年份、地名、人名、数字等);拿不准就说不确定，宁可点到为止也不编。' +
  '不寒暄、不复述原文、不用 markdown 或列表、不超过 2 句，像页边批注点到为止。' +
  '每条标注只输出一个 JSON 对象:{"result_type":"...","content":"旁注","confidence":0.x}；content 内若引用原文请用「」括，勿用半角双引号(会破坏 JSON)；此外不要任何文字。';

const TONE = {
  circle: '这是圈选：解释被圈的是什么、关键在哪。',
  underline: '这是划线/重点：提炼要点、点出它为何重要。',
  highlight: '这是高亮/重点：提炼这处的要点、点出它为何重要。',
  arrow: '这是箭头/关联：点出它指向什么、和什么相关。',
  margin_note: '这是手写批注：先读出我写了什么，再就内容与所标段落给呼应。',
};

/** 由「为什么画」(intent) 主导回应语气，几何形状(eventType)兜底——让提问/指令/综合不被当成普通解释。 */
function toneFor(eventType, intent, modes) {
  if (intent === 'question') return '我像在发问：针对所标处直接作答，不要反问。';
  if (intent === 'command') return '我写的是一条指令（如总结/翻译/改写）：直接执行我的要求、作用在所标段落上，给结果而非评论。';
  if (intent === 'summary' || (Array.isArray(modes) && modes.includes('summary'))) return '我在这一处留了多个标注：综合它们给一条整体性的洞察，帮我想深一层。';
  return TONE[eventType] || '就我标注处给一条旁注。';
}

const sessions = new Map(); // bookId → session

function extractJson(text) {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { content: text };
  try { return JSON.parse(m[0]); } catch { /* 内部半角引号破坏 JSON（Claude 常见）→ 正则抽字段兜底 */ }
  const b = m[0];
  const rt = b.match(/"result_type"\s*:\s*"([^"]*)"/);
  const cf = b.match(/"confidence"\s*:\s*([0-9.]+)/);
  // content：锚定其后的 ,"confidence" 或结尾 "}，容忍 content 内部的半角双引号
  const cm = b.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"confidence"|\}\s*$)/);
  if (!cm && !rt) return { content: text };
  return { result_type: rt ? rt[1] : undefined, content: cm ? cm[1] : text, confidence: cf ? Number(cf[1]) : undefined };
}

async function ensureSession(bookId, cfg) {
  // 每轮先刷新代理（当前模型 + 思考预算）——即便复用会话，也让思考开关/模型即时生效
  const proxy = await getOrStartProxy({ gatewayUrl: cfg.gatewayUrl, realModel: cfg.realModel, thinkBudget: cfg.thinkBudget });
  const existing = sessions.get(bookId);
  if (existing && !existing.closed && existing.model === cfg.realModel) return existing;

  // 一本书一个会话；切换模型(cfg.realModel 变)也重起。开新前关掉其它会话(含本书旧模型)。
  for (const [id, other] of sessions) {
    if (!other.closed) { try { other.inputQueue.close(); } catch { /* */ } }
    sessions.delete(id);
  }

  const sessionId = `inkloop-${bookId}`;
  const baseUrlForBinary = `${proxy.baseUrl}/__nd/${encodeURIComponent(sessionId)}`;
  const inputQueue = new AsyncQueue();
  const s = { inputQueue, pending: [], curText: '', closed: false, bookId, model: cfg.realModel };
  s.ready = new Promise((resolve) => { s._resolveReady = resolve; }); // SDK 'init' 到达(子进程就绪)即 resolve
  sessions.set(bookId, s);

  const stream = query({
    prompt: inputQueue,
    options: {
      model: 'claude-opus-4-7[1m]',
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
      settingSources: [],
      systemPrompt: PERSONA,
      env: { ...process.env, ANTHROPIC_BASE_URL: baseUrlForBinary, ANTHROPIC_API_KEY: cfg.key },
    },
  });

  // 消费循环:每个 result 结束一轮 → FIFO 解析对应 pending(SDK 串行处理 turn,顺序对齐)
  s.consumer = (async () => {
    try {
      for await (const msg of stream) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          s._resolveReady?.(); // 子进程就绪 → 预热完成
        } else if (msg.type === 'assistant') {
          const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (t) s.curText += t;
        } else if (msg.type === 'result') {
          const p = s.pending.shift();
          if (p) p.resolve({ text: s.curText.trim(), subtype: msg.subtype, cost: msg.total_cost_usd, ms: Date.now() - p.t0 });
          s.curText = '';
        }
      }
    } catch (e) {
      s.pending.splice(0).forEach((p) => p.reject(e));
    } finally {
      s.closed = true;
      s._resolveReady?.(); // 别让 open 的等待挂死
      s.pending.splice(0).forEach((p) => p.reject(new Error('session closed')));
    }
  })();

  return s;
}

// 多图角色标签：每张图前插一段说明，按名（笔迹图/合成图）引用，不依赖图片张数/编号。
const ROLE_LABEL = {
  ink: '【笔迹图·我的手写已从原文单独抽出、铺白底，识别手写就看这张】',
  composite: '【合成图·墨迹叠在原文上，判断我画在哪、圈/划住了什么就看这张】',
  // page(原文层)已弃用——原文以整页文字为准，不再单独发图
};

/** 把一条标注拼成一轮 turn 的 content(多图[笔迹/原文/合成] + 焦点文字 + 整页语境)。图在前、文字在后。 */
function buildTurnContent({ pageText, focus, gestureType, intent, modes, image, images }) {
  const tone = toneFor(gestureType, intent, modes);
  const list = Array.isArray(images) && images.length ? images : (image ? [{ role: 'composite', data: image }] : []);
  const hasInk = list.some((im) => im?.role === 'ink');
  const hasImg = list.length > 0;
  const foc = (focus || '').trim();

  // 话术随实际情况自适应——核心：没附图就绝不提图（治"求图/幻觉一张图"）。
  let body;
  if (hasImg) {
    // 兜底视觉证据路径：focus 为空（命中图区/空白且 OCR 没读出）或 dev 强制发图时才走这里。
    const imgDesc = hasInk
      ? '上面附了笔迹图（我的手写已抽出、铺白底）与合成图（墨迹叠在原文上）。'
      : '上面附了一张合成图（我的墨迹叠在原文上，看我画在哪、圈/划住了什么）。';
    const step1 = hasInk
      ? '① 先看笔迹图逐字读出手写；再看合成图确认我标注落在全文哪一处（对照整页文字）；'
      : '① 看合成图确认我标注落在全文哪一处（对照整页文字）；';
    body = `${imgDesc}原文以整页文字为准。${foc ? `命中文字约为：「${foc}」。` : '结构没给出命中文字，请据图判断。'}\n${step1}② ${tone} 一句中文旁注。`;
  } else if (foc) {
    // 纯取证路线：有命中文字、无图。直接据文字回答，禁止提图。
    body = `读者标注**命中的原文是**：「${foc}」。没有附图，也不需要图——直接就这处文字给旁注，不要索取或描述任何图片。\n${tone} 一句中文旁注。`;
  } else {
    // 无图、无命中：诚实兜底，禁止编造/提图。
    body = `读者这次标注**没有命中任何具体文字**（多半落在空白处或纯图像区）。不要假设有图片、不要编造内容；用一句话如实说明"这处没对到原文具体内容"，或就整页语境给一句轻提示即可。`;
  }
  const text = `这一页全文（语境）：\n${(pageText || '').slice(0, 2500)}\n\n${body}`;
  const content = [];
  for (const im of list) {
    const raw = String(im?.data || '');
    const b64 = raw.replace(/^data:image\/[a-z]+;base64,/, '');
    if (!b64) continue;
    const mt = /^data:(image\/[a-z]+);base64,/.exec(raw);
    const media_type = mt ? mt[1] : 'image/png'; // 透传 jpeg/png（原文/合成层走 jpeg 省体积+延迟）
    if (im.role && ROLE_LABEL[im.role]) content.push({ type: 'text', text: ROLE_LABEL[im.role] });
    content.push({ type: 'image', source: { type: 'base64', media_type, data: b64 } });
  }
  content.push({ type: 'text', text });
  return content;
}

/** 跑一轮标注 → 返回 InkLoop 形态的结果。bookId 内的会话长驻、记得前文。 */
export async function runAgentTurn(bookId, ann, cfg) {
  const s = await ensureSession(bookId, cfg);
  const content = buildTurnContent(ann);
  const res = await new Promise((resolve, reject) => {
    s.pending.push({ resolve, reject, t0: Date.now() });
    s.inputQueue.push(userTurn(content));
  });
  const parsed = extractJson(res.text);
  const modes = Array.isArray(ann.modes) ? ann.modes : [];
  return {
    result_type: modes.includes(parsed.result_type) ? parsed.result_type : (modes[0] || 'inspiration'),
    content: String(parsed.content || res.text || '此刻没能想清楚，稍后再为你低语。').trim(),
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
    _meta: { ms: res.ms, cost: res.cost, subtype: res.subtype, model: s.model },
  };
}

/** 纯文本跟进轮(测试连贯 / 未来"追问"用):不带图,直接 push 一句到会话。 */
export async function runRawTurn(bookId, text, cfg) {
  const s = await ensureSession(bookId, cfg);
  const res = await new Promise((resolve, reject) => {
    s.pending.push({ resolve, reject, t0: Date.now() });
    s.inputQueue.push(userTurn(text));
  });
  return { content: res.text, _meta: { ms: res.ms, cost: res.cost } };
}

export function closeAgentSession(bookId) {
  const s = sessions.get(bookId);
  if (s) { try { s.inputQueue.close(); } catch { /* */ } sessions.delete(bookId); }
}

export function agentSessionStats() {
  return [...sessions.entries()].map(([id, s]) => ({ bookId: id, closed: s.closed, pending: s.pending.length }));
}

// ── HTTP 端点封装(vite 中间件挂载用;cfg 从 env 取,key 不出服务端) ──
function cfgFrom(body) {
  return {
    gatewayUrl: process.env.LLM_GATEWAY_URL,
    key: process.env.LLM_GATEWAY_KEY,
    realModel: (body && body.model) || process.env.LLM_MODEL || 'kimi-k2.6', // 模型来自请求(dev 面板选的)，回退 env
    thinkBudget: (body && body.thinking) ? (Number(process.env.AGENT_THINK_BUDGET) || 1024) : 0, // 思考开关：on→预算(env 或 1024)，off→0
  };
}

/** POST /api/agent/turn —— 跑一轮标注。 */
export async function agentTurnEndpoint(body) {
  const { bookId, gestureType, intent, pageText, focus, image, images, modes } = body || {};
  if (!bookId) throw new Error('bookId required');
  return runAgentTurn(bookId, { gestureType, intent, pageText, focus, image, images, modes }, cfgFrom(body));
}

/** POST /api/agent/open —— 开书预热:起会话 + spawn 子进程,消掉首笔 ~14s 冷启。 */
export async function agentOpenEndpoint(body) {
  if (!body?.bookId) throw new Error('bookId required');
  const s = await ensureSession(body.bookId, cfgFrom(body));
  // 等子进程 'init' 就绪(spawn 完),让开书后的首笔标注变成热轮;超时兜底不挂死
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, 20000))]);
  return { ok: true, warmed: body.bookId };
}

/** POST /api/agent/close —— 关书结束会话。 */
export function agentCloseEndpoint(body) {
  closeAgentSession(body?.bookId);
  return { ok: true };
}
