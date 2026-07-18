import { describe, expect, it } from 'vitest';
import type { Mark } from '../capture/session';
import { buildMarkGraph } from './mark-graph';

function mark(id: string, t: number, x: number): Mark {
  return {
    id,
    t,
    event: {
      event_id: id,
      page_id: 'pg_0',
      event_type: 'stroke',
      geometry: { bbox: [x, 0.1, 0.02, 0.02] },
      stroke_points: [{ x, y: 0.1, t: 0, pressure: 0.5 }],
    },
    feature: { type: 'drawing', confidence: 1 },
    scored: { type: 'stroke', score: 1 },
    hmp: null,
    markedText: '',
  } as Mark;
}

describe('mark graph pen-down time', () => {
  it('classifies the temporal quadrant from Mark.t even when recognition completion would be close', () => {
    const start = 1_752_700_000_000;
    const graph = buildMarkGraph([
      mark('first', start, 0.1),
      mark('second', start + 40_000, 0.11),
    ], [null, null]);

    expect(graph.edges.find((edge) => edge.kind === 'temporal')).toMatchObject({
      from: 'first',
      to: 'second',
      quadrant: 'revisit',
    });
    expect(graph.nodes.map((node) => node.t)).toEqual([start, start + 40_000]);
  });
});
