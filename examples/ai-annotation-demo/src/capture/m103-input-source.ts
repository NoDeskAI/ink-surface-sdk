/**
 * Haoqing M103 设备专用：原生输入分类覆盖。
 *
 * 2026-07-01 真机确认：`HqHwBridge` 武装厂商快速手写模式后，真实触控笔到达 WebView 自己合成
 * PointerEvent 之前会在底层丢失笔尖/橡皮标识位——`e.pointerType` 被错报成 `"touch"`（压感数据还在，
 * 只是身份信息被吞了）。原生侧用一个更早的 `OnTouchListener`(在 WebView 内部处理之前)看到的是没被
 * 污染的原始 `MotionEvent`，能正确分辨设备名(笔 vs 手指)和 tool type(笔尖 vs 橡皮)，通过
 * `window.InkLoopInputSource` 同步暴露出来（见 `InputSourceBridge.kt`）。
 *
 * 只在这台设备上生效——原生接口不存在时 `nativePointerKind()` 恒返回 null，调用方应退回自己原来
 * 按 `e.pointerType` 判断的逻辑，对其它设备/桌面 web 零影响。
 */
import { isM103Device, isOnyxPaperDevice, supportsNativeInputSource } from './m103-device';
import { bus, state } from '../app/state';

export interface M103PhysicalPenPoint {
  x: number;
  y: number;
  pressure: number;
  t: number;
  strokeWidth?: number;
  flag: number;
}

export interface M103PhysicalPenStroke {
  seq: number;
  source: 'motion_event' | 'onyx_touch_helper';
  points: M103PhysicalPenPoint[];
}

interface InkLoopInputSourceBridge {
  classifyLast(): string;
  isOsdArmed(): boolean;
  takeLastPhysicalPenStroke?(): string;
  clearPhysicalPenStrokes?(): void;
  debugStatus?(): string;
}

function bridge(): InkLoopInputSourceBridge | null {
  if (!supportsNativeInputSource()) return null;
  const w = window as unknown as { InkLoopInputSource?: InkLoopInputSourceBridge };
  return w.InkLoopInputSource ?? null;
}

export type M103PointerKind = 'pen' | 'eraser' | 'touch' | null;

/** 原生对"最近这次接触"的分类；没有可用覆盖信息(非 M103/接口未就位/原生判定不了)时返回 null——
 *  调用方此时应该退回自己原来按 `e.pointerType` 判断的逻辑，不要当成"确定是 touch"。 */
export function nativePointerKind(): M103PointerKind {
  const b = bridge();
  if (!b) return null;
  try {
    const k = b.classifyLast();
    return k === 'pen' || k === 'eraser' || k === 'touch' ? k : null;
  } catch {
    return null;
  }
}

/** 这次接触是不是真实笔(笔尖或橡皮头都算"笔"，会不会画/擦由调用方自己再判断)。 */
export function isPhysicalPenContact(e: PointerEvent): boolean {
  const native = nativePointerKind();
  if (native != null) return native === 'pen' || native === 'eraser';
  return e.pointerType === 'pen';
}

/** 这次接触是不是手指。 */
export function isPhysicalFingerContact(e: PointerEvent): boolean {
  const native = nativePointerKind();
  if (native != null) return native === 'touch';
  return e.pointerType === 'touch';
}

/** 厂商 OSD 快速墨迹这一刻是不是真的武装成功——武装时应该信它做实时视觉、自己别跟着实时画，
 *  避免"OSD 快画一次 + 我们自己的画布又慢慢画一次"两套渲染叠加、反而更卡。没有覆盖信息(非 M103/
 *  接口未就位)时返回 false（保守：自己画，行为跟没有这套机制之前一致）。 */
export function isOsdActive(): boolean {
  const b = bridge();
  if (!b) return false;
  try { return b.isOsdArmed(); } catch { return false; }
}

