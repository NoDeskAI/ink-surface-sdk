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

export function isStrokeOnlyAnnotation(annotation: InkLoopAnnotation): boolean {
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

export function isDuplicateDocumentHeading(model: InkLoopVisualModel): boolean {
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
