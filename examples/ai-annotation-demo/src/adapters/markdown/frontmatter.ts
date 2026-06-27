import type { KnowledgeObject, Sha256 } from '../../knowledge/knowledge-object';

export type FrontmatterValue = string | number | boolean | string[] | number[] | undefined;
export type Frontmatter = Record<string, FrontmatterValue>;

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function renderFrontmatterObject(frontmatter: Frontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

export function frontmatterForKnowledgeObject(ko: KnowledgeObject, renderBodyHash: Sha256): Frontmatter {
  return {
    inkloop_id: ko.ko_id,
    inkloop_schema: ko.schema_version,
    inkloop_kind: ko.kind,
    inkloop_status: ko.status,
    inkloop_content_hash: ko.content_hash,
    inkloop_render_body_hash: renderBodyHash,
    document_id: ko.source.document_id,
    document_title: ko.source.document_title,
    page_index: ko.source.page_index,
    page: ko.source.page_index === undefined ? undefined : ko.source.page_index + 1,
    object_refs: ko.source.object_refs,
    anchor_bbox: ko.source.anchor_bbox,
    inkloop_uri: ko.source.inkloop_uri,
    created: ko.created_at,
    updated: ko.updated_at,
    completed: ko.kind === 'task' ? false : undefined,
    tags: ko.tags,
  };
}

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
  start: number;
  end: number;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter | null {
  if (!markdown.startsWith('---\n')) return null;
  const close = markdown.indexOf('\n---', 4);
  if (close === -1) return null;
  const raw = markdown.slice(4, close);
  const frontmatter: Record<string, unknown> = {};
  let currentListKey: string | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentListKey) {
      (frontmatter[currentListKey] as unknown[]).push(parseScalar(listMatch[1]));
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    if (!rest.trim()) {
      frontmatter[key] = [];
      currentListKey = key;
    } else {
      frontmatter[key] = parseScalar(rest);
      currentListKey = null;
    }
  }

  const end = close + '\n---'.length;
  return {
    frontmatter,
    body: markdown.slice(markdown[end] === '\n' ? end + 1 : end),
    start: 0,
    end: markdown[end] === '\n' ? end + 1 : end,
  };
}

export function replaceFrontmatter(markdown: string, nextFrontmatter: Frontmatter): string {
  const rendered = renderFrontmatterObject(nextFrontmatter);
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return `${rendered}\n${markdown}`;
  return `${rendered}\n${markdown.slice(parsed.end)}`;
}
