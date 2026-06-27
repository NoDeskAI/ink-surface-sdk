import './styles.css';
import {
  installInkLoopSurfaceStyles,
  renderInkLoopVisualModel,
  type InkLoopAnnotation,
  type InkLoopStrokePoint,
  type InkLoopVisualBlock,
  type InkLoopVisualStroke,
  type InkLoopVisualModel,
} from './inkloop-surface-sdk';

interface LabState {
  ok: boolean;
  run_dir: string;
  vault_root: string;
  base_dir: string;
  documents_dir: string;
  source_path: string | null;
  source_markdown: string;
  visual_model: InkLoopVisualModel | null;
  files: string[];
  external_edits: unknown[];
  bindings: unknown[];
  watch_events: unknown[];
  updated_at: string;
}

interface PullResult {
  ok: boolean;
  latency_ms: number;
  watch_events: unknown[];
  document_external_edits: unknown[];
  task_metadata_updates: unknown[];
  external_edit_count: number;
}

interface MutationResult {
  ok: boolean;
  source_path?: string;
  block_id?: string;
  ko_id?: string;
  updated_at?: string;
  error?: string;
}

interface AddAnnotationResult extends MutationResult {
  annotation?: InkLoopAnnotation;
}

type LabMode = 'focus' | 'thinking';
type InkTool = 'text' | 'pen' | 'highlighter';
type StrokeTool = Exclude<InkTool, 'text'>;

const ANNOTATION_KINDS = ['excerpt', 'annotation', 'qa', 'ai_note', 'task'];
const DEFAULT_INK_COLORS: Record<StrokeTool, string> = {
  pen: '#38bdf8',
  highlighter: '#facc15',
};
const DEFAULT_INK_OPACITY: Record<StrokeTool, number> = {
  pen: 0.92,
  highlighter: 0.56,
};
const INK_SWATCHES = ['#38bdf8', '#f8fafc', '#111827', '#facc15', '#fb7185', '#34d399'];

