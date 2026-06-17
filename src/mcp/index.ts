/**
 * 唯一对外 MCP 边（v3 边界纠正：MCP 只存在于外部集成这条缝）—— P5 骨架 stub。
 *
 * 两个方向：① 外部 AI（CC/Codex/ChatGPT/Cursor）连进来消费我们的判断数据（阶段二平台）；
 *           ② 我们连出去把 action items/判断推到 Notion/Linear/Todo。
 * 内部（模型 / 库 / 向量）全本地直连、绝不 MCP 化——本模块只包外部集成。隐私：opt-in、按范围授权、可撤销。
 * 当前未实现，仅立类型与入口。
 */
export type ExternalTarget = 'notion' | 'linear' | 'todo' | 'obsidian';
export interface PushResult { ok: boolean; note: string }

/** 推判断 / action items 到外部（占位）。真实：经各自 MCP/API、用户授权后才发。 */
export async function pushTo(target: ExternalTarget, _payload: unknown): Promise<PushResult> {
  return { ok: false, note: `P5 stub: 外部 MCP 边（${target}）未接` };
}

/** 把本地判断库暴露成对外 MCP server 的入口（占位·阶段二）。 */
export function serveJudgmentMcp(): void {
  /* TODO（阶段二）：把 durable 判断库包成远程 MCP，供外部 AI 经干净工具边界读取 */
}
