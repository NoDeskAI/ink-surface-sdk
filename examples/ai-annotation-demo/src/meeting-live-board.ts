import './meeting-live-board.css';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { authHeaders } from './core/auth';
import {
  MeetingLiveBoardInkProjection,
  liveBoardMeetingDocumentId,
  type LiveBoardInkStroke,
} from './meeting-live-board-ink';
import {
  createLiveBoardStrokeAddEvent,
  createLiveBoardStrokeDeleteEvent,
  pushLiveBoardEvents,
} from './meeting-live-board-publisher';
import { shouldRenderLiveBoardStatus } from './meeting-live-board-state';
import {
  selectLiveTranscriptUtterances,
  type LiveBoardTranscriptUtterance,
} from './meeting-live-board-transcript';

type Track = 'mic' | 'remote';
type Point = { x: number; y: number };
type Stroke = LiveBoardInkStroke;
type Utterance = LiveBoardTranscriptUtterance;
type Transcript = { session_id: string; status: 'provisional' | 'formal'; utterances: Utterance[]; revision: number };

const root = document.querySelector<HTMLElement>('#meeting-live-board');
if (!root) throw new Error('missing #meeting-live-board');
const app = root;

const state: {
  localStrokes: Stroke[];
  runtimeStrokes: Stroke[];
  inkConnected: boolean;
  inkScope: string | null;
  transcript: Transcript | null;
  camera: MediaStream | null;
  cameraRequesting: boolean;
  connected: boolean;
  active: boolean;
  tracks: Track[];
  pendingChunks: number;
  cameraError: string | null;
  lastUpdate: number;
} = { localStrokes: [], runtimeStrokes: [], inkConnected: false, inkScope: null, transcript: null, camera: null, cameraRequesting: false, connected: false, active: false, tracks: [], pendingChunks: 0, cameraError: null, lastUpdate: 0 };

const query = new URLSearchParams(window.location.search);
const projectionMode = query.get('projection') === '1';
const monitorMode = query.get('monitor') === '1';
// OBS owns the physical camera in projection mode and overlays it as a native
// source. The browser must not compete with OBS or Meet for the same device.
const autoCamera = !projectionMode && query.get('camera') === 'auto';
const explicitMeetingDocumentId = liveBoardMeetingDocumentId(
  query.get('meeting_doc_id') || query.get('meeting_id'),
);
const inkProjection = new MeetingLiveBoardInkProjection(explicitMeetingDocumentId);
let runtimeCursor = explicitMeetingDocumentId ? '0' : 'latest';
let inkRefreshInFlight = false;
let runtimeMutationQueue = Promise.resolve();
let clearInFlight = false;
let pendingStrokePublishInFlight = false;
let pendingLocalStrokes: Array<{
  annotationId: string;
  pageIndex: number;
  points: Point[];
}> = [];

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character);
}