const css = `
  body.lab {
    display: block;
    overflow: auto;
    overscroll-behavior: none;
    background: #f5f3ee;
    color: #191816;
  }
  body.lab.is-inkloop-drawing {
    overflow: hidden;
  }
  .lab-shell {
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 1px;
    background: #d8d3ca;
  }
  .lab-doc, .lab-side {
    background: #fbfaf7;
    min-width: 0;
  }
  .lab-doc {
    padding: 34px clamp(24px, 6vw, 86px);
  }
  .lab-side {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: auto;
    padding: 20px;
  }
  .lab-kicker {
    font: 12px var(--mono);
    color: #716d65;
    text-transform: uppercase;
    letter-spacing: .08em;
    margin-bottom: 8px;
  }
  .lab-title {
    font: 600 26px/1.25 var(--serif);
    margin: 0 0 20px;
  }
  .lab-card {
    border: 1px solid #d8d3ca;
    border-radius: 8px;
    padding: 14px;
    background: #fffefa;
    margin-bottom: 12px;
  }
  .lab-card h2 {
    font: 600 14px var(--sans);
    margin: 0 0 8px;
  }
  .lab-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
  }
  .lab-mode-switch {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
    padding: 4px;
    border: 1px solid #d8d3ca;
    border-radius: 8px;
    background: #f5f3ee;
    margin: 10px 0 12px;
  }
  .lab-mode-btn {
    border: 0;
    border-radius: 6px;
    padding: 7px 8px;
    background: transparent;
    color: #4f4a43;
    font: 12px var(--sans);
    cursor: pointer;
  }
  .lab-mode-btn.is-active {
    background: #24221f;
    color: #fbfaf7;
  }
  .lab-tool-switch {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 4px;
    border: 1px solid #d8d3ca;
    border-radius: 8px;
    background: #f5f3ee;
    margin: 0 0 12px;
  }
  .lab-tool-btn {
    border: 0;
    border-radius: 6px;
    padding: 7px 8px;
    background: transparent;
    color: #4f4a43;
    font: 12px var(--sans);
    cursor: pointer;
  }
  .lab-tool-btn.is-active {
    background: #697c82;
    color: #fbfaf7;
  }
  .lab-tool-btn:disabled {
    color: #aaa39a;
    cursor: default;
  }
  .lab-color-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    margin: 0 0 12px;
  }
  .lab-color-input {
    width: 34px;
    height: 34px;
    padding: 2px;
    border: 1px solid #c6c0b7;
    border-radius: 6px;
    background: #fffefa;
    cursor: pointer;
  }
  .lab-color-input:disabled {
    opacity: .45;
    cursor: default;
  }
  .lab-color-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .lab-color-swatch {
    width: 24px;
    height: 24px;
    border: 1px solid #c6c0b7;
    border-radius: 999px;
    background: var(--swatch);
    cursor: pointer;
  }
  .lab-color-swatch.is-active {
    outline: 2px solid #24221f;
    outline-offset: 2px;
  }
  .lab-color-swatch:disabled {
    opacity: .45;
    cursor: default;
  }
  .lab-zoom-controls {
    display: grid;
    grid-template-columns: 36px minmax(64px, 1fr) 36px;
    align-items: center;
    gap: 6px;
    margin: 0 0 12px;
  }
  .lab-zoom-btn {
    height: 34px;
    border: 1px solid #c6c0b7;
    border-radius: 6px;
    background: #fffefa;
    color: #24221f;
    font: 600 18px/1 var(--sans);
    cursor: pointer;
  }
  .lab-zoom-label {
    text-align: center;
    color: #716d65;
    font: 12px var(--mono);
  }
  .lab-btn {
    border: 1px solid #c6c0b7;
    background: #24221f;
    color: #fbfaf7;
    border-radius: 6px;
    padding: 8px 10px;
    font: 12px var(--sans);
    cursor: pointer;
  }
  .lab-btn.secondary {
    background: #fffefa;
    color: #24221f;
  }
  .lab-metric {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    font: 12px var(--mono);
    padding: 5px 0;
    border-bottom: 1px solid #ece7df;
  }
  .lab-preview {
    max-width: 1080px;
    margin: 0 auto;
    font: 16px/1.75 var(--serif);
  }
  .lab-document-canvas {
    position: relative;
    min-height: max(860px, calc(100vh - 92px));
    padding-bottom: 56vh;
    overflow: visible;
    zoom: var(--lab-zoom, 1);
    transform-origin: top left;
    touch-action: auto;
  }
  .lab-free-canvas {
    position: absolute;
    z-index: 9;
    inset: -260px 0 -520px 0;
    width: 100%;
    height: calc(100% + 780px);
    overflow: visible;
    pointer-events: none;
    touch-action: none;
  }
  .lab-preview[data-mode="thinking"] .lab-document-canvas.is-drawing {
    cursor: crosshair;
  }
  .lab-preview[data-mode="thinking"][data-tool="pen"] .lab-document-canvas,
  .lab-preview[data-mode="thinking"][data-tool="pen"] .inkloop-surface-root,
  .lab-preview[data-mode="thinking"][data-tool="pen"] .inkloop-visual-block,
  .lab-preview[data-mode="thinking"][data-tool="pen"] .inkloop-content-plane,
  .lab-preview[data-mode="thinking"][data-tool="highlighter"] .lab-document-canvas,
  .lab-preview[data-mode="thinking"][data-tool="highlighter"] .inkloop-surface-root,
  .lab-preview[data-mode="thinking"][data-tool="highlighter"] .inkloop-visual-block,
  .lab-preview[data-mode="thinking"][data-tool="highlighter"] .inkloop-content-plane {
    touch-action: none;
    overscroll-behavior: contain;
    -webkit-user-select: none;
    user-select: none;
  }
  .lab-preview[data-mode="focus"] .inkloop-visual-block {
    grid-template-columns: minmax(0, 760px);
    gap: 0;
    min-height: auto;
  }
  .lab-preview[data-mode="focus"] .inkloop-content-plane {
    max-width: 760px;
  }
  .lab-preview[data-mode="focus"] .inkloop-mark-layer,
  .lab-preview[data-mode="focus"] .inkloop-margin-notes,
  .lab-preview[data-mode="focus"] .lab-free-canvas {
    display: none;
  }
  .lab-preview h1 {
    font: 600 32px/1.2 var(--serif);
    margin: 0 0 16px;
  }
  .lab-preview h2 {
    font: 600 20px/1.3 var(--sans);
    margin: 30px 0 8px;
    color: #45413b;
  }
  .lab-preview h3 {
    font: 600 17px/1.4 var(--sans);
    margin: 20px 0 8px;
  }
  .lab-preview p {
    margin: 0 0 14px;
  }
  .lab-callout {
    border-left: 3px solid #697c82;
    background: #f0eee8;
    padding: 10px 12px;
    margin: 12px 0 18px;
    font-family: var(--sans);
    font-size: 14px;
  }
  .lab-callout-title {
    font-weight: 600;
    margin-bottom: 4px;
  }
  .lab-link {
    color: #2f626c;
    font-family: var(--sans);
  }
  .lab-editor-empty {
    color: #716d65;
    font: 12px/1.55 var(--sans);
  }
  .lab-form {
    display: grid;
    gap: 10px;
  }
  .lab-field {
    display: grid;
    gap: 5px;
  }
  .lab-field span {
    color: #716d65;
    font: 11px var(--mono);
    text-transform: uppercase;
    letter-spacing: .06em;
  }
  .lab-input,
  .lab-textarea,
  .lab-select {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #c6c0b7;
    border-radius: 6px;
    background: #fffefa;
    color: #191816;
    font: 13px/1.55 var(--sans);
    padding: 8px 9px;
  }
  .lab-textarea {
    min-height: 136px;
    resize: vertical;
    font-family: var(--serif);
  }
  .lab-form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .lab-inline-edit {
    position: absolute;
    z-index: 8;
    top: 8px;
    right: 258px;
    border: 1px solid #c6c0b7;
    border-radius: 6px;
    padding: 4px 8px;
    background: #fffefa;
    color: #4f4a43;
    font: 11px/1.2 var(--sans);
    opacity: 0;
    cursor: pointer;
    transition: opacity 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .lab-preview .inkloop-visual-block:hover .lab-inline-edit,
  .lab-inline-edit:focus-visible {
    opacity: 1;
  }
  .lab-inline-edit:hover,
  .lab-inline-edit:focus-visible {
    border-color: #697c82;
    color: #191816;
  }
  .lab-preview .inkloop-margin-note {
    cursor: pointer;
    border-radius: 4px;
    transition: background 120ms ease;
  }
  .lab-preview .inkloop-margin-note:hover,
  .lab-preview .inkloop-margin-note.is-selected {
    background: rgba(105, 124, 130, 0.08);
  }
  .lab-preview[data-mode="thinking"] .inkloop-visual-block[data-editable="true"] .inkloop-content-plane > :is(p, h1, h2, h3, h4, h5, h6, li, blockquote) {
    outline: none;
    background: transparent;
    cursor: crosshair;
  }
  .lab-preview[data-mode="thinking"][data-tool="text"] .inkloop-visual-block[data-editable="true"] .inkloop-content-plane > :is(p, h1, h2, h3, h4, h5, h6, li, blockquote) {
    cursor: text;
  }
  .lab-preview[data-mode="thinking"] .inkloop-visual-block.is-saving .inkloop-content-plane > :is(p, h1, h2, h3, h4, h5, h6, li, blockquote) {
    outline: none;
  }
  .lab-preview [contenteditable="true"]:focus {
    outline: none;
  }
  .lab-draw-live {
    fill: none;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .lab-draw-live.is-highlighter {
    stroke-width: 10;
  }
  .lab-log {
    font: 11px/1.5 var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
    color: #4f4a43;
    max-height: 260px;
    overflow: auto;
  }
  .lab-path {
    font: 11px/1.5 var(--mono);
    color: #716d65;
    word-break: break-all;
  }
  @media (max-width: 1180px) {
    .lab-shell {
      grid-template-columns: 1fr;
    }
    .lab-doc {
      min-height: 100svh;
      padding: 28px clamp(22px, 5vw, 48px) 18px;
    }
    .lab-preview {
      max-width: 980px;
    }
    .lab-side {
      position: static;
      height: auto;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      padding: 16px clamp(22px, 5vw, 48px) 28px;
    }
    .lab-side > .lab-kicker,
    .lab-side > .lab-title {
      grid-column: 1 / -1;
      margin-bottom: 0;
    }
    .lab-card {
      margin-bottom: 0;
    }
    .lab-preview .inkloop-surface-root .inkloop-visual-block {
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }
    .lab-preview .inkloop-surface-root .inkloop-margin-notes {
      position: relative;
      top: auto;
      right: auto;
      grid-column: 1;
      grid-row: 2;
      width: auto;
    }
  }
  @media (max-width: 820px) {
    .lab-doc {
      padding: 22px 18px 12px;
    }
    .lab-side {
      display: block;
      padding: 14px 18px 24px;
    }
    .lab-card {
      margin-bottom: 12px;
    }
    .lab-inline-edit { right: 12px; }
  }
`;

