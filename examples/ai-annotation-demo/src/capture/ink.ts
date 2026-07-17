import type { StrokePoint } from '../core/contracts';
import { activePageRegions, normToPx, pageRegionAtPx, pxToNorm, pageCss } from '../core/transform';
import { trace } from '../core/trace';
import { bus, currentStrokes, getActiveContext, settings, state, strokeMarkIds, type Stroke, type Tool } from '../app/state';
import { recordInkSample } from '../local/bedrock-recorder';
import { styleFor } from './stroke-style';
import { signalInkArea } from '../surface/eink';
import { isHardwareEraserTip } from './m103-pen-eraser';
import { isPhysicalPenContact, isPhysicalFingerContact, isOsdActive, clearOsdInkAfterCommit, setPenDown, shouldUseOsdOnlyForStroke, registerOsdClearBarrier, takeLastPhysicalPenStroke, enterOnyxFastInk, exitOnyxFastInk, clearPhysicalPenStrokeBuffer } from './m103-input-source';
import { takeHqSocketStroke, type HqSocketPoint } from './m103-hqhw-socket';
import { publishM103RawPenStroke, type M103RawPenSource } from './m103-raw-pen-adapter';
import { isM103Device, isOnyxPaperDevice } from './m103-device';
import { isLikelyStylusPointer, shouldPersistNativeStrokeFromDrain } from './input-policy';
import { estimatePenDownAt } from './stroke-time';

let cv: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
export interface StrokeCaptureContext {
  documentId: string;
  pageId: string;
  pageIndex: number;
  contextId: string;
  strokesByPage: Map<string, Stroke[]>;
}

let live: { tool: Tool; points: StrokePoint[]; t0: number; penDownAt: number; pointerType: string; skipLiveDraw: boolean; capture: StrokeCaptureContext } | null = null;
let nav: { x0: number; y0: number; lastX: number; lastY: number; scrolled: boolean } | null = null;
let erasingOsd = false; // OSD 武装时的橡皮手势：抬笔要清掉 OSD 那条虚线拖影（橡皮走 eraseAt 早退、不进 finish）
/** 死区半径（CSS px）：逐 pointermove 丢掉与上一采样点相距 < 此值的 sub-px 抖动。
 *  借鉴 xournalpp Deadzone(1.3px)——在抖动发生时即抑制，让点按/手抖稳定落到 tap_region，
 *  而非事后靠总行程补救。真实笔画相邻点远大于此值，不受影响。 */
const DEADZONE_PX = 1.3;
let onStrokeComplete: ((stroke: Stroke, pointerType: string, penUpAt: number, capture: StrokeCaptureContext) => void) | null = null;

const SWIPE_MIN_PX = 60; // 横滑超过此距离且以横向为主 → 翻页
const NAV_SCROLL_MIN_PX = 4; // 手指竖拖超过这点再接管滚动，避免轻微抖动误动页面

// 日记白板零画布：判定 ink.ts 画布是不是当前活动写字面(白板/原版·非重排)。重排由 reader.ts 管。
function isOriginalInkSurface(): boolean {
  return state.surfaceType !== 'article' || settings.viewMode !== 'reader';
}

type NativePhysicalPenStroke = NonNullable<ReturnType<typeof takeLastPhysicalPenStroke>>;

function nativeRawPenSource(stroke: NativePhysicalPenStroke): M103RawPenSource {
  if (stroke.source === 'onyx_touch_helper') return 'onyx_touch_helper';
  return isOnyxPaperDevice() ? 'onyx_motion_event' : 'm103_motion_event';
}

function publishNativePhysicalPenStroke(
  stroke: NativePhysicalPenStroke,
  surfaceRect: DOMRect,
  surfaceId: string,
): void {
  const source = nativeRawPenSource(stroke);
  const isOnyx = source === 'onyx_touch_helper' || source === 'onyx_motion_event';
  publishM103RawPenStroke(stroke, {
    penId: isOnyx ? 'onyx_t10_wacom' : 'm103_hqhw_stylus',
    sessionId: state.documentId ?? (isOnyx ? 'onyx_session' : 'm103_session'),
    surfaceId,
    firmwareVersion: source === 'onyx_touch_helper'
      ? 'onyx-touch-helper'
      : source === 'onyx_motion_event'
        ? 'onyx-motion-event-fallback'
        : 'm103-motion-event-fallback',
    surfaceRect,
  }, source);
}

