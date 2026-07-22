import '../core/polyfills';
import { CLASSROOM_MAX_STROKE_POINTS, CLASSROOM_SCHEMA_VERSION, CLASSROOM_WORLD_GEOMETRY_VERSION, type ClassroomBoardEvent, type ClassroomConfirmedFocus, type ClassroomMaterial, type ClassroomRecognitionRevision, type ClassroomSnapshot, type ClassroomSurfaceRef, type ClassroomTeacherView, type ClassroomTranscriptRevision, type ClassroomTranscriptionState, type ClassroomWorldBBox, type ClassroomWorldPoint, type InkLoopStrokePoint, type LessonGraph } from 'ink-surface-sdk/runtime-schema';
import type { TeacherLessonCandidate } from '../../shared/classroom/education-workflows';
import { ClassroomBoardRenderer } from './board-renderer';
import { ClassroomClient, createClassroomClientId } from './classroom-client';
import { TextbookRenderer } from './textbook-renderer';
import { ClassroomRecognitionClient, groupRecentFormulaEvents, latestRecognitionProjection, recognitionTrustLabel, remainingRecognitionIdleDelay, renderRecognitionCrop, shouldShowRecognitionLatex } from './classroom-recognition-client';
import { ClassroomAudioApi, ClassroomAudioCapture, classroomAudioAvailability, floatToPcmBase64, TeacherAudioPeers, type ClassroomRecordingState } from './classroom-audio-client';
import { classroomAudioWorkletUrl } from './classroom-audio-worklet';
import { ClassroomTranscriptClient, formatTranscriptTime, latestTranscriptProjection } from './classroom-transcript-client';
import { ClassroomTeachingViewport } from './classroom-teaching-viewport';
import { ClassroomGestureController } from './classroom-gesture-controller';
import { fitPageViewport, fitPageWidthViewport, pageViewportKey, screenToWorld } from './classroom-world-model';
import { boxesIntersect, eventBBox, sameSurface } from '../../shared/classroom/classroom-spatial';
import { syncInkToolControls, type InkToolControl } from '../core/ink-tool-controls';
import './classroom.css';

interface CreatedClassroom {
  classroom: { classroom_id: string; title?: string; status: 'draft' | 'live' | 'ended'; latest_sequence: number };
  class_code: string;
  teacher_credential: string;
}

interface ClassroomLessonOutput {
  generation_id: string;
  candidates: TeacherLessonCandidate[];
  review_complete: boolean;
  execution_mode: 'real' | 'deterministic_fallback';
  reviewed_lesson_graph?: LessonGraph;
  stale?: boolean;
}

export interface PendingStroke {
  id: string;
  points: InkLoopStrokePoint[];
}

export function strokeBoundingBox(points: readonly InkLoopStrokePoint[]): [number, number, number, number] {
  const xs = points.map((point) => point.x_norm);
  const ys = points.map((point) => point.y_norm);
  const minX = Math.min(...xs); const minY = Math.min(...ys);
  return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}

export function previewWindow(points: readonly InkLoopStrokePoint[], limit = 256): InkLoopStrokePoint[] {
  return points.slice(-limit);
}

export function compactStrokePoints(points: readonly InkLoopStrokePoint[], limit = CLASSROOM_MAX_STROKE_POINTS): InkLoopStrokePoint[] {
  if (points.length <= limit) return [...points];
  const output: InkLoopStrokePoint[] = [];
  const last = points.length - 1;
  for (let index = 0; index < limit; index += 1) output.push(points[Math.round((index * last) / (limit - 1))]);
  return output;
}

export function mergeBoardEvent(events: readonly ClassroomBoardEvent[], next: ClassroomBoardEvent): ClassroomBoardEvent[] {
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  bySequence.set(next.sequence, next);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

export function pointerSamples<T>(event: T & { getCoalescedEvents?: () => T[] }): T[] {
  const samples = event.getCoalescedEvents?.() ?? [];
  return samples.length ? samples : [event];
}

export function shouldCommitCancelledStroke(pointCount: number): boolean { return pointCount >= 2; }

function worldStrokeBoundingBox(points: readonly ClassroomWorldPoint[]): ClassroomWorldBBox {
  const xs = points.map((point) => point.x_world); const ys = points.map((point) => point.y_world);
  const minX = Math.min(...xs); const minY = Math.min(...ys);
  return [minX, minY, Math.max(...xs) - minX || 0.001, Math.max(...ys) - minY || 0.001];
}

export function teacherLessonErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'unknown_error';
  if (message === 'insufficient_evidence') return '板书证据不足，至少完成几笔有效板书后再生成课堂候选。';
  if (message === 'untrusted_formula_evidence') return '仍有公式待确认或识别失败。请先完成公式审核，再生成课堂候选。';
  return `课堂候选生成失败：${message}`;
}

const STORAGE_KEY = 'inkloop.classroom.teacher.v1';
const app = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#classroom-app');

function readSaved(): CreatedClassroom | null {
  if (typeof localStorage === 'undefined') return null;
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as CreatedClassroom | null; } catch { return null; }
}
function save(value: CreatedClassroom | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else localStorage.removeItem(STORAGE_KEY);
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node;
}

let session = readSaved();
let client = new ClassroomClient({ token: session?.teacher_credential });
let activeClassroomLifecycle: AbortController | null = null;

function renderSetup(message = ''): void {
  if (!app) return;
  activeClassroomLifecycle?.abort(); activeClassroomLifecycle = null;
  app.replaceChildren();
  const shell = element('main', 'empty-panel');
  const form = element('form', 'setup');
  form.append(element('h1', '', '开始一堂课'), element('p', '', '在 iPad 上书写，学生通过课堂码实时观看。课堂记录保存在这台 Mac；只有明确启用的识别、转写或 AI 功能才会发送所需片段。'));
  const field = element('div', 'field');
  const label = element('label', '', '课堂名称'); label.htmlFor = 'classroom-title';
  const input = element('input'); input.id = 'classroom-title'; input.name = 'title'; input.value = '数学课堂'; input.maxLength = 96; input.required = true;
  field.append(label, input);
  const error = element('div', 'field-error', message); error.setAttribute('role', 'alert');
  const submit = element('button', 'btn primary', '创建课堂'); submit.type = 'submit';
  form.append(field, error, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault(); submit.disabled = true; error.textContent = '';
    void new ClassroomClient().post<CreatedClassroom>('/v1/classrooms', { title: input.value }).then((created) => {
      session = created; client = new ClassroomClient({ token: created.teacher_credential }); save(created); renderClassroom();
    }).catch((cause) => { error.textContent = cause instanceof Error ? cause.message : '课堂创建失败'; submit.disabled = false; });
  });
  shell.append(form); app.append(shell); input.focus();
}

