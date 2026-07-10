import type { ConceptLayer, EntityMode } from 'ink-surface-sdk/export-core';
import type {
  DocumentProjection,
  KnowledgeKind,
  KnowledgeObject,
  KnowledgeRiskStatus,
  KnowledgeStatus,
} from 'ink-surface-sdk/knowledge-schema';
import { isStrokeOnlyAnnotation } from 'ink-surface-sdk/surface-model';
import type { InkLoopAnnotation, InkLoopVisualModel, InkLoopVisualStroke } from 'ink-surface-sdk/surface-model';

export interface VaultFolder {
  base_dir: string;
  documents_dir: string;
}

export interface ObsidianVaultEntityInput {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  dates?: string[];
  knowledgeObjects: KnowledgeObject[];
  documentProjections: DocumentProjection[];
  materialDocumentIds?: string[];
  visualModel?: InkLoopVisualModel;
}

export interface ObsidianVaultRenderInput {
  entities: ObsidianVaultEntityInput[];
  conceptLayer?: ConceptLayer;
}

export interface RenderedFile {
  path: string;
  markdown: string;
}

export const OBSIDIAN_CONTROLLED_FIELDS_MARKER = '<!-- inkloop:controlled-fields v1 -->' as const;

export interface ObsidianControlledKnowledgePatch {
  status?: KnowledgeStatus;
  tags?: string[];
  task_done?: boolean;
  risk_status?: KnowledgeRiskStatus;
  risk_note?: string;
  comment_md?: string;
}

export interface ObsidianControlledKnowledgeEdit {
  schema_version: 'inkloop.obsidian_controlled_knowledge_edit.v1';
  document_id: string;
  document_uri?: string;
  ko_id: string;
  kind: KnowledgeKind | string;
  patch: ObsidianControlledKnowledgePatch;
  source: 'obsidian_controlled_fields';
}

const RELATION_LABELS: Record<string, string> = {
  same_ai_turn: '同源笔记',
  same_context: '同场采集笔记',
  same_entity: '同实体笔记',
};

const MEETING_ONLY_KINDS = new Set<KnowledgeKind | string>([
  'task',
  'decision',
  'risk',
  'meeting_action',
  'meeting_decision',
  'meeting_risk',
]);

function knowledgeObjectsForEntity(entity: ObsidianVaultEntityInput): KnowledgeObject[] {
  if (entity.mode !== 'reading') return entity.knowledgeObjects;
  return entity.knowledgeObjects.filter((ko) => !MEETING_ONLY_KINDS.has(ko.kind));
}

function shouldRenderKnowledgeNote(
  entity: ObsidianVaultEntityInput,
  ko: KnowledgeObject,
  annotation?: InkLoopAnnotation,
): boolean {
  if (entity.mode !== 'meeting') return true;
  if (ko.kind !== 'annotation') return true;
  if (!annotation) return true;
  return !isStrokeOnlyAnnotation(annotation);
}

function renderableKnowledgeObjectsForEntity(
  entity: ObsidianVaultEntityInput,
  annotations: Map<string, InkLoopAnnotation>,
): KnowledgeObject[] {
  return knowledgeObjectsForEntity(entity).filter((ko) => shouldRenderKnowledgeNote(entity, ko, annotations.get(ko.ko_id)));
}

function cleanSegment(input: string): string {
  return input
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 96)
    .trim() || 'Untitled';
}

function cleanDocumentTitle(input: string): string {
  const segment = cleanSegment(input);
  return segment.replace(/\s*\.(?:md|markdown|pdf|epub)$/i, '').trim() || segment;
}

function shortId(input: string): string {
  return input.replace(/^ko_/, '').slice(0, 8);
}

function day(input?: string): string {
  return input && /^\d{4}-\d{2}-\d{2}/.test(input) ? input.slice(0, 10) : 'Undated';
}

