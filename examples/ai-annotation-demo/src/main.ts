import './core/polyfills'; // 必须最先：老 WebView 补 Promise.withResolvers（pdf.js 用到）
import './styles.css';
import './components/mark-drawer.css';
import { installDoubleTapZoomGuard } from './core/viewport-guard';
import { bus, state, settings, saveSettings, getActiveContext } from './app/state';
import type { SurfaceContext } from './app/surface-context';
import type { NormBBox, ScreenOverlay } from './core/contracts';
import { normToPx, pageCss, pageRegionForId } from './core/transform';
import { listLibraryItems, loadPdfBlob, setDocCoverImageDataUrl, setLastReadPage, type LibraryShelfItem } from './local/store';
import { extractDocumentCoverImageDataUrl, initRenderer, loadFile, reopenBook, renderPage, renderSyntheticSurface, gotoPage, setZoom, hasDocument } from './surface/renderer';
import { initWhisper } from './surface/whisper';
import { initReader, readerFocusOverlay } from './surface/reader';
import { initAnchorLayer } from './surface/anchor-layer';
import { initInsightPanel } from './surface/insight-panel';
import { initToolbar } from './surface/toolbar';
import { initDevOverlay } from './dev/dev-overlay';
import { initEinkMirror } from './surface/eink';
import { features } from './config/features';
import { restoreLedgerState } from './controllers/ledger-restore';
import { wireAnnotationLoop, flushRegion } from './app/annotation-loop';
import { hydrateRuntimeAnnotationsToActiveCanvas, installWebRuntimeSyncHost } from './integration/inksurface/runtime-sync-host';
import { initRuntimeSyncStatus } from './components/runtime-sync-status';
import { deleteCloudLibraryItem, downloadCloudLibraryItem, hasCloudLibraryItem, libraryItemAction, recordLocalImportedSource, startLibrarySyncLoop, uploadLoadedDocumentSource, type LibraryImportProgress } from './integration/inksurface/library-sync';
import { getSession, setSession } from './core/auth';
import { renderLibraryShelf } from './components/library-shelf';
import {
  pageLayoutControlsAvailable,
  pdfOriginalControlsAvailable,
  readingControlsUnavailableHint,
  readingExperienceForSource,
  type ReadingExperience,
} from './core/reading-experience';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const INSTALL_KEY = 'inkloop.install_id.v1';
const LOCAL_DEMO_AUTH = import.meta.env.VITE_INKLOOP_LOCAL_DEMO_AUTH === '1'
  || (import.meta.env.DEV && import.meta.env.VITE_INKLOOP_LOCAL_DEMO_AUTH !== '0');
const LOCAL_DEMO_TENANT_ID = (import.meta.env.VITE_INKLOOP_LOCAL_DEMO_TENANT_ID as string | undefined) || 'local';
const LOCAL_DEMO_USER_ID = (import.meta.env.VITE_INKLOOP_LOCAL_DEMO_USER_ID as string | undefined) || 'local_demo';

function installId(): string {
  let id = localStorage.getItem(INSTALL_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(INSTALL_KEY, id);
  }
  return id;
}

function ensureLocalDemoSession(): void {
  if (!LOCAL_DEMO_AUTH || getSession()) return;
  setSession({
    sessionId: 'local-demo-session',
    sessionToken: 'local-demo-token',
    tenantId: LOCAL_DEMO_TENANT_ID,
    userId: LOCAL_DEMO_USER_ID,
    deviceId: `web-${installId()}`,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
  });
}

ensureLocalDemoSession();
installDoubleTapZoomGuard();

initRenderer({
  pageLayer: $<HTMLCanvasElement>('page-layer'),
  inkLayer: $<HTMLCanvasElement>('ink-layer'),
  stage: $('stage'),
  stageWrap: $('stage-wrap'),
});

// 标注会话编排（区域组装→收口→综合→旁注）抽到 app/annotation-loop，桌面与移动版共用同一份、传各自的 #ink 画布。
wireAnnotationLoop($<HTMLCanvasElement>('ink-layer'));
const runtimeSyncHost = installWebRuntimeSyncHost({
  logger: (event, details) => console.debug(`[${event}]`, details),
});
initRuntimeSyncStatus();