export function takeLastPhysicalPenStroke(): M103PhysicalPenStroke | null {
  const onyx = takeLastOnyxPenStroke();
  if (onyx) return onyx;
  const b = bridge();
  if (!b?.takeLastPhysicalPenStroke) return null;
  try {
    const raw = b.takeLastPhysicalPenStroke();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<M103PhysicalPenStroke>;
    if (parsed.source !== 'motion_event' || !Array.isArray(parsed.points) || parsed.points.length === 0 || typeof parsed.seq !== 'number') return null;
    return parsed as M103PhysicalPenStroke;
  } catch {
    return null;
  }
}

function takeLastOnyxPenStroke(): M103PhysicalPenStroke | null {
  const b = onyxPenBridge();
  if (!b?.takeLastPhysicalPenStroke) return null;
  try {
    const raw = b.takeLastPhysicalPenStroke();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<M103PhysicalPenStroke>;
    if (parsed.source !== 'onyx_touch_helper' || !Array.isArray(parsed.points) || parsed.points.length === 0 || typeof parsed.seq !== 'number') return null;
    return parsed as M103PhysicalPenStroke;
  } catch {
    return null;
  }
}

export function clearPhysicalPenStrokeBuffer(): void {
  const b = bridge();
  try { onyxPenBridge()?.clearPhysicalPenStrokes?.(); } catch { /* no-op */ }
  try { b?.clearPhysicalPenStrokes?.(); } catch { /* no-op */ }
}

export function physicalPenDebugStatus(): unknown {
  const b = bridge();
  if (!b?.debugStatus) return null;
  try {
    const raw = b.debugStatus();
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return { error: String(error) };
  }
}

interface InkLoopOnyxEpdBridge {
  enterFastInk(): boolean;
  exitFastInk(): boolean;
  refreshDirtyRect?(x: number, y: number, width: number, height: number): boolean;
  debugStatus?(): string;
}

interface InkLoopOnyxPenBridge {
  enterFastInk(): boolean;
  exitFastInk(): boolean;
  takeLastPhysicalPenStroke?(): string;
  clearPhysicalPenStrokes?(): void;
  debugStatus?(): string;
}

function onyxEpdBridge(): InkLoopOnyxEpdBridge | null {
  if (!isOnyxPaperDevice()) return null;
  const w = window as unknown as { InkLoopOnyxEpd?: InkLoopOnyxEpdBridge };
  return w.InkLoopOnyxEpd ?? null;
}

function onyxPenBridge(): InkLoopOnyxPenBridge | null {
  if (!isOnyxPaperDevice()) return null;
  const w = window as unknown as { InkLoopOnyxPen?: InkLoopOnyxPenBridge };
  return w.InkLoopOnyxPen ?? null;
}

/** ONYX/T10：落笔期间尝试打开厂商原生 raw drawing + transient fast update。
 * 返回 true 只表示 TouchHelper 接口已接受请求；当前 T10 固件下不等价于视觉层已稳定实时出墨，
 * 调用方应保留 WebView canvas live draw 作为可见性兜底。 */
export function enterOnyxFastInk(e?: PointerEvent): boolean {
  if (e && !isPhysicalPenContact(e)) return false;
  let nativeRender = false;
  try { nativeRender = onyxPenBridge()?.enterFastInk() === true; } catch { /* best-effort */ }
  try { onyxEpdBridge()?.enterFastInk(); } catch { /* best-effort */ }
  return nativeRender;
}

export function exitOnyxFastInk(): void {
  try { onyxPenBridge()?.exitFastInk(); } catch { /* best-effort */ }
  try { onyxEpdBridge()?.exitFastInk(); } catch { /* best-effort */ }
}

export function onyxEpdDebugStatus(): unknown {
  const b = onyxEpdBridge();
  if (!b?.debugStatus) return null;
  try {
    const raw = b.debugStatus();
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return { error: String(error) };
  }
}

export function onyxPenDebugStatus(): unknown {
  const b = onyxPenBridge();
  if (!b?.debugStatus) return null;
  try {
    const raw = b.debugStatus();
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return { error: String(error) };
  }
}

