import { z } from 'zod';
import { buildMeetingPanelSummaryPrompts, SYSTEM_PROMPTS, type MeetingPanelSummaryHandwritingSections, type PromptRole } from './prompts';

/**
 * 推理网关代理（Node 侧，仅 dev server 内运行）。
 *
 * 复用 Nodesign 的 NoDesk AI Gateway：
 *   POST {LLM_GATEWAY_URL}  (= …/default/passthrough)
 *   Authorization: Bearer {LLM_GATEWAY_KEY}     ← 网关只认 Bearer，不认 x-api-key
 *   body: 标准 Anthropic /v1/messages + 顶层注入 channel / channel_url
 *
 * channel 按 model 前缀自动路由（跟他们网关一致）：kimi-* → moonshot；其余 → DMXAPI。
 * 真实回答由此处的 model 产出；source_refs 由服务端从请求装配，**不让模型编造**（PRD 红线）。
 *
 * 这是 inference 的 provider 接缝实现之一；annotation 语义/文档解析最终归 B 组，
 * 这里先用现成网关把链路跑通。
 */

// 惰性读取：env 由 vite 插件在 configureServer 里注入 process.env，
// 晚于本模块 import 求值，所以不能在模块顶层捕获。
function cfg() {
  const url = process.env.LLM_GATEWAY_URL
    || process.env.LLM_GATEWAY_BASE
    || 'https://llm-gateway-api.nodesk.tech/default/v1';
  const transport = process.env.LLM_GATEWAY_TRANSPORT
    || (url.includes('/passthrough') ? 'anthropic_passthrough' : 'openai_chat_completions');
  return {
    url,
    key: process.env.LLM_GATEWAY_KEY || '',
    model: process.env.LLM_MODEL || 'glm-5.2',
    transport,
  };
}

/**
 * 模型家族路由表（D2）：前缀 → {渠道(=provider), 渠道 URL, thinking 配置}。route()/thinkingFor() 收口于此，不再各处 if。
 * 2026-06-22 网关探针实测：Claude(adaptive)/Kimi(enabled+budget) 经网关回思考块；Gemini 经 DMX 不回传（不请求·白吃 token）。
 * minTokens 给思考留头寸（保持原 claude 1280 等效上限）。
 */
const DMX_URL = 'https://www.dmxapi.cn/v1/messages';
const MODEL_ROUTES: ReadonlyArray<{ prefix: string; channel: string; channel_url: string; thinking: any; minTokens: number }> = [
  { prefix: 'kimi',   channel: 'kimi', channel_url: 'https://api.moonshot.cn/anthropic/v1/messages', thinking: { type: 'enabled', budget_tokens: 1024 }, minTokens: 1280 },
  { prefix: 'claude', channel: 'DMX',  channel_url: DMX_URL, thinking: { type: 'adaptive', display: 'summarized' }, minTokens: 1280 },
];
const DEFAULT_ROUTE = { channel: 'DMX', channel_url: DMX_URL, thinking: null, minTokens: 0 }; // gemini / 其它：不请求思考

function routeFor(model: string) {
  return MODEL_ROUTES.find((r) => model.startsWith(r.prefix)) ?? DEFAULT_ROUTE;
}
function route(model: string): { channel: string; channel_url: string } {
  const r = routeFor(model);
  return { channel: r.channel, channel_url: r.channel_url };
}
function thinkingFor(model: string): { thinking: any; minTokens: number } | null {
  const r = routeFor(model);
  return r.thinking ? { thinking: r.thinking, minTokens: r.minTokens } : null;
}

// D2 调用可观测：每次网关调用记 requestId/model/provider/latency/ok（服务端日志；远程代理同样可采）。
let aiCallSeq = 0;
function logAiCall(meta: { requestId: string; model: string; provider: string; ms: number; ok: boolean; status: number }): void {
  console.log(`[ai] ${JSON.stringify(meta)}`);
}

function isOpenAiTransport(): boolean {
  const transport = cfg().transport;
  return transport === 'openai_chat_completions' || transport === 'chat_completions';
}