initWhisper($('whisper-layer'), { fold: true });
initAnchorLayer($('stage'));
initReader($('reader'), { replyMode: true });
initToolbar($('toolbar'));
initInsightPanel({
  cards: $('cards'),
  foot: $('panel-foot'),
  count: $('insight-count'),
});
initDevOverlay(); // 画布叠层（独立于旧 dev 抽屉，由设置页 devOverlay/showRegion/showRelations 控）
// 桌面 dev 导航壳不属于 V1 阅读主线。需要调试页时显式打开：
//   http://localhost:5173/?devnav=1
// 或 localStorage.setItem('inkloop.devnav','1')
function devNavEnabled(): boolean {
  if (new URLSearchParams(location.search).get('devnav') === '1') return true;
  try { return localStorage.getItem('inkloop.devnav') === '1'; } catch { return false; }
}
if (devNavEnabled()) {
  void import('./dev/console').then(({ initNavShell }) => {
    initNavShell();
    // 窄屏(电纸屏竖向 / 手机)：导航栏默认收起为抽屉，避免在 ~405px 宽挤占正文。
    if (window.matchMedia('(max-width: 640px)').matches) document.body.classList.add('rail-collapsed');
  });
}
if (features.einkBridge) initEinkMirror(); // 电纸屏镜像：套壳内容变化 → 推 IT8951（web/dev 无桥则 no-op；D1 flag 可关）

const fileIn = $<HTMLInputElement>('file-in');
fileIn.addEventListener('change', () => {
  const file = fileIn.files?.[0];
  fileIn.value = '';
  if (file) void importAndSyncFile(file);
});

const importStatus = $('import-status');
let importRunSeq = 0;
const activeLibraryActionIds = new Set<string>();

function importPhaseLabel(phase: LibraryImportProgress['phase']): string {
  if (phase === 'hashing') return '准备导入';
  if (phase === 'queued') return '已入队';
  if (phase === 'encoding') return '读取文件';
  if (phase === 'uploading') return '上传中';
  if (phase === 'cloud_ready') return '云端已保存';
  if (phase === 'downloading') return '下载中';
  if (phase === 'waiting') return '等待同步';
  if (phase === 'local_opening') return '本机打开';
  if (phase === 'local_ready') return '完成';
  return '导入失败';
}

function showImportStatus(progress: LibraryImportProgress): void {
  importStatus.hidden = false;
  importStatus.classList.toggle('error', progress.phase === 'failed');
  importStatus.classList.toggle('done', progress.phase === 'local_ready' || progress.phase === 'cloud_ready');
  importStatus.classList.toggle('indeterminate', !!progress.indeterminate);
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
  importStatus.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'import-status-head';
  const title = document.createElement('span');
  title.textContent = `${importPhaseLabel(progress.phase)} · ${progress.filename}`;
  const value = document.createElement('b');
  value.textContent = progress.indeterminate ? '...' : `${percent}%`;
  head.append(title, value);
  const bar = document.createElement('div');
  bar.className = 'import-status-bar';
  const fill = document.createElement('span');
  fill.style.width = progress.indeterminate ? '0%' : `${percent}%`;
  bar.appendChild(fill);
  const detail = document.createElement('div');
  detail.className = 'import-status-detail';
  detail.textContent = progress.detail || '';
  importStatus.append(head, bar, detail);
}

function hideImportStatusLater(seq: number): void {
  window.setTimeout(() => {
    if (seq === importRunSeq) importStatus.hidden = true;
  }, 2200);
}

function hideCurrentStatusLater(): void {
  const seq = importRunSeq;
  hideImportStatusLater(seq);
}

function showLibraryHome(): void {
  importStatus.hidden = true;
  document.body.classList.remove('doc-loaded');
  $('empty-state').style.display = '';
  $('reading').classList.remove('reader');
  ($('reader') as HTMLElement).hidden = true;
  ($('stage-wrap') as HTMLElement).style.display = '';
  $('doc-name').textContent = '';
  $('page-ind').textContent = '';
  insight.classList.remove('open');
  void refreshLibrary();
}

async function refreshLibrary(): Promise<void> {
  await renderRecent(recentBooks, { withCap: true });
}