function calloutOf(ko: KnowledgeObject): string {
  if (ko.render_hints?.markdown_callout) return ko.render_hints.markdown_callout;
  if (ko.kind === 'qa') return 'question';
  if (ko.kind === 'summary' || ko.kind === 'lesson_note' || ko.kind === 'reading_note') return 'summary';
  if (ko.kind === 'excerpt' || ko.kind === 'highlight') return 'quote';
  if (ko.kind === 'task' || ko.kind === 'meeting_action') return 'todo';
  if (ko.kind === 'risk' || ko.kind === 'meeting_risk') return 'warning';
  if (ko.kind === 'formula_step' || ko.kind === 'decision' || ko.kind === 'meeting_decision' || ko.kind === 'diagram') return 'tip';
  return 'note';
}

function noteBaseName(ko: Pick<KnowledgeObject, 'title' | 'ko_id'>): string {
  return `${cleanSegment(ko.title)} - ${shortId(ko.ko_id)}`;
}

function wikilink(baseName: string, _label?: string): string {
  const clean = cleanSegment(baseName);
  return `[[${clean}]]`;
}

function frontmatter(entries: Record<string, string | string[] | undefined>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function parseFrontmatter(markdown: string): Record<string, string | string[]> {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return {};
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return {};
  const lines = normalized.slice(4, end).split('\n');
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of lines) {
    const list = line.match(/^\s*-\s*(.+?)\s*$/);
    if (listKey && list) {
      const current = Array.isArray(out[listKey]) ? out[listKey] as string[] : [];
      current.push(unquoteYamlScalar(list[1]));
      out[listKey] = current;
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!entry) {
      listKey = null;
      continue;
    }
    const [, key, raw = ''] = entry;
    if (!raw.trim()) {
      out[key] = [];
      listKey = key;
    } else {
      out[key] = unquoteYamlScalar(raw);
      listKey = null;
    }
  }
  return out;
}

function unquoteYamlScalar(input: string): string {
  const value = input.trim();
  if (!value) return '';
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^['"]|['"]$/g, '');
  }
}

function controlledSection(markdown: string): string {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n');
  const markerIndex = normalized.indexOf(OBSIDIAN_CONTROLLED_FIELDS_MARKER);
  if (markerIndex === -1) return '';
  const afterMarker = normalized.slice(markerIndex + OBSIDIAN_CONTROLLED_FIELDS_MARKER.length);
  const nextHeading = afterMarker.search(/\n##\s+/);
  return (nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading)).trim();
}

function controlledLineValue(section: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^\\s*-\\s*${escaped}:\\s*(.*)$`, 'im'));
  return match ? match[1].trim() : undefined;
}

function parseTags(input: string | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  return input.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeKnowledgeStatus(input: string | undefined): KnowledgeStatus | undefined {
  if (!input) return undefined;
  const value = input.trim();
  return ['inbox', 'accepted', 'edited', 'follow_up', 'dismissed', 'export_ready', 'exported', 'archived'].includes(value)
    ? value as KnowledgeStatus
    : undefined;
}

function normalizeRiskStatus(input: string | undefined): KnowledgeRiskStatus | undefined {
  if (!input) return undefined;
  const value = input.trim();
  return ['open', 'watching', 'mitigated', 'closed'].includes(value)
    ? value as KnowledgeRiskStatus
    : undefined;
}

function taskDoneFromSection(section: string): boolean | undefined {
  const match = section.match(/^\s*-\s*\[([ xX])\]\s*Task done\s*$/im);
  if (!match) return undefined;
  return match[1].toLowerCase() === 'x';
}

function nonEmptyString(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  return input.trim();
}

function cleanPatch(patch: ObsidianControlledKnowledgePatch): ObsidianControlledKnowledgePatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined;
  })) as ObsidianControlledKnowledgePatch;
}

export function parseObsidianControlledKnowledgeEdit(markdown: string): ObsidianControlledKnowledgeEdit | null {
  const front = parseFrontmatter(markdown);
  const documentId = typeof front.inkloop_document_id === 'string' ? front.inkloop_document_id : '';
  const koId = typeof front.inkloop_knowledge_object_id === 'string' ? front.inkloop_knowledge_object_id : '';
  const kind = typeof front.inkloop_knowledge_kind === 'string' ? front.inkloop_knowledge_kind : '';
  if (!documentId || !koId || !kind) return null;

  const section = controlledSection(markdown);
  if (!section) return null;

  const patch = cleanPatch({
    status: normalizeKnowledgeStatus(controlledLineValue(section, 'Status')),
    tags: parseTags(controlledLineValue(section, 'Tags')),
    task_done: taskDoneFromSection(section),
    risk_status: normalizeRiskStatus(controlledLineValue(section, 'Risk status')),
    risk_note: nonEmptyString(controlledLineValue(section, 'Risk note')),
    comment_md: nonEmptyString(controlledLineValue(section, 'Comment')),
  });
  if (Object.keys(patch).length === 0) return null;

  return {
    schema_version: 'inkloop.obsidian_controlled_knowledge_edit.v1',
    document_id: documentId,
    document_uri: typeof front.inkloop_document_uri === 'string' ? front.inkloop_document_uri : undefined,
    ko_id: koId,
    kind,
    patch,
    source: 'obsidian_controlled_fields',
  };
}

function documentUri(documentId: string): string {
  return `inkloop://doc/${encodeURIComponent(documentId)}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function vaultFolderForEntity(input: {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  date?: string;
}): VaultFolder {
  const title = cleanDocumentTitle(input.documentTitle || input.documentId);
  if (input.mode === 'meeting') {
    const base = `InkLoop/Meetings/${day(input.date)} ${title}`;
    return { base_dir: base, documents_dir: base };
  }
  if (input.mode === 'diary') {
    const base = `InkLoop/Diary/${day(input.date)}`;
    return { base_dir: base, documents_dir: base };
  }
  const base = `InkLoop/Reading/${title}`;
  return { base_dir: base, documents_dir: base };
}

