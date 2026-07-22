// 移动版（电纸屏）入口：阅读默认进书架；日记能力保留给内部白板/会议手记，不作为普通用户入口。
// 复用同名 DOM id（page-layer/ink-layer/stage/stage-wrap/whisper-layer），与桌面共用 app/annotation-loop 的编排（不分叉）。
// 注意：不 import 桌面 styles.css —— 移动版有自己的样式（src/mobile/mobile.css，正规化后从 mobile.html 内联抽出）。
import './core/polyfills'; // 必须最先：设备 WebView 109 补 Promise.withResolvers（pdf.js 用到）
import './mobile/mobile.css'; // 移动版样式（Vite 注入；build 后抽成 dist 内 <link>，故无 FOUC）
import './components/mark-drawer.css';
import QRCode from 'qrcode';
import { extractEpubCoverImageDataUrl, initRenderer, renderBlankSurface, renderBlankPage, renderSyntheticSurface, loadFile, importFileToLibrary, reopenBook, renderPage, renderPageTextLayerOnly } from './surface/renderer';
import type { SurfaceContext } from './app/surface-context';
import { initWhisper } from './surface/whisper';
import { initAnchorLayer } from './surface/anchor-layer';
import { buildRecords, initInsightPanel } from './surface/insight-panel';
import { initReader, readerFlip, readerArmBackward, readerVInfo, readerSetVPage, readerFocusMark, readerFocusOverlay, readerDocumentPageInfo, readerPageCountForSource } from './surface/reader';
import { initDevOverlay } from './dev/dev-overlay';
import { wireAnnotationLoop, flushBoardOcrMarks, flushRegion } from './app/annotation-loop';
import { triggerBoardOcr } from './capture/board-ocr';
import { setTool, getActiveContext, state, settings, saveSettings, bus, currentStrokes, strokeMarkIds, type Stroke } from './app/state';
import type { NormBBox, ScreenOverlay, StrokePoint } from './core/contracts';
import { DEVICE_ID, pageIdFor, shortId } from './core/ids';
import { appendAiTurnEntry, appendMarkEntry, createDiaryDoc, flushActiveDoc, getBookAiTurns, getFoldedMarks, getLibrarySyncRecord, listDiaries, listBooks, listLibraryItems, listLibrarySyncRecords, loadPdfBlob, setActiveDoc, setLastReadPage, setReadingProgress, setDiaryPageCount, setDocCoverImageDataUrl, renameDiary, deleteDiary, type LibraryShelfItem } from './local/store';
import { confirmSheet, confirmSheetWithOption, infoSheet } from './mobile/sheet';
import { redrawInk, undoStroke } from './capture/ink';
import { inkToolFromControlKey, syncInkToolControls } from './core/ink-tool-controls';
import { restoreLedgerState } from './controllers/ledger-restore';
import { initEinkMirror, signalInkArea } from './surface/eink';
import { disarmM103HqHwAreaNow, initM103HqHwArea } from './capture/m103-hqhw-area';
import { initOnyxPenArea } from './capture/onyx-pen-area';
import { initM103HqHwSocket } from './capture/m103-hqhw-socket';
import { forceResetOsdInkNow, nativePointerKind } from './capture/m103-input-source';
import { shouldStartBookPointerSwipe, shouldStartBookTouchSwipe } from './capture/input-policy';
import { installM103RawPenCaptureBridge } from './capture/m103-raw-pen-adapter';
import { features } from './config/features';
import { createSyntheticMeetingEventMark, initMobileMeeting, leaveActiveMeetingForReading } from './mobile/meeting';
import { initMobileDev } from './mobile/dev';
import { initMobileShell } from './mobile/shell';
import { initMobileAuthLogin } from './mobile/auth-login';
import { estimateReaderPageIndexFromBbox, isSummaryHiddenMark } from './mobile/mark-summary';
import { inkLoopDeviceProfile } from './capture/m103-device';
import { publishVaultFromDevice, abortVaultPublish } from './integration/inksurface/vault-publish-device';
import { createPager, mountPagerBar, type Pager, type PagerBar } from './surface/virtual-pager';
import type { PersistedAiTurn, PersistedDoc, PersistedMark } from './core/store-format';
import { hydrateRuntimeAnnotationsToActiveCanvas, installWebRuntimeSyncHost, type WebRuntimeSyncHost } from './integration/inksurface/runtime-sync-host';
import { initRuntimeSyncStatus } from './components/runtime-sync-status';
import { apiBase, apiRouteChoice, getJson, postJson, setApiRoute } from './core/api';
import { getSession, onAuthChange, setSession } from './core/auth';
import { refreshCoreSessionFromAuthority } from './core/session-reconcile';
import { deleteCloudLibraryItem, downloadCloudLibraryItem, hasCloudLibraryItem, pullCloudLibraryManifest, recordLocalImportedSource, retryPendingLibraryUploads, startLibrarySyncLoop, uploadLoadedDocumentSource } from './integration/inksurface/library-sync';
import { normToPx, pageCss, pageRegionForId } from './core/transform';
import {
  pageLayoutControlsAvailable,
  pdfOriginalControlsAvailable,
  readingControlsUnavailableHint,
  readingExperienceForSource,
  type ReadingExperience,
} from './core/reading-experience';
import type { ReaderPageState } from './surface/reader';
import { createLibraryBookCard, createLibraryImportCard, isUserVisibleLibraryItem, shelfKindLabel } from './components/library-shelf';
import { correctedMarkedTextForPhysicalPenLine } from './app/mark-text';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const RULED = { ruledLines: false } as const; // 移动版线格走 CSS 叠层（#diary-lines），故引擎页画布不画线

interface InkLoopColorBridge {
  supportsColorDisplay?: () => boolean;
  debugStatus?: () => string;
}

function detectPaperColor(): boolean {
  const profile = inkLoopDeviceProfile();
  const fallback = profile === 'onyx-t10' || /t10c|cplus|color/i.test(navigator.userAgent);
  const bridge = (window as unknown as { InkLoopOnyxEpd?: InkLoopColorBridge }).InkLoopOnyxEpd;
  try {
    if (typeof bridge?.supportsColorDisplay === 'function') return bridge.supportsColorDisplay();
  } catch {
    return fallback;
  }
  return fallback;
}

function initPaperColorProfile(): void {
  const color = detectPaperColor();
  document.body.dataset.paperColor = color ? 'color' : 'mono';
  document.body.classList.toggle('paper-color', color);
}

initPaperColorProfile();

interface InkLoopRuntimeManifest {
  schema_version?: string;
  product_loop?: string;
  sync_loop?: string;
  mode?: string;
  entrypoint?: string;
}

function initAndroidRuntimeBoundary(): void {
  const target = document.getElementById('runtime-boundary-text');
  if (!target) return;
  const fallback = 'V1 demo · Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection';
  const bridge = (window as unknown as {
    InkLoopRuntime?: { getManifest?: () => string };
  }).InkLoopRuntime;
  if (!bridge || typeof bridge.getManifest !== 'function') {
    target.textContent = fallback;
    return;
  }
  try {
    const manifest = JSON.parse(bridge.getManifest()) as InkLoopRuntimeManifest;
    const productLoop = manifest.product_loop || 'InkLoop Paper';
    const syncLoop = manifest.sync_loop || 'Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection';
    const mode = manifest.mode || 'web-cloud-first-paper-local-first';
    target.textContent = `${productLoop} · ${syncLoop} · ${mode}`;
  } catch (error) {
    target.textContent = `${fallback} · runtime manifest unavailable`;
    console.warn('InkLoopRuntime manifest unavailable', error);
  }
}

initRenderer({
  pageLayer: el<HTMLCanvasElement>('page-layer'),
  inkLayer: el<HTMLCanvasElement>('ink-layer'),
  stage: el('stage'),
  stageWrap: el('stage-wrap'),
});
wireAnnotationLoop(el<HTMLCanvasElement>('ink-layer'));
const runtimeSyncHost: WebRuntimeSyncHost = installWebRuntimeSyncHost({
  logger: (event, details) => console.debug(`[${event}]`, details),
});
initRuntimeSyncStatus();
initWhisper(el('whisper-layer'), { fold: true }); // 电纸屏：AI 旁注折叠成点触标记（点开才显·像 reader replyMode）
initAnchorLayer(el('stage')); // 流式 anchor:place 锚点预览（原版/canvas 视图·文本阅读时 #stage hidden 自然不显）——与桌面对齐
initReader(el('reader'), { notePlacement: 'inline', restoreStrokes: true, replyMode: true, paginate: true }); // 文本阅读视图（书籍态·AI 注内联段落下方·重画旧 mark 真笔触·电纸屏阅读页翻页·复用桌面 reader.ts 行为层）
initInsightPanel({ cards: el('m-cards'), foot: el('m-panel-foot'), count: el('m-insight-count') }); // 标记记录历史（复用桌面同款）
initDevOverlay(); // dev 叠层（bbox/region/relation/HMP 浮窗·设置页 devOverlay/showRegion/showRelations 控·默认关）——接真桌面同款
if (features.einkBridge) initEinkMirror(); // 电纸屏镜像：套壳内容变化 → 推 IT8951（web/dev 无桥则 no-op）
initM103HqHwArea(); // M103 专用：上报当前画布矩形给原生 HqHwBridge 收窄画区（非 M103 直接 no-op）
initOnyxPenArea(); // ONYX 专用：上报画布矩形给 OnyxPenBridge 收窄 raw drawing 画区（非 ONYX 直接 no-op）
initM103HqHwSocket(); // M103 专用：接收硬件 socket 笔点（抬笔用同源点补画，消除微重影·非 M103 no-op）
installM103RawPenCaptureBridge(); // M103 专用：启动即暴露真实物理笔点导出桥，便于真机延迟/持久化验收。
initMobileShell(); // 外壳交互（导航脊/子导航/工具/rail/文件浮层）——原 mobile.html 内联脚本，正规化后抽出
initMobileAuthLogin(); // 阶段C：二维码设备登录门禁；有有效 session 时自动隐藏
void completeFeishuOAuthDeepLink(); // 设备端飞书 OAuth deep link 回调：系统浏览器授权完成 → 回 InkLoop 换 token。
// 身份校准：前端 core session 停在设备授权时的 local_user，飞书登录后后端 token 已升级成 feishu_ou_*。
// 启动 + web 重定向登录回来(pageshow/可见)时拉后端权威身份覆盖前端；setSession 会 emit 'login' →
// runtime-sync-host / library-sync 借此重建 namespace（见 Phase 3）。
void refreshCoreSessionFromAuthority();
window.addEventListener('pageshow', () => { void refreshCoreSessionFromAuthority(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshCoreSessionFromAuthority(); });
initAndroidRuntimeBoundary(); // Android/Paper V1 demo boundary: Web cloud-first -> Paper local-first -> Obsidian projection.
startCloudDeviceHeartbeat(); // Cloud Hub DeviceManifest：设备在线状态、LAN/同步健康度持久化。
startCloudDeviceCommandPolling(); // Cloud Hub device commands：Obsidian「回到原文」等运行时打开动作。

async function completeFeishuOAuthDeepLink(): Promise<void> {
  const url = new URL(window.location.href);
  if (url.searchParams.get('inkloop_oauth') !== 'lark') return;
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code') || '';
  const stateParam = url.searchParams.get('state') || '';
  const redirectUri = url.searchParams.get('redirect_uri') || 'inkloop://oauth/lark/callback';
  const cleanUrl = `${window.location.origin}${window.location.pathname}${window.location.hash || ''}`;
  try {
    window.history.replaceState(null, document.title, cleanUrl);
  } catch { /* ignore history cleanup */ }
  if (error) {
    await infoSheet({ title: '飞书授权失败', message: error });
    return;
  }
  if (!code || !stateParam) {
    await infoSheet({ title: '飞书授权失败', message: '缺少 code 或 state。' });
    return;
  }
  try {
    const completed = await postJson<{ session?: { session_id: string; session_token: string; tenant_id: string; user_id: string; device_id: string; expires_at: number } }>('/api/feishu-svc/api/feishu/oauth/device/complete', {
      code,
      state: stateParam,
      redirect_uri: redirectUri,
    }, { auth: true });
    if (completed.session) {
      setSession({
        sessionId: completed.session.session_id,
        sessionToken: completed.session.session_token,
        tenantId: completed.session.tenant_id,
        userId: completed.session.user_id,
        deviceId: completed.session.device_id,
        expiresAt: completed.session.expires_at,
      });
    }
    document.dispatchEvent(new CustomEvent('inkloop:feishu-oauth-complete', { detail: completed }));
    await Promise.allSettled([
      pullCloudLibraryManifest(),
      retryPendingLibraryUploads(),
    ]);
    if (document.body.dataset.read === 'books') await renderBookShelf();
    await infoSheet({ title: '飞书已登录', message: '会议原始发言、智能纪要和 InkLoop 后处理已可继续同步。' });
  } catch (e) {
    await infoSheet({ title: '飞书授权写入失败', message: String((e as Error)?.message || e) });
  }
}

function cloudDeviceHeartbeatPayload(): Record<string, unknown> {
  const lanBridge = (window as unknown as { InkLoopLanImport?: { getState?: () => string } }).InkLoopLanImport;
  let lan_import: Record<string, unknown> | undefined;
  try {
    if (lanBridge?.getState) lan_import = JSON.parse(lanBridge.getState()) as Record<string, unknown>;
  } catch {
    lan_import = { error: 'lan_state_unavailable' };
  }
  return {
    platform: 'android-webview',
    app_surface: 'paper-runtime-host',
    status: document.visibilityState === 'hidden' ? 'idle' : 'online',
    api_base: apiBase(),
    capabilities: {
      reading: true,
      meeting: true,
      lan_import: !!lanBridge?.getState,
      runtime_sync: true,
      obsidian_projection: true,
    },
    health: {
      document_id: state.documentId || null,
      page_index: state.pageIndex,
      surface_type: state.surfaceType,
      logged_in: !!getSession(),
    },
    lan_import,
  };
}

function sendCloudDeviceHeartbeat(reason: string): void {
  if (!getSession()) return;
  const payload = cloudDeviceHeartbeatPayload();
  void postJson('/v1/devices/heartbeat', {
    ...payload,
    health: {
      ...(payload.health as Record<string, unknown> | undefined),
      reason,
    },
  }, { auth: true }).catch(() => {
    // Device status is advisory; reading and marking must remain local-first.
  });
}

function startCloudDeviceHeartbeat(): void {
  sendCloudDeviceHeartbeat('startup');
  onAuthChange((event) => {
    if (event.kind === 'login') sendCloudDeviceHeartbeat('login');
  });
  const interval = window.setInterval(() => sendCloudDeviceHeartbeat('interval'), 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      disarmM103HqHwAreaNow();
    }
    sendCloudDeviceHeartbeat('visibilitychange');
  });
  window.addEventListener('pagehide', () => {
    window.clearInterval(interval);
    disarmM103HqHwAreaNow();
    sendCloudDeviceHeartbeat('pagehide');
  });
  window.addEventListener('beforeunload', () => {
    disarmM103HqHwAreaNow();
  });
}

interface CloudDeviceCommand {
  command_id: string;
  type: string;
  payload?: { uri?: string };
}

