import '../core/polyfills';
import { CLASSROOM_WORLD_GEOMETRY_VERSION, type ClassroomBoardEvent, type ClassroomConfirmedFocus, type ClassroomMaterial, type ClassroomPreview, type ClassroomRecognitionRevision, type ClassroomSpatialRegion, type ClassroomTeacherView, type ClassroomTranscriptRevision, type ClassroomTranscriptionState } from 'ink-surface-sdk/runtime-schema';
import type { EducationAiJob, EducationAiJobKind } from '../../shared/classroom/education-workflows';
import { ClassroomBoardRenderer } from './board-renderer';
import { ClassroomClient, createClassroomClientId } from './classroom-client';
import { applyStudentBrowseIntent, applyTeacherProjection, applyTransientTeacherProjection, enterFreeBrowse, restoreLocalFollowState, returnToTeacher, type ClassroomFollowState } from './classroom-follow-state';
import { TextbookRenderer } from './textbook-renderer';
import { latestRecognitionProjection, recognitionTrustLabel } from './classroom-recognition-client';
import { ClassroomAudioApi, classroomAudioTransportAvailability, playClassroomAudio, StudentAudioPeer } from './classroom-audio-client';
import { classroomDeliveryLabel, classroomDeliveryMode, formatTranscriptTime, latestTranscriptProjection } from './classroom-transcript-client';
import { ClassroomTeachingViewport } from './classroom-teaching-viewport';
import { ClassroomGestureController } from './classroom-gesture-controller';
import { fitPageViewport, fitWorldRegionViewport, pageViewportKey, screenToWorld } from './classroom-world-model';
import './classroom.css';

interface StudentSession {
  classroom: { classroom_id: string; title?: string; status: 'live' | 'ended' };
  participant_credential: string;
  participant_id?: string;
}

interface ClassroomSnapshot {
  board_events: ClassroomBoardEvent[];
  snapshot_sequence: number;
  classroom_status: 'live' | 'ended';
  capabilities?: { textbook: boolean };
  materials?: ClassroomMaterial[];
  teacher_view?: ClassroomTeacherView;
  confirmed_focus?: ClassroomConfirmedFocus;
  recognitions?: ClassroomRecognitionRevision[];
  transcripts?: ClassroomTranscriptRevision[];
  transcription?: ClassroomTranscriptionState;
}

export interface SelectionBox { x: number; y: number; width: number; height: number }

export function selectionBox(
  start: { x_norm: number; y_norm: number },
  end: { x_norm: number; y_norm: number },
): SelectionBox {
  return {
    x: Math.min(start.x_norm, end.x_norm),
    y: Math.min(start.y_norm, end.y_norm),
    width: Math.abs(end.x_norm - start.x_norm),
    height: Math.abs(end.y_norm - start.y_norm),
  };
}

export function reconnectDelay(attempt: number): number {
  return Math.min(8_000, 500 * (2 ** Math.max(0, Math.min(attempt, 4))));
}

export function nextBoardSyncNotice(current: string, status: 'applied' | 'duplicate' | 'gap'): string {
  return status === 'applied' && current === '课堂还没有板书。' ? '板书已同步，可以解释当前步骤。' : current;
}

export function joinErrorMessage(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : String(cause || '');
  if (code === 'classroom_not_live') return '课堂尚未开始或已结束，请联系老师。';
  if (code === 'join_rate_limited') return '尝试次数过多，请稍后再试。';
  if (code.startsWith('nickname_')) return '请填写有效昵称。';
  return '无法加入课堂，请检查网络、课堂码和昵称。';
}

