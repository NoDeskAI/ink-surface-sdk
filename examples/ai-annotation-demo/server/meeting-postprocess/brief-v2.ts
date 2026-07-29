import type { EvidenceSnapshot, MeetingSummaryCardsV2, MeetingSummaryExtraction } from './contracts';
import { meetingSummaryCardsV2Schema, meetingSummaryExtractionSchema } from './contracts';
import { chunkUtterances, reduceExtractions } from './long-meeting';
import { sha256 } from './identity';
import { meetingTemplate } from './templates';

export type JsonGenerator = (input: {
  system: string;
  user: string;
  max_tokens: number;
  model?: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

export const MEETING_BRIEF_PROMPT_VERSION = 'meeting_brief_prompt_v2.7';
export const DEFAULT_MEETING_CHUNK_CHARS = 24_000;
const BRIEF_LIMITS = { key_points: 5, decisions: 5, action_items: 8, highlights: 3, risks: 5, open_questions: 5, personal_notes: 5 } as const;
const FIXED_TEMPLATE_SECTIONS: Partial<Record<EvidenceSnapshot['template_id'], Record<string, { title: string; max: number }>>> = {
  university_notes: {
    course_info: { title: '课程信息', max: 4 }, key_concepts: { title: '关键概念与定义', max: 6 }, lecture_points: { title: '主要讲座要点与提纲', max: 6 }, examples: { title: '示例与案例研究', max: 6 }, instructor_emphasis: { title: '讲师重点（重要！）', max: 6 }, questions_answers: { title: '提出的问题与回答', max: 6 }, personal_connections: { title: '个人反思与联系', max: 6 }, review_followup: { title: '需复习与跟进', max: 6 }, memory_aids: { title: '学习技巧与记忆辅助', max: 6 }, possible_exam_questions: { title: '可能的考试题目', max: 6 },
  },
  interactive_classroom: {
    chronological_review: { title: '课堂内容回顾', max: 12 }, definitions_formulas: { title: '定义、公式与示例', max: 8 }, interactions: { title: '课堂互动与反馈', max: 8 }, glossary: { title: '重要术语表', max: 12 }, review_questions: { title: '复习问题', max: 8 }, practice_followup: { title: '练习与延伸', max: 8 },
  },
  interview_memo: {
    interview_context: { title: '访谈背景', max: 4 }, question_records: { title: '按问题整理的访谈记录', max: 12 }, key_signals: { title: '关键数据与信号', max: 8 }, confirmed_items: { title: '确认事项', max: 8 }, pending_items: { title: '待确认事项', max: 8 }, next_actions: { title: '下一步行动', max: 8 },
  },
};
const SYSTEM = `你是 InkLoop 的多场景内容后处理器。所有模板共享同一事实边界：唯一会议事实来源是 InkLoop 自采 Mic/Remote 双轨经自有 Meeting Media 链路收敛的正式转写，以及 InkLoop 板书、手写和 OCR 证据；Google Meet、Zoom、Teams、飞书只承担会议承载或转播，它们的转写、智能纪要和摘要一律不作为输入。用户会后补充只用于分析方向和优先级，不自动成为会议事实。

当前场景模板是强约束，不是文风提示：必须按模板指定的信息角色、字段映射和标题语言进行筛选，不能把不同场景写成同一种通用会议纪要。只基于输入证据，不补充外部事实；一条事实只表达一次；提议、假设和未确认事项不能写成 confirmed decision；只有明确承诺才是 explicit action；owner 和 due_at 未明确时必须为 null；用户手写默认只进入 personal_notes，除非原始发言明确支持。每个重要条目必须引用给定 utterance ID；personal_notes 必须引用 mark ID。

说话人身份由系统自动分析，不要求用户确认。输入中的已知姓名可直接使用；低置信身份会以“远端发言人 A/B”等稳定匿名标签出现，不得根据声音、上下文或发言内容自行编造真实姓名。摘要默认省略匿名发言人标签，只有区分立场或明确责任归属确有必要时才原样引用该稳定标签。

只输出一个 JSON 对象，不输出 Markdown、代码围栏或解释。对象必须且只能包含以下字段：
{
  "theme": "string",
  "overview": "string",
  "section_titles": {"background":"贴合会议内容的背景模块标题，最多20字","discussion":"贴合核心议题的讨论模块标题，最多20字","next_steps":"贴合行动与提醒的后续模块标题，最多20字"},
  "key_points": [{"id":"string","text":"string","evidence_refs":["utterance-id"]}],
  "decisions": [{"id":"string","text":"string","status":"confirmed|tentative","evidence_refs":["utterance-id"]}],
  "action_items": [{"id":"string","task":"string","owner":"string|null","due_at":"string|null","commitment":"explicit|proposed","evidence_refs":["utterance-id"]}],
  "highlights": [{"id":"string","text":"string","evidence_refs":["utterance-id"]}],
  "risks": [{"id":"string","text":"string","mitigation":"string|null","evidence_refs":["utterance-id"]}],
  "open_questions": [{"id":"string","text":"string","evidence_refs":["utterance-id"]}],
  "personal_notes": [{"id":"string","text":"string","kind":"thought|question|todo|emphasis","mark_refs":["mark-id"],"supporting_utterance_refs":["utterance-id"]}]
  ,"template_sections": [{"id":"template规定的稳定section-id","title":"模板规定的板块标题","summary":"string|null","items":[{"id":"string","text":"string","label":"string|null","speaker":"string|null","evidence_refs":["utterance-id或mark-id"]}]}]
}
template_sections 是四个专属场景的最终展示契约：university_notes、interactive_classroom、reasoning_summary、interview_memo 必须严格按模板声明生成；meeting_expert 固定输出 []。不存在的可选板块直接省略，不输出空壳。除非场景模板明确声明 section_titles 不参与最终排版，否则三个 section_titles 必须简洁具体。没有证据的数组必须为 []，不得增加其他字段。`;

function userGuidanceText(snapshot: EvidenceSnapshot): string {
  const guidance = snapshot.user_guidance;
  const groups = [
    ['当场结论', guidance.conclusions],
    ['最深感受', guidance.deepest_impressions],
    ['关注痛点', guidance.pain_points],
  ].filter(([, items]) => (items as string[]).length);
  if (!groups.length) return '用户会后引导：无。';
  return `用户会后引导（source=user_supplied，不属于会议证据）：\n${groups.map(([label, items]) => `${label as string}：\n${(items as string[]).map((item) => `- ${item}`).join('\n')}`).join('\n')}\n这些内容只用于决定信息优先级和组织方向。未被转写或板书独立支持的内容不得进入 key_points、decisions、action_items、highlights、risks、open_questions 或 personal_notes，也不得借用无关 evidence ref；绝不能写成已确认会议事实。`;
}

function evidenceText(snapshot: EvidenceSnapshot, utteranceIds?: Set<string>): string {
  const utterances = snapshot.utterances.filter((x) => !utteranceIds || utteranceIds.has(x.id)).map((x) => `[utterance:${x.id} ${x.start_ms}-${x.end_ms} ${x.speaker_name || x.speaker_id || ''}] ${x.text}`);
  const handwriting = snapshot.handwriting.map((x) => `[handwriting:${x.id} marks=${x.mark_ids.join(',') || x.id}${x.corrected_by_user ? ' user-corrected' : ''}] ${x.text}`);
  return [...utterances, ...handwriting].join('\n');
}

function validateRefs(value: MeetingSummaryExtraction, snapshot: EvidenceSnapshot, allowedUtteranceIds?: Set<string>): MeetingSummaryExtraction {
  const utteranceIds = allowedUtteranceIds || new Set(snapshot.utterances.map((x) => x.id));
  const markIds = new Set(snapshot.handwriting.flatMap((x) => [x.id, ...x.mark_ids]));
  const evidenceLists = [value.key_points, value.decisions, value.action_items, value.highlights, value.risks, value.open_questions, ...value.template_sections.map((section) => section.items)];
  for (const list of evidenceLists) for (const item of list) for (const ref of item.evidence_refs) if (!utteranceIds.has(ref) && !markIds.has(ref)) throw new Error('meeting_card_source_ref_invalid');
  for (const note of value.personal_notes) {
    if (note.mark_refs.some((ref) => !markIds.has(ref)) || note.supporting_utterance_refs.some((ref) => !utteranceIds.has(ref))) throw new Error('meeting_card_source_ref_invalid');
  }
  return value;
}

function normalize(value: unknown, snapshot: EvidenceSnapshot, allowedUtteranceIds?: Set<string>): MeetingSummaryExtraction {
  const record: unknown = value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : value;
  if (record && typeof record === 'object' && !Array.isArray(record)) {
    const objectRecord = record as Record<string, unknown>;
    const actionItems = Array.isArray(objectRecord.action_items) ? objectRecord.action_items.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const { text, ...rest } = row;
      const task = typeof row.task === 'string' && row.task.trim() ? row.task : typeof text === 'string' && text.trim() ? text : undefined;
      const nullable = (candidate: unknown): unknown => typeof candidate === 'string' && /^(?:null|none|未指定|未提及)$/iu.test(candidate.trim()) ? null : candidate;
      return task ? [{ ...rest, owner: nullable(row.owner), due_at: nullable(row.due_at), task }] : [];
    }) : objectRecord.action_items;
    objectRecord.action_items = actionItems;
  }
  const parsed = meetingSummaryExtractionSchema.parse(record);
  const fixed = FIXED_TEMPLATE_SECTIONS[snapshot.template_id];
  if (snapshot.template_id === 'meeting_expert') parsed.template_sections = [];
  else if (fixed) parsed.template_sections = parsed.template_sections.flatMap((section) => {
    const policy = fixed[section.id];
    return policy ? [{ ...section, title: policy.title, items: section.items.slice(0, policy.max) }] : [];
  }).sort((a, b) => Object.keys(fixed).indexOf(a.id) - Object.keys(fixed).indexOf(b.id));
  return validateRefs(parsed, snapshot, allowedUtteranceIds);
}

