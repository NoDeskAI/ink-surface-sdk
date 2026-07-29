import { z } from 'zod';
import type { EvidenceSnapshot } from './contracts';
import type { JsonGenerator } from './brief-v2';

export const INTERVIEW_ARCHIVE_PROMPT_VERSION = 'interview_archive_html_v3';

const itemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(8_000),
  signal: z.enum(['positive', 'negative', 'uncertain', 'neutral']).default('neutral'),
  evidence_type: z.enum(['direct_statement', 'observed_behavior', 'researcher_judgment', 'product_hypothesis', 'uncertainty']).default('researcher_judgment'),
  object_scope: z.string().trim().max(160).default('未标注'),
  opportunity_level: z.enum(['expressed_need', 'behavior_supported_hypothesis', 'researcher_idea', 'not_applicable']).default('not_applicable'),
  evidence_refs: z.array(z.string().min(1).max(256)).max(32).default([]),
}).strict();
const quoteSchema = z.object({ quote: z.string().trim().min(1).max(2_000), speaker: z.string().trim().max(160).default(''), time: z.string().trim().max(80).default(''), evidence_refs: z.array(z.string().min(1).max(256)).min(1).max(8) }).strict();
const evidenceSchema = z.object({ conclusion: z.string().trim().min(1).max(2_000), strength: z.enum(['高', '中高', '中', '中低', '低']), basis: z.string().trim().min(1).max(4_000), evidence_refs: z.array(z.string().min(1).max(256)).min(1).max(16) }).strict();
const archiveSchema = z.object({
  title: z.string().trim().min(1).max(300), interview_date: z.string().trim().max(80).default(''), interviewee: z.string().trim().max(160).default('未识别受访者'),
  instant_findings: z.array(itemSchema).min(5).max(8), profile: z.array(itemSchema).max(12).default([]), meeting_minutes: z.array(itemSchema).max(20).default([]), product_implications: z.array(itemSchema).max(12).default([]),
  evidence_strength: z.array(evidenceSchema).max(16).default([]), quotes: z.array(quoteSchema).min(4).max(8), fact_gaps: z.array(itemSchema).max(12).default([]), product_hypotheses: z.array(itemSchema).max(12).default([]), next_actions: z.array(itemSchema).max(12).default([]), archive_notes: z.array(itemSchema).min(1).max(8),
}).strict();

const SYSTEM = `你是严谨的用户研究归档分析师。输出一个 JSON 对象，不输出 Markdown 或 HTML。唯一事实依据是 InkLoop 自有正式转写和板书/手写证据；用户主动补充的研究者见解只用于分析框架和优先级。不得使用、假设或评价 Gemini、Zoom、飞书等第三方自动纪要。严格区分受访者事实、研究者判断、产品假设；研究者见解没有自有证据支持时必须标明判断或存疑。不要把研究者提出的功能写成受访者需求，不把称赞写成需求验证、购买意愿或市场普遍性。重视不保存、不导出、不拍照、不复用、不整理、不愿改变流程、现有平台已满足、问题从未发生、诱导后才设想等负向证据。单一样本不可外推。
输出语言是简体中文。无论输入转写使用什么语言，title 以及除 quotes 之外的所有分析字段都必须使用简体中文；英文姓名、产品名和必要术语可以保留。quotes.quote 必须保留受访者原始语言，不翻译、不改写。不得因为输入是英文而把分析正文输出为英文。
JSON 字段固定为 title, interview_date, interviewee, instant_findings, profile, meeting_minutes, product_implications, evidence_strength, quotes, fact_gaps, product_hypotheses, next_actions, archive_notes。interviewee 必须是姓名字符串。instant_findings/profile/meeting_minutes/product_implications/fact_gaps/product_hypotheses/next_actions/archive_notes 必须全部是 JSON 数组，数组元素严格为 {"title":"...","body":"...","signal":"positive|negative|uncertain|neutral","evidence_type":"direct_statement|observed_behavior|researcher_judgment|product_hypothesis|uncertainty","object_scope":"实体白板|数字白板|课程平台|录像|设备|采购|学生|其他具体对象|对象不明确","opportunity_level":"expressed_need|behavior_supported_hypothesis|researcher_idea|not_applicable","evidence_refs":["utterance-id"]}，不得把 profile 等输出成对象。evidence_strength 必须是数组，元素为 {"conclusion":"...","strength":"高|中高|中|中低|低","basis":"...","evidence_refs":["utterance-id"]}。quotes 必须是数组，元素为 {"quote":"...","speaker":"...","time":"...","evidence_refs":["utterance-id"]}。
instant_findings 必须5-8条，按汇报价值排序，每条包含真实行为、流程或例子、重要性、产品含义、信号方向、证据强度和推断边界。profile 只覆盖本次真实谈到且与研究主题相关的职业机构、科目、学生、授课形式、特殊学习需求和关系。
meeting_minutes 必须先按逐字稿还原真实对话脉络，再动态生成适量小节；分析清单只是找线索的视角，不是固定目录。只有真实谈到且有信息价值的主题才建立小节，不补齐课前/课中/课后/采购等未覆盖环节，不把零散一句扩写成完整故事。每个小节尽量写清背景、具体动作、作用对象、工具或材料、事件顺序、实际结果、选择原因、例子、数字、频率和差异；短答或拒绝展开必须保持原有信息密度。产品判断不得混入 meeting_minutes。meeting_minutes 的每个小节必须引用覆盖该小节事实和例子的 evidence refs。
quotes 保留4-8句原语言，选择能直接证明 meeting_minutes 中重要行为、需求、态度或限制的原话；不得选择寒暄。quotes 不独立成章，渲染器会按 evidence refs 自动放入最相关的 meeting_minutes 小节。若转写词语不确定，quote 中标注“[转写存疑]”，不得擅自纠正。
product_implications 分清强证据机会、待验证机会、不支持方向、进入条件和研究者假设。fact_gaps 与 product_hypotheses 分开。next_actions 必须具体。archive_notes 明确单一样本边界和三类内容。所有事实条目引用输入 evidence ref；纯研究者假设可以引用相关证据并明确边界。`;