async function importAndSyncFile(file: File): Promise<void> {
  const seq = ++importRunSeq;
  const onProgress = (progress: LibraryImportProgress): void => {
    if (seq !== importRunSeq) return;
    showImportStatus(progress);
    if (progress.phase !== 'hashing' && progress.phase !== 'encoding') void refreshLibrary();
  };

  try {
    onProgress({ phase: 'local_opening', filename: file.name || 'untitled', percent: 15, detail: '本机解析并打开文档' });
    const loaded = await loadFile(file);
    if (!loaded) throw new Error('document_not_loaded');
    await recordLocalImportedSource(file, loaded, 'web');
    onProgress({ phase: 'local_ready', filename: loaded.filename, documentId: loaded.documentId, percent: 55, detail: '本机已可读，后台同步 Cloud Hub' });
    void refreshLibrary();
    void uploadLoadedDocumentSource(file, loaded, 'web', { onProgress }).then((ok) => {
      if (ok) hideImportStatusLater(seq);
    });
  } catch (error) {
    onProgress({ phase: 'failed', filename: file.name || 'untitled', percent: 100, detail: `本机导入失败：${String((error as Error)?.message || error)}` });
    void refreshLibrary();
  }
}

// ── 书架：列出已持久存储的书，点击免重导打开（阶段一）──
const recentBooks = $('recent-books');
const shelfCoverHydrationIds = new Set<string>();

async function hydrateShelfCoverIfNeeded(item: LibraryShelfItem): Promise<void> {
  if (item.doc?.cover_image_data_url || item.cover_image_data_url || !item.local_available) return;
  if (shelfCoverHydrationIds.has(item.document_id)) return;
  shelfCoverHydrationIds.add(item.document_id);
  try {
    const blob = await loadPdfBlob(item.document_id);
    if (!blob) return;
    const cover = await extractDocumentCoverImageDataUrl(await blob.arrayBuffer(), item.filename, item.mime_type || blob.type);
    if (!cover) return;
    await setDocCoverImageDataUrl(item.document_id, cover);
    await refreshLibrary();
  } catch {
    // 封面是可再生缓存，失败不影响导入、阅读或同步。
  } finally {
    shelfCoverHydrationIds.delete(item.document_id);
  }
}

async function renderRecent(container: HTMLElement, opts?: { withCap?: boolean; emptyHint?: boolean }): Promise<void> {
  const books = await listLibraryItems();
  renderLibraryShelf(container, books, {
    mode: 'web',
    title: undefined,
    caption: undefined,
    emptyHint: opts?.emptyHint ? '还没有已保存的书' : undefined,
    activeDocumentIds: activeLibraryActionIds,
    showMeta: false,
    showStatus: true,
    showAction: true,
    onOpen: openLibraryItem,
    onDelete: deleteLibraryBook,
    onCoverHydrateNeeded: (item) => void hydrateShelfCoverIfNeeded(item),
    onImport: () => fileIn.click(),
  });
}

interface DeleteLibraryBookChoice {
  confirmed: boolean;
  deleteCloud: boolean;
}

function libraryDeleteDetail(result: Awaited<ReturnType<typeof deleteCloudLibraryItem>>, deleteCloud: boolean, hadCloudCopy: boolean): string {
  if (result.cloudError) return `已从本机删除；Cloud Hub 删除未完成：${result.cloudError}`;
  if (deleteCloud && hadCloudCopy) return '已从本机和 Cloud Hub 删除';
  if (hadCloudCopy) return '已删除本机副本，Cloud Hub 书架保留';
  return '已从本机书架删除';
}

