export interface InkLoopAnnotation {
  ko_id: string;
  kind: string;
  title: string;
  body_md?: string;
  status?: string;
  render_mode?: 'stroke_only' | 'margin_note';
  anchor_bbox?: [number, number, number, number];
  page_index?: number;
  visual_bbox?: [number, number, number, number];
  visual_strokes?: InkLoopVisualStroke[];
}

export interface InkLoopStrokePoint {
  x: number;
  y: number;
  t?: number;
  pressure?: number;
}

export interface InkLoopVisualStroke {
  tool?: 'pen' | 'highlighter';
  color?: string;
  opacity?: number;
  points: InkLoopStrokePoint[];
}

export interface InkLoopVisualBlock {
  id: string;
  kind: string;
  region: string;
  page?: string;
  bbox?: string;
  content: string;
  annotations: InkLoopAnnotation[];
}

export interface InkLoopVisualModel {
  documentTitle: string;
  blocks: InkLoopVisualBlock[];
}

export type InkLoopAnnotationPatch = Partial<Pick<InkLoopAnnotation, 'kind' | 'title' | 'body_md' | 'status'>>;

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

function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of input.matchAll(/([A-Za-z0-9_-]+)=([^\s>]+)/g)) attrs[match[1]] = match[2];
  return attrs;
}