// 笔是否正落纸（**只标记"写字笔"在落**·橡皮不置——擦除仍需重画画布让墨迹消失）。写字期间要**彻底不碰画布**：
// 不清 OSD、不 resizeInk、不改布局——否则写字引发的程序性滚动/mark 收口重投影会触发重绘=用户看到的"写的时候还在碰画布"。
// 由写字笔的 pointerdown 置真（**必须放在橡皮 early-return 之后**）、抬笔/取消置假。
let penDown = false;
export function setPenDown(down: boolean): void { penDown = down; }
export function isPenDown(): boolean { return penDown; }

// ── 重排画布/布局改动的单一权威策略 ──
// 背景：`.reader-ink` 的重绘(resizeInk)与重排布局(settleV/scrollTop)在 reader.ts 里有 ~10 处散点直调，
// 没有单一入口——逐路径加 penDown 守卫是打地鼠(codex 彻查结论)。收口成：所有重绘/布局调用都带一个
// `reason` 并先问这里"现在能不能动"。策略：非 M103 恒放行(桌面/其它设备零回归)；M103 写字笔落纸期间一律拒
// (写字零画布)；否则只有「交接类」reason 放行(翻页/切视图/清 OSD/橡皮/重排落地/resize)，
// 'live'/'mark-resolved'/'restore-sync' 这类"写完顺手刷"一律拒→留到下一个交接时刻从 model 统一画。
export type ReaderMutationReason =
  | 'live' | 'mark-resolved' | 'restore-sync'
  | 'render' | 'stream-render' | 'repaginate' | 'page-scroll'
  | 'osd-clear' | 'view-change' | 'window-resize'
  | 'pointer-cancel' | 'erase';

const READER_HANDOFF: ReadonlySet<ReaderMutationReason> = new Set<ReaderMutationReason>([
  'render', 'stream-render', 'repaginate', 'page-scroll', 'osd-clear',
  'view-change', 'window-resize', 'pointer-cancel', 'erase',
]);

/** M103 物理笔：OSD 硬件层负责写字实时显示，画布一律不 live draw——**不再赌**落笔瞬间 `isOsdArmed()` 的竞态
 *  (arm 异步·面积上报后原生握手才置真·刚翻页/切重排/首帧后第一笔常读到 false→整笔 skipLiveDraw 锁死→
 *  每个 move 都画画布=写字期间碰画布，即根因 H1)。非 M103/非物理笔返回 false，调用方退回原 `isOsdActive()` 逻辑。 */
export function shouldUseOsdOnlyForStroke(e: PointerEvent): boolean {
  return isM103Device() && isPhysicalPenContact(e) && (state.tool === 'pen' || state.tool === 'aipen');
}

/** 现在能不能写 `.reader-ink` 画布(resizeInk / live 增量画)。见上策略。返回 false 时调用方应直接跳过绘制。 */
export function canMutateReaderCanvas(reason: ReaderMutationReason): boolean {
  if (!isM103Device()) return true;
  if (penDown) return false;
  return READER_HANDOFF.has(reason);
}

/** 现在能不能改重排布局(paginate 排版 / scrollTop)。同上策略：写字中拒；'live'/'mark-resolved'/'restore-sync' 拒。 */
export function canMutateReaderLayout(reason: ReaderMutationReason): boolean {
  if (!isM103Device()) return true;
  if (penDown) return false;
  return reason !== 'live' && reason !== 'mark-resolved' && reason !== 'restore-sync';
}

/** 这个 reason 是不是"交接类"(翻页/切视图/清 OSD/橡皮/重排落地/resize)——调度合批时用它把已排队的弱 reason
 *  ('mark-resolved'/'restore-sync') 升级成交接，避免弱 reason 先占坑把同帧内真该重绘的交接吞掉。 */
export function isReaderHandoffReason(reason: ReaderMutationReason): boolean {
  return READER_HANDOFF.has(reason);
}

