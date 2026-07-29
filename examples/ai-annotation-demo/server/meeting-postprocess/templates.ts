export const MEETING_TEMPLATE_IDS = [
  'university_notes',
  'interactive_classroom',
  'reasoning_summary',
  'interview_memo',
  'interview_archive',
  'meeting_expert',
] as const;

export type MeetingTemplateId = typeof MEETING_TEMPLATE_IDS[number];

export interface MeetingPostprocessTemplate {
  id: MeetingTemplateId;
  version: string;
  label: string;
  prompt: string;
}

export const DEFAULT_MEETING_TEMPLATE_ID: MeetingTemplateId = 'meeting_expert';

export const MEETING_POSTPROCESS_TEMPLATES: Record<MeetingTemplateId, MeetingPostprocessTemplate> = {
  university_notes: {
    id: 'university_notes',
    version: 'university_notes.v3',
    label: '大学课堂笔记',
    prompt: `严格生成“大学课堂笔记”，目标是把讲座整理为可复习的概念、实例、考试提示和练习题，不得套用会议纪要结构。
overview 用1-2句说明课程主题、学习目标和本次范围。template_sections 按下列顺序输出有证据的板块：
1. course_info / 课程信息：提取课程名称、讲师、日期、课程进度或主题；用 item.label 标识字段名。
2. key_concepts / 关键概念与定义：最多6项，列出定义、公式、定理或方法；不能补充教材外知识。
3. lecture_points / 主要讲座要点与提纲：最多6项，每项包含要点及必要解释。
4. examples / 示例与案例研究：最多6项，保留例子、应用情境和案例结论。
5. instructor_emphasis / 讲师重点（重要！）：仅记录讲师反复强调、明确说重要或与考试相关的内容。
6. questions_answers / 提出的问题与回答：item.label 写具体问题，text 写课堂给出的回答；未回答则明确标记。
7. personal_connections / 个人反思与联系：只使用用户手写的 thought/emphasis 或课堂中明确出现的联系，不代替用户编造反思。
8. review_followup / 需复习与跟进：只记录明确需要复习、阅读、练习或跟进的主题。
9. memory_aids / 学习技巧与记忆辅助：仅记录课堂实际给出的助记符、类比、记忆工具。
10. possible_exam_questions / 可能的考试题目：仅记录讲师明确暗示的考试题，或把已有课堂问题忠实改成自测题；不得编造新知识与答案。
不存在的板块省略。template_sections 是最终展示结构。兼容字段可同步提取，但 decisions 和 risks 通常为空；action_items 仅放明确布置的课后任务。section_titles 不参与最终排版。`,
  },
  interactive_classroom: {
    id: 'interactive_classroom',
    version: 'interactive_classroom.v3',
    label: '互动课堂',
    prompt: `严格生成“互动课堂”复习资料：它是按授课时间顺序组织、带术语表和复习问题的简明课堂脚本，不是通用会议纪要，也不只是师生互动复盘。
过滤笑话、轶事、迟到讨论、点名、设备调试和与主题无关的插曲；只保留与课程主题直接相关的内容。语言清晰、简洁、客观，优先短句和主动语态。
overview 概括课程目标、主题和进度。template_sections 按下列顺序输出有内容的板块：
1. chronological_review / 课堂内容回顾：严格按讲授时间顺序，用编号式要点整理主要内容。
2. definitions_formulas / 定义、公式与示例：保留关键定义、重要公式及课堂给出的简明示例。
3. interactions / 课堂互动与反馈：item.label 写具体问题，text 写学生有效回应及教师反馈、纠正或示范，不把问答拆散。
4. glossary / 重要术语表：item.label 写术语，text 写课堂语境中的定义；关键词本身必须完整保留。
5. review_questions / 复习问题：在摘要末尾列出，只能依据已讲内容生成可回答的复习题；不得引入外部知识。
6. practice_followup / 练习与延伸：只记录明确布置的练习、作业、分组任务和下次课准备。
不存在的板块省略。template_sections 是最终展示结构；section_titles 不参与最终排版。`,
  },
  reasoning_summary: {
    id: 'reasoning_summary',
    version: 'reasoning_summary.v3',
    label: '推理总结',
    prompt: `严格生成“推理总结”。该模板是 Autopilot：先在内部判断输入任务类型，再选择最合适的推理框架；不能对所有输入强制套用同一组固定标题。
可选择但不限于：问题求解（问题→条件→推导→结论→验证）、方案比较（目标→标准→选项→权衡→建议）、因果分析（现象→证据→原因→影响→验证）、决策分析（目标→约束→选择→依据→风险）、知识归纳（主题→核心命题→关系→结论）。混合内容可组合框架。
overview 用1-2句给出总结目标和最重要结论。template_sections 动态生成3-6个有信息价值的板块：id 使用稳定英文语义短名，title 必须贴合当前内容；按实际逻辑顺序排列。每个 item 只陈述证据支持的事实、推断、假设或结论，并用 label 明确标注“事实”“推断”“假设”“结论”“待验证”之一。事实、推断和假设严格分开；因果链不得补造中间事实；证据不足的结论标为待验证。最后仅在确有不确定性或验证动作时增加相应板块。
实时平衡效率与准确性：简单输入用最短充分结构，复杂输入才展开；不按发言顺序复述，不输出冗余空板块。template_sections 是最终展示结构；section_titles 不参与最终排版。`,
  },
  interview_memo: {
    id: 'interview_memo',
    version: 'interview_memo.v3',
    label: '访谈备忘录',
    prompt: `严格生成“访谈备忘录”，按具体访谈问题和发言人整理，保留详细信息，同时单独提取确认事项、待确认事项和下一步行动；不得套用通用会议纪要。
overview 写访谈对象、研究目标、情境与覆盖范围。template_sections 按下列顺序输出：
1. interview_context / 访谈背景：仅放必要背景，可用 summary。
2. question_records / 按问题整理的访谈记录：每个 item.label 必须是访谈中实际提出的具体问题，不能用宽泛议题代替；item.speaker 填回答者的输入姓名或稳定匿名标签；item.text 只写该发言人的回答。不同发言人的回答分成不同 item。数字、专有名词和具体例子不得省略。
3. key_signals / 关键数据与信号：只提取高辨识度原意表达、数字、专有名词、反常或矛盾信号。
4. confirmed_items / 确认事项：记录访谈中已明确确认的事实、需求或结论。
5. pending_items / 待确认事项：只记录原文明确表示未确定、缺少当前数据或尚未回答的事项，不自行发明延伸研究问题。
6. next_actions / 下一步行动：只记录访谈中真实约定的材料补充、回访或研究动作；模型建议的追问不得伪装成已约定行动。
不存在的可选板块省略，但 question_records 必须在有实质回答时输出。不得替受访者补充立场，也不要把个人观点写成普遍结论。template_sections 是最终展示结构；section_titles 不参与最终排版。兼容字段中 confirmed decision、tentative/open_questions、action_items 分别与上述三类保持一致。`,
  },
  interview_archive: {
    id: 'interview_archive',
    version: 'interview_archive.v3',
    label: '用户访谈归档纪要（完整版）',
    prompt: `生成完整的用户访谈中文版归档纪要，最终产物必须是单个自包含 HTML，不生成 Markdown。只使用 InkLoop 自有正式转写、板书/手写证据和用户主动补充的研究者见解；不得使用 Gemini、Zoom、飞书等第三方自动纪要。研究者即时见解置于最前，并作为主要分析框架；自有转写用于补充事实、行为、例子和时间点，同时主动发现研究者未提及的重要信号。严格区分受访者陈述、可见行为、研究者判断、产品假设和存疑内容；每条行为必须绑定实体白板、数字白板、课程平台、录像等具体对象，对象不明不得猜测。保留 usually/might 等量词和受访者最终修正口径，强断言必须有直接证据。产品机会分为主动需求、行为支持假设和研究者设想，重视负向证据，单一受访者不得外推。固定包含八章：研究者即时发现、受访者画像、完整会议纪要、产品机会或影响、证据强度、待验证问题、建议后续动作、归档说明。完整会议纪要必须按真实谈话动态分段，分析清单不是固定目录；保留事件顺序、具体例子、工具、数字、频率和时间点。受访者原话不再独立成章，必须嵌入其所证明的会议纪要小节。具体完整规范见归档 HTML 专用生成器。该模板不生成 summary_cards、Markdown summary 或 template_sections。`,
  },
  meeting_expert: {
    id: 'meeting_expert',
    version: 'meeting_expert.v3',
    label: '会议全面总结专家',
    prompt: `角色定位：你是会议纪要专家，职责是将会议记录转化为高密度、结构化、可执行的文档。核心原则是每一句输出都必须有信息价值，宁缺毋滥。

内部分析（不直接输出）：
1. 识别会议类型：决策型以结论和行动为导向；创意型以观点和共识为导向；混合型按议题灵活切换。
2. 锁定核心议题与会议最终要解决的问题。
3. 对信息价值排序，过滤口误、重复、背景噪音和无关闲聊。
4. 决定三层金字塔中哪些板块有实质内容；没有内容的板块必须省略。

第一层“核心信息”（必须输出）：
- theme：基于核心议题和结论生成精准会议标题，格式为“[类型] [主题]：[核心结论或目标]”。
- overview：一句话摘要，概括最核心结论或进展，不超过50字；必要背景可在前面补一句。
- decisions：结论与决策。明确决策标 confirmed；待进一步讨论标 tentative。每条必须写清结论及依据，责任人仅在原文明确时写入文本。创意型会议无明确决策时，改写为核心共识与方向。
- action_items：待办事项，只提取会议实际提及的任务；owner、due_at 未提及必须为 null；无明确待办则整个板块省略。

第二层“关键脉络”（视内容丰富度按需输出）：
- key_points：讨论脉络。按议题梳理，每条应包含该议题的核心观点及提出者、分歧与各方立场、最终走向或结论；重要发言使用输入中的真实姓名或稳定匿名标签；关键节点可带时间。每个议题2-5句，全部讨论脉络合计不超过500字。
- highlights：关键提取，只保留有价值的重要数据、新观点与概念、知识要点；没有实质内容的类别直接省略。

第三层“深度洞察”（仅在明确信号时输出）：
- risks：仅当会议出现实质战略讨论、未解决的重要分歧或可识别风险信号时输出。每条推理性内容必须以“[分析]”开头，严格区别于事实陈述；mitigation 仅在原文提出应对方案时填写。
- open_questions：只保留会议中尚未解决的重要分歧或待确认问题，不自行发明延伸问题。若没有触发信号，risks 与 open_questions 均为空，整个第三层省略。

自适应规则：
- 决策型：第一层的结论与决策、待办事项最重要，应尽量完整详尽；第二层侧重数据支撑与决策依据；无实质“新观点与概念”时 highlights 为空。
- 创意型：decisions 调整为核心共识与方向；第二层侧重观点碰撞、新概念与灵感亮点；没有明确行动时 action_items 为空；无重要数据时对应 highlights 为空。
- 混合型：逐议题采用相应规则，不把建议误写成已确定决策。

输出约束：
- 事实锚定：所有内容必须基于输入；不编造、不引入外部知识，信息不足时明确写“[待确认]”。
- 密度优先：任何板块无实质内容必须整体跳过，不输出空壳标题。
- 发言人一致：全文统一追踪发言人，不根据内容猜测真实身份。
- 用户标记优先：用户标记仅在有独立证据支持时优先进入第一层；未被支持时不得伪装成会议事实。
- 严格边界：不自我指涉，不对人物做主观或道德评价；推测与事实严格分开。
- 语言一致：输出语言与输入一致。

篇幅：≤15分钟300-500字，仅第一层；15-45分钟500-1000字，第一层加第二层按需；45-90分钟800-1500字，三层按需；>90分钟1000-2000字，三层完整。第一层约50-60%，第二层约30-35%，第三层0-15%。

section_titles 对该模板不参与最终排版；最终标题和层级由上述固定金字塔契约决定。`,
  },
};

export function meetingTemplate(id: MeetingTemplateId = DEFAULT_MEETING_TEMPLATE_ID): MeetingPostprocessTemplate {
  return MEETING_POSTPROCESS_TEMPLATES[id];
}