async function ackCloudDeviceCommand(command: CloudDeviceCommand, ok: boolean, result: Record<string, unknown>): Promise<void> {
  await postJson(`/v1/devices/commands/${encodeURIComponent(command.command_id)}/ack`, {
    ok,
    result: {
      ...result,
      device_id: getSession()?.deviceId || DEVICE_ID,
    },
    error: ok ? undefined : String(result.error || 'command_failed'),
  }, { auth: true });
}

async function handleCloudDeviceCommand(command: CloudDeviceCommand): Promise<void> {
  if (command.type !== 'open_source') {
    await ackCloudDeviceCommand(command, false, { error: 'unsupported_device_command_type', type: command.type });
    return;
  }
  const uri = String(command.payload?.uri || '').trim();
  if (!uri) {
    await ackCloudDeviceCommand(command, false, { error: 'missing_open_source_uri' });
    return;
  }
  const result = await openInkLoopUri(uri);
  await ackCloudDeviceCommand(command, result.ok, result as unknown as Record<string, unknown>);
}

function startCloudDeviceCommandPolling(): void {
  let inFlight = false;
  const poll = async (): Promise<void> => {
    const session = getSession();
    if (!session || inFlight) return;
    inFlight = true;
    try {
      const payload = await getJson<{ commands?: CloudDeviceCommand[] }>(
        `/v1/devices/commands:pull?device_id=${encodeURIComponent(session.deviceId)}`,
        { auth: true },
      );
      for (const command of payload.commands || []) {
        await handleCloudDeviceCommand(command).catch((error) =>
          ackCloudDeviceCommand(command, false, { error: String((error as Error)?.message || error) }).catch(() => undefined),
        );
      }
    } catch {
      // Command polling must never interrupt reading/marking; heartbeat exposes device health separately.
    } finally {
      inFlight = false;
    }
  };
  void poll();
  onAuthChange((event) => {
    if (event.kind === 'login') void poll();
  });
  const interval = window.setInterval(() => void poll(), 2_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') void poll();
  });
  window.addEventListener('pagehide', () => window.clearInterval(interval));
}

function defaultPaperReadingMode(): void {
  const key = 'inkloop.mobile.original-defaulted.v1';
  let changed = false;
  try {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      if (settings.viewMode !== 'page') {
        settings.viewMode = 'page';
        changed = true;
      }
    }
  } catch {
    // WebView localStorage 不可用时仍按原版优先处理。
    if (settings.viewMode !== 'page') {
      settings.viewMode = 'page';
      changed = true;
    }
  }
  if (settings.reflowProvider !== 'local') {
    settings.reflowProvider = 'local';
    changed = true;
  }
  if (settings.reflowEager) {
    settings.reflowEager = false;
    changed = true;
  }
  if (changed) saveSettings();
}
defaultPaperReadingMode();

// 标记记录抽屉开关（rail 灯泡图标）
el('rl-ai').addEventListener('click', () => document.body.classList.toggle('insight-open'));
el('insight-x').addEventListener('click', () => document.body.classList.remove('insight-open'));
el('scrim-insight').addEventListener('click', () => document.body.classList.remove('insight-open'));

// reload/重开后从账本恢复该日记的笔迹（renderBlankSurface 末尾会 emit document:loaded）。
bus.on('document:loaded', () => {
  // 稿纸线叠层（#diary-lines）跟 surfaceType 走：白板=显、PDF(article)=隐。
  // 否则会中把资料 PDF 载进同一画布时，日记格线叠层会透在 PDF 上（#stage-wrap 搬进会中宿主、叠层随行）。
  document.body.dataset.surface = state.surfaceType;
  const id = state.documentId;
  if (id) {
    void restoreLedgerState(id)
      .then(() => hydrateRuntimeAnnotationsToActiveCanvas(runtimeSyncHost.store, id))
      .then(() => redrawInk());
  }
});

// 切回 reader 实例后重渲其 surface（mobile 原本不听 context:switched·桌面 main.ts 有）：
// 否则会中开过资料 PDF 再退会议时，画布残留上一会的资料帧、而活跃 context 已是 reader——
// 用户看着会议资料、落笔却进 reader 文档（归错档）。reader 有 PDF(书)→renderPage 重渲该书首/当前页（state 字段委托 activeCtx，自动指向 reader 的 pdf/页/doc）+ redrawInk 画回其墨迹；
// 空 reader / 日记列表态画布本就隐藏，不重渲（renderBlankSurface 会另起新文档，反而破坏）。
bus.on('context:switched', (ctx) => {
  const c = ctx as SurfaceContext;
  if (c.pdf && c.surfaceType === 'article') {
    void renderPage().then(() => { if (getActiveContext() === c) redrawInk(); });
  } else if (c.syntheticDoc && c.surfaceType === 'article') {
    renderSyntheticSurface();
    redrawInk();
  }
});

// 左缘工具格子（data-tool）→ 引擎 setTool：自由笔 / 文本锚定标记 / 擦。
const toolButtons = [...document.querySelectorAll<HTMLElement>('[data-tool]')];
if (state.tool === 'hand') setTool('pen');
function syncToolButtons(): void {
  syncInkToolControls(toolButtons, state.tool);
}
for (const b of toolButtons) {
  b.addEventListener('click', () => { const t = inkToolFromControlKey(b.dataset.tool); if (t) setTool(t); });
}
bus.on('tool', () => syncToolButtons());
syncToolButtons();
document.querySelector<HTMLElement>('[data-act="undo"]')?.addEventListener('click', () => undoStroke());
// AI 笔是显式 AI 命令：选中 AI 笔写 → 必进入 AI 回应；普通笔=纯内容阅读标记。

function reviewLaterBbox(): NormBBox {
  return [0.94, 0.035, 0.035, 0.035];
}

function bboxForPoints(points: StrokePoint[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

type SyntheticReadingMarkKind = 'underline' | 'highlight' | 'circle' | 'handwriting' | 'ai_pen' | 'review_later';

function underlineStrokePoints(): StrokePoint[] {
  return [
    { x: 0.19, y: 0.38, t: 0, pressure: 0.48 },
    { x: 0.32, y: 0.385, t: 16, pressure: 0.52 },
    { x: 0.49, y: 0.382, t: 32, pressure: 0.5 },
    { x: 0.67, y: 0.386, t: 48, pressure: 0.46 },
  ];
}

function circleStrokePoints(cx = 0.42, cy = 0.52, rx = 0.16, ry = 0.065): StrokePoint[] {
  const points: StrokePoint[] = [];
  for (let i = 0; i <= 18; i += 1) {
    const a = (i / 18) * Math.PI * 2;
    points.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, t: i * 12, pressure: 0.56 });
  }
  return points;
}

function handwritingStrokePoints(): StrokePoint[] {
  return [
    { x: 0.72, y: 0.34, t: 0, pressure: 0.5 },
    { x: 0.75, y: 0.31, t: 16, pressure: 0.54 },
    { x: 0.79, y: 0.37, t: 32, pressure: 0.57 },
    { x: 0.83, y: 0.31, t: 48, pressure: 0.53 },
    { x: 0.87, y: 0.36, t: 64, pressure: 0.5 },
    { x: 0.89, y: 0.33, t: 80, pressure: 0.45 },
  ];
}

function syntheticReadingMarkSpec(kind: SyntheticReadingMarkKind): {
  points: StrokePoint[];
  tool: 'pen' | 'aipen' | 'highlighter' | 'underline';
  color: string;
  feature_type: 'markup' | 'handwriting' | 'drawing';
  marked_text: string;
  scored_type: string;
  ai_eligible: boolean;
  origin?: 'pen' | 'ai_pen' | 'highlighter' | 'underline' | 'auto';
} {
  if (kind === 'underline' || kind === 'highlight') {
    return {
      points: underlineStrokePoints(),
      tool: kind === 'underline' ? 'underline' : 'highlighter',
      color: '#888888',
      feature_type: 'markup',
      marked_text: 'UX 3.0 包括生态化体验、创新赋能体验、AI 赋能体验、人智交互体验和人智协同体验。',
      scored_type: kind,
      ai_eligible: false,
      origin: kind === 'underline' ? 'underline' : 'highlighter',
    };
  }
  if (kind === 'circle') {
    return {
      points: circleStrokePoints(),
      tool: 'pen',
      color: '#111111',
      feature_type: 'drawing',
      marked_text: '',
      scored_type: 'circle',
      ai_eligible: false,
    };
  }
  if (kind === 'handwriting') {
    return {
      points: handwritingStrokePoints(),
      tool: 'pen',
      color: '#111111',
      feature_type: 'handwriting',
      marked_text: '核心问题：智能时代 UX 不能只做界面可用性，要覆盖意图推理、隐私、自主权和人机协同。',
      scored_type: 'margin_note',
      ai_eligible: true,
      origin: 'pen',
    };
  }
  if (kind === 'ai_pen') {
    return {
      points: circleStrokePoints(0.48, 0.44, 0.18, 0.07),
      tool: 'aipen',
      color: '#111111',
      feature_type: 'handwriting',
      marked_text: 'AI 笔问题：这段 UX 3.0 的核心变化是什么？',
      scored_type: 'margin_note',
      ai_eligible: true,
      origin: 'ai_pen',
    };
  }
  if (kind === 'review_later') return {
    points: [],
    tool: 'pen',
    color: '#111111',
    feature_type: 'drawing',
    marked_text: '稍后处理',
    scored_type: 'review_later',
    ai_eligible: false,
    origin: 'auto',
  };
  throw new Error(`unsupported synthetic reading mark kind: ${String(kind)}`);
}

async function markCurrentPageReviewLater(): Promise<{ ok: boolean; mark_id?: string; error?: string }> {
  const documentId = state.documentId;
  const pageId = state.pageId;
  if (!documentId || !pageId) {
    const error = 'missing_active_document';
    void infoSheet({ title: '无法标记', message: '请先打开一本书或一页内容。' });
    return { ok: false, error };
  }
  const bbox = reviewLaterBbox();
  const markId = shortId('evt');
  await appendMarkEntry({
    document_id: documentId,
    page_id: pageId,
    page_index: state.pageIndex,
    mark_id: markId,
    strokes: [],
    bbox,
    tool: 'pen',
    color: '#111111',
    pointer_type: 'button',
    device_id: DEVICE_ID,
    abs_timestamp: Date.now(),
    context_id: getActiveContext().id,
    feature_type: 'drawing',
    feature_confidence: 1,
    kind: 'review_later',
    kind_source: 'manual',
    scored_type: 'review_later',
    scored_score: 1,
    hmp: null,
    marked_text: '稍后处理',
    ai_eligible: false,
    origin: 'auto',
    is_tombstone: false,
  });
  bus.emit('mark:resolved', { feature: 'drawing', text: '稍后处理' });
  void runtimeSyncHost.syncDocument(documentId, 'review-later');
  void infoSheet({ title: '已标记', message: '这页已加入稍后处理，不会在页面上留下额外图形。' });
  return { ok: true, mark_id: markId };
}

async function createSyntheticReadingMark(kind: SyntheticReadingMarkKind): Promise<{
  ok: boolean;
  kind: SyntheticReadingMarkKind;
  mark_id?: string;
  document_id?: string;
  page_id?: string;
  page_index?: number;
  folded_count?: number;
  error?: string;
}> {
  const documentId = state.documentId;
  const pageId = state.pageId;
  if (!documentId || !pageId) return { ok: false, kind, error: 'missing_active_document' };
  let spec: ReturnType<typeof syntheticReadingMarkSpec>;
  try {
    spec = syntheticReadingMarkSpec(kind);
  } catch (error) {
    return { ok: false, kind, error: String((error as Error)?.message || error) };
  }
  const bbox = spec.points.length ? bboxForPoints(spec.points) : reviewLaterBbox();
  const markId = shortId('evt');
  const representativeTool = spec.tool === 'aipen' ? 'pen' : spec.tool;
  const stroke: Stroke | null = spec.points.length ? { tool: spec.tool, points: spec.points } : null;
  if (stroke) {
    currentStrokes().push(stroke);
    strokeMarkIds.set(stroke, markId);
    redrawInk();
  }
  signalInkArea(bbox);
  await appendMarkEntry({
    document_id: documentId,
    page_id: pageId,
    page_index: state.pageIndex,
    mark_id: markId,
    strokes: spec.points.length ? [{ tool: spec.tool, points: spec.points }] : [],
    bbox,
    tool: representativeTool,
    color: spec.color,
    pointer_type: 'synthetic',
    device_id: DEVICE_ID,
    abs_timestamp: Date.now(),
    context_id: getActiveContext().id,
    feature_type: spec.feature_type,
    feature_confidence: 1,
    kind,
    kind_source: 'manual_synthetic',
    scored_type: spec.scored_type,
    scored_score: 1,
    hmp: null,
    marked_text: spec.marked_text,
    ai_eligible: spec.ai_eligible,
    origin: spec.origin ?? 'auto',
    is_tombstone: false,
  });
  bus.emit('mark:resolved', { feature: spec.feature_type, text: spec.marked_text });
  void runtimeSyncHost.syncDocument(documentId, `synthetic-${kind}`);
  const folded = await getFoldedMarks(documentId);
  return { ok: true, kind, mark_id: markId, document_id: documentId, page_id: pageId, page_index: state.pageIndex, folded_count: folded.length };
}

document.querySelector<HTMLElement>('[data-act="review-later"]')?.addEventListener('click', () => void markCurrentPageReviewLater());

// ════ 日记：先有文件再写内容 ════
const titleEl = el('diary-title');
const wrap = el('stage-wrap');
const pgInd = el('pg-ind');
const dim = (W = 0, H = 0) => ({ width: W || wrap.clientWidth, height: H || wrap.clientHeight });
let lastReaderPageState: ReaderPageState | null = null;

function readerPageInfo(pageIndex: number, pageCount: number, readerPageIndex: number, readerPageCount: number): { current: number; total: number; estimated: boolean } {
  return readerDocumentPageInfo(pageIndex, pageCount, readerPageIndex, readerPageCount);
}

function currentSourceKind(): 'pdf' | 'epub' | 'markdown' | null {
  const ctx = getActiveContext();
  if (ctx.pdf) return 'pdf';
  if (ctx.syntheticDoc) return ctx.syntheticDoc.kind === 'epub' ? 'epub' : 'markdown';
  return null;
}

function readerModeStatusLabel(): string {
  return '阅读模式';
}

function readerToggleLabel(isReader: boolean): string {
  return isReader ? '页面' : '阅读';
}

function isReaderPageState(payload: unknown): payload is ReaderPageState {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Partial<ReaderPageState>;
  return typeof p.pageIndex === 'number'
    && typeof p.pageCount === 'number'
    && typeof p.readerPageIndex === 'number'
    && typeof p.readerPageCount === 'number'
    && typeof p.current === 'number'
    && typeof p.total === 'number';
}

function currentReaderPageState(): ReaderPageState {
  if (
    lastReaderPageState
    && lastReaderPageState.documentId === state.documentId
    && lastReaderPageState.pageIndex === state.pageIndex
    && settings.viewMode === 'reader'
  ) {
    return lastReaderPageState;
  }
  const v = readerVInfo();
  const pageCount = Math.max(1, state.pageCount || 1);
  const info = readerPageInfo(state.pageIndex, pageCount, v.index, v.count);
  return {
    documentId: state.documentId,
    pageIndex: state.pageIndex,
    pageCount,
    readerPageIndex: v.index,
    readerPageCount: v.count,
    current: info.current,
    total: info.total,
    estimated: info.estimated,
    label: readerModeStatusLabel(),
  };
}

