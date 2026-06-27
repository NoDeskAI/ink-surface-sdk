/**
 * 全书主题联想召回（向量层）——预留接口，实现待本地 embedding/索引就位（见 src/local/vector.ts）。
 *
 * 与空间召回(recall.ts)正交、互补：
 *   · 空间召回钉"这一行/这附近"的**指代**——精确、就近、按位置（治当下这笔在问什么）。
 *   · 主题召回捞"全书别处与此相关"的旧标注——模糊、跨页、按语义（治"跟刚才那个有关吗"这类跨页联想）。
 * 喂模型时主题结果**单独贴标签**、与"你正指的这行"严格区隔，避免语义关联反过来制造主题漂移。
 *
 * 现 vectorStore.search 为 no-op 恒返 []，故本函数现也恒返 []——端到端的缝已接好；
 * 接上真实本地向量库时只动 src/local/vector.ts 一处即生效，本函数与上游 pipeline 不变。
 */
import type { VectorHit } from '../local/vector';
import { vectorStore } from '../local/vector';

export async function findThematicRecall(bookId: string, queryText: string, k = 3): Promise<VectorHit[]> {
  const q = queryText.trim();
  if (!bookId || !q) return [];
  try {
    return await vectorStore.search(q, { bookId, k });
  } catch {
    return []; // 检索失败不连累主推理闭环
  }
}
