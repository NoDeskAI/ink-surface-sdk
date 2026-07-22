// 移动版（电纸屏）外壳交互：导航脊顶层 mode 切换、阅读/dev 子导航、工具收纳、rail 折叠、文件浮层关闭。
// 原为 mobile.html 末尾的内联 <script>，抽出成模块（正规化）。行为与原内联脚本逐条等价，仅加空值守卫。
// 真数据/钻取（会议进入、dev 段切换、settings 绑定）仍由 mobile/meeting.ts、mobile/dev.ts controller 接管。
import { setTool, type Tool } from '../app/state';
import { inkToolFromControlKey } from '../core/ink-tool-controls';

const B = document.body;

const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(sel));
const byId = (v: string): HTMLElement | null => document.getElementById(v);
const FLOATING_TOOLS_KEY = 'inkloop.mobile.floating-tools.v1';
const FLOATING_TOOLS_DRAG_THRESHOLD_PX = 6;
const FLOATING_TOOLS_CLICK_SUPPRESS_MS = 500;

/** 设/清一个导航按钮的 on/dim 态 + 其所属 .rl-item 的 cur 态（与原内联脚本同义）。 */
function setBtn(b: HTMLElement, on: boolean): void {
  b.classList.toggle('on', on);
  b.classList.toggle('dim', !on);
  b.closest('.rl-item')?.classList.toggle('cur', on);
}

/** mode/read/mtg 组合决定当前面是否可书写（阅读原文 / 会中白板）。 */
function updateWritable(): void {
  const { mode, read, mtg } = B.dataset;
  const w =
    (mode === 'read' && read === 'book') ||
    (mode === 'meet' && mtg === 'live');
  B.classList.toggle('writable', w);
}

function isFloatingToolShell(): boolean {
  return B.dataset.mode === 'read' || B.dataset.mode === 'meet';
}

function clampFloatingTools(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - 56);
  const maxY = Math.max(8, window.innerHeight - 70);
  const minY = isFloatingToolShell() ? 86 : 8;
  return {
    x: Math.min(maxX, Math.max(8, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
}

function applyFloatingToolsPosition(pos: { x: number; y: number }): void {
  const next = clampFloatingTools(pos.x, pos.y);
  B.style.setProperty('--floating-tools-x', `${Math.round(next.x)}px`);
  B.style.setProperty('--floating-tools-y', `${Math.round(next.y)}px`);
}

function loadFloatingToolsPosition(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(FLOATING_TOOLS_KEY) || 'null') as { x?: number; y?: number } | null;
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) applyFloatingToolsPosition({ x: Number(raw.x), y: Number(raw.y) });
  } catch {
    // 损坏的本地位置不影响默认布局。
  }
}

function saveFloatingToolsPosition(pos: { x: number; y: number }): void {
  const next = clampFloatingTools(pos.x, pos.y);
  applyFloatingToolsPosition(next);
  try { localStorage.setItem(FLOATING_TOOLS_KEY, JSON.stringify(next)); } catch { /* no-op */ }
}

/** 切阅读子态：books/book/open。diary/new 保留为内部能力，不再作为普通用户入口。 */
function setRead(v: string): void {
  B.dataset.read = v;
  for (const b of $$('#read-sub [data-read]')) {
    setBtn(b, b.dataset.read === v || (v === 'open' && b.dataset.read === 'books'));
  }
  updateWritable();
}