document.body.classList.add('lab');
document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
installInkLoopSurfaceStyles();
document.body.innerHTML = `
  <main class="lab-shell">
    <article class="lab-doc">
      <div class="lab-preview" id="preview">
        <div class="lab-kicker">InkLoop Obsidian Sync Lab</div>
        <h1 class="lab-title">Loading...</h1>
      </div>
    </article>
    <aside class="lab-side">
      <div class="lab-kicker">Local adapter</div>
      <h1 class="lab-title">双向同步测试</h1>
      <div class="lab-card">
        <h2>操作</h2>
        <div class="lab-mode-switch" role="group" aria-label="InkLoop mode">
          <button class="lab-mode-btn" data-mode="focus" type="button">专注阅读</button>
          <button class="lab-mode-btn is-active" data-mode="thinking" type="button">标记思考</button>
        </div>
        <div class="lab-tool-switch" role="group" aria-label="InkLoop tool">
          <button class="lab-tool-btn" data-tool="text" type="button">文本</button>
          <button class="lab-tool-btn is-active" data-tool="pen" type="button">铅笔</button>
          <button class="lab-tool-btn" data-tool="highlighter" type="button">高亮</button>
        </div>
        <div class="lab-color-row">
          <input class="lab-color-input" id="ink-color" type="color" aria-label="标注颜色" />
          <div class="lab-color-swatches" id="ink-swatches" aria-label="常用标注颜色"></div>
        </div>
        <div class="lab-zoom-controls" aria-label="canvas zoom controls">
          <button class="lab-zoom-btn" id="zoom-out" type="button" aria-label="缩小画布">−</button>
          <button class="lab-zoom-btn" id="zoom-reset" type="button" aria-label="重置缩放"><span class="lab-zoom-label" id="zoom-label">100%</span></button>
          <button class="lab-zoom-btn" id="zoom-in" type="button" aria-label="放大画布">+</button>
        </div>
        <div class="lab-actions">
          <button class="lab-btn" id="refresh">重新读取</button>
          <button class="lab-btn" id="pull">Pull 回 InkLoop</button>
          <button class="lab-btn secondary" id="reset">一键还原</button>
        </div>
        <div class="lab-path" id="path"></div>
      </div>
      <div class="lab-card">
        <h2>指标</h2>
        <div id="metrics"></div>
      </div>
      <div class="lab-card">
        <h2>思考面板</h2>
        <div id="editor" class="lab-editor-empty">在标记思考模式下选择正文块或右侧旁注</div>
      </div>
      <div class="lab-card">
        <h2>最近 Pull</h2>
        <div class="lab-log" id="pull-log">尚未执行</div>
      </div>
      <div class="lab-card">
        <h2>文件</h2>
        <div class="lab-log" id="files"></div>
      </div>
    </aside>
  </main>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeHexColor(input: string | null | undefined, fallback: string): string {
  const value = String(input || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function storedInkColor(tool: StrokeTool): string {
  try {
    return normalizeHexColor(window.localStorage.getItem(`inkloop.lab.color.${tool}`), DEFAULT_INK_COLORS[tool]);
  } catch {
    return DEFAULT_INK_COLORS[tool];
  }
}

function persistInkColor(tool: StrokeTool, color: string): void {
  try {
    window.localStorage.setItem(`inkloop.lab.color.${tool}`, color);
  } catch {
    // Local storage can be unavailable in restricted webviews; the in-memory color still applies.
  }
}

function renderMetrics(state: LabState, pull?: PullResult): void {
  const rows = [
    ['base_dir', state.base_dir],
    ['documents_dir', state.documents_dir],
    ['bindings', String(state.bindings.length)],
    ['external_edits', String(state.external_edits.length)],
    ['watch_events', String(state.watch_events.length)],
    ['last_pull_ms', pull ? String(pull.latency_ms) : '-'],
    ['updated_at', state.updated_at],
  ];
  $('metrics').innerHTML = rows.map(([k, v]) => `<div class="lab-metric"><span>${k}</span><span>${escapeHtml(v)}</span></div>`).join('');
}

let lastPull: PullResult | undefined;
let selectedEditorKey: string | undefined;
let labMode: LabMode = 'thinking';
let inkTool: InkTool = 'pen';
let inkColors: Record<StrokeTool, string> = {
  pen: storedInkColor('pen'),
  highlighter: storedInkColor('highlighter'),
};
let isDrawing = false;
let isStateLoading = false;
let canvasZoom = 1;
const editTimers = new Map<string, number>();

async function loadState(): Promise<void> {
  if (isDrawing) return;
  isStateLoading = true;
  try {
    const response = await fetch('/api/obsidian-lab/state');
    const state = await response.json() as LabState;
    const preview = $('preview');
    preview.dataset.mode = labMode;
    preview.dataset.tool = inkTool;
    preview.replaceChildren();
    const kicker = document.createElement('div');
    kicker.className = 'lab-kicker';
    kicker.textContent = 'InkLoop Surface';
    preview.appendChild(kicker);
    if (state.visual_model) {
      const rendered = renderInkLoopVisualModel(state.visual_model);
      rendered.classList.toggle('is-focus-mode', labMode === 'focus');
      rendered.classList.toggle('is-thinking-mode', labMode === 'thinking');
      const canvas = document.createElement('div');
      canvas.className = 'lab-document-canvas';
      canvas.style.setProperty('--lab-zoom', String(canvasZoom));
      canvas.appendChild(rendered);
      preview.appendChild(canvas);
      attachDocumentInteractions(canvas, rendered, state.visual_model);
    } else {
      const title = document.createElement('h1');
      title.className = 'lab-title';
      title.textContent = 'No source document found';
      preview.appendChild(title);
    }
    $('path').textContent = state.source_path ?? state.vault_root;
    $('files').textContent = state.files.join('\n');
    renderMetrics(state, lastPull);
  } finally {
    isStateLoading = false;
    updateModeButtons();
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await response.json() as T;
}

function updateModeButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.lab-mode-btn')) {
    button.classList.toggle('is-active', button.dataset.mode === labMode);
  }
  updateToolButtons();
  $('preview').dataset.mode = labMode;
  $('preview').dataset.tool = inkTool;
  const surface = document.querySelector<HTMLElement>('#preview .inkloop-surface-root');
  surface?.classList.toggle('is-focus-mode', labMode === 'focus');
  surface?.classList.toggle('is-thinking-mode', labMode === 'thinking');
  document.body.classList.toggle('is-inkloop-editing', labMode === 'thinking');
  updateZoomControls();
  updateColorControls();
}

function updateToolButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.lab-tool-btn')) {
    const isActive = button.dataset.tool === inkTool;
    button.classList.toggle('is-active', isActive);
    button.disabled = labMode === 'focus';
  }
}

function currentStrokeTool(): StrokeTool {
  return isStrokeTool(inkTool) ? inkTool : 'pen';
}

function currentInkColor(): string {
  return inkColors[currentStrokeTool()];
}

function currentInkOpacity(): number {
  return DEFAULT_INK_OPACITY[currentStrokeTool()];
}

function setInkColor(color: string): void {
  const tool = currentStrokeTool();
  const nextColor = normalizeHexColor(color, inkColors[tool]);
  inkColors = { ...inkColors, [tool]: nextColor };
  persistInkColor(tool, nextColor);
  updateColorControls();
}

function updateColorControls(): void {
  const input = document.getElementById('ink-color') as HTMLInputElement | null;
  const disabled = labMode === 'focus' || inkTool === 'text';
  if (input) {
    input.value = currentInkColor();
    input.disabled = disabled;
  }
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('.lab-color-swatch')) {
    const color = normalizeHexColor(swatch.dataset.color, DEFAULT_INK_COLORS.pen);
    swatch.classList.toggle('is-active', color === currentInkColor());
    swatch.disabled = disabled;
  }
}

function updateZoomControls(): void {
  const label = document.getElementById('zoom-label');
  if (label) label.textContent = `${Math.round(canvasZoom * 100)}%`;
  document.querySelector<HTMLElement>('.lab-document-canvas')?.style.setProperty('--lab-zoom', String(canvasZoom));
}

function setCanvasZoom(nextZoom: number): void {
  canvasZoom = Math.min(1.8, Math.max(0.65, Math.round(nextZoom * 100) / 100));
  updateZoomControls();
}

function setMode(mode: LabMode): void {
  labMode = mode;
  selectedEditorKey = undefined;
  for (const timer of editTimers.values()) window.clearTimeout(timer);
  editTimers.clear();
  updateModeButtons();
  void loadState();
}

function setInkTool(tool: InkTool): void {
  inkTool = tool;
  selectedEditorKey = undefined;
  for (const timer of editTimers.values()) window.clearTimeout(timer);
  editTimers.clear();
  updateModeButtons();
  void loadState();
}

function isStrokeTool(tool: InkTool): tool is StrokeTool {
  return tool === 'pen' || tool === 'highlighter';
}

function editableTextFromElement(element: HTMLElement): string {
  return element.innerText.replace(/\u00a0/g, ' ').trimEnd();
}

function markdownForEditableBlock(block: InkLoopVisualBlock, visibleText: string): string {
  if (block.kind === 'heading' || block.content.startsWith('#')) {
    const level = Math.min(6, Math.max(1, block.content.match(/^#{1,6}/)?.[0]?.length ?? 1));
    return `${'#'.repeat(level)} ${visibleText.replace(/^#{1,6}\s+/, '').trim()}`;
  }
  return visibleText;
}

