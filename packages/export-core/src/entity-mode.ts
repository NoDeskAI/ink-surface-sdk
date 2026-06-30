export type EntityMode = 'reading' | 'diary' | 'meeting';

export const ENTITY_MODES: readonly EntityMode[] = ['reading', 'diary', 'meeting'];

/**
 * Derive an entity's mode from its document id prefix (matches the store's
 * book/diary listing + meeting doc id convention):
 * mtgdoc_/mtgboard_ -> meeting; diary -> diary; everything else -> reading.
 */
export function entityModeOf(documentId: string): EntityMode {
  if (documentId.startsWith('mtgdoc_') || documentId.startsWith('mtgboard_')) return 'meeting';
  if (documentId.startsWith('diary')) return 'diary';
  return 'reading';
}
