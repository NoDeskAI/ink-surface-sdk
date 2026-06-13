import type { OcrTextBlock } from '../core/contracts';
import type { ReflowBlock } from '../core/reflow';
import { reflowLocal } from '../core/reflow';

/**
 * 重排 provider 接缝（跟 ocr.ts / inference.ts 同构）。
 *  - local ：本地启发式，纯几何、离线、保 bbox 映射。
 *  - hybrid：中间路线 —— 几何打骨架（保 bbox）+ 模型逐块精修（清断词/纠类型/修阅读顺序）。
 *            模型只重排/精修同一批 id，不合并拆分，所以每块仍认得原页 bbox。
 */
export type ReflowProvider = (blocks: OcrTextBlock[]) => Promise<ReflowBlock[]>;

const local: ReflowProvider = async (blocks) => reflowLocal(blocks);

const hybrid: ReflowProvider = async (blocks) => {
  const base = reflowLocal(blocks);
  if (base.length < 2) return base;
  let refined: Array<{ id: string; type: string; level: number; text: string }>;
  try {
    const resp = await fetch('/api/reflow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: base.map((b) => ({ id: b.id, type: b.type, text: b.text })) }),
    });
    if (!resp.ok) return base; // 模型失败 → 降级用启发式
    refined = await resp.json();
    if (!Array.isArray(refined)) return base;
  } catch {
    return base;
  }

  // 按 id 贴回原页 bbox；模型漏掉的块按原位补回（绝不丢内容）
  const byId = new Map(base.map((b) => [b.id, b]));
  const out: ReflowBlock[] = [];
  for (const r of refined) {
    const src = byId.get(r.id);
    if (!src) continue;
    out.push({
      id: src.id,
      type: r.type === 'heading' ? 'heading' : 'para',
      level: r.type === 'heading' ? (r.level || 1) : 0,
      text: r.text || src.text,
      source: src.source,
    });
    byId.delete(r.id);
  }
  for (const b of base) if (byId.has(b.id)) out.push(b);
  return out.length ? out : base;
};

export const reflowProviders: Record<string, ReflowProvider> = { local, hybrid };

export const REFLOW_PROVIDER_LABELS: Record<string, string> = {
  local: '仅启发式（即时·保 bbox）',
  hybrid: '启发式 + 模型精修',
};
