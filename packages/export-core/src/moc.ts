import { sha256Hex } from '../../knowledge-schema/src/index.js';
import type { EntityMode } from './entity-mode.js';

export interface MocEntity {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  dates: readonly string[];
}

export type MocKind = 'daily' | 'mode' | 'root';
export type MocSectionKind = 'entities' | 'mocs' | 'recent';

export interface MocEntityTarget {
  type: 'entity';
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
}

export interface MocReferenceTarget {
  type: 'moc';
  mocId: string;
  mocKind: MocKind;
  title: string;
  mode?: EntityMode;
  date?: string;
}

export type MocTarget = MocEntityTarget | MocReferenceTarget;

export interface MocItem {
  itemId: string;
  label: string;
  target: MocTarget;
}

export interface MocSection {
  sectionId: string;
  kind: MocSectionKind;
  title: string;
  mode?: EntityMode;
  items: readonly MocItem[];
}

export interface MocDailySummaryClause {
  mode: EntityMode;
  entityDocumentIds: readonly string[];
}

export interface MocDailySummary {
  date: string;
  clauses: readonly MocDailySummaryClause[];
}

export interface MocModel {
  mocId: string;
  kind: MocKind;
  title: string;
  mode?: EntityMode;
  date?: string;
  tags: readonly string[];
  sections: readonly MocSection[];
  summary?: MocDailySummary;
}

export interface MocModeGroup {
  mode: EntityMode;
  items: readonly MocEntity[];
}

export interface BuildMocModelsOptions {
  recentDailyLimit?: number;
}

export const MOC_ROOT_ID = 'moc_root';
export const MOC_ROOT_TITLE = 'InkLoop';
export const MOC_MODE_ORDER: readonly EntityMode[] = ['reading', 'meeting', 'diary'];

const compareText = (a: string, b: string): number => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
const compareEntity = (a: MocEntity, b: MocEntity): number =>
  compareText(a.documentTitle, b.documentTitle) || compareText(a.documentId, b.documentId);

export function modeMocId(mode: EntityMode): string {
  return `moc_mode_${mode}`;
}

export function dateMocId(date: string): string {
  return `moc_date_${date}`;
}

export async function stableMocToken(seed: string, length = 10): Promise<string> {
  return (await sha256Hex(seed)).slice(0, length);
}

export async function mocSectionId(mocId: string, key: string): Promise<string> {
  return `msec_${await stableMocToken(`${mocId}|section|${key}`)}`;
}

export async function mocItemId(mocId: string, key: string): Promise<string> {
  return `mitem_${await stableMocToken(`${mocId}|item|${key}`)}`;
}

export function collectMocDates(entities: readonly MocEntity[]): string[] {
  const dates = new Set<string>();
  for (const entity of entities) {
    for (const date of entity.dates) dates.add(date);
  }
  return [...dates].sort();
}

export function groupMocEntitiesByMode(entities: readonly MocEntity[]): MocModeGroup[] {
  return MOC_MODE_ORDER.map((mode) => ({
    mode,
    items: entities.filter((entity) => entity.mode === mode).sort(compareEntity),
  })).filter((group) => group.items.length > 0);
}

async function buildEntityItems(mocId: string, entities: readonly MocEntity[]): Promise<MocItem[]> {
  const items: MocItem[] = [];
  for (const entity of entities) {
    items.push({
      itemId: await mocItemId(mocId, `entity:${entity.documentId}`),
      label: entity.documentTitle,
      target: {
        type: 'entity',
        documentId: entity.documentId,
        documentTitle: entity.documentTitle,
        mode: entity.mode,
      },
    });
  }
  return items;
}

async function buildMocItems(ownerMocId: string, targets: readonly MocReferenceTarget[]): Promise<MocItem[]> {
  const items: MocItem[] = [];
  for (const target of targets) {
    items.push({
      itemId: await mocItemId(ownerMocId, `moc:${target.mocId}`),
      label: target.title,
      target,
    });
  }
  return items;
}