function escapeRegExp(input: string): string {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function encodeAnnotationComment(annotation: InkLoopAnnotation): string {
  return `<!-- inkloop:annotation-json ${encodeURIComponent(JSON.stringify(annotation))} -->`;
}

function isStrokeOnlyAnnotation(annotation: InkLoopAnnotation): boolean {
  return annotation.render_mode === 'stroke_only'
    || (annotation.visual_strokes?.some((stroke) => stroke.points.length > 1) === true && !normalizeText(annotation.body_md));
}

export function normalizeText(input: string | undefined | null): string {
  return String(input || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAnnotationComments(markdown: string): InkLoopAnnotation[] {
  const annotations: InkLoopAnnotation[] = [];
  for (const match of markdown.matchAll(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g)) {
    try {
      annotations.push(JSON.parse(decodeURIComponent(match[1].trim())) as InkLoopAnnotation);
    } catch {
      // Keep malformed metadata out of the visual layer. The source markdown still has the fallback.
    }
  }
  return annotations;
}

function refreshAnnotationFallbackSections(markdown: string): string {
  return markdown.replace(
    /(<!--\s*inkloop:annotations-begin\s+[^>]*-->\s*\n<div class="inkloop-annotation-fallback"[^>]*>\s*\n)([\s\S]*?)(\n<\/div>\s*\n<!--\s*inkloop:annotations-end\s+[^>]*-->)/g,
    (full, prefix: string, body: string, suffix: string) => {
      const comments = [...body.matchAll(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g)];
      const annotations: InkLoopAnnotation[] = [];
      const commentLines: string[] = [];
      for (const match of comments) {
        try {
          const annotation = JSON.parse(decodeURIComponent(match[1].trim())) as InkLoopAnnotation;
          annotations.push(annotation);
          commentLines.push(encodeAnnotationComment(annotation));
        } catch {
          commentLines.push(match[0]);
        }
      }
      if (!commentLines.length) return full;
      const titles = annotations
        .filter((annotation) => !isStrokeOnlyAnnotation(annotation))
        .map((annotation) => `<li>${escapeHtml(annotation.title)}</li>`)
        .join('\n');
      return `${prefix}${commentLines.join('\n')}\n<strong>InkLoop annotations</strong>\n<ul>\n${titles}\n</ul>${suffix}`;
    },
  );
}

function annotationFallbackSection(blockId: string, annotation: InkLoopAnnotation): string {
  const visibleTitle = isStrokeOnlyAnnotation(annotation) ? '' : `<li>${escapeHtml(annotation.title)}</li>`;
  return [
    `<!-- inkloop:annotations-begin block=${blockId} mapping=inkloop.obsidian.mapping.v1 -->`,
    `<div class="inkloop-annotation-fallback" data-inkloop-block="${escapeHtml(blockId)}">`,
    encodeAnnotationComment(annotation),
    '<strong>InkLoop annotations</strong>',
    '<ul>',
    visibleTitle,
    '</ul>',
    '</div>',
    `<!-- inkloop:annotations-end block=${blockId} -->`,
  ].join('\n');
}

export function replaceInkLoopBlockContent(markdown: string, blockId: string, nextContent: string): string {
  const begin = `<!--\\s*inkloop:block-begin\\s+[^>]*\\bid=${escapeRegExp(blockId)}\\b[^>]*-->`;
  const end = `<!--\\s*inkloop:block-end\\s+id=${escapeRegExp(blockId)}\\s*-->`;
  const pattern = new RegExp(`(${begin}\\s*\\n)([\\s\\S]*?)(\\n${end})`);
  if (!pattern.test(markdown)) throw new Error(`InkLoop block was not found: ${blockId}`);
  return markdown.replace(pattern, (_full, prefix: string, _oldBody: string, suffix: string) => `${prefix}${nextContent.trimEnd()}${suffix}`);
}

export function appendInkLoopAnnotation(markdown: string, blockId: string, annotation: InkLoopAnnotation): string {
  const sectionPattern = new RegExp(
    `(<!--\\s*inkloop:annotations-begin\\s+[^>]*\\bblock=${escapeRegExp(blockId)}\\b[^>]*-->\\s*\\n<div class="inkloop-annotation-fallback"[^>]*>\\s*\\n)([\\s\\S]*?)(\\n</div>\\s*\\n<!--\\s*inkloop:annotations-end\\s+[^>]*-->)`,
  );
  if (sectionPattern.test(markdown)) {
    const inserted = markdown.replace(sectionPattern, (_full, prefix: string, body: string, suffix: string) => {
      const marker = '<strong>InkLoop annotations</strong>';
      if (body.includes(marker)) return `${prefix}${body.replace(marker, `${encodeAnnotationComment(annotation)}\n${marker}`)}${suffix}`;
      return `${prefix}${body.trimEnd()}\n${encodeAnnotationComment(annotation)}${suffix}`;
    });
    return refreshAnnotationFallbackSections(inserted);
  }

  const blockEnd = new RegExp(`(<!--\\s*inkloop:block-end\\s+id=${escapeRegExp(blockId)}\\s*-->)`);
  if (!blockEnd.test(markdown)) throw new Error(`InkLoop block was not found: ${blockId}`);
  return markdown.replace(blockEnd, `$1\n\n${annotationFallbackSection(blockId, annotation)}`);
}

export function updateInkLoopAnnotation(markdown: string, koId: string, patch: InkLoopAnnotationPatch): string {
  let didUpdate = false;
  const nextMarkdown = markdown.replace(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g, (full, encoded: string) => {
    try {
      const annotation = JSON.parse(decodeURIComponent(encoded.trim())) as InkLoopAnnotation;
      if (annotation.ko_id !== koId) return full;
      const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      didUpdate = true;
      return encodeAnnotationComment({ ...annotation, ...cleanPatch });
    } catch {
      return full;
    }
  });
  if (!didUpdate) throw new Error(`InkLoop annotation was not found: ${koId}`);
  return refreshAnnotationFallbackSections(nextMarkdown);
}

function isDuplicateDocumentHeading(model: InkLoopVisualModel): boolean {
  const firstHeading = model.blocks.find((block) => block.kind === 'heading' || block.content.startsWith('#'));
  return normalizeText(firstHeading?.content) === normalizeText(model.documentTitle);
}

export function parseInkLoopVisualModel(markdown: string): InkLoopVisualModel | null {
  if (!markdown.includes('inkloop_projection_id')) return null;
  const titleMatch = markdown.replace(/^---[\s\S]*?---\s*/m, '').match(/^#\s+(.+)$/m);
  const blocks: InkLoopVisualBlock[] = [];
  const blockRegex = /<!--\s*inkloop:block-begin\s+([^>]*)-->\s*\n([\s\S]*?)\n<!--\s*inkloop:block-end\s+id=([^>]+?)\s*-->/g;
  const matches = [...markdown.matchAll(blockRegex)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const attrs = parseAttrs(match[1]);
    const blockId = attrs.id || match[3];
    const tailStart = (match.index ?? 0) + match[0].length;
    const tailEnd = matches[index + 1]?.index ?? markdown.indexOf('<!-- inkloop:document-end', tailStart);
    const tail = markdown.slice(tailStart, tailEnd === -1 ? undefined : tailEnd);
    blocks.push({
      id: blockId,
      kind: attrs.kind || 'paragraph',
      region: attrs.region || 'editable',
      page: attrs.page,
      bbox: attrs.bbox,
      content: match[2].trim(),
      annotations: parseAnnotationComments(tail),
    });
  }

  return { documentTitle: titleMatch?.[1]?.trim() || 'InkLoop document', blocks };
}

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