function askDeleteLibraryBook(item: LibraryShelfItem): Promise<DeleteLibraryBookChoice> {
  const title = item.filename.replace(/\.(pdf|epub|md|markdown)$/i, '') || item.filename;
  const hadCloudCopy = hasCloudLibraryItem(item);
  return new Promise((resolve) => {
    let settled = false;
    const scrim = document.createElement('div');
    scrim.className = 'app-dialog-scrim';
    scrim.setAttribute('role', 'presentation');

    const dialog = document.createElement('section');
    dialog.className = 'app-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'delete-book-dialog-title');

    const heading = document.createElement('h2');
    heading.id = 'delete-book-dialog-title';
    heading.textContent = '删除书籍';

    const message = document.createElement('p');
    message.className = 'app-dialog-message';
    message.textContent = hadCloudCopy
      ? `删除《${title}》的本机副本？会移除本机源文件、阅读进度、标记和 AI 记录。Cloud Hub 默认保留，之后可从书架重新下载。`
      : `删除《${title}》？这本书没有 Cloud Hub 副本，会从本机书架移除源文件、阅读进度、标记和 AI 记录。`;

    let cloudInput: HTMLInputElement | undefined;
    if (hadCloudCopy) {
      const label = document.createElement('label');
      label.className = 'app-dialog-check';
      cloudInput = document.createElement('input');
      cloudInput.type = 'checkbox';
      const box = document.createElement('span');
      box.className = 'app-dialog-check-box';
      box.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'app-dialog-check-copy';
      const labelText = document.createElement('span');
      labelText.className = 'app-dialog-check-title';
      labelText.textContent = '同时从书架删除';
      const hint = document.createElement('span');
      hint.className = 'app-dialog-check-hint';
      hint.textContent = '勾选后会同时删除 Cloud Hub 源文件，其他设备的书架也会移除。';
      copy.append(labelText, hint);
      label.append(cloudInput, box, copy);
      dialog.append(heading, message, label);
    } else {
      dialog.append(heading, message);
    }

    const actions = document.createElement('div');
    actions.className = 'app-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'app-dialog-button';
    cancel.textContent = '取消';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'app-dialog-button app-dialog-button-danger';
    const updateConfirmText = (): void => {
      confirm.textContent = cloudInput?.checked ? '删除本机和云端' : '删除本机副本';
    };
    if (cloudInput) {
      updateConfirmText();
      cloudInput.addEventListener('change', updateConfirmText);
    } else {
      confirm.textContent = '删除';
    }
    actions.append(cancel, confirm);
    dialog.appendChild(actions);
    scrim.appendChild(dialog);
    document.body.appendChild(scrim);

    const close = (choice: DeleteLibraryBookChoice): void => {
      if (settled) return;
      settled = true;
      scrim.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      window.setTimeout(() => scrim.remove(), 140);
      resolve(choice);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close({ confirmed: false, deleteCloud: false });
    };
    cancel.addEventListener('click', () => close({ confirmed: false, deleteCloud: false }));
    confirm.addEventListener('click', () => close({ confirmed: true, deleteCloud: !!cloudInput?.checked }));
    scrim.addEventListener('mousedown', (event) => {
      if (event.target === scrim) close({ confirmed: false, deleteCloud: false });
    });
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      scrim.classList.add('open');
      cancel.focus();
    });
  });
}

async function deleteLibraryBook(item: LibraryShelfItem): Promise<void> {
  if (activeLibraryActionIds.has(item.document_id)) return;
  const hadCloudCopy = hasCloudLibraryItem(item);
  const choice = await askDeleteLibraryBook(item);
  if (!choice.confirmed) return;
  activeLibraryActionIds.add(item.document_id);
  void refreshLibrary();
  const seq = ++importRunSeq;
  try {
    const result = await deleteCloudLibraryItem(item, { deleteCloud: choice.deleteCloud });
    const detail = libraryDeleteDetail(result, choice.deleteCloud, hadCloudCopy);
    showImportStatus({ phase: 'local_ready', filename: item.filename, documentId: item.document_id, percent: 100, detail });
    if (state.documentId === item.document_id) showLibraryHome();
    await refreshLibrary();
    hideImportStatusLater(seq);
  } catch (error) {
    showImportStatus({ phase: 'failed', filename: item.filename, documentId: item.document_id, percent: 100, detail: `删除失败：${String((error as Error)?.message || error)}` });
  } finally {
    activeLibraryActionIds.delete(item.document_id);
    void refreshLibrary();
  }
}

