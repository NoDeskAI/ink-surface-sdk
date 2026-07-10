import type { PersistedReaderLayoutSnapshot } from '../core/store-format';

export const READER_PAGE_MAP_SCHEMA = 'inkloop.reader_page_map.v1';

export interface ReaderPageMapSourceBlock {
  id: string;
  sourceRunIds?: string[];
}

export interface ReaderPageMapEntry {
  block_id: string;
  source_run_ids: string[];
  reader_page_index: number;
  top: number;
  bottom: number;
  text_sample: string;
}

export interface ReaderPageMap {
  schema: typeof READER_PAGE_MAP_SCHEMA;
  page_id: string;
  page_index: number;
  layout_id: string;
  style_fingerprint: string;
  viewport_height: number;
  reader_page_count: number;
  entries: ReaderPageMapEntry[];
  created_at: string;
}

export interface CreateReaderPageMapInput {
  layout: PersistedReaderLayoutSnapshot;
  sourceBlocks: ReaderPageMapSourceBlock[];
  viewportHeight: number;
  now?: string;
}

function clampPageIndex(index: number, pageCount: number): number {
  return Math.min(Math.max(0, Math.floor(index)), Math.max(1, pageCount) - 1);
}

export function createReaderPageMap(input: CreateReaderPageMapInput): ReaderPageMap {
  const viewportHeight = Math.max(1, Math.floor(input.viewportHeight || input.layout.height || 1));
  const pageCount = Math.max(1, Math.ceil(Math.max(input.layout.height || 1, viewportHeight) / viewportHeight));
  const sourceRunsByBlock = new Map(input.sourceBlocks.map((block) => [block.id, block.sourceRunIds ?? []]));
  const rows = new Map<string, ReaderPageMapEntry>();
  for (const run of input.layout.text_runs) {
    if (!run.block_id) continue;
    const top = Math.max(0, run.y - run.h);
    const bottom = Math.max(top, run.y);
    const existing = rows.get(run.block_id);
    if (existing) {
      existing.top = Math.min(existing.top, top);
      existing.bottom = Math.max(existing.bottom, bottom);
      if (existing.text_sample.length < 120) existing.text_sample = `${existing.text_sample} ${run.text}`.trim().slice(0, 160);
      continue;
    }
    rows.set(run.block_id, {
      block_id: run.block_id,
      source_run_ids: sourceRunsByBlock.get(run.block_id) ?? [],
      reader_page_index: clampPageIndex(top / viewportHeight, pageCount),
      top,
      bottom,
      text_sample: run.text.slice(0, 160),
    });
  }

  const entries = [...rows.values()].sort((a, b) => (a.top - b.top) || a.block_id.localeCompare(b.block_id));
  for (const entry of entries) entry.reader_page_index = clampPageIndex(entry.top / viewportHeight, pageCount);

  return {
    schema: READER_PAGE_MAP_SCHEMA,
    page_id: input.layout.page_id,
    page_index: input.layout.page_index,
    layout_id: input.layout.layout_id,
    style_fingerprint: input.layout.style_fingerprint,
    viewport_height: viewportHeight,
    reader_page_count: pageCount,
    entries,
    created_at: input.now ?? new Date().toISOString(),
  };
}

export function readerPageMapMatchesLayout(map: ReaderPageMap | null | undefined, layout: PersistedReaderLayoutSnapshot): boolean {
  return !!map
    && map.schema === READER_PAGE_MAP_SCHEMA
    && map.layout_id === layout.layout_id
    && map.style_fingerprint === layout.style_fingerprint
    && map.page_id === layout.page_id
    && map.page_index === layout.page_index;
}

export function readerPageMapHasLocatorCoverage(map: ReaderPageMap): boolean {
  return map.entries.length > 0 && map.entries.every((entry) => entry.source_run_ids.length > 0);
}

export function readerPageMapHasNearEmptyIntermediatePage(map: ReaderPageMap, minFillRatio = 0.18): boolean {
  if (map.reader_page_count <= 2) return false;
  for (let pageIndex = 0; pageIndex < map.reader_page_count - 1; pageIndex += 1) {
    const entries = map.entries.filter((entry) => entry.reader_page_index === pageIndex);
    if (!entries.length) return true;
    const pageTop = pageIndex * map.viewport_height;
    const pageBottom = pageTop + map.viewport_height;
    const top = Math.max(pageTop, Math.min(...entries.map((entry) => entry.top)));
    const bottom = Math.min(pageBottom, Math.max(...entries.map((entry) => entry.bottom)));
    const filled = Math.max(0, bottom - top);
    if (filled / map.viewport_height < minFillRatio) return true;
  }
  return false;
}