const EVIDENCE_DISCIPLINE = `生成前必须执行以下事实审计：
1. 对象绑定：每个行为必须确认作用对象是实体白板、数字白板、课程平台、录像、设备还是其他对象。提问说“board”但回答出现 screen、slide、tab、session 等线索时，不得自动归为实体白板；无法确定时 object_scope 写“对象不明确”，正文明确存疑。
2. 量词保真：usually 不得升级为“总是/从不”，might/think/believe 不得升级为确定事实，单次行为不得升级为稳定习惯。受访者后续自我修正或降级时，以最终口径为准并保留不确定性。
3. 强断言门槛：“刚需、必须、无法、完全、所有、无意愿、禁止、绝不会”等词，只有受访者直接明确陈述且引用支持时才能使用。
4. 来源分层：只允许 direct_statement（受访者直接陈述）、observed_behavior（InkLoop自有画面/板书可见行为）、researcher_judgment、product_hypothesis、uncertainty。不得把问卷、其他访谈、研究者记忆或第三方摘要混入本场事实；输入未提供就不得引用。
5. 机会分级：expressed_need 仅用于受访者主动表达的问题或需求；behavior_supported_hypothesis 用于行为支持但未主动提出的机会；researcher_idea 用于更弱的研究者设想。现有功能被使用、被称赞或表现良好，不等于对新产品有需求。
6. 名称保真：转写不稳定的品牌、人名、平台名不得强行纠正，必须标为存疑。
7. 完整纪要按实际流程展开具体小节，写清“动作→对象→结果”；不要为了简短把不同工具或不同阶段合并成一句。
8. 产品机会优先写改变方向的负向证据和进入条件；低价值、偏离研究主题的伪机会应省略。`;

const AUDIT_SYSTEM = `你是用户研究事实审校员。输入包含原始证据和一份待审校 JSON。只输出修订后的完整 JSON，不输出解释、Markdown 或 HTML，字段结构必须与输入 JSON 完全一致。
逐条检查并修正：
1. 行为对象：实体白板、数字白板、screen、slide、tab、session、课程平台、录像不得混淆；无法确定时 evidence_type 改为 uncertainty、object_scope 改为“对象不明确”，正文明确对象未确认。特别是：访谈者问“board”，受访者随后用 screen/slide/session 描述擦除、关闭后次日仍保留时，这组证据不能标成实体白板；除非受访者在同一回答中再次明确说 physical whiteboard，否则必须降级为对象不明确。
2. 量词与自我修正：保留 usually/might/think/believe/never tried 等不确定性；受访者后续修正优先。没有尝试不等于无意愿，认为平台可能限制不等于平台禁止。
3. 强断言：删除没有直接证据支持的“刚需、必须、无法、完全、所有、无意愿、禁止、极少、低频”等升级表述。
4. 机会边界：使用或称赞现有功能不等于对新产品有需求；没有主动需求时不得标 expressed_need。
5. 来源边界：删除原始证据中不存在的问卷、其他受访者、第三方纪要、研究者记忆和现场观察。输入只有转写、没有板书/手写证据时，任何条目都不得标 observed_behavior。
6. 名称边界：品牌或专名转写不稳定时标记存疑，不强行纠正。
保留有证据的细节、八章节内容、动态完整会议纪要和全部有效 evidence_refs；quotes 必须保留并就地支持会议纪要，不要为了审校把报告缩成摘要。除 quotes.quote 保留原语言外，输出简体中文。`;

