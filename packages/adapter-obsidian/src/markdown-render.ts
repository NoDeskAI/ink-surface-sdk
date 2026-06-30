import { MODE_NOUN, tagSlug, type ConceptLayer, type EntityMode } from '../../export-core/src/index.js';
import type { DocumentProjection, DocumentProjectionBlock, KnowledgeObject } from '../../knowledge-schema/src/index.js';
import { sanitizeName, VAULT_ROOT_DIR, vaultFolderForEntity, type VaultFolder } from './vault-layout.js';

export interface RenderedFile {
  path: string;
  markdown: string;
}

export interface ObsidianVaultEntityInput {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  dates: readonly string[];
  knowledgeObjects: readonly KnowledgeObject[];
  documentProjections: readonly DocumentProjection[];
}

export interface ObsidianVaultRenderInput {
  entities: readonly ObsidianVaultEntityInput[];
  conceptLayer?: ConceptLayer;
}

interface ResolvedEntity extends Omit<ObsidianVaultEntityInput, 'dates'> {
  dates: string[];
  folder: VaultFolder;
}

const MODE_LABEL: Record<EntityMode, string> = { reading: '阅读', diary: '日记', meeting: '会议' };
const MODE_VERB: Record<EntityMode, string> = { reading: '读了', meeting: '开了', diary: '写了' };
const MODE_ORDER: EntityMode[] = ['reading', 'meeting', 'diary'];

const CALLOUT: Record<string, string> = {
  ai_note: 'note',
  qa: 'question',
  excerpt: 'quote',
  annotation: 'note',
  summary: 'summary',
  concept: 'tip',
  task: 'todo',
};

function excerpt(input: string, limit = 32): string {
  const stripped = sanitizeName(input).replace(/[\s]*[(（]约[^)）]*处手写[)）]\s*$/u, '').trim();
  const chars = [...(stripped || sanitizeName(input))];
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
}

function makeNamer(): (base: string) => string {
  const used = new Set<string>();
  const key = (input: string): string => input.normalize('NFKC').toLocaleLowerCase('en-US');

  return (base: string): string => {
    const root = sanitizeName(base);
    if (!used.has(key(root))) {
      used.add(key(root));
      return root;
    }

    for (let index = 2; ; index += 1) {
      const candidate = `${root} ${index}`;
      if (!used.has(key(candidate))) {
        used.add(key(candidate));
        return candidate;
      }
    }
  };
}

const yamlStr = (input: string): string => JSON.stringify(input);
const fm = (tags: readonly string[]): string => ['---', 'tags:', ...[...new Set(tags)].map((tag) => `  - ${yamlStr(tag)}`), '---'].join('\n');
const wl = (name: string): string => `[[${name}]]`;

const calloutOf = (kind: string, body: string): string => {
  const type = CALLOUT[kind] ?? 'note';
  return [`> [!${type}] InkLoop`, ...body.split('\n').map((line) => `> ${line}`)].join('\n');
};

const escapeWiki = (input: string): string => input.replace(/\[\[/g, '\\[\\[').replace(/\]\]/g, '\\]\\]');
const headingText = (input: string): string => escapeWiki(input).replace(/\s+/g, ' ').trim();

const paragraphText = (input: string): string =>
  escapeWiki(input.trim())
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s{0,3})(#{1,6})(\s+)/u, '$1\\$2$3')
        .replace(/^(\s{0,3})>/u, '$1\\>')
        .replace(/^(\s{0,3})([-+*])(\s+)/u, '$1\\$2$3')
        .replace(/^(\s{0,3})(\d+\.)(\s+)/u, '$1\\$2$3'),
    )
    .join('\n');

const renderBlocks = (blocks: readonly DocumentProjectionBlock[]): string =>
  blocks
    .map((block) => (block.kind === 'heading' ? `## ${headingText(block.text_md)}` : paragraphText(block.text_md)))
    .filter((text) => text.length > 0)
    .join('\n\n');

const day = (input: string): string | undefined => (/^\d{4}-\d{2}-\d{2}/.test(input) ? input.slice(0, 10) : undefined);

function normalizeDates(dates: readonly string[]): string[] {
  return [...new Set(dates.map(day).filter((date): date is string => !!date))].sort();
}

function resolveEntities(entities: readonly ObsidianVaultEntityInput[]): ResolvedEntity[] {
  return entities.map((entity) => {
    const dates = normalizeDates(entity.dates);
    const folder = vaultFolderForEntity({
      documentId: entity.documentId,
      documentTitle: entity.documentTitle,
      mode: entity.mode,
      date: dates[0],
    });

    return { ...entity, dates, folder };
  });
}

interface Named {
  entity: ResolvedEntity;
  hubName: string;
  dir: string;
  leaves: Array<{ ko: KnowledgeObject; name: string }>;
}

/**
 * bundle -> clean human-readable Obsidian markdown (Vision A knowledge graph).
 * Pure & deterministic. Zero sidecar: every file is a vanilla `.md`, every
 * wikilink resolves to a clean unique basename allocated here.
 */