async function openLibraryItem(item: LibraryShelfItem): Promise<void> {
  if (activeLibraryActionIds.has(item.document_id)) return;
  const action = libraryItemAction(item);
  if (action.kind === 'wait' || action.kind === 'reimport') {
    showImportStatus({
      phase: action.kind === 'wait' ? 'waiting' : 'failed',
      filename: item.filename || '(未命名)',
      documentId: item.document_id,
      percent: action.kind === 'wait' ? 15 : 100,
      detail: action.hint,
    });
    hideCurrentStatusLater();
    return;
  }
  activeLibraryActionIds.add(item.document_id);
  void refreshLibrary();
  const seq = ++importRunSeq;
  const onProgress = (progress: LibraryImportProgress): void => {
    if (seq === importRunSeq) showImportStatus(progress);
    if (progress.phase === 'downloading' || progress.phase === 'local_ready' || progress.phase === 'failed') void refreshLibrary();
  };
  try {
    if (action.kind === 'open') {
      importStatus.hidden = true;
      await reopenBook(item.document_id, item.filename);
      return;
    }
    onProgress({ phase: 'downloading', filename: item.filename, documentId: item.document_id, percent: 0, indeterminate: true, detail: '正在从 Cloud Hub 下载到本机' });
    await downloadCloudLibraryItem(item, { onProgress });
    onProgress({ phase: 'local_ready', filename: item.filename, documentId: item.document_id, percent: 100, detail: '已下载到本机 Library' });
    hideCurrentStatusLater();
  } catch (error) {
    onProgress({ phase: 'failed', filename: item.filename, documentId: item.document_id, percent: 100, detail: `操作失败：${String((error as Error)?.message || error)}` });
  } finally {
    activeLibraryActionIds.delete(item.document_id);
    void renderRecent(recentBooks, { withCap: true });
  }
}

void renderRecent(recentBooks, { withCap: true }); // 启动即在空状态屏列出
startLibrarySyncLoop(() => { void renderRecent(recentBooks, { withCap: true }); });
$('home-btn').addEventListener('click', showLibraryHome);

// 拖拽上传：拖到整个阅读区任意位置即可
const reading = $('reading');
const isSupportedDocument = (file: File): boolean =>
  file.type === 'application/pdf' ||
  file.type === 'application/epub+zip' ||
  file.type === 'text/markdown' ||
  /\.(pdf|epub|md|markdown)$/i.test(file.name);
const pickDocument = (list: FileList | undefined): File | undefined =>
  list ? [...list].find(isSupportedDocument) : undefined;

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
  const file = pickDocument(e.dataTransfer?.files);
  if (file) void importAndSyncFile(file);
});

bus.on('document:loaded', () => { void restoreFromLedger(); });

interface MarkFocusPayload {
  markId?: string;
  documentId?: string;
  pageId?: string;
  pageIndex?: number | null;
  bbox?: NormBBox;
}

