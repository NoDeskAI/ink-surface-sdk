/**
 * 云端 tool-loop 编排（冷路径·S1–S7）—— P5 骨架 stub。
 *
 * 不用 Agent SDK：S1–S7 都是步骤已知的确定性 pipeline（非自主 agent），裸 tool-loop + 确定性
 * 编排 + durable 库托底即可。各场景异步、后台、永不占用户等待。当前仅立类型与入口，逐个后续接
 * （向量库就绪后 S1/S4/S6 才有底料；S5/S7 还需 mcp/ 外部边）。
 */
export type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7';

export const SCENARIOS: Record<ScenarioId, string> = {
  S1: '标注即可搜（OCR+语义索引→自然语言查判断）',
  S2: '写完即落地（清 Markdown→Notion/Obsidian）',
  S3: '判断 Brief（立场→依据→待验证，每条点回原页）',
  S4: '跨材料综合（多文档聚合→竞品矩阵/脉络图）',
  S5: '行动承接（抽 action items→Linear/Todo→遗忘曲线推送）',
  S6: '长期记忆（周度聚合→Memory Digest）',
  S7: '内容反哺（历史判断→文章/Slide/PRD 草稿）',
};

export interface ScenarioRun { id: ScenarioId; bookId?: string; }
export interface ScenarioResult { id: ScenarioId; ok: boolean; note: string }

/** 跑一个场景编排（占位）。真实形态：检索 local/vector → 扇出综合 → 产出 / 经 mcp 外部边集成。 */
export async function runScenario(run: ScenarioRun): Promise<ScenarioResult> {
  return { id: run.id, ok: false, note: `P5 stub: ${SCENARIOS[run.id]} 未实现` };
}
