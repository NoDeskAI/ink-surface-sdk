import { sha256Tagged } from '../../knowledge/hash';
import type { Sha256 } from '../../knowledge/knowledge-object';

export const OBSIDIAN_MAPPING_VERSION = 'inkloop.obsidian.mapping.v1';

export interface InkloopSection {
  koId: string;
  hash?: Sha256;
  mapping?: string;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  body: string;
}

export type ReplaceResult =
  | { type: 'replaced'; markdown: string }
  | { type: 'missing_section' }
  | { type: 'duplicate_sections' }
  | { type: 'controlled_section_modified'; currentSectionHash: Sha256 };

const beginPattern = /<!--\s*inkloop:begin\s+([^>]+?)\s*-->/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.trim().split(/\s+/)) {
    const [key, value] = part.split('=');
    if (key && value) out[key] = value;
  }
  return out;
}

export function renderControlledSection(input: {
  koId: string;
  renderBodyHash: Sha256;
  body: string;
}): string {
  return [
    `<!-- inkloop:begin ko=${input.koId} hash=${input.renderBodyHash} mapping=${OBSIDIAN_MAPPING_VERSION} -->`,
    '',
    input.body.trimEnd(),
    '',
    `<!-- inkloop:end ko=${input.koId} -->`,
  ].join('\n');
}

export function findInkloopSections(markdown: string, koId: string): InkloopSection[] {
  const sections: InkloopSection[] = [];
  beginPattern.lastIndex = 0;

  for (let match = beginPattern.exec(markdown); match; match = beginPattern.exec(markdown)) {
    const parsed = attrs(match[1]);
    if (parsed.ko !== koId) continue;

    const endPattern = new RegExp(`<!--\\s*inkloop:end\\s+ko=${koId}\\s*-->`, 'g');
    endPattern.lastIndex = beginPattern.lastIndex;
    const endMatch = endPattern.exec(markdown);
    if (!endMatch) continue;

    const bodyStart = match.index + match[0].length;
    const bodyEnd = endMatch.index;
    sections.push({
      koId,
      hash: parsed.hash as Sha256 | undefined,
      mapping: parsed.mapping,
      start: match.index,
      end: endMatch.index + endMatch[0].length,
      bodyStart,
      bodyEnd,
      body: markdown.slice(bodyStart, bodyEnd),
    });
  }

  return sections;
}

export async function hashSectionBody(body: string): Promise<Sha256> {
  return sha256Tagged(body.trim());
}

export async function replaceControlledSection(input: {
  existingMarkdown: string;
  koId: string;
  oldRenderBodyHash?: Sha256;
  newSection: string;
}): Promise<ReplaceResult> {
  const sections = findInkloopSections(input.existingMarkdown, input.koId);
  if (sections.length === 0) return { type: 'missing_section' };
  if (sections.length > 1) return { type: 'duplicate_sections' };

  const [section] = sections;
  const currentSectionHash = await hashSectionBody(section.body);
  if (input.oldRenderBodyHash && currentSectionHash !== input.oldRenderBodyHash) {
    return { type: 'controlled_section_modified', currentSectionHash };
  }

  return {
    type: 'replaced',
    markdown: `${input.existingMarkdown.slice(0, section.start)}${input.newSection}${input.existingMarkdown.slice(section.end)}`,
  };
}

export function snapshotAndReplaceControlledSection(input: {
  existingMarkdown: string;
  section: InkloopSection;
  newSection: string;
  detectedAt: string;
}): string {
  const snapshot = [
    `<!-- inkloop:snapshot-begin ko=${input.section.koId} original_hash=${input.section.hash ?? 'unknown'} detected=${input.detectedAt} -->`,
    input.section.body.trim(),
    `<!-- inkloop:snapshot-end ko=${input.section.koId} -->`,
    '',
    input.newSection,
  ].join('\n');
  return `${input.existingMarkdown.slice(0, input.section.start)}${snapshot}${input.existingMarkdown.slice(input.section.end)}`;
}