function line(points: Point[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(4)} ${point.y.toFixed(4)}`).join(' ');
}

function timeLabel(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function trackLabel(track: Track): string { return track === 'mic' ? '我' : '对方'; }

function render(): void {
  const transcript = state.transcript;
  const strokes = [...state.runtimeStrokes, ...state.localStrokes];
  const utterances = selectLiveTranscriptUtterances(transcript?.utterances || []);
  app.innerHTML = `
    <section class="live-shell ${projectionMode ? 'is-projection' : ''} ${monitorMode ? 'is-monitor' : ''}" aria-label="InkLoop 会议实时画板">
      <header class="live-header">
        <div class="brand-lockup"><span class="brand-mark">I</span><strong>InkLoop Live Board</strong></div>
        <div class="meeting-state ${state.active ? 'is-live' : ''}" role="status" aria-live="polite" aria-atomic="true">
          <span class="live-dot"></span>
          <span>${state.active ? '实时记录中' : state.connected ? '已连接，等待分片' : '等待实时数据'}</span>
        </div>
        <div class="header-actions">
          ${monitorMode ? '<span class="monitor-badge">教师监看 · 正向画面</span>' : ''}
          ${projectionMode ? '' : `<button type="button" data-action="camera" ${state.cameraRequesting ? 'disabled' : ''}>${state.camera ? '关闭摄像头' : state.cameraRequesting ? '等待摄像头授权…' : '打开摄像头'}</button>`}
          <button type="button" data-action="clear" ${clearInFlight ? 'disabled' : ''}>${clearInFlight ? '正在清空…' : '清空画布'}</button>
          <button type="button" data-action="fullscreen">全屏</button>
        </div>
      </header>

      <div class="live-layout">
        <section class="board-stage" aria-label="实时板书画布">
          <div class="board-meta">
            <span>${state.inkScope ? escapeHtml(state.inkScope) : 'WAITING FOR MEETING INK'}</span>
            <span>${strokes.length} strokes · ${state.inkConnected ? 'InkEvent 已连接' : 'InkEvent 重连中'}</span>
          </div>
          <div class="ink-board" id="ink-board" tabindex="0" role="application" aria-label="InkLoop 实时板书画布；可用鼠标、触控笔或触摸书写">
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="InkLoop 数字画布">
              ${strokes.map((stroke) => `<path d="${stroke.path}" data-stroke="${escapeHtml(stroke.id)}" style="stroke:${stroke.color};stroke-opacity:${stroke.opacity};stroke-width:${stroke.width}"></path>`).join('')}
            </svg>
            <div class="board-guide"><span>从这里开始写</span><i></i></div>
          </div>
          <div class="track-status" role="status" aria-live="polite" aria-atomic="true" aria-label="录制轨道状态">
            <span class="track ${state.tracks.includes('mic') && state.active ? 'is-on' : ''}"><i></i>Mic 本机麦克风</span>
            <span class="track ${state.tracks.includes('remote') && state.active ? 'is-on' : ''}"><i></i>Remote Meet 音频</span>
            <span class="track ${state.connected && state.pendingChunks === 0 ? 'is-on' : ''}"><i></i>${!state.connected ? 'ASR 重连中' : state.pendingChunks ? `ASR 处理中 ${state.pendingChunks}` : 'ASR 已追平'}</span>
            <span class="session-ref">${escapeHtml(transcript?.session_id || 'No active session')}</span>
          </div>
        </section>

        <aside class="live-rail" aria-label="实时转写">
          <div class="camera-frame ${state.camera ? 'has-camera' : ''}">
            <video id="camera-preview" autoplay muted playsinline></video>
            <div class="camera-placeholder"><span>CAM</span><small>${state.cameraError ? escapeHtml(state.cameraError) : state.cameraRequesting ? '请在 Chrome 权限弹窗中允许摄像头' : '摄像头画中画'}</small></div>
          </div>
          <div class="transcript-head">
            <div><span>LIVE TRANSCRIPT</span><h1>实时转写</h1></div>
            <em>${transcript?.status === 'formal' ? '已收敛' : '持续修订'}</em>
          </div>
          <ol class="transcript-list" aria-label="实时转写；内容持续修订" aria-live="off">
            ${utterances.length ? utterances.map((utterance) => `
              <li class="utterance ${utterance.track}">
                <div><b>${trackLabel(utterance.track)}</b><time>${timeLabel(utterance.start_ms)}</time></div>
                <p>${escapeHtml(utterance.text)}</p>
              </li>`).join('') : `
              <li class="transcript-empty"><b>正在聆听</b><span>会议开始说话后，转写会按 Mic / Remote 分轨出现。</span></li>`}
          </ol>
        </aside>
      </div>
    </section>`;
  bind();
  const video = app.querySelector<HTMLVideoElement>('#camera-preview');
  if (video && state.camera) video.srcObject = state.camera;
}

function bind(): void {
  const board = app.querySelector<HTMLElement>('#ink-board');
  let active: Point[] = [];
  if (!projectionMode) board?.addEventListener('pointerdown', (event) => {
    board.setPointerCapture(event.pointerId);
    active = [relativePoint(event, board)];
  });
  if (!projectionMode) board?.addEventListener('pointermove', (event) => {
    if (!active.length) return;
    active.push(relativePoint(event, board));
    previewPath(line(active));
  });
  if (!projectionMode) board?.addEventListener('pointerup', () => {
    if (active.length > 1) {
      const annotationId = `ko_live_${crypto.randomUUID()}`;
      state.localStrokes.push({
        id: `${annotationId}:0`,
        path: line(active),
        color: '#172522',
        opacity: 1,
        width: 0.0045,
        pageIndex: inkProjection.activePageIndex,
      });
      pendingLocalStrokes.push({
        annotationId,
        pageIndex: inkProjection.activePageIndex,
        points: [...active],
      });
      void publishPendingLocalStrokes();
    }
    active = [];
    render();
  });
  app.querySelector('[data-action="clear"]')?.addEventListener('click', () => clearBoard());
  app.querySelector('[data-action="fullscreen"]')?.addEventListener('click', () => void document.documentElement.requestFullscreen());
  app.querySelector('[data-action="camera"]')?.addEventListener('click', () => void toggleCamera());
}

function enqueueRuntimeEvents(events: RuntimeSyncEvent[]): Promise<void> {
  const operation = runtimeMutationQueue
    .catch(() => undefined)
    .then(async () => {
      await pushLiveBoardEvents(events, { headers: authHeaders() });
      // Do not wait for the next timer tick: both this tab and the independent
      // OBS Browser Source can now pull the authoritative event immediately.
      await refreshInk();
    });
  runtimeMutationQueue = operation
    .catch((error) => {
      console.error('[meeting-live-board] runtime ink publish failed', error);
      state.inkConnected = false;
      render();
    });
  return operation;
}

async function publishPendingLocalStrokes(): Promise<void> {
  const documentId = state.inkScope;
  if (!documentId || pendingLocalStrokes.length === 0 || pendingStrokePublishInFlight) return;
  pendingStrokePublishInFlight = true;
  const pending = [...pendingLocalStrokes];
  let published = false;
  try {
    await enqueueRuntimeEvents(pending.map((stroke) => createLiveBoardStrokeAddEvent({
      documentId,
      annotationId: stroke.annotationId,
      eventId: `evt_live_add_${crypto.randomUUID()}`,
      pageIndex: stroke.pageIndex,
      points: stroke.points,
    })));
    const publishedIds = new Set(pending.map((stroke) => stroke.annotationId));
    pendingLocalStrokes = pendingLocalStrokes.filter(
      (stroke) => !publishedIds.has(stroke.annotationId),
    );
    published = true;
  } catch {
    // Keep optimistic geometry and retry it on the next status refresh.
  } finally {
    pendingStrokePublishInFlight = false;
    if (published && state.inkScope && pendingLocalStrokes.length > 0) {
      queueMicrotask(() => void publishPendingLocalStrokes());
    }
  }
}

function annotationIdFromLocalStroke(stroke: Stroke): string {
  return stroke.id.endsWith(':0') ? stroke.id.slice(0, -2) : stroke.id;
}

function clearBoard(): void {
  if (clearInFlight) return;
  const documentId = state.inkScope;
  const annotationIds = new Set([
    ...inkProjection.annotationIds(),
    ...state.localStrokes.map(annotationIdFromLocalStroke),
  ]);
  if (annotationIds.size === 0) return;
  if (!documentId) {
    state.localStrokes = [];
    state.runtimeStrokes = [];
    pendingLocalStrokes = [];
    render();
    return;
  }
  clearInFlight = true;
  render();
  void enqueueRuntimeEvents([...annotationIds].map((annotationId) =>
    createLiveBoardStrokeDeleteEvent({
      documentId,
      annotationId,
      eventId: `evt_live_delete_${crypto.randomUUID()}`,
    }))).then(() => {
      inkProjection.removeAnnotations(annotationIds);
      state.localStrokes = state.localStrokes.filter(
        (stroke) => !annotationIds.has(annotationIdFromLocalStroke(stroke)),
      );
      state.runtimeStrokes = inkProjection.strokes();
      pendingLocalStrokes = pendingLocalStrokes.filter(
        (stroke) => !annotationIds.has(stroke.annotationId),
      );
    }).catch(() => {
      // Leave the visible, authoritative projection intact so the user can retry.
    }).finally(() => {
      clearInFlight = false;
      render();
    });
}

function reconcileOptimisticStrokes(events: readonly RuntimeSyncEvent[]): void {
  const authoritativeIds = new Set(events.flatMap((event) => {
    if (!event.operation.startsWith('annotation.')) return [];
    const id = event.target.id
      || (typeof event.payload.ko_id === 'string' ? event.payload.ko_id : null);
    return id ? [id] : [];
  }));
  if (!authoritativeIds.size) return;
  state.localStrokes = state.localStrokes.filter(
    (stroke) => !authoritativeIds.has(annotationIdFromLocalStroke(stroke)),
  );
  pendingLocalStrokes = pendingLocalStrokes.filter(
    (stroke) => !authoritativeIds.has(stroke.annotationId),
  );
}

function relativePoint(event: PointerEvent, element: HTMLElement): Point {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function previewPath(path: string): void {
  const svg = app.querySelector<SVGElement>('#ink-board svg');
  if (!svg) return;
  let preview = svg.querySelector<SVGPathElement>('[data-preview]');
  if (!preview) {
    preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    preview.dataset.preview = 'true';
    svg.append(preview);
  }
  preview.setAttribute('d', path);
}

async function toggleCamera(): Promise<void> {
  if (state.camera) {
    state.camera.getTracks().forEach((track) => track.stop());
    state.camera = null;
    state.cameraError = null;
  } else {
    state.cameraRequesting = true;
    state.cameraError = null;
    render();
    try {
      state.camera = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 540 }, audio: false });
      state.cameraError = null;
    } catch (error) {
      state.cameraError = (error as DOMException).name === 'NotAllowedError' ? '请允许 Chrome 使用摄像头' : '摄像头暂不可用';
    } finally {
      state.cameraRequesting = false;
    }
  }
  render();
}

async function startCameraIfNeeded(): Promise<void> {
  if (!autoCamera || state.camera || state.cameraRequesting) return;
  await toggleCamera();
}

async function refreshTranscript(): Promise<void> {
  try {
    const response = await fetch('http://127.0.0.1:3000/api/meeting-media/live-status', {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`transcript_http_${response.status}`);
    const body = await response.json() as { active?: boolean; tracks?: Track[]; pending_chunks?: number; transcript?: Transcript | null; meeting_doc_id?: string };
    const nextTranscript = body.transcript || null;
    const nextTracks = body.tracks || [];
    const nextPendingChunks = Number(body.pending_chunks || 0);
    const nextActive = body.active === true;
    const changed = shouldRenderLiveBoardStatus({
      connected: state.connected,
      active: state.active,
      transcriptSessionID: state.transcript?.session_id || null,
      transcriptRevision: state.transcript?.revision ?? null,
      tracks: state.tracks,
      pendingChunks: state.pendingChunks,
    }, {
      connected: true,
      active: nextActive,
      transcriptSessionID: nextTranscript?.session_id || null,
      transcriptRevision: nextTranscript?.revision ?? null,
      tracks: nextTracks,
      pendingChunks: nextPendingChunks,
    });
    state.transcript = nextTranscript;
    state.active = nextActive;
    state.tracks = nextTracks;
    state.pendingChunks = nextPendingChunks;
    state.connected = true;
    state.lastUpdate = Date.now();
    if (!explicitMeetingDocumentId && body.active === true && body.meeting_doc_id) {
      const selected = liveBoardMeetingDocumentId(body.meeting_doc_id);
      if (selected && inkProjection.selectMeeting(selected)) {
        // Now that the Companion has supplied the active meeting scope, replay
        // this document from cursor zero. The projector still filters every
        // other meeting, so no historical ink can leak into the board.
        runtimeCursor = '0';
        state.runtimeStrokes = [];
        state.inkScope = selected;
        void publishPendingLocalStrokes();
      }
    }
    if (state.inkScope && pendingLocalStrokes.length > 0) {
      void publishPendingLocalStrokes();
    }
    if (changed) render();
  } catch {
    if (Date.now() - state.lastUpdate > 5_000 && state.connected) { state.connected = false; render(); }
  }
}

async function refreshInk(): Promise<void> {
  if (inkRefreshInFlight) return;
  inkRefreshInFlight = true;
  try {
    let changed = false;
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < 5) {
      const url = new URL('http://127.0.0.1:3000/v1/runtime/events:pull');
      url.searchParams.set('device_id', 'meeting-live-board');
      url.searchParams.set('cursor', runtimeCursor);
      url.searchParams.set('limit', '200');
      const response = await fetch(url, {
        headers: authHeaders(),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`runtime_sync_http_${response.status}`);
      const body = await response.json() as {
        events?: RuntimeSyncEvent[];
        next_cursor?: string;
        has_more?: boolean;
      };
      const events = body.events || [];
      reconcileOptimisticStrokes(events);
      changed = inkProjection.apply(events) || changed;
      runtimeCursor = body.next_cursor || runtimeCursor;
      hasMore = body.has_more === true;
      pages += 1;
    }
    const nextScope = inkProjection.meetingDocumentId;
    if (changed || !state.inkConnected || state.inkScope !== nextScope) {
      state.runtimeStrokes = inkProjection.strokes();
      state.inkScope = nextScope;
      state.inkConnected = true;
      render();
    }
  } catch {
    if (state.inkConnected) {
      state.inkConnected = false;
      render();
    }
  } finally {
    inkRefreshInFlight = false;
  }
}

render();
window.setInterval(() => void refreshTranscript(), 500);
window.setInterval(() => void refreshInk(), 500);
void refreshTranscript();
void refreshInk();
void startCameraIfNeeded();