function finalize(value: MeetingSummaryExtraction, snapshot: EvidenceSnapshot): MeetingSummaryCardsV2 {
  const ocrFailed = snapshot.missing_reasons.includes('ocr_failed');
  const ocrPartial = snapshot.missing_reasons.includes('ocr_pending');
  const utteranceStart = snapshot.utterances.length ? Math.min(...snapshot.utterances.map((item) => item.start_ms)) : null;
  const utteranceEnd = snapshot.utterances.length ? Math.max(...snapshot.utterances.map((item) => item.end_ms)) : null;
  const durationMs = snapshot.started_at_ms !== null && snapshot.ended_at_ms !== null
    ? Math.max(0, snapshot.ended_at_ms - snapshot.started_at_ms)
    : utteranceStart !== null && utteranceEnd !== null && utteranceEnd > utteranceStart ? utteranceEnd - utteranceStart : null;
  const participants = [...new Set(snapshot.utterances
    .map((item) => item.speaker_name || item.speaker_id)
    .filter((item): item is string => Boolean(item?.trim()) && !/^(?:(?:说话人|speaker)\s*\d+|本机发言人|远端发言人(?:\s+[A-F0-9]+)?|remote speaker(?:\s+[A-F0-9]+)?)$/iu.test(item!.trim())))];
  const compact = {
    ...value,
    key_points: value.key_points.slice(0, BRIEF_LIMITS.key_points),
    decisions: value.decisions.slice(0, BRIEF_LIMITS.decisions),
    action_items: value.action_items.slice(0, BRIEF_LIMITS.action_items),
    highlights: value.highlights.slice(0, BRIEF_LIMITS.highlights),
    risks: value.risks.slice(0, BRIEF_LIMITS.risks),
    open_questions: value.open_questions.slice(0, BRIEF_LIMITS.open_questions),
    personal_notes: value.personal_notes.slice(0, BRIEF_LIMITS.personal_notes),
    template_sections: value.template_sections.slice(0, 16).map((section) => ({ ...section, items: section.items.slice(0, 12) })),
  };
  return meetingSummaryCardsV2Schema.parse({
    ...compact,
    schema_version: '2.0',
    template_id: snapshot.template_id,
    template_version: snapshot.template_version,
    meeting_metadata: {
      started_at: snapshot.started_at_ms === null ? null : new Date(snapshot.started_at_ms).toISOString(),
      duration_ms: durationMs,
      participants,
    },
    artifact_state: snapshot.finality === 'final' ? 'final' : 'provisional',
    coverage: {
      utterances: snapshot.missing_reasons.some((reason) => reason === 'transcript_pending' || reason === 'transcript_partial') ? 'partial' : 'complete',
      handwriting_ocr: ocrFailed ? 'failed' : ocrPartial ? 'partial' : 'complete',
      started_at_ms: snapshot.started_at_ms,
      ended_at_ms: snapshot.ended_at_ms,
    },
  });
}