function folderForEntity(entity: ObsidianVaultEntityInput): VaultFolder {
  return vaultFolderForEntity({
    documentId: entity.documentId,
    documentTitle: entity.documentTitle,
    mode: entity.mode,
    date: entity.dates?.[0],
  });
}

function strokeKey(stroke: InkLoopVisualStroke): string {
  return JSON.stringify({
    tool: stroke.tool,
    color: stroke.color ?? '',
    opacity: stroke.opacity ?? '',
    points: stroke.points.map((point) => [
      Number(point.x).toFixed(4),
      Number(point.y).toFixed(4),
      point.pressure == null ? '' : Number(point.pressure).toFixed(4),
    ]),
  });
}

function annotationStrokes(annotation: InkLoopAnnotation | undefined): InkLoopVisualStroke[] {
  const seen = new Set<string>();
  const out: InkLoopVisualStroke[] = [];
  for (const stroke of [...(annotation?.visual_strokes ?? []), ...(annotation?.surface_strokes ?? [])]) {
    if ((stroke.points?.length ?? 0) <= 1) continue;
    const key = strokeKey(stroke);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stroke);
  }
  return out;
}

function svgNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function svgPointValue(value: number, normalized: boolean): number {
  const number = normalized ? value * 100 : value;
  return Math.round(number * 100) / 100;
}

function svgStrokePath(points: Array<{ x: number; y: number }>, normalized: boolean): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${svgPointValue(point.x, normalized)},${svgPointValue(point.y, normalized)}`)
    .join(' ');
}

const MEETING_PAGE_W = 1000;
const MEETING_PAGE_H = 1242;

function meetingStrokePath(points: Array<{ x: number; y: number }>, normalized: boolean): string {
  return points
    .map((point, index) => {
      const x = normalized ? point.x * MEETING_PAGE_W : point.x;
      const y = normalized ? point.y * MEETING_PAGE_H : point.y;
      return `${index === 0 ? 'M' : 'L'}${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(' ');
}

function escapeCssClass(input: string | undefined): string {
  return String(input || 'pen').replace(/[^a-zA-Z0-9_-]/g, '') || 'pen';
}