async function saveBlockContent(block: InkLoopVisualBlock, content: string, wrapper?: HTMLElement): Promise<void> {
  wrapper?.classList.add('is-saving');
  const result = await postJson<MutationResult>('/api/obsidian-lab/update-block', { block_id: block.id, content });
  $('pull-log').textContent = JSON.stringify(result, null, 2);
  window.setTimeout(() => wrapper?.classList.remove('is-saving'), 450);
}

function markSelected(key: string): void {
  selectedEditorKey = key;
  for (const note of document.querySelectorAll('.inkloop-margin-note.is-selected')) note.classList.remove('is-selected');
  const selectedNote = document.querySelector<HTMLElement>(`.inkloop-margin-note[data-editor-key="${key}"]`);
  selectedNote?.classList.add('is-selected');
}

function replaceEditor(children: Node[]): void {
  const editor = $('editor');
  editor.className = '';
  editor.replaceChildren(...children);
}

function makeButton(label: string, className = 'lab-btn secondary'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  return button;
}

function makeField(label: string, input: HTMLElement): HTMLLabelElement {
  const field = document.createElement('label');
  field.className = 'lab-field';
  const text = document.createElement('span');
  text.textContent = label;
  field.append(text, input);
  return field;
}

async function saveMutation(url: string, body: unknown): Promise<void> {
  $('pull-log').textContent = 'saving...';
  const result = await postJson<MutationResult>(url, body);
  $('pull-log').textContent = JSON.stringify(result, null, 2);
  await loadState();
}

