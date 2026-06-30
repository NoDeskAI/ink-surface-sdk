import { describe, expect, it } from 'vitest';
import type { EntityMode } from './entity-mode';
import {
  buildMocModels,
  dateMocId,
  MOC_ROOT_ID,
  MOC_ROOT_TITLE,
  mocItemId,
  mocSectionId,
  modeMocId,
  type MocEntity,
  type MocModel,
  type MocSection,
  type MocSectionKind,
} from './moc';

const ENTITIES: MocEntity[] = [
  { documentId: 'doc_b1', documentTitle: '深入理解计算机系统', mode: 'reading', dates: ['2026-06-28', '2026-06-29'] },
  { documentId: 'doc_b2', documentTitle: 'A Philosophy of Software Design', mode: 'reading', dates: ['2026-06-30'] },
  { documentId: 'mtgdoc_m1', documentTitle: '架构评审 v4', mode: 'meeting', dates: ['2026-06-29'] },
  { documentId: 'diary_d1', documentTitle: '6.29 日记', mode: 'diary', dates: ['2026-06-29'] },
];

const ACTIVE_DATES = ['2026-06-28', '2026-06-29', '2026-06-30'] as const;
const PRESENT_MODES = ['reading', 'meeting', 'diary'] as const;

function byId(models: readonly MocModel[], mocId: string): MocModel {
  const model = models.find((item) => item.mocId === mocId);
  if (!model) throw new Error(`MOC not found: ${mocId}`);
  return model;
}

function sectionByKind(model: MocModel, kind: MocSectionKind): MocSection {
  const section = model.sections.find((item) => item.kind === kind);
  if (!section) throw new Error(`Section not found: ${model.mocId}/${kind}`);
  return section;
}

function sectionByMode(model: MocModel, mode: EntityMode): MocSection {
  const section = model.sections.find((item) => item.mode === mode);
  if (!section) throw new Error(`Mode section not found: ${model.mocId}/${mode}`);
  return section;
}

function entityDocumentIds(model: MocModel): string[] {
  return model.sections.flatMap((section) =>
    section.items.flatMap((item) => (item.target.type === 'entity' ? [item.target.documentId] : [])),
  );
}

function mocReferences(section: MocSection) {
  return section.items.map((item) => {
    if (item.target.type !== 'moc') throw new Error(`Expected moc target: ${item.itemId}`);
    return { label: item.label, target: item.target };
  });
}