function chatCompletionsUrl(url: string): string {
  const base = url.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function openAiExtras(model: string): Record<string, unknown> {
  if (/^glm[-_.]/i.test(model)) {
    return {
      thinking: { type: 'disabled' },
      enable_thinking: false,
      reasoning_effort: 'none',
    };
  }
  return {};
}

function openAiContentPart(block: any): any | null {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') return { type: 'text', text: String(block.text || '') };
  if (block.type === 'image') {
    const source = block.source || {};
    const data = String(source.data || '').replace(/^data:image\/[a-z]+;base64,/, '');
    if (!data) return null;
    const mediaType = String(source.media_type || 'image/png');
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
  }
  return null;
}

function openAiContent(content: unknown): unknown {
  if (!Array.isArray(content)) return String(content || '');
  const parts = content.map(openAiContentPart).filter(Boolean);
  return parts.length ? parts : '';
}

function openAiMessages(system: string, messages: any[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const message of messages) {
    const role = message?.role === 'assistant' || message?.role === 'system' ? message.role : 'user';
    out.push({ role, content: openAiContent(message?.content) });
  }
  return out;
}

function emptyTextError(model: string, data: any): Error {
  const finish = data?.choices?.[0]?.finish_reason || data?.stop_reason || 'unknown';
  const reasoning = data?.choices?.[0]?.message?.reasoning_content || '';
  const usage = data?.usage ? ` usage=${JSON.stringify(data.usage)}` : '';
  return new Error(`网关返回空正文 model=${model} finish=${finish}${reasoning ? ' reasoning_content_present=true' : ''}${usage}`);
}

async function callOpenAiGateway(opts: { system: string; messages: any[]; maxTokens: number; model?: string }): Promise<{ text: string; thinking: string; data: any }> {
  const { url, key } = cfg();
  const model = opts.model || cfg().model;
  if (!key) throw new Error('LLM_GATEWAY_KEY 未配置（在 annotation-loop-demo/.env 填网关 Key）');
  const body: any = {
    model,
    messages: openAiMessages(opts.system, opts.messages),
    max_tokens: opts.maxTokens,
    ...openAiExtras(model),
  };
  const requestId = `ai_${Date.now().toString(36)}_${++aiCallSeq}`;
  const t0 = Date.now();
  const resp = await fetch(chatCompletionsUrl(url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await resp.json().catch(() => ({}));
  logAiCall({ requestId, model, provider: 'openai_chat_completions', ms: Date.now() - t0, ok: resp.ok, status: resp.status });
  if (!resp.ok) throw new Error(data?.error?.message || `网关返回 ${resp.status}`);
  const message = data?.choices?.[0]?.message ?? {};
  const text = String(Array.isArray(message.content)
    ? message.content.map((part: any) => part?.text || '').join('')
    : message.content || '').trim();
  if (!text) throw emptyTextError(model, data);
  return { text, thinking: String(message.reasoning_content || '').trim(), data };
}

/** 低层网关调用：传完整 messages（可带 tools），返回完整响应 data。 */
async function callGateway(opts: { system: string; messages: any[]; maxTokens: number; tools?: any[]; model?: string }): Promise<any> {
  const { url, key } = cfg();
  const model = opts.model || cfg().model; // 模型可由调用方覆盖(dev 面板选的)，route() 按前缀分渠道
  if (!key) throw new Error('LLM_GATEWAY_KEY 未配置（在 annotation-loop-demo/.env 填网关 Key）');
  const { channel, channel_url } = route(model);
  // gemini 适配：Gemini 2.5/3 flash 默认开思考、思考 token 计入 max_tokens，低预算→空响应。给足余量。
  const max_tokens = model.startsWith('gemini') ? Math.max(opts.maxTokens, 2048) : opts.maxTokens;
  const body: any = { model, max_tokens, system: opts.system, messages: opts.messages, channel, channel_url };
  if (opts.tools) body.tools = opts.tools;
  const requestId = `ai_${Date.now().toString(36)}_${++aiCallSeq}`;
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data: any = await resp.json().catch(() => ({}));
  logAiCall({ requestId, model, provider: channel, ms: Date.now() - t0, ok: resp.ok, status: resp.status });
  if (!resp.ok) throw new Error(data?.error?.message || `网关返回 ${resp.status}`);
  return data;
}

/**
 * 流式网关调用：以 SSE(stream:true) 拉取，逐段 yield 文字增量(text_delta)。
 * 网关若不支持流式(返回 application/json) → 退化为一次性读出全文再 yield 一次，
 * 调用方逻辑不变(只是不再是增量)。供 reflowAiStream 做"按段流式重排"。
 */
type GwEvent = { type: 'text' | 'thinking'; delta: string };

/**
 * 流式网关调用（事件级）：逐段 yield {type:'text'|'thinking', delta}。
 *  · thinking 按模型家族派生（thinkingFor·实测）：Claude 用 adaptive、Kimi 用 enabled+budget，都经网关回思考块；
 *    Gemini 经 DMX 不回传思考摘要（请求也无益），故不请求。
 *  · 网关不支持 SSE 时退化为一次性读出 content 块（text + 可能的 thinking 块）。
 */
async function* gatewayEventStream(opts: { system: string; messages: any[]; maxTokens: number; model?: string; thinking?: boolean }): AsyncGenerator<GwEvent> {
  if (isOpenAiTransport()) {
    const result = await callOpenAiGateway({ system: opts.system, messages: opts.messages, maxTokens: opts.maxTokens, model: opts.model });
    if (result.thinking && opts.thinking) yield { type: 'thinking', delta: result.thinking };
    yield { type: 'text', delta: result.text };
    return;
  }

  const { url, key } = cfg();
  const model = opts.model || cfg().model;
  if (!key) throw new Error('LLM_GATEWAY_KEY 未配置（在 annotation-loop-demo/.env 填网关 Key）');
  const { channel, channel_url } = route(model);
  const tc = opts.thinking ? thinkingFor(model) : null; // 按家族派生（Claude/Kimi 回思考，Gemini 不请求）
  let max_tokens = model.startsWith('gemini') ? Math.max(opts.maxTokens, 2048) : opts.maxTokens;
  if (tc) max_tokens = Math.max(max_tokens, tc.minTokens); // 给思考留头寸
  const body: any = { model, max_tokens, system: opts.system, messages: opts.messages, channel, channel_url, stream: true };
  if (tc) body.thinking = tc.thinking;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok || !resp.body || !ct.includes('event-stream')) {
    // 网关没给 SSE（不支持流式/报错）→ 一次性读出 content 块（思考块 + 文本块）
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error?.message || `网关返回 ${resp.status}`);
    let emittedText = false;
    for (const b of (data?.content || [])) {
      if (b?.type === 'thinking' && b.thinking) yield { type: 'thinking', delta: String(b.thinking) };
      else if (b?.type === 'text' && b.text) {
        emittedText = true;
        yield { type: 'text', delta: String(b.text) };
      }
    }
    if (!emittedText) throw emptyTextError(model, data);
    return;
  }
  const reader = (resp.body as any).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let emittedText = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const ev = JSON.parse(payload);
        const d = ev?.delta;
        if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) yield { type: 'thinking', delta: d.thinking };
        else {
          const t = d?.text ?? (d?.type === 'text_delta' ? d.text : undefined);
          if (typeof t === 'string' && t) {
            emittedText = true;
            yield { type: 'text', delta: t };
          }
        }
      } catch { /* 非 JSON 的 SSE 行（注释/心跳）跳过 */ }
    }
  }
  if (!emittedText) throw emptyTextError(model, {});
}

