import {
  isDuplicateDocumentHeading,
  isStrokeOnlyAnnotation,
  normalizeText,
  parseInkLoopVisualModel,
  type InkLoopAnnotation,
  type InkLoopStrokePoint,
  type InkLoopVisualBlock,
  type InkLoopVisualModel,
} from '../../surface-model/src/index.js';

export {
  appendInkLoopAnnotation,
  isDuplicateDocumentHeading,
  isStrokeOnlyAnnotation,
  normalizeText,
  parseInkLoopVisualModel,
  replaceInkLoopBlockContent,
  updateInkLoopAnnotation,
} from '../../surface-model/src/index.js';
export type {
  InkLoopAnnotation,
  InkLoopAnnotationPatch,
  InkLoopStrokePoint,
  InkLoopVisualBlock,
  InkLoopVisualModel,
  InkLoopVisualStroke,
} from '../../surface-model/src/index.js';

export const INKLOOP_SURFACE_CSS = `
.inkloop-surface-root {
  --inkloop-paper: var(--background-primary, #fbfaf7);
  --inkloop-ink: var(--text-normal, #191816);
  --inkloop-muted: var(--text-muted, #716d65);
  --inkloop-line: var(--background-modifier-border, #d8d3ca);
  --inkloop-highlight: rgba(238, 205, 82, 0.24);
  --inkloop-pencil: var(--inkloop-ink);
  --inkloop-ai: rgba(93, 121, 127, 0.82);
  color: var(--inkloop-ink);
}

.inkloop-surface-root .inkloop-visual-block {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 212px;
  gap: 28px;
  margin: 18px 0 24px;
  padding: 14px 0;
  min-height: 78px;
}

.inkloop-surface-root .inkloop-content-plane {
  position: relative;
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
}

.inkloop-surface-root .inkloop-content-plane > p,
.inkloop-surface-root .inkloop-content-plane > li,
.inkloop-surface-root .inkloop-content-plane > blockquote,
.inkloop-surface-root .inkloop-content-plane > h1,
.inkloop-surface-root .inkloop-content-plane > h2,
.inkloop-surface-root .inkloop-content-plane > h3,
.inkloop-surface-root .inkloop-content-plane > h4,
.inkloop-surface-root .inkloop-content-plane > h5,
.inkloop-surface-root .inkloop-content-plane > h6 {
  position: relative;
  z-index: 2;
  margin-top: 0;
  margin-bottom: 0;
  line-height: 1.78;
}

.inkloop-surface-root .inkloop-visual-block.is-plain {
  margin: 8px 0;
  padding-top: 8px;
  padding-bottom: 8px;
  min-height: auto;
}

.inkloop-surface-root.is-focus-mode .inkloop-visual-block,
.inkloop-focus-mode .inkloop-surface-root .inkloop-visual-block {
  grid-template-columns: minmax(0, 760px);
  gap: 0;
  min-height: auto;
}

.inkloop-surface-root.is-focus-mode .inkloop-content-plane,
.inkloop-focus-mode .inkloop-surface-root .inkloop-content-plane {
  max-width: 760px;
}

.inkloop-surface-root.is-focus-mode .inkloop-mark-layer,
.inkloop-surface-root.is-focus-mode .inkloop-margin-notes,
.inkloop-focus-mode .inkloop-surface-root .inkloop-mark-layer,
.inkloop-focus-mode .inkloop-surface-root .inkloop-margin-notes {
  display: none;
}

.inkloop-surface-root .inkloop-mark-layer {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  left: -10px;
  top: -7px;
  right: auto;
  width: calc(100% + 20px);
  height: calc(100% + 14px);
  overflow: visible;
}

.inkloop-surface-root .inkloop-mark-highlight {
  fill: var(--inkloop-highlight);
  stroke: none;
}

.inkloop-surface-root .inkloop-mark-box,
.inkloop-surface-root .inkloop-mark-circle,
.inkloop-surface-root .inkloop-mark-task {
  fill: none;
  stroke: var(--inkloop-pencil);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.inkloop-surface-root .inkloop-mark-circle {
  stroke: rgba(132, 91, 39, 0.72);
  stroke-width: 2;
}

.inkloop-surface-root .inkloop-mark-task,
.inkloop-surface-root .inkloop-mark-underline {
  fill: none;
  stroke: rgba(84, 112, 118, 0.78);
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.inkloop-surface-root .inkloop-mark-rail {
  fill: none;
  stroke: var(--inkloop-ai);
  stroke-width: 3;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.inkloop-surface-root .inkloop-mark-freehand {
  fill: none;
  stroke: var(--inkloop-ink);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.inkloop-surface-root .inkloop-mark-freehand.is-highlighter {
  stroke: rgba(238, 205, 82, 0.56);
  stroke-width: 10;
}

.inkloop-surface-root .inkloop-margin-notes {
  position: relative;
  top: auto;
  right: auto;
  z-index: 3;
  grid-column: 2;
  grid-row: 1;
  width: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.inkloop-surface-root .inkloop-margin-note {
  padding: 2px 0;
  color: var(--inkloop-muted);
}

.inkloop-surface-root .inkloop-margin-note-kind {
  margin-bottom: 2px;
  font-size: 10px;
  font-family: var(--font-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.72;
}

.inkloop-surface-root .inkloop-margin-note-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--inkloop-ink);
}

.inkloop-surface-root .inkloop-margin-note-body {
  margin-top: 4px;
  font-size: 12px;
  font-style: italic;
  line-height: 1.55;
}

@media (max-width: 980px) {
  .inkloop-surface-root .inkloop-visual-block {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }

  .inkloop-surface-root .inkloop-margin-notes {
    position: relative;
    top: auto;
    right: auto;
    grid-column: 1;
    grid-row: 2;
    width: auto;
  }
}
`;
function previewText(annotation: InkLoopAnnotation): string {
  return normalizeText(annotation.body_md || annotation.title).slice(0, 180);
}

