import type { OcrTextBlock, PDFPageRecord, ScreenOverlay, StrokePoint } from '../core/contracts';

type Handler = (...args: unknown[]) => void;

class Bus {
  private handlers = new Map<string, Set<Handler>>();
  on(event: string, fn: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }
}

/**
 * 事件总线。约定的事件：
 *  'document:loaded'      文档导入完成
 *  'page:rendered'        页面渲染完成（含缩放重渲）
 *  'overlay:add' (o)      新 overlay 产生
 *  'overlay:state' (o)    overlay 状态变化（接受/编辑/忽略）
 *  'overlay:remove' (id)  overlay 被移除（如综述被新一轮综合替换）
 *  'settings:changed'     行为设置变化（落点/各行为开关）
 *  'anchor:focus' (id)    请求高亮某个锚点
 *  'card:focus' (id)      请求滚动到某张卡片
 *  'trace' (kind, obj)    新 trace 记录
 *  'metrics'              延迟/计数更新
 *  'tool' (tool)          工具切换
 */
export const bus = new Bus();

export type Tool = 'pen' | 'highlighter' | 'eraser';

/** AI 输出落点：右侧留白 / 贴正文浮动。 */
export type Placement = 'margin' | 'inline';

/** 阅读面：原版 PDF / 重排 reader。 */
export type ViewMode = 'page' | 'reader';

/**
 * 开放式行为设置 —— 每条行为独立可启停，可任意组合（非二选一模式）。
 * 以后新增符号语法（箭头=建立联系、波浪线=存疑…）只需再加一条，不动其它。
 */
export interface Settings {
  placement: Placement;
  viewMode: ViewMode;                            // 阅读面：原版 PDF / 重排
  reflowProvider: string;                        // 重排引擎：local / llm
  gesture: { enabled: boolean };                 // 手势响应：每次停笔 → 按手势意图作答（圈/划/问/写）
  idle: { enabled: boolean; seconds: number };   // 停顿综合：超时无新标注 → 综合本页所有标注
}

export const settings: Settings = {
  placement: 'margin',
  viewMode: 'page',
  reflowProvider: 'local',
  gesture: { enabled: true },
  idle: { enabled: true, seconds: 5 },
};

export interface Stroke {
  tool: Tool;
  points: StrokePoint[];
}

export const state = {
  tool: 'pen' as Tool,
  zoom: 1,
  fileName: '',
  fileHash: null as string | null,
  documentId: null as string | null,
  pageCount: 0,
  pageIndex: 0,
  pageId: null as string | null,
  pageRecord: null as PDFPageRecord | null,
  textBlocks: [] as OcrTextBlock[],
  strokesByPage: new Map<string, Stroke[]>(),
  overlays: [] as ScreenOverlay[],
  ocrProvider: 'textlayer',
  inferProvider: 'cloud',
};

export function currentStrokes(): Stroke[] {
  if (!state.pageId) return [];
  if (!state.strokesByPage.has(state.pageId)) state.strokesByPage.set(state.pageId, []);
  return state.strokesByPage.get(state.pageId)!;
}

export function setTool(tool: Tool): void {
  state.tool = tool;
  bus.emit('tool', tool);
}