/** 流式文字（兼容旧调用：只要正文，不请求思考）。供 reflowAiStream 等。 */
async function* gatewayTextStream(opts: { system: string; messages: any[]; maxTokens: number; model?: string }): AsyncGenerator<string> {
  for await (const e of gatewayEventStream(opts)) if (e.type === 'text') yield e.delta;
}

const textOf = (data: any): string =>
  (data?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();

type ImgIn = { role?: string; data: string };

// 多图角色标签：每张图前插一段文字说明它是什么，按名（笔迹图/合成图）引用，不依赖张数/编号。
const ROLE_LABEL: Record<string, string> = {
  ink: '【笔迹图·用户手写已从原文单独抽出、铺白底，识别手写就看这张】',
  composite: '【合成图·墨迹叠在原文上，判断画在哪、圈/划住了什么就看这张】',
  board: '【完整白板页·白底笔迹，区域坐标在后续 JSON 中给出】',
  // page(原文层)已弃用——原文以整页文字 page_text 为准，不再单独发图
};

/** 把图列表（带可选角色）转成 content 块：每张前插一段角色标签文字，再插图。 */
function imageBlocks(images: ImgIn[]): any[] {
  const out: any[] = [];
  for (const im of images) {
    const raw = String(im?.data || '');
    const data = raw.replace(/^data:image\/[a-z]+;base64,/, '');
    if (!data) continue;
    const mt = /^data:(image\/[a-z]+);base64,/.exec(raw);
    const media_type = mt ? mt[1] : 'image/png'; // 透传 jpeg/png（grabLayers 原文/合成发 jpeg 省体积）
    const label = im.role ? ROLE_LABEL[im.role] : '';
    if (label) out.push({ type: 'text', text: label });
    out.push({ type: 'image', source: { type: 'base64', media_type, data } });
  }
  return out;
}

/** 单发：images 可为多图(带角色)数组，或单张已 strip 的 b64 字符串(旧调用方)。图在前、文字在后。 */
async function gateway(system: string, user: string, maxTokens: number, image?: string | ImgIn[], model?: string): Promise<string> {
  const blocks = Array.isArray(image)
    ? imageBlocks(image)
    : (image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] : []);
  const content = blocks.length ? [...blocks, { type: 'text', text: user }] : user;
  if (isOpenAiTransport()) {
    return (await callOpenAiGateway({ system, messages: [{ role: 'user', content }], maxTokens, model })).text;
  }
  const text = textOf(await callGateway({ system, messages: [{ role: 'user', content }], maxTokens, model }));
  if (!text) throw emptyTextError(model || cfg().model, {});
  return text;
}


function extractJson(text: string): any {
  if (!text) return {};
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { content: text };
  try { return JSON.parse(m[0]); } catch { /* 内部半角引号破坏 JSON（Claude 常见）→ 正则抽字段兜底 */ }
  const b = m[0];
  const rt = b.match(/"result_type"\s*:\s*"([^"]*)"/);
  const cf = b.match(/"confidence"\s*:\s*([0-9.]+)/);
  const cm = b.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"confidence"|\}\s*$)/);
  if (!cm && !rt) return { content: text };
  return { result_type: rt ? rt[1] : undefined, content: cm ? cm[1] : text, confidence: cf ? Number(cf[1]) : undefined };
}

// C5：AI 返回的声明式 schema（替代手写 String()/默认兜底，行为等价）。每字段 .catch 默认 = 缺/坏字段回退，
// 故 .parse 对 extractJson 的任意对象都不抛；跨字段逻辑（kind 依赖 reading 等）仍留在各函数内。
const interpretRawSchema = z.object({
  reading: z.string().catch(''),
  kind: z.string().catch(''),
  description: z.string().catch(''),
});
const classifyRawSchema = z.object({
  respond: z.boolean().catch(true), // 缺/非布尔 → true（等价旧 respond !== false）
  reason: z.string().catch(''),
});
const readingNoteRawSchema = z.object({
  title: z.string().catch(''),
  body_md: z.string().catch(''),
  summary_md: z.string().catch(''),
});
const meetingPanelTextSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(600));
/** 超限截断而非清空：.max().catch([]) 会在模型多给一条时把整组静默清空，改为保留前 N 条。 */
const cappedArray = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).catch([] as z.infer<T>[]).transform((arr) => arr.slice(0, max));

