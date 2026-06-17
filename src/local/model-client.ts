import type { InferenceRequest, InferenceResult, ResultType } from '../core/contracts';
import { shortId } from '../core/ids';

export type InferenceProvider = (req: InferenceRequest) => Promise<InferenceResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let counter = 0;

/** 占位文案生成。真实回答由 cloud provider（LLM）替换，这里只为演示三种行为的形态。 */
function mockContent(req: InferenceRequest): { type: ResultType; content: string } {
  const modes = req.output_modes;

  // 停顿综合：把本页所有标注合成一条
  if (modes.includes('summary')) {
    const nearby = req.nearby_text ?? '';
    const count = (nearby.match(/〔/g) ?? []).length || req.ocr_blocks.length;
    const quotes = (nearby.match(/"([^"]+)"/g) ?? []).slice(0, 2).join('、');
    const content = count
      ? `读到这里，你在这一页留下了 ${count} 处标注${quotes ? `：${quotes}` : ''}。这些标记看起来围绕同一条线索——它们在意的与其说是字面意思，不如说是背后那个尚未被言明的假设。要往前推进，可以先确认这条假设是否成立，再决定哪几处值得展开。`
      : '这一页还没有可供综合的标注。圈一处你在意的地方，停笔片刻，我来帮你把它们串起来。';
    return { type: 'summary', content };
  }

  // 符号对话：output_modes 收窄为 ['question'] → 针对圈住的内容作答（而非反问）
  if (modes.length === 1 && modes[0] === 'question') {
    const snippet = (req.ocr_blocks[0]?.text || req.nearby_text || '你圈出的内容').slice(0, 28);
    return { type: 'inspiration', content: `就你圈出的「${snippet}」——它的关键在于先分清"是什么"与"为什么"：字面定义之外，作者真正想立的是一个判断。沿这个判断往下读，多半能接上你那个问号。` };
  }

  // 逐笔即时旁注：在三种语气间轮换
  const t = (['question', 'inspiration', 'connection'] as const)[counter++ % 3];
  const snippet = (req.ocr_blocks[0]?.text || req.nearby_text || '该区域').slice(0, 24);
  const content = {
    question: `这里值得追问：「${snippet}…」背后的假设是否成立？`,
    inspiration: `「${snippet}」可以和你之前标注过的概念建立联系，形成一个新的假设方向。`,
    connection: `「${snippet}」与本文档其他章节可能存在呼应，建议对照阅读。`,
  }[t];
  return { type: t, content };
}

const mock: InferenceProvider = async (req) => {
  await sleep(req.output_modes.includes('summary') ? 700 : 600);
  const { type, content } = mockContent(req);
  return {
    result_id: shortId('res'),
    trace_id: req.trace_id,
    request_id: req.request_id,
    result_type: type,
    content,
    source_refs: [{
      page_id: req.annotation_event.page_id,
      bbox: req.ocr_blocks[0]?.bbox || req.annotation_event.geometry.bbox,
      ocr_block_ids: req.ocr_blocks.map((b) => b.id),
      event_id: req.event_id,
    }],
    confidence: 0.82,
    created_at: new Date().toISOString(),
    model_name: 'deterministic-mock',
    model_version: '0',
  };
};

const fail: InferenceProvider = async () => {
  await sleep(400);
  throw new Error('模拟云端超时（A11 演练）');
};

/** 经本地 dev 代理（/api/infer）打 NoDesk 网关 → kimi-k2.6（可切 claude-sonnet-4-6）。 */
const cloud: InferenceProvider = async (req) => {
  const resp = await fetch('/api/infer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error((e as { error?: string }).error || `推理代理 ${resp.status}`);
  }
  return (await resp.json()) as InferenceResult;
};

export const inferProviders: Record<string, InferenceProvider> = { mock, fail, cloud };

export const INFER_PROVIDER_LABELS: Record<string, string> = {
  mock: 'deterministic mock',
  fail: '模拟失败（测 A11）',
  cloud: 'NoDesk 网关（kimi-k2.6·可切 Sonnet）',
};