function renderStrokePaths(strokes: InkLoopVisualStroke[], normalized: boolean): string {
  return strokes.map((stroke) => {
    const tool = escapeCssClass(stroke.tool);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(stroke.color || '')) ? String(stroke.color) : '#1A1A1A';
    const opacity = Math.min(1, Math.max(0.08, Number(stroke.opacity) || (tool === 'highlighter' ? 0.48 : 0.92)));
    const width = tool === 'highlighter' ? 12 : tool === 'underline' ? 4 : 3.2;
    return `<path class="inkloop-meeting-ink-path is-${escapeHtml(tool)}" d="${escapeHtml(meetingStrokePath(stroke.points, normalized))}" fill="none" stroke="${escapeHtml(color)}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
}

function meetingHandwritingSections(entity: ObsidianVaultEntityInput, annotations: Map<string, InkLoopAnnotation>): string {
  if (entity.mode !== 'meeting') return '';
  const pages = new Map<number, InkLoopVisualStroke[]>();
  for (const block of entity.visualModel?.blocks ?? []) {
    const blockPage = Number(block.page);
    for (const annotation of block.annotations ?? []) {
      const ko = entity.knowledgeObjects.find((item) => item.ko_id === annotation.ko_id);
      if (!ko || shouldRenderKnowledgeNote(entity, ko, annotations.get(ko.ko_id))) continue;
      const strokes = annotationStrokes(annotation)
        .filter((stroke) => (stroke.coord_space ?? annotation.surface_coord_space ?? 'page_norm') !== 'block_norm')
        .map((stroke) => ({
          ...stroke,
          points: stroke.points.map((point) => ({ x: svgNumber(point.x), y: svgNumber(point.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
        }))
        .filter((stroke) => stroke.points.length > 1);
      if (!strokes.length) continue;
      const pageIndex = Number.isFinite(annotation.page_index) ? Number(annotation.page_index) : Number.isFinite(blockPage) ? blockPage : 0;
      pages.set(pageIndex, [...(pages.get(pageIndex) ?? []), ...strokes]);
    }
  }
  if (!pages.size) return '';
  const sections: string[] = ['## 手写记录'];
  for (const [pageIndex, strokes] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    const allPoints = strokes.flatMap((stroke) => stroke.points);
    const normalized = allPoints.every((point) => point.x >= -0.05 && point.x <= 1.05 && point.y >= -0.05 && point.y <= 1.05);
    const xs = normalized ? [0, MEETING_PAGE_W] : allPoints.map((point) => point.x);
    const ys = normalized ? [0, MEETING_PAGE_H] : allPoints.map((point) => point.y);
    const pad = normalized ? 0 : 18;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const maxX = Math.max(...xs) + pad;
    const maxY = Math.max(...ys) + pad;
    sections.push(
      `### 原始手记第 ${pageIndex + 1} 页`,
      `<svg class="inkloop-meeting-ink-page" data-inkloop-page="${pageIndex}" viewBox="${Math.round(minX * 100) / 100} ${Math.round(minY * 100) / 100} ${Math.round(Math.max(1, maxX - minX) * 100) / 100} ${Math.round(Math.max(1, maxY - minY) * 100) / 100}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="InkLoop meeting handwriting page ${pageIndex + 1}" style="display:block;width:100%;max-width:760px;aspect-ratio:${MEETING_PAGE_W}/${MEETING_PAGE_H};margin:12px 0 20px;border:1px solid rgba(148,163,184,0.35);border-radius:8px;background:rgba(248,250,252,0.72)">`
        + renderStrokePaths(strokes, normalized)
        + '</svg>',
    );
  }
  return sections.join('\n\n');
}