function pageIndexFromPageId(pageId?: string): number | undefined {
  const m = String(pageId || '').match(/_(\d+)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function safePageNormBbox(bbox?: NormBBox): NormBBox | null {
  if (!bbox || bbox.length !== 4) return null;
  const [x, y, w, h] = bbox.map((value) => Number(value)) as NormBBox;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  if (x < -0.05 || y < -0.05 || w > 1.1 || h > 1.1 || x + w > 1.05 || y + h > 1.05) return null;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(1, x + w);
  const y1 = Math.min(1, y + h);
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

function flashOriginalBbox(bbox?: NormBBox, pageId?: string): void {
  const safeBbox = safePageNormBbox(bbox);
  if (!safeBbox) return;
  const region = pageRegionForId(pageId);
  const w = region?.w ?? pageCss.w;
  const h = region?.h ?? pageCss.h;
  if (!w || !h) return;
  const stage = $('stage');
  stage.querySelectorAll('.page-source-flash').forEach((node) => node.remove());
  const pos = normToPx(safeBbox[0], safeBbox[1], pageId);
  const flash = document.createElement('div');
  flash.className = 'page-source-flash';
  flash.style.cssText = [
    'position:absolute',
    'z-index:8',
    'pointer-events:none',
    'box-sizing:border-box',
    'border:2px dashed #2563eb',
    'background:rgba(37,99,235,.08)',
    'border-radius:3px',
    `left:${Math.max(0, pos.x - 4)}px`,
    `top:${Math.max(0, pos.y - 4)}px`,
    `width:${Math.max(10, safeBbox[2] * w + 8)}px`,
    `height:${Math.max(10, safeBbox[3] * h + 8)}px`,
  ].join(';');
  stage.appendChild(flash);
  window.setTimeout(() => flash.remove(), 1800);
}

async function focusMarkRecord(payload: MarkFocusPayload): Promise<void> {
  const documentId = payload.documentId || state.documentId;
  if (!documentId) return;
  if (state.documentId !== documentId) {
    const item = (await listLibraryItems()).find((entry) => entry.document_id === documentId);
    if (!item) return;
    const opened = item.local_available ? await reopenBook(item.document_id, item.filename) : false;
    if (!opened) {
      await openLibraryItem(item);
      if (state.documentId !== documentId) return;
    }
  }
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  const rawPage = typeof payload.pageIndex === 'number' ? payload.pageIndex : pageIndexFromPageId(payload.pageId);
  const targetPage = Math.max(0, Math.min(Math.max(0, state.pageCount - 1), rawPage ?? state.pageIndex));
  if (targetPage !== state.pageIndex) state.pageIndex = targetPage;
  if (getActiveContext().pdf) await renderPage();
  else if (getActiveContext().syntheticDoc) renderSyntheticSurface();
  flashOriginalBbox(payload.bbox, payload.pageId);
}

async function focusOverlaySource(overlay: ScreenOverlay): Promise<void> {
  if (settings.viewMode === 'reader' && overlay.page_id === state.pageId && readerFocusOverlay(overlay)) return;
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  const rawPage = pageIndexFromPageId(overlay.page_id);
  const targetPage = Math.max(0, Math.min(Math.max(0, state.pageCount - 1), rawPage ?? state.pageIndex));
  if (targetPage !== state.pageIndex) state.pageIndex = targetPage;
  if (getActiveContext().pdf) await renderPage();
  else if (getActiveContext().syntheticDoc) renderSyntheticSurface();
  flashOriginalBbox(overlay.geometry.anchor_bbox, overlay.page_id);
}

bus.on('reader:source-focus', (overlay) => { void focusOverlaySource(overlay as ScreenOverlay); });

// 方案 B Stage 1：切换激活实例（进/退会议）后的重绘。
// 切回已加载的 PDF 实例（如退会议回主阅读）→ 重渲当前页 + 复原 chrome/墨迹/旁注，全程不重新 fetch/decode。
// 白板/聊天 surface 由调用方（enterMeeting）显式 renderBlankSurface 处理；空实例（无书）→ 回空屏。
bus.on('context:switched', (ctx) => {
  const c = ctx as SurfaceContext;
  if (c.pdf && c.surfaceType === 'article') {
    void renderPage().then(() => { if (getActiveContext() === c) void restoreFromLedger(); }); // 渲染期间又切走则不再恢复（P0-5）
  } else if (c.syntheticDoc && c.surfaceType === 'article') {
    renderSyntheticSurface();
    void restoreFromLedger();
  } else if (!c.documentId) {
    document.body.classList.remove('doc-loaded');
    $('empty-state').style.display = '';
  }
});

/** reload/重开后从账本重建：笔迹(folded marks) + AI 旁注/对话 buffer(book log) + pending session(水位线后)。 */
async function restoreFromLedger(): Promise<void> {
  document.body.classList.add('doc-loaded');
  $('empty-state').style.display = 'none';
  $('doc-name').textContent = state.fileName;
  void renderRecent(recentBooks, { withCap: true }); // 刷新书架（新导入的书下次回到空屏即可见）
  const docId = state.documentId;
  if (!docId) return;
  await restoreLedgerState(docId); // 账本→state 重建（笔迹/旁注/buffer/pending），见 controllers/ledger-restore
  await hydrateRuntimeAnnotationsToActiveCanvas(runtimeSyncHost.store, docId);
}

let lastPageId: string | null = null;
const zoomModeSelect = $<HTMLSelectElement>('zoom-mode');
const layoutSingle = $('layout-single');
const layoutSpread = $('layout-spread');
const layoutControl = layoutSingle.closest<HTMLElement>('.seg-control');
const zoomIndicator = $('zoom-ind');
const zoomOutButton = $('zoom-out') as HTMLButtonElement;
const zoomInButton = $('zoom-in') as HTMLButtonElement;

function isSpreadPageMode(): boolean {
  const ctx = getActiveContext();
  return settings.viewMode === 'page' && settings.pageLayout === 'spread' && !!(ctx.pdf || ctx.syntheticDoc);
}

function currentReadingExperience(): ReadingExperience | null {
  const ctx = getActiveContext();
  if (ctx.pdf) return readingExperienceForSource('pdf');
  if (ctx.syntheticDoc) return readingExperienceForSource(ctx.syntheticDoc.kind === 'epub' ? 'epub' : 'markdown');
  return null;
}

function isPdfLoaded(): boolean {
  return pdfOriginalControlsAvailable(currentReadingExperience());
}

function isPageLayoutAvailable(): boolean {
  return pageLayoutControlsAvailable(currentReadingExperience());
}

function isTextReaderAvailable(): boolean {
  return !!currentReadingExperience()?.controls.textReader;
}

function renderActivePage(): void {
  const ctx = getActiveContext();
  if (ctx.pdf) void renderPage();
  else if (ctx.syntheticDoc) renderSyntheticSurface();
}

function syncReadingControls(): void {
  layoutSingle.setAttribute('aria-pressed', settings.pageLayout === 'single' ? 'true' : 'false');
  layoutSpread.setAttribute('aria-pressed', settings.pageLayout === 'spread' ? 'true' : 'false');
  const experience = currentReadingExperience();
  const layoutLoaded = pageLayoutControlsAvailable(experience);
  const pdfLoaded = pdfOriginalControlsAvailable(experience);
  const pdfOnlyHint = readingControlsUnavailableHint(experience);
  const zoomHint = pdfLoaded ? '' : (experience ? '缩放只作用于 PDF 原版页' : '先打开一本书');
  if (layoutControl) layoutControl.hidden = !layoutLoaded;
  zoomModeSelect.hidden = !pdfLoaded;
  zoomOutButton.hidden = !pdfLoaded;
  zoomIndicator.hidden = !pdfLoaded;
  zoomInButton.hidden = !pdfLoaded;
  layoutSingle.toggleAttribute('disabled', !layoutLoaded);
  layoutSpread.toggleAttribute('disabled', !layoutLoaded);
  zoomModeSelect.disabled = !pdfLoaded;
  zoomOutButton.disabled = !pdfLoaded;
  zoomInButton.disabled = !pdfLoaded;
  layoutSingle.title = pdfOnlyHint || '单页布局';
  layoutSpread.title = pdfOnlyHint || '双页布局';
  zoomModeSelect.title = zoomHint || '缩放方式';
  zoomOutButton.title = zoomHint || '缩小';
  zoomInButton.title = zoomHint || '放大';
  if (settings.zoomMode === 'percent') {
    const value = String(settings.zoomPercent / 100);
    const exists = [...zoomModeSelect.options].some((o) => o.value === value);
    if (exists) {
      zoomModeSelect.value = value;
    } else {
      const custom = [...zoomModeSelect.options].find((o) => o.value === 'custom');
      if (custom) custom.textContent = `${settings.zoomPercent}%`;
      zoomModeSelect.value = 'custom';
    }
  } else {
    zoomModeSelect.value = settings.zoomMode;
  }
}

function pageIndicatorText(): string {
  if (isSpreadPageMode() && state.pageIndex + 1 < state.pageCount) {
    return `第 ${state.pageIndex + 1}-${state.pageIndex + 2} / ${state.pageCount} 页`;
  }
  return `第 ${state.pageIndex + 1} / ${state.pageCount} 页`;
}

bus.on('page:rendered', () => {
  $('page-ind').textContent = pageIndicatorText();
  $('zoom-ind').textContent = `${Math.round(state.zoom * 100)}%`;
  syncReadingControls();
  // 翻页（非缩放重渲）：记阅读位置。在途笔的复位由 annotation-loop 的 page:rendered 监听负责。
  if (state.pageId !== lastPageId) {
    lastPageId = state.pageId;
    setLastReadPage(state.pageIndex); // 记阅读位置（去抖落盘），重开跳回
  }
});

$('prev').addEventListener('click', () => gotoPage(-1));
$('next').addEventListener('click', () => gotoPage(1));
layoutSingle.addEventListener('click', () => {
  if (!isPageLayoutAvailable()) { syncReadingControls(); return; }
  settings.pageLayout = 'single';
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  syncReadingControls();
  renderActivePage();
});
layoutSpread.addEventListener('click', () => {
  if (!isPageLayoutAvailable()) { syncReadingControls(); return; }
  settings.pageLayout = 'spread';
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  syncReadingControls();
  renderActivePage();
});
zoomModeSelect.addEventListener('change', () => {
  if (!isPdfLoaded()) { syncReadingControls(); return; }
  const value = zoomModeSelect.value;
  if (value === 'fit-page' || value === 'fit-width') {
    settings.zoomMode = value;
  } else if (value !== 'custom') {
    settings.zoomMode = 'percent';
    settings.zoomPercent = Math.round(Number(value) * 100);
  }
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  syncReadingControls();
  void renderPage();
});

// 翻页手势：笔/手指分流后，手指横滑（或 hand 工具拖动）→ ink.ts 发 nav:flip
bus.on('nav:flip', (dir) => gotoPage(Number(dir) || 0));
bus.on('mark:focus', (payload) => void focusMarkRecord(payload as MarkFocusPayload));

// 触控板两指横滑 → 翻页（最贴近真机手指翻页）。横向为主才拦，竖向滚动放行；一次滑一翻、加锁防连翻。
let wheelAccum = 0;
let wheelLock = false;
$('stage-wrap').addEventListener('wheel', (e) => {
  if (settings.viewMode !== 'page' || !hasDocument()) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // 竖向滚动不翻页
  e.preventDefault();                                    // 拦 Safari/浏览器的前进后退手势
  if (wheelLock) return;
  wheelAccum += e.deltaX;
  if (Math.abs(wheelAccum) > 80) {
    gotoPage(wheelAccum > 0 ? 1 : -1);
    wheelAccum = 0;
    wheelLock = true;
    window.setTimeout(() => { wheelLock = false; }, 450);
  }
}, { passive: false });
zoomInButton.addEventListener('click', () => {
  if (!isPdfLoaded()) { syncReadingControls(); return; }
  settings.viewMode = 'page';
  applyViewMode();
  setZoom(state.zoom + 0.25);
  saveSettings();
  syncReadingControls();
});
zoomOutButton.addEventListener('click', () => {
  if (!isPdfLoaded()) { syncReadingControls(); return; }
  settings.viewMode = 'page';
  applyViewMode();
  setZoom(state.zoom - 0.25);
  saveSettings();
  syncReadingControls();
});

const insight = $('insight');
$('insight-toggle').addEventListener('click', () => {
  const open = insight.classList.toggle('open');
  bus.emit('insight:visibility', open);
});

function readerToggleLabel(isReader: boolean): string {
  return isReader ? '页面' : '阅读';
}

// 原版 PDF / EPUB 文本阅读器 ⇄ 可标记阅读面
function applyViewMode(): void {
  const canUseReader = isTextReaderAvailable();
  if (!canUseReader && settings.viewMode === 'reader') {
    settings.viewMode = 'page';
    saveSettings();
  }
  const isReader = canUseReader && settings.viewMode === 'reader';
  $('reading').classList.toggle('reader', isReader);
  ($('reader') as HTMLElement).hidden = !isReader;
  ($('stage-wrap') as HTMLElement).style.display = isReader ? 'none' : '';
  const btn = $('view-toggle');
  btn.hidden = !canUseReader;
  btn.textContent = readerToggleLabel(isReader);
  btn.classList.toggle('active', isReader);
  syncReadingControls();
}
$('view-toggle').addEventListener('click', () => {
  if (!isTextReaderAvailable()) {
    settings.viewMode = 'page';
    applyViewMode();
    return;
  }
  // 切面前先收口在途区域：此刻 pageId/surfaceIndex 仍是当前面，能正确落成 mark；否则 regBbox 跨面存活，
  // 切过去第一笔会与旧面在途区域误并（跨面污染）。空区域时 flushRegion 有 events.length 守卫、是 no-op。
  flushRegion('view-switch');
  settings.viewMode = settings.viewMode === 'reader' ? 'page' : 'reader';
  applyViewMode();
  bus.emit('view:changed');
});
applyViewMode(); // 初始即同步 DOM 到持久化的 viewMode（否则刷新后 reader 持久值不反映、停在 page）

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.isContentEditable) return;
  if (e.key === 'ArrowLeft') gotoPage(-1);
  if (e.key === 'ArrowRight') gotoPage(1);
});

window.addEventListener('resize', () => {
  if (!hasDocument()) return;
  if (getActiveContext().pdf) void renderPage();
  else if (getActiveContext().syntheticDoc) renderSyntheticSurface();
});

declare global {
  interface Window { __inkloop?: { state: typeof state; settings: typeof settings; bus: typeof bus; features: typeof features } }
}
window.__inkloop = { state, settings, bus, features };
