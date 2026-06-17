import type { NormBBox, OcrTextBlock } from '../core/contracts';
import type { ReflowBlock, ReflowBlockType } from '../core/reflow';
import { reflowLocal, groupLines, blockId, type ReflowLine } from '../core/reflow';

/**
 * 重排 provider 接缝（跟 ocr.ts / inference.ts 同构）。
 *  - local  ：本地启发式，纯几何、离线、保 bbox。
 *  - hybrid ：几何打骨架 + 模型逐块精修（纯文字），保 bbox。
 *  - vision ：几何打骨架 + 模型**看页面图**重判角色/阅读顺序，保 bbox（多栏/表格更准）。
 *  - rewrite：完全放弃几何，让模型**看图重写**成规范语义块（治网页截图/扭曲页/字号统一）。
 *           bbox 由模型估计（粗），文字严格按图转写。
 */
export type ReflowProvider = (blocks: OcrTextBlock[]) => Promise<ReflowBlock[]>;

const local: ReflowProvider = async (blocks) => reflowLocal(blocks);

/** 把当前页 canvas 缩到长边 ≤max 再转 PNG（控 token），失败返回 undefined。 */
function grabPageImage(max = 1280): string | undefined {
  const cv = document.getElementById('page-layer') as HTMLCanvasElement | null;
  if (!cv || !cv.width || !cv.height) return undefined;
  try {
    const scale = Math.min(1, max / Math.max(cv.width, cv.height));
    const w = Math.round(cv.width * scale);
    const h = Math.round(cv.height * scale);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d')!.drawImage(cv, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  } catch {
    return undefined; // 跨域污染等 → 退回无图
  }
}

/** 几何块交 /api/reflow 精修（可带页面图）；按 id 把原页 bbox 贴回，失败降级用几何。 */
async function refine(base: ReflowBlock[], image?: string): Promise<ReflowBlock[]> {
  if (base.length < 2) return base;
  let refined: Array<{ id: string; type: string; level: number; text: string }>;
  try {
    const resp = await fetch('/api/reflow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 列表用占位文本送给模型（只让它排序，不让它拆平结构）
      body: JSON.stringify({
        blocks: base.map((b) => ({ id: b.id, type: b.type, text: b.type === 'list' ? `（列表）${(b.items ?? []).join(' / ')}` : b.text })),
        image,
      }),
    });
    if (!resp.ok) return base;
    refined = await resp.json();
    if (!Array.isArray(refined)) return base;
  } catch {
    return base;
  }
  const byId = new Map(base.map((b) => [b.id, b]));
  const out: ReflowBlock[] = [];
  for (const r of refined) {
    const src = byId.get(r.id);
    if (!src) continue;
    if (src.type === 'list') { out.push(src); byId.delete(r.id); continue; } // 列表原样保留结构，只取模型给的位置
    out.push({
      id: src.id,
      type: r.type === 'heading' ? 'heading' : 'para',
      level: r.type === 'heading' ? (r.level || 1) : 0,
      text: r.text || src.text,
      source: src.source, // 原页 bbox 原样保留
    });
    byId.delete(r.id);
  }
  for (const b of base) if (byId.has(b.id)) out.push(b); // 模型漏掉的按原样补回
  return out.length ? out : base;
}

const hybrid: ReflowProvider = async (blocks) => refine(reflowLocal(blocks));
const vision: ReflowProvider = async (blocks) => refine(reflowLocal(blocks), grabPageImage());

/** 确定性 id：同页 rewrite 出同样的 id → 缩放/重渲后行内注不丢锚。 */
function rewriteId(text: string, index: number): string {
  let h = 0;
  for (let k = 0; k < text.length; k++) h = (h * 31 + text.charCodeAt(k)) | 0;
  return `vlm_${index}_${(h >>> 0).toString(36)}`;
}