export function renderVaultMarkdown(input: ObsidianVaultRenderInput): RenderedFile[] {
  const namer = makeNamer();
  const files: RenderedFile[] = [];
  const entities = resolveEntities(input.entities);

  const named: Named[] = entities.map((entity) => {
    const hubName = namer(entity.documentTitle);
    const dir = entity.folder.documents_dir;
    const leaves = entity.knowledgeObjects.map((ko) => ({ ko, name: namer(excerpt(ko.body_md) || ko.kind) }));
    return { entity, hubName, dir, leaves };
  });

  const hubByDoc = new Map(named.map((item) => [item.entity.documentId, item] as const));
  const koLeafName = new Map(named.flatMap((item) => item.leaves.map((leaf) => [leaf.ko.ko_id, leaf.name] as const)));

  const concepts = input.conceptLayer?.concepts ?? [];
  const conceptHubName = new Map(concepts.map((concept) => [concept.title, namer(concept.title)] as const));
  const assignmentsByKo = input.conceptLayer?.assignmentsByKo ?? {};
  const membersByConcept = input.conceptLayer?.membersByConcept ?? {};
  const localByKo = input.conceptLayer?.localByKo ?? {};

  const allDates = [...new Set(entities.flatMap((entity) => entity.dates))].sort();
  const dateName = new Map(allDates.map((date) => [date, namer(date)] as const));
  const presentModes = MODE_ORDER.filter((mode) => entities.some((entity) => entity.mode === mode));
  const modeMocName = new Map(presentModes.map((mode) => [mode, namer(`${MODE_LABEL[mode]} · 全部`)] as const));
  const rootName = namer('InkLoop 总览');

  for (const namedEntity of named) {
    const { entity, hubName, dir, leaves } = namedEntity;
    const hubTags = ['inkloop', `inkloop/${entity.mode}`, `inkloop/${MODE_NOUN[entity.mode]}/${tagSlug(entity.documentTitle)}`];
    const body: string[] = [fm(hubTags), '', `# ${entity.documentTitle}`, ''];

    if (entity.mode === 'meeting') {
      const text = renderBlocks(entity.documentProjections[0]?.blocks ?? []);
      if (text) body.push(text, '');
    }

    if (leaves.length) {
      body.push('## 笔记', '', ...leaves.map((leaf) => `- ${wl(leaf.name)}`), '');
    }

    files.push({ path: `${dir}/${hubName}.md`, markdown: `${body.join('\n').trimEnd()}\n` });

    for (const { ko, name } of leaves) {
      const conceptNames = assignmentsByKo[ko.ko_id] ?? [];
      const localNames = localByKo[ko.ko_id] ?? [];
      const tags = [...ko.tags, ...[...conceptNames, ...localNames].map((concept) => `inkloop/topic/${tagSlug(concept)}`)];
      const leaf = [fm(tags), '', `# ${name}`, '', calloutOf(ko.kind, ko.body_md.trim()), '', `**来源**：${wl(hubName)}`];

      if (conceptNames.length) {
        leaf.push('', `**相关概念**：${conceptNames.map((concept) => wl(conceptHubName.get(concept) ?? concept)).join('、')}`);
      }

      files.push({ path: `${dir}/${name}.md`, markdown: `${leaf.join('\n')}\n` });
    }
  }

  for (const concept of concepts) {
    const hub = conceptHubName.get(concept.title) ?? concept.title;
    const memberLinks = (membersByConcept[concept.title] ?? [])
      .map((koId) => koLeafName.get(koId))
      .filter((name): name is string => !!name)
      .map(wl);

    const lines = [fm(['inkloop', 'inkloop/concept', `inkloop/topic/${tagSlug(concept.title)}`]), '', `# ${concept.title}`, ''];
    if (memberLinks.length) lines.push('## 相关笔记', '', ...memberLinks.map((link) => `- ${link}`), '');

    files.push({ path: `${VAULT_ROOT_DIR}/Concepts/${hub}.md`, markdown: `${lines.join('\n').trimEnd()}\n` });
  }

  for (const date of allDates) {
    const active = entities.filter((entity) => entity.dates.includes(date));
    const groups = MODE_ORDER.map((mode) => ({ mode, items: active.filter((entity) => entity.mode === mode) })).filter((group) => group.items.length);
    const link = (entity: ResolvedEntity): string => wl(hubByDoc.get(entity.documentId)!.hubName);
    const sentence = groups.map((group) => `${MODE_VERB[group.mode]} ${group.items.map(link).join('、')}`).join('，');
    const lines = [fm(['inkloop', 'inkloop/moc', `inkloop/date/${date}`]), '', `# ${date}`, ''];

    if (sentence) lines.push(`${date} ${sentence}。`, '');
    for (const group of groups) lines.push(`## ${MODE_LABEL[group.mode]}`, '', ...group.items.map((entity) => `- ${link(entity)}`), '');

    files.push({ path: `${VAULT_ROOT_DIR}/${dateName.get(date)}.md`, markdown: `${lines.join('\n').trimEnd()}\n` });
  }

  for (const mode of presentModes) {
    const items = entities.filter((entity) => entity.mode === mode);
    const lines = [
      fm(['inkloop', 'inkloop/moc', `inkloop/${mode}`]),
      '',
      `# ${MODE_LABEL[mode]} · 全部`,
      '',
      ...items.map((entity) => `- ${wl(hubByDoc.get(entity.documentId)!.hubName)}`),
    ];

    files.push({ path: `${VAULT_ROOT_DIR}/${modeMocName.get(mode)}.md`, markdown: `${lines.join('\n')}\n` });
  }

  const recent = [...allDates].reverse().slice(0, 30);
  const root = [fm(['inkloop', 'inkloop/moc']), '', '# InkLoop 总览', '', '## 模式', '', ...presentModes.map((mode) => `- ${wl(modeMocName.get(mode)!)}`), ''];

  if (recent.length) root.push('## 最近', '', ...recent.map((date) => `- ${wl(dateName.get(date)!)}`), '');

  files.push({ path: `${VAULT_ROOT_DIR}/${rootName}.md`, markdown: `${root.join('\n').trimEnd()}\n` });

  return files;
}