export type ProgressiveBriefItem = { section: keyof Pick<MeetingSummaryExtraction, 'key_points' | 'decisions' | 'action_items' | 'highlights' | 'risks' | 'open_questions' | 'personal_notes'>; item: MeetingSummaryExtraction[ProgressiveBriefItem['section']][number] };
const MAX_CHUNK_CONCURRENCY = 3;

function progressiveItems(value: MeetingSummaryExtraction): ProgressiveBriefItem[] {
  const sections: ProgressiveBriefItem['section'][] = ['key_points', 'decisions', 'action_items', 'highlights', 'risks', 'open_questions', 'personal_notes'];
  return sections.flatMap((section) => value[section].map((item) => ({ section, item }) as ProgressiveBriefItem));
}

export async function generateBriefV2(input: { title: string; snapshot: EvidenceSnapshot; generate: JsonGenerator; chunk_chars?: number; template_prompt?: string; getCached?: (key: string) => unknown; saveCached?: (key: string, value: unknown) => Promise<void>; onItem?: (item: ProgressiveBriefItem) => Promise<void>; onItems?: (items: ProgressiveBriefItem[]) => Promise<void> }): Promise<MeetingSummaryCardsV2> {
  const chunks = chunkUtterances(input.snapshot.utterances, input.chunk_chars || DEFAULT_MEETING_CHUNK_CHARS);
  const handwritingHash = sha256(input.snapshot.handwriting.map((x) => ({ id: x.id, revision: x.revision, text: x.text, corrected_by_user: x.corrected_by_user })));
  const guidanceHash = sha256(input.snapshot.user_guidance);
  const extract = async (utteranceIds?: Set<string>, chunkHash = 'single'): Promise<MeetingSummaryExtraction> => {
    const cacheKey = sha256({
      prompt_version: MEETING_BRIEF_PROMPT_VERSION,
      template_id: input.snapshot.template_id,
      template_version: input.snapshot.template_version,
      meeting_title: input.title,
      chunk_hash: chunkHash,
      handwriting_hash: handwritingHash,
      guidance_hash: guidanceHash,
    });
    let raw = chunks.length > 1 ? input.getCached?.(cacheKey) : undefined;
    if (!raw) {
      const template = meetingTemplate(input.snapshot.template_id);
      const prompt = input.template_prompt?.trim() || template.prompt;
      raw = await input.generate({ system: `${SYSTEM}\n\n当前场景模板（${template.label}，${template.version}）：${prompt}`, user: `会议标题：${input.title}\n${userGuidanceText(input.snapshot)}\n${chunks.length > 1 ? '这是完整会议的一个分块；只抽取本块可证明的候选，不假设缺失部分。每个数组最多保留 5 条最重要的候选。\n' : ''}证据：\n${evidenceText(input.snapshot, utteranceIds)}`, max_tokens: 24_000 });
    }
    const parsed = normalize(raw, input.snapshot, utteranceIds);
    if (chunks.length > 1) await input.saveCached?.(cacheKey, parsed);
    const items = progressiveItems(parsed);
    if (input.onItems) await input.onItems(items);
    else for (const item of items) await input.onItem?.(item);
    return parsed;
  };
  if (chunks.length <= 1) return finalize(await extract(), input.snapshot);
  const extractChunk = async (utteranceIds: string[], chunkHash: string): Promise<MeetingSummaryExtraction[]> => {
    try { return [await extract(new Set(utteranceIds), chunkHash)]; }
    catch (error) {
      if (utteranceIds.length <= 1) throw error;
      const middle = Math.ceil(utteranceIds.length / 2);
      const left = utteranceIds.slice(0, middle);
      const right = utteranceIds.slice(middle);
      return [
        ...await extractChunk(left, sha256({ parent: chunkHash, half: 'left', utterance_ids: left })),
        ...await extractChunk(right, sha256({ parent: chunkHash, half: 'right', utterance_ids: right })),
      ];
    }
  };
  const chunkParts: MeetingSummaryExtraction[][] = new Array(chunks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CHUNK_CONCURRENCY, chunks.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      chunkParts[index] = await extractChunk(chunk.utterances.map((x) => x.id), chunk.hash);
    }
  });
  await Promise.all(workers);
  const parts = chunkParts.flat();
  const deterministic = reduceExtractions(parts);
  let reduced = deterministic;
  try {
    reduced = normalize(await input.generate({
      system: `${SYSTEM}\n\n当前场景模板（${meetingTemplate(input.snapshot.template_id).label}，${input.snapshot.template_version}）：${input.template_prompt?.trim() || meetingTemplate(input.snapshot.template_id).prompt}`,
      user: `会议标题：${input.title}\n${userGuidanceText(input.snapshot)}\n以下是按完整会议各分块抽取的候选。请严格按当前场景模板做全局归并：去重、合并跨块事项、保留前后修正与不确定性，并核对负责人和截止时间；不得新增候选中不存在的 evidence ref。最终数组上限仅是安全边界：key_points/decisions/risks/open_questions 各最多 5 条，action_items 最多 8 条，highlights 最多 3 条；具体保留哪些内容、各字段如何表达必须服从模板。\n${JSON.stringify(deterministic)}`,
      max_tokens: 24_000,
    }), input.snapshot);
  } catch { /* 分块结果均已严格校验；全局模型失败时保留确定性去重结果。 */ }
  return finalize(reduced, input.snapshot);
}

export const meetingBriefV2SystemPrompt = SYSTEM;
