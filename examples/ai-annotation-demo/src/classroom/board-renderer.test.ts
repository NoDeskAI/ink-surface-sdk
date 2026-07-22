import { describe, expect, it } from 'vitest';
import { BoardModel, normalizedPoint, strokePath, unionSourceBoxes } from './board-renderer';
import { activeBoardEvents } from '../../shared/classroom/classroom-spatial';

describe('classroom board renderer model', () => {
  it('projects normalized points consistently at different viewport sizes', () => {
    expect(strokePath([{ x_norm: 0.25, y_norm: 0.5, t_ms: 1 }], 800, 600)).toBe('M 200 300');
    expect(strokePath([{ x_norm: 0.25, y_norm: 0.5, t_ms: 1 }], 400, 300)).toBe('M 100 150');
    expect(normalizedPoint(200, 150, { left: 100, top: 100, width: 400, height: 200 })).toEqual({ x_norm: 0.25, y_norm: 0.25 });
    expect(normalizedPoint(200, 150, { left: 100, top: 100, width: 0, height: 0 })).toEqual({ x_norm: 0, y_norm: 0 });
  });

  it('reconciles previews with final events and detects sequence gaps', () => {
    const model = new BoardModel();
    model.applyPreview({ client_event_id: 'client_1', revision: 1 });
    expect(model.applyPreview({ client_event_id: 'client_1', revision: 2 })).toBe(true);
    expect(model.applyPreview({ client_event_id: 'client_1', revision: 1 })).toBe(false);
    expect(model.previews.get('client_1')?.revision).toBe(2);
    expect(model.applyBoardEvent({ sequence: 1, client_event_id: 'client_1' })).toBe('applied');
    expect(model.previews.has('client_1')).toBe(false);
    expect(model.applyBoardEvent({ sequence: 1, client_event_id: 'client_1' })).toBe('duplicate');
    model.applyPreview({ client_event_id: 'client_2', revision: 1 });
    model.applyPreview({ client_event_id: 'client_3', revision: 1 });
    expect(model.applyBoardEvent({ sequence: 3, client_event_id: 'client_3' })).toBe('gap');
    expect(model.applyBoardEvent({ sequence: 2, client_event_id: 'client_2' })).toBe('applied');
    expect(model.sequence).toBe(3);
    expect(model.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(model.previews.size).toBe(0);
  });

  it('projects eraser tombstones out while preserving the append-only ledger', () => {
    const stroke = { event: { event_id: 'ink_one', event_type: 'stroke', metadata: { tool: 'pen' } } } as never;
    const erase = { event: { event_id: 'ink_erase', event_type: 'erase', metadata: { tool: 'eraser', erased_event_ids: ['ink_one'] } } } as never;
    expect(activeBoardEvents([stroke, erase])).toEqual([]);
  });

  it('unions every recognition stroke when locating a complete formula', () => {
    expect(unionSourceBoxes([[10, 20, 30, 10], [80, 15, 20, 20]], 5)).toEqual([5, 10, 100, 30]);
  });
});
