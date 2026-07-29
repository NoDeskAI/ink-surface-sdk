import type { PersistedMeeting } from '../../core/store-format';

type Cards = NonNullable<PersistedMeeting['summary_cards_v2']>;
export interface SummaryBlock { title: string; paragraph?: string; rows: string[] }
export interface SummaryLayer { title?: string; blocks: SummaryBlock[] }

function action(item: Cards['action_items'][number]): string {
  return `${item.task}${item.owner ? `（负责人：${item.owner}` : item.due_at ? '（' : ''}${item.due_at ? `${item.owner ? '；' : ''}截止：${item.due_at}` : ''}${item.owner || item.due_at ? '）' : ''}${item.commitment === 'proposed' ? '（提议）' : ''}`;
}

function nonEmpty(layers: SummaryLayer[]): SummaryLayer[] {
  return layers.map((layer) => ({ ...layer, blocks: layer.blocks.filter((block) => Boolean(block.paragraph?.trim()) || block.rows.length > 0) })).filter((layer) => layer.blocks.length > 0);
}

function ownedTemplateLayer(cards: Cards): SummaryLayer[] | null {
  if (!cards.template_sections?.length) return null;
  return nonEmpty([{ blocks: cards.template_sections.map((section) => ({
    title: section.title,
    paragraph: section.summary || undefined,
    rows: section.items.map((item) => `${item.label ? `${item.label}：` : ''}${item.speaker ? `（${item.speaker}）` : ''}${item.text}`),
  })) }]);
}

/** 模板是最终文档结构的唯一决定者；这里没有通用三段式 fallback。 */
export function templateSummaryLayers(cards: Cards): SummaryLayer[] {
  const titles = cards.section_titles || { background: '', discussion: '', next_steps: '' };
  if (cards.template_id && cards.template_id !== 'meeting_expert') {
    const owned = ownedTemplateLayer(cards);
    if (owned) return owned;
  }
  switch (cards.template_id) {
    case 'meeting_expert':
    case undefined: {
      const confirmed = cards.decisions.filter((item) => item.status === 'confirmed').map((item) => item.text);
      const tentative = cards.decisions.filter((item) => item.status === 'tentative').map((item) => `[待进一步讨论] ${item.text}`);
      return nonEmpty([
        { title: '第一层：核心信息', blocks: [
          { title: '一句话摘要', paragraph: cards.overview, rows: [] },
          { title: '结论与决策', rows: [...confirmed, ...tentative] },
          { title: '待办事项', rows: cards.action_items.map(action) },
        ] },
        { title: '第二层：关键脉络', blocks: [
          { title: '讨论脉络', rows: cards.key_points.map((item) => item.text) },
          { title: '关键提取', rows: cards.highlights.map((item) => item.text) },
        ] },
        { title: '第三层：深度洞察', blocks: [
          { title: '深度分析', rows: cards.risks.map((item) => `${item.text}${item.mitigation ? `（应对：${item.mitigation}）` : ''}`) },
          { title: '未解决的重要分歧与待确认', rows: cards.open_questions.map((item) => item.text) },
        ] },
        { blocks: [{ title: '个人标记与提醒', rows: cards.personal_notes.map((item) => item.text) }] },
      ]);
    }
    case 'interview_memo':
      return nonEmpty([{ blocks: [
        { title: titles.background || '访谈背景', paragraph: cards.overview, rows: [] },
        { title: titles.discussion || '受访者洞察与证据', rows: cards.key_points.map((item) => item.text) },
        { title: '关键数据与信号', rows: cards.highlights.map((item) => item.text) },
        { title: '确认事项', rows: cards.decisions.filter((item) => item.status === 'confirmed').map((item) => item.text) },
        { title: '待确认事项', rows: [...cards.decisions.filter((item) => item.status === 'tentative').map((item) => item.text), ...cards.open_questions.map((item) => item.text)] },
        { title: '下一步行动', rows: cards.action_items.map(action) },
        { title: '风险与矛盾信号', rows: cards.risks.map((item) => `${item.text}${item.mitigation ? `（应对：${item.mitigation}）` : ''}`) },
        { title: '个人提醒', rows: cards.personal_notes.map((item) => item.text) },
      ] }]);
    case 'university_notes':
      return nonEmpty([{ blocks: [
        { title: titles.background || '课程概览', paragraph: cards.overview, rows: [] },
        { title: titles.discussion || '核心概念与定义', rows: cards.key_points.map((item) => item.text) },
        { title: '主要讲座要点与案例', rows: cards.highlights.map((item) => item.text) },
        { title: '提出的问题与回答', rows: cards.open_questions.map((item) => item.text) },
        { title: titles.next_steps || '需复习与课后任务', rows: cards.action_items.map(action) },
      ] }]);
    case 'interactive_classroom':
      return nonEmpty([{ blocks: [
        { title: titles.background || '课堂目标与进展', paragraph: cards.overview, rows: [] },
        { title: titles.discussion || '互动问答与反馈', rows: cards.key_points.map((item) => item.text) },
        { title: '教师反馈、纠正与示范', rows: cards.highlights.map((item) => item.text) },
        { title: '仍待思考的问题', rows: cards.open_questions.map((item) => item.text) },
        { title: titles.next_steps || '练习与延伸', rows: cards.action_items.map(action) },
      ] }]);
    case 'reasoning_summary':
      return nonEmpty([{ blocks: [
        { title: titles.background || '问题与已知条件', paragraph: cards.overview, rows: cards.key_points.map((item) => item.text) },
        { title: titles.discussion || '推理链与结论', rows: [...cards.highlights.map((item) => item.text), ...cards.decisions.map((item) => `${item.status === 'tentative' ? '[待验证] ' : ''}${item.text}`)] },
        { title: '不确定性、反例与风险', rows: cards.risks.map((item) => item.text) },
        { title: titles.next_steps || '验证与下一步推演', rows: [...cards.open_questions.map((item) => item.text), ...cards.action_items.map(action)] },
      ] }]);
    case 'interview_archive':
      return [];
  }
}