const meetingPanelSummarySchema = z.object({
  conclusions: cappedArray(meetingPanelTextSchema, 10),
  action_items: cappedArray(z.object({
    task: meetingPanelTextSchema,
    owner: z.string().transform((value) => value.trim()).pipe(z.string().max(120)).catch('未指定'),
    due: z.string().transform((value) => value.trim()).pipe(z.string().max(120)).optional(),
    evidence: z.string().transform((value) => value.trim()).pipe(z.string().max(600)).optional(),
  }), 10),
  risks: cappedArray(meetingPanelTextSchema, 10),
  open_questions: cappedArray(meetingPanelTextSchema, 10),
  next_steps: cappedArray(meetingPanelTextSchema, 10),
  // 访谈模式：完整研究报告 markdown 原文（可选·zod 默认会剥未知键，必须显式声明才能透传到设备）
  report_markdown: z.string().optional(),
});

export type MeetingPanelSummary = z.infer<typeof meetingPanelSummarySchema>;




/**
 * 意图理解：读用户在页边的手写批注截图 —— ①转写手写文字 ②判断「为什么写」。
 * 几何手势（圈/划/箭头）的意图已知；手写靠这条 VLM 解读补上（Phase C）。
 */
export async function runInterpret(payload: any): Promise<{ reading: string; kind: string; description: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { reading: '', kind: 'none', description: '' };
  // 类型分类器 + 转写器（v3：markup 由几何判，"手写 vs 画"这条无几何模板的轴交给识别——
  // 它读这团墨是不是文字。**context-free**：只看墨图，不需要对话上下文。英文优先、中文兜底，逐字转写不翻译。
  // 画（sketch/mixed）另给一句"大概像什么"的粗描述（笑脸/箭头/方框…）——只描述长相，不揣测意图（意图交推理模型）。
  const system = SYSTEM_PROMPTS.ink_classifier;
  const raw = await gateway(system, 'Classify, transcribe and describe this ink:', 300, image, payload?.model);
  const j = interpretRawSchema.parse(extractJson(raw)); // 全 string，缺/坏字段 → ''
  const reading = j.reading.trim();
  const KINDS = ['handwriting', 'sketch', 'mixed', 'none'];
  const kind = KINDS.includes(j.kind) ? j.kind : (reading ? 'handwriting' : 'none'); // 缺 kind 时按有无文字兜底
  const description = (kind === 'sketch' || kind === 'mixed') ? j.description.trim() : '';
  return { reading, kind, description };
}

/**
 * 上下文分类器（v3）：判读者刚写下的一段手写，是不是想让伴读 AI 现在就回应。
 *   respond=true：冲着 AI 来的提问/指令；respond=false：写给自己的笔记/感想（折叠不打扰）。
 * 带与主模型同源的上下文（标注脉络 narrative + 所标 marked + 最近对话）；明确问号/疑问词/祈使偏 respond——
 * 漏答一个真问题，比偶尔多答一句更糟。解析失败默认 respond=true。
 */
export async function runClassifyContext(payload: any): Promise<{ respond: boolean; reason: string }> {
  const question = String(payload?.question || '').trim();
  if (!question) return { respond: false, reason: '无手写文字' };
  const narrative = String(payload?.view_narrative || '').trim();
  const marked = String(payload?.marked || '').trim();
  const convo: Array<{ role: string; content: string }> = Array.isArray(payload?.conversation) ? payload.conversation : [];
  const history = convo.slice(-6).map((m) => `${m.role === 'user' ? '读者' : 'AI'}：${String(m.content || '').slice(0, 200)}`).join('\n');
  const system = SYSTEM_PROMPTS.context_classifier;
  const user =
    `读者刚写下：「${question}」\n` +
    (marked ? `这一阵标注涉及：${marked}\n` : '') +
    (narrative ? `标注脉络：${narrative}\n` : '') +
    (history ? `\n最近对话：\n${history}\n` : '') +
    '\n该不该现在回应？';
  const raw = await gateway(system, user, 200, undefined, payload?.model);
  const j = classifyRawSchema.parse(extractJson(raw));
  return { respond: j.respond, reason: j.reason.slice(0, 120) };
}