function openAnnotationEditor(annotation: InkLoopAnnotation): void {
  markSelected(`annotation:${annotation.ko_id}`);
  const title = document.createElement('div');
  title.className = 'lab-kicker';
  title.textContent = `Annotation ${annotation.ko_id}`;

  const form = document.createElement('form');
  form.className = 'lab-form';
  const kind = document.createElement('select');
  kind.className = 'lab-select';
  for (const value of ANNOTATION_KINDS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value.replace(/_/g, ' ');
    option.selected = annotation.kind === value;
    kind.appendChild(option);
  }
  const name = document.createElement('input');
  name.className = 'lab-input';
  name.value = annotation.title;
  const body = document.createElement('textarea');
  body.className = 'lab-textarea';
  body.value = annotation.body_md || '';

  const actions = document.createElement('div');
  actions.className = 'lab-form-actions';
  const cancel = makeButton('取消');
  const save = makeButton('保存标注', 'lab-btn');
  save.type = 'submit';
  actions.append(cancel, save);
  form.append(makeField('类型', kind), makeField('标题', name), makeField('内容', body), actions);
  cancel.onclick = () => {
    $('editor').className = 'lab-editor-empty';
    $('editor').textContent = '在标记思考模式下选择正文块或右侧旁注';
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void saveMutation('/api/obsidian-lab/update-annotation', {
      ko_id: annotation.ko_id,
      patch: { kind: kind.value, title: name.value, body_md: body.value },
    });
  };

  replaceEditor([title, form]);
  name.focus();
}

