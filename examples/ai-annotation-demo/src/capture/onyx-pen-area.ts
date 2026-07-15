/**
 * ONYX BOOX 设备专用：把「当前书写画布矩形」上报给原生 OnyxPenBridge，收窄 raw drawing 画区。
 *
 * 背景：ONYX TouchHelper 的 limitRect 若设成整个 WebView，书架/按钮/弹层等非书写面也会被当成原生画线区
 * （用笔点会出墨）。这里前端上报当前可写画布（`#ink-layer` 原版页 / `.reader-ink` 重排页）的矩形，只在
 * 真书写面 arm、离开/书架/浮层上报 null 让原生 disarm。不带 M103 那套 OSD 清理（ONYX 无 hq.hw 硬件叠层）。
 *
 * 只在这台设备生效——`isOnyxPaperDevice()` 门控；非 ONYX 时 `window.InkLoopOnyxPen.updateWritingArea`
 * 不存在，channel() 返回 null，全部 no-op。独立设备模块，不侵入 ink.ts/reader.ts 共用主代码。
 */
import { bus, state } from '../app/state';
import { isOnyxPaperDevice } from './m103-device';

interface OnyxPenChannel { updateWritingArea(rectJson: string): void }

function channel(): OnyxPenChannel | null {
  if (!isOnyxPaperDevice()) return null;
  const b = (window as unknown as { InkLoopOnyxPen?: OnyxPenChannel }).InkLoopOnyxPen;
  return b && typeof b.updateWritingArea === 'function' ? b : null;
}

const CANDIDATE_SELECTORS = '#ink-layer, .reader-ink, #reader';
// 会遮挡/顶掉可写画布的浮层：打开时整个 disarm（报 null），别让原生在浮层底下响应笔迹。
const BLOCKING_CHROME = ['files-open', 'insight-open', 'side-open'];

function canvasBlocked(): boolean {
  const b = document.body;
  if (BLOCKING_CHROME.some((c) => b.classList.contains(c))) return true;
  if (document.querySelector('.msheet-scrim')) return true; // 动态 sheet 遮罩
  const spine = document.getElementById('mtg-spine');
  return !!spine && !spine.hidden; // 会议时间脊展开遮挡画布
}

interface AreaRect { x: number; y: number; w: number; h: number; dpr: number }

export interface OnyxPenAreaEligibility {
  writable: boolean;
  mode?: string;
  read?: string;
  meetingNoteOpen?: boolean;
  tool: string;
  blocked: boolean;
}

/** 只判页面状态；DOM 可见性与 bbox 在下一层处理，便于覆盖会议壳残留 data-read 的回归。 */
export function shouldArmOnyxPenArea(input: OnyxPenAreaEligibility): boolean {
  if (!input.writable) return false;
  if (input.mode === 'read' && input.read === 'books') return false;
  if (input.mode === 'meet' && !input.meetingNoteOpen) return false;
  if (input.tool !== 'pen' && input.tool !== 'aipen') return false;
  return !input.blocked;
}

/** 当前可见书写画布的矩形（host-local 物理 px）；非书写面/书架/非画笔工具/被遮挡 → null。 */
function visibleCanvasRect(): AreaRect | null {
  if (!shouldArmOnyxPenArea({
    writable: document.body.classList.contains('writable'),
    mode: document.body.dataset.mode,
    read: document.body.dataset.read,
    meetingNoteOpen: document.body.classList.contains('mtg-note-open'),
    tool: state.tool,
    blocked: canvasBlocked(),
  })) return null;
  // getBoundingClientRect 是 CSS px（相对 viewport = WebView host-local）；× dpr = 物理 px。
  // OnyxPenBridge.setLimitRect 要的正是 host-local 物理 px（不减屏幕原点），两边同一把尺。
  const dpr = window.devicePixelRatio || 1;
  const nodes = document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTORS);
  for (const el of nodes) {
    if (el.offsetParent === null) continue; // display:none / 祖先隐藏
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr, dpr };
    }
  }
  return null;
}

let lastSig = '';
function reportNow(): void {
  const ch = channel();
  if (!ch) return;
  const rect = visibleCanvasRect();
  const sig = rect ? `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}` : 'null';
  if (sig === lastSig) return; // 画区几何没变（写字/mark 重绘不改几何）→ 不重报，保持 arm、不打断书写
  lastSig = sig;
  try { ch.updateWritingArea(rect ? JSON.stringify(rect) : 'null'); } catch { /* no-op */ }
}

let reportRaf = 0;
function scheduleReport(): void {
  if (!channel() || reportRaf) return;
  reportRaf = requestAnimationFrame(() => { reportRaf = 0; reportNow(); });
}

/** 明确离开可写面时立即报 null（返回书架/刷新列表不能等下一轮 DOM 观察，否则原生画区会短暂盖在书架上）。 */
export function disarmOnyxPenAreaNow(): void {
  const ch = channel();
  if (!ch) return;
  lastSig = 'null';
  try { ch.updateWritingArea('null'); } catch { /* no-op */ }
}

let installed = false;
/** 安装 ONYX 画区上报。非 ONYX 直接跳过（no-op）。mobile-main 一行注册即可。 */
export function initOnyxPenArea(): void {
  if (installed || !channel()) return;
  installed = true;
  // 业务事件触发重算（经签名门；写字后 mark 重绘也发这些但几何不变→跳过）
  bus.on('page:rendered', scheduleReport);
  bus.on('view:changed', scheduleReport);
  bus.on('document:loaded', scheduleReport);
  bus.on('context:switched', scheduleReport);
  bus.on('tool', scheduleReport);
  bus.on('settings:changed', scheduleReport);
  bus.on('reader:vpage', scheduleReport); // 重排虚拟页翻动
  window.addEventListener('resize', scheduleReport);
  window.visualViewport?.addEventListener('resize', scheduleReport);
  window.visualViewport?.addEventListener('scroll', scheduleReport);
  document.addEventListener('scroll', scheduleReport, { capture: true, passive: true });
  document.addEventListener('visibilitychange', scheduleReport);
  // 导航/遮挡/画布移位靠广观察 DOM 变化（改 body class/dataset、reader 增删节点、画布 style 移位）
  const mo = new MutationObserver(scheduleReport);
  mo.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'data-mode', 'data-read', 'data-surface'],
  });
  setTimeout(reportNow, 600); // 首帧稳定后报一次
}