export async function runReadingNotePostprocess(payload: any): Promise<{ title: string; body_md: string; summary_md: string }> {
  const docTitle = String(payload?.doc_title || '').trim();
  const quote = String(payload?.quote || '').trim();
  const userNote = String(payload?.user_note || '').trim();
  const contextText = String(payload?.context_text || '').trim();
  if (!quote && !userNote) return { title: '', body_md: '', summary_md: '' };

  const system = `<task_context>
你在为 InkLoop 生成一条 Obsidian Reading Note。输入来自读者在墨水屏上对原文的标记：可能包含原文摘录、手写边注、页内上下文。
</task_context>
<rules>
- 不要复述整段原文，不要写空泛套话。
- 把原文观点转成读者后续能检索、复盘、行动的笔记。
- 如果有用户边注，优先围绕用户边注解释它为什么重要。
- 输出要像正式阅读笔记，不像测试数据。
- body_md 用 1-2 个短段落，中文，直接给洞察和产品启发。
- summary_md 用一句话概括这条标记对当前文档/项目的意义。
</rules>
<output_format>
只输出 JSON：{"title":"短标题","body_md":"正文","summary_md":"一句摘要"}。不要 markdown 代码块，不要额外解释。
</output_format>`;
  const user = [
    docTitle ? `文档标题：${docTitle}` : '',
    quote ? `原文摘录：${quote}` : '',
    userNote ? `用户边注：${userNote}` : '',
    contextText ? `页内上下文：${contextText.slice(0, 1200)}` : '',
  ].filter(Boolean).join('\n');
  const raw = await gateway(system, user, 600, undefined, payload?.model);
  const parsed = readingNoteRawSchema.parse(extractJson(raw));
  return {
    title: parsed.title.trim().slice(0, 80),
    body_md: parsed.body_md.trim(),
    summary_md: parsed.summary_md.trim(),
  };
}

/** Provider 会后转写 -> panel_summary 五要素。窄端点调用；输入长度与输出 schema 都在服务端收口。 */
export async function runMeetingPanelSummary(payload: any): Promise<{ summary: MeetingPanelSummary; model: string }> {
  const title = String(payload?.title || '').trim().slice(0, 300) || '(未命名会议)';
  const platform = String(payload?.platform || 'google_meet').trim().slice(0, 64) || 'google_meet';
  const transcript = String(payload?.transcript || '').trim();
  const smartNote = String(payload?.smart_note || '').trim().slice(0, 8_000);
  if (!transcript) throw Object.assign(new Error('meeting_transcript_required'), { status: 400 });
  if (transcript.length > 18_000) throw Object.assign(new Error('meeting_transcript_too_large'), { status: 413 });
  const model = String(payload?.model || cfg().model);
  const handwritingSections = normalizeMeetingPanelHandwritingSections(payload?.handwriting_sections);
  const prompt = buildMeetingPanelSummaryPrompts({
    platform,
    meeting_title: title,
    transcript,
    ...(smartNote ? { smart_note: smartNote } : {}),
    ...(handwritingSections ? { handwriting_sections: handwritingSections } : {}),
  });
  // 长输出（访谈报告 20k tokens）非流式会撞网关 ~100s 空闲掐线（524）——走流式累积保活连接。
  let raw = '';
  for await (const delta of gatewayTextStream({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 20000, model })) raw += delta;
  const summary = meetingPanelSummarySchema.parse(extractJson(raw));
  if (!summary.conclusions.length) throw new Error('meeting_summary_missing_conclusions');
  return { summary, model };
}

type HandwritingSectionKey = 'pre_meeting' | 'in_meeting' | 'post_meeting';
type PreparedHandwritingItem = { text: string; relative_time?: string; truncated: boolean };

const HANDWRITING_TOTAL_CHARS = 8_000;
const HANDWRITING_TOTAL_ITEMS = 80;
const HANDWRITING_SECTION_ORDER = [1, 1, 1, 0, 2] as const;

function fairHandwritingAllocation(
  demands: readonly number[],
  total: number,
  reserved: readonly number[],
): number[] {
  const allocation = demands.map((demand, index) => Math.min(demand, reserved[index] || 0));
  let remaining = Math.max(0, total - allocation.reduce((sum, value) => sum + value, 0));
  while (remaining > 0) {
    let progressed = false;
    for (const index of HANDWRITING_SECTION_ORDER) {
      if (remaining <= 0) break;
      if ((allocation[index] || 0) >= (demands[index] || 0)) continue;
      allocation[index] += 1;
      remaining -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }
  return allocation;
}

function preparedTextItem(raw: unknown): PreparedHandwritingItem | undefined {
  if (typeof raw !== 'string') return undefined;
  const original = raw.trim();
  if (!original) return undefined;
  return { text: original.slice(0, 500), truncated: original.length > 500 };
}

export function normalizeMeetingPanelHandwritingSections(value: unknown): MeetingPanelSummaryHandwritingSections | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const textItems = (raw: unknown): PreparedHandwritingItem[] => Array.isArray(raw)
    ? raw.flatMap((item) => preparedTextItem(item) || [])
    : [];
  const preItems = textItems(source.pre_meeting);
  const inItems = Array.isArray(source.in_meeting) ? source.in_meeting.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const prepared = preparedTextItem(item.text);
    if (!prepared) return [];
    const originalRelativeTime = typeof item.relative_time === 'string' ? item.relative_time.trim() : '';
    return [{
      ...prepared,
      relative_time: originalRelativeTime.slice(0, 24),
      truncated: prepared.truncated || originalRelativeTime.length > 24,
    }];
  }) : [];
  const postItems = textItems(source.post_meeting);
  const allItems = [preItems, inItems, postItems];
  if (!allItems.some((items) => items.length)) return undefined;

  const itemAllocation = fairHandwritingAllocation(
    allItems.map((items) => items.length),
    HANDWRITING_TOTAL_ITEMS,
    [16, 48, 16],
  );
  const selectedItems = allItems.map((items, index) => items.slice(0, itemAllocation[index]));
  const charAllocation = fairHandwritingAllocation(
    selectedItems.map((items) => items.reduce((sum, item) => sum + item.text.length, 0)),
    HANDWRITING_TOTAL_CHARS,
    [1_600, 4_800, 1_600],
  );
  const omitted: Partial<Record<HandwritingSectionKey, number>> = {};
  const sectionKeys: HandwritingSectionKey[] = ['pre_meeting', 'in_meeting', 'post_meeting'];
  const emitted = selectedItems.map((items, sectionIndex) => {
    let remaining = charAllocation[sectionIndex] || 0;
    let omittedCount = allItems[sectionIndex].length - items.length;
    const output = items.flatMap((item) => {
      if (remaining <= 0) {
        omittedCount += 1;
        return [];
      }
      const text = item.text.slice(0, remaining);
      remaining -= text.length;
      if (item.truncated || text.length < item.text.length) omittedCount += 1;
      return text ? [{ ...item, text }] : [];
    });
    if (omittedCount > 0) omitted[sectionKeys[sectionIndex]] = omittedCount;
    return output;
  });
  const preMeeting = emitted[0].map((item) => item.text);
  const inMeeting = emitted[1].map((item) => ({ relative_time: item.relative_time || '', text: item.text }));
  const postMeeting = emitted[2].map((item) => item.text);
  if (!preMeeting.length && !inMeeting.length && !postMeeting.length) return undefined;
  return {
    pre_meeting: preMeeting,
    in_meeting: inMeeting,
    post_meeting: postMeeting,
    ...(Object.keys(omitted).length ? { omitted_count: omitted } : {}),
  };
}