// ── 清 OSD 前的可等待屏障 ──
// OSD 抬笔要清时，若有"在途还没落进 model 的笔"(finishCommittedR 正 await 硬件 socket 点·≤160ms)，先等它落定再清，
// 否则会用不含这笔的 model 重绘画布、随后清掉 OSD → 这笔视觉上消失到下次交接(两路 codex review 都独立指出的竞态)。
type OsdClearBarrier = () => void | Promise<void>;
const osdClearBarriers = new Set<OsdClearBarrier>();
/** 注册一个"清 OSD 前必须先等完"的屏障(如 reader 的在途笔提交)。返回注销函数。 */
export function registerOsdClearBarrier(fn: OsdClearBarrier): () => void {
  osdClearBarriers.add(fn);
  return () => { osdClearBarriers.delete(fn); };
}
async function runOsdClearBarriers(): Promise<void> {
  for (const fn of [...osdClearBarriers]) {
    try { await fn(); } catch { /* best-effort：屏障出错也绝不能永久卡住清 OSD */ }
  }
}

interface InkLoopHqHwBridge {
  clearFastInk(): void;
  resetFastInk?: () => void;
  forceResetFastInk?: () => void;
}

function hqHwBridge(): InkLoopHqHwBridge | null {
  if (!isM103Device()) return null;
  const w = window as unknown as { InkLoopHqHw?: InkLoopHqHwBridge };
  return w.InkLoopHqHw ?? null;
}

/** 清 OSD 交接：先发 `osd:will-clear` 让**写字时零画布刷新**的面(重排)从 model 把画布补齐，再等双 rAF 屏障
 *  (确保画布已呈现)清掉 OSD 临时墨迹。写字时全信 OSD 显示(最丝滑·不逐笔刷画布)，只在这个"要清 OSD"的唯一时机
 *  把画布一次性重绘出来——翻页/切视图/滚动/橡皮所有清 OSD 场景都走这里，所以不会"清了 OSD 画布还没画→丢墨"。
 *  太早清(没呈现就清)会闪/断，不清则 OSD 墨迹不自行消失。非 M103 no-op(bus 事件也无人接·零影响)。 */
export function clearOsdInkAfterCommit(): void {
  const b = hqHwBridge();
  if (!b) return;
  void (async () => {
    await runOsdClearBarriers();  // 先等在途笔落进 model（正常几 ms 即完；socket 缺包最坏 160ms）——保证下面重绘用的是含这笔的 model
    bus.emit('osd:will-clear'); // 当前面据此从 model 重绘画布(见 reader.ts)——补上写字时没画的 live 笔，OSD 清后不丢
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { b.clearFastInk(); } catch { /* no-op */ }
    }));
  })();
}

/** 立即清掉当前 OSD 临时墨迹。
 * 用于离开阅读/书写面这种明确的视觉边界：此时不需要等 canvas 承接笔迹，只需要保证硬件叠加层别盖到下一个页面。 */
export function clearOsdInkNow(): void {
  const b = hqHwBridge();
  if (!b) return;
  try { b.clearFastInk(); } catch { /* no-op */ }
}

/** 明确离开可写面时使用：清掉 OSD，并让原生 drawserver 解除当前画区。
 * 与 clearOsdInkAfterCommit 不同，这里不是“临时层交接到持久 canvas”，而是视觉边界切换：
 * 旧硬件墨迹绝不能继续盖在书架、下一本书或下一页上。 */
export function resetOsdInkNow(): void {
  const b = hqHwBridge();
  if (!b) return;
  try {
    if (b.resetFastInk) b.resetFastInk();
    else b.clearFastInk();
  } catch {
    try { b.clearFastInk(); } catch { /* no-op */ }
  }
}

/** 强制清掉跨进程残留的 M103 OSD 硬件墨迹。
 *  用于启动/刷新/离开可写面这些视觉边界：即便当前 JS 进程已丢失 armed/index 状态，也要让原生侧清
 *  drawserver 中可能遗留的画区和临时墨迹。普通重复 null 上报不要走这里。 */
export function forceResetOsdInkNow(): void {
  const b = hqHwBridge();
  if (!b) return;
  try {
    if (b.forceResetFastInk) b.forceResetFastInk();
    else if (b.resetFastInk) b.resetFastInk();
    else b.clearFastInk();
  } catch {
    try { b.clearFastInk(); } catch { /* no-op */ }
  }
}