function renderClassroom(): void {
  if (!app) return;
  if (!session) { renderSetup(); return; }
  activeClassroomLifecycle?.abort();
  const lifecycle = new AbortController(); activeClassroomLifecycle = lifecycle;
  const classroom = session.classroom;
  app.replaceChildren();
  const shell = element('main', 'classroom-shell teacher-shell');
  const topbar = element('header', 'teacher-command-header');
  const brand = element('div', 'classroom-brand'); brand.append(element('strong', '', 'InkLoop 教师课堂'), element('span', '', '课本 · 板书 · 全班焦点'));
  const state = element('div', 'classroom-status'); const dot = element('span', 'status-dot'); dot.dataset.state = 'online'; state.append(dot, element('span', 'status-label', classroom.status === 'live' ? '正在授课' : classroom.status === 'ended' ? '课程已结束' : '等待开始'));
  const workspace = element('section', 'teacher-studio');
  const identity = element('div'); identity.append(element('div', 'class-title', classroom.title || '课堂'), element('div', 'class-code', session.class_code));
  const actions = element('div', 'session-actions');
  const inkTools = element('div', 'ink-tools'); inkTools.setAttribute('role', 'group'); inkTools.setAttribute('aria-label', '书写工具');
  const penTool = element('button', 'btn ink-tool', '笔'); penTool.dataset.tool = 'pen';
  const highlighterTool = element('button', 'btn ink-tool', '高亮'); highlighterTool.dataset.tool = 'highlighter';
  const eraserTool = element('button', 'btn ink-tool', '橡皮'); eraserTool.dataset.tool = 'eraser';
  const undoTool = element('button', 'btn ink-tool', '撤销');
  for (const button of [penTool, highlighterTool, eraserTool, undoTool]) button.type = 'button'; undoTool.disabled = true;
  inkTools.append(penTool, highlighterTool, eraserTool, undoTool);
  const upload = element('button', 'btn', '导入 PDF'); upload.type = 'button';
  const uploadInput = element('input'); uploadInput.type = 'file'; uploadInput.accept = 'application/pdf,.pdf'; uploadInput.hidden = true;
  const start = element('button', 'btn primary', classroom.status === 'draft' ? '开始上课' : classroom.status === 'live' ? '结束课堂' : '课堂已结束'); start.type = 'button'; start.disabled = classroom.status === 'ended';
  const forget = element('button', 'btn', '退出本机'); forget.type = 'button';
  const remove = element('button', 'btn danger', '删除课堂'); remove.type = 'button'; remove.hidden = classroom.status !== 'ended';
  actions.append(start, remove, forget);
  const textbookControls = element('nav', 'textbook-controls'); textbookControls.setAttribute('aria-label', '课本控制');
  const previousPage = element('button', 'btn', '上一页'); const nextPage = element('button', 'btn', '下一页');
  previousPage.type = nextPage.type = 'button';
  const pageLabel = element('span', 'page-label', '白板');
  const zoomOut = element('button', 'btn', '－'); const zoomIn = element('button', 'btn', '＋'); zoomOut.type = zoomIn.type = 'button';
  const zoomLabel = element('span', 'zoom-label', '100%');
  const scratch = element('button', 'btn', '旧草稿定位'); scratch.type = 'button'; scratch.hidden = true;
  const confirmFocus = element('button', 'btn focus-action', '设为全班焦点'); confirmFocus.type = 'button'; confirmFocus.disabled = true;
  textbookControls.append(previousPage, pageLabel, nextPage, zoomOut, zoomLabel, zoomIn, scratch, confirmFocus);
  const stage = element('div', 'board-stage textbook-stage'); const frame = element('div', 'board-frame textbook-frame'); frame.dataset.live = String(classroom.status === 'live');
  const worldLayer = element('div', 'teaching-world');
  const pageLayer = element('div', 'textbook-page-layer teaching-page');
  const canvas = element('canvas', 'textbook-canvas'); canvas.hidden = true;
  const focusOverlay = element('div', 'textbook-focus'); focusOverlay.hidden = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('classroom-board');
  const recognitionRegion = element('div', 'recognition-region'); recognitionRegion.hidden = true; recognitionRegion.append(element('span', '', '正在识别'));
  pageLayer.append(canvas, focusOverlay); worldLayer.append(pageLayer, svg, recognitionRegion); frame.append(worldLayer);
  const viewportStatus = element('div', 'teaching-viewport-status'); viewportStatus.setAttribute('role', 'status'); frame.append(viewportStatus);
  const submitNotice = element('div', 'board-submit-notice'); submitNotice.hidden = true; submitNotice.setAttribute('role', 'alert');
  const submitText = element('span', '', '这笔尚未提交到课堂。');
  const retrySubmit = element('button', 'btn', '重试提交'); retrySubmit.type = 'button';
  submitNotice.append(submitText, retrySubmit); frame.append(submitNotice);
  stage.append(frame);
  const recognitionPanel = element('aside', 'recognition-panel');
  const recognitionHeading = element('div', 'recognition-heading'); recognitionHeading.append(element('h2', '', '板书识别'), element('span', 'recognition-auto-state', classroom.status === 'live' ? '自动' : '未开始'));
  const recognitionNotice = element('p', 'recognition-notice', classroom.status === 'live' ? '停笔后自动识别，结果由老师确认。' : '开始上课后，停笔即可自动识别。'); recognitionNotice.setAttribute('aria-live', 'polite');
  const recognitionQueue = element('div', 'recognition-queue');
  recognitionPanel.append(recognitionHeading, recognitionNotice, recognitionQueue);
  const audioIdentity = element('div', 'audio-identity'); audioIdentity.append(element('strong', '', '课堂声音'), element('span', '', '教师单向直播 · 同步保存原始录音'));
  const audioStatus = element('span', 'audio-status', '未开启'); audioStatus.setAttribute('aria-live', 'polite');
  const audioToggle = element('button', 'btn', '开始录制并直播声音'); audioToggle.type = 'button'; audioToggle.disabled = classroom.status !== 'live';
  let transcriptionLanguage: 'zh' | 'en' = localStorage.getItem('inkloop.classroom.transcription-language') === 'en' ? 'en' : 'zh';
  const languageSwitch = element('div', 'transcript-language-switch'); languageSwitch.setAttribute('role', 'group'); languageSwitch.setAttribute('aria-label', '字幕语言');
  const chineseLanguage = element('button', 'language-option', '中文'); const englishLanguage = element('button', 'language-option', 'English');
  chineseLanguage.type = englishLanguage.type = 'button';
  const syncLanguageSwitch = (): void => { chineseLanguage.classList.toggle('on', transcriptionLanguage === 'zh'); englishLanguage.classList.toggle('on', transcriptionLanguage === 'en'); chineseLanguage.setAttribute('aria-pressed', String(transcriptionLanguage === 'zh')); englishLanguage.setAttribute('aria-pressed', String(transcriptionLanguage === 'en')); };
  const setLanguage = (language: 'zh' | 'en'): void => { transcriptionLanguage = language; localStorage.setItem('inkloop.classroom.transcription-language', language); syncLanguageSwitch(); audioStatus.textContent = `${language === 'zh' ? '中文普通话' : 'English'} · 从下一段声音生效`; };
  chineseLanguage.addEventListener('click', () => setLanguage('zh')); englishLanguage.addEventListener('click', () => setLanguage('en')); languageSwitch.append(chineseLanguage, englishLanguage); syncLanguageSwitch();
  const transcriptionPrivacy = element('div', 'audio-transcription-mode', '本机转写 · 音频不发送到外部');
  const externalTranscription = element('label', 'audio-external-opt-in'); const externalTranscriptionCheckbox = element('input'); externalTranscriptionCheckbox.type = 'checkbox';
  externalTranscription.append(externalTranscriptionCheckbox, document.createTextNode('允许把本次录音片段发送到管理员配置的外部转写服务'));
  externalTranscription.hidden = true;
  const transcriptPanel = element('section', 'classroom-transcript-panel teacher-transcript-panel');
  const transcriptHead = element('div', 'transcript-head');
  const transcriptHeadActions = element('div', 'transcript-head-actions');
  const transcriptMode = element('span', 'transcript-mode', '本机');
  const clearTranscripts = element('button', 'btn transcript-clear', '清空'); clearTranscripts.type = 'button'; clearTranscripts.title = '清空全班字幕';
  transcriptHeadActions.append(transcriptMode, clearTranscripts); transcriptHead.append(element('strong', '', '实时字幕'), transcriptHeadActions);
  const transcriptList = element('div', 'transcript-list'); transcriptList.append(element('p', 'transcript-empty', '开启课堂声音后生成本地优先字幕。'));
  transcriptPanel.append(transcriptHead, transcriptList);
  const headerAudio = element('div', 'teacher-header-audio'); headerAudio.append(languageSwitch, audioStatus, audioToggle);
  const headerIdentity = element('div', 'teacher-header-identity'); headerIdentity.append(identity, state);
  topbar.append(brand, headerIdentity, headerAudio, actions);
  const toolbelt = element('nav', 'teacher-toolbelt'); toolbelt.setAttribute('aria-label', '授课工具');
  toolbelt.append(inkTools, textbookControls, upload, uploadInput);
  const teacherSidebar = element('aside', 'teacher-sidebar'); teacherSidebar.append(transcriptPanel, recognitionPanel);
  const studioBody = element('div', 'teacher-studio-body'); studioBody.append(stage, teacherSidebar);
  // Privacy/provider details remain available to assistive technology and are
  // surfaced only when an external service is actually configured.
  const audioDetails = element('div', 'teacher-audio-details'); audioDetails.append(audioIdentity, transcriptionPrivacy, externalTranscription);
  topbar.append(audioDetails);
  workspace.append(toolbelt, studioBody);
  const lessonPanel = element('section', 'teacher-lesson'); lessonPanel.hidden = classroom.status !== 'ended';
  workspace.append(lessonPanel); shell.append(topbar, workspace); app.append(shell);
  const renderer = new ClassroomBoardRenderer(svg);
  const textbook = new TextbookRenderer(canvas, focusOverlay);
  const teachingViewport = new ClassroomTeachingViewport({ viewport: frame, world: worldLayer, page: pageLayer, ink: svg, focus: focusOverlay, status: viewportStatus }, () => {
    renderer.setVisibleWorldRect(teachingViewport.visibleRect());
  });
  let materials: ClassroomMaterial[] = [];
  let material: ClassroomMaterial | undefined;
  let teacherView: ClassroomTeacherView | undefined;
  let confirmedFocus: ClassroomConfirmedFocus | undefined;
  let lastStrokeBox: ClassroomWorldBBox | undefined;
  let viewRevision = 0;
  let materialLoadRevision = 0;
  let activeInkTool: Extract<InkToolControl, 'pen' | 'highlighter' | 'eraser'> = 'pen';
  let viewInteraction = '';
  let viewInteractionSequence = 0;
  let lastTransientSentAt = 0;
  let recentEvents: ClassroomBoardEvent[] = [];
  let recognitions: ClassroomRecognitionRevision[] = [];
  let recognitionTimer = 0;
  let recognitionBusy = false;
  let recognitionQueued = false;
  let lastRecognitionStrokeAt = 0;
  let recognitionConsent: 'unknown' | 'granted' | 'denied' = sessionStorage.getItem(`inkloop.classroom.recognition-consent.${classroom.classroom_id}`) === 'granted' ? 'granted' : 'unknown';
  const recognitionClient = new ClassroomRecognitionClient(client, classroom.classroom_id);
  const audioApi = new ClassroomAudioApi(client, classroom.classroom_id);
  const transcriptClient = new ClassroomTranscriptClient(client, classroom.classroom_id);
  let transcripts: ClassroomTranscriptRevision[] = [];
  let transcription: ClassroomTranscriptionState | null = null;
  const syncInkTools = (): void => {
    syncInkToolControls([penTool, highlighterTool, eraserTool], activeInkTool);
    frame.dataset.inkTool = activeInkTool;
    undoTool.disabled = classroom.status !== 'live' || renderer.activeEvents().filter((event) => sameSurface(event.surface, teacherView?.active_surface)).length === 0;
  };
  penTool.addEventListener('click', () => { activeInkTool = 'pen'; syncInkTools(); frame.focus(); });
  highlighterTool.addEventListener('click', () => { activeInkTool = 'highlighter'; syncInkTools(); frame.focus(); });
  eraserTool.addEventListener('click', () => { activeInkTool = 'eraser'; syncInkTools(); frame.focus(); });
  const renderTranscripts = (): void => {
    transcriptList.replaceChildren();
    const visible = latestTranscriptProjection(transcripts);
    if (!visible.length) transcriptList.append(element('p', 'transcript-empty', transcription?.state === 'delayed' ? '转写暂时延迟，原始录音已保留。' : '等待老师讲解…'));
    for (const chunkId of transcription?.retryable_chunk_ids ?? []) {
      const retry = element('button', 'btn', `重试 ${chunkId}`); retry.type = 'button';
      retry.addEventListener('click', () => { retry.disabled = true; void transcriptClient.retry(chunkId).then(() => transcriptClient.list()).then((value) => { transcripts = value.transcripts; transcription = value.transcription; renderTranscripts(); }).catch(() => { retry.disabled = false; }); });
      transcriptList.append(retry);
    }
    for (const item of visible) {
      const row = element('article', `transcript-row ${item.status === 'provisional' ? 'provisional' : ''} ${item.status === 'corrected' ? 'stabilized' : ''} ${item.confidence < 0.6 ? 'low-confidence' : ''}`);
      const transcriptText = element('span', 'transcript-text', item.text);
      row.append(element('time', '', formatTranscriptTime(item.relative_start_ms)), transcriptText);
      const actions = element('div', 'transcript-actions');
      if (classroom.status === 'ended') {
        const correct = element('button', 'btn', '更正'); correct.type = 'button';
        correct.addEventListener('click', () => {
          const text = window.prompt('更正字幕', item.text)?.trim(); if (!text || text === item.text) return;
          void transcriptClient.correct(item.transcript_id, text).then(({ transcript }) => { transcripts.push(transcript); renderTranscripts(); });
        });
        actions.append(correct);
      }
      if (actions.childElementCount) row.append(actions);
      transcriptList.append(row);
    }
    transcriptList.scrollTop = transcriptList.scrollHeight;
  };
  clearTranscripts.addEventListener('click', () => {
    if (!transcripts.length && !transcription) return;
    if (!window.confirm('清空全班字幕？\n\n所有已加入课堂的设备都会同步清空。原始录音和板书仍会保留。')) return;
    clearTranscripts.disabled = true;
    void transcriptClient.clear().then(() => {
      transcripts = []; transcription = null; renderTranscripts();
      clearTranscripts.textContent = '已清空'; window.setTimeout(() => { clearTranscripts.textContent = '清空'; }, 1_500);
    }).catch((cause) => {
      window.alert(`清空失败：${cause instanceof Error ? cause.message : 'unknown'}`);
    }).finally(() => { clearTranscripts.disabled = false; });
  });
  const audioCapture = new ClassroomAudioCapture({ isSecureContext: globalThis.isSecureContext, protocol: location.protocol, mediaDevices: navigator.mediaDevices });
  let audioAbort: AbortController | null = null;
  let audioPeers: TeacherAudioPeers | null = null;
  let audioContext: AudioContext | null = null;
  let audioWorklet: AudioWorkletNode | null = null;
  let recording: ClassroomRecordingState | null = null;
  let audioUpload: Promise<unknown> = Promise.resolve();
  let pendingAudioUploads = 0;
  const availability = classroomAudioAvailability({ isSecureContext: globalThis.isSecureContext, protocol: location.protocol, mediaDevices: navigator.mediaDevices });
  if (!availability.available) {
    audioToggle.disabled = true; audioStatus.classList.add('degraded');
    audioStatus.textContent = availability.reason === 'secure_context_required' ? '当前是 HTTP 开发入口 · 音频需受信任 HTTPS' : '浏览器不支持麦克风采集';
  }

  const stopAudio = async (): Promise<void> => {
    audioAbort?.abort(); audioAbort = null; audioPeers?.stop(); audioPeers = null;
    audioCapture.stop();
    if (audioWorklet) {
      const flushed = new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 1_000);
        const receive = (event: MessageEvent<{ type?: string }>): void => {
          if (event.data.type !== 'flushed') return;
          window.clearTimeout(timeout); audioWorklet?.port.removeEventListener('message', receive); resolve();
        };
        audioWorklet!.port.addEventListener('message', receive); audioWorklet!.port.start();
      });
      audioWorklet.port.postMessage({ type: 'flush' }); await flushed;
    }
    await audioUpload.catch(() => undefined);
    await audioContext?.close().catch(() => undefined); audioContext = null; audioWorklet = null;
    const current = recording; recording = null;
    if (current?.state === 'recording') await audioApi.stopRecording(current).catch(() => undefined);
    audioToggle.textContent = '开始录制并直播声音'; audioToggle.disabled = session?.classroom.status !== 'live' || !availability.available;
    audioStatus.textContent = current?.health === 'incomplete' ? '已停止 · 录制不完整' : '已停止'; audioStatus.classList.toggle('degraded', current?.health === 'incomplete');
  };

  const startAudio = async (): Promise<void> => {
    audioToggle.disabled = true; audioStatus.textContent = '正在请求麦克风权限…'; audioStatus.classList.remove('degraded');
    try {
      const stream = await audioCapture.acquire();
      recording = (await audioApi.startRecording()).recording;
      audioAbort = new AbortController(); audioPeers = new TeacherAudioPeers(audioApi, stream); void audioPeers.run(audioAbort.signal);
      audioContext = new AudioContext(); const source = audioContext.createMediaStreamSource(stream); const workletUrl = classroomAudioWorkletUrl();
      await audioContext.audioWorklet.addModule(workletUrl); URL.revokeObjectURL(workletUrl);
      const worklet = new AudioWorkletNode(audioContext, 'inkloop-classroom-audio'); audioWorklet = worklet; const silent = audioContext.createGain(); silent.gain.value = 0;
      source.connect(worklet); worklet.connect(silent); silent.connect(audioContext.destination);
      let sequence = recording.last_sequence; let relativeStart = recording.last_relative_end_ms;
      worklet.port.onmessage = (event: MessageEvent<{ type?: string; samples?: Float32Array; sampleRate?: number }>) => {
        if (event.data.type === 'flushed' || !event.data.samples || !event.data.sampleRate) return;
        if (!recording || recording.state !== 'recording') return;
        const samples = event.data.samples; const sampleRate = event.data.sampleRate; const duration = Math.round(samples.length / sampleRate * 1_000);
        sequence += 1; const currentSequence = sequence; const startMs = relativeStart; relativeStart += duration;
        const currentRecording = recording;
        pendingAudioUploads += 1;
        if (pendingAudioUploads > 4) { audioStatus.textContent = `声音直播中 · ${pendingAudioUploads} 段等待上传`; audioStatus.classList.add('degraded'); }
        audioUpload = audioUpload.then(() => audioApi.appendChunk(currentRecording.recording_id, {
          recording_generation: currentRecording.recording_generation, chunk_id: `${currentRecording.recording_id}_chunk_${currentSequence}`, sequence: currentSequence,
          sample_rate: sampleRate, channels: 1, relative_start_ms: startMs, relative_end_ms: relativeStart, pcm_s16le_base64: floatToPcmBase64(samples),
          external_transcription_opt_in: externalTranscriptionCheckbox.checked,
          language_hint: transcriptionLanguage,
        })).then((result) => { recording = result.recording; audioStatus.textContent = result.recording.health === 'healthy' ? `声音直播中 · 已保存 ${result.recording.chunk_count} 段` : '声音直播中 · 录制不完整'; audioStatus.classList.toggle('degraded', result.recording.health === 'incomplete'); renderTranscripts(); }).catch(() => { if (recording) recording = { ...recording, health: 'incomplete' }; audioStatus.textContent = '声音直播中 · 录制上传失败'; audioStatus.classList.add('degraded'); renderTranscripts(); }).finally(() => { pendingAudioUploads -= 1; });
      };
      audioToggle.textContent = '停止课堂声音'; audioToggle.disabled = false; audioStatus.textContent = '声音直播中 · 正在保存录音';
    } catch (cause) {
      audioAbort?.abort(); audioAbort = null; audioPeers?.stop(); audioPeers = null; audioCapture.stop();
      await audioContext?.close().catch(() => undefined); audioContext = null; audioWorklet = null;
      const failedRecording = recording ? { ...recording, health: 'incomplete' as const } : null; recording = null;
      if (failedRecording?.state === 'recording') await audioApi.stopRecording(failedRecording).catch(() => undefined);
      audioStatus.classList.add('degraded');
      audioStatus.textContent = cause instanceof DOMException && cause.name === 'NotAllowedError' ? '麦克风权限被拒绝 · 课本和板书仍可用' : `声音启动失败 · ${cause instanceof Error ? cause.message : 'unknown'}`;
      audioToggle.disabled = false;
    }
  };
  audioToggle.addEventListener('click', () => { if (recording?.state === 'recording') void stopAudio(); else void startAudio(); });

  const renderRecognitions = (): void => {
    recognitionQueue.replaceChildren();
    const visible = latestRecognitionProjection(recognitions).filter((item) => item.status !== 'dismissed');
    if (!visible.length) { recognitionQueue.append(element('p', 'recognition-empty', '暂无识别候选')); return; }
    for (const recognition of visible) {
      const item = element('article', `recognition-item trust-${recognition.status}`);
      const head = element('div', 'recognition-item-head');
      head.append(element('span', 'recognition-state', recognitionTrustLabel(recognition)), element('span', 'recognition-revision', `r${recognition.revision}`));
      item.append(head);
      item.append(element('div', 'recognition-text', recognition.text || '未获得可用识别结果'));
      if (shouldShowRecognitionLatex(recognition.text, recognition.latex)) item.append(element('code', 'recognition-latex', `LaTeX · ${recognition.latex}`));
      const locate = element('button', 'source-link', '定位原公式'); locate.type = 'button'; locate.addEventListener('click', () => { void locateSources(recognition.event_ids); }); item.append(locate);
      if (recognition.status === 'pending') {
        const actions = element('div', 'recognition-actions');
        const confirmButton = element('button', 'btn', '确认'); const correctButton = element('button', 'btn', '纠正'); const dismissButton = element('button', 'btn', '驳回');
        for (const button of [confirmButton, correctButton, dismissButton]) button.type = 'button';
        const review = (input: { status: 'confirmed' | 'corrected' | 'dismissed'; text?: string; latex?: string }): void => {
          for (const button of [confirmButton, correctButton, dismissButton]) button.disabled = true;
          void recognitionClient.review(recognition.recognition_id, input).then(({ recognition: next }) => { recognitions.push(next); renderRecognitions(); recognitionNotice.textContent = input.status === 'corrected' ? '更正已保存，学生端和后续 AI 将使用新 revision。' : '审核状态已同步到学生端。'; }).catch((cause) => { recognitionNotice.textContent = `审核失败：${cause instanceof Error ? cause.message : 'unknown'}`; renderRecognitions(); });
        };
        confirmButton.addEventListener('click', () => review({ status: 'confirmed' }));
        correctButton.addEventListener('click', () => { const text = prompt('修正识别文本：', recognition.text); if (!text?.trim()) return; const latex = prompt('修正 LaTeX（可留空）：', recognition.latex || ''); review({ status: 'corrected', text: text.trim(), latex: latex?.trim() || undefined }); });
        dismissButton.addEventListener('click', () => review({ status: 'dismissed' }));
        actions.append(confirmButton, correctButton, dismissButton); item.append(actions);
      } else if (recognition.status === 'failed') {
        const actions = element('div', 'recognition-actions');
        const removeButton = element('button', 'btn danger', '删除'); removeButton.type = 'button';
        removeButton.addEventListener('click', () => {
          removeButton.disabled = true;
          void recognitionClient.review(recognition.recognition_id, { status: 'dismissed' }).then(({ recognition: dismissed }) => {
            recognitions.push(dismissed); renderRecognitions(); recognitionNotice.textContent = '失败记录已删除，原笔迹仍保留。';
          }).catch((cause) => { removeButton.disabled = false; recognitionNotice.textContent = `删除失败：${cause instanceof Error ? cause.message : 'unknown'}`; });
        });
        actions.append(removeButton); item.append(actions);
      }
      recognitionQueue.append(item);
    }
  };

  const hideRecognitionRegion = (): void => { recognitionRegion.hidden = true; };
  const showRecognitionRegion = (group: ReturnType<typeof groupRecentFormulaEvents>): void => {
    const box = group?.spatial_region?.bbox_world; if (!box) return;
    recognitionRegion.style.left = `${box[0]}px`; recognitionRegion.style.top = `${box[1]}px`;
    recognitionRegion.style.width = `${box[2]}px`; recognitionRegion.style.height = `${box[3]}px`; recognitionRegion.hidden = false;
  };
  const runAutomaticRecognition = (): void => {
    if (recognitionBusy) { recognitionQueued = true; return; }
    if (session?.classroom.status !== 'live') return;
    const group = groupRecentFormulaEvents(recentEvents, { surface: activeSurface(), materials });
    if (!group) return;
    const groupKey = [...group.event_ids].sort().join('|');
    const alreadyRecognized = latestRecognitionProjection(recognitions).some((item) => [...item.event_ids].sort().join('|') === groupKey);
    if (alreadyRecognized) return;
    if (recognitionConsent === 'unknown') {
      recognitionConsent = window.confirm('开启本堂课的自动板书识别？\n\n停笔后，只会把刚写的板书区域发送给已配置的 AI 识别服务；不会发送课堂语音。') ? 'granted' : 'denied';
      if (recognitionConsent === 'granted') sessionStorage.setItem(`inkloop.classroom.recognition-consent.${classroom.classroom_id}`, 'granted');
    }
    if (recognitionConsent !== 'granted') { recognitionNotice.textContent = '自动识别未开启，刷新页面后可重新授权。'; return; }
    recognitionBusy = true; showRecognitionRegion(group); recognitionNotice.textContent = `正在识别刚写的内容（${group.event_ids.length} 笔）…`;
    let crop: string;
    try { crop = renderRecognitionCrop(recentEvents, group, document, materials); }
    catch { recognitionBusy = false; hideRecognitionRegion(); recognitionNotice.textContent = '无法截取这段板书，书写和同步不受影响。'; return; }
    void recognitionClient.recognize(group, 'external', crop).then(({ recognition }) => {
      recognitions.push(recognition); renderRecognitions();
      recognitionNotice.textContent = recognition.status === 'failed' ? '这段板书暂时无法识别，书写和同步不受影响。' : '识别完成，请确认或修改。';
      if (recognition.status !== 'failed') {
        const fullGroup = new Set(recognition.event_ids);
        const fragments = latestRecognitionProjection(recognitions).filter((item) => item.recognition_id !== recognition.recognition_id
          && item.status === 'pending' && item.event_ids.length < fullGroup.size && item.event_ids.every((id) => fullGroup.has(id)));
        for (const fragment of fragments) {
          void recognitionClient.review(fragment.recognition_id, { status: 'dismissed' }).then(({ recognition: dismissed }) => {
            recognitions.push(dismissed); renderRecognitions();
          }).catch(() => undefined);
        }
      }
    }).catch((cause) => { recognitionNotice.textContent = `识别失败：${cause instanceof Error ? cause.message : 'unknown'}`; }).finally(() => {
      recognitionBusy = false; window.setTimeout(hideRecognitionRegion, 1_200);
      if (recognitionQueued) {
        recognitionQueued = false; window.clearTimeout(recognitionTimer);
        recognitionTimer = window.setTimeout(runAutomaticRecognition, remainingRecognitionIdleDelay(lastRecognitionStrokeAt, Date.now()));
      }
    });
  };
  const scheduleAutomaticRecognition = (): void => {
    window.clearTimeout(recognitionTimer);
    lastRecognitionStrokeAt = Date.now();
    recognitionNotice.textContent = '已同步，停笔约 1.6 秒后自动识别…';
    recognitionTimer = window.setTimeout(runAutomaticRecognition, remainingRecognitionIdleDelay(lastRecognitionStrokeAt, Date.now()));
  };

  const activeSurface = (): ClassroomSurfaceRef => teacherView?.active_surface ?? { kind: 'teacher_board' };
  const updateTextbookControls = (): void => {
    const has = !!material && !!teacherView;
    previousPage.disabled = !has || teacherView!.page_index <= 0;
    nextPage.disabled = !has || teacherView!.page_index >= material!.page_count - 1;
    pageLabel.textContent = has ? `${teacherView!.page_index + 1} / ${material!.page_count}` : '白板';
    zoomLabel.textContent = has ? `${Math.round((teacherView!.viewport?.zoom_scale ?? teacherView!.zoom_percent / 100) * 100)}%` : '100%';
    confirmFocus.disabled = !has || !lastStrokeBox || teacherView?.active_surface.kind !== 'textbook_page';
  };
  const renderTeacherView = async (): Promise<void> => {
    if (!material || !teacherView) { canvas.hidden = true; frame.classList.remove('has-textbook'); renderer.setSurface({ kind: 'teacher_board' }); updateTextbookControls(); return; }
    const geometry = material.page_geometries?.[teacherView.page_index];
    teachingViewport.setPageGeometry(geometry);
    const view = teacherView.viewport ?? (geometry ? fitPageViewport(geometry.width_world, geometry.height_world, teachingViewport.size()) : { center_x_world: 0, center_y_world: 0, zoom_scale: teacherView.zoom_percent / 100 });
    teachingViewport.setView(view); renderer.setMaterials(materials); renderer.setVisibleWorldRect(teachingViewport.visibleRect());
    canvas.hidden = false; frame.classList.add('has-textbook'); frame.classList.remove('scratch-surface'); renderer.setSurface({ kind: 'textbook_page', material_id: material.material_id, page_index: teacherView.page_index });
    await textbook.render({ ...teacherView, viewport: view }); updateTextbookControls(); syncInkTools();
  };
  const publishView = async (pageIndex: number, zoomPercent: number, viewportOverride?: ClassroomTeacherView['viewport'], zoomMode: ClassroomTeacherView['zoom_mode'] = 'percent'): Promise<void> => {
    if (!material || lifecycle.signal.aborted) return;
    const nextPage = Math.max(0, Math.min(material.page_count - 1, pageIndex));
    const geometry = material.page_geometries?.[nextPage];
    const key = pageViewportKey(material.material_id, nextPage);
    const viewport = viewportOverride ?? (zoomMode === 'fit-width' && geometry
      ? fitPageWidthViewport(geometry.width_world, geometry.height_world, teachingViewport.size())
      : teacherView?.page_viewports?.[key] ?? (geometry ? fitPageViewport(geometry.width_world, geometry.height_world, teachingViewport.size()) : { center_x_world: 0, center_y_world: 0, zoom_scale: Math.max(0.5, Math.min(4, zoomPercent / 100)) }));
    const pageViewports = { ...(teacherView?.page_viewports ?? {}), [key]: viewport };
    teacherView = {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroom.classroom_id, material_id: material.material_id,
      page_index: nextPage, zoom_mode: zoomMode, zoom_percent: Math.round(viewport.zoom_scale * 100), viewport, page_viewports: pageViewports,
      active_surface: { kind: 'textbook_page', material_id: material.material_id, page_index: nextPage },
      revision: Math.max(viewRevision + 1, (teacherView?.revision ?? 0) + 1), updated_at: new Date().toISOString(),
    };
    viewRevision = teacherView.revision; lastStrokeBox = undefined; hideRecognitionRegion(); textbook.showFocus(confirmedFocus?.material_id === material.material_id && confirmedFocus.page_index === nextPage ? confirmedFocus : undefined); await renderTeacherView();
    if (lifecycle.signal.aborted) return;
    await client.post(`/v1/classrooms/${classroom.classroom_id}/teacher-view`, teacherView, lifecycle.signal);
  };
  const locateSources = async (eventIds: readonly string[]): Promise<void> => {
    const events = eventIds.map((eventId) => renderer.sourceEvent(eventId)).filter((event): event is ClassroomBoardEvent => !!event);
    const event = events[0]; if (!event || !renderer.sourceWorldBBoxForEvents(eventIds)) return;
    if (!events.every((candidate) => sameSurface(candidate.surface, event.surface))) return;
    if (!sameSurface(event.surface, activeSurface())) return;
    requestAnimationFrame(() => renderer.showSourceAnchor(eventIds));
  };
  const locateSource = (eventId: string): Promise<void> => locateSources([eventId]);
  const publishGestureView = (view: NonNullable<ClassroomTeacherView['viewport']>, final: boolean): void => {
    if (!teacherView || !material || session?.classroom.status !== 'live') return;
    const now = performance.now(); if (!final && now - lastTransientSentAt < 84) return; lastTransientSentAt = now;
    if (!viewInteraction) { viewInteraction = createClassroomClientId('view'); viewInteractionSequence = 0; }
    viewInteractionSequence += 1;
    const baseRevision = teacherView.revision; const key = pageViewportKey(material.material_id, teacherView.page_index);
    const candidate: ClassroomTeacherView = { ...teacherView, zoom_mode: 'percent', viewport: view, page_viewports: { ...(teacherView.page_viewports ?? {}), [key]: view }, zoom_percent: Math.round(view.zoom_scale * 100), revision: baseRevision + 1, updated_at: new Date().toISOString() };
    const interactionId = viewInteraction; const sequence = viewInteractionSequence;
    void client.post<{ teacher_view: ClassroomTeacherView; durable: boolean }>(`/v1/classrooms/${classroom.classroom_id}/teacher-view-transient`, { teacher_view: candidate, interaction_id: interactionId, transient_sequence: sequence, base_revision: baseRevision, final }).then((result) => {
      if (result.durable) { teacherView = result.teacher_view; viewRevision = result.teacher_view.revision; viewInteraction = ''; viewInteractionSequence = 0; }
    }).catch(() => { if (final) { viewInteraction = ''; viewInteractionSequence = 0; } });
  };
  const useMaterial = async (next: ClassroomMaterial, existingView?: ClassroomTeacherView, initialPageIndex = 0): Promise<void> => {
    if (lifecycle.signal.aborted) return;
    const loadRevision = ++materialLoadRevision;
    const bytes = await client.pdf(`/v1/classrooms/${classroom.classroom_id}/materials/${next.material_id}`, lifecycle.signal);
    if (loadRevision !== materialLoadRevision || lifecycle.signal.aborted) return;
    await textbook.load(bytes);
    if (loadRevision !== materialLoadRevision || lifecycle.signal.aborted) return;
    material = next;
    if (existingView?.material_id === next.material_id) {
      teacherView = existingView; viewRevision = existingView.revision;
      const geometry = next.page_geometries?.[existingView.page_index];
      const oldFit = geometry ? fitPageViewport(geometry.width_world, geometry.height_world, teachingViewport.size()) : undefined;
      const looksLikeLegacyFitPage = !!oldFit && !!existingView.viewport
        && Math.abs(existingView.viewport.center_x_world) < 0.01 && Math.abs(existingView.viewport.center_y_world) < 0.01
        && Math.abs(existingView.viewport.zoom_scale - oldFit.zoom_scale) < 0.03;
      if (existingView.zoom_mode === 'fit-width' || looksLikeLegacyFitPage) await publishView(existingView.page_index, existingView.zoom_percent, undefined, 'fit-width');
      else await renderTeacherView();
    } else await publishView(initialPageIndex, 100, undefined, 'fit-width');
  };
  let fitWidthResizeTimer = 0;
  let fitWidthSize = `${frame.clientWidth}x${frame.clientHeight}`;
  const fitWidthResizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
    const nextSize = `${frame.clientWidth}x${frame.clientHeight}`;
    if (nextSize === fitWidthSize) return;
    fitWidthSize = nextSize;
    window.clearTimeout(fitWidthResizeTimer);
    if (!teacherView || !material || teacherView.zoom_mode !== 'fit-width') return;
    const geometry = material.page_geometries?.[teacherView.page_index];
    if (!geometry) return;
    const view = fitPageWidthViewport(geometry.width_world, geometry.height_world, teachingViewport.size());
    teachingViewport.setView(view); renderer.setVisibleWorldRect(teachingViewport.visibleRect());
    fitWidthResizeTimer = window.setTimeout(() => {
      if (teacherView?.zoom_mode === 'fit-width') void publishView(teacherView.page_index, Math.round(view.zoom_scale * 100), view, 'fit-width');
    }, 180);
  });
  fitWidthResizeObserver?.observe(frame);
  lifecycle.signal.addEventListener('abort', () => { fitWidthResizeObserver?.disconnect(); window.clearTimeout(fitWidthResizeTimer); }, { once: true });
  const uploadPdf = async (bytes: ArrayBuffer, title: string, key: string): Promise<void> => {
    const result = await client.uploadPdf<{ material: ClassroomMaterial }>(`/v1/classrooms/${classroom.classroom_id}/materials`, bytes, title, key);
    materials = [...materials.filter((item) => item.material_id !== result.material.material_id), result.material];
    await useMaterial(result.material);
  };
  upload.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files?.[0]; if (!file) return;
    upload.disabled = true;
    void file.arrayBuffer().then((bytes) => uploadPdf(bytes, file.name.replace(/\.pdf$/i, ''), createClassroomClientId('upload'))).catch((cause) => alert(`PDF 导入失败：${cause instanceof Error ? cause.message : 'unknown'}`)).finally(() => { upload.disabled = false; uploadInput.value = ''; });
  });
  previousPage.addEventListener('click', () => { if (teacherView) void publishView(teacherView.page_index - 1, teacherView.zoom_percent, undefined, teacherView.zoom_mode); });
  nextPage.addEventListener('click', () => { if (teacherView) void publishView(teacherView.page_index + 1, teacherView.zoom_percent, undefined, teacherView.zoom_mode); });
  zoomOut.addEventListener('click', () => { if (teacherView) { const view = teachingViewport.zoomAt({ x: frame.clientWidth / 2, y: frame.clientHeight / 2 }, teachingViewport.getView().zoom_scale / 1.2); void publishView(teacherView.page_index, Math.round(view.zoom_scale * 100), view); } });
  zoomIn.addEventListener('click', () => { if (teacherView) { const view = teachingViewport.zoomAt({ x: frame.clientWidth / 2, y: frame.clientHeight / 2 }, teachingViewport.getView().zoom_scale * 1.2); void publishView(teacherView.page_index, Math.round(view.zoom_scale * 100), view); } });
  confirmFocus.addEventListener('click', () => {
    if (!material || !teacherView || !lastStrokeBox) return;
    const focus: ClassroomConfirmedFocus = { schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroom.classroom_id, focus_id: createClassroomClientId('focus'), material_id: material.material_id, page_index: teacherView.page_index, spatial_region: { coordinate_space: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: { kind: 'textbook_page', material_id: material.material_id, page_index: teacherView.page_index }, bbox_world: lastStrokeBox }, confirmed_at: new Date().toISOString() };
    void client.post(`/v1/classrooms/${classroom.classroom_id}/confirmed-focus`, focus).then(() => { confirmedFocus = focus; textbook.showFocus(focus); confirmFocus.textContent = '全班焦点已更新'; });
  });
  const renderLesson = (lesson: ClassroomLessonOutput | null): void => {
    lessonPanel.replaceChildren();
    const heading = element('div', 'lesson-heading'); heading.append(element('h2', '', '教师规范课堂笔记'));
    const generate = element('button', 'btn primary', lesson?.stale ? '按新公式重新生成' : lesson ? '已生成候选' : '生成课堂候选'); generate.type = 'button'; generate.disabled = !!lesson && !lesson.stale;
    heading.append(generate); lessonPanel.append(heading);
    const generationError = element('p', 'lesson-error'); generationError.hidden = true; generationError.setAttribute('role', 'alert'); lessonPanel.append(generationError);
    generate.addEventListener('click', () => {
      generate.disabled = true; generationError.hidden = true; generationError.textContent = '';
      void client.post<{ lesson: ClassroomLessonOutput }>(`/v1/classrooms/${classroom.classroom_id}/lesson`).then(({ lesson: next }) => renderLesson(next)).catch((cause) => {
        generationError.textContent = teacherLessonErrorMessage(cause); generationError.hidden = false; generate.disabled = false;
      });
    });
    if (!lesson) return;
    const status = element('p', 'lesson-status', lesson.stale ? '公式证据已更新 · 当前候选已过期，请重新生成。' : `${lesson.execution_mode === 'real' ? '真实 AI 候选' : '确定性降级候选'} · ${lesson.review_complete ? '审核已完成，以下内容是唯一规范投影。' : `还有 ${lesson.candidates.filter((candidate) => candidate.review_status === 'pending').length} 项待审核。`}`); lessonPanel.append(status);
    for (const candidate of lesson.candidates) {
      const item = element('article', 'lesson-candidate');
      const needsFormulaReview = candidate.kind === 'formula' && candidate.confidence < 0.6 && candidate.review_status === 'pending';
      const title = element('div', 'lesson-candidate-head');
      title.append(element('strong', '', `步骤 ${candidate.order} · ${candidate.kind}`), element('span', '', needsFormulaReview ? '低置信公式 · 需要审核' : candidate.review_status));
      item.append(title, element('p', '', candidate.content));
      const source = candidate.source_refs.find((ref) => ref.type === 'ink_event');
      if (source?.type === 'ink_event') { const link = element('button', 'source-link', `定位来源 · ${source.event_id}`); link.type = 'button'; link.addEventListener('click', () => { void locateSource(source.event_id); }); item.append(link); }
      if (candidate.review_status === 'pending') {
        const commands = element('div', 'lesson-review-actions');
        const accept = element('button', 'btn', '接受'); const edit = element('button', 'btn', '编辑'); const dismiss = element('button', 'btn', '驳回');
        for (const button of [accept, edit, dismiss]) button.type = 'button';
        const review = (status: 'accepted' | 'edited' | 'dismissed', content?: string): void => { for (const button of [accept, edit, dismiss]) button.disabled = true; void client.post<{ lesson: ClassroomLessonOutput }>(`/v1/classrooms/${classroom.classroom_id}/lesson/candidates/${candidate.candidate_id}/review`, { status, ...(content ? { content } : {}) }).then(({ lesson: next }) => renderLesson(next)); };
        accept.addEventListener('click', () => review('accepted'));
        edit.addEventListener('click', () => { const content = prompt('修改课堂步骤：', candidate.content); if (content?.trim()) review('edited', content); });
        dismiss.addEventListener('click', () => review('dismissed'));
        commands.append(accept, edit, dismiss); item.append(commands);
      }
      lessonPanel.append(item);
    }
    if (lesson.reviewed_lesson_graph) {
      const reviewed = element('div', 'reviewed-lesson'); reviewed.append(element('h3', '', '已审核课堂步骤'));
      for (const step of lesson.reviewed_lesson_graph.steps) reviewed.append(element('p', '', `${step.order}. ${step.content}`));
      lessonPanel.append(reviewed);
    }
  };
  if (classroom.status === 'ended') void client.get<{ lesson: ClassroomLessonOutput | null }>(`/v1/classrooms/${classroom.classroom_id}/lesson`).then(({ lesson }) => renderLesson(lesson)).catch(() => renderLesson(null));
  void client.get<ClassroomSnapshot>(`/v1/classrooms/${classroom.classroom_id}/snapshot`, lifecycle.signal).then(async (snapshot) => {
    if (lifecycle.signal.aborted) return;
    renderer.renderSnapshot(snapshot.board_events); recentEvents = snapshot.board_events; recognitions = snapshot.recognitions ?? []; renderRecognitions(); materials = snapshot.materials ?? [];
    transcripts = snapshot.transcripts ?? []; transcription = snapshot.transcription ?? null; renderTranscripts();
    void transcriptClient.list().then((value) => {
      const external = value.processing_mode === 'external';
      transcriptMode.textContent = external ? '外部' : '本机';
      externalTranscription.hidden = !external; transcriptionPrivacy.hidden = external;
      if (external) transcriptionPrivacy.textContent = '外部转写已配置 · 需逐次授权';
    }).catch(() => undefined);
    if (snapshot.recording?.state === 'interrupted') { audioStatus.textContent = '上次录音因服务重启中断 · 已保留原始分段'; audioStatus.classList.add('degraded'); }
    else if (snapshot.recording?.state === 'recording') { audioStatus.textContent = '检测到未完成录音 · 点击开始可恢复采集'; audioStatus.classList.add('degraded'); }
    else if (snapshot.recording?.state === 'stopped') { audioStatus.textContent = snapshot.recording.health === 'incomplete' ? '上次录音已停止 · 录制不完整' : '上次录音已停止'; audioStatus.classList.toggle('degraded', snapshot.recording.health === 'incomplete'); }
    if (snapshot.capabilities?.textbook === false) { textbookControls.hidden = true; upload.hidden = true; return; }
    confirmedFocus = snapshot.confirmed_focus;
    const result = await client.post<{ material: ClassroomMaterial }>(`/v1/classrooms/${classroom.classroom_id}/materials/builtin`, undefined, lifecycle.signal);
    if (lifecycle.signal.aborted) return;
    materials = [...materials.filter((item) => item.material_id !== result.material.material_id), result.material];
    const currentIsFullBook = snapshot.teacher_view?.material_id === result.material.material_id;
    await useMaterial(result.material, currentIsFullBook ? snapshot.teacher_view : undefined, 11); textbook.showFocus(snapshot.confirmed_focus);
  }).catch(() => undefined);
  const transcriptPoll = window.setInterval(() => {
    void transcriptClient.list().then((value) => { transcripts = value.transcripts; transcription = value.transcription; transcriptMode.textContent = value.processing_mode === 'external' ? '外部' : '本机'; renderTranscripts(); }).catch(() => undefined);
  }, 2_000);
  lifecycle.signal.addEventListener('abort', () => window.clearInterval(transcriptPoll), { once: true });

  type PendingWorldStroke = { id: string; pointerId?: number; points: ClassroomWorldPoint[]; surface: Extract<ClassroomSurfaceRef, { kind: 'textbook_page' }>; tool: 'pen' | 'highlighter' | 'eraser'; erasedEventIds?: string[] };
  let active: PendingWorldStroke & { pointerId: number } | null = null;
  let failedStroke: PendingWorldStroke | null = null;
  const worldPointForEvent = (event: PointerEvent): ClassroomWorldPoint => {
    const rect = frame.getBoundingClientRect();
    const point = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: rect.width, height: rect.height }, teachingViewport.getView());
    return { x_world: point.x, y_world: point.y, t_ms: Date.now(), ...(event.pressure ? { pressure: event.pressure } : {}) };
  };
  const startWriting = (event: PointerEvent): void => {
    if (session?.classroom.status !== 'live' || !material || !teacherView || event.pointerType === 'touch') return;
    const surface = { kind: 'textbook_page' as const, material_id: material.material_id, page_index: teacherView.page_index };
    try { frame.setPointerCapture(event.pointerId); } catch { /* synthetic/browser compatibility */ }
    active = { id: createClassroomClientId('client'), pointerId: event.pointerId, points: [worldPointForEvent(event)], surface, tool: activeInkTool };
  };
  const moveWriting = (event: PointerEvent): void => {
    if (!active || event.pointerId !== active.pointerId) return;
    for (const sample of pointerSamples(event)) active.points.push(worldPointForEvent(sample));
    if (active.points.length > CLASSROOM_MAX_STROKE_POINTS * 2) active.points = active.points.filter((_, index) => index % 2 === 0);
    renderer.renderPreview({ schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroom.classroom_id, client_event_id: active.id, revision: active.points.length, geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, points_world: active.points, tool: active.tool, color: '#1a1a1a', expires_at_ms: Date.now() + 30_000, surface: active.surface });
    if (active.points.length % 4 === 0) void client.post(`/v1/classrooms/${classroom.classroom_id}/preview`, { schema_version: CLASSROOM_SCHEMA_VERSION, client_event_id: active.id, revision: active.points.length, geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, points_world: active.points.slice(-256), tool: active.tool, color: '#1a1a1a', expires_at_ms: Date.now() + 30_000, surface: active.surface }).catch(() => undefined);
  };
  const submitStroke = (stroke: PendingWorldStroke): void => {
    const bbox = worldStrokeBoundingBox(stroke.points);
    const startMs = stroke.points[0].t_ms; const endMs = stroke.points.at(-1)!.t_ms;
    submitNotice.hidden = true;
    const erasedEventIds = stroke.tool === 'eraser' ? stroke.erasedEventIds ?? renderer.activeEvents().filter((event) => sameSurface(event.surface, stroke.surface) && boxesIntersect(eventBBox(event, material), bbox)).map((event) => event.event.event_id) : [];
    if (stroke.tool === 'eraser' && erasedEventIds.length === 0) { renderer.clearPreview(stroke.id); return; }
    void client.post<{ board_event: ClassroomBoardEvent }>(`/v1/classrooms/${classroom.classroom_id}/events`, {
      schema_version: CLASSROOM_SCHEMA_VERSION, classroom_id: classroom.classroom_id, client_event_id: stroke.id,
      geometry_version: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: stroke.surface,
      event: { event_id: `ink_${stroke.id}`, trace_id: `trace_${stroke.id}`, session_id: classroom.classroom_id, surface_id: `${stroke.surface.material_id}:${stroke.surface.page_index}`, pen_id: 'teacher_pointer', event_type: stroke.tool === 'eraser' ? 'erase' : 'stroke', stroke_refs: [`stroke_${stroke.id}`], bbox_world: bbox, ts_start_ms: startMs, ts_end_ms: endMs, source: { device: 'web_demo', localization: 'manual_mock', confidence: 1 }, metadata: { mode: 'teach', tool: stroke.tool, color: '#1a1a1a', ...(erasedEventIds.length ? { erased_event_ids: erasedEventIds } : {}) } },
      stroke: { stroke_id: `stroke_${stroke.id}`, session_id: classroom.classroom_id, surface_id: `${stroke.surface.material_id}:${stroke.surface.page_index}`, pen_id: 'teacher_pointer', points_world: stroke.points, bbox_world: bbox, ts_start_ms: startMs, ts_end_ms: endMs },
    }).then(({ board_event }) => { failedStroke = null; recentEvents = mergeBoardEvent(recentEvents, board_event); if (stroke.tool !== 'eraser') lastStrokeBox = bbox; confirmFocus.disabled = !material || !lastStrokeBox; confirmFocus.textContent = '设为全班焦点'; renderer.renderEvent(board_event); syncInkTools(); if (stroke.tool === 'eraser') { window.clearTimeout(recognitionTimer); hideRecognitionRegion(); recognitionNotice.textContent = `已擦除 ${erasedEventIds.length} 笔，全班已同步。`; } else if (stroke.tool === 'pen') scheduleAutomaticRecognition(); else recognitionNotice.textContent = '高亮已同步。'; }).catch(() => {
      failedStroke = stroke; submitNotice.hidden = false;
    });
  };
  const eraseEvents = (events: ClassroomBoardEvent[], label: string): void => {
    if (!teacherView || !material || events.length === 0) return;
    const points = events.flatMap((event) => [eventBBox(event, material)]);
    const left = Math.min(...points.map((box) => box[0])); const top = Math.min(...points.map((box) => box[1]));
    const right = Math.max(...points.map((box) => box[0] + box[2])); const bottom = Math.max(...points.map((box) => box[1] + box[3]));
    const now = Date.now(); const id = createClassroomClientId('erase');
    submitStroke({ id, tool: 'eraser', erasedEventIds: events.map((event) => event.event.event_id), surface: { kind: 'textbook_page', material_id: material.material_id, page_index: teacherView.page_index }, points: [{ x_world: left, y_world: top, t_ms: now }, { x_world: right, y_world: bottom, t_ms: now + 1 }] });
    recognitionNotice.textContent = label;
  };
  undoTool.addEventListener('click', () => {
    const latest = renderer.activeEvents().filter((event) => sameSurface(event.surface, teacherView?.active_surface)).at(-1);
    if (latest) eraseEvents([latest], '正在撤销上一笔…');
  });
  const finish = (event: PointerEvent): void => {
    if (!active || event.pointerId !== active.pointerId) return;
    const stroke = active; stroke.points.push(worldPointForEvent(event)); active = null;
    if (stroke.points.length < 2) { renderer.clearPreview(stroke.id); return; }
    submitStroke(stroke);
  };
  const cancelWriting = (): void => {
    if (!active) return;
    const stroke = active; active = null;
    if (shouldCommitCancelledStroke(stroke.points.length)) submitStroke(stroke); else renderer.clearPreview(stroke.id);
  };
  const gestureController = new ClassroomGestureController(frame, { allowWriting: true, emit: (intent) => {
    if (intent.type === 'write_start') startWriting(intent.event);
    if (intent.type === 'write_move') moveWriting(intent.event);
    if (intent.type === 'write_end') finish(intent.event);
    if (intent.type === 'write_cancel') cancelWriting();
    if (intent.type === 'pan') {
      const view = teachingViewport.pan(intent.dx, intent.dy); renderer.setVisibleWorldRect(teachingViewport.visibleRect());
      publishGestureView(view, intent.final);
    }
    if (intent.type === 'zoom') {
      const view = teachingViewport.zoomAt({ x: intent.anchor_x, y: intent.anchor_y }, teachingViewport.getView().zoom_scale * intent.factor); renderer.setVisibleWorldRect(teachingViewport.visibleRect());
      publishGestureView(view, intent.final);
    }
  } });
  lifecycle.signal.addEventListener('abort', () => {
    window.clearTimeout(recognitionTimer); gestureController.destroy(); teachingViewport.destroy();
    // Page teardown cannot await network finalization, but local capture and WebRTC
    // must stop synchronously so the microphone indicator never survives navigation.
    audioAbort?.abort(); audioAbort = null; audioPeers?.stop(); audioPeers = null; audioCapture.stop();
    audioWorklet?.disconnect(); audioWorklet = null; void audioContext?.close().catch(() => undefined); audioContext = null;
    void textbook.destroy();
  }, { once: true });
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  frame.addEventListener('keydown', (event) => {
    if (!teacherView) return;
    if (event.key === '+' || event.key === '=') zoomIn.click();
    else if (event.key === '-') zoomOut.click();
    else if (event.key === '0' && material?.page_geometries?.[teacherView.page_index]) {
      void publishView(teacherView.page_index, teacherView.zoom_percent, undefined, 'fit-width');
    } else if (event.key.startsWith('Arrow')) {
      const dx = event.key === 'ArrowLeft' ? 48 : event.key === 'ArrowRight' ? -48 : 0; const dy = event.key === 'ArrowUp' ? 48 : event.key === 'ArrowDown' ? -48 : 0;
      const view = teachingViewport.pan(dx, dy); void publishView(teacherView.page_index, Math.round(view.zoom_scale * 100), view);
    } else return;
    event.preventDefault();
  });
  retrySubmit.addEventListener('click', () => { if (failedStroke) submitStroke(failedStroke); });
  start.addEventListener('click', () => {
    if (!session) return;
    const action = session.classroom.status === 'draft' ? 'start' : 'end';
    if (action === 'end' && !confirm('结束后将停止板书和新学生加入。确认结束课堂？')) return;
    start.disabled = true;
    void (action === 'end' ? stopAudio() : Promise.resolve()).then(() => client.post<{ classroom: CreatedClassroom['classroom'] }>(`/v1/classrooms/${classroom.classroom_id}/${action}`)).then((payload) => {
      if (!session) return; session.classroom = payload.classroom; save(session); renderClassroom();
    }).catch(() => { start.disabled = false; });
  });
  remove.addEventListener('click', () => {
    if (!confirm('永久删除这堂课、全部学生私有结果和教师输出？此操作不可撤销。')) return;
    remove.disabled = true;
    void client.delete(`/v1/classrooms/${classroom.classroom_id}`).then(() => {
      save(null); session = null; renderSetup('课堂已从这台 Mac 删除。');
    }).catch(() => { remove.disabled = false; });
  });
  forget.addEventListener('click', () => { if (confirm('仅清除此浏览器中的教师凭证？课堂数据仍保留在 Mac。')) { save(null); session = null; renderSetup(); } });
}

if (app) { if (session) renderClassroom(); else renderSetup(); }