// 日记可无限向前翻（空白新页不落盘），故"总页数"取已落盘页数与当前页的较大值——
// 翻到空白新页时显 N/N（不显 N>M），真写了才把 page_count 抬上去、退回去也不缩。书籍 pageIndex 不越界、行为不变。
function updatePageInd(): void {
  if (state.surfaceType === 'article' && settings.viewMode === 'reader') {
    const info = currentReaderPageState();
    pgInd.textContent = `${info.current}/${info.total}`;
    return;
  }
  const total = Math.max(state.pageCount, state.pageIndex + 1);
  const ctx = getActiveContext();
  if (
    state.surfaceType === 'article'
    && settings.viewMode === 'page'
    && settings.pageLayout === 'spread'
    && (ctx.pdf || ctx.syntheticDoc)
    && state.pageIndex + 1 < total
  ) {
    pgInd.textContent = `${state.pageIndex + 1}-${state.pageIndex + 2}/${total}`;
    return;
  }
  pgInd.textContent = `${state.pageIndex + 1}/${total}`;
}

function recordBookReadingProgress(flush = false): void {
  if (state.surfaceType !== 'article' || !state.documentId) return;
  const pageCount = Math.max(1, state.pageCount || 1);
  const pageIndex = Math.min(Math.max(0, state.pageIndex || 0), pageCount - 1);
  const viewMode = settings.viewMode === 'reader' ? 'reader' : 'page';
  const readerState = viewMode === 'reader' ? currentReaderPageState() : null;
  const v = readerState ? { index: readerState.readerPageIndex, count: readerState.readerPageCount } : { index: 0, count: 1 };
  const readerPageCount = Math.max(1, v.count || 1);
  const readerPageIndex = Math.min(Math.max(0, v.index || 0), readerPageCount - 1);
  const progressWithinPage = viewMode === 'reader' ? (readerPageIndex + 1) / readerPageCount : 1;
  const percent = readerState ? readerState.current / readerState.total : (pageIndex + progressWithinPage) / pageCount;
  setReadingProgress({
    pageIndex,
    pageCount,
    readerPageIndex,
    readerPageCount,
    percent,
    viewMode,
  });
  if (flush) flushActiveDoc();
}

let readingProgressTimer: number | undefined;
function recordBookReadingProgressSoon(): void {
  window.clearTimeout(readingProgressTimer);
  readingProgressTimer = window.setTimeout(() => {
    readingProgressTimer = undefined;
    recordBookReadingProgress();
  }, 240);
}

function flushBookReadingProgress(): void {
  window.clearTimeout(readingProgressTimer);
  readingProgressTimer = undefined;
  recordBookReadingProgress(true);
}

/** 切到写区视图（日记=new / 书籍=book，都复用同一张画布），并同步左缘高亮 + 标记可写态。 */
function showWritable(read: 'new' | 'book' = 'new'): void {
  closeLayoutPanel();
  closeMarkSummaryPanel();
  leaveActiveMeetingForReading();
  document.body.dataset.mode = 'read';
  document.body.dataset.read = read;
  const hl = read === 'book' ? 'books' : 'new'; // 书籍读书面高亮「书籍」，日记高亮「新日记」
  for (const b of document.querySelectorAll<HTMLElement>('#read-sub [data-read]')) {
    const on = b.dataset.read === hl;
    b.classList.toggle('on', on); b.classList.toggle('dim', !on);
    b.closest('.rl-item')?.classList.toggle('cur', on);
  }
  document.body.classList.add('writable'); // 模块切视图时自己点亮工具格子（不依赖 inline updateWritable）
}

function triggerDiaryBoardOcrOnLeave(): void {
  const documentId = state.surfaceType === 'whiteboard' && state.documentId?.startsWith('diary') ? state.documentId : null;
  if (!documentId) return;
  void flushBoardOcrMarks().then(() => triggerBoardOcr(documentId));
}

/** 点「新日记」=先建并落库一份新日记文件，再渲染空白可写页。 */
async function newDiary(): Promise<void> {
  triggerDiaryBoardOcrOnLeave();
  const d = new Date();
  const title = `${d.getMonth() + 1}.${d.getDate()} 日记`;
  const id = shortId('diary');
  const doc = await createDiaryDoc(id, title, 1); // 先有文件（立即落库）
  showWritable('new');
  titleEl.contentEditable = 'true';
  titleEl.textContent = title;
  titleEl.dataset.auto = '1'; // 自动占位（待手写命名）——将来第一段手写覆盖
  renderBlankSurface(id, title, { ...RULED, ...dim() }); // 满铺写区
  getActiveContext().storeDoc = doc; setActiveDoc(doc); // R6：store.current = 这本日记
  updatePageInd();
  applyViewMode(); // 新日记=白板，复位成原版视图
}

/** 重开一篇已存日记（从日记列表点开）。 */
function openDiary(doc: PersistedDoc): void {
  if (state.documentId !== doc.document_id) triggerDiaryBoardOcrOnLeave();
  const title = doc.filename || '未命名';
  showWritable('new'); // 必须先让写区可见——隐藏时 stage-wrap.clientWidth=0，纸会被算成 0 宽
  titleEl.contentEditable = 'true';
  titleEl.textContent = title;
  titleEl.dataset.auto = '0'; // 已有标题
  renderBlankSurface(doc.document_id, title, { ...RULED, ...dim() }); // emit document:loaded → 账本恢复笔迹
  state.pageCount = doc.page_count || 1; // renderBlankSurface 写死 1，复原真页数
  getActiveContext().storeDoc = doc; setActiveDoc(doc);
  updatePageInd();
  applyViewMode(); // 日记=白板，复位成原版视图（从文本阅读态的书切来时要把 #reader 收掉、露回画布）
}

// ════ 书籍：PDF 导入/重开（复用同一张画布，surfaceType=article） ════
const fileIn = el<HTMLInputElement>('m-file-in');

function useOriginalPageMode(persist = true): void {
  lastReaderPageState = null;
  if (settings.viewMode === 'page') return;
  settings.viewMode = 'page';
  if (persist) saveSettings();
}

function useReaderMode(): void {
  if (settings.viewMode === 'reader') return;
  settings.viewMode = 'reader';
  saveSettings();
}

function currentReadingExperience(): ReadingExperience | null {
  const sourceKind = currentSourceKind();
  return sourceKind ? readingExperienceForSource(sourceKind) : null;
}

function currentTextReaderAvailable(): boolean {
  return !!currentReadingExperience()?.controls.textReader;
}

function currentArticleCanReflow(): boolean {
  return state.surfaceType === 'article' && !!state.documentId && currentTextReaderAvailable() && state.textBlocks.length > 0;
}

function originalPdfControlsAvailable(): boolean {
  return pdfOriginalControlsAvailable(currentReadingExperience());
}

function currentPageLayoutControlsAvailable(): boolean {
  return pageLayoutControlsAvailable(currentReadingExperience());
}

function setReaderStateBadge(label = '', detail = ''): void {
  let badge = document.getElementById('reader-state-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'reader-state-badge';
    el('view-toggle').insertAdjacentElement('afterend', badge);
  }
  badge.textContent = label;
  badge.title = detail;
  badge.hidden = !label || document.body.dataset.read !== 'book';
}

function syncLayoutPanel(): void {
  const panel = document.getElementById('layout-panel');
  const toggle = document.getElementById('layout-toggle');
  if (!panel || !toggle) return;
  if (document.body.dataset.read !== 'book') panel.hidden = true;
  const experience = currentReadingExperience();
  const canUseLayoutControls = pageLayoutControlsAvailable(experience);
  const canUsePdfControls = originalPdfControlsAvailable();
  const disabledHint = readingControlsUnavailableHint(experience);
  const zoomHint = canUsePdfControls ? '' : (experience ? '缩放只作用于 PDF 原版页' : '先打开一本书');
  toggle.hidden = document.body.dataset.read !== 'book' || !canUseLayoutControls;
  if (!canUseLayoutControls) panel.hidden = true;
  const open = !panel.hidden;
  toggle.classList.toggle('on', open);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-layout]')) {
    const selected = button.dataset.layout === settings.pageLayout;
    button.disabled = !canUseLayoutControls;
    button.title = canUseLayoutControls ? '' : disabledHint;
    button.classList.toggle('on', canUseLayoutControls && selected);
    button.setAttribute('aria-pressed', canUseLayoutControls && selected ? 'true' : 'false');
  }
  const zoomRows = new Set<HTMLElement>();
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-zoom-mode]')) {
    const row = button.closest<HTMLElement>('.layout-row');
    if (row) zoomRows.add(row);
    const selected = button.dataset.zoomMode === settings.zoomMode;
    button.disabled = !canUsePdfControls;
    button.title = canUsePdfControls ? '' : zoomHint;
    button.classList.toggle('on', canUsePdfControls && selected);
    button.setAttribute('aria-pressed', canUsePdfControls && selected ? 'true' : 'false');
  }
  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-zoom-percent]')) {
    const row = button.closest<HTMLElement>('.layout-row');
    if (row) zoomRows.add(row);
    const value = Number(button.dataset.zoomPercent);
    const selected = settings.zoomMode === 'percent' && value === settings.zoomPercent;
    button.disabled = !canUsePdfControls;
    button.title = canUsePdfControls ? '' : zoomHint;
    button.classList.toggle('on', canUsePdfControls && selected);
    button.setAttribute('aria-pressed', canUsePdfControls && selected ? 'true' : 'false');
  }
  zoomRows.forEach((row) => { row.hidden = !canUsePdfControls; });
}

function closeLayoutPanel(): void {
  const panel = document.getElementById('layout-panel');
  if (panel) panel.hidden = true;
  syncLayoutPanel();
}

async function applyOriginalLayoutChange(update: () => void, opts: { pdfOnly?: boolean } = {}): Promise<void> {
  if (document.body.dataset.read !== 'book') return;
  const allowed = opts.pdfOnly ? originalPdfControlsAvailable() : currentPageLayoutControlsAvailable();
  if (!allowed) {
    syncLayoutPanel();
    return;
  }
  flushRegion('view-switch');
  update();
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  syncLayoutPanel();
  bus.emit('view:changed');
  if (state.surfaceType !== 'article') return;
  const ctx = getActiveContext();
  if (ctx.pdf) await renderPage();
  else if (ctx.syntheticDoc) renderSyntheticSurface();
  redrawInk();
  updatePageInd();
  recordBookReadingProgressSoon();
}

async function ensureCurrentPageTextLayer(forceRefresh = false): Promise<boolean> {
  if (state.surfaceType !== 'article') return false;
  if (!currentTextReaderAvailable()) return false;
  const ctx = getActiveContext();
  if (ctx.pdf && (forceRefresh || !state.textBlocks.length)) await (settings.viewMode === 'reader' ? renderPageTextLayerOnly() : renderPage());
  else if (ctx.syntheticDoc && !state.textBlocks.length) renderSyntheticSurface();
  return currentArticleCanReflow();
}

async function enterReaderModeForCurrentBook(opts: { forceRefresh?: boolean; notifyOnFail?: boolean } = {}): Promise<boolean> {
  lastReaderPageState = null;
  if (!currentTextReaderAvailable()) {
    useOriginalPageMode(false);
    applyViewMode();
    setReaderStateBadge('原版阅读', 'PDF 使用原版页面阅读');
    return false;
  }
  const ready = await ensureCurrentPageTextLayer(!!opts.forceRefresh);
  if (!ready) {
    useOriginalPageMode(false);
    applyViewMode();
    setReaderStateBadge('原版阅读', '没有可用文本层');
    if (opts.notifyOnFail) void infoSheet({ title: '无法进入阅读模式', message: '这一页没有可用文本层，已保留原版页面。' });
    return false;
  }
  useReaderMode();
  applyViewMode();
  bus.emit('view:changed');
  updatePageInd();
  return true;
}

/** 重开一本已存的书（书架点开）：复用读书面，reopenBook → loadIntoState 渲首页 + emit document:loaded。 */
function restoreReaderPageProgress(doc: Pick<PersistedDoc, 'last_read_progress'>): void {
  const saved = doc.last_read_progress;
  if (saved?.view_mode !== 'reader' || !saved.reader_page_index) return;
  let attempts = 0;
  const target = saved.reader_page_index;
  const apply = (): void => {
    if (document.body.dataset.read !== 'book' || settings.viewMode !== 'reader') return;
    const v = readerVInfo();
    if (v.count > target || attempts >= 8) {
      readerSetVPage(target);
      updatePageInd();
      return;
    }
    attempts += 1;
    window.setTimeout(apply, 120);
  };
  window.setTimeout(apply, 0);
}

async function openBook(doc: Pick<PersistedDoc, 'document_id' | 'filename' | 'last_read_progress'>): Promise<void> {
  lastReaderPageState = null;
  disarmM103HqHwAreaNow();
  useOriginalPageMode();
  clearReadingSurfacePixels();
  showWritable('book'); // 先让写区可见（reopenBook 内 renderPage 读 stage-wrap.clientWidth）
  applyViewMode();
  titleEl.contentEditable = 'false'; // 书名只读
  titleEl.dataset.auto = '0';
  titleEl.textContent = doc.filename || '未命名';
  const ok = await reopenBook(doc.document_id, doc.filename || '未命名');
  if (!ok) { titleEl.textContent = (doc.filename || '未命名') + '（无文件字节）'; return; }
  updatePageInd();
  applyViewMode();
  if (doc.last_read_progress?.view_mode === 'reader') {
    void enterReaderModeForCurrentBook({ forceRefresh: true }).then((ready) => {
      if (ready) restoreReaderPageProgress(doc);
    });
  }
}