function extractJsonArray(text: string): any[] {
  if (!text) return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * 逐块精修（中间路线）：几何切好的块交模型清断词/纠类型/修阅读顺序，
 * **同一批 id 各用一次、不许合并拆分** —— 这样每块仍认得原页 bbox（前端按 id 贴回）。
 */
export async function runReflow(payload: any): Promise<any[]> {
  const blocks: any[] = payload?.blocks || [];
  if (!blocks.length) return [];
  const img = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : undefined;
  const list = blocks.map((b, i) => `${i + 1}. [${b.type}] (${b.id}) ${b.text}`).join('\n');
  const system = SYSTEM_PROMPTS.reflow_refine;
  const rules =
    `输出一个 JSON 数组，每个元素 {"id":"…","type":"heading"|"para","level":1到3,"text":"…"}：\n` +
    `- 必须把每个 id 各用一次，不许合并、拆分、新增或丢弃；\n` +
    `- 按真实阅读顺序排列（多栏要对）；type/level 重新判定（para 的 level 给 0）；text 清掉断词与多余空格。\n` +
    `只输出该 JSON 数组，别的都不要。`;
  const user = img
    ? `这是该页的图，以及按几何切好的文本块（序号、粗类型、id、文字）：\n${list}\n\n看着图判断真实版面，${rules}`
    : `下面是按几何切好的文本块（序号、粗类型、id、文字）：\n${list}\n\n${rules}`;
  const raw = await gateway(system, user, 2500, img, payload?.model || REFLOW_MODEL);
  const refined = extractJsonArray(raw);
  // 校验：只保留出现过的 id；模型漏掉的块前端会按原样补回
  const ids = new Set(blocks.map((b) => b.id));
  return refined.filter((r) => r && ids.has(r.id)).map((r) => ({
    id: r.id,
    type: r.type === 'heading' ? 'heading' : 'para',
    level: typeof r.level === 'number' ? r.level : 0,
    text: String(r.text || '').trim(),
  }));
}

/** 默认重排模型：结构分类任务、对延迟敏感、质量要求低 → 用快模型。dev 面板/payload 可覆盖。 */
const REFLOW_MODEL = 'gemini-3.1-flash-lite';

/**
 * 重排提示词（流式/非流式共用）。输出改为 **NDJSON**——一行一个语义块对象，
 * 便于服务端边收边解析、客户端按段流式渲染（治"等整页排完才显示"的延迟）。
 */
function buildReflowAiPrompt(lines: any[]): { system: string; user: string } {
  const list = lines.map((l) => `${l.id}\t[${l.sizeRatio ?? 1}x] ${String(l.text || '').slice(0, 200)}`).join('\n');
  const system = SYSTEM_PROMPTS.reflow_structure;
  const rules =
    `逐行输出 NDJSON——**一行一个独立 JSON 对象**，每行就是一个语义块，按阅读顺序排：\n` +
    `{"type":"heading"|"para"|"list","level":1到3(仅heading需要),"lineIds":["ln_x",...]}\n` +
    `- 每个行 id 必须恰好出现一次，不丢、不重、不新增；\n` +
    `- 不要改写、翻译或新增任何文字——你只做分组与分类；\n` +
    `- 一行一个 JSON 对象，**不要包成数组、不要加 \`\`\` 代码块、不要任何额外解释或编号**。`;
  return { system, user: `${list}\n\n${rules}` };
}

/** 把模型吐的一行解析成合法分组（校验 lineIds 都在本页行内）；非分组行返回 null。 */
function parseGroupLine(line: string, valid: Set<unknown>): { type: string; level: number; lineIds: string[] } | null {
  if (!line || line[0] !== '{') return null; // 代码块/数组/空行/解释文字一律跳过
  let g: any;
  try { g = JSON.parse(line); } catch { return null; }
  if (!g || !Array.isArray(g.lineIds)) return null;
  const lineIds = g.lineIds.filter((id: unknown) => valid.has(id));
  if (!lineIds.length) return null;
  return { type: g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para', level: typeof g.level === 'number' ? g.level : 1, lineIds };
}

/**
 * AI 结构重建（非流式）：给"行"（id+相对字号+文字）让模型分组成 标题/段落/列表。
 * 模型只输出分组 lineIds、不改写文字——前端按 lineIds 把文字与原页 bbox 拼回（重排块可追溯）。
 * 关键治"多段并一块"：标题靠字号+独立成行，连续正文按语义切多段，绝不因行距均匀而合并。
 * 用于预热下一页 + 流式失败兜底；实时主路径走 reflowAiStream（SSE 按段流式）。
 */
export async function runReflowAi(payload: any): Promise<any[]> {
  const lines: any[] = payload?.lines || [];
  if (lines.length < 2) return [];
  const { system, user } = buildReflowAiPrompt(lines);
  const model = payload?.model || REFLOW_MODEL;
  const raw = await gateway(system, user, model.startsWith('gemini') ? 4096 : 3500, undefined, model);
  const valid = new Set(lines.map((l) => l.id));
  // 优先按 NDJSON 逐行解析
  const groups = raw.split('\n').map((ln) => parseGroupLine(ln.trim(), valid)).filter(Boolean) as any[];
  if (groups.length) return groups;
  // 兜底：模型仍输出了 JSON 数组（旧习惯）
  return extractJsonArray(raw)
    .filter((g) => g && Array.isArray(g.lineIds))
    .map((g) => ({ type: g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para', level: typeof g.level === 'number' ? g.level : 1, lineIds: g.lineIds.filter((id: unknown) => valid.has(id)) }))
    .filter((g) => g.lineIds.length);
}

/**
 * AI 结构重建（流式）：边收模型 NDJSON 边 yield 分组。供 /api/reflow-ai-stream
 * 一段段写回浏览器，让重排"按段冒出来"而非整页排完才显示。网关不支持流式时
 * gatewayTextStream 会退化为一次性返回——本生成器照常逐组 yield（只是不增量）。
 */
export async function* reflowAiStream(payload: any): AsyncGenerator<{ type: string; level: number; lineIds: string[] }> {
  const lines: any[] = payload?.lines || [];
  if (lines.length < 2) return;
  const { system, user } = buildReflowAiPrompt(lines);
  const model = payload?.model || REFLOW_MODEL;
  const valid = new Set(lines.map((l) => l.id));
  let buf = '';
  let full = '';
  let yielded = 0;
  for await (const delta of gatewayTextStream({ system, messages: [{ role: 'user', content: user }], maxTokens: model.startsWith('gemini') ? 4096 : 3500, model })) {
    buf += delta; full += delta;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const g = parseGroupLine(buf.slice(0, nl).trim(), valid);
      buf = buf.slice(nl + 1);
      if (g) { yielded++; yield g; }
    }
  }
  const tail = parseGroupLine(buf.trim(), valid); // 最后一行可能无换行
  if (tail) { yielded++; yield tail; }
  if (yielded === 0) {
    // 模型没按 NDJSON（输出了数组/代码块）→ 整体兜底解析，逐组补出
    for (const g of extractJsonArray(full)) {
      if (g && Array.isArray(g.lineIds)) {
        const lineIds = g.lineIds.filter((id: unknown) => valid.has(id));
        if (lineIds.length) yield { type: g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para', level: typeof g.level === 'number' ? g.level : 1, lineIds };
      }
    }
  }
}

/**
 * 局部截图 OCR：读一张从 PDF 裁出的标注区域图，原样转写其中文字（含手写）。
 * 只转写、不解释、不翻译——转写文字回前端填 OCRResult.text_blocks，喂推理 + 装 source_refs。
 */
export async function runOcrVlm(payload: any): Promise<{ text: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { text: '' };
  const isPage = payload?.scope === 'page';
  const bbox = Array.isArray(payload?.bbox) ? payload.bbox.map((n: any) => Number(n)) : null;
  // scope 分支（整页只转写框内 / 局部转写全图）按需追加在注册表 system 后
  const system = SYSTEM_PROMPTS.ocr + (isPage
    ? '\n<input>输入是一整页 PDF 截图，以及用户标注框在页面上的大致位置。只转写标注框那块区域内的文字。</input>'
    : '\n<input>输入是一张从 PDF 页面裁出的局部截图。转写图中的文字。</input>');
  let user = '转写这张截图里的文字：';
  if (isPage && bbox) {
    const [x, y, w, h] = bbox;
    const pct = (v: number) => Math.round(v * 100);
    user = `用户标注框大约在页面横向 ${pct(x)}%–${pct(x + w)}%、纵向 ${pct(y)}%–${pct(y + h)}%（左上角为原点）。转写该区域内的文字：`;
  }
  const text = await gateway(system, user, isPage ? 700 : 500, image, payload?.model); // 局部 OCR 随 inferModel 走（kimi/gemini A/B）
  return { text: text.trim() };
}

/**
 * 整页白板 OCR：一页只调一次 VLM，整页供上下文，regions 保留 mark 级时间锚。
 * 返回原始模型文本，码块/多余文字的防御解析统一留给 server/board-ocr.ts。
 */
export async function runBoardOcrVlm(payload: any): Promise<string> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  const regions = Array.isArray(payload?.regions) ? payload.regions : [];
  if (!image || !regions.length) return '{}';
  const langHint = typeof payload?.lang_hint === 'string' && payload.lang_hint.trim()
    ? `\n语言提示：${payload.lang_hint.trim().slice(0, 64)}`
    : '';
  const user = `按下列区域转写手写，bbox=[x,y,w,h]且已归一化到 0–1：\n${JSON.stringify(regions)}${langHint}`;
  return gateway(
    SYSTEM_PROMPTS.board_ocr,
    user,
    Math.min(2400, Math.max(600, regions.length * 100)),
    [{ role: 'board', data: `data:image/jpeg;base64,${image}` }],
    payload?.model,
  );
}

/**
 * 图像解读：看一张从原页裁出的图，结合「图附近正文 + 前页总结」说清它在讲什么。
 * 重排时图不丢，旁附这一句 AI 注解。（未来上下文可扩到相邻页。）
 */
export async function runExplainImage(payload: any): Promise<{ text: string }> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return { text: '' };
  const nearby = String(payload?.nearby || '').slice(0, 800);
  const prev = String(payload?.prevSummary || '').slice(0, 200);
  const system = SYSTEM_PROMPTS.image_explain;
  const ctx = [prev ? `前页梗概：${prev}` : '', nearby ? `图附近的正文：${nearby}` : ''].filter(Boolean).join('\n');
  const user = `${ctx ? ctx + '\n\n' : ''}看这张图，给读者一句解读：`;
  const text = await gateway(system, user, 300, image, payload?.model);
  return { text: text.trim() };
}

/**
 * VLM 重写重排：让模型看一张整页 PDF 截图，按真实阅读顺序产出语义块（标题/段/列表）。
 * 治网页截图、扭曲页、字号统一的 OCR 嵌字 PDF —— 这些把纯几何 reflowLocal 打爆的情况。
 * 严格转写、不改写原文（PRD 红线）；返回数组里每块带模型估计的归一化 bbox（便于反查）。
 */
export async function runReflowVlm(payload: any): Promise<any[]> {
  const image = payload?.image ? String(payload.image).replace(/^data:image\/[a-z]+;base64,/, '') : '';
  if (!image) return [];
  const system = SYSTEM_PROMPTS.reflow_vlm;
  const raw = await gateway(system, '看这张页面图，按上面格式重排：', 3000, image, payload?.model || REFLOW_MODEL);
  const arr = extractJsonArray(raw);
  return arr.filter((b) => b && (b.type === 'heading' || b.type === 'para' || b.type === 'list')).map((b) => ({
    type: b.type,
    level: typeof b.level === 'number' ? b.level : 0,
    text: typeof b.text === 'string' ? b.text.trim() : '',
    items: Array.isArray(b.items) ? b.items.map((x: unknown) => String(x).trim()).filter(Boolean) : undefined,
    ordered: typeof b.ordered === 'boolean' ? b.ordered : undefined,
    bbox: Array.isArray(b.bbox) && b.bbox.length === 4 ? b.bbox.map((n: any) => Number(n) || 0) : [0, 0, 1, 0.05],
  }));
}

/**
 * 网页对话式聊天（流式·P2 替代退役的 Agent SDK 会话）。
 * 无状态端点：会话状态（每本书 buffer）由客户端持有、整串 messages 传入——正是 ChatGPT/Claude 网页对话的形态。
 * 逐段 yield 文字增量；客户端 append + 可解析锚点结构化输出（锚点落位 P3/P4 接）。
 */
export async function* chatStream(payload: any): AsyncGenerator<string> {
  const messages: any[] = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.length) return;
  const role = (String(payload?.role || 'annotator')) as PromptRole;
  const system = SYSTEM_PROMPTS[role] ?? SYSTEM_PROMPTS.annotator;
  const model = payload?.model || cfg().model;
  const maxTokens = typeof payload?.maxTokens === 'number' ? payload.maxTokens : 800;
  // thinking 默认开（保持 annotator 伴读行为不变）；调用方可显式 thinking:false 关掉（如概念抽取这类轻分类·省 token/不抬 maxTokens）。
  const thinking = payload?.thinking !== false;
  // NDJSON 帧：每行 {"k":"t"|"r","d":"<增量>"}——t=回复正文、r=思考过程（reasoning）。客户端 chatTurn 分流。
  for await (const e of gatewayEventStream({ system, messages, maxTokens, model, thinking })) {
    yield JSON.stringify({ k: e.type === 'thinking' ? 'r' : 't', d: e.delta }) + '\n';
  }
}
