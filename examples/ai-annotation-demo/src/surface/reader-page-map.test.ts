import { describe, expect, it } from 'vitest';

import type { PersistedReaderLayoutSnapshot } from '../core/store-format';
import {
  createReaderPageMap,
  readerPageMapHasLocatorCoverage,
  readerPageMapHasNearEmptyIntermediatePage,
  readerPageMapMatchesLayout,
} from './reader-page-map';

function layoutFixture(): PersistedReaderLayoutSnapshot {
  return {
    schema: 'inkloop.reader_layout.v1',
    layout_id: 'reader_layout_a',
    page_index: 0,
    page_id: 'pg_demo_0',
    capture_surface: 'reader',
    coord_space: 'reader_px',
    width: 800,
    height: 1620,
    style_fingerprint: 'w=800|h=1620|font=normal/400/24px/36px/serif|engine=local@v5|paginate=1',
    reflow_engine: 'local@v5',
    text_runs: [
      { block_id: 'b1', text: '第一页第一段', x: 32, y: 60, w: 520, h: 30, font_size: 24 },
      { block_id: 'b1', text: '第一页第二行', x: 32, y: 100, w: 520, h: 30, font_size: 24 },
      { block_id: 'b2', text: '第二页内容', x: 32, y: 860, w: 520, h: 30, font_size: 24 },
      { block_id: 'b3', text: '第三页内容', x: 32, y: 1580, w: 520, h: 30, font_size: 24 },
    ],
    updated_at: '2026-07-06T00:00:00.000Z',
  };
}

describe('reader page map', () => {
  it('maps measured reader text runs to virtual reader pages with source run coverage', () => {
    const layout = layoutFixture();
    const map = createReaderPageMap({
      layout,
      sourceBlocks: [
        { id: 'b1', sourceRunIds: ['r1', 'r2'] },
        { id: 'b2', sourceRunIds: ['r3'] },
        { id: 'b3', sourceRunIds: ['r4'] },
      ],
      viewportHeight: 810,
      now: '2026-07-06T00:01:00.000Z',
    });

    expect(map.reader_page_count).toBe(2);
    expect(map.entries.map((entry) => [entry.block_id, entry.reader_page_index])).toEqual([
      ['b1', 0],
      ['b2', 1],
      ['b3', 1],
    ]);
    expect(readerPageMapMatchesLayout(map, layout)).toBe(true);
    expect(readerPageMapHasLocatorCoverage(map)).toBe(true);
  });

  it('marks missing source run coverage as not ready for precise locator mapping', () => {
    const map = createReaderPageMap({
      layout: layoutFixture(),
      sourceBlocks: [{ id: 'b1', sourceRunIds: ['r1'] }],
      viewportHeight: 810,
    });

    expect(readerPageMapHasLocatorCoverage(map)).toBe(false);
  });

  it('detects near-empty intermediate reader pages', () => {
    const layout = layoutFixture();
    layout.height = 2430;
    layout.text_runs = [
      { block_id: 'b1', text: '第一页内容', x: 32, y: 60, w: 520, h: 30, font_size: 24 },
      { block_id: 'b2', text: '第三页内容', x: 32, y: 1660, w: 520, h: 30, font_size: 24 },
    ];

    const map = createReaderPageMap({
      layout,
      sourceBlocks: [
        { id: 'b1', sourceRunIds: ['r1'] },
        { id: 'b2', sourceRunIds: ['r2'] },
      ],
      viewportHeight: 810,
    });

    expect(map.reader_page_count).toBe(3);
    expect(readerPageMapHasNearEmptyIntermediatePage(map)).toBe(true);
  });
});
