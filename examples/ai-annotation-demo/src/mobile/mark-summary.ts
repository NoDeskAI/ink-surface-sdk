import type { PersistedMark } from '../core/store-format';

type SummaryMarkFields = Pick<
  PersistedMark,
  | 'ai_eligible'
  | 'capture_surface'
  | 'hmp'
  | 'is_tombstone'
  | 'kind'
  | 'kind_source'
  | 'marked_text'
  | 'pointer_type'
  | 'reader_layout_id'
  | 'reflow_anchor_runs'
  | 'scored_type'
  | 'strokes'
  | 'surface_coord_space'
>;

export function hasReliableSummaryAnchor(mark: SummaryMarkFields): boolean {
  return !!mark.hmp?.target_object_refs?.length
    || !!mark.reflow_anchor_runs?.length
    || !!mark.reader_layout_id
    || mark.capture_surface === 'reader'
    || mark.surface_coord_space === 'reader_px';
}

export function isManualSyntheticMark(mark: SummaryMarkFields): boolean {
  return mark.pointer_type === 'synthetic' || mark.kind_source === 'manual_synthetic';
}

export function isSummaryHiddenMark(mark: SummaryMarkFields): boolean {
  if (mark.is_tombstone) return true;
  const kind = `${mark.kind ?? ''} ${mark.scored_type ?? ''}`.toLowerCase();
  const noVisibleInk = !(mark.strokes ?? []).some((s) => s.points?.length);
  if (kind.includes('review_later') || (mark.ai_eligible === false && noVisibleInk && (mark.marked_text ?? '').trim() === '稍后处理')) return true;
  return isManualSyntheticMark(mark) && !hasReliableSummaryAnchor(mark);
}

export function estimateReaderPageIndexFromBbox(bbox: [number, number, number, number] | undefined, readerPageCount: number): number {
  const count = Math.max(1, Math.floor(readerPageCount || 1));
  const y = Math.min(Math.max(0, bbox?.[1] ?? 0), 0.999);
  return Math.min(count - 1, Math.floor(y * count));
}