describe('buildMocModels', () => {
  it('产出 daily + mode + root，数量和 id 精确', async () => {
    const models = await buildMocModels(ENTITIES);

    expect(models.filter((model) => model.kind === 'daily')).toHaveLength(3);
    expect(models.filter((model) => model.kind === 'mode')).toHaveLength(3);
    expect(models.filter((model) => model.kind === 'root')).toHaveLength(1);

    expect(models.map((model) => model.mocId)).toEqual([
      'moc_date_2026-06-28',
      'moc_date_2026-06-29',
      'moc_date_2026-06-30',
      'moc_mode_reading',
      'moc_mode_meeting',
      'moc_mode_diary',
      'moc_root',
    ]);
  });

  it('每个活动日期都有 daily MOC，且当天实体零丢失', async () => {
    const models = await buildMocModels(ENTITIES);

    for (const date of ACTIVE_DATES) {
      const daily = byId(models, dateMocId(date));
      const expected = ENTITIES.filter((entity) => entity.dates.includes(date)).map((entity) => entity.documentId).sort();

      expect(daily.kind).toBe('daily');
      expect(daily.date).toBe(date);
      expect(entityDocumentIds(daily).sort()).toEqual(expected);
      expect(daily.sections.every((section) => section.kind === 'entities')).toBe(true);
    }
  });

  it('每个实体进入自己的 mode model', async () => {
    const models = await buildMocModels(ENTITIES);

    for (const mode of PRESENT_MODES) {
      const model = byId(models, modeMocId(mode));
      const expected = ENTITIES.filter((entity) => entity.mode === mode).map((entity) => entity.documentId).sort();

      expect(model).toMatchObject({
        kind: 'mode',
        title: mode,
        mode,
        tags: ['inkloop/moc', `inkloop/${mode}`],
      });
      expect(entityDocumentIds(model).sort()).toEqual(expected);
    }
  });

  it('root 引用全部 present mode，并按 recentDailyLimit 限制最近 daily', async () => {
    const models = await buildMocModels(ENTITIES, { recentDailyLimit: 2 });
    const root = byId(models, MOC_ROOT_ID);

    expect(root).toMatchObject({
      kind: 'root',
      title: MOC_ROOT_TITLE,
      tags: ['inkloop/moc'],
    });

    expect(mocReferences(sectionByKind(root, 'mocs'))).toEqual([
      {
        label: 'reading',
        target: { type: 'moc', mocId: 'moc_mode_reading', mocKind: 'mode', title: 'reading', mode: 'reading' },
      },
      {
        label: 'meeting',
        target: { type: 'moc', mocId: 'moc_mode_meeting', mocKind: 'mode', title: 'meeting', mode: 'meeting' },
      },
      {
        label: 'diary',
        target: { type: 'moc', mocId: 'moc_mode_diary', mocKind: 'mode', title: 'diary', mode: 'diary' },
      },
    ]);

    expect(mocReferences(sectionByKind(root, 'recent'))).toEqual([
      {
        label: '2026-06-30',
        target: { type: 'moc', mocId: 'moc_date_2026-06-30', mocKind: 'daily', title: '2026-06-30', date: '2026-06-30' },
      },
      {
        label: '2026-06-29',
        target: { type: 'moc', mocId: 'moc_date_2026-06-29', mocKind: 'daily', title: '2026-06-29', date: '2026-06-29' },
      },
    ]);
  });

  it('sectionId/itemId 稳定，且由 mocId + key 派生', async () => {
    const first = await buildMocModels(ENTITIES);
    const second = await buildMocModels([...ENTITIES].reverse());

    const idSnapshot = (models: readonly MocModel[]) =>
      models.map((model) => ({
        mocId: model.mocId,
        sections: model.sections.map((section) => ({
          sectionId: section.sectionId,
          itemIds: section.items.map((item) => item.itemId),
        })),
      }));

    expect(idSnapshot(first)).toEqual(idSnapshot(second));

    const d29 = byId(first, dateMocId('2026-06-29'));
    const readingSection = sectionByMode(d29, 'reading');
    const readingItem = readingSection.items.find(
      (item) => item.target.type === 'entity' && item.target.documentId === 'doc_b1',
    );

    expect(readingSection.sectionId).toBe(await mocSectionId('moc_date_2026-06-29', 'mode:reading'));
    expect(readingSection.sectionId).toMatch(/^msec_[a-f0-9]{10}$/);

    expect(readingItem?.itemId).toBe(await mocItemId('moc_date_2026-06-29', 'entity:doc_b1'));
    expect(readingItem?.itemId).toMatch(/^mitem_[a-f0-9]{10}$/);
  });

  it('daily summary clauses 按 mode 分组并列出当天实体 id', async () => {
    const models = await buildMocModels(ENTITIES);

    expect(byId(models, dateMocId('2026-06-28')).summary).toEqual({
      date: '2026-06-28',
      clauses: [{ mode: 'reading', entityDocumentIds: ['doc_b1'] }],
    });

    expect(byId(models, dateMocId('2026-06-29')).summary).toEqual({
      date: '2026-06-29',
      clauses: [
        { mode: 'reading', entityDocumentIds: ['doc_b1'] },
        { mode: 'meeting', entityDocumentIds: ['mtgdoc_m1'] },
        { mode: 'diary', entityDocumentIds: ['diary_d1'] },
      ],
    });
  });

  it('空输入返回 []', async () => {
    expect(await buildMocModels([])).toEqual([]);
  });
});
