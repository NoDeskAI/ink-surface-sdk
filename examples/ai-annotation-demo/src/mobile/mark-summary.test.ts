import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, type HMP } from '../core/contracts';
import { estimateReaderPageIndexFromBbox, hasReliableSummaryAnchor, isSummaryHiddenMark } from './mark-summary';

const baseMark: Parameters<typeof isSummaryHiddenMark>[0] = {
  ai_eligible: false,
  capture_surface: 'page',
  hmp: null,
  is_tombstone: false,
  kind: 'underline',
  kind_source: 'manual',
  marked_text: '真实标记',
  pointer_type: 'pen',
  reader_layout_id: undefined,
  reflow_anchor_runs: undefined,
  scored_type: 'underline',
  strokes: [{ tool: 'pen', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }] }],
  surface_coord_space: undefined,
};

const anchoredHmp: HMP = {
  hmp_id: 'hmp_test',
  surface_id: 'pg_test_0',
  mode: 'anchored',
  action: 'underline',
  target_region: [0.1, 0.2, 0.3, 0.02],
  target_object_refs: ['tl_1_0'],
  object_hint: 'text',
  confidence: 1,
  version: SCHEMA_VERSION,
};

describe('mark summary filtering', () => {
  it('hides synthetic demo marks that have no reliable source anchor', () => {
    expect(isSummaryHiddenMark({
      ...baseMark,
      kind_source: 'manual_synthetic',
      pointer_type: 'synthetic',
      marked_text: '硬编码演示文本',
    })).toBe(true);
  });

  it('keeps anchored reading marks in the summary', () => {
    expect(hasReliableSummaryAnchor({
      ...baseMark,
      hmp: anchoredHmp,
    })).toBe(true);
    expect(isSummaryHiddenMark({
      ...baseMark,
      hmp: anchoredHmp,
    })).toBe(false);
  });

  it('estimates a reader page index from the source bbox when exact layout is unavailable', () => {
    expect(estimateReaderPageIndexFromBbox([0.2, 0.1, 0.3, 0.04], 2)).toBe(0);
    expect(estimateReaderPageIndexFromBbox([0.2, 0.75, 0.3, 0.04], 2)).toBe(1);
  });
});