/** Keep internal evidence references available to the renderer without leaking them into student copy. */
export function studentFacingAiText(text: string): string {
  return text
    .replace(/(^|\n)\s*来源\s*[·:：][^\n]*/g, '$1')
    .replace(/\b(?:ink_client|ink)_[A-Za-z0-9_-]+\b/g, '老师的板书')
    .replace(/老师的板书(?:\s*[、,，和到至-]\s*老师的板书)+/g, '老师的板书')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

const STORAGE_KEY = 'inkloop.classroom.student.v1';
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export function bootstrapStudentClassroom(app: HTMLElement): void {
  if (window.location.hostname === 'appassets.androidplatform.net' || new URLSearchParams(window.location.search).get('eink') === '1') {
    document.body.classList.add('eink-bw');
  }

  let session: StudentSession | null = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as StudentSession | null; } catch { return null; }
  })();
  let client = new ClassroomClient({ token: session?.participant_credential });
  let lifecycleAbort: AbortController | null = null;

  const save = (value: StudentSession | null): void => {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  };

  const renderJoin = (message = ''): void => {
    lifecycleAbort?.abort();
    app.replaceChildren();
    const shell = element('main', 'empty-panel');
    const form = element('form', 'setup');
    form.append(element('h1', '', '加入课堂'), element('p', '', '输入老师展示的课堂码。AI 解释和课后练习只对这个浏览器可见。'));
    if (session) {
      const resume = element('section', 'resume-classroom');
      const resumeCopy = element('div', 'resume-classroom-copy');
      resumeCopy.append(
        element('span', 'resume-eyebrow', session.classroom.status === 'ended' ? '上次课堂 · 已结束' : '检测到上次课堂'),
        element('strong', '', session.classroom.title || '未命名课堂'),
        element('small', '', '不会自动进入，避免把新课堂误认为上一次课堂。'),
      );
      const resumeButton = element('button', 'btn', session.classroom.status === 'ended' ? '查看上次课堂' : '继续上次课堂'); resumeButton.type = 'button';
      resumeButton.addEventListener('click', () => renderViewer());
      resume.append(resumeCopy, resumeButton); form.append(resume);
    }
    const codeField = element('div', 'field');
    const codeLabel = element('label', '', '课堂码'); codeLabel.htmlFor = 'class-code';
    const code = element('input'); code.id = 'class-code'; code.name = 'class-code'; code.autocomplete = 'off'; code.inputMode = 'text'; code.maxLength = 6; code.required = true;
    code.setAttribute('aria-describedby', 'join-error');
    codeField.append(codeLabel, code);
    const nameField = element('div', 'field');
    const nameLabel = element('label', '', '昵称'); nameLabel.htmlFor = 'nickname';
    const nickname = element('input'); nickname.id = 'nickname'; nickname.name = 'nickname'; nickname.autocomplete = 'off'; nickname.maxLength = 48; nickname.required = true;
    nickname.setAttribute('aria-describedby', 'join-error');
    nameField.append(nameLabel, nickname);
    const error = element('div', 'field-error', message); error.id = 'join-error'; error.setAttribute('role', 'alert');
    const submit = element('button', 'btn primary', '进入课堂'); submit.type = 'submit';
    form.append(codeField, nameField, error, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      void new ClassroomClient().post<StudentSession>('/v1/classrooms/join', {
        class_code: code.value.trim().toUpperCase(),
        nickname: nickname.value.trim(),
      }).then((joined) => {
        session = joined;
        client = new ClassroomClient({ token: joined.participant_credential });
        save(joined);
        renderViewer();
      }).catch((cause) => {
        error.textContent = joinErrorMessage(cause);
        submit.disabled = false;
      });
    });
    shell.append(form); app.append(shell); code.focus();
  };

  const renderViewer = (): void => {
    if (!session) { renderJoin(); return; }
    lifecycleAbort?.abort();
    const lifecycle = new AbortController();
    lifecycleAbort = lifecycle;
    app.replaceChildren();

    const shell = element('main', 'classroom-shell');
    const topbar = element('header', 'student-player-header');
    const brand = element('div', 'classroom-brand');
    brand.append(element('strong', '', 'InkLoop 学生课堂'), element('span', '', session.classroom.title || '课堂'));
    const state = element('div', 'classroom-status');
    const dot = element('span', 'status-dot'); dot.dataset.state = 'reconnecting';
    const label = element('span', 'status-label', '正在连接'); label.setAttribute('aria-live', 'polite');
    const switchClassroom = element('button', 'btn switch-classroom', '切换课堂'); switchClassroom.type = 'button';
    state.append(dot, label);

    const layout = element('section', 'student-layout');
    const boardArea = element('section', 'student-board-area');
    const contextStatus = element('span', 'context-status', session.classroom.status === 'ended' ? '已结束' : '直播中');
    const followStatus = element('span', 'follow-status', '跟随老师');
    const followMode = element('button', 'live-mode on', '跟随老师'); followMode.type = 'button'; followMode.setAttribute('aria-pressed', 'true');
    const browseMode = element('button', 'live-mode', '自由浏览'); browseMode.type = 'button'; browseMode.setAttribute('aria-pressed', 'false');
    const modeSwitch = element('div', 'live-mode-switch'); modeSwitch.setAttribute('aria-label', '页面跟随模式'); modeSwitch.append(followMode, browseMode);
    const audioStatus = element('span', 'audio-status', '尚未开启'); audioStatus.setAttribute('aria-live', 'polite');
    const enableAudio = element('button', 'btn', '开启课堂声音'); enableAudio.type = 'button'; enableAudio.disabled = session.classroom.status === 'ended';
    const audioElement = element('audio'); audioElement.autoplay = true; audioElement.hidden = true;
    const transcriptPanel = element('section', 'classroom-transcript-panel student-transcript-panel');
    const transcriptHead = element('div', 'transcript-head');
    const transcriptHeadActions = element('div', 'transcript-head-actions');
    const transcriptMode = element('span', 'transcript-mode', '仅课本与板书');
    const clearTranscripts = element('button', 'btn transcript-clear', '清空当前设备'); clearTranscripts.type = 'button';
    transcriptHeadActions.append(transcriptMode, clearTranscripts); transcriptHead.append(element('strong', '', '实时字幕 · 中文 + English'), transcriptHeadActions);
    const transcriptList = element('div', 'transcript-list'); transcriptPanel.append(transcriptHead, transcriptList);
    const audioTransport = classroomAudioTransportAvailability({ isSecureContext: globalThis.isSecureContext, protocol: location.protocol });
    if (!audioTransport.available) { enableAudio.disabled = true; audioStatus.textContent = '当前是 HTTP 开发入口 · 音频需受信任 HTTPS'; audioStatus.classList.add('degraded'); }
    const textbookControls = element('nav', 'student-textbook-controls'); textbookControls.setAttribute('aria-label', '课本浏览');
    const previousPage = element('button', 'btn', '上一页'); const nextPage = element('button', 'btn', '下一页'); previousPage.type = nextPage.type = 'button';
    const pageLabel = element('span', 'page-label', '白板');
    const zoomOut = element('button', 'btn', '－'); const zoomIn = element('button', 'btn', '＋'); zoomOut.type = zoomIn.type = 'button';
    const returnButton = element('button', 'btn primary return-teacher', '回到老师页面'); returnButton.type = 'button'; returnButton.hidden = true;
    textbookControls.append(previousPage, pageLabel, nextPage, zoomOut, zoomIn, returnButton);
    const playerTools = element('div', 'student-player-tools');
    playerTools.append(element('span', 'live-indicator', ''), contextStatus, followStatus, modeSwitch, audioStatus, enableAudio, switchClassroom, state, audioElement);
    topbar.append(brand, playerTools);
    const stage = element('div', 'board-stage');
    const frame = element('div', 'board-frame textbook-frame');
    const worldLayer = element('div', 'teaching-world');
    const pageLayer = element('div', 'textbook-page-layer teaching-page');
    const canvas = element('canvas', 'textbook-canvas'); canvas.hidden = true;
    const focusOverlay = element('div', 'textbook-focus'); focusOverlay.hidden = true;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('classroom-board');
    const selection = element('div', 'board-selection'); selection.hidden = true;
    pageLayer.append(canvas, focusOverlay); worldLayer.append(pageLayer, svg, selection); frame.append(worldLayer);
    const viewportStatus = element('div', 'teaching-viewport-status'); viewportStatus.setAttribute('role', 'status');
    frame.append(viewportStatus, textbookControls); stage.append(frame); boardArea.append(topbar, stage);

    const sidebar = element('aside', 'student-sidebar');
    const notesPanel = element('section', 'student-sidebar-panel student-notes-panel');
    const notesHeading = element('div', 'sidebar-panel-heading');
    const openAi = element('button', 'btn sidebar-ai-toggle', 'AI 助手'); openAi.type = 'button';
    notesHeading.append(element('h2', '', '我的课堂笔记'), element('span', 'notes-save-status', '自动保存'), openAi);
    const notesInput = element('textarea', 'student-notes'); notesInput.placeholder = '边听边记……\n\n可以记录公式、疑问和老师强调的重点。'; notesInput.setAttribute('aria-label', '我的课堂笔记');
    const notesContext = element('div', 'notes-context', '跟随老师时，当前页码会显示在这里。'); notesPanel.append(notesHeading, notesInput, notesContext);
    const ai = element('section', 'student-ai-drawer'); ai.hidden = true;
    const aiDrawerHead = element('div', 'sidebar-panel-heading'); const closeAi = element('button', 'btn', '收起'); closeAi.type = 'button'; aiDrawerHead.append(element('h2', '', 'AI 学习助手'), closeAi); ai.append(aiDrawerHead);
    ai.append(element('h2', '', '我的 AI 学习助手'), element('p', '', '解释、总结和练习只保存在你的个人空间。'));
    const notice = element('div', 'notice', '板书同步后即可解释当前步骤。'); notice.setAttribute('aria-live', 'polite'); ai.append(notice);
    const recognitionStrip = element('section', 'student-recognition'); recognitionStrip.setAttribute('aria-live', 'polite');
    recognitionStrip.append(element('strong', '', '老师板书识别'), element('p', '', '暂无公式识别结果'));
    ai.append(recognitionStrip);
    const select = element('button', 'ai-action'); select.type = 'button'; select.disabled = true;
    select.append(element('b', '', '只解释我圈出的内容'), element('span', '', '点一下后，在左侧板书上拖出一个框'));
    const live = element('button', 'ai-action'); live.type = 'button'; live.disabled = true;
    live.append(element('b', '', '解释这一步'), element('span', '', '默认解释老师最近写的一组板书'));
    const missed = element('button', 'ai-action'); missed.type = 'button'; missed.disabled = true;
    missed.append(element('b', '', '补一下刚才的内容'), element('span', '', '按顺序补记最近最多 60 秒'));
    const summary = element('button', 'ai-action'); summary.type = 'button'; summary.disabled = true;
    summary.append(element('b', '', '生成完整课堂总结'), element('span', '', '老师结束课堂后可生成'));
    const practice = element('button', 'ai-action'); practice.type = 'button'; practice.disabled = true;
    practice.append(element('b', '', '生成课后练习'), element('span', '', '老师结束课堂后，按整堂课内容出题'));
    const scope = element('div', 'ai-scope');
    scope.append(element('span', 'ai-scope-label', '本次范围'), element('strong', 'ai-scope-value', '老师最近写的一组板书'));
    const history = element('section', 'ai-history'); history.setAttribute('aria-live', 'polite');
    const foot = element('div', 'student-foot');
    const clear = element('button', 'btn', '清除此设备数据'); clear.type = 'button'; foot.append(clear);
    ai.append(scope, select, live, missed, summary, practice, history, foot);
    transcriptPanel.classList.add('student-sidebar-panel');
    sidebar.append(notesPanel, transcriptPanel, ai); layout.append(boardArea, sidebar); shell.append(layout); app.append(shell);

    const renderer = new ClassroomBoardRenderer(svg);
    const textbook = new TextbookRenderer(canvas, focusOverlay);
    const teachingViewport = new ClassroomTeachingViewport({ viewport: frame, world: worldLayer, page: pageLayer, ink: svg, focus: focusOverlay, selection, status: viewportStatus }, () => renderer.setVisibleWorldRect(teachingViewport.visibleRect()));
    const id = session.classroom.classroom_id;
    const audioApi = new ClassroomAudioApi(client, id);
    let audioPeer: StudentAudioPeer | null = null;
    let audioPlaying = false;
    let transcripts: ClassroomTranscriptRevision[] = [];
    let transcription: ClassroomTranscriptionState | null = null;
    const participantNamespace = session.participant_id ?? session.participant_credential.slice(-12);
    const notesStorageKey = `inkloop.classroom.notes.v1.${id}.${participantNamespace}`;
    notesInput.value = localStorage.getItem(notesStorageKey) || '';
    let notesSaveTimer = 0;
    notesInput.addEventListener('input', () => {
      window.clearTimeout(notesSaveTimer); notesHeading.querySelector('.notes-save-status')!.textContent = '保存中…';
      notesSaveTimer = window.setTimeout(() => { localStorage.setItem(notesStorageKey, notesInput.value); notesHeading.querySelector('.notes-save-status')!.textContent = '已保存到当前设备'; }, 300);
    });
    openAi.addEventListener('click', () => { ai.hidden = false; }); closeAi.addEventListener('click', () => { ai.hidden = true; });
    const transcriptCutoffKey = `inkloop.classroom.transcript-cutoff.v1.${id}.${participantNamespace}`;
    let transcriptCutoffAt = Number(localStorage.getItem(transcriptCutoffKey) || '-1');
    if (!Number.isFinite(transcriptCutoffAt)) transcriptCutoffAt = -1;
    const visibleTranscripts = (): ClassroomTranscriptRevision[] => transcripts.filter((item) => Date.parse(item.created_at) > transcriptCutoffAt);
    let latestEvidenceTimeMs = 0;
    const renderTranscripts = (): void => {
      transcriptList.replaceChildren();
      transcriptHead.querySelector('.transcript-mode')!.textContent = classroomDeliveryLabel(classroomDeliveryMode({ audioPlaying, transcription }));
      const visible = latestTranscriptProjection(visibleTranscripts()).slice(-6);
      if (!visible.length) { transcriptList.append(element('p', 'transcript-empty', transcription?.state === 'delayed' ? '字幕暂时延迟，课本和板书继续。' : '等待老师讲解…')); return; }
      for (const item of visible) {
        const row = element('article', `transcript-row ${item.status === 'provisional' ? 'provisional' : ''} ${item.status === 'corrected' ? 'stabilized' : ''} ${item.confidence < 0.6 ? 'low-confidence' : ''}`);
        row.append(element('time', '', formatTranscriptTime(item.relative_start_ms)), element('span', 'transcript-text', item.text));
        transcriptList.append(row);
      }
      transcriptList.scrollTop = transcriptList.scrollHeight;
    };
    renderTranscripts();
    clearTranscripts.addEventListener('click', () => {
      transcriptCutoffAt = Date.now();
      localStorage.setItem(transcriptCutoffKey, String(transcriptCutoffAt)); renderTranscripts();
      clearTranscripts.textContent = '本机已清空'; window.setTimeout(() => { clearTranscripts.textContent = '清空当前设备'; }, 1_500);
    });
    switchClassroom.addEventListener('click', () => {
      lifecycle.abort(); audioConnectionAbort?.abort(); audioPeer?.stop(); renderJoin();
    });
    let audioConnectionAbort: AbortController | null = null;
    let audioGeneration = Number.parseInt(sessionStorage.getItem(`inkloop.classroom.audio-generation.${id}`) || '0', 10) + 1;
    enableAudio.addEventListener('click', () => {
      enableAudio.disabled = true; audioStatus.textContent = '正在连接老师声音…';
      audioConnectionAbort?.abort(); audioPeer?.stop(); audioConnectionAbort = new AbortController();
      audioPeer = new StudentAudioPeer(audioApi, (stream) => {
        void playClassroomAudio(audioElement, stream).then((state) => {
          audioPlaying = state === 'playing'; audioStatus.textContent = state === 'playing' ? '老师声音播放中' : '浏览器阻止播放 · 请再次点击开启'; renderTranscripts();
          audioStatus.classList.toggle('degraded', state === 'autoplay_blocked'); enableAudio.textContent = '重新连接声音'; enableAudio.disabled = false;
        });
      }, audioGeneration);
      sessionStorage.setItem(`inkloop.classroom.audio-generation.${id}`, String(audioGeneration)); audioGeneration += 1;
      void audioPeer.start().then(() => audioPeer?.run(audioConnectionAbort!.signal)).catch((cause) => { audioPlaying = false; audioStatus.textContent = `声音连接失败 · ${cause instanceof Error ? cause.message : 'unknown'}`; audioStatus.classList.add('degraded'); enableAudio.disabled = false; renderTranscripts(); });
    });
    const followStorageKey = `inkloop.classroom.follow.v2.${id}.${participantNamespace}`;
    let savedFollowValue: unknown = null;
    try { savedFollowValue = JSON.parse(localStorage.getItem(followStorageKey) || 'null') as unknown; } catch { /* invalid local state falls back after snapshot */ }
    let follow: ClassroomFollowState = { mode: 'follow_teacher' }; let restoredLocalFollow = false;
    const saveFollow = (): void => localStorage.setItem(followStorageKey, JSON.stringify({ schema_version: 2, mode: follow.mode, visible_view: follow.mode === 'free_browse' ? follow.visible_view : undefined }));
    let materials: ClassroomMaterial[] = [];
    let loadedMaterialId = '';
    let renderFollowRevision = 0;
    let recognitions: ClassroomRecognitionRevision[] = [];
    const locateSource = async (eventId: string): Promise<void> => {
      const event = renderer.sourceEvent(eventId); const bbox = renderer.sourceWorldBBox(eventId); const current = follow.visible_view ?? follow.teacher_view;
      if (!event || !bbox || !current) return;
      const surface = event.surface; const pageIndex = surface?.kind === 'textbook_page' ? surface.page_index : surface?.kind === 'scratch' ? surface.linked_page_index : current.page_index;
      if (pageIndex === undefined) return;
      const camera = fitWorldRegionViewport(bbox, teachingViewport.size()); const key = pageViewportKey(current.material_id, pageIndex);
      follow = enterFreeBrowse(follow, { ...current, page_index: pageIndex, active_surface: { kind: 'textbook_page', material_id: current.material_id, page_index: pageIndex }, viewport: camera, zoom_percent: Math.round(camera.zoom_scale * 100), page_viewports: { ...(current.page_viewports ?? {}), [key]: camera } });
      saveFollow(); await renderFollow(); requestAnimationFrame(() => renderer.focusSource(eventId)); frame.focus();
    };
    const renderRecognitions = (): void => {
      recognitionStrip.replaceChildren(); recognitionStrip.append(element('strong', '', '老师板书识别'));
      const visible = latestRecognitionProjection(recognitions).filter((item) => item.status !== 'dismissed').slice(0, 3);
      if (!visible.length) { recognitionStrip.append(element('p', '', '暂无公式识别结果')); return; }
      for (const recognition of visible) {
        const item = element('div', `student-recognition-item trust-${recognition.status}`);
        item.append(element('span', 'recognition-state', recognitionTrustLabel(recognition)));
        if (recognition.status === 'confirmed' || recognition.status === 'corrected') item.append(element('b', '', recognition.text));
        else if (recognition.status === 'pending') item.append(element('b', '', '该公式待老师确认'));
        else item.append(element('b', '', '本次公式识别不可用'));
        item.addEventListener('click', () => { void locateSource(recognition.event_ids[0]); });
        recognitionStrip.append(item);
      }
    };
    const materialForView = (view?: ClassroomTeacherView): ClassroomMaterial | undefined => materials.find((item) => item.material_id === view?.material_id);
    const updateFollowUi = (): void => {
      const view = follow.visible_view; const material = materialForView(view);
      followStatus.textContent = follow.mode === 'follow_teacher' ? '跟随老师' : follow.pending_teacher_update ? '老师已移动 · 你在自由浏览' : '自由浏览';
      followMode.classList.toggle('on', follow.mode === 'follow_teacher'); followMode.setAttribute('aria-pressed', String(follow.mode === 'follow_teacher'));
      browseMode.classList.toggle('on', follow.mode === 'free_browse'); browseMode.setAttribute('aria-pressed', String(follow.mode === 'free_browse'));
      returnButton.hidden = follow.mode === 'follow_teacher';
      if (follow.mode === 'free_browse' && follow.teacher_view) returnButton.textContent = `回到老师 · 第 ${follow.teacher_view.page_index + 1} 页`;
      pageLabel.textContent = view && material ? `${view.page_index + 1} / ${material.page_count} · ${follow.mode === 'follow_teacher' ? '适应窗口' : `${view.zoom_percent}%`}` : '白板';
      notesContext.textContent = view && material ? `${follow.mode === 'follow_teacher' ? '正在跟随老师' : '正在自由浏览'} · 第 ${view.page_index + 1} / ${material.page_count} 页` : '老师暂未打开课本页面';
      previousPage.disabled = follow.mode !== 'free_browse' || !view || view.page_index <= 0;
      nextPage.disabled = follow.mode !== 'free_browse' || !view || !material || view.page_index >= material.page_count - 1;
      zoomOut.disabled = zoomIn.disabled = follow.mode !== 'free_browse' || !view;
    };
    const renderFollow = async (): Promise<void> => {
      const renderRevision = ++renderFollowRevision;
      const view = follow.visible_view; const material = materialForView(view);
      if (!view || !material) { canvas.hidden = true; frame.classList.remove('has-textbook'); renderer.setSurface({ kind: 'teacher_board' }); updateFollowUi(); return; }
      const geometry = material.page_geometries?.[view.page_index]; teachingViewport.setPageGeometry(geometry);
      // Follow the teacher's page and focus, but fit it to the student's own
      // player dimensions instead of reusing the teacher device's pixels.
      const camera = follow.mode === 'follow_teacher' && geometry
        ? fitPageViewport(geometry.width_world, geometry.height_world, teachingViewport.size(), 18)
        : view.viewport ?? (geometry ? fitPageViewport(geometry.width_world, geometry.height_world, teachingViewport.size(), 18) : { center_x_world: 0, center_y_world: 0, zoom_scale: view.zoom_percent / 100 });
      teachingViewport.setView(camera); renderer.setMaterials(materials); renderer.setVisibleWorldRect(teachingViewport.visibleRect());
      frame.classList.remove('scratch-surface'); renderer.setSurface({ kind: 'textbook_page', material_id: material.material_id, page_index: view.page_index });
      try {
        if (loadedMaterialId !== material.material_id) {
          const bytes = await client.pdf(`/v1/classrooms/${id}/materials/${material.material_id}`, lifecycle.signal);
          if (renderRevision !== renderFollowRevision || lifecycle.signal.aborted) return;
          await textbook.load(bytes);
          if (renderRevision !== renderFollowRevision || lifecycle.signal.aborted) return;
          loadedMaterialId = material.material_id;
        }
      } catch {
        if (renderRevision !== renderFollowRevision || lifecycle.signal.aborted) return;
        notice.textContent = '课本暂时加载失败 · 点阵和板书继续，正在等待重试。';
        const hasMatchingTextbook = loadedMaterialId === material.material_id;
        canvas.hidden = !hasMatchingTextbook; frame.classList.toggle('has-textbook', hasMatchingTextbook);
        updateFollowUi(); return;
      }
      canvas.hidden = false; frame.classList.add('has-textbook');
      try { await textbook.render({ ...view, viewport: camera }); } catch {
        if (renderRevision === renderFollowRevision && !lifecycle.signal.aborted) notice.textContent = '课本页面渲染失败 · 点阵和板书继续，切页或重连后会重试。';
      }
      if (renderRevision !== renderFollowRevision || lifecycle.signal.aborted) return;
      textbook.showFocus(follow.visible_focus); updateFollowUi();
    };
    const browse = (pageDelta: number, zoomDelta: number): void => {
      const current = follow.visible_view ?? follow.teacher_view; const material = materialForView(current); if (!current || !material) return;
      const page = Math.max(0, Math.min(material.page_count - 1, current.page_index + pageDelta));
      const geometry = material.page_geometries?.[page]; const key = pageViewportKey(current.material_id, page);
      const camera = current.page_viewports?.[key] ?? (geometry ? fitPageViewport(geometry.width_world, geometry.height_world, teachingViewport.size()) : teachingViewport.getView());
      const zoom = Math.max(0.5, Math.min(4, camera.zoom_scale + zoomDelta / 100));
      follow = applyStudentBrowseIntent(follow, { ...current, page_index: page, zoom_percent: Math.round(zoom * 100), viewport: { ...camera, zoom_scale: zoom }, page_viewports: { ...(current.page_viewports ?? {}), [key]: { ...camera, zoom_scale: zoom } }, active_surface: { kind: 'textbook_page', material_id: current.material_id, page_index: page } });
      saveFollow(); void renderFollow();
    };
    previousPage.addEventListener('click', () => browse(-1, 0)); nextPage.addEventListener('click', () => browse(1, 0)); zoomOut.addEventListener('click', () => browse(0, -10)); zoomIn.addEventListener('click', () => browse(0, 10));
    const returnToTeacherView = (): void => { follow = returnToTeacher(follow); saveFollow(); void renderFollow(); };
    followMode.addEventListener('click', returnToTeacherView); returnButton.addEventListener('click', returnToTeacherView);
    browseMode.addEventListener('click', () => { const current = follow.visible_view ?? follow.teacher_view; if (!current) return; follow = enterFreeBrowse(follow, current); saveFollow(); updateFollowUi(); });
    let selectionMode = false;
    let selectionStart: { x_world: number; y_world: number } | null = null;
    let selectedBox: SelectionBox | null = null;
    let selectedRegion: ClassroomSpatialRegion | null = null;
    const scopeValue = scope.querySelector<HTMLElement>('.ai-scope-value')!;
    const updateAiScope = (): void => {
      scopeValue.textContent = selectedRegion ? '你在左侧圈出的板书' : '老师最近写的一组板书（最多 8 笔）';
      live.querySelector('span')!.textContent = selectedRegion ? '只解释你圈出的板书，不包含其他区域' : '解释老师最近写的一组板书';
    };

    const friendlyAiError = (cause: unknown): string => {
      const code = cause instanceof Error ? cause.message : '';
      if (code === 'insufficient_evidence') return '这里还没有足够的板书内容，请等老师写完或重新圈选。';
      if (code === 'untrusted_formula_evidence') return '这个公式还没有经过老师确认，暂时不能用于总结或出题。';
      if (code === 'classroom_not_ended') return '老师还没有结束课堂。下课后这里会立即开放。';
      if (code === 'classroom_not_live') return '课堂已经结束，请使用课堂总结或课后练习。';
      return '生成失败，请稍后再试。';
    };

    const renderJobs = (jobs: EducationAiJob[]): void => {
      history.replaceChildren();
      for (const job of jobs) {
        if (job.result?.review_status === 'dismissed') continue;
        const article = element('article', 'ai-result');
        const head = element('div', 'ai-result-head');
        const kindLabel = job.kind === 'live_explanation' ? '当前步骤解释' : job.kind === 'class_summary' ? '完整课堂总结' : '课后练习';
        head.append(element('strong', '', job.result?.title || kindLabel), element('span', 'execution-badge', job.stale ? '内容已更新' : job.result ? (job.result.execution_mode === 'real' ? '已生成' : '基础说明') : job.status === 'failed' ? '生成失败' : job.status === 'running' ? '正在生成' : '排队中'));
        article.append(head);
        if (job.stale) article.append(element('p', 'stale-notice', '老师已更正相关公式，这份结果保留作历史记录，请重新生成。'));
        if (!job.result) {
          article.append(element('p', '', job.status === 'failed' ? '上次生成中断，可以使用同一任务重试。' : '任务正在后台处理，完成后会自动显示。'));
          if (job.status === 'failed') {
            const retry = element('button', 'btn', '重试任务'); retry.type = 'button';
            retry.addEventListener('click', () => { retry.disabled = true; void client.post(`/v1/classrooms/${id}/education-jobs/${job.job_id}/retry`).then(() => loadJobs()).catch(() => { retry.disabled = false; }); });
            article.append(retry);
          }
          history.append(article);
          continue;
        }
        if (job.result.review_status === 'edited' && job.result.user_edit) article.append(element('p', 'user-edit', job.result.user_edit));
        for (const section of job.result.sections) {
          const content = studentFacingAiText(section.content);
          if (!content) continue;
          const block = element('div', 'ai-result-section');
          block.append(element('p', '', content));
          article.append(block);
        }
        const review = element('div', 'ai-result-actions');
        const edit = element('button', 'btn', '编辑理解'); edit.type = 'button';
        const dismiss = element('button', 'btn', '移出历史'); dismiss.type = 'button';
        const retry = job.result.execution_mode === 'deterministic_fallback' || job.stale ? element('button', 'btn', job.stale ? '按新证据重新生成' : '重试真实 AI') : null;
        if (retry) {
          retry.type = 'button';
          retry.addEventListener('click', () => {
            retry.disabled = true; notice.textContent = '正在重试真实 AI…';
            void client.post<{ job: EducationAiJob }>(`/v1/classrooms/${id}/education-jobs/${job.job_id}/retry`).then(({ job: next }) => {
              notice.textContent = next.result?.execution_mode === 'real' ? '真实 AI 重试成功。' : '网关仍不可用，已保留原降级结果。';
              void loadJobs();
            }).catch(() => { notice.textContent = '重试失败，请稍后再试。'; retry.disabled = false; });
          });
        }
        edit.addEventListener('click', () => {
          const value = prompt('写下你的理解（原始 AI 结果会保留）：', job.result?.user_edit || '');
          if (!value?.trim()) return;
          void client.post<{ job: EducationAiJob }>(`/v1/classrooms/${id}/education-jobs/${job.job_id}/review`, { status: 'edited', user_edit: value }).then(() => loadJobs());
        });
        dismiss.addEventListener('click', () => void client.post(`/v1/classrooms/${id}/education-jobs/${job.job_id}/review`, { status: 'dismissed' }).then(() => loadJobs()));
        review.append(...(retry ? [retry, edit, dismiss] : [edit, dismiss])); article.append(review); history.append(article);
      }
    };

    const loadJobs = async (): Promise<void> => {
      try { renderJobs((await client.get<{ jobs: EducationAiJob[] }>(`/v1/classrooms/${id}/education-jobs`)).jobs); } catch { /* reconnect owns credential failures */ }
    };

    const requestJob = (kind: EducationAiJobKind, button: HTMLButtonElement, mode: 'default' | 'missed' = 'default'): void => {
      button.disabled = true; notice.textContent = kind === 'live_explanation' ? '正在解释当前板书…' : kind === 'class_summary' ? '正在整理完整课堂总结…' : '正在生成课后练习…';
      const poll = window.setInterval(() => void loadJobs(), 500);
      void client.post<{ job: EducationAiJob }>(`/v1/classrooms/${id}/education-jobs`, {
        kind, client_request_id: createClassroomClientId('request'),
        ...(kind === 'live_explanation' && selectedRegion ? { selection_region: selectedRegion } : {}),
        ...(kind === 'live_explanation' && selectedRegion ? { evidence_intent: 'selected_region' } : mode === 'missed' ? { evidence_intent: 'missed_segment', trigger_time_ms: latestEvidenceTimeMs } : {}),
      }).then(({ job }) => {
        notice.textContent = job.result?.execution_mode === 'real' ? '真实 AI 结果已生成。' : '网关暂不可用，已生成明确标记的确定性降级结果。';
        const eventIds = job.evidence.source_refs.filter((ref) => ref.type === 'ink_event').map((ref) => ref.event_id);
        if (eventIds.length) renderer.showSourceAnchor(eventIds);
        selectedBox = null; selectedRegion = null; selection.hidden = true; updateAiScope(); void loadJobs(); updateActions(session?.classroom.status ?? 'live');
      }).catch((cause) => {
        notice.textContent = friendlyAiError(cause);
        updateActions(session?.classroom.status ?? 'live');
      }).finally(() => window.clearInterval(poll));
    };
    live.addEventListener('click', () => requestJob('live_explanation', live));
    missed.addEventListener('click', () => requestJob('live_explanation', missed, 'missed'));
    void loadJobs();

    const updateActions = (status: 'live' | 'ended'): void => {
      const hasBoard = renderer.model.sequence > 0;
      select.disabled = !hasBoard || status !== 'live';
      live.disabled = !hasBoard || status !== 'live';
      missed.disabled = !hasBoard || status !== 'live';
      summary.disabled = !hasBoard;
      practice.disabled = !hasBoard;
      summary.dataset.locked = String(status !== 'ended'); practice.dataset.locked = String(status !== 'ended');
      summary.querySelector('span')!.textContent = status === 'ended' ? '整理整堂课的知识点和步骤' : '老师还未结束课堂，点击可查看开放条件';
      practice.querySelector('span')!.textContent = status === 'ended' ? '根据整堂课的板书、公式和讲解生成练习' : '老师还未结束课堂，点击可查看开放条件';
      contextStatus.textContent = status === 'ended' ? '已结束' : '直播中';
      frame.dataset.selecting = String(selectionMode && status === 'live');
    };

    const guardPostClass = (button: HTMLButtonElement, run: () => void): void => {
      if (button.dataset.locked === 'true') { notice.textContent = '老师还没有结束课堂。教师端点击“结束课堂”后，就可以在这里生成。'; return; }
      run();
    };
    summary.addEventListener('click', () => guardPostClass(summary, () => requestJob('class_summary', summary)));
    practice.addEventListener('click', () => guardPostClass(practice, () => requestJob('practice', practice)));

    select.addEventListener('click', () => {
      selectionMode = !selectionMode;
      select.setAttribute('aria-pressed', String(selectionMode));
      select.querySelector('b')!.textContent = selectionMode ? '现在去左侧拖动框选' : selectedBox ? '重新圈选内容' : '只解释我圈出的内容';
      frame.dataset.selecting = String(selectionMode);
      if (selectionMode) notice.textContent = '请在板书上拖动，框选需要解释的范围。';
    });
    frame.addEventListener('pointerdown', (event) => {
      if (!selectionMode || session?.classroom.status !== 'live') return;
      frame.setPointerCapture(event.pointerId);
      const rect = frame.getBoundingClientRect(); const world = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: rect.width, height: rect.height }, teachingViewport.getView());
      selectionStart = { x_world: world.x, y_world: world.y };
      selection.hidden = false;
    });
    frame.addEventListener('pointermove', (event) => {
      if (!selectionStart || !selectionMode) return;
      const rect = frame.getBoundingClientRect(); const world = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: rect.width, height: rect.height }, teachingViewport.getView());
      const left = Math.min(selectionStart.x_world, world.x); const top = Math.min(selectionStart.y_world, world.y);
      Object.assign(selection.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(world.x - selectionStart.x_world)}px`, height: `${Math.abs(world.y - selectionStart.y_world)}px` });
    });
    const finishSelection = (event: PointerEvent): void => {
      if (!selectionStart || !selectionMode) return;
      const rect = frame.getBoundingClientRect(); const world = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, { width: rect.width, height: rect.height }, teachingViewport.getView());
      const width = Math.abs(world.x - selectionStart.x_world); const height = Math.abs(world.y - selectionStart.y_world);
      selectedBox = { x: Math.min(selectionStart.x_world, world.x), y: Math.min(selectionStart.y_world, world.y), width, height };
      const view = follow.visible_view; selectedRegion = view ? { coordinate_space: CLASSROOM_WORLD_GEOMETRY_VERSION, surface: { kind: 'textbook_page', material_id: view.material_id, page_index: view.page_index }, bbox_world: [selectedBox.x, selectedBox.y, selectedBox.width, selectedBox.height] } : null;
      selectionStart = null;
      if (selectedBox.width * teachingViewport.getView().zoom_scale < 8 || selectedBox.height * teachingViewport.getView().zoom_scale < 8) { selectedBox = null; selectedRegion = null; selection.hidden = true; notice.textContent = '框选范围太小，请重新拖动。'; return; }
      selectionMode = false;
      select.setAttribute('aria-pressed', 'false');
      select.querySelector('b')!.textContent = '重新框选范围';
      frame.dataset.selecting = 'false';
      updateAiScope(); notice.textContent = '范围已选好。点击“解释这一步”，AI 只会解释框内内容。';
    };
    frame.addEventListener('pointerup', finishSelection);
    frame.addEventListener('pointercancel', () => { selectionStart = null; });
    const studentGestures = new ClassroomGestureController(frame, { allowWriting: false, emit: (intent) => {
      if (selectionMode || follow.mode !== 'free_browse') return;
      const current = follow.visible_view ?? follow.teacher_view; if (!current) return;
      let camera = teachingViewport.getView();
      if (intent.type === 'pan') camera = teachingViewport.pan(intent.dx, intent.dy);
      else if (intent.type === 'zoom') camera = teachingViewport.zoomAt({ x: intent.anchor_x, y: intent.anchor_y }, camera.zoom_scale * intent.factor);
      else return;
      const key = pageViewportKey(current.material_id, current.page_index);
      follow = applyStudentBrowseIntent(follow, { ...current, viewport: camera, zoom_percent: Math.round(camera.zoom_scale * 100), page_viewports: { ...(current.page_viewports ?? {}), [key]: camera } });
      renderer.setVisibleWorldRect(teachingViewport.visibleRect()); saveFollow(); updateFollowUi();
    } });
    lifecycle.signal.addEventListener('abort', () => { studentGestures.destroy(); teachingViewport.destroy(); void textbook.destroy(); }, { once: true });
    frame.addEventListener('keydown', (event) => {
      if (selectionMode || follow.mode !== 'free_browse') return;
      if (event.key === '+' || event.key === '=') browse(0, 10);
      else if (event.key === '-') browse(0, -10);
      else if (event.key.startsWith('Arrow')) {
        const current = follow.visible_view ?? follow.teacher_view; if (!current) return;
        const dx = event.key === 'ArrowLeft' ? 48 : event.key === 'ArrowRight' ? -48 : 0; const dy = event.key === 'ArrowUp' ? 48 : event.key === 'ArrowDown' ? -48 : 0;
        const camera = teachingViewport.pan(dx, dy); const key = pageViewportKey(current.material_id, current.page_index);
        follow = applyStudentBrowseIntent(follow, { ...current, viewport: camera, zoom_percent: Math.round(camera.zoom_scale * 100), page_viewports: { ...(current.page_viewports ?? {}), [key]: camera } }); saveFollow(); updateFollowUi();
      } else return;
      event.preventDefault();
    });

    let reconnectAttempt = 0;
    const run = async (): Promise<void> => {
      while (!lifecycle.signal.aborted && session) {
        let resync = false;
        let deleted = false;
        const streamController = new AbortController();
        const abortStream = (): void => streamController.abort();
        lifecycle.signal.addEventListener('abort', abortStream, { once: true });
        try {
          const snapshot = await client.get<ClassroomSnapshot>(`/v1/classrooms/${id}/snapshot`, streamController.signal);
          if (lifecycle.signal.aborted || !session) return;
          renderer.renderSnapshot(snapshot.board_events);
          latestEvidenceTimeMs = Math.max(0, ...snapshot.board_events.map((item) => item.event.ts_end_ms), ...(snapshot.transcripts ?? []).map((item) => item.relative_end_ms));
          recognitions = snapshot.recognitions ?? []; renderRecognitions();
          transcripts = snapshot.transcripts ?? []; transcription = snapshot.transcription ?? null; renderTranscripts();
          materials = snapshot.materials ?? [];
          if (!restoredLocalFollow) { follow = restoreLocalFollowState(savedFollowValue, id, materials); restoredLocalFollow = true; savedFollowValue = null; }
          if (snapshot.capabilities?.textbook === false) textbookControls.hidden = true;
          follow = applyTeacherProjection(follow, snapshot.teacher_view, snapshot.confirmed_focus);
          await renderFollow();
          session.classroom.status = snapshot.classroom_status;
          save(session);
          updateActions(snapshot.classroom_status);
          dot.dataset.state = 'online';
          label.textContent = snapshot.classroom_status === 'ended' ? '课程已结束' : '实时同步';
          notice.textContent = snapshot.board_events.length ? '已连接，板书会自动更新。' : '课堂还没有板书。';
          reconnectAttempt = 0;
          await client.stream(`/v1/classrooms/${id}/stream?cursor=${renderer.model.sequence}`, (message) => {
            if (message.event === 'board_event') {
              const boardEvent = message.data as unknown as ClassroomBoardEvent;
              const status = renderer.renderEvent(boardEvent); latestEvidenceTimeMs = Math.max(latestEvidenceTimeMs, boardEvent.event.ts_end_ms);
              if (status === 'gap') { resync = true; streamController.abort(); return; }
              notice.textContent = nextBoardSyncNotice(notice.textContent, status);
              updateActions(session?.classroom.status ?? 'live');
            }
            if (message.event === 'preview') renderer.renderPreview(message.data.preview as ClassroomPreview);
            if (message.event === 'material_published') { materials = [...materials.filter((item) => item.material_id !== (message.data.material as ClassroomMaterial).material_id), message.data.material as ClassroomMaterial]; void renderFollow(); }
            if (message.event === 'teacher_view') {
              const before = follow; const view = message.data.teacher_view as unknown as ClassroomTeacherView; follow = applyTeacherProjection(follow, view);
              if (follow !== before) void renderFollow().then(() => frame.dispatchEvent(new CustomEvent('inkloop:classroom-view-render', { detail: { kind: 'durable_view', revision: view.revision, teacher_sample_timestamp_ms: Date.parse(view.updated_at), render_commit_timestamp_ms: Date.now() } })));
            }
            if (message.event === 'teacher_view_transient') {
              const before = follow; const view = message.data.teacher_view as unknown as ClassroomTeacherView; follow = applyTransientTeacherProjection(follow, view, {
                interaction_id: String(message.data.interaction_id), transient_sequence: Number(message.data.transient_sequence), base_revision: Number(message.data.base_revision),
              });
              if (follow !== before) void renderFollow().then(() => frame.dispatchEvent(new CustomEvent('inkloop:classroom-view-render', { detail: { kind: 'transient_view', revision: view.revision, teacher_sample_timestamp_ms: Date.parse(view.updated_at), render_commit_timestamp_ms: Date.now() } })));
            }
            if (message.event === 'confirmed_focus') { follow = applyTeacherProjection(follow, undefined, message.data.confirmed_focus as unknown as ClassroomConfirmedFocus); void renderFollow(); }
            if (message.event === 'recognition_revision') { recognitions.push(message.data.recognition as unknown as ClassroomRecognitionRevision); renderRecognitions(); }
            if (message.event === 'transcript_revision') { const transcript = message.data.transcript as unknown as ClassroomTranscriptRevision; transcripts.push(transcript); latestEvidenceTimeMs = Math.max(latestEvidenceTimeMs, transcript.relative_end_ms); renderTranscripts(); }
            if (message.event === 'transcription_state') { transcription = message.data.transcription as unknown as ClassroomTranscriptionState; renderTranscripts(); }
            if (message.event === 'transcripts_cleared') { transcripts = []; transcription = null; transcriptCutoffAt = -1; localStorage.removeItem(transcriptCutoffKey); renderTranscripts(); }
            if (message.event === 'recording_state') {
              const state = message.data.recording as { state?: string; health?: string };
              if (state.state === 'interrupted') { audioStatus.textContent = '老师录音中断 · 课本和板书继续'; audioStatus.classList.add('degraded'); }
              if (state.state === 'stopped') { audioStatus.textContent = state.health === 'incomplete' ? '课堂声音已停止 · 录音不完整' : '课堂声音已停止'; audioStatus.classList.toggle('degraded', state.health === 'incomplete'); }
            }
            if (message.event === 'class_state' && message.data.status === 'ended' && session) {
              session.classroom.status = 'ended'; save(session); updateActions('ended');
              audioConnectionAbort?.abort(); audioPeer?.stop(); enableAudio.disabled = true; audioStatus.textContent = '课堂声音已结束';
              label.textContent = '课程已结束'; notice.textContent = '课堂已结束，可以生成总结和课后练习。';
            }
            if (message.event === 'resync_required') { resync = true; streamController.abort(); }
            if (message.event === 'class_deleted') { deleted = true; streamController.abort(); }
          }, streamController.signal);
          if (deleted) { save(null); session = null; renderJoin('这堂课已被老师删除。'); return; }
          if (resync) { dot.dataset.state = 'reconnecting'; label.textContent = '正在校准'; notice.textContent = '正在重新载入完整板书。'; continue; }
          throw new Error('classroom_stream_ended');
        } catch (cause) {
          if (deleted) { save(null); session = null; renderJoin('这堂课已被老师删除。'); return; }
          if (lifecycle.signal.aborted || !session) return;
          if (resync) continue;
          const message = cause instanceof Error ? cause.message : '';
          if (message === 'unauthorized' || message === 'forbidden' || message === 'classroom_not_found') {
            save(null); session = null; renderJoin('课堂凭证已失效，请重新加入。'); return;
          }
          dot.dataset.state = 'reconnecting'; label.textContent = '正在重连'; notice.textContent = '连接中断，正在自动恢复板书。';
          await delay(reconnectDelay(reconnectAttempt), lifecycle.signal);
          reconnectAttempt += 1;
        } finally {
          lifecycle.signal.removeEventListener('abort', abortStream);
          streamController.abort();
        }
      }
    };
    void run();

    clear.addEventListener('click', () => {
      if (!confirm('清除此浏览器的课堂凭证和缓存？')) return;
      lifecycle.abort(); audioConnectionAbort?.abort(); audioPeer?.stop();
      if (notesSaveTimer) window.clearTimeout(notesSaveTimer);
      localStorage.removeItem(notesStorageKey); localStorage.removeItem(transcriptCutoffKey); localStorage.removeItem(followStorageKey);
      session = null; save(null); renderJoin();
    });
  };

  // A stored participant credential is offered explicitly instead of silently
  // reopening an older classroom when the student page is loaded again.
  renderJoin();
}

const app = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('#classroom-app');
if (app) bootstrapStudentClassroom(app);
