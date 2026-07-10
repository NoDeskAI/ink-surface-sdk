import { describe, expect, it } from 'vitest';

import type { ScreenOverlay } from '../core/contracts';
import { withoutOverlay } from './state';

const overlay = (overlay_id: string): ScreenOverlay => ({
  overlay_id,
  trace_id: `tr_${overlay_id}`,
  page_id: 'page_0',
  result_id: `res_${overlay_id}`,
  overlay_type: 'note',
  geometry: { anchor_bbox: [0, 0, 0.1, 0.1] },
  display_text: 'AI旁注',
  dismissible: true,
  created_at: '2026-07-08T00:00:00.000Z',
  state: 'shown',
  result_type: 'summary',
});

describe('overlay state helpers', () => {
  it('removes only the dismissed overlay from the current in-memory list', () => {
    expect(withoutOverlay([overlay('keep'), overlay('drop')], 'drop').map((item) => item.overlay_id)).toEqual(['keep']);
  });
});
