import { describe, expect, it } from 'vitest';
import { entityModeOf } from './entity-mode';
import { MODE_NOUN, tagSlug, taxonomyTags } from './taxonomy';

describe('entityModeOf', () => {
  it('按 document id 前缀判 mode', () => {
    expect(entityModeOf('doc_abc123def456')).toBe('reading');
    expect(entityModeOf('book_abc123def456')).toBe('reading');
    expect(entityModeOf('random_document')).toBe('reading');

    expect(entityModeOf('diary_ab12cd34')).toBe('diary');
    expect(entityModeOf('diary-2026-06-29')).toBe('diary');

    expect(entityModeOf('mtgdoc_m123')).toBe('meeting');
    expect(entityModeOf('mtgdoc_m123_msg9')).toBe('meeting');
    expect(entityModeOf('mtgboard_m123')).toBe('meeting');
  });
});

describe('MODE_NOUN', () => {
  it('mode noun 使用导出核心约定', () => {
    expect(MODE_NOUN).toEqual({
      reading: 'book',
      diary: 'diary',
      meeting: 'meeting',
    });
  });
});

describe('tagSlug', () => {
  it('保留 CJK，空格和标点折叠为连字符', () => {
    expect(tagSlug('架构评审 v4')).toBe('架构评审-v4');
    expect(tagSlug('深入理解计算机系统')).toBe('深入理解计算机系统');
    expect(tagSlug('你好，世界！ v4')).toBe('你好-世界-v4');
    expect(tagSlug('A/B: C? D*E|F')).toBe('A-B-C-D-E-F');
  });

  it('做 NFKC、去首尾连字符，空结果回退 untitled', () => {
    expect(tagSlug('  ﬁ   Ligature  ')).toBe('fi-Ligature');
    expect(tagSlug('---A---')).toBe('A');
    expect(tagSlug(' /// ')).toBe('untitled');
    expect(tagSlug('')).toBe('untitled');
  });

  it('截断到 60 个字符', () => {
    const slug = tagSlug(`段落 ${'x'.repeat(80)}`);

    expect(slug).toHaveLength(60);
    expect(slug).toBe(`段落-${'x'.repeat(57)}`);
  });
});

describe('taxonomyTags', () => {
  it('默认从 documentId 派生 mode，并使用标题 slug', () => {
    expect(
      taxonomyTags({
        documentId: 'doc_book_1',
        documentTitle: '架构评审 v4',
        isoDate: '2026-06-29T08:00:00.000Z',
      }),
    ).toEqual(['inkloop/reading', 'inkloop/book/架构评审-v4', 'inkloop/date/2026-06-29']);
  });

  it('支持显式覆盖 mode/entitySlug/date', () => {
    expect(
      taxonomyTags({
        documentId: 'doc_book_1',
        documentTitle: '不会用于实体 slug',
        isoDate: '2026-06-29T08:00:00.000Z',
        mode: 'meeting',
        entitySlug: '周会 第 7 期',
        date: '2026-06-28',
      }),
    ).toEqual(['inkloop/meeting', 'inkloop/meeting/周会-第-7-期', 'inkloop/date/2026-06-28']);
  });

  it('diary 默认用日期做实体 slug，不用日记标题', () => {
    expect(
      taxonomyTags({
        documentId: 'diary_ab12cd34',
        documentTitle: '6.29 日记',
        isoDate: '2026-06-29T22:00:00.000Z',
      }),
    ).toEqual(['inkloop/diary', 'inkloop/diary/2026-06-29', 'inkloop/date/2026-06-29']);
  });
});