let initialized = false;
export function initMobileShell(): void {
  if (initialized) return;
  initialized = true;

  // 顶层 mode（阅读/会议/dev）
  for (const b of $$('.nav [data-mode]')) {
    b.addEventListener('click', () => {
      for (const x of $$('.nav [data-mode]')) setBtn(x, false);
      setBtn(b, true);
      if (b.dataset.mode) B.dataset.mode = b.dataset.mode;
      if (b.dataset.mode === 'read') setRead('books');
      updateWritable(); // 会议进入 + 钻取/返回由 mobile/meeting.ts 接管（真数据）
    });
  }

  // 阅读子导航
  for (const b of $$('#read-sub [data-read]')) {
    b.addEventListener('click', () => { if (b.dataset.read) setRead(b.dataset.read); });
  }

  // dev 子导航
  for (const b of $$('#dev-sub [data-dev]')) {
    b.addEventListener('click', () => {
      for (const x of $$('#dev-sub [data-dev]')) setBtn(x, false);
      setBtn(b, true);
      if (b.dataset.dev) B.dataset.dev = b.dataset.dev;
    });
  }

  // 历史静态 open 页已隐藏，保留返回兜底到阅读书架。
  for (const row of $$('[data-open]')) row.addEventListener('click', () => setRead('open'));
  byId('open-back')?.addEventListener('click', () => setRead('books'));

  // 工具收纳：收起按钮切显隐 + 选工具回填图标
  const tt = byId('tools-toggle');
  const rail = byId('m-rail');
  loadFloatingToolsPosition();
  let drag: { pointerId: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  let suppressClickUntil = 0;
  const dragSurface = rail ?? tt;
  const toggleToolsOpen = (): void => {
    B.classList.toggle('tools-open');
    tt?.setAttribute('aria-expanded', B.classList.contains('tools-open') ? 'true' : 'false');
  };
  const suppressSyntheticClick = (): void => {
    suppressClickUntil = Date.now() + FLOATING_TOOLS_CLICK_SUPPRESS_MS;
  };
  dragSurface?.addEventListener('pointerdown', (e) => {
    if (!isFloatingToolShell() || !rail) return;
    const target = e.target instanceof Element ? e.target.closest('#tools-toggle') : null;
    if (!target) return;
    const r = rail.getBoundingClientRect();
    drag = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    try { dragSurface.setPointerCapture(e.pointerId); } catch { /* no-op */ }
    e.preventDefault();
  });
  dragSurface?.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < FLOATING_TOOLS_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    tt?.classList.add('dragging');
    applyFloatingToolsPosition({ x: drag.ox + dx, y: drag.oy + dy });
    e.preventDefault();
  });
  const clearPointerDrag = (e: PointerEvent): typeof drag | null => {
    if (!drag || e.pointerId !== drag.pointerId) return null;
    const done = drag;
    drag = null;
    tt?.classList.remove('dragging');
    try { dragSurface?.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    return done;
  };
  const finishDrag = (e: PointerEvent): void => {
    const done = clearPointerDrag(e);
    if (!done) return;
    if (!done.moved) {
      toggleToolsOpen();
      suppressSyntheticClick();
      e.preventDefault();
      return;
    }
    saveFloatingToolsPosition({ x: done.ox + e.clientX - done.sx, y: done.oy + e.clientY - done.sy });
    e.preventDefault();
  };
  const cancelDrag = (e: PointerEvent): void => {
    const done = clearPointerDrag(e);
    if (!done) return;
    e.preventDefault();
  };
  dragSurface?.addEventListener('pointerup', finishDrag);
  dragSurface?.addEventListener('pointercancel', cancelDrag);
  let touchDrag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  if (!('PointerEvent' in window)) {
    dragSurface?.addEventListener('touchstart', (e) => {
      if (!isFloatingToolShell() || !rail || e.touches.length !== 1) return;
      const target = e.target instanceof Element ? e.target.closest('#tools-toggle') : null;
      if (!target) return;
      const t = e.touches[0];
      const r = rail.getBoundingClientRect();
      touchDrag = { id: t.identifier, sx: t.clientX, sy: t.clientY, ox: r.left, oy: r.top, moved: false };
      e.preventDefault();
    }, { passive: false });
    dragSurface?.addEventListener('touchmove', (e) => {
      if (!touchDrag) return;
      const t = [...e.touches].find((item) => item.identifier === touchDrag?.id);
      if (!t) return;
      const dx = t.clientX - touchDrag.sx;
      const dy = t.clientY - touchDrag.sy;
      if (!touchDrag.moved && Math.hypot(dx, dy) < FLOATING_TOOLS_DRAG_THRESHOLD_PX) return;
      touchDrag.moved = true;
      tt?.classList.add('dragging');
      applyFloatingToolsPosition({ x: touchDrag.ox + dx, y: touchDrag.oy + dy });
      e.preventDefault();
    }, { passive: false });
    const finishTouchDrag = (e: TouchEvent): void => {
      if (!touchDrag) return;
      const done = touchDrag;
      const t = [...e.changedTouches].find((item) => item.identifier === done.id);
      if (!t) return;
      touchDrag = null;
      tt?.classList.remove('dragging');
      if (!done.moved) {
        toggleToolsOpen();
        suppressSyntheticClick();
        e.preventDefault();
        return;
      }
      saveFloatingToolsPosition({ x: done.ox + t.clientX - done.sx, y: done.oy + t.clientY - done.sy });
      e.preventDefault();
    };
    const cancelTouchDrag = (e: TouchEvent): void => {
      if (!touchDrag) return;
      touchDrag = null;
      tt?.classList.remove('dragging');
      e.preventDefault();
    };
    dragSurface?.addEventListener('touchend', finishTouchDrag, { passive: false });
    dragSurface?.addEventListener('touchcancel', cancelTouchDrag, { passive: false });
  }
  tt?.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    toggleToolsOpen();
  });
  window.addEventListener('resize', () => {
    const r = rail?.getBoundingClientRect();
    if (r) saveFloatingToolsPosition({ x: r.left, y: r.top });
  });
  for (const b of $$('[data-tool]')) {
    b.addEventListener('click', () => {
      const tool = inkToolFromControlKey(b.dataset.tool) as Tool | undefined;
      if (tool) setTool(tool);
      for (const x of $$('[data-tool]')) x.classList.remove('on');
      b.classList.add('on');
      const icon = b.querySelector('svg')?.cloneNode(true);
      const current = tt?.querySelector('.ti');
      if (icon instanceof Element && current) {
        icon.classList.add('ti');
        current.replaceWith(icon);
      }
    });
  }

  // rail 折叠 / 唤出
  byId('rl-collapse')?.addEventListener('click', () => B.classList.add('rail-off'));
  byId('m-tab')?.addEventListener('click', () => B.classList.remove('rail-off'));

  // 文件浮层关闭（书架/导入卡由 mobile-main 动态渲染并绑定）
  byId('files-x')?.addEventListener('click', () => B.classList.remove('files-open'));
  byId('scrim-files')?.addEventListener('click', () => B.classList.remove('files-open'));

  updateWritable();
}