/** 完全 VLM 重写：看图直出语义块（治网页截图/扭曲页/统一字号）。文字严格转写，bbox 由模型估。 */
const rewrite: ReflowProvider = async () => {
  const image = grabPageImage();
  if (!image) return [];
  let arr: Array<{ type?: string; level?: number; text?: string; items?: string[]; ordered?: boolean; bbox?: number[] }>;
  try {
    const resp = await fetch('/api/reflow-vlm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }),
    });
    if (!resp.ok) return [];
    arr = await resp.json();
    if (!Array.isArray(arr)) return [];
  } catch { return []; }
  return arr.map((b, i): ReflowBlock => {
    const type = (b.type === 'heading' || b.type === 'list' ? b.type : 'para') as ReflowBlockType;
    const text = type === 'list' ? (b.items ?? []).join('\n') : String(b.text ?? '');
    const bbox: NormBBox = (b.bbox && b.bbox.length === 4)
      ? [b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]] as NormBBox
      : [0, 0, 1, 0.05];
    return {
      id: rewriteId(text, i),
      type,
      level: type === 'heading' ? (b.level || 1) : 0,
      text,
      source: bbox,
      ...(type === 'list' ? { items: b.items ?? [], ordered: !!b.ordered } : {}),
    };
  }).filter((b) => b.text.trim().length > 0 || (b.items?.length ?? 0) > 0);
};

function unionLines(lines: ReflowLine[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const l of lines) { const [x, y, w, h] = l.bbox; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * AI 结构重建（文本驱动·主线升级）：把"行"(id+相对字号+文字)交模型分组成 标题/段落/列表，
 * 靠内容+字号判段落边界与标题层级——治本地 gap 启发式把多段并成一块。模型只输出分组(lineIds)，
 * 文字与 source bbox 由前端按 lineIds 从原行拼回，**重排块照样映射回原页**（圈画可追溯）。
 */
const ai: ReflowProvider = async (blocks) => {
  const lines = groupLines(blocks);
  if (lines.length < 3) return reflowLocal(blocks);
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const bodyFont = sizes[sizes.length >> 1] || 0.012;
  let groups: Array<{ type?: string; level?: number; lineIds?: string[] }>;
  try {
    const resp = await fetch('/api/reflow-ai', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: lines.map((l) => ({ id: l.id, sizeRatio: +(l.size / bodyFont).toFixed(2), text: l.text })) }),
    });
    if (!resp.ok) return reflowLocal(blocks);
    groups = await resp.json();
    if (!Array.isArray(groups)) return reflowLocal(blocks);
  } catch { return reflowLocal(blocks); }

  const byId = new Map(lines.map((l) => [l.id, l]));
  const used = new Set<string>();
  const out: ReflowBlock[] = [];
  for (const g of groups) {
    const gls = (g.lineIds ?? []).map((id) => byId.get(id)).filter((l): l is ReflowLine => !!l);
    if (!gls.length) continue;
    gls.forEach((l) => used.add(l.id));
    const type: ReflowBlockType = g.type === 'heading' ? 'heading' : g.type === 'list' ? 'list' : 'para';
    const text = gls.map((l) => l.text).join(type === 'list' ? '\n' : ' ');
    out.push({
      id: blockId(text, out.length), type,
      level: type === 'heading' ? (g.level || 1) : 0,
      text, source: unionLines(gls),
      ...(type === 'list' ? { items: gls.map((l) => l.text), ordered: false } : {}),
    });
  }
  for (const l of lines) if (!used.has(l.id)) out.push({ id: blockId(l.text, out.length + 1000), type: 'para', level: 0, text: l.text, source: l.bbox }); // 漏掉的行补回，别丢字
  out.sort((a, b) => a.source[1] - b.source[1]);
  return out.length ? out : reflowLocal(blocks);
};

export const reflowProviders: Record<string, ReflowProvider> = { local, hybrid, vision, rewrite, ai };

export const REFLOW_PROVIDER_LABELS: Record<string, string> = {
  ai: 'AI 结构重建（文本驱动·主线·保 bbox）',
  local: '仅启发式（即时·保 bbox）',
  hybrid: '启发式 + 模型精修（文字）',
  vision: '启发式 + 视觉重排（Kimi 看图·保 bbox）',
  rewrite: 'VLM 看图重写（治网页截图/扭曲页·bbox 估算）',
};
