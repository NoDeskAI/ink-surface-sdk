import { describe, expect, it } from 'vitest';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { shouldExportCloudAiTurn, shouldPostprocessRuntimeAnnotation } from './runtime-postprocess-policy';

function event(input: Partial<RuntimeSyncEvent> & { payload?: RuntimeSyncEvent['payload'] } = {}): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: 'evt_policy',
    source: 'inkloop_device',
    doc_id: input.doc_id || 'doc_reading',
    operation: input.operation || 'annotation.add',
    target: { type: 'annotation', id: 'ko_policy' },
    payload: input.payload || {},
    origin: { device_id: 'paper' },
    status: 'pending',
    dedupe_key: 'evt_policy',
    created_at: '2026-07-07T00:00:00.000Z',
    updated_at: '2026-07-07T00:00:00.000Z',
  };
}

describe('runtime annotation postprocess policy', () => {
  it('does not create AI turns for ordinary physical pen reading marks', () => {
    expect(shouldPostprocessRuntimeAnnotation(event({
      payload: {
        mark_id: 'mark_pen',
        tool: 'pen',
        origin: 'pen',
        feature_type: 'markup',
        scored_type: 'stroke',
        ai_eligible: false,
        marked_text: '用户用物理笔划线的原文',
      },
    }))).toBe(false);
  });

  it('keeps explicit AI pen and meeting annotations in the postprocess path', () => {
    expect(shouldPostprocessRuntimeAnnotation(event({
      payload: { mark_id: 'mark_ai', tool: 'pen', origin: 'ai_pen', ai_eligible: true },
    }))).toBe(true);
    expect(shouldPostprocessRuntimeAnnotation(event({
      payload: {
        annotation: {
          ko_id: 'mark_ai_stroke',
          render_mode: 'stroke_only',
          ai_eligible: true,
        },
      },
    }))).toBe(true);
    expect(shouldPostprocessRuntimeAnnotation(event({ doc_id: 'mtgdoc_demo', payload: { tool: 'pen', origin: 'pen', ai_eligible: false } }))).toBe(true);
  });

  it('suppresses Cloud AI turns when classifier said the mark was not asking AI to respond', () => {
    expect(shouldExportCloudAiTurn({ metadata: { classifier_respond: false }, status: 'accepted' })).toBe(false);
    expect(shouldExportCloudAiTurn({ metadata: { classifier_respond: true }, status: 'accepted' })).toBe(true);
  });
});
