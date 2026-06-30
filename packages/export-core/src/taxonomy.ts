import { entityModeOf, type EntityMode } from './entity-mode.js';

/** mode -> tag noun (reading uses `book`, closer to product semantics). */
export const MODE_NOUN: Record<EntityMode, string> = {
  reading: 'book',
  diary: 'diary',
  meeting: 'meeting',
};

export interface TaxonomyTagsOptions {
  documentId: string;
  documentTitle: string;
  isoDate: string;
  mode?: EntityMode;
  entitySlug?: string;
  date?: string;
}

/**
 * Hierarchical-tag-safe slug: collapse anything that is not a letter/number/_/-
 * into `-` (CJK kept via \p{L}), squeeze, trim, cap at 60. Hosts that render
 * these into a destination's tag syntax rely on this being space-free.
 */
export function tagSlug(input: string): string {
  return (
    input
      .normalize('NFKC')
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

/**
 * Canonical taxonomy tags for a knowledge object: `inkloop/<mode>`,
 * `inkloop/<noun>/<entitySlug>`, `inkloop/date/<YYYY-MM-DD>`. These live on the
 * canonical KO; each destination adapter decides how to render them.
 */
export function taxonomyTags(opts: TaxonomyTagsOptions): string[] {
  const mode = opts.mode ?? entityModeOf(opts.documentId);
  const date = (opts.date ?? opts.isoDate).slice(0, 10);
  const entityRaw = opts.entitySlug ?? (mode === 'diary' ? date : opts.documentTitle);

  return [`inkloop/${mode}`, `inkloop/${MODE_NOUN[mode]}/${tagSlug(entityRaw)}`, `inkloop/date/${date}`];
}