function svgForAnnotation(annotation: InkLoopAnnotation | undefined): string {
  const strokes = annotationStrokes(annotation).map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ x: svgNumber(point.x), y: svgNumber(point.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  })).filter((stroke) => stroke.points.length > 1);
  if (!strokes.length) return '';

  const allPoints = strokes.flatMap((stroke) => stroke.points);
  const normalized = allPoints.every((point) => point.x >= -0.05 && point.x <= 1.05 && point.y >= -0.05 && point.y <= 1.05);
  const xs = allPoints.map((point) => svgPointValue(point.x, normalized));
  const ys = allPoints.map((point) => svgPointValue(point.y, normalized));
  const minX = normalized ? 0 : Math.min(...xs);
  const minY = normalized ? 0 : Math.min(...ys);
  const maxX = normalized ? 100 : Math.max(...xs);
  const maxY = normalized ? 100 : Math.max(...ys);
  const pad = normalized ? 0 : 12;
  const viewBox = [
    Math.round((minX - pad) * 100) / 100,
    Math.round((minY - pad) * 100) / 100,
    Math.max(1, Math.round((maxX - minX + pad * 2) * 100) / 100),
    Math.max(1, Math.round((maxY - minY + pad * 2) * 100) / 100),
  ].join(' ');
  const paths = strokes.map((stroke) => {
    const tool = String(stroke.tool || 'pen').replace(/[^a-zA-Z0-9_-]/g, '');
    const color = /^#[0-9a-fA-F]{6}$/.test(String(stroke.color || '')) ? String(stroke.color) : '#38bdf8';
    const opacity = Math.min(1, Math.max(0.08, Number(stroke.opacity) || (tool === 'highlighter' ? 0.48 : 0.92)));
    const width = tool === 'highlighter' ? 4.8 : 2.4;
    return `<path class="inkloop-cloud-mark-freehand is-${escapeHtml(tool)}" d="${escapeHtml(svgStrokePath(stroke.points, normalized))}" fill="none" stroke="${escapeHtml(color)}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return [
    `<svg class="inkloop-cloud-mark-layer" data-inkloop-knowledge-object="${escapeHtml(annotation?.ko_id || '')}" viewBox="${escapeHtml(viewBox)}" preserveAspectRatio="none" role="img" aria-label="InkLoop mark" style="display:block;width:100%;height:120px;margin:12px 0;border:1px solid rgba(148,163,184,0.35);border-radius:8px;background:rgba(248,250,252,0.72)">`,
    paths,
    '</svg>',
  ].join('');
}

function annotationsByKo(input: ObsidianVaultRenderInput): Map<string, InkLoopAnnotation> {
  const map = new Map<string, InkLoopAnnotation>();
  for (const entity of input.entities) {
    for (const block of entity.visualModel?.blocks ?? []) {
      for (const annotation of block.annotations ?? []) {
        if (!map.has(annotation.ko_id)) map.set(annotation.ko_id, annotation);
      }
    }
  }
  return map;
}

function renderProjectionBlocks(projection: DocumentProjection): string {
  const out: string[] = [];
  for (const block of projection.blocks ?? []) {
    const anchor = `^${block.block_id}`;
    if (block.kind === 'heading') out.push(`${'#'.repeat(Math.min(6, Math.max(1, block.heading_level ?? 2)))} ${block.text_md}\n${anchor}`);
    else out.push(`${block.text_md}\n${anchor}`);
  }
  return out.join('\n\n');
}

function sourceRefSummary(ref: unknown): string {
  const item = ref as Record<string, unknown>;
  if (item.ref_type === 'document') {
    const page = typeof item.page_index === 'number' ? `page ${item.page_index + 1}` : String(item.page_id || '');
    const quote = item.quote ? ` - ${String(item.quote)}` : '';
    return `document ${String(item.document_id || '')} ${page}${quote}`.trim();
  }
  if (item.ref_type === 'meeting_mark') {
    const seconds = typeof item.time_ms === 'number' ? ` @${Math.round(item.time_ms / 1000)}s` : '';
    return `meeting_mark ${String(item.meeting_id || '')}/${String(item.meeting_mark_id || '')}${seconds}`.trim();
  }
  if (item.ref_type === 'project_memory') return `project_memory ${String(item.kind || '')}: ${String(item.title || '')}`.trim();
  if (item.type === 'ink_event') return `ink_event ${String(item.event_id || '')}`.trim();
  if (item.type === 'board_object') return `board_object ${String(item.object_type || '')}:${String(item.object_id || '')}`.trim();
  if (item.type === 'audio_segment') return `audio ${String(item.start_ms || '')}-${String(item.end_ms || '')}`.trim();
  return JSON.stringify(ref);
}

function renderStructuredSourceRefs(ko: KnowledgeObject): string {
  const refs = ko.source_refs ?? [];
  if (!refs.length) return '';
  return [
    '## Source Refs',
    ...refs.map((ref) => `- ${sourceRefSummary(ref)}`),
    '',
    '```json',
    JSON.stringify(refs, null, 2),
    '```',
  ].join('\n');
}