// 在途笔提交跟踪(镜像 reader)：finishCommitted 抬笔后 await 硬件 socket 点(≤160ms)才 push 进 model。这期间清 OSD
// 会用没这笔的 model redrawInk、清完就丢显示。注册成 OSD 清理屏障：清 OSD 前先等在途提交落定(见 m103-input-source)。
const pendingInkCommits = new Set<Promise<void>>();
let osdClearBarrierRegistered = false;
let nativeStrokeDrainTimer: number | undefined;
function trackInkCommit(p: Promise<void>): void {
  const guarded = p.catch(() => undefined);
  pendingInkCommits.add(guarded);
  void guarded.finally(() => pendingInkCommits.delete(guarded));
}
function waitPendingInkCommits(): Promise<void> {
  return pendingInkCommits.size ? Promise.allSettled([...pendingInkCommits]).then(() => undefined) : Promise.resolve();
}

function nativeStrokeIsEraser(stroke: NativePhysicalPenStroke): boolean {
  return stroke.points.some((point) => point.flag === 321);
}

function captureForNativeStroke(stroke: NativePhysicalPenStroke): StrokeCaptureContext | null {
  if (!cv || !state.documentId || !state.pageId || !stroke.points.length) return null;
  const rect = cv.getBoundingClientRect();
  const first = stroke.points[0];
  const x = first.x - rect.left;
  const y = first.y - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
  const region = pageRegionAtPx(x, y);
  const activeContext = getActiveContext();
  return {
    documentId: state.documentId,
    pageId: region?.pageId ?? state.pageId,
    pageIndex: region?.pageIndex ?? state.pageIndex,
    contextId: activeContext.id,
    strokesByPage: activeContext.strokesByPage,
  };
}

function drainNativePhysicalPenQueue(): void {
  if (!cv || !onStrokeComplete || live || pendingInkCommits.size) return;
  if (!state.documentId || !state.pageId || settings.viewMode === 'reader') return;
  for (let i = 0; i < 8; i++) {
    const nativeStroke = takeLastPhysicalPenStroke();
    if (!nativeStroke) return;
    if (!shouldPersistNativeStrokeFromDrain({ activeTool: state.tool, nativeIsEraser: nativeStrokeIsEraser(nativeStroke) })) continue;
    const capture = captureForNativeStroke(nativeStroke);
    if (!capture) continue;
    const points = socketToNorm(nativeStroke.points, capture.pageId);
    if (!points.length) continue;
    publishNativePhysicalPenStroke(nativeStroke, cv.getBoundingClientRect(), capture.pageId);
    drawStroke(points, state.tool, capture.pageId);
    const stroke: Stroke = { tool: state.tool, points, penDownAt: estimatePenDownAt(points) };
    const pageStrokes = capture.strokesByPage.get(capture.pageId) ?? [];
    pageStrokes.push(stroke);
    capture.strokesByPage.set(capture.pageId, pageStrokes);
    onStrokeComplete(stroke, 'pen', performance.now(), capture);
  }
}

/**
 * 输入意图分流 —— 笔 / 手指的「硬件接口」，policy 只在这一处：
 *  - pointerType 'pen'   → 标注（触控笔，带真压感）
 *  - pointerType 'touch' → 导航（手指：横划翻页 / 竖划滚动 / 点按），绝不画墨
 *  - 鼠标(桌面/preview)  → 跟随当前工具：hand 翻页，其它落笔（便于桌面调试）
 * 2026-06-30 M103：设备有独立笔(huion·真压感)与手指(FocalTech)两套数字化仪，Android 原生区分 pen/touch，
 *   故按 pointerType 硬分流——笔写、手指导航，掌/指落画布天然不画墨(palm rejection 免费)。
 *   旧 RK3588(纯电容枚举 'touch'·手指即笔) 的「手指默认能写、切 hand 才翻页」假设在此弃用。
 * 2026-07-01：`HqHwBridge` 武装厂商快速手写模式后 `pointerType` 会被弄脏(笔被误报成 touch)，
 *   优先信 `isPhysicalPenContact`/`isPhysicalFingerContact`(M103 上会咨询原生的权威判断，
 *   其它设备/没有覆盖信息时等价于原来直接看 e.pointerType)。
 */
function resolveIntent(e: PointerEvent): 'annotate' | 'navigate' {
  const stylusLike = isLikelyStylusPointer({ pointerType: e.pointerType, pressure: e.pressure, width: e.width, height: e.height });
  if (isPhysicalPenContact(e)) return 'annotate';
  if (stylusLike) return 'annotate';
  if (isPhysicalFingerContact(e)) return 'navigate';
  return state.tool === 'hand' ? 'navigate' : 'annotate'; // mouse：桌面调试保留旧行为
}