function evidence(snapshot: EvidenceSnapshot): string {
  const guidance = snapshot.user_guidance;
  const researcher = [`当场结论：${guidance.conclusions.join('；') || '无'}`, `最深感受：${guidance.deepest_impressions.join('；') || '无'}`, `关注痛点：${guidance.pain_points.join('；') || '无'}`].join('\n');
  const transcript = snapshot.utterances.map((row) => `[${row.id} ${Math.floor(row.start_ms / 60000)}:${String(Math.floor(row.start_ms / 1000) % 60).padStart(2, '0')} ${row.speaker_name || row.speaker_id || '未知发言人'}] ${row.text}`).join('\n');
  const handwriting = snapshot.handwriting.map((row) => `[${row.id} handwriting ${row.kind}] ${row.text}`).join('\n');
  return `研究者即时见解（不是受访者事实）：\n${researcher}\n\n完整会议证据：\n${transcript}\n${handwriting}`;
}

function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
function slug(value: string): string { return value.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 80) || '未识别受访者'; }
function readableBody(value: string): string {
  return value.replace(/\s*(?:evidence_refs?|证据索引)\s*[:：]\s*\[[^\]]*\]\s*\.?/giu, '').trim();
}
const evidenceLabels = { direct_statement: '受访者陈述', observed_behavior: '现场行为', researcher_judgment: '研究者判断', product_hypothesis: '产品假设', uncertainty: '存疑' } as const;
const opportunityLabels = { expressed_need: '主动需求', behavior_supported_hypothesis: '行为支持假设', researcher_idea: '研究者设想', not_applicable: '' } as const;
function cards(items: z.infer<typeof itemSchema>[]): string {
  return items.map((item) => {
    const badges = [
      `<span>${esc(evidenceLabels[item.evidence_type])}</span>`,
      item.object_scope !== '未标注' ? `<span>${esc(item.object_scope)}</span>` : '',
      opportunityLabels[item.opportunity_level] ? `<span>${esc(opportunityLabels[item.opportunity_level])}</span>` : '',
    ].filter(Boolean).join('');
    return `<article class="card ${item.signal}"><div class="badges">${badges}</div><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p></article>`;
  }).join('');
}
function section(id: string, title: string, body: string): string { return `<section id="${id}"><h2>${title}</h2>${body || '<p class="muted">本次访谈未覆盖。</p>'}</section>`; }