function bboxOfPoints(points: InkLoopStrokePoint[]): [number, number, number, number] {
  if (!points.length) return [0, 0, 0, 0];
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

interface FreehandPoint extends InkLoopStrokePoint {
  clientX: number;
  clientY: number;
}

interface BlockDrawTarget {
  block: InkLoopVisualBlock;
  rect: DOMRect;
}

function pointFromPointer(event: PointerEvent, layer: SVGSVGElement, t0: number): FreehandPoint {
  const rect = layer.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / Math.max(1, rect.width),
    y: (event.clientY - rect.top) / Math.max(1, rect.height),
    t: Math.round(performance.now() - t0),
    pressure: event.pressure || 0,
    clientX: event.clientX,
    clientY: event.clientY,
  };
}

function pathFromPoints(points: InkLoopStrokePoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${(point.x * 100).toFixed(2)},${(point.y * 100).toFixed(2)}`).join(' ');
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function blockContentElement(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>('.inkloop-content-plane > :is(p, h1, h2, h3, h4, h5, h6, li, blockquote)');
}

function drawAnchorRect(wrapper: HTMLElement): DOMRect | null {
  const existingLayer = wrapper.querySelector<SVGSVGElement>('.inkloop-mark-layer');
  const existingRect = existingLayer?.getBoundingClientRect();
  if (existingRect && existingRect.width > 1 && existingRect.height > 1) return existingRect;
  const contentRect = blockContentElement(wrapper)?.getBoundingClientRect();
  if (contentRect && contentRect.width > 1 && contentRect.height > 1) return contentRect;
  const wrapperRect = wrapper.getBoundingClientRect();
  return wrapperRect.width > 1 && wrapperRect.height > 1 ? wrapperRect : null;
}

function distanceToRect(x: number, y: number, rect: DOMRect): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function resolveBlockDrawTarget(surfaceRoot: HTMLElement, model: { blocks: InkLoopVisualBlock[] }, points: FreehandPoint[]): BlockDrawTarget | null {
  if (!points.length) return null;
  const xs = points.map((point) => point.clientX);
  const ys = points.map((point) => point.clientY);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  let best: BlockDrawTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const block of model.blocks) {
    const wrapper = surfaceRoot.querySelector<HTMLElement>(`.inkloop-visual-block[data-block-id="${CSS.escape(block.id)}"]`);
    if (!wrapper) continue;
    const rect = drawAnchorRect(wrapper);
    if (!rect) continue;
    const distance = distanceToRect(centerX, centerY, rect);
    if (distance < bestDistance) {
      best = { block, rect };
      bestDistance = distance;
    }
  }

  return best;
}

function blockRelativePoint(point: FreehandPoint, rect: DOMRect): InkLoopStrokePoint {
  return {
    x: (point.clientX - rect.left) / Math.max(1, rect.width),
    y: (point.clientY - rect.top) / Math.max(1, rect.height),
    t: point.t,
    pressure: point.pressure,
  };
}

const DRAW_START_DISTANCE_PX = 5;

interface PendingFreehand {
  pointerId: number;
  startEvent: PointerEvent;
  startX: number;
  startY: number;
}

function canUseFreehandTarget(event: PointerEvent): boolean {
  if (labMode !== 'thinking') return false;
  if (!isStrokeTool(inkTool)) return false;
  if (isStateLoading) return false;
  if (event.button !== 0 && event.pointerType !== 'pen' && event.pointerType !== 'touch') return false;
  const target = eventElement(event.target);
  if (!target) return false;
  if (target.closest('button, input, textarea, select, a')) return false;
  if (target.closest('.inkloop-margin-note')) return false;
  return true;
}

function shouldDrawImmediately(event: PointerEvent): boolean {
  return isStrokeTool(inkTool) || event.pointerType === 'pen' || event.pointerType === 'touch' || event.altKey;
}

function attachFreeCanvas(canvas: HTMLElement, surfaceRoot: HTMLElement, model: { blocks: InkLoopVisualBlock[] }): void {
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.setAttribute('class', 'lab-free-canvas');
  layer.setAttribute('viewBox', '0 0 100 100');
  layer.setAttribute('preserveAspectRatio', 'none');
  let points: FreehandPoint[] = [];
  let path: SVGPathElement | null = null;
  let t0 = 0;
  let activePointerId: number | null = null;
  let pending: PendingFreehand | null = null;
  let scrollLockActive = false;

  const preventDocumentTouch = (event: TouchEvent) => {
    if (isDrawing) event.preventDefault();
  };

  const preventDocumentGesture = (event: Event) => {
    if (isDrawing) event.preventDefault();
  };

  const installScrollLock = () => {
    if (scrollLockActive) return;
    scrollLockActive = true;
    document.body.classList.add('is-inkloop-drawing');
    document.addEventListener('touchmove', preventDocumentTouch, { capture: true, passive: false });
    document.addEventListener('gesturestart', preventDocumentGesture, { capture: true, passive: false } as AddEventListenerOptions);
  };

  const releaseScrollLock = () => {
    if (!scrollLockActive) return;
    scrollLockActive = false;
    document.body.classList.remove('is-inkloop-drawing');
    document.removeEventListener('touchmove', preventDocumentTouch, true);
    document.removeEventListener('gesturestart', preventDocumentGesture, true);
  };

  const clearPending = () => {
    document.removeEventListener('pointermove', watchPendingMove, true);
    document.removeEventListener('pointerup', finishPendingClick, true);
    document.removeEventListener('pointercancel', cancelPending, true);
    pending = null;
  };

  const beginDrawing = (event: PointerEvent, initialEvent = event) => {
    if (isDrawing || activePointerId !== null || path) return;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    isDrawing = true;
    installScrollLock();
    canvas.classList.add('is-drawing');
    activePointerId = initialEvent.pointerId;
    try {
      canvas.setPointerCapture?.(activePointerId);
    } catch {
      // Safari may reject capture when the pointer has already moved between pending and draw.
    }
    t0 = performance.now();
    points = [pointFromPointer(initialEvent, layer, t0)];
    if (event !== initialEvent) points.push(pointFromPointer(event, layer, t0));
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', `lab-draw-live is-${inkTool}`);
    path.setAttribute('d', pathFromPoints(points));
    path.setAttribute('stroke', currentInkColor());
    path.setAttribute('stroke-opacity', String(currentInkOpacity()));
    layer.appendChild(path);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', cancel, true);
  };

  const watchPendingMove = (event: PointerEvent) => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
    if (distance < DRAW_START_DISTANCE_PX) return;
    const initialEvent = pending.startEvent;
    clearPending();
    beginDrawing(event, initialEvent);
  };

  const finishPendingClick = (event: PointerEvent) => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    clearPending();
  };

  const cancelPending = (event: PointerEvent) => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    clearPending();
  };

  const start = (event: PointerEvent) => {
    if (pending || isDrawing || activePointerId !== null || path) {
      if (event.pointerType === 'pen' || event.pointerType === 'touch') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!canUseFreehandTarget(event)) return;
    if (event.pointerType === 'pen' || event.pointerType === 'touch') {
      event.preventDefault();
      event.stopPropagation();
    }
    if (shouldDrawImmediately(event)) {
      beginDrawing(event);
      return;
    }
    pending = {
      pointerId: event.pointerId,
      startEvent: event,
      startX: event.clientX,
      startY: event.clientY,
    };
    document.addEventListener('pointermove', watchPendingMove, true);
    document.addEventListener('pointerup', finishPendingClick, true);
    document.addEventListener('pointercancel', cancelPending, true);
  };

  const move = (event: PointerEvent) => {
    if (!isDrawing || !path || event.pointerId !== activePointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = pointFromPointer(event, layer, t0);
    const last = points[points.length - 1];
    if (Math.hypot(next.x - last.x, next.y - last.y) < 0.004) return;
    points.push(next);
    path.setAttribute('d', pathFromPoints(points));
  };

  const cleanup = () => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', cancel, true);
    if (activePointerId !== null) {
      try {
        canvas.releasePointerCapture?.(activePointerId);
      } catch {
        // Pointer capture is best-effort across browsers.
      }
    }
    activePointerId = null;
    releaseScrollLock();
    canvas.classList.remove('is-drawing');
  };

  const cancel = () => {
    isDrawing = false;
    points = [];
    path?.remove();
    path = null;
    cleanup();
  };

  const finish = async (event: PointerEvent) => {
    if (!isDrawing || event.pointerId !== activePointerId) return;
    event.preventDefault();
    event.stopPropagation();
    isDrawing = false;
    cleanup();
    const finalPoints = points;
    points = [];
    if (finalPoints.length < 2) {
      path?.remove();
      path = null;
      return;
    }
    const target = resolveBlockDrawTarget(surfaceRoot, model, finalPoints);
    if (!target) {
      path?.remove();
      path = null;
      $('pull-log').textContent = 'No InkLoop block found for this mark.';
      return;
    }
    const blockPoints = finalPoints.map((point) => blockRelativePoint(point, target.rect));
    const tool = isStrokeTool(inkTool) ? inkTool : 'pen';
    const stroke: InkLoopVisualStroke = { tool, color: currentInkColor(), opacity: currentInkOpacity(), points: blockPoints };
    const bbox = bboxOfPoints(blockPoints);
    $('pull-log').textContent = 'adding mark...';
    const result = await postJson<AddAnnotationResult>('/api/obsidian-lab/add-annotation', {
      block_id: target.block.id,
      kind: tool === 'highlighter' ? 'excerpt' : 'annotation',
      title: `${tool === 'highlighter' ? 'Highlight' : 'Hand mark'} ${new Date().toLocaleTimeString()}`,
      render_mode: 'stroke_only',
      visual_bbox: bbox,
      visual_strokes: [stroke],
    });
    if (result.ok) {
      path?.setAttribute('data-saved-ko-id', result.annotation?.ko_id ?? 'true');
    } else {
      path?.remove();
    }
    path = null;
    $('pull-log').textContent = JSON.stringify(result, null, 2);
  };

  canvas.addEventListener('pointerdown', start, true);
  canvas.appendChild(layer);
}

function attachDocumentInteractions(canvas: HTMLElement, root: HTMLElement, model: InkLoopVisualModel): void {
  attachFreeCanvas(canvas, root, model);
  for (const block of model.blocks) {
    const wrapper = [...root.querySelectorAll<HTMLElement>('.inkloop-visual-block')].find((node) => node.dataset.blockId === block.id);
    if (!wrapper) continue;
    wrapper.dataset.editable = block.region === 'editable' ? 'true' : 'false';
    const content = blockContentElement(wrapper);
    if (content && block.region === 'editable') {
      const canEditText = labMode === 'thinking' && inkTool === 'text';
      content.contentEditable = canEditText ? 'true' : 'false';
      content.spellcheck = canEditText;
      content.oninput = () => {
        if (labMode !== 'thinking' || inkTool !== 'text') return;
        const existing = editTimers.get(block.id);
        if (existing) window.clearTimeout(existing);
        editTimers.set(block.id, window.setTimeout(() => {
          editTimers.delete(block.id);
          void saveBlockContent(block, markdownForEditableBlock(block, editableTextFromElement(content)), wrapper);
        }, 650));
      };
      content.onblur = () => {
        if (labMode !== 'thinking' || inkTool !== 'text') return;
        const existing = editTimers.get(block.id);
        if (existing) window.clearTimeout(existing);
        editTimers.delete(block.id);
        void saveBlockContent(block, markdownForEditableBlock(block, editableTextFromElement(content)), wrapper);
      };
    }
    for (const annotation of block.annotations) {
      const note = [...wrapper.querySelectorAll<HTMLElement>('.inkloop-margin-note')].find((node) => node.dataset.koId === annotation.ko_id);
      if (!note) continue;
      const key = `annotation:${annotation.ko_id}`;
      note.dataset.editorKey = key;
      note.tabIndex = 0;
      if (selectedEditorKey === key) note.classList.add('is-selected');
      note.onclick = () => openAnnotationEditor(annotation);
      note.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openAnnotationEditor(annotation);
        }
      };
    }
  }
}

$<HTMLButtonElement>('refresh').onclick = () => void loadState();
$<HTMLButtonElement>('zoom-out').onclick = () => setCanvasZoom(canvasZoom - 0.1);
$<HTMLButtonElement>('zoom-reset').onclick = () => setCanvasZoom(1);
$<HTMLButtonElement>('zoom-in').onclick = () => setCanvasZoom(canvasZoom + 0.1);
for (const button of document.querySelectorAll<HTMLButtonElement>('.lab-mode-btn')) {
  button.onclick = () => setMode((button.dataset.mode as LabMode | undefined) ?? 'thinking');
}
for (const button of document.querySelectorAll<HTMLButtonElement>('.lab-tool-btn')) {
  button.onclick = () => setInkTool((button.dataset.tool as InkTool | undefined) ?? 'pen');
}
const swatchRoot = document.getElementById('ink-swatches');
if (swatchRoot) {
  for (const color of INK_SWATCHES) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'lab-color-swatch';
    swatch.dataset.color = color;
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', `选择 ${color}`);
    swatch.onclick = () => setInkColor(color);
    swatchRoot.appendChild(swatch);
  }
}
$<HTMLInputElement>('ink-color').oninput = (event) => setInkColor((event.currentTarget as HTMLInputElement).value);
$<HTMLButtonElement>('pull').onclick = async () => {
  $('pull-log').textContent = 'pulling...';
  lastPull = await postJson<PullResult>('/api/obsidian-lab/pull');
  $('pull-log').textContent = JSON.stringify(lastPull, null, 2);
  await loadState();
};
$<HTMLButtonElement>('reset').onclick = async () => {
  $('pull-log').textContent = 'resetting...';
  lastPull = undefined;
  selectedEditorKey = undefined;
  const result = await postJson<unknown>('/api/obsidian-lab/reset');
  $('pull-log').textContent = JSON.stringify(result, null, 2);
  await loadState();
};

void loadState();
window.setInterval(() => {
  if (!isDrawing && !isStateLoading && (labMode === 'focus' || inkTool !== 'text')) void loadState();
}, 2000);
