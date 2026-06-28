import { describe, expect, it } from 'vitest';
import { assertRuntimeSyncEvent, isRuntimeSyncEvent, validateRuntimeSyncEvent, type RuntimeAnnotation, type RuntimeSyncEvent } from './index';

function event(input: Partial<RuntimeSyncEvent> = {}): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: 'evt_runtime_schema',
    source: 'test',
    doc_id: 'doc_runtime_schema',
    operation: 'annotation.add',
    target: { type: 'annotation', id: 'ko_runtime_schema', block_id: 'blk_runtime_schema' },
    payload: {},
    status: 'pending',
    dedupe_key: 'doc_runtime_schema:annotation.add:ko_runtime_schema',
    created_at: '2026-06-28T00:00:00.000Z',
    updated_at: '2026-06-28T00:00:00.000Z',
    ...input,
  };
}

describe('runtime schema', () => {
  it('validates the current runtime sync event contract', () => {
    const value = event();

    expect(validateRuntimeSyncEvent(value)).toEqual([]);
    expect(isRuntimeSyncEvent(value)).toBe(true);
    expect(() => assertRuntimeSyncEvent(value)).not.toThrow();
  });

  it('reports missing required event fields without throwing', () => {
    const issues = validateRuntimeSyncEvent({ schema_version: 'inkloop.runtime_sync_event.v1', status: 'pending' });

    expect(issues.map((issue) => issue.path)).toContain('event_id');
    expect(issues.map((issue) => issue.path)).toContain('doc_id');
    expect(issues.map((issue) => issue.path)).toContain('operation');
    expect(issues.map((issue) => issue.path)).toContain('target');
  });

  it('keeps overflow stroke coordinates valid for infinite canvas marks', () => {
    const annotation: RuntimeAnnotation = {
      ko_id: 'ko_overflow',
      render_mode: 'stroke_only',
      visual_strokes: [{ tool: 'pen', points: [{ x: -0.3, y: 0.2 }, { x: 1.8, y: 0.9 }] }],
    };

    expect(annotation.visual_strokes?.[0].points).toEqual([{ x: -0.3, y: 0.2 }, { x: 1.8, y: 0.9 }]);
  });
});