/** 导入一份新 PDF（file input / 文件桥读出的 File）。 */
async function importPdfFile(f: File, source: 'paper_file' | 'paper_wifi' = 'paper_file'): Promise<void> {
  lastReaderPageState = null;
  useOriginalPageMode();
  clearReadingSurfacePixels();
  showWritable('book');
  applyViewMode();
  titleEl.contentEditable = 'false';
  titleEl.dataset.auto = '0';
  titleEl.textContent = f.name;
  let loaded: Awaited<ReturnType<typeof loadFile>> = null;
  try {
    loaded = await loadFile(f); // 落库 + 渲首页 + emit document:loaded
  } catch (e) {
    // B7-bug2 联动：storePdfBlob 现在写失败会上抛，这里必须接住并告知用户，别让用户以为导入成功了。
    void infoSheet({ title: '导入失败', message: `《${f.name}》未能保存：${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  updatePageInd();
  await recordLocalImportedSource(f, loaded, source);
  void uploadLoadedDocumentSource(f, loaded, source).finally(() => void renderBookShelf());
  void renderBookShelf(); // 新书进书架
}
fileIn.addEventListener('change', () => {
  const f = fileIn.files?.[0]; fileIn.value = '';
  if (f) void importPdfFile(f);
});

/** 导入入口：有原生文件桥（电纸屏·系统选择器看不见）走 WebView 内浏览器；否则用系统文件选择器。 */
function importBook(): void {
  const bridges = window as unknown as { InkLoopFiles?: { list?: unknown }; InkLoopLanImport?: { start?: unknown } };
  if ((bridges.InkLoopFiles && typeof bridges.InkLoopFiles.list === 'function')
    || (bridges.InkLoopLanImport && typeof bridges.InkLoopLanImport.start === 'function')) void openFileBrowser(); // 原生桥（设备）
  else fileIn.click(); // dev/preview：系统选择器
}

// ── 书架（真数据 listBooks）──
// 书架是内容入口，不做虚拟分页；否则少量书籍时会出现离内容很远的 1/2 页码，像布局 bug。
const shelfCoverHydrationIds = new Set<string>();
const activeLibraryActionIds = new Set<string>();

async function hydrateShelfCoverIfNeeded(item: LibraryShelfItem): Promise<void> {
  if (item.doc?.cover_image_data_url || item.cover_image_data_url || !item.local_available || shelfKindLabel(item) !== 'EPUB') return;
  if (shelfCoverHydrationIds.has(item.document_id)) return;
  shelfCoverHydrationIds.add(item.document_id);
  try {
    const blob = await loadPdfBlob(item.document_id);
    if (!blob) return;
    const cover = extractEpubCoverImageDataUrl(await blob.arrayBuffer());
    if (!cover) return;
    await setDocCoverImageDataUrl(item.document_id, cover);
    if (document.body.dataset.read === 'books') void renderBookShelf();
  } catch {
    // 封面是装饰性缓存，失败不影响阅读/同步。
  } finally {
    shelfCoverHydrationIds.delete(item.document_id);
  }
}

async function renderBookShelf(): Promise<void> {
  if (document.body.dataset.mode === 'read' && document.body.dataset.read === 'books') {
    document.body.classList.remove('writable');
    disarmM103HqHwAreaNow();
  }
  const vbody = el('rv-books').querySelector<HTMLElement>('.vbody');
  const cnt = el('rv-books').querySelector('.cnt');
  if (!vbody) return;
  const host = document.createElement('div');
  host.className = 'shelf-grid';
  const books = (await listLibraryItems()).filter(isUserVisibleLibraryItem);
  if (cnt) cnt.textContent = `${books.length} 本`;
  vbody.textContent = '';
  const cards: HTMLElement[] = [];
  for (const b of books) {
    const card = createLibraryBookCard(b, {
      mode: 'paper',
      active: activeLibraryActionIds.has(b.document_id),
      onOpen: openLibraryItem,
      onDelete: deleteLibraryBook,
      onCoverHydrateNeeded: (item) => void hydrateShelfCoverIfNeeded(item),
        progress: { readerPageInfo },
    });
    cards.push(card);
  }
  // 导入卡（与书卡同尺寸）
  const imp = createLibraryImportCard(importBook, { mode: 'paper' });
  cards.push(imp);
  for (const card of cards) host.appendChild(card);
  vbody.appendChild(host);
}

async function deleteLibraryBook(item: LibraryShelfItem): Promise<void> {
  if (activeLibraryActionIds.has(item.document_id)) return;
  const title = item.filename.replace(/\.(pdf|epub|md|markdown)$/i, '') || item.filename;
  const hasCloudCopy = hasCloudLibraryItem(item);
  const choice = hasCloudCopy
    ? await confirmSheetWithOption({
      title: '删除书籍',
      message: `删除《${title}》的本机副本？会移除本机源文件、阅读进度、标记和 AI 记录。Cloud Hub 默认保留，之后可从书架重新下载。`,
      confirm: '删除',
      option: {
        label: '同时从书架删除',
        hint: '勾选后会同时删除 Cloud Hub 源文件，其他设备的书架也会移除。',
      },
    })
    : {
      confirmed: await confirmSheet({
        title: '删除书籍',
        message: `删除《${title}》？这本书没有 Cloud Hub 副本，会从本机书架移除源文件、阅读进度、标记和 AI 记录。`,
        confirm: '删除',
      }),
      checked: false,
    };
  if (!choice.confirmed) return;
  activeLibraryActionIds.add(item.document_id);
  void renderBookShelf();
  try {
    const result = await deleteCloudLibraryItem(item, { deleteCloud: choice.checked });
    if (state.documentId === item.document_id) backToBookShelf();
    else void renderBookShelf();
    if (result.cloudError) {
      void infoSheet({ title: '已从本机删除', message: `Cloud Hub 删除暂未完成：${result.cloudError}` });
    }
  } catch (error) {
    void infoSheet({ title: '删除失败', message: `《${item.filename}》未能删除：${String((error as Error)?.message || error)}` });
  } finally {
    activeLibraryActionIds.delete(item.document_id);
    void renderBookShelf();
  }
}

function backToBookShelf(): void {
  closeLayoutPanel();
  closeMarkSummaryPanel();
  flushRegion('manual');
  flushBookReadingProgress();
  disarmM103HqHwAreaNow();
  document.body.dataset.read = 'books';
  document.body.classList.remove('writable');
  clearReadingSurfacePixels();
  void renderBookShelf();
  bus.emit('view:changed');
}

function clearReadingSurfacePixels(): void {
  disarmM103HqHwAreaNow();
  closeLayoutPanel();
  lastReaderPageState = null;
  for (const id of ['ink-layer', 'page-layer']) {
    const canvas = el<HTMLCanvasElement>(id);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width || canvas.clientWidth, canvas.height || canvas.clientHeight);
  }
  el('stage').querySelectorAll('.page-source-flash').forEach((node) => node.remove());
  const reader = el('reader');
  reader.hidden = true;
  reader.classList.remove('reader-processing');
  for (const child of Array.from(reader.children)) {
    if (child instanceof HTMLCanvasElement && child.classList.contains('reader-ink')) {
      const ctx = child.getContext('2d');
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, child.width || child.clientWidth, child.height || child.clientHeight);
      }
      child.style.display = 'none';
      continue;
    }
    child.remove();
  }
  const whisper = el('whisper-layer');
  whisper.replaceChildren();
  whisper.style.display = '';
  el('stage-wrap').style.display = '';
  const badge = document.getElementById('reader-state-badge');
  if (badge) {
    badge.textContent = '';
    badge.hidden = true;
  }
  document.body.classList.remove('insight-open');
  el('stage-wrap').scrollTop = 0;
}

async function openLibraryItem(item: LibraryShelfItem): Promise<void> {
  if (item.local_available) {
    await openBook(item.doc ?? item);
    return;
  }
  showWritable('book');
  titleEl.contentEditable = 'false';
  titleEl.dataset.auto = '0';
  titleEl.textContent = `${item.filename}（下载中）`;
  try {
    await downloadCloudLibraryItem(item);
    const fresh = (await listLibraryItems()).find((entry) => entry.document_id === item.document_id);
    if (fresh?.local_available) {
      await openBook(fresh.doc ?? fresh);
      void renderBookShelf();
      return;
    }
    titleEl.textContent = item.filename;
    updatePageInd();
    applyViewMode();
    void renderBookShelf();
  } catch (error) {
    titleEl.textContent = item.filename;
    void infoSheet({ title: '下载失败', message: `《${item.filename}》暂时无法下载：${String((error as Error)?.message || error)}` });
    void renderBookShelf();
  }
}

function parseNonNegativeInt(value: string | null | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseInkLoopUri(rawUri: string): InkLoopUriTarget {
  const uri = String(rawUri || '').trim();
  if (!uri) throw new Error('empty_inkloop_uri');
  if (/^inkloop:\/\/doc\//i.test(uri)) {
    const url = new URL(uri.replace(/^inkloop:/i, 'https:'));
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const documentId = parts[0] || '';
    const pageToken = parts.findIndex((part) => part === 'page');
    const pageNumber = pageToken >= 0 ? parseNonNegativeInt(parts[pageToken + 1]) : undefined;
    let pageIndex = pageNumber === undefined ? undefined : Math.max(0, pageNumber - 1);
    pageIndex = parseNonNegativeInt(url.searchParams.get('page')) ?? pageIndex;
    const anchor = url.searchParams.get('anchor') || url.searchParams.get('mark') || url.searchParams.get('ko') || undefined;
    if (!documentId) throw new Error('missing_document_id');
    return { documentId, pageIndex, anchor };
  }
  const url = new URL(uri);
  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  let documentId = '';
  let pageIndex: number | undefined;

  if (url.protocol === 'inkloop:' && url.hostname === 'doc') {
    documentId = parts[0] || '';
  } else if ((url.protocol === 'http:' || url.protocol === 'https:') && parts[0] === 'doc') {
    documentId = parts[1] || '';
    parts.splice(0, 1);
  } else {
    throw new Error('unsupported_inkloop_uri');
  }

  const pageToken = parts.findIndex((part) => part === 'page');
  if (pageToken >= 0) {
    const pageNumber = parseNonNegativeInt(parts[pageToken + 1]);
    pageIndex = pageNumber === undefined ? undefined : Math.max(0, pageNumber - 1);
  }
  pageIndex = parseNonNegativeInt(url.searchParams.get('page')) ?? pageIndex;
  const anchor = url.searchParams.get('anchor') || url.searchParams.get('mark') || url.searchParams.get('ko') || undefined;
  if (!documentId) throw new Error('missing_document_id');
  return { documentId, pageIndex, anchor };
}

async function resolveAnchorPage(documentId: string, anchor?: string): Promise<{ pageIndex?: number; pageId?: string; found: boolean }> {
  if (!anchor) return { found: false };
  const marks = await getFoldedMarks(documentId).catch(() => []);
  const mark = (marks as Array<{ mark_id?: string; entry_id?: string; page_index?: number; page_id?: string }>).find((item) =>
    item.mark_id === anchor || item.entry_id === anchor,
  );
  return {
    pageIndex: typeof mark?.page_index === 'number' ? mark.page_index : undefined,
    pageId: mark?.page_id,
    found: !!mark,
  };
}

async function renderOpenedPage(pageIndex: number): Promise<void> {
  const clamped = Math.min(Math.max(0, pageIndex), Math.max(0, state.pageCount - 1));
  state.pageIndex = clamped;
  setLastReadPage(clamped);
  const ctx = getActiveContext();
  if (ctx.pdf) await (settings.viewMode === 'reader' ? renderPageTextLayerOnly() : renderPage());
  else if (ctx.syntheticDoc) renderSyntheticSurface();
  redrawInk();
  updatePageInd();
  applyViewMode();
  recordBookReadingProgress();
}

async function openInkLoopUri(uri: string): Promise<InkLoopOpenResult> {
  const failOpen = (error: unknown, target?: Partial<InkLoopUriTarget>): InkLoopOpenResult => {
    const result: InkLoopOpenResult = {
      schema_version: 'inkloop.source_open_result.v1',
      ok: false,
      uri,
      document_id: target?.documentId,
      anchor: target?.anchor,
      active_document_id: getActiveContext()?.documentId || undefined,
      error: String((error as Error)?.message || error),
    };
    (window as unknown as { __inkloopLastSourceOpen?: InkLoopOpenResult }).__inkloopLastSourceOpen = result;
    return result;
  };

  let target: InkLoopUriTarget;
  try {
    target = parseInkLoopUri(uri);
  } catch (error) {
    return failOpen(error);
  }

  try {
    await pullCloudLibraryManifest().catch(() => undefined);
    let item = (await listLibraryItems()).find((entry) => entry.document_id === target.documentId);
    if (!item) return failOpen('document_not_found', target);

    let downloaded = false;
    if (!item.local_available) {
      await downloadCloudLibraryItem(item);
      downloaded = true;
      item = (await listLibraryItems()).find((entry) => entry.document_id === target.documentId);
    }
    if (!item?.local_available) return failOpen('document_not_local_after_download', target);

    await openBook(item.doc ?? item);
    const anchor = await resolveAnchorPage(target.documentId, target.anchor);
    const pageIndex = target.pageIndex ?? anchor.pageIndex ?? 0;
    await renderOpenedPage(pageIndex);
    const activeDocumentId = getActiveContext()?.documentId || undefined;
    const result: InkLoopOpenResult = {
      schema_version: 'inkloop.source_open_result.v1',
      ok: activeDocumentId === target.documentId,
      uri,
      document_id: target.documentId,
      page_index: state.pageIndex,
      page_id: anchor.pageId || `pg_${target.documentId}_${state.pageIndex + 1}`,
      anchor: target.anchor,
      anchor_found: target.anchor ? anchor.found : undefined,
      downloaded,
      active_document_id: activeDocumentId,
    };
    (window as unknown as { __inkloopLastSourceOpen?: InkLoopOpenResult }).__inkloopLastSourceOpen = result;
    document.body.dataset.inkloopOpenDoc = target.documentId;
    document.body.dataset.inkloopOpenPage = String(state.pageIndex);
    if (target.anchor) document.body.dataset.inkloopOpenAnchor = target.anchor;
    window.dispatchEvent(new CustomEvent('inkloop:source-opened', { detail: result }));
    return result;
  } catch (error) {
    return failOpen(error, target);
  }
}

type MarkSummaryItem = {
  id: string;
  kind: 'mark' | 'ai' | 'bound';
  label: string;
  text: string;
  aiText?: string;
  pageIndex: number;
  pageId: string;
  createdAt: string;
  mark?: PersistedMark;
  turn?: PersistedAiTurn;
  overlay?: ScreenOverlay;
  bbox?: NormBBox;
  documentId: string;
};

interface MarkFocusPayload {
  markId?: string;
  documentId?: string;
  pageId?: string;
  pageIndex?: number | null;
  bbox?: NormBBox;
}

type MarkEntryDraft = Parameters<typeof appendMarkEntry>[0];
type AiTurnEntryDraft = Parameters<typeof appendAiTurnEntry>[0];

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function pageIndexFromPageId(pageId?: string): number | undefined {
  const m = String(pageId || '').match(/_(\d+)$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

type MarkSummaryTone = 'ai' | 'highlight' | 'underline' | 'pen';

function summaryMarkTone(mark: PersistedMark): MarkSummaryTone {
  const action = mark.hmp?.action;
  const origin = String(mark.origin || '');
  const tool = String(mark.tool || '');
  if (tool === 'highlighter' || origin === 'highlighter' || mark.scored_type === 'highlight' || action === 'highlight') return 'highlight';
  if (tool === 'underline' || origin === 'underline' || mark.scored_type === 'underline' || action === 'underline') return 'underline';
  if (tool === 'ai_pen' || tool === 'aipen' || origin === 'ai_pen' || origin === 'aipen') return 'ai';
  return 'pen';
}

function markSummaryTone(item: MarkSummaryItem): MarkSummaryTone {
  return item.kind === 'ai' || item.kind === 'bound' ? 'ai' : item.mark ? summaryMarkTone(item.mark) : 'pen';
}

function markForCurrentSummary(mark: PersistedMark): PersistedMark {
  if (mark.kind_source === 'runtime-sync') return mark;
  if (mark.document_id !== state.documentId) return mark;
  if (mark.page_id !== state.pageId && mark.page_index !== state.pageIndex) return mark;
  const correctedText = correctedMarkedTextForPhysicalPenLine(mark, state.textBlocks);
  if (!correctedText) return mark;
  const currentText = (mark.marked_text || '').trim();
  if (correctedText === currentText && mark.scored_type !== 'circle') return mark;
  return {
    ...mark,
    marked_text: correctedText,
    scored_type: mark.scored_type === 'circle' ? 'underline' : mark.scored_type,
    kind_source: mark.kind_source || 'local_text_line',
  };
}

function unionNormBbox(a: NormBBox, b: NormBBox): NormBBox {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]), y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
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

function hasImpossiblePageNormBbox(mark: PersistedMark): boolean {
  if (mark.coord_space === 'reader_px' || mark.surface_coord_space === 'reader_px') return false;
  return !safePageNormBbox(mark.bbox);
}

function bboxCenterInInflated(region: NormBBox, bbox: NormBBox, pad: number): boolean {
  const cx = bbox[0] + bbox[2] / 2;
  const cy = bbox[1] + bbox[3] / 2;
  return cx >= region[0] - pad && cx <= region[0] + region[2] + pad
    && cy >= region[1] - pad && cy <= region[1] + region[3] + pad;
}

function isPlainPenStrokeMark(mark: PersistedMark): boolean {
  if (mark.is_tombstone) return false;
  const origin = String(mark.origin || '');
  if (origin === 'ai_pen' || origin === 'aipen') return false;
  if (mark.tool !== 'pen' && origin !== 'pen') return false;
  const markedText = (mark.marked_text || '').trim();
  const hasSemanticText = !!markedText && !/^stroke(?:_group)?$/i.test(markedText) && !/^手写 \d+ 笔$/.test(markedText);
  const plainStrokeShape = mark.scored_type === 'stroke' || mark.scored_type === 'stroke_group';
  if (hasSemanticText && !plainStrokeShape) return false;
  if (mark.ai_eligible === true && !plainStrokeShape) return false;
  return mark.strokes.length > 0 && (plainStrokeShape || mark.feature_type === 'drawing' || mark.feature_type === 'handwriting');
}

function canFoldPenSummaryMark(group: PersistedMark, mark: PersistedMark): boolean {
  if (group.page_id !== mark.page_id || group.capture_surface !== mark.capture_surface) return false;
  const groupTime = Date.parse(group.created_at);
  const markTime = Date.parse(mark.created_at);
  if (Number.isFinite(groupTime) && Number.isFinite(markTime) && Math.abs(markTime - groupTime) > 12_000) return false;
  const pad = mark.capture_surface === 'reader' ? 0.075 : 0.055;
  return bboxCenterInInflated(group.bbox, mark.bbox, pad) || bboxCenterInInflated(mark.bbox, group.bbox, pad);
}

function combinePenSummaryMarks(group: PersistedMark, mark: PersistedMark): PersistedMark {
  const bbox = unionNormBbox(group.bbox, mark.bbox);
  const markedTexts = [group.marked_text, mark.marked_text]
    .map((text) => (text || '').trim())
    .filter((text) => text && !/^stroke(?:_group)?$/i.test(text) && !/^手写 \d+ 笔$/.test(text));
  const strokeCount = group.strokes.length + mark.strokes.length;
  return {
    ...group,
    bbox,
    strokes: [...group.strokes, ...mark.strokes],
    feature_type: 'handwriting',
    feature_confidence: Math.max(group.feature_confidence || 0, mark.feature_confidence || 0, 0.85),
    kind: group.kind || mark.kind || 'handwriting',
    kind_source: group.kind_source || mark.kind_source || 'local_group',
    scored_type: 'stroke_group',
    scored_score: Math.max(group.scored_score || 0, mark.scored_score || 0, 0.8),
    marked_text: markedTexts.length ? [...new Set(markedTexts)].join(' / ') : `手写 ${strokeCount} 笔`,
    reflow_anchor_runs: [...new Set([...(group.reflow_anchor_runs ?? []), ...(mark.reflow_anchor_runs ?? [])])],
  };
}

function coalescePenSummaryMarks(marks: PersistedMark[]): PersistedMark[] {
  const out: PersistedMark[] = [];
  for (const mark of [...marks].sort((a, b) => (a.page_index - b.page_index) || (a.seq - b.seq) || a.created_at.localeCompare(b.created_at))) {
    if (!isPlainPenStrokeMark(mark)) {
      out.push(mark);
      continue;
    }
    let lastIndex = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (isPlainPenStrokeMark(out[i]) && canFoldPenSummaryMark(out[i], mark)) { lastIndex = i; break; }
    }
    if (lastIndex >= 0) out[lastIndex] = combinePenSummaryMarks(out[lastIndex], mark);
    else out.push(mark);
  }
  return out;
}

async function collectMarkSummaryItems(documentId: string): Promise<MarkSummaryItem[]> {
  const [marks, turns] = await Promise.all([getFoldedMarks(documentId), getBookAiTurns(documentId)]);
  const latestTurn = new Map<string, PersistedAiTurn>();
  for (const turn of turns) {
    const old = latestTurn.get(turn.overlay_id);
    if (!old || turn.seq > old.seq) latestTurn.set(turn.overlay_id, turn);
  }
  const visibleMarks = coalescePenSummaryMarks(marks.filter((mark) => !hasImpossiblePageNormBbox(mark)))
    .filter((mark) => !isSummaryHiddenMark(mark))
    .map(markForCurrentSummary);
  const out: MarkSummaryItem[] = buildRecords(visibleMarks, [...latestTurn.values()]).map((record) => ({
    id: record.id,
    kind: record.kind,
    label: record.label,
    text: record.anchorText,
    aiText: record.aiText,
    pageIndex: record.pageIndex ?? record.mark?.page_index ?? record.turn?.page_index ?? 0,
    pageId: record.pageId || record.mark?.page_id || record.turn?.page_id || state.pageId || `pg_${documentId}_0`,
    createdAt: record.createdAt,
    mark: record.mark,
    turn: record.turn,
    overlay: record.overlay,
    bbox: record.mark?.bbox ?? record.turn?.inference_view?.anchor_bbox ?? record.overlay?.geometry.anchor_bbox,
    documentId,
  }));
  return out.sort((a, b) => (a.pageIndex - b.pageIndex) || a.createdAt.localeCompare(b.createdAt));
}

function markSummaryTitle(item: MarkSummaryItem): string {
  const text = item.kind === 'ai'
    ? (item.turn?.inference_view?.question || item.turn?.inference_view?.marked || item.text)
    : item.text;
  return text.replace(/\s+/g, ' ').trim() || `${item.label} · 第 ${item.pageIndex + 1} 页`;
}

function markSummaryAiText(item: MarkSummaryItem): string {
  return (item.aiText || item.turn?.user_edited_text || item.turn?.ai_reply || item.overlay?.display_text || '').replace(/\s+/g, ' ').trim();
}

function markSummaryTimeText(item: MarkSummaryItem): string {
  try {
    return new Date(item.createdAt).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return item.createdAt;
  }
}

function createMarkSummaryRow(item: MarkSummaryItem, index: number, onSelect: () => void): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `mark-summary-item ${item.kind}`;
  row.dataset.id = item.id;
  row.dataset.tone = markSummaryTone(item);
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', index === 0 ? 'true' : 'false');

  const body = document.createElement('span');
  body.className = 'mark-summary-row-body';
  const top = document.createElement('span');
  top.className = 'mark-summary-row-top';
  const tag = document.createElement('span');
  tag.className = 'mark-summary-tag';
  tag.textContent = item.label;
  const page = document.createElement('span');
  page.className = 'mark-summary-page';
  page.textContent = markSummaryPageText(item);
  top.append(tag, page);
  const title = document.createElement('span');
  title.className = 'mark-summary-title';
  const titleText = document.createElement('span');
  titleText.className = 'mark-summary-title-text';
  titleText.textContent = markSummaryTitle(item);
  title.appendChild(titleText);
  const meta = document.createElement('span');
  meta.className = 'mark-summary-meta';
  meta.textContent = `${item.kind === 'bound' ? '锚定标记 + AI 返回' : item.kind === 'ai' ? 'AI 旁注' : '原始标记'} · ${markSummaryTimeText(item)}`;
  body.append(top, title, meta);
  const aiText = item.kind === 'bound' ? markSummaryAiText(item) : '';
  if (aiText) {
    const ai = document.createElement('span');
    ai.className = 'mark-summary-ai';
    const aiLabel = document.createElement('span');
    aiLabel.className = 'mark-summary-ai-label';
    aiLabel.textContent = 'AI 返回';
    const aiBody = document.createElement('span');
    aiBody.className = 'mark-summary-ai-text';
    aiBody.textContent = aiText;
    ai.append(aiLabel, aiBody);
    body.appendChild(ai);
  }
  row.appendChild(body);
  row.addEventListener('click', onSelect);
  return row;
}

function markSummaryPageText(item: MarkSummaryItem): string {
  if (state.surfaceType === 'article' && settings.viewMode === 'reader') {
    const pageCount = readerPageCountForSource(item.pageIndex);
    const readerPageIndex = estimateReaderPageIndexFromBbox(item.bbox, pageCount.count);
    const info = readerDocumentPageInfo(item.pageIndex, state.pageCount, readerPageIndex, pageCount.count);
    return `${info.estimated || pageCount.estimated ? '约' : ''}第 ${info.current}/${info.total} 页`;
  }
  return `原文第 ${item.pageIndex + 1}/${Math.max(1, state.pageCount || item.pageIndex + 1)} 页`;
}

function flashOriginalBbox(bbox?: NormBBox, pageId?: string): boolean {
  const region = pageRegionForId(pageId);
  const w = region?.w ?? pageCss.w;
  const h = region?.h ?? pageCss.h;
  const safeBbox = safePageNormBbox(bbox);
  if (!safeBbox || !w || !h) return false;
  const stage = el('stage');
  stage.querySelectorAll('.page-source-flash').forEach((node) => node.remove());
  const pos = normToPx(safeBbox[0], safeBbox[1], pageId);
  const flash = document.createElement('div');
  flash.className = 'page-source-flash';
  flash.style.cssText = `left:${Math.max(0, pos.x - 4)}px;top:${Math.max(0, pos.y - 4)}px;width:${Math.max(10, safeBbox[2] * w + 8)}px;height:${Math.max(10, safeBbox[3] * h + 8)}px;`;
  stage.appendChild(flash);
  window.setTimeout(() => flash.remove(), 1800);
  return true;
}

async function ensureSourceDocumentOpen(documentId: string): Promise<boolean> {
  leaveActiveMeetingForReading();
  const sameDocument = state.documentId === documentId && getActiveContext()?.documentId === documentId;
  if (sameDocument) {
    if (document.body.dataset.mode !== 'read' || document.body.dataset.read !== 'book') {
      showWritable('book');
      applyViewMode();
      if (state.surfaceType === 'article') await renderOpenedPage(state.pageIndex);
    }
    return true;
  }
  const item = (await listLibraryItems()).find((entry) => entry.document_id === documentId);
  if (!item) {
    void infoSheet({ title: '找不到原文', message: '这条标记对应的源文件不在当前书架里。' });
    return false;
  }
  await openLibraryItem(item);
  return getActiveContext()?.documentId === documentId;
}

async function focusMarkSummaryItem(item: MarkSummaryItem): Promise<void> {
  closeMarkSummaryPanel();
  const opened = await ensureSourceDocumentOpen(item.documentId);
  if (!opened) return;
  const targetPage = Math.max(0, Math.min(state.pageCount - 1, item.pageIndex ?? pageIndexFromPageId(item.pageId) ?? state.pageIndex));
  if (targetPage !== state.pageIndex) await renderOpenedPage(targetPage);
  if (settings.viewMode === 'reader') {
    await enterReaderModeForCurrentBook();
    await nextFrame(); await nextFrame();
    const ok = item.mark ? readerFocusMark(item.mark) : item.overlay ? readerFocusOverlay(item.overlay) : false;
    if (!ok) {
      useOriginalPageMode();
      applyViewMode();
      flashOriginalBbox(item.bbox, item.pageId);
    }
    return;
  }
  flashOriginalBbox(item.bbox, item.pageId);
}

async function focusRuntimeMarkRecord(payload: MarkFocusPayload): Promise<void> {
  const documentId = payload.documentId || state.documentId;
  if (!documentId) return;
  const pageIndex = Math.max(0, payload.pageIndex ?? pageIndexFromPageId(payload.pageId) ?? state.pageIndex);
  await focusMarkSummaryItem({
    id: payload.markId || `${documentId}:${pageIndex}`,
    kind: 'mark',
    label: '标记',
    text: '标记快照',
    pageIndex,
    pageId: payload.pageId || pageIdFor(documentId, pageIndex),
    createdAt: new Date().toISOString(),
    bbox: payload.bbox,
    documentId,
  });
}

function closeMarkSummaryPanel(): void {
  document.querySelector('.mark-summary-scrim')?.remove();
  document.querySelector('.mark-summary')?.remove();
  document.body.classList.remove('mark-summary-open');
}

async function openMarkSummaryPanel(): Promise<void> {
  if (!state.documentId) return;
  closeMarkSummaryPanel();
  const items = await collectMarkSummaryItems(state.documentId);
  const scrim = document.createElement('button');
  scrim.type = 'button';
  scrim.className = 'mark-summary-scrim';
  scrim.setAttribute('aria-label', '关闭标记摘要');
  scrim.addEventListener('click', closeMarkSummaryPanel);
  const panel = document.createElement('aside');
  panel.className = 'mark-summary';
  panel.innerHTML = '<div class="mark-summary-head"><div><strong>标记摘要</strong><span class="mark-summary-count"></span></div><button class="mark-summary-close" type="button" aria-label="关闭">×</button></div><div class="mark-summary-body"><div class="mark-summary-list" role="listbox"></div></div>';
  panel.querySelector('.mark-summary-close')?.addEventListener('click', closeMarkSummaryPanel);
  const count = panel.querySelector('.mark-summary-count') as HTMLElement;
  const list = panel.querySelector('.mark-summary-list') as HTMLElement;
  count.textContent = `${items.length} 项`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mark-summary-empty';
    empty.textContent = '暂无标记。高亮、划线、AI 笔和手写内容会在这里形成可回跳的快照。';
    list.appendChild(empty);
  }
  const rows: HTMLButtonElement[] = [];
  const select = (item: MarkSummaryItem, row: HTMLButtonElement): void => {
    for (const r of rows) {
      const selected = r === row;
      r.classList.toggle('selected', selected);
      r.setAttribute('aria-selected', String(selected));
    }
    void focusMarkSummaryItem(item);
  };
  items.forEach((item, index) => {
    const row = createMarkSummaryRow(item, index, () => select(item, row));
    rows.push(row);
    list.appendChild(row);
  });
  if (rows[0]) rows[0].classList.add('selected');
  el('rv-new').append(scrim, panel);
  document.body.classList.add('mark-summary-open');
}

async function findTurnForOverlay(overlay: ScreenOverlay): Promise<{ documentId: string; turn?: PersistedAiTurn }> {
  const docIds = new Set<string>();
  if (state.documentId) docIds.add(state.documentId);
  for (const book of await listBooks().catch(() => [])) docIds.add(book.document_id);
  for (const documentId of docIds) {
    const turns = await getBookAiTurns(documentId).catch(() => []);
    const turn = turns.find((entry) => entry.overlay_id === overlay.overlay_id);
    if (turn) return { documentId, turn };
  }
  return { documentId: state.documentId || getActiveContext()?.documentId || '', turn: undefined };
}

async function focusOverlaySource(overlay: ScreenOverlay): Promise<void> {
  const { documentId, turn } = await findTurnForOverlay(overlay);
  if (!documentId) {
    void infoSheet({ title: '找不到原文', message: '这条 AI 旁注没有可回跳的源文件记录。' });
    return;
  }
  const opened = await ensureSourceDocumentOpen(documentId);
  if (!opened) return;
  const targetPage = Math.max(0, Math.min(
    Math.max(0, state.pageCount - 1),
    turn?.page_index ?? pageIndexFromPageId(overlay.page_id) ?? state.pageIndex,
  ));
  const bbox = turn?.inference_view?.anchor_bbox ?? overlay.geometry.anchor_bbox;
  useOriginalPageMode();
  applyViewMode();
  if (targetPage !== state.pageIndex) await renderOpenedPage(targetPage);
  else if (state.surfaceType === 'article') {
    await renderPage();
    redrawInk();
    updatePageInd();
    recordBookReadingProgressSoon();
  }
  flashOriginalBbox(bbox, turn?.page_id ?? overlay.page_id);
}

function startupInkLoopUri(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('inkloop_uri') || url.searchParams.get('inkloop_url');
    if (fromQuery) return fromQuery;
    const hash = url.hash.replace(/^#/, '');
    if (hash.startsWith('inkloop=')) return decodeURIComponent(hash.slice('inkloop='.length));
  } catch {
    // Ignore malformed browser state; manual source links still work through __inkloop.
  }
  return null;
}

el('read-sub').querySelector<HTMLElement>('[data-read="books"]')?.addEventListener('click', () => {
  document.body.dataset.read = 'books';
  document.body.classList.remove('writable');
  disarmM103HqHwAreaNow();
  void renderBookShelf();
});
document.getElementById('book-back')?.addEventListener('click', backToBookShelf);
document.getElementById('book-marks')?.addEventListener('click', () => void openMarkSummaryPanel());
bus.on('reader:source-focus', (overlay) => void focusOverlaySource(overlay as ScreenOverlay));
bus.on('mark:focus', (payload) => void focusRuntimeMarkRecord(payload as MarkFocusPayload));
document.getElementById('books-import')?.addEventListener('click', importBook);
document.getElementById('books-meet')?.addEventListener('click', () => {
  document.querySelector<HTMLElement>('.nav [data-mode="meet"]')?.click();
});
document.querySelector<HTMLElement>('.nav [data-mode="read"]')?.addEventListener('click', () => {
  document.body.dataset.read = 'books';
  document.body.classList.remove('writable');
  disarmM103HqHwAreaNow();
  void renderBookShelf();
});

// ── WebView 内文件浏览器（电纸屏：系统选择器看不见，需安卓壳 InkLoopFiles 桥枚举 /sdcard）──
// 桥契约：window.InkLoopFiles = { list(path):Promise<{name,path,dir,size?}[]>, readBase64(path):Promise<string> }
// 无桥（web/dev）→ importBook 不会走到这；走到了也安全降级到系统文件选择器。
interface FileEntry { name: string; path: string; dir: boolean; size?: number; uploadedAt?: number }
// 原生桥（InkLoopFilesBridge·addJavascriptInterface）：方法同步返回字符串（list=JSON / readBase64=base64）。
interface ReadableFileBridge { readBase64(p: string): string }
interface FilesBridge extends ReadableFileBridge { list(p: string): string }
interface LanImportState { running: boolean; url?: string | null; token?: string | null; ip?: string | null; port?: number; inbox?: FileEntry[]; error?: string }
interface LanImportBridge extends ReadableFileBridge { start(): string; stop(): string; getState(): string; list(): string; delete?(p: string): boolean }
interface InkLoopUriTarget { documentId: string; pageIndex?: number; anchor?: string }
interface InkLoopOpenResult {
  schema_version: 'inkloop.source_open_result.v1';
  ok: boolean;
  uri: string;
  document_id?: string;
  page_index?: number;
  page_id?: string;
  anchor?: string;
  anchor_found?: boolean;
  downloaded?: boolean;
  active_document_id?: string;
  error?: string;
}
const FILE_ROOT = '/sdcard/Download';
let filesPager: Pager | null = null;
let filesBar: PagerBar | null = null;
let lanInboxPollTimer: number | null = null;
let lanInboxObservedSignature = '';
let lanInboxPollPath = FILE_ROOT;
let lanInboxRefreshInFlight = false;
let lanInboxAutoImportInFlight = false;
let lanInboxLastPaintAt = 0;
const lanInboxAutoImportedKeys = new Set<string>();
let lanImportUiStatus: { state: 'idle' | 'importing' | 'done' | 'failed'; message: string } = {
  state: 'idle',
  message: '',
};

function setLanImportUiStatus(state: typeof lanImportUiStatus.state, message: string): void {
  lanImportUiStatus = { state, message };
}

function lanInboxEntryKey(e: FileEntry): string {
  return `${e.path}:${e.size ?? 0}:${e.uploadedAt ?? 0}`;
}

function isSupportedImportEntry(e: Pick<FileEntry, 'name' | 'dir'>): boolean {
  return !e.dir && /\.(pdf|epub|md|markdown)$/i.test(e.name);
}

function lanInboxSignature(stateNow: LanImportState | null): string {
  const inbox = Array.isArray(stateNow?.inbox) ? stateNow.inbox.filter((e) => !e.dir) : [];
  return inbox
    .map((e) => `${e.path}:${e.name}:${e.size ?? 0}:${e.uploadedAt ?? 0}`)
    .sort()
    .join('|');
}

function clearLanInboxAutoRefresh(): void {
  if (lanInboxPollTimer !== null) window.clearInterval(lanInboxPollTimer);
  lanInboxPollTimer = null;
  lanInboxObservedSignature = '';
  lanInboxRefreshInFlight = false;
  lanInboxLastPaintAt = 0;
}

function startLanInboxAutoRefresh(lan: LanImportBridge, path: string, stateNow: LanImportState | null): void {
  lanInboxPollPath = path;
  lanInboxObservedSignature = lanInboxSignature(stateNow);
  if (lanInboxPollTimer !== null) return;
  lanInboxPollTimer = window.setInterval(() => {
    let next: LanImportState;
    try {
      next = parseBridgeJson<LanImportState>(lan.getState(), { running: false, inbox: [] });
    } catch {
      return;
    }
    if (!next.running && !document.body.classList.contains('files-open')) {
      clearLanInboxAutoRefresh();
      return;
    }
    const nextSignature = lanInboxSignature(next);
    const changed = nextSignature !== lanInboxObservedSignature;
    const shouldPaint = changed || (document.body.classList.contains('files-open') && Date.now() - lanInboxLastPaintAt > 4000);
    if (!shouldPaint || lanInboxRefreshInFlight) return;
    lanInboxObservedSignature = nextSignature;
    lanInboxLastPaintAt = Date.now();
    lanInboxRefreshInFlight = true;
    const inbox = Array.isArray(next.inbox) ? next.inbox.filter((e) => !e.dir) : [];
    void autoImportLanInbox(lan, inbox).finally(() => {
      if (!document.body.classList.contains('files-open')) return;
      void openFileBrowser(lanInboxPollPath);
    }).finally(() => {
      lanInboxRefreshInFlight = false;
    });
  }, 2000);
}

async function openFileBrowser(path: string = FILE_ROOT): Promise<void> {
  const bridge = (window as unknown as { InkLoopFiles?: FilesBridge }).InkLoopFiles;
  const lan = (window as unknown as { InkLoopLanImport?: LanImportBridge }).InkLoopLanImport;
  if (!bridge?.list && !lan?.start) { fileIn.click(); return; }
  document.body.classList.add('files-open');
  const title = el('files').querySelector('.fh .ti') as HTMLElement;
  const crumb = el('files').querySelector('.crumb') as HTMLElement;
  const fls = el('files').querySelector('.fls') as HTMLElement;
  const pager = filesPager ?? (filesPager = createPager(fls, { onChange: (i) => filesBar?.update(i), observe: false }));
  if (!filesBar) filesBar = mountPagerBar(pager, el('files'));
  const host = pager.content;
  title.textContent = lan ? 'WiFi 传书' : '导入文件';
  crumb.textContent = lan && path === FILE_ROOT ? '扫码上传，或浏览本机下载目录' : path;
  host.textContent = '加载中…';
  let entries: FileEntry[] = [];
  let lanState: LanImportState | null = null;
  try {
    if (bridge?.list) {
      const raw = await bridge.list(path);
      entries = JSON.parse(typeof raw === 'string' ? raw : '[]'); // 桥同步返 JSON 串
    }
    if (lan?.start) lanState = readLanImportState(lan);
  } catch { document.body.classList.remove('files-open'); fileIn.click(); return; }
  if (lan) startLanInboxAutoRefresh(lan, path, lanState);
  lanInboxLastPaintAt = Date.now();
  host.textContent = '';
  const addRow = (label: string, meta: string, dir: boolean, onClick: () => void): void => {
    const r = document.createElement('div');
    r.className = dir ? 'frow dir' : 'frow';
    const ic = dir
      ? '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
      : '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>';
    r.innerHTML = `<span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ic}</svg></span><div><div class="nm"></div><div class="mt"></div></div>${dir ? '<span class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>' : ''}`;
    (r.querySelector('.nm') as HTMLElement).textContent = label;
    (r.querySelector('.mt') as HTMLElement).textContent = meta;
    r.addEventListener('click', onClick);
    host.appendChild(r);
  };
  if (lan) renderLanImportPanel(host, lan, lanState, () => void openFileBrowser(path));
  const inbox = Array.isArray(lanState?.inbox) ? lanState!.inbox!.filter((e) => !e.dir) : [];
  if (lan && inbox.length) void autoImportLanInbox(lan, inbox, path);
  if (inbox.length) addSection(host, 'Wi-Fi 收件箱');
  for (const e of inbox) {
    if (isSupportedImportEntry(e)) {
      const imported = lanInboxAutoImportedKeys.has(lanInboxEntryKey(e));
      addRow(e.name, `${formatFileSize(e.size)} · ${imported ? '已加入书架' : '自动加入书架中'}`, false, () => void importFromBridge(lan!, e, 'paper_wifi'));
    }
  }
  if (!entries.length && !inbox.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.style.padding = '20px 12px';
    empty.textContent = bridge?.list ? '这个目录是空的，或缺「所有文件访问」权限（设置里授予后重开）。' : '本机文件桥不可用。可用同一 Wi-Fi 的电脑打开上方地址上传文件。';
    host.appendChild(empty);
  }
  if (path !== FILE_ROOT) addRow('返回上级', '', true, () => void openFileBrowser(path.replace(/\/[^/]+\/?$/, '') || FILE_ROOT));
  if (bridge) {
    if (entries.length) addSection(host, path === FILE_ROOT ? '本机下载目录' : '本机文件');
    for (const e of entries) {
      if (e.dir) addRow(e.name, '文件夹', true, () => void openFileBrowser(e.path));
      else if (/\.pdf$/i.test(e.name)) addRow(e.name, e.size ? `${(e.size / 1048576).toFixed(1)} MB` : 'PDF', false, () => void importFromBridge(bridge, e, 'paper_file'));
      else if (/\.epub$/i.test(e.name)) addRow(e.name, e.size ? `${(e.size / 1048576).toFixed(1)} MB` : 'EPUB', false, () => void importFromBridge(bridge, e, 'paper_file'));
      else if (/\.(md|markdown)$/i.test(e.name)) addRow(e.name, e.size ? `${(e.size / 1024).toFixed(1)} KB` : 'Markdown', false, () => void importFromBridge(bridge, e, 'paper_file'));
      // 其它（HTML/图片）暂不导入——HTML→PDF / 图片转 PDF 走 convert-service，后续
    }
  }
  pager.relayout('first'); // 新目录 → 回首页
}

function addSection(host: HTMLElement, label: string): void {
  const sec = document.createElement('div');
  sec.className = 'fsec';
  sec.textContent = label;
  host.appendChild(sec);
}

function parseBridgeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(typeof raw === 'string' ? raw : '') as T; }
  catch { return fallback; }
}

function readLanImportState(lan: LanImportBridge): LanImportState {
  const fallback: LanImportState = { running: false, inbox: [] };
  return parseBridgeJson<LanImportState>(lan.start(), fallback);
}

function formatFileSize(size?: number): string {
  if (!size) return '0 KB';
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function renderLanImportPanel(host: HTMLElement, lan: LanImportBridge, stateNow: LanImportState | null, refresh: () => void): void {
  const url = stateNow?.url || '';
  const box = document.createElement('div');
  box.className = `lanbox ${url ? 'online' : 'offline'}`;

  const head = document.createElement('div');
  head.className = 'lanhead';
  const title = document.createElement('div');
  title.className = 'lant';
  title.textContent = 'Wi-Fi 局域网上传';
  const badge = document.createElement('div');
  badge.className = 'lanbadge';
  badge.textContent = url ? '已开启' : '未连接';
  head.append(title, badge);

  const body = document.createElement('div');
  body.className = 'lanbody';
  const qr = document.createElement('div');
  qr.className = 'lanqr';
  const right = document.createElement('div');
  right.className = 'lanright';

  const meta = document.createElement('div');
  meta.className = 'lanm';
  meta.textContent = url
    ? '同一 Wi-Fi 的电脑或 iPad 扫码上传文件。文件会先进入本机书架，随后后台同步 Cloud Hub。'
    : (stateNow?.error ? `未启动：${stateNow.error}` : '连接 Wi-Fi 后刷新。');

  const status = document.createElement('div');
  status.className = `lanstatus ${lanImportUiStatus.state}`;
  const inboxCount = Array.isArray(stateNow?.inbox) ? stateNow.inbox.filter((e) => !e.dir).length : 0;
  status.textContent = lanImportUiStatus.message || (url ? (inboxCount ? `检测到 ${inboxCount} 个待导入文件。` : '等待上传文件。') : '未开始。');

  const addr = document.createElement('button');
  addr.type = 'button';
  addr.className = 'lanurl';
  addr.textContent = url || '等待获取设备地址';
  addr.disabled = !url;
  addr.addEventListener('click', () => {
    if (!url) return;
    void navigator.clipboard?.writeText(url);
  });

  if (url) {
    const img = document.createElement('img');
    img.alt = '';
    qr.appendChild(img);
    QRCode.toDataURL(url, { width: 188, margin: 1, color: { dark: '#111111', light: '#ffffff' } })
      .then((src) => { img.src = src; })
      .catch(() => { qr.textContent = 'QR 生成失败'; });
  } else {
    qr.textContent = 'Wi-Fi';
  }

  const actions = document.createElement('div');
  actions.className = 'lana';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = '刷新收件箱';
  refreshBtn.addEventListener('click', refresh);
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.textContent = '关闭上传';
  stopBtn.addEventListener('click', () => {
    try { lan.stop(); } catch { /* no-op */ }
    setLanImportUiStatus('idle', '上传服务已关闭。');
    refresh();
  });
  const shelfBtn = document.createElement('button');
  shelfBtn.type = 'button';
  shelfBtn.textContent = '去书架';
  shelfBtn.addEventListener('click', () => {
    document.body.classList.remove('files-open');
    void renderBookShelf();
  });
  actions.append(refreshBtn, shelfBtn, stopBtn);
  right.append(meta, status, addr, actions);
  body.append(qr, right);
  box.append(head, body);
  host.appendChild(box);
}

function mimeForFileName(name: string): string {
  if (/\.epub$/i.test(name)) return 'application/epub+zip';
  if (/\.(md|markdown)$/i.test(name)) return 'text/markdown';
  return 'application/pdf';
}

async function importFromBridge(bridge: ReadableFileBridge, e: FileEntry, source: 'paper_file' | 'paper_wifi'): Promise<void> {
  try {
    const f = await fileFromBridge(bridge, e);
    if (!f) return; // 读失败（无权限/越权）：留在浏览器
    document.body.classList.remove('files-open');
    await importPdfFile(f, source);
  } catch (error) {
    void infoSheet({ title: '导入失败', message: `《${e.name}》未能导入：${String((error as Error)?.message || error)}` });
  }
}

async function fileFromBridge(bridge: ReadableFileBridge, e: FileEntry): Promise<File | null> {
  const b64 = await bridge.readBase64(e.path);
  if (!b64) return null;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new File([bytes], e.name, { type: mimeForFileName(e.name) });
}

async function syncLanImportedFileToCloud(f: File, loaded: NonNullable<Awaited<ReturnType<typeof importFileToLibrary>>>, pathForRefresh: string): Promise<void> {
  setLanImportUiStatus('importing', `本地可读，正在同步 Cloud Hub：${f.name}`);
  await uploadLoadedDocumentSource(f, loaded, 'paper_wifi');
  const record = await getLibrarySyncRecord(loaded.documentId);
  if (record?.cloud_available && record.sync_status !== 'failed') {
    setLanImportUiStatus('done', `已加入书架并同步 Cloud Hub：${f.name}`);
  } else {
    setLanImportUiStatus('failed', `已加入书架，但 Cloud Hub 同步失败：${record?.error || '稍后自动重试'}`);
  }
  void renderBookShelf();
  if (document.body.classList.contains('files-open')) void openFileBrowser(pathForRefresh);
}

async function autoImportLanInbox(lan: LanImportBridge, inbox: FileEntry[], pathForRefresh = lanInboxPollPath): Promise<void> {
  if (lanInboxAutoImportInFlight) return;
  const candidates = inbox.filter((e) => {
    if (!isSupportedImportEntry(e)) return false;
    return !lanInboxAutoImportedKeys.has(lanInboxEntryKey(e));
  });
  if (!candidates.length) return;
  lanInboxAutoImportInFlight = true;
  let importedAny = false;
  try {
    for (const e of candidates) {
      const key = lanInboxEntryKey(e);
      lanInboxAutoImportedKeys.add(key);
      try {
        setLanImportUiStatus('importing', `正在加入书架：${e.name}`);
        const f = await fileFromBridge(lan, e);
        if (!f) {
          lanInboxAutoImportedKeys.delete(key);
          continue;
        }
        const loaded = await importFileToLibrary(f);
        if (!loaded) {
          lanInboxAutoImportedKeys.delete(key);
          continue;
        }
        await recordLocalImportedSource(f, loaded, 'paper_wifi');
        importedAny = true;
        try { lan.delete?.(e.path); } catch { /* 收件箱清理失败不影响本地入库 */ }
        setLanImportUiStatus('done', `已加入书架：${e.name}。正在同步 Cloud Hub。`);
        void renderBookShelf();
        void syncLanImportedFileToCloud(f, loaded, pathForRefresh).catch((error) => {
          setLanImportUiStatus('failed', `已加入书架，但 Cloud Hub 同步失败：${String((error as Error)?.message || error)}`);
          void renderBookShelf();
        });
      } catch (error) {
        lanInboxAutoImportedKeys.delete(key);
        setLanImportUiStatus('failed', `导入失败：${e.name}。请重试。`);
        console.warn('LAN inbox auto import failed', e.name, error);
      }
    }
  } finally {
    lanInboxAutoImportInFlight = false;
  }
  if (!importedAny) return;
  void renderBookShelf();
  if (document.body.classList.contains('files-open')) void openFileBrowser(pathForRefresh);
}

// 标题手动改 → 脱离自动态、持久化；回车收尾（单行）。
titleEl.addEventListener('input', () => { titleEl.dataset.auto = '0'; });
titleEl.addEventListener('blur', () => {
  const id = state.documentId;
  if (id && state.surfaceType === 'whiteboard') void renameDiary(id, (titleEl.textContent || '未命名').trim());
});
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });

// 第一段手写 → 自动成为标题（仅 data-auto=1 占位态时覆盖；识别出的 markedText 来自后端）。
bus.on('mark:resolved', (p) => {
  const { feature, text } = p as { feature: string; text: string };
  if (state.surfaceType !== 'whiteboard') return;
  // 日记 materialize：在某页写了内容→该页落成真页（page_count 抬到含当前页·只增）。
  // storeDoc 存在=有持久文档(日记)；会议白板 storeDoc=null→跳过。空白翻页过去没写的页不会到这(无 mark)。
  if (getActiveContext().storeDoc) {
    const need = state.pageIndex + 1;
    if (need > state.pageCount) { state.pageCount = need; updatePageInd(); }
    setDiaryPageCount(need); // 落盘 doc.page_count（need<=已存则 no-op）——会议手记也有 storeDoc 故同样 materialize
  }
  // diary-title 自动命名只对「日记」doc（id 以 diary 开头）：会议手记(mtgboard_)的命名归 meeting.ts 的 #mtg-note-title。
  // 按 doc 类型判而非 UI mode——否则首段手写后立刻切到 dev/meet，识别迟到回来时 mode 已变会漏命名。
  const id = state.documentId;
  if (!id?.startsWith('diary')) return;
  if (feature !== 'handwriting' || titleEl.dataset.auto !== '1') return;
  const t = (text || '').trim().split('\n')[0].slice(0, 40);
  if (!t) return;
  titleEl.textContent = t;
  titleEl.dataset.auto = '0';
  void renameDiary(id, t);
});

// 点「新日记」即新建（即便已在新日记页也另起一份）。
el('read-sub').querySelector<HTMLElement>('[data-read="new"]')?.addEventListener('click', () => void newDiary());
// 导航切走即视为离开日记画板；监听注册在 shell 之后，但判定只读尚未被新 surface 覆盖的 state.documentId。
document.querySelectorAll<HTMLElement>('.nav [data-mode], #read-sub [data-read]').forEach((button) => {
  button.addEventListener('click', triggerDiaryBoardOcrOnLeave);
});
if (document.body.dataset.read === 'new') void newDiary();

// ════ 翻页（多页日记） ════
// 日记无限向前翻：只挡住小于 0，不挡上界——翻过最后一页就是一张空白新页（未写=不落盘，写了才在 mark:resolved 里 materialize）。
let articlePageNavBusy = false;

async function gotoArticlePage(delta: number, textLayerOnly = false): Promise<void> {
  const ctx = getActiveContext();
  const stride = (ctx.pdf || ctx.syntheticDoc) && settings.viewMode === 'page' && settings.pageLayout === 'spread' ? 2 : 1;
  const signed = Math.sign(delta || 0);
  const steps = Math.max(1, Math.abs(Math.trunc(delta || 0)));
  const next = state.pageIndex + signed * steps * stride;
  if (next < 0 || next >= state.pageCount) return;
  lastReaderPageState = null;
  state.pageIndex = next;
  if (ctx.pdf) await (textLayerOnly ? renderPageTextLayerOnly() : renderPage());
  else if (ctx.syntheticDoc) renderSyntheticSurface();
}

function gotoDiaryPage(idx: number): void {
  if (state.surfaceType !== 'whiteboard') return;
  if (idx < 0) return;
  renderBlankPage(idx, RULED);
  redrawInk();            // 画回该页已有笔迹（strokesByPage 已含全部页；空白新页无笔=空画）
  setLastReadPage(idx);   // 记阅读位置（空白新页也记，当书签）
  updatePageInd();
}
/** 翻页：书籍（article）走 renderer.gotoPage；日记（whiteboard）走 gotoDiaryPage。
 *  文本阅读态：先翻源页内的阅读页，到源页边界再翻源页（翻回则落在上一页末页）。 */
async function pageNav(delta: number): Promise<void> {
  if (state.surfaceType === 'article') {
    if (settings.viewMode === 'reader') {
      const r = readerFlip(delta);
      if (r === 'moved') return;   // reader:vpage 统一刷新页码和进度，避免一次虚拟翻页重复写状态。
      // 到 PDF 页边界 → 翻 PDF 页，但仅当真有目标页（否则首/末页 readerArmBackward+gotoPage 空转、landAtEnd 残留污染下次翻页落位）
      const hasTarget = delta < 0 ? state.pageIndex > 0 : state.pageIndex < state.pageCount - 1;
      if (!hasTarget) return;
      if (articlePageNavBusy) return;
      articlePageNavBusy = true;
      flushRegion('manual'); // 翻 PDF 页会 page:rendered→resetAssembly 清掉在途笔→丢！先收口落库(空区域 no-op)
      try {
        if (delta < 0) readerArmBackward();             // 翻回上一 PDF 页 → 落其末页
        await gotoArticlePage(delta, true);             // page:rendered → reader rebuild → settleV → reader:vpage → updatePageInd
        setLastReadPage(state.pageIndex);
        recordBookReadingProgress();
      } finally {
        articlePageNavBusy = false;
      }
      return;
    }
    if (articlePageNavBusy) return;
    articlePageNavBusy = true;
    flushRegion('manual'); // 原版翻页同理，先收口
    try {
      await gotoArticlePage(delta);
      setLastReadPage(state.pageIndex);
      recordBookReadingProgress();
    } finally {
      articlePageNavBusy = false;
    }
  } else { flushRegion('manual'); gotoDiaryPage(state.pageIndex + delta); } // 日记翻页也会换 pageId→reset，先收口
}

const BOOK_SWIPE_MIN_PX = 58;
const BOOK_SWIPE_LOCK_PX = 16;
let lastBookSwipeAt = 0;
bus.on('nav:flip', () => { lastBookSwipeAt = Date.now(); });

function bookSwipeEnabled(): boolean {
  return document.body.dataset.mode === 'read'
    && document.body.dataset.read === 'book'
    && state.surfaceType === 'article'
    && !!state.documentId;
}

function swipeBlockedTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest([
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '#diary-bar',
    '#m-rail',
    '#m-tab',
    '.msheet',
    '.mark-summary',
    '#m-insight',
    '#files',
    '#auth-gate',
  ].join(','));
}

function swipeDir(dx: number, dy: number): number {
  return Math.abs(dx) >= BOOK_SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.15
    ? (dx < 0 ? 1 : -1)
    : 0;
}

function emitBookSwipe(dir: number): void {
  if (!dir || !bookSwipeEnabled()) return;
  const now = Date.now();
  if (now - lastBookSwipeAt < 320) return;
  lastBookSwipeAt = now;
  bus.emit('nav:flip', dir);
}

function touchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    const item = list.item(i);
    if (item?.identifier === id) return item;
  }
  return null;
}

function installBookSwipeNavigation(surface: HTMLElement): void {
  let touchNav: { id: number; x0: number; y0: number; horizontal: boolean } | null = null;
  surface.addEventListener('touchstart', (e) => {
    if (!bookSwipeEnabled() || e.touches.length !== 1 || swipeBlockedTarget(e.target)) return;
    if (!shouldStartBookTouchSwipe(nativePointerKind())) return;
    const t = e.touches[0];
    touchNav = { id: t.identifier, x0: t.clientX, y0: t.clientY, horizontal: false };
  }, { passive: true });
  surface.addEventListener('touchmove', (e) => {
    if (!touchNav) return;
    const t = touchById(e.touches, touchNav.id);
    if (!t) return;
    const dx = t.clientX - touchNav.x0;
    const dy = t.clientY - touchNav.y0;
    if (!touchNav.horizontal && Math.abs(dx) > BOOK_SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.15) touchNav.horizontal = true;
    if (touchNav.horizontal && e.cancelable) e.preventDefault();
  }, { passive: false });
  surface.addEventListener('touchend', (e) => {
    if (!touchNav) return;
    const done = touchNav;
    const t = touchById(e.changedTouches, done.id);
    touchNav = null;
    if (!t) return;
    const dir = swipeDir(t.clientX - done.x0, t.clientY - done.y0);
    if (dir && e.cancelable) e.preventDefault();
    emitBookSwipe(dir);
  }, { passive: false });
  surface.addEventListener('touchcancel', () => { touchNav = null; }, { passive: true });

  let pointerNav: { id: number; x0: number; y0: number; horizontal: boolean } | null = null;
  surface.addEventListener('pointerdown', (e) => {
    if (surface.id === 'reader') return;
    if (!bookSwipeEnabled() || swipeBlockedTarget(e.target)) return;
    if (!shouldStartBookPointerSwipe({ nativeKind: nativePointerKind(), pointerType: e.pointerType })) return;
    if ((e.target as Element | null)?.closest?.('#ink-layer,#page-layer')) return;
    pointerNav = { id: e.pointerId, x0: e.clientX, y0: e.clientY, horizontal: false };
    try { surface.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  });
  surface.addEventListener('pointermove', (e) => {
    if (!pointerNav || e.pointerId !== pointerNav.id) return;
    const dx = e.clientX - pointerNav.x0;
    const dy = e.clientY - pointerNav.y0;
    if (!pointerNav.horizontal && Math.abs(dx) > BOOK_SWIPE_LOCK_PX && Math.abs(dx) > Math.abs(dy) * 1.15) pointerNav.horizontal = true;
    if (pointerNav.horizontal) e.preventDefault();
  });
  surface.addEventListener('pointerup', (e) => {
    if (!pointerNav || e.pointerId !== pointerNav.id) return;
    const done = pointerNav;
    pointerNav = null;
    try { surface.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    emitBookSwipe(swipeDir(e.clientX - done.x0, e.clientY - done.y0));
  });
  surface.addEventListener('pointercancel', (e) => {
    if (!pointerNav || e.pointerId !== pointerNav.id) return;
    pointerNav = null;
    try { surface.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  });
}

installBookSwipeNavigation(wrap);
installBookSwipeNavigation(el('reader'));

el('pg-prev').addEventListener('click', () => { void pageNav(-1); });
el('pg-next').addEventListener('click', () => { void pageNav(1); }); // 日记：下一页可无限向前（空白新页·写了才落盘），取代原手动加页

// ── 原版 PDF / EPUB 文本阅读器 ⇄ 可标记阅读面（仅书籍态）──
function applyViewMode(): void {
  const canUseReader = document.body.dataset.read === 'book' && currentTextReaderAvailable();
  if (!canUseReader && settings.viewMode === 'reader') {
    settings.viewMode = 'page';
    saveSettings();
  }
  const isReader = canUseReader && settings.viewMode === 'reader';
  const reader = el('reader') as HTMLElement;
  const hasReaderContent = !!reader.querySelector('.reader-page');
  const showReaderContent = isReader && hasReaderContent;
  el('stage-wrap').style.display = showReaderContent ? 'none' : '';
  el('whisper-layer').style.display = showReaderContent ? 'none' : '';
  reader.hidden = !isReader;
  reader.classList.toggle('reader-processing', isReader && !hasReaderContent);
  if (isReader && !reader.querySelector('.reader-page,.reader-empty,.reader-warn,.reader-loading')) {
    const loading = document.createElement('p');
    loading.className = 'reader-loading';
    loading.textContent = state.textBlocks.length ? '正在整理阅读文本…' : '正在读取文本层…';
    reader.appendChild(loading);
  }
  if (!isReader) reader.querySelectorAll('.reader-loading').forEach((node) => node.remove());
  el('view-toggle').hidden = document.body.dataset.read !== 'book' || !canUseReader;
  el('view-toggle').textContent = readerToggleLabel(isReader);
  el('view-toggle').classList.toggle('on', isReader);
  document.getElementById('reader-state-badge')?.toggleAttribute('hidden', document.body.dataset.read !== 'book');
  syncLayoutPanel();
}
el('view-toggle').addEventListener('click', () => {
  if (document.body.dataset.read !== 'book') return; // 文本阅读只对书籍（日记是白板·无文本层）
  if (!currentTextReaderAvailable()) {
    useOriginalPageMode();
    applyViewMode();
    return;
  }
  flushRegion('view-switch'); // 切面前收口在途区域：此刻 pageId/surfaceIndex 仍是当前面，否则跨面误并
  const nextMode = settings.viewMode === 'reader' ? 'page' : 'reader';
  if (nextMode === 'reader') {
    void enterReaderModeForCurrentBook({ forceRefresh: true, notifyOnFail: true });
    return;
  }
  settings.viewMode = 'page';
  saveSettings();
  applyViewMode();
  bus.emit('view:changed'); // → reader.rebuild 当前阅读页
  if (state.surfaceType === 'article') void renderPage().then(() => {
    redrawInk();
    updatePageInd();
  });
});

el('layout-toggle').addEventListener('click', (event) => {
  event.stopPropagation();
  if (document.body.dataset.read !== 'book') return;
  const panel = el('layout-panel');
  panel.hidden = !panel.hidden;
  syncLayoutPanel();
});
el('layout-panel').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('pointerdown', (event) => {
  const panel = document.getElementById('layout-panel');
  if (!panel || panel.hidden) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('#layout-panel,#layout-toggle')) return;
  closeLayoutPanel();
});
for (const button of el('layout-panel').querySelectorAll<HTMLButtonElement>('[data-layout]')) {
  button.addEventListener('click', () => {
    const layout = button.dataset.layout;
    if (layout !== 'single' && layout !== 'spread') return;
    void applyOriginalLayoutChange(() => { settings.pageLayout = layout; });
  });
}
for (const button of el('layout-panel').querySelectorAll<HTMLButtonElement>('[data-zoom-mode]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.zoomMode;
    if (mode !== 'fit-page' && mode !== 'fit-width') return;
    void applyOriginalLayoutChange(() => { settings.zoomMode = mode; }, { pdfOnly: true });
  });
}
for (const button of el('layout-panel').querySelectorAll<HTMLButtonElement>('[data-zoom-percent]')) {
  button.addEventListener('click', () => {
    const percent = Number(button.dataset.zoomPercent);
    if (!Number.isFinite(percent) || percent <= 0) return;
    void applyOriginalLayoutChange(() => {
      settings.zoomMode = 'percent';
      settings.zoomPercent = percent;
    }, { pdfOnly: true });
  });
}
bus.on('reader:ready', (payload) => {
  const p = payload as Partial<ReaderPageState>;
  if (p.documentId && p.documentId !== state.documentId) return;
  if (isReaderPageState(payload)) lastReaderPageState = payload;
  setReaderStateBadge(p.label || readerModeStatusLabel());
  applyViewMode();
  updatePageInd();
  recordBookReadingProgressSoon();
});
bus.on('reader:fallback', (payload) => {
  const p = payload as { documentId?: string; pageIndex?: number; label?: string; detail?: string };
  if (p.documentId && p.documentId !== state.documentId) return;
  lastReaderPageState = null;
  useOriginalPageMode(false);
  applyViewMode();
  setReaderStateBadge(p.label || '原版阅读', p.detail || '');
  if (state.surfaceType === 'article') void renderPage().then(() => {
    redrawInk();
    updatePageInd();
    recordBookReadingProgressSoon();
  });
});
// 手型工具横滑 → 翻页（ink.ts 发 nav:flip）。
bus.on('nav:flip', (dir) => { void pageNav(Number(dir) || 0); });
// 双指左右滑翻页：板上 touch-remap 把双指横滑识别成方向键注入（单指写字契约不变·见 eink/touch-remap.c）→ 这里收方向键翻页。
// 只在阅读/书写面 + 会中白板生效（列表面有 ‹ › 翻页条；pageNav 在列表态会去翻隐藏文档故 gate）。
window.addEventListener('keydown', (e) => {
  const m = document.body.dataset.mode, read = document.body.dataset.read;
  const ok = (m === 'read' && (read === 'new' || read === 'book' || read === 'open'))
    || (m === 'meet' && document.body.dataset.mtg === 'live');
  if (!ok) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') bus.emit('nav:flip', 1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') bus.emit('nav:flip', -1);
});
// 书籍 gotoPage 渲染后更新页码（日记 gotoDiaryPage 自带；重复调用幂等）。
bus.on('page:rendered', () => { updatePageInd(); recordBookReadingProgressSoon(); });
bus.on('reader:vpage', (payload) => {
  if (isReaderPageState(payload) && (!payload.documentId || payload.documentId === state.documentId)) lastReaderPageState = payload;
  updatePageInd();
  recordBookReadingProgressSoon();
}); // 文本阅读页翻动/阅读页落地 → 刷新全局页码
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushBookReadingProgress();
    disarmM103HqHwAreaNow();
  }
});
window.addEventListener('pagehide', () => {
  flushBookReadingProgress();
  disarmM103HqHwAreaNow();
  triggerDiaryBoardOcrOnLeave();
});
window.addEventListener('beforeunload', () => {
  disarmM103HqHwAreaNow();
});

// ════ 日记列表（真数据） ════
const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 日记列表虚拟翻页（电纸屏：禁滚 + ‹ › 翻页）——共享 virtual-pager 引擎
let diaryPager: Pager | null = null;
let diaryBar: PagerBar | null = null;
async function renderDiaryList(): Promise<void> {
  const body = el('rv-diary').querySelector<HTMLElement>('.vbody');
  const cnt = el('rv-diary').querySelector('.cnt');
  if (!body) return;
  const pager = diaryPager ?? (diaryPager = createPager(body, { onChange: (i) => diaryBar?.update(i) }));
  if (!diaryBar) diaryBar = mountPagerBar(pager, el('rv-diary'));
  const host = pager.content;
  const diaries = await listDiaries();
  if (cnt) cnt.textContent = `${diaries.length} 篇`;
  host.textContent = '';
  if (!diaries.length) {
    const e = document.createElement('div');
    e.className = 'recent-empty';
    e.style.cssText = 'padding:24px 8px;color:var(--mut2);font-size:13px;';
    e.textContent = '还没有日记。点左侧「新日记」开一篇。';
    host.appendChild(e);
    pager.relayout('keep');
    return;
  }
  for (const doc of diaries) {
    const d = doc.saved_at ? new Date(doc.saved_at) : null;
    const dateStr = d ? `${d.getMonth() + 1}.${d.getDate()}` : '';
    const wk = d ? WK[d.getDay()] : '';
    const row = document.createElement('div');
    row.className = 'drow';
    row.innerHTML = `<div class="dd">${dateStr}<span class="wk">${wk}</span></div>`
      + `<div class="dc"><div class="dt"></div><div class="dm">${doc.page_count || 1} 页</div></div>`
      + `<button class="drow-del" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg></button>`;
    const titleNode = row.querySelector('.dt') as HTMLElement;
    titleNode.textContent = doc.filename || '未命名';
    titleNode.contentEditable = 'false';
    titleNode.spellcheck = false;
    // 单击标题=跟行内其余位置一样打开日记（延后一拍等，好判定是不是双击）；双击标题=就地改名。
    let clickTimer: number | undefined;
    titleNode.addEventListener('click', (e) => {
      e.stopPropagation();
      if (clickTimer !== undefined) { clearTimeout(clickTimer); clickTimer = undefined; return; } // 双击的第二下——交给 dblclick，这里不再重复打开
      clickTimer = window.setTimeout(() => { clickTimer = undefined; openDiary(doc); }, 300);
    });
    titleNode.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clickTimer !== undefined) { clearTimeout(clickTimer); clickTimer = undefined; }
      titleNode.contentEditable = 'true';
      titleNode.focus();
      const range = document.createRange();
      range.selectNodeContents(titleNode); // 全选现有标题，直接打字即可覆盖
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    titleNode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleNode.blur(); } });
    titleNode.addEventListener('blur', () => {
      titleNode.contentEditable = 'false';
      const t = (titleNode.textContent || '').trim() || '未命名';
      titleNode.textContent = t;
      if (t === (doc.filename || '未命名')) return;
      doc.filename = t; // 同步闭包里的 doc，避免改名后立刻点开该行仍用旧标题渲染写区
      void renameDiary(doc.document_id, t);
    });
    row.addEventListener('click', () => openDiary(doc));
    row.querySelector('.drow-del')?.addEventListener('click', async (e) => {
      e.stopPropagation(); // 别触发 openDiary
      const ok = await confirmSheet({ title: '删除日记', message: `「${doc.filename || '未命名'}」及其全部手写会删掉，不可恢复。`, confirm: '删除' });
      if (ok) { await deleteDiary(doc.document_id); void renderDiaryList(); }
    });
    host.appendChild(row);
  }
  pager.relayout('keep');
}
// 切到「日记」时刷新列表。
el('read-sub').querySelector<HTMLElement>('[data-read="diary"]')?.addEventListener('click', () => void renderDiaryList());

async function clearCurrentBookAnnotationsForDebug(includeAiTurns = true): Promise<{ documentId: string | null; marks: number; aiTurns: number }> {
  const documentId = state.documentId;
  if (!documentId) return { documentId: null, marks: 0, aiTurns: 0 };

  const marks = await getFoldedMarks(documentId);
  for (const mark of marks) {
    const {
      entry_id: _entryId,
      seq: _seq,
      created_at: _createdAt,
      schema_version: _schemaVersion,
      ...base
    } = mark;
    const tool = base.tool === 'highlighter' || base.tool === 'underline' ? base.tool : 'pen';
    const tombstone: MarkEntryDraft = {
      ...base,
      tool,
      strokes: [],
      bbox: base.bbox || [0, 0, 0, 0],
      hmp: null,
      marked_text: '',
      abs_timestamp: Date.now(),
      context_id: base.context_id || getActiveContext().id,
      ai_eligible: false,
      is_tombstone: true,
    };
    await appendMarkEntry(tombstone);
  }

  const turns = includeAiTurns ? await getBookAiTurns(documentId) : [];
  for (const turn of turns.filter((item) => item.overlay_state !== 'dismissed')) {
    const {
      entry_id: _entryId,
      seq: _seq,
      created_at: _createdAt,
      ...base
    } = turn;
    const dismissed: AiTurnEntryDraft = {
      ...base,
      overlay_state: 'dismissed',
      user_edited_text: base.user_edited_text,
      supersedes: turn.entry_id,
    };
    await appendAiTurnEntry(dismissed);
  }

  const ctx = getActiveContext();
  ctx.strokesByPage.clear();
  ctx.overlays = [];
  bus.emit('page:rendered');
  redrawInk();
  await restoreLedgerState(documentId);
  forceResetOsdInkNow();
  bus.emit('page:rendered');
  await runtimeSyncHost.syncDocument(documentId, 'debug-clear-current-book-annotations').catch(() => undefined);
  return { documentId, marks: marks.length, aiTurns: turns.length };
}

// dev 调试钩子（同桌面 __inkloop）：preview/控制台里读状态、发 bus 事件、测书籍导入。
// exportInkSurfaceL1：WS3 L1 对接——把一本书产成协作方 InkSurface 契约 artifacts（KO/投影/runtime/visual model），dev-only。
(window as unknown as { __inkloop?: unknown }).__inkloop = {
  state, bus, getActiveContext, listBooks, loadFile, reopenBook, openBook,
  settings,
  readerVInfo,
  readerSetVPage,
  markCurrentPageReviewLater,
  createSyntheticReadingMark,
  createSyntheticMeetingEventMark,
  openInkLoopUri,
  openFileBrowser,
  listLibraryItems,
  listLibrarySyncRecords,
  pullCloudLibraryManifest,
  retryPendingLibraryUploads,
  downloadCloudLibraryItem,
  apiBase,
  apiRouteChoice,
  setApiRoute,
  setDeviceSession: setSession,
  getFoldedMarks,
  getBookAiTurns,
  clearCurrentBookAnnotationsForDebug,
  runtimeSyncHost,
  readLanImportState: () => {
    const lan = (window as unknown as { InkLoopLanImport?: LanImportBridge }).InkLoopLanImport;
    return lan ? readLanImportState(lan) : null;
  },
  syncActiveRuntime: () => state.documentId ? runtimeSyncHost.syncDocument(state.documentId, 'manual-debug') : Promise.resolve(),
  reconcileRuntimeNow: () => runtimeSyncHost.reconcileNow(state.documentId || undefined, 'manual-debug'),
  pullRuntimeNow: () => runtimeSyncHost.pullNow('manual-debug'),
  exportInkSurfaceL1: (docId: string) => import('./integration/inksurface').then((m) => m.buildL1Export(docId)),
  // exportMeeting：会议 → InkSurface 契约（转写=文档/手写=标注/总结=summary KO）·dev-only·C「打通链路」
  exportMeeting: (meetingId: string) => import('./integration/inksurface/meeting-export').then((m) => m.buildMeetingL1Export(meetingId)),
  // exportVaultBundle：枚举 阅读/日记/会议 → 各 L1 导出（含 taxonomy 标签）+ MOC + 概念层（LLM 跨链）→ bundle JSON·dev-only。
  // 主写盘路径＝scripts/render-vault.ts（干净 .md·消费 conceptLayer→ 出 Concepts/ 枢纽 + 叶子相关概念·Vision A 知识图谱）。
  // scripts/export-vault.ts（SDK adapter·带 sidecar·**不消费概念层**）保留给将来插件/L2 双向同步那条消费方，别拿它当默认导出。
  exportVaultBundle: () => import('./integration/inksurface/vault-collect').then((m) => m.collectVaultBundle()),
  // buildVaultRelease：bundle → 整包干净 .md 发布包（manifest sha256 + files）·交付路线 Y 的设备侧产物·dev-only。
  // 上传 panel 存 + Obsidian 下载器拉 = 跨仓库/部署的后续件（panel 加端点 + 插件下载器）。
  buildVaultRelease: async () => {
    const [{ collectVaultBundle }, { buildVaultRelease }] = await Promise.all([import('./integration/inksurface/vault-collect'), import('./integration/inksurface/vault-release')]);
    return buildVaultRelease(await collectVaultBundle());
  },
  // publishVaultRelease：一个动作 collect → build → POST panel（交付路线 Y 设备侧闭环）。逻辑在 vault-publish-device（设置页按钮共用）。
  // 默认 userId=当前 session；本地演示为 local_demo（须与 Obsidian 插件一致）·概念层默认关（传 {concepts:true} 才出 Concepts/）。
  publishVaultRelease: publishVaultFromDevice,
  abortVaultPublish,
};

const initialInkLoopUri = startupInkLoopUri();
if (initialInkLoopUri) window.setTimeout(() => void openInkLoopUri(initialInkLoopUri), 0);

// ════ 线格开关 boot 态：复选框绑定移到 mobile/dev.ts（设置页重渲会重建该控件）════
document.body.classList.toggle('lines-off', localStorage.getItem('inkloop.mobile.lines') === 'off');

// ════ 会议 controller（真数据·会中白板）════
// 会议资料一律开在会议工作台内（enterMeeting→openMaterialInMeeting·载进 meetingCtx）、不再跳全局阅读面，故无需 goReadSurface。
initMobileMeeting({ readerCtx: getActiveContext() }); // readerCtx = boot 主阅读实例（'__reader__'）
initMobileDev(); // dev 三页（AI 会话 / 采集取证 / 设置）接真数据

// ════ 启动：阅读默认进入书架；日记能力保留为内部白板/会议复用，不再作为用户入口。════
void renderBookShelf();
startLibrarySyncLoop(() => { void renderBookShelf(); });