function drawSeg(a: StrokePoint, b: StrokePoint, tool: Tool, pageId?: string | null): void {
  const dpr = window.devicePixelRatio || 1;
  const s = styleFor(tool, b.pressure);
  const p1 = normToPx(a.x, a.y, pageId);
  const p2 = normToPx(b.x, b.y, pageId);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = s.composite;
  ctx.strokeStyle = s.stroke;
  ctx.lineCap = s.cap;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function drawDot(p: StrokePoint, tool: Tool, pageId?: string | null): void {
  const dpr = window.devicePixelRatio || 1;
  const s = styleFor(tool, p.pressure);
  const px = normToPx(p.x, p.y, pageId);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = s.composite;
  ctx.fillStyle = s.stroke;
  ctx.beginPath();
  ctx.arc(px.x, px.y, Math.max(1, s.width / 2), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/** M103 硬件 socket 点(WebView CSS 视口坐标) → 页归一化 StrokePoint。与 evtNorm 同系(减画布 rect→pxToNorm)。 */
function socketToNorm(points: HqSocketPoint[], pageId?: string | null): StrokePoint[] {
  const r = cv.getBoundingClientRect();
  return points.map((p) => ({ ...pxToNorm(p.x - r.left, p.y - r.top, pageId), t: p.t, pressure: p.pressure }));
}

function drawStroke(points: StrokePoint[], tool: Tool, pageId?: string | null): void {
  if (points.length === 1) { drawDot(points[0], tool, pageId); return; }
  for (let i = 1; i < points.length; i++) drawSeg(points[i - 1], points[i], tool, pageId);
}

export function redrawInk(): void {
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = Math.max(pageCss.w, ...activePageRegions().map((r) => r.x + r.w));
  const height = Math.max(pageCss.h, ...activePageRegions().map((r) => r.y + r.h));
  ctx.clearRect(0, 0, width, height);
  const regions = activePageRegions();
  if (regions.length) {
    for (const region of regions) {
      const strokes = state.strokesByPage.get(region.pageId) ?? [];
      for (const s of strokes) drawStroke(s.points, s.tool, region.pageId);
    }
  } else {
    for (const s of currentStrokes()) drawStroke(s.points, s.tool);
  }
}

function evtPx(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function evtNorm(e: { clientX: number; clientY: number }, pageId?: string | null): { x: number; y: number } {
  const p = evtPx(e);
  return pxToNorm(p.x, p.y, pageId);
}

function scrollHost(): HTMLElement | null {
  return cv.closest<HTMLElement>('#stage-wrap');
}

/** 基岩录制 tap（Tier 1·影子·死区前）。features.bedrock 关时立即返回、零开销。 */
function bedrockTap(e: PointerEvent, p: { x: number; y: number }, phase: 'down' | 'move' | 'up', pageId = state.pageId ?? undefined): void {
  if (!settings.bedrock || !state.documentId) return;
  recordInkSample({
    documentId: state.documentId, pageId,
    x: p.x, y: p.y, phase, contactId: e.pointerId,
    pressure: e.pressure, dims: { w: pageCss.w, h: pageCss.h },
    penSource: isPhysicalPenContact(e), surface: 'article',
  });
}

function eraseAt(e: PointerEvent): void {
  const pxy = evtPx(e);
  const region = pageRegionAtPx(pxy.x, pxy.y);
  const pageId = region?.pageId ?? state.pageId;
  const p = evtNorm(e, pageId);
  const strokes = pageId ? (state.strokesByPage.get(pageId) ?? currentStrokes()) : currentStrokes();
  const hitRadius = 10 / Math.max(region?.w ?? pageCss.w, 1); // ~10px
  for (let i = strokes.length - 1; i >= 0; i--) {
    const aspect = (region?.h ?? pageCss.h) / Math.max(region?.w ?? pageCss.w, 1);
    const hit = strokes[i].points.some((pt) => Math.hypot(pt.x - p.x, (pt.y - p.y) * aspect) < hitRadius);
    if (hit) { eraseStroke(strokes[i], 'erase'); return; }
  }
}

/**
 * 擦/撤一笔：若该笔已属于某 mark（组装过、已落账本）→ 擦掉整 mark（移除其全部笔 + 发 mark:erase
 * 让 main 落 tombstone）；否则（尚未组装的在途笔）只移这一笔，无需 tombstone（它还没持久化）。
 */
function eraseStroke(stroke: Stroke, reason: 'erase' | 'undo'): void {
  let strokes = currentStrokes();
  for (const arr of state.strokesByPage.values()) {
    if (arr.includes(stroke)) { strokes = arr; break; }
  }
  const mid = strokeMarkIds.get(stroke);
  // 被擦笔集合（命中 mark→整组·否则单笔）：留它们的点算脏区，擦完发 A2 局部刷——
  // 否则电纸屏上画布重画了但不更新（橡皮"擦了没反应"·用户实测漏的就是这个）。
  const erased = mid ? strokes.filter((s) => strokeMarkIds.get(s) === mid) : [stroke];
  if (mid) {
    for (let k = strokes.length - 1; k >= 0; k--) if (strokeMarkIds.get(strokes[k]) === mid) strokes.splice(k, 1);
    bus.emit('mark:erase', mid); // → main: 落 mark tombstone + 从 session 移除
  } else {
    const k = strokes.indexOf(stroke);
    if (k >= 0) strokes.splice(k, 1);
    bus.emit('stroke:cancel', stroke); // 撤 pending 组装：否则 6s 内擦的在途笔仍 assemble 成 mark、reload 复活（两面共有的老洞）
  }
  trace(reason === 'undo' ? 'StrokeUndone' : 'StrokeErased', { page_id: state.pageId ?? '', mark_id: mid ?? '' });
  redrawInk();
  const pts = erased.flatMap((s) => s.points);
  if (pts.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    signalInkArea([x0, y0, x1 - x0, y1 - y0]); // 页归一化 bbox → #ink-layer 映射 → A2 局部刷（原版画布）
  }
}

export function undoStroke(): void {
  const strokes = currentStrokes();
  if (!strokes.length) return;
  eraseStroke(strokes[strokes.length - 1], 'undo');
}

export function initInk(
  canvas: HTMLCanvasElement,
  complete: (stroke: Stroke, pointerType: string, penUpAt: number, capture: StrokeCaptureContext) => void,
): void {
  cv = canvas;
  ctx = canvas.getContext('2d', { desynchronized: true })!;
  onStrokeComplete = complete;
  if (nativeStrokeDrainTimer === undefined) {
    nativeStrokeDrainTimer = window.setInterval(drainNativePhysicalPenQueue, 120);
  }

  cv.addEventListener('pointerdown', (e) => {
    if (!state.documentId || !state.pageId) return;
    // 手指/手型 → 导航：记起点，抬笔时判横滑翻页（不进笔迹采集）
    if (resolveIntent(e) === 'navigate') {
      e.preventDefault();
      nav = { x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, scrolled: false };
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      return;
    }
    e.preventDefault();
    enterOnyxFastInk(e);
    // 物理橡皮头(M103 专用)不看当前选的工具，就跟真实铅笔一样翻过来就能擦。
    if (state.tool === 'eraser' || isHardwareEraserTip(e)) {
      clearPhysicalPenStrokeBuffer();
      if (isOsdActive()) erasingOsd = true;
      eraseAt(e);
      return;
    }
    setPenDown(true); // 笔落纸：写字期间彻底不碰画布(见 maybeClearOsd)——程序滚动不再触发清 OSD/resizeInk
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const startPx = evtPx(e);
    const region = pageRegionAtPx(startPx.x, startPx.y);
    const capturePageId = region?.pageId ?? state.pageId;
    const capturePageIndex = region?.pageIndex ?? state.pageIndex;
    const p = evtNorm(e, capturePageId);
    const activeContext = getActiveContext();
    const capture: StrokeCaptureContext = {
      documentId: state.documentId,
      pageId: capturePageId,
      pageIndex: capturePageIndex,
      contextId: activeContext.id,
      strokesByPage: activeContext.strokesByPage,
    };
    // OSD 快速墨迹武装成功时(2026-07-01 真机 logcat 实锤 drawserver 真在刷我们的笔)，写的过程中信 OSD
    // 硬件层做即时视觉，自己别跟着实时画——否则"OSD 实时刷一层 + 我们画布又实时刷一层"两套墨迹叠加、
    // 反而难看。抬笔时(finish)补画一整笔进画布做持久真相(页面刷新/翻页后靠它从 model 重绘)。
    // M103 的 OSD 已被真机验证为独立实时墨迹层，可以完全跳过 WebView live draw。
    // T10/ONYX 的 TouchHelper raw rendering 在部分固件上会返回 true 但视觉层不实时出墨；
    // 如果这里也跳过 canvas，用户就只能在抬笔后看到 finishCommitted 补画的整笔。
    // 因此 ONYX 仍进入 fast update/raw capture，但 WebView canvas 保持实时绘制作为稳定兜底。
    const skipLiveDraw = shouldUseOsdOnlyForStroke(e);
    if (!skipLiveDraw) drawDot({ x: p.x, y: p.y, t: 0, pressure: e.pressure || 0 }, state.tool, capture.pageId);
    live = {
      tool: state.tool,
      t0: performance.now(),
      penDownAt: Date.now(),
      pointerType: isPhysicalPenContact(e) ? 'pen' : e.pointerType, // 落库用的身份别信可能被弄脏的 e.pointerType
      points: [{ x: p.x, y: p.y, t: 0, pressure: e.pressure || 0 }],
      skipLiveDraw,
      capture,
    };
    bedrockTap(e, p, 'down', capture.pageId);
  });

  cv.addEventListener('pointermove', (e) => {
    if (nav) {
      e.preventDefault();
      const dx = e.clientX - nav.lastX;
      const dy = e.clientY - nav.lastY;
      const totalY = e.clientY - nav.y0;
      nav.lastX = e.clientX;
      nav.lastY = e.clientY;
      if (nav.scrolled || Math.abs(totalY) > NAV_SCROLL_MIN_PX || Math.abs(dy) > Math.abs(dx)) {
        const host = scrollHost();
        if (host) {
          host.scrollTop -= dy;
          nav.scrolled = nav.scrolled || Math.abs(totalY) > NAV_SCROLL_MIN_PX;
        }
      }
      return;
    }
    if ((state.tool === 'eraser' || isHardwareEraserTip(e)) && e.buttons) {
      clearPhysicalPenStrokeBuffer();
      if (isOsdActive()) erasingOsd = true;
      eraseAt(e);
      return;
    }
    if (!live) return;
    e.preventDefault();
    // 无损：优先取全部合并点；合成事件/旧内核返回空数组时回退到事件本身
    let raw: PointerEvent[] = e.getCoalescedEvents ? (e.getCoalescedEvents() as PointerEvent[]) : [];
    if (!raw.length) raw = [e];
    for (const ce of raw) {
      const p = evtNorm(ce, live.capture.pageId);
      bedrockTap(ce, p, 'move', live.capture.pageId); // 死区前：连手抖也录下来
      const last = live.points[live.points.length - 1];
      // 死区：与上一点相距 < DEADZONE_PX(CSS px) 的 sub-px 抖动直接丢，稳 tap 判定（页面未渲染时 pageCss=0，跳过死区）
      if (pageCss.w && pageCss.h && Math.hypot((p.x - last.x) * pageCss.w, (p.y - last.y) * pageCss.h) < DEADZONE_PX) continue;
      const pt: StrokePoint = {
        x: p.x, y: p.y,
        t: Math.round(performance.now() - live.t0),
        pressure: ce.pressure || 0,
      };
      if (!live.skipLiveDraw) drawSeg(last, pt, live.tool, live.capture.pageId);
      live.points.push(pt);
    }
  });

  const finish = () => {
    if (!live) return;
    const st = live;
    const penUpAt = performance.now();
    live = null; // 立刻让出 live，异步领硬件点期间下一笔可正常开始
    trackInkCommit(finishCommitted(st, penUpAt)); // 跟踪在途提交：清 OSD 屏障先等它落定，防 160ms socket 窗口清 OSD 丢最后一笔显示
  };

  // OSD 武装时(skipLiveDraw)抬笔：领同源硬件 socket 点画整笔 + 喂 model。**关键：这台设备 WebView 指针坐标有
  // 偏移，硬件 socket 点才是真实落点(和 OSD 对齐)**——用 WebView 点补画会和 OSD 错位(用户实测"重画没对齐、端点像
  // 多出个点")、且落库数据也偏。socket 抬笔后几毫秒即到(fallback 160ms 仅 socket 缺包时·罕见)。非 OSD 路径同步走。
  async function finishCommitted(st: NonNullable<typeof live>, penUpAt: number): Promise<void> {
    let points = st.points;
    let nativePublished = false;
    if (st.skipLiveDraw) {
      const socket = isM103Device() ? await takeHqSocketStroke(st.t0, 160) : null;
      if (socket?.points.length) {
        points = socketToNorm(socket.points, st.capture.pageId);
        publishM103RawPenStroke(socket, {
          penId: 'm103_hqhw_stylus',
          sessionId: state.documentId ?? 'm103_session',
          surfaceId: st.capture.pageId ?? 'm103_surface',
          firmwareVersion: 'm103-hqhw-bridge',
          surfaceRect: cv.getBoundingClientRect(),
        });
        nativePublished = true;
      } else {
        const motion = takeLastPhysicalPenStroke();
        if (motion?.points.length) {
          points = socketToNorm(motion.points, st.capture.pageId);
          publishNativePhysicalPenStroke(motion, cv.getBoundingClientRect(), st.capture.pageId ?? 'native_surface');
          nativePublished = true;
        }
      }
      // 日记白板零画布：不补画 #ink-layer(靠 ink_ref 给 AI + osd:will-clear/AI笔点击时从 model 一次性重绘做显示)——写字全程不刷屏。
      // 书籍原版/PDF 仍补画持久真相(其 markup/composite 取证依赖 #ink-layer·不动·零回归)。
      if (state.surfaceType !== 'whiteboard') drawStroke(points, st.tool, st.capture.pageId);
    } else if (!nativePublished && st.pointerType === 'pen') {
      const motion = takeLastPhysicalPenStroke();
      if (motion?.points.length) {
        publishNativePhysicalPenStroke(motion, cv.getBoundingClientRect(), st.capture.pageId ?? 'native_surface');
      }
    }
    const stroke: Stroke = { tool: st.tool, points, penDownAt: st.penDownAt };
    const pageStrokes = st.capture.strokesByPage.get(st.capture.pageId) ?? [];
    pageStrokes.push(stroke);
    st.capture.strokesByPage.set(st.capture.pageId, pageStrokes);
    onStrokeComplete?.(stroke, st.pointerType, penUpAt, st.capture);
  }

  // 导航抬笔：横滑距离够且以横向为主 → 翻页（左滑下一页、右滑上一页）。main.ts 接 nav:flip。
  const finishNav = (e: PointerEvent) => {
    if (!nav) return;
    const dx = e.clientX - nav.x0, dy = e.clientY - nav.y0;
    const scrolled = nav.scrolled;
    nav = null;
    if (scrolled) return;
    if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) bus.emit('nav:flip', dx < 0 ? 1 : -1);
  };

  cv.addEventListener('pointerup', (e) => {
    setPenDown(false); // 抬笔：恢复画布清理(翻页/滚动交接可清)
    exitOnyxFastInk();
    if (erasingOsd) { erasingOsd = false; clearPhysicalPenStrokeBuffer(); clearOsdInkAfterCommit(); } // 橡皮抬笔：清掉 OSD 虚线拖影
    if (nav) finishNav(e); else { bedrockTap(e, evtNorm(e, live?.capture.pageId), 'up', live?.capture.pageId ?? undefined); finish(); }
  });
  cv.addEventListener('pointercancel', () => { setPenDown(false); exitOnyxFastInk(); live = null; nav = null; if (erasingOsd) { erasingOsd = false; clearOsdInkAfterCommit(); } });

  bus.on('page:rendered', () => redrawInk());
  bus.on('tool', () => {
    cv.style.cursor = state.tool === 'eraser' ? 'cell' : state.tool === 'hand' ? 'grab' : 'crosshair';
    // 用户要的"点击 AI 笔触发一次重刷"：白板零画布写字时内容只在 OSD 上，切到 AI 笔时把已写内容一次性重绘到 #ink-layer
    // (经 osd:will-clear→redrawInk)并清 OSD——进 AI 模式立刻看得见自己写了啥。非 M103/无 OSD 时 clearOsdInkAfterCommit no-op。
    if (state.tool === 'aipen' && isOriginalInkSurface()) clearOsdInkAfterCommit();
  });
  // 清 OSD 交接：白板/原版面(非重排)在清 OSD 前把 #ink-layer 从 model 重绘出来，OSD 清后笔不消失(镜像 reader 的 osd:will-clear→resizeInk)。
  bus.on('osd:will-clear', () => { if (isOriginalInkSurface()) redrawInk(); });
  // 清 OSD 前先等 ink 面在途笔提交落定(只原版态·非 M103 端 clearOsdInkAfterCommit 本就 no-op)。注册一次。
  if (!osdClearBarrierRegistered) {
    registerOsdClearBarrier(() => (isOriginalInkSurface() ? waitPendingInkCommits() : undefined));
    osdClearBarrierRegistered = true;
  }
}