async function buildDailyMocModel(date: string, entities: readonly MocEntity[]): Promise<MocModel> {
  const mocId = dateMocId(date);
  const grouped = groupMocEntitiesByMode(entities.filter((entity) => entity.dates.includes(date)));
  const sections: MocSection[] = [];

  for (const group of grouped) {
    sections.push({
      sectionId: await mocSectionId(mocId, `mode:${group.mode}`),
      kind: 'entities',
      title: group.mode,
      mode: group.mode,
      items: await buildEntityItems(mocId, group.items),
    });
  }

  return {
    mocId,
    kind: 'daily',
    title: date,
    date,
    tags: ['inkloop/moc', `inkloop/date/${date}`],
    summary: {
      date,
      clauses: grouped.map((group) => ({
        mode: group.mode,
        entityDocumentIds: group.items.map((entity) => entity.documentId),
      })),
    },
    sections,
  };
}

async function buildModeMocModel(group: MocModeGroup): Promise<MocModel> {
  const mocId = modeMocId(group.mode);
  return {
    mocId,
    kind: 'mode',
    title: group.mode,
    mode: group.mode,
    tags: ['inkloop/moc', `inkloop/${group.mode}`],
    sections: [
      {
        sectionId: await mocSectionId(mocId, `mode:${group.mode}`),
        kind: 'entities',
        title: group.mode,
        mode: group.mode,
        items: await buildEntityItems(mocId, group.items),
      },
    ],
  };
}

async function buildRootMocModel(
  entities: readonly MocEntity[],
  dates: readonly string[],
  opts: BuildMocModelsOptions,
): Promise<MocModel> {
  const recentLimit = Math.max(0, opts.recentDailyLimit ?? 30);
  const presentModes = MOC_MODE_ORDER.filter((mode) => entities.some((entity) => entity.mode === mode));
  const recentDates = [...dates].reverse().slice(0, recentLimit);

  const sections: MocSection[] = [
    {
      sectionId: await mocSectionId(MOC_ROOT_ID, 'modes'),
      kind: 'mocs',
      title: 'modes',
      items: await buildMocItems(
        MOC_ROOT_ID,
        presentModes.map((mode) => ({
          type: 'moc',
          mocId: modeMocId(mode),
          mocKind: 'mode',
          title: mode,
          mode,
        })),
      ),
    },
  ];

  if (recentDates.length) {
    sections.push({
      sectionId: await mocSectionId(MOC_ROOT_ID, 'recent'),
      kind: 'recent',
      title: 'recent',
      items: await buildMocItems(
        MOC_ROOT_ID,
        recentDates.map((date) => ({
          type: 'moc',
          mocId: dateMocId(date),
          mocKind: 'daily',
          title: date,
          date,
        })),
      ),
    });
  }

  return {
    mocId: MOC_ROOT_ID,
    kind: 'root',
    title: MOC_ROOT_TITLE,
    tags: ['inkloop/moc'],
    sections,
  };
}

/**
 * entities -> destination-neutral MOC models (daily + per-mode + root).
 * Pure and deterministic. Adapters render these into their own link/tag syntax
 * (Obsidian wikilinks + inline tags, Notion relations, ...).
 *
 * Invariants: every active date yields a daily model (zero entity loss); every
 * entity appears in its mode model; root references every present mode + the
 * most recent daily models.
 */
export async function buildMocModels(
  entities: readonly MocEntity[],
  opts: BuildMocModelsOptions = {},
): Promise<MocModel[]> {
  if (!entities.length) return [];

  const dates = collectMocDates(entities);
  const models: MocModel[] = [];

  for (const date of dates) models.push(await buildDailyMocModel(date, entities));
  for (const group of groupMocEntitiesByMode(entities)) models.push(await buildModeMocModel(group));
  models.push(await buildRootMocModel(entities, dates, opts));

  return models;
}