function renderControlledFields(ko: KnowledgeObject): string {
  const lines = [
    '## Controlled Fields',
    OBSIDIAN_CONTROLLED_FIELDS_MARKER,
    `- Status: ${ko.status}`,
    `- Tags: ${ko.tags.join(', ')}`,
  ];
  if (ko.kind === 'task' || ko.kind === 'meeting_action') {
    lines.push(`- [${ko.controlled_fields?.task_done ? 'x' : ' '}] Task done`);
  }
  if (ko.kind === 'risk' || ko.kind === 'meeting_risk') {
    lines.push(`- Risk status: ${ko.controlled_fields?.risk_status ?? 'open'}`);
    lines.push(`- Risk note: ${ko.controlled_fields?.risk_note ?? ''}`);
  }
  if (ko.kind === 'highlight' || ko.kind === 'excerpt' || ko.kind === 'annotation') {
    lines.push(`- Comment: ${ko.controlled_fields?.comment_md ?? ''}`);
  }
  return lines.join('\n');
}

function renderEntityHub(entity: ObsidianVaultEntityInput, input: ObsidianVaultRenderInput, noteNames: Map<string, string>): RenderedFile {
  const folder = folderForEntity(entity);
  const title = cleanDocumentTitle(entity.documentTitle || entity.documentId);
  const uri = documentUri(entity.documentId);
  const annotations = annotationsByKo(input);
  const lines = [
    frontmatter({
      inkloop_document_id: entity.documentId,
      inkloop_document_uri: uri,
      inkloop_projection_role: 'source_file_unit',
      inkloop_mode: entity.mode,
      inkloop_projection_scope: 'reviewed_knowledge_only',
    }),
    `# ${title}`,
    '## Source File',
    [
      `- InkLoop document: ${uri}`,
      '- Unit: source file/session; Obsidian notes below are reviewed projections derived from this unit.',
      entity.mode === 'meeting'
        ? '- Boundary: meeting tasks, decisions, risks, and summaries are editable Markdown projections, not canonical InkEvents.'
        : '- Boundary: reading summaries, highlights, handwritten thoughts, and AI brush responses are editable Markdown projections, not canonical InkEvents.',
    ].join('\n'),
  ];
  const projectionBody = entity.documentProjections.map(renderProjectionBlocks).filter(Boolean).join('\n\n');
  if (projectionBody) lines.push('## 文档', projectionBody);
  if (entity.materialDocumentIds?.length) {
    const byId = new Map(input.entities.map((item) => [item.documentId, item] as const));
    const links = entity.materialDocumentIds
      .map((id) => byId.get(id))
      .filter((item): item is ObsidianVaultEntityInput => !!item)
      .map((item) => `- ${wikilink(item.documentTitle)}`);
    if (links.length) lines.push('## 引用资料', links.join('\n'));
  }
  const handwriting = meetingHandwritingSections(entity, annotations);
  if (handwriting) lines.push(handwriting);
  const knowledgeObjects = renderableKnowledgeObjectsForEntity(entity, annotations);
  if (knowledgeObjects.length) {
    lines.push('## 笔记', knowledgeObjects.map((ko) => `- ${wikilink(noteNames.get(ko.ko_id) ?? noteBaseName(ko), ko.title)}`).join('\n'));
  }
  return { path: `${folder.base_dir}/${title}.md`, markdown: `${lines.join('\n\n')}\n` };
}