export async function generateInterviewArchiveHtml(input: { title: string; snapshot: EvidenceSnapshot; generate: JsonGenerator; skipAudit?: boolean; template_prompt?: string }): Promise<{ filename: string; html: string; generated_at: string }> {
  const sourceEvidence = evidence(input.snapshot);
  const templatePrompt = input.template_prompt?.trim();
  let raw = await input.generate({ system: `${SYSTEM}\n${EVIDENCE_DISCIPLINE}${templatePrompt ? `\n\n当前用户调试模板（必须遵守，若与事实边界冲突则事实边界优先）：\n${templatePrompt}` : ''}`, user: `访谈标题：${input.title}\n${sourceEvidence}`, max_tokens: 24_000 });
  if (!input.skipAudit && input.snapshot.utterances.length >= 20) {
    const visualEvidence = input.snapshot.handwriting.length ? '本次包含 InkLoop 板书/手写证据，可以在有对应引用时使用 observed_behavior。' : '本次只有转写，没有 InkLoop 视觉、板书或手写证据，禁止使用 observed_behavior。';
    raw = await input.generate({ system: AUDIT_SYSTEM, user: `${visualEvidence}\n\n原始证据：\n${sourceEvidence}\n\n待审校 JSON：\n${JSON.stringify(raw)}`, max_tokens: 24_000 });
  }
  const normalized = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : raw;
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>;
    if (record.interviewee && typeof record.interviewee === 'object' && !Array.isArray(record.interviewee)) {
      const person = record.interviewee as Record<string, unknown>;
      record.interviewee = [person.name, person.full_name, person.display_name].find((value) => typeof value === 'string' && value.trim()) || '未识别受访者';
    }
    const itemFields = ['instant_findings', 'profile', 'meeting_minutes', 'product_implications', 'auto_summary_corrections', 'fact_gaps', 'product_hypotheses', 'next_actions', 'archive_notes'];
    for (const field of itemFields) if (Array.isArray(record[field])) record[field] = (record[field] as unknown[]).map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const item = value as Record<string, unknown>;
      const additions = [
        ['为什么重要', item.importance], ['产品含义', item.product_implication ?? item.product_implications],
        ['证据强度', item.evidence_strength], ['推断边界', item.inference_boundary],
      ].flatMap(([label, content]) => typeof content === 'string' && content.trim() ? [`${label}：${content.trim()}`] : []);
      return { title: item.title, body: [typeof item.body === 'string' ? item.body.trim() : '', ...additions].filter(Boolean).join('\n'), signal: item.signal, evidence_type: item.evidence_type, object_scope: item.object_scope, opportunity_level: item.opportunity_level, evidence_refs: item.evidence_refs };
    });
  }
  const result = archiveSchema.parse(normalized);
  for (const field of ['instant_findings', 'profile', 'meeting_minutes', 'product_implications', 'fact_gaps', 'product_hypotheses', 'next_actions', 'archive_notes'] as const) {
    for (const item of result[field]) item.body = readableBody(item.body);
  }
  const localizedAnalysis = [
    result.title,
    ...result.instant_findings.flatMap((item) => [item.title, item.body]),
    ...result.profile.flatMap((item) => [item.title, item.body]),
    ...result.meeting_minutes.flatMap((item) => [item.title, item.body]),
    ...result.product_implications.flatMap((item) => [item.title, item.body]),
    ...result.evidence_strength.flatMap((item) => [item.conclusion, item.basis]),
    ...result.fact_gaps.flatMap((item) => [item.title, item.body]),
    ...result.product_hypotheses.flatMap((item) => [item.title, item.body]),
    ...result.next_actions.flatMap((item) => [item.title, item.body]),
    ...result.archive_notes.flatMap((item) => [item.title, item.body]),
  ];
  const localizedText = localizedAnalysis.join('\n');
  const chineseCharacters = localizedText.match(/[\u3400-\u9fff]/gu)?.length || 0;
  if (localizedText.length >= 500 && chineseCharacters < 50) throw new Error('interview_archive_analysis_language_invalid');
  // Meeting time is trusted capture metadata, not a model inference. Always
  // prefer it when present so a plausible-looking model date cannot leak into
  // the archive or filename.
  if (input.snapshot.started_at_ms !== null) {
    result.interview_date = new Date(input.snapshot.started_at_ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  } else if (!result.interview_date || /^(?:未提供|未记录|unknown)$/iu.test(result.interview_date)) {
    result.interview_date = '日期未记录';
  }
  const known = new Set([...input.snapshot.utterances.map((row) => row.id), ...input.snapshot.handwriting.map((row) => row.id)]);
  const refs = [...result.instant_findings, ...result.profile, ...result.meeting_minutes, ...result.product_implications, ...result.fact_gaps, ...result.product_hypotheses, ...result.next_actions, ...result.archive_notes, ...result.evidence_strength, ...result.quotes].flatMap((item) => item.evidence_refs);
  if (refs.some((ref) => !known.has(ref))) throw new Error('interview_archive_source_ref_invalid');
  const utteranceTimes = new Map(input.snapshot.utterances.map((row) => [row.id, row.start_ms]));
  for (const quote of result.quotes) {
    const startMs = quote.evidence_refs.map((ref) => utteranceTimes.get(ref)).find((value): value is number => value !== undefined);
    if (startMs !== undefined) quote.time = `${Math.floor(startMs / 60_000)}:${String(Math.floor(startMs / 1_000) % 60).padStart(2, '0')}`;
  }
  const nav = [['findings','研究者即时发现'],['profile','受访者画像'],['minutes','完整会议纪要'],['implications','产品机会或影响'],['evidence','证据强度'],['questions','待验证问题'],['actions','建议后续动作'],['archive','归档说明']];
  const rows = result.evidence_strength.map((row) => `<tr><td>${esc(row.conclusion)}</td><td><span class="strength">${row.strength}</span></td><td>${esc(row.basis)}</td></tr>`).join('');
  const unmatchedQuotes = new Set(result.quotes);
  const minuteCards = result.meeting_minutes.map((item) => {
    const itemRefs = new Set(item.evidence_refs);
    const related = result.quotes.filter((quote) => unmatchedQuotes.has(quote) && quote.evidence_refs.some((ref) => itemRefs.has(ref)));
    for (const quote of related) unmatchedQuotes.delete(quote);
    const quoteHtml = related.map((quote) => `<blockquote><p>“${esc(quote.quote)}”</p><footer>${esc(quote.speaker || '受访者')} · ${esc(quote.time || '时间未记录')}</footer></blockquote>`).join('');
    return `${cards([item])}${quoteHtml}`;
  }).join('');
  const remainingQuoteHtml = [...unmatchedQuotes].map((quote) => `<blockquote><p>“${esc(quote.quote)}”</p><footer>${esc(quote.speaker || '受访者')} · ${esc(quote.time || '时间未记录')}</footer></blockquote>`).join('');
  const minutes = `${minuteCards}${remainingQuoteHtml ? `<div class="orphan-quotes"><h3>补充原话</h3>${remainingQuoteHtml}</div>` : ''}`;
  const body = [section('findings','一、研究者即时发现（优先阅读）',cards(result.instant_findings)),section('profile','二、受访者画像',cards(result.profile)),section('minutes','三、完整会议纪要',minutes),section('implications','四、产品机会或对产品方向的影响',cards(result.product_implications)),section('evidence','五、证据强度判断',rows ? `<div class="table-wrap"><table><thead><tr><th>结论</th><th>证据强度</th><th>判断依据</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''),section('questions','六、待验证问题',`<h3>事实缺口</h3>${cards(result.fact_gaps)}<h3>产品假设</h3>${cards(result.product_hypotheses)}`),section('actions','七、建议的后续动作',cards(result.next_actions)),section('archive','八、归档说明',cards(result.archive_notes))].join('');
  const css = `*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f3efe5;color:#25231f;font:15px/1.75 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}aside{position:fixed;inset:0 auto 0 0;width:260px;background:#202522;color:#eee;padding:28px 22px;overflow:auto}aside strong{font-size:18px}nav a{display:block;color:#cfd7d0;text-decoration:none;padding:8px 0;border-bottom:1px solid #343c37}main{max-width:980px;margin-left:260px;padding:52px 60px 100px}header{padding-bottom:24px;border-bottom:2px solid #343b35}h1{font-size:34px;line-height:1.25;margin:0 0 12px}h2{font-size:24px;margin:56px 0 20px}h3{font-size:17px;margin:0 0 8px}.meta,.muted{color:#746f65}.card{background:#fffdf7;border:1px solid #ded8ca;border-left:5px solid #798278;border-radius:8px;padding:17px 20px;margin:12px 0}.card.negative{border-left-color:#a64b43}.card.positive{border-left-color:#398062}.card.uncertain{border-left-color:#b28137}.card p{margin:0;white-space:pre-line}.badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.badges span{background:#ece8dc;border:1px solid #d8d1c2;border-radius:999px;color:#5c574e;font-size:12px;line-height:1.4;padding:3px 8px}blockquote{margin:14px 0;padding:18px 22px;background:#e8eee9;border-left:5px solid #425d4d}blockquote p{margin:0}blockquote footer{margin-top:8px;color:#5e665f}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;background:#fffdf7}th,td{text-align:left;vertical-align:top;border:1px solid #d5cfc2;padding:12px}th{background:#e4e0d5}.strength{white-space:nowrap;font-weight:700}@media(max-width:800px){aside{position:relative;width:auto}main{margin:0;padding:28px 20px}nav{columns:2}h1{font-size:27px}}@media print{aside{display:none}main{margin:0;max-width:none;padding:0}body{background:#fff}.card,blockquote,table{break-inside:avoid}a{color:inherit}}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(result.title)}</title><style>${css}</style></head><body><aside><strong>访谈归档纪要</strong><p>${esc(result.interviewee)}</p><nav>${nav.map(([id,label]) => `<a href="#${id}">${label}</a>`).join('')}</nav></aside><main><header><h1>${esc(result.title)}</h1><div class="meta">访谈日期：${esc(result.interview_date || '未记录')}　受访者：${esc(result.interviewee)}</div></header>${body}</main></body></html>`;
  return { filename: `${slug(result.interview_date || '日期未记录')}，${slug(result.interviewee)}用户访谈_中文版归档纪要.html`, html, generated_at: new Date().toISOString() };
}