function createSvgElement(name: string, doc: Document): SVGElement {
  return doc.createElementNS('http://www.w3.org/2000/svg', name);
}

function addSvgPath(svg: SVGElement, cls: string, d: string, doc: Document, attrs: Record<string, string | number> = {}): void {
  const path = createSvgElement('path', doc);
  path.setAttribute('class', cls);
  path.setAttribute('d', d);
  for (const [key, value] of Object.entries(attrs)) path.setAttribute(key, String(value));
  svg.appendChild(path);
}

function addSvgRect(svg: SVGElement, cls: string, attrs: Record<string, string | number>, doc: Document): void {
  const rect = createSvgElement('rect', doc);
  rect.setAttribute('class', cls);
  for (const [key, value] of Object.entries(attrs)) rect.setAttribute(key, String(value));
  svg.appendChild(rect);
}

function strokePath(points: InkLoopStrokePoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${(point.x * 100).toFixed(2)},${(point.y * 100).toFixed(2)}`)
    .join(' ');
}

export function renderMarkLayer(block: InkLoopVisualBlock, doc: Document = document): SVGElement | null {
  if (!block.annotations.length) return null;
  const svg = createSvgElement('svg', doc);
  svg.setAttribute('class', 'inkloop-mark-layer');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const drawnAnnotations = block.annotations.filter((annotation) => annotation.visual_strokes?.some((stroke) => stroke.points.length > 1));
  for (const annotation of drawnAnnotations) {
    for (const stroke of annotation.visual_strokes ?? []) {
      if (stroke.points.length <= 1) continue;
      const attrs: Record<string, string | number> = {};
      if (stroke.color) attrs.stroke = stroke.color;
      if (stroke.opacity !== undefined) attrs['stroke-opacity'] = Math.min(1, Math.max(0.05, Number(stroke.opacity) || 1));
      addSvgPath(svg, `inkloop-mark-freehand is-${stroke.tool ?? 'pen'}`, strokePath(stroke.points), doc, attrs);
    }
  }

  const kinds = new Set(block.annotations.filter((annotation) => !drawnAnnotations.includes(annotation)).map((annotation) => annotation.kind));
  if (kinds.has('excerpt')) addSvgRect(svg, 'inkloop-mark-highlight', { x: 1, y: 13, width: 98, height: 70, rx: 5, ry: 5 }, doc);
  if (kinds.has('annotation')) {
    addSvgPath(svg, 'inkloop-mark-box', 'M3,13 C15,8 83,8 96,14 C99,31 98,71 95,86 C76,95 23,94 5,86 C1,67 1,33 3,13', doc);
  }
  if (kinds.has('qa')) {
    addSvgPath(svg, 'inkloop-mark-circle', 'M10,19 C31,3 76,6 91,23 C106,40 94,79 72,90 C45,104 9,91 4,62 C1,43 2,28 10,19', doc);
    addSvgPath(svg, 'inkloop-mark-underline', 'M12,84 C31,78 53,86 88,80', doc);
  }
  if (kinds.has('task')) {
    addSvgPath(svg, 'inkloop-mark-task', 'M7,20 C19,17 22,28 29,30 C39,34 45,15 57,18 C70,20 69,39 82,38 C88,38 92,35 96,31', doc);
    addSvgPath(svg, 'inkloop-mark-underline', 'M11,88 C33,83 58,88 90,84', doc);
  }
  if (kinds.has('ai_note')) addSvgPath(svg, 'inkloop-mark-rail', 'M0,7 C3,28 3,68 0,94', doc);
  if (!svg.childNodes.length) addSvgRect(svg, 'inkloop-mark-highlight', { x: 2, y: 16, width: 96, height: 66, rx: 5, ry: 5 }, doc);
  return svg;
}

export function renderMarginNotes(block: InkLoopVisualBlock, doc: Document = document): HTMLElement | null {
  const visibleAnnotations = block.annotations.filter((annotation) => !isStrokeOnlyAnnotation(annotation));
  if (!visibleAnnotations.length) return null;
  const notes = doc.createElement('aside');
  notes.className = 'inkloop-margin-notes';
  for (const annotation of visibleAnnotations) {
    const note = doc.createElement('div');
    note.className = `inkloop-margin-note is-${annotation.kind}`;
    note.dataset.koId = annotation.ko_id;
    note.dataset.annotationKind = annotation.kind;
    const label = doc.createElement('div');
    label.className = 'inkloop-margin-note-kind';
    label.textContent = annotation.kind.replace(/_/g, ' ');
    const title = doc.createElement('div');
    title.className = 'inkloop-margin-note-title';
    title.textContent = annotation.title;
    note.append(label, title);
    const body = previewText(annotation);
    if (body && body !== annotation.title) {
      const excerpt = doc.createElement('div');
      excerpt.className = 'inkloop-margin-note-body';
      excerpt.textContent = body;
      note.appendChild(excerpt);
    }
    notes.appendChild(note);
  }
  return notes;
}

function appendTextWithLineBreaks(el: HTMLElement, text: string, doc: Document): void {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) el.appendChild(doc.createElement('br'));
    el.appendChild(doc.createTextNode(line));
  });
}

function markdownHeadingLevel(markdown: string): number {
  return Math.min(6, Math.max(1, markdown.match(/^#{1,6}/)?.[0]?.length ?? 2));
}

export function renderBlockContent(block: InkLoopVisualBlock, doc: Document = document): HTMLElement {
  if (block.kind === 'heading' || block.content.startsWith('#')) {
    const level = markdownHeadingLevel(block.content);
    const heading = doc.createElement(`h${level}`);
    heading.textContent = block.content.replace(/^#{1,6}\s+/, '').trim();
    return heading;
  }
  const paragraph = doc.createElement('p');
  appendTextWithLineBreaks(paragraph, block.content, doc);
  return paragraph;
}

export function renderInkLoopVisualBlock(block: InkLoopVisualBlock, doc: Document = document): HTMLElement {
  const wrapper = doc.createElement('section');
  const hasVisibleAnnotations = block.annotations.some((annotation) => !isStrokeOnlyAnnotation(annotation));
  wrapper.className = `inkloop-visual-block${hasVisibleAnnotations ? '' : ' is-plain'}${block.region === 'editable' ? ' is-preview-editable' : ''}`;
  wrapper.dataset.blockId = block.id;
  wrapper.dataset.annotationKinds = block.annotations.map((annotation) => annotation.kind).join(' ');
  const contentPlane = doc.createElement('div');
  contentPlane.className = 'inkloop-content-plane';
  contentPlane.appendChild(renderBlockContent(block, doc));
  const markLayer = renderMarkLayer(block, doc);
  const notes = renderMarginNotes(block, doc);
  if (markLayer) contentPlane.appendChild(markLayer);
  wrapper.appendChild(contentPlane);
  if (notes) wrapper.appendChild(notes);
  return wrapper;
}

export function renderInkLoopDocument(markdown: string, doc: Document = document): HTMLElement {
  const model = parseInkLoopVisualModel(markdown);
  if (model) return renderInkLoopVisualModel(model, doc);
  const root = doc.createElement('article');
  root.className = 'inkloop-surface-root inkloop-native-preview inkloop-native-preview-root';
  const empty = doc.createElement('p');
  empty.textContent = normalizeText(markdown);
  root.appendChild(empty);
  return root;
}

export function renderInkLoopVisualModel(model: InkLoopVisualModel, doc: Document = document): HTMLElement {
  const root = doc.createElement('article');
  root.className = 'inkloop-surface-root inkloop-native-preview inkloop-native-preview-root';

  if (!isDuplicateDocumentHeading(model)) {
    const title = doc.createElement('h1');
    title.textContent = model.documentTitle;
    root.appendChild(title);
  }

  let lastPage: string | undefined;
  for (const block of model.blocks) {
    if (block.page !== undefined && block.page !== lastPage) {
      const pageHeading = doc.createElement('h2');
      pageHeading.textContent = `Page ${Number(block.page) + 1}`;
      root.appendChild(pageHeading);
      lastPage = block.page;
    }
    root.appendChild(renderInkLoopVisualBlock(block, doc));
  }
  return root;
}

export function installInkLoopSurfaceStyles(doc: Document = document, id = 'inkloop-surface-sdk-styles'): HTMLStyleElement {
  const existing = doc.getElementById(id);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = INKLOOP_SURFACE_CSS;
  doc.head.appendChild(style);
  return style;
}