function renderKoNote(
  ko: KnowledgeObject,
  entity: ObsidianVaultEntityInput,
  input: ObsidianVaultRenderInput,
  noteNames: Map<string, string>,
  annotation: InkLoopAnnotation | undefined,
): RenderedFile {
  const folder = folderForEntity(entity);
  const base = noteNames.get(ko.ko_id) ?? noteBaseName(ko);
  const lines = [
    frontmatter({
      inkloop_document_id: ko.source.document_id,
      inkloop_document_uri: ko.source.inkloop_uri,
      inkloop_knowledge_object_id: ko.ko_id,
      inkloop_knowledge_kind: ko.kind,
      inkloop_projection_role: 'knowledge_projection',
      inkloop_projection_scope: 'reviewed_knowledge_only',
      inkloop_status: ko.status,
      tags: ko.tags,
    }),
    `# ${ko.title}`,
    `> [!${calloutOf(ko)}] ${ko.title}`,
  ];
  const body = ko.body_md.trim();
  if (body) lines.push(body.split('\n').map((line) => `> ${line}`).join('\n'));
  const structuredRefs = renderStructuredSourceRefs(ko);
  if (structuredRefs) lines.push(structuredRefs);
  lines.push(renderControlledFields(ko));
  const svg = svgForAnnotation(annotation);
  if (svg) lines.push(svg);

  const concepts = [
    ...(input.conceptLayer?.assignmentsByKo?.[ko.ko_id] ?? []),
    ...(input.conceptLayer?.localByKo?.[ko.ko_id] ?? []),
  ];
  const uniqueConcepts = [...new Set(concepts)];
  if (uniqueConcepts.length) lines.push(`**相关概念** ${uniqueConcepts.map((name) => wikilink(name)).join(' ')}`);

  const grouped = new Map<string, string[]>();
  for (const relation of input.conceptLayer?.relationsByKo?.[ko.ko_id] ?? []) {
    const label = RELATION_LABELS[relation.kind] ?? relation.kind;
    const peer = noteNames.get(relation.ko_id);
    if (!peer) continue;
    const bucket = grouped.get(label) ?? [];
    bucket.push(wikilink(peer));
    grouped.set(label, bucket);
  }
  for (const [label, links] of grouped) lines.push(`**${label}** ${[...new Set(links)].join(' ')}`);

  return { path: `${folder.base_dir}/${base}.md`, markdown: `${lines.join('\n\n')}\n` };
}

function renderConceptHub(title: string, input: ObsidianVaultRenderInput, noteNames: Map<string, string>): RenderedFile {
  const members = [
    ...(input.conceptLayer?.membersByConcept?.[title] ?? []),
    ...(input.conceptLayer?.membersByEntity?.[title] ?? []),
  ];
  const lines = [`# ${title}`, '## 相关笔记'];
  const links = [...new Set(members)]
    .map((koId) => noteNames.get(koId))
    .filter((name): name is string => !!name)
    .map((name) => `- ${wikilink(name)}`);
  lines.push(links.length ? links.join('\n') : '暂无');
  return { path: `InkLoop/Concepts/${cleanSegment(title)}.md`, markdown: `${lines.join('\n\n')}\n` };
}

export function renderVaultMarkdown(input: ObsidianVaultRenderInput): RenderedFile[] {
  const files: RenderedFile[] = [];
  const noteNames = new Map<string, string>();
  const annotations = annotationsByKo(input);
  for (const entity of input.entities) {
    for (const ko of renderableKnowledgeObjectsForEntity(entity, annotations)) noteNames.set(ko.ko_id, noteBaseName(ko));
  }

  for (const entity of input.entities) {
    files.push(renderEntityHub(entity, input, noteNames));
    for (const ko of renderableKnowledgeObjectsForEntity(entity, annotations)) {
      files.push(renderKoNote(ko, entity, input, noteNames, annotations.get(ko.ko_id)));
    }
  }

  const conceptTitles = new Set<string>();
  for (const hub of input.conceptLayer?.hubs ?? []) conceptTitles.add(hub.title);
  for (const concept of input.conceptLayer?.concepts ?? []) conceptTitles.add(concept.title);
  for (const title of conceptTitles) files.push(renderConceptHub(title, input, noteNames));

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
