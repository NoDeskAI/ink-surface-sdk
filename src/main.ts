import './styles.css';
import { recordEvent, commitGesture, commitDigest } from './core/pipeline';
import { resolveGesture } from './core/gesture';
import { shortId } from './core/ids';
import { bus, state, settings } from './app/state';
import type { AnnotationEvent } from './core/contracts';
import { initRenderer, loadFile, gotoPage, setZoom, hasDocument } from './ui/renderer';
import { initInk } from './ui/ink';
import { initWhisper } from './ui/whisper';
import { initReader } from './ui/reader';
import { initInsightPanel } from './ui/insight-panel';
import { initToolbar } from './ui/toolbar';
import { initDevDrawer, toggleDrawer } from './ui/dev-drawer';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const STOP_WINDOW = 1200; // 手势会话窗：抬笔后静默此窗即算一次手势完成（即时旁注 / 符号对话）

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

let sessionTrace: string | null = null;
let pending: AnnotationEvent[] = [];
let stopTimer: number | undefined;
let idleTimer: number | undefined;

// 停顿综合按页累积本页所有标注（不清空：每轮综合都基于"全部标注"，替换上一条综述）
const digestByPage = new Map<string, AnnotationEvent[]>();
const pageBucket = (pid: string): AnnotationEvent[] => {
  if (!digestByPage.has(pid)) digestByPage.set(pid, []);
  return digestByPage.get(pid)!;
};

function cancelTimers(): void {
  window.clearTimeout(stopTimer);
  window.clearTimeout(idleTimer);
  pending = [];
  sessionTrace = null;
}

initInk($<HTMLCanvasElement>('ink-layer'), (stroke, pointerType, penUpAt) => {
  if (!sessionTrace) sessionTrace = shortId('trc');
  const evt = recordEvent(stroke, sessionTrace, pointerType, penUpAt);
  if (!evt) return;
  pending.push(evt);
  pageBucket(evt.page_id).push(evt);

  // 会话窗结算：把这次停笔解析成一个手势意图 → 按意图作答（圈/划/问/写）
  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    const batch = pending;
    pending = [];
    sessionTrace = null;
    if (settings.gesture.enabled && batch.length) {
      void commitGesture(batch, performance.now(), resolveGesture(batch));
    }
  }, STOP_WINDOW);

  // 停顿综合窗：每次落笔都重置，超时无新标注 → 综合本页所有标注
  if (settings.idle.enabled) {
    const pid = evt.page_id;
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      void commitDigest(pageBucket(pid).slice(), performance.now());
    }, settings.idle.seconds * 1000);
  }
});

// 设置变化时取消在途计时（避免旧设置下的延迟触发）
bus.on('settings:changed', cancelTimers);

initWhisper($('whisper-layer'));
initReader($('reader'));
initToolbar($('toolbar'));
initInsightPanel({
  cards: $('cards'),
  foot: $('panel-foot'),
  count: $('insight-count'),
});
initDevDrawer({
  drawer: $('dev-drawer'),
  ocrSelect: $<HTMLSelectElement>('ocr-provider'),
  inferSelect: $<HTMLSelectElement>('infer-provider'),
  metricsBody: $('metrics-body'),
  traceLog: $('trace-log'),
  selftest: $('selftest'),
  downloadBtn: $('dl-trace'),
  closeBtn: $('drawer-close'),
});

const fileIn = $<HTMLInputElement>('file-in');
fileIn.addEventListener('change', () => {
  const file = fileIn.files?.[0];
  if (file) void loadFile(file);
});

// 拖拽上传：拖到整个阅读区任意位置即可
const reading = $('reading');
const pickPdf = (list: FileList | undefined): File | undefined =>
  list ? [...list].find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) : undefined;

let dragDepth = 0;
const setDragging = (on: boolean) => reading.classList.toggle('dragover', on);

reading.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) setDragging(true);
});
reading.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
reading.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); }
});
reading.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const file = pickPdf(e.dataTransfer?.files);
  if (file) void loadFile(file);
});

bus.on('document:loaded', () => {
  document.body.classList.add('doc-loaded');
  $('empty-state').style.display = 'none';
  $('doc-name').textContent = state.fileName;
});

let lastPageId: string | null = null;
bus.on('page:rendered', () => {
  $('page-ind').textContent = `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
  // 翻页（非缩放重渲）时取消在途计时：别让旧页的停顿综合在新页触发
  if (state.pageId !== lastPageId) { lastPageId = state.pageId; cancelTimers(); }
});

$('prev').addEventListener('click', () => gotoPage(-1));
$('next').addEventListener('click', () => gotoPage(1));
$('zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.25));
$('zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.25));
$('dev-toggle').addEventListener('click', () => toggleDrawer());

const insight = $('insight');
$('insight-toggle').addEventListener('click', () => insight.classList.toggle('open'));

// 原版 PDF ⇄ 重排阅读
function applyViewMode(): void {
  const isReader = settings.viewMode === 'reader';
  $('reading').classList.toggle('reader', isReader);
  ($('reader') as HTMLElement).hidden = !isReader;
  ($('stage-wrap') as HTMLElement).style.display = isReader ? 'none' : '';
  const btn = $('view-toggle');
  btn.textContent = isReader ? '原版' : '重排';
  btn.classList.toggle('active', isReader);
}
$('view-toggle').addEventListener('click', () => {
  settings.viewMode = settings.viewMode === 'reader' ? 'page' : 'reader';
  applyViewMode();
  bus.emit('view:changed');
});

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.isContentEditable) return;
  if (e.key === 'ArrowLeft') gotoPage(-1);
  if (e.key === 'ArrowRight') gotoPage(1);
});

window.addEventListener('resize', () => {
  if (hasDocument()) setZoom(state.zoom); // 触发自适应重渲
});

declare global {
  interface Window { __inkloop?: { state: typeof state; settings: typeof settings; bus: typeof bus } }
}
window.__inkloop = { state, settings, bus };
