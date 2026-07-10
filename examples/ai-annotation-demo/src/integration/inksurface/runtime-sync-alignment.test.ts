import { describe, expect, it } from 'vitest';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import type { PersistedMark } from '../../core/store-format';
import { requeueVisibleRuntimeMarksForCloudAlignment, visibleRuntimeMarkSignature } from './runtime-sync-alignment';
import { runtimeSyncEventIdForMarkId } from './runtime-sync-bridge';

function mark(input: Partial<PersistedMark> & { mark_id: string; seq: number }): PersistedMark {
  return {
    schema_version: '5',
    entry_id: `ent_${input.mark_id}`,
    document_id: input.document_id ?? 'doc_align',
    page_id: input.page_id ?? 'pg_align_0',
    page_index: input.page_index ?? 0,
    seq: input.seq,
    created_at: input.created_at ?? '2026-07-08T00:00:00.000Z',
    mark_id: input.mark_id,
    strokes: input.strokes ?? [{ tool: 'pen', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }] }],
    bbox: input.bbox ?? [0.1, 0.2, 0.1, 0.1],
    tool: input.tool ?? 'pen',
    color: input.color ?? '#111111',
    pointer_type: 'pen',
    device_id: input.device_id ?? 'device_align',
    abs_timestamp: 0,
    feature_type: input.feature_type ?? 'drawing',
    feature_confidence: 1,
    kind: input.kind,
    scored_type: input.scored_type ?? 'stroke',
    scored_score: 1,
    hmp: null,
    marked_text: input.marked_text ?? '',
    ai_eligible: input.ai_eligible,
    origin: input.origin,
    is_tombstone: input.is_tombstone ?? false,
  };
}

function event(input: Partial<RuntimeSyncEvent> & { event_id: string; doc_id?: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'inkloop_device',
    doc_id: input.doc_id ?? 'doc_align',
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: `ko_${input.event_id}` },
    payload: input.payload ?? {},
    origin: input.origin ?? { device_id: 'device_align' },
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-07-08T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-07-08T00:00:00.000Z',
    attempt_count: input.attempt_count,
    last_error: input.last_error,
    next_retry_at: input.next_retry_at,
    sent_at: input.sent_at,
    ack_id: input.ack_id,
    deduped_by_event_id: input.deduped_by_event_id,
  };
}

function memoryOutbox(initial: RuntimeSyncEvent[]): Pick<OfflineRuntimeStorePort, 'listOutboxEvents' | 'writeOutboxEvents'> & { events: RuntimeSyncEvent[] } {
  let events = initial;
  return {
    get events() {
      return events;
    },
    async listOutboxEvents() {
      return events.map((item) => ({ ...item, payload: { ...item.payload } }));
    },
    async writeOutboxEvents(nextEvents) {
      events = nextEvents.map((item) => ({ ...item, payload: { ...item.payload } }));
    },
  };
}

describe('runtime sync visible mark alignment', () => {
  it('requeues sent and exhausted local-visible mark events without touching hidden or unrelated events', async () => {
    const visible = mark({ mark_id: 'mark_visible', seq: 1 });
    const failed = mark({ mark_id: 'mark_failed', seq: 2 });
    const missing = mark({ mark_id: 'mark_missing', seq: 3 });
    const hidden = mark({
      mark_id: 'mark_review_later',
      seq: 4,
      strokes: [],
      scored_type: 'review_later',
      kind: 'review_later',
      marked_text: '稍后处理',
      ai_eligible: false,
    });
    const store = memoryOutbox([
      event({ event_id: 'evt_bootstrap_old', operation: 'runtime.bootstrap', status: 'sent', payload: { snapshot: { doc_id: 'doc_align' } } }),
      event({
        event_id: runtimeSyncEventIdForMarkId(visible.mark_id),
        status: 'sent',
        payload: { mark_id: visible.mark_id },
        attempt_count: 1,
        sent_at: '2026-07-08T00:00:01.000Z',
        ack_id: 'ack_visible',
      }),
      event({
        event_id: runtimeSyncEventIdForMarkId(failed.mark_id),
        status: 'failed',
        payload: { mark_id: failed.mark_id },
        attempt_count: 5,
        last_error: 'network down',
        next_retry_at: '2099-01-01T00:00:00.000Z',
      }),
      event({
        event_id: runtimeSyncEventIdForMarkId(hidden.mark_id),
        status: 'sent',
        payload: { mark_id: hidden.mark_id },
        ack_id: 'ack_hidden',
      }),
      event({ event_id: 'evt_other_doc', doc_id: 'doc_other', status: 'sent', payload: { mark_id: visible.mark_id }, ack_id: 'ack_other' }),
      event({ event_id: 'evt_bootstrap_latest', operation: 'runtime.bootstrap', status: 'sent', payload: { snapshot: { doc_id: 'doc_align' } }, ack_id: 'ack_bootstrap' }),
    ]);

    const result = await requeueVisibleRuntimeMarksForCloudAlignment({
      docId: 'doc_align',
      marks: [visible, failed, missing, hidden],
      runtimeStore: store,
      now: () => '2026-07-08T00:00:10.000Z',
    });

    expect(result).toMatchObject({
      visible_marks: 3,
      requeued: 3,
      missing_event_ids: [runtimeSyncEventIdForMarkId(missing.mark_id)],
      requeued_event_ids: [
        runtimeSyncEventIdForMarkId(visible.mark_id),
        runtimeSyncEventIdForMarkId(failed.mark_id),
        'evt_bootstrap_latest',
      ],
    });
    const byId = new Map(store.events.map((item) => [item.event_id, item]));
    expect(byId.get(runtimeSyncEventIdForMarkId(visible.mark_id))).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      updated_at: '2026-07-08T00:00:10.000Z',
    });
    expect(byId.get(runtimeSyncEventIdForMarkId(visible.mark_id))?.ack_id).toBeUndefined();
    expect(byId.get(runtimeSyncEventIdForMarkId(failed.mark_id))?.next_retry_at).toBeUndefined();
    expect(byId.get(runtimeSyncEventIdForMarkId(hidden.mark_id))).toMatchObject({ status: 'sent', ack_id: 'ack_hidden' });
    expect(byId.get('evt_bootstrap_old')).toMatchObject({ status: 'sent' });
    expect(byId.get('evt_other_doc')).toMatchObject({ status: 'sent', ack_id: 'ack_other' });
    expect(byId.get('evt_bootstrap_latest')).toMatchObject({ status: 'pending', attempt_count: 0 });
  });

  it('builds a stable signature for visible mark changes and ignores hidden review-later entries', () => {
    const first = mark({ mark_id: 'mark_a', seq: 1 });
    const second = mark({ mark_id: 'mark_b', seq: 2 });
    const hidden = mark({
      mark_id: 'mark_hidden',
      seq: 99,
      strokes: [],
      scored_type: 'review_later',
      kind: 'review_later',
      marked_text: '稍后处理',
      ai_eligible: false,
    });

    expect(visibleRuntimeMarkSignature([first, second, hidden])).toBe(visibleRuntimeMarkSignature([hidden, second, first]));
    expect(visibleRuntimeMarkSignature([first, second, hidden])).not.toBe(visibleRuntimeMarkSignature([first, mark({ mark_id: 'mark_b', seq: 3 })]));
  });

  it('creates a pending sync event when a visible local mark has no outbox coverage', async () => {
    const visible = mark({ mark_id: 'mark_visible_missing', seq: 1 });
    const hidden = mark({
      mark_id: 'mark_hidden_missing',
      seq: 2,
      strokes: [],
      scored_type: 'review_later',
      kind: 'review_later',
      marked_text: '稍后处理',
      ai_eligible: false,
    });
    const store = memoryOutbox([]);

    const result = await requeueVisibleRuntimeMarksForCloudAlignment({
      docId: 'doc_align',
      marks: [visible, hidden],
      runtimeStore: store,
      buildEvents: async () => [
        event({
          event_id: runtimeSyncEventIdForMarkId(visible.mark_id),
          status: 'sent',
          payload: { mark_id: visible.mark_id },
          attempt_count: 2,
          sent_at: '2026-07-08T00:00:03.000Z',
          ack_id: 'stale_ack',
        }),
        event({
          event_id: runtimeSyncEventIdForMarkId(hidden.mark_id),
          status: 'sent',
          payload: { mark_id: hidden.mark_id },
        }),
      ],
      now: () => '2026-07-08T00:00:10.000Z',
    });

    expect(result).toMatchObject({
      visible_marks: 1,
      requeued: 0,
      missing_event_ids: [],
      created_event_ids: [runtimeSyncEventIdForMarkId(visible.mark_id)],
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      event_id: runtimeSyncEventIdForMarkId(visible.mark_id),
      status: 'pending',
      attempt_count: 0,
      updated_at: '2026-07-08T00:00:10.000Z',
    });
    expect(store.events[0].ack_id).toBeUndefined();
    expect(store.events[0].sent_at).toBeUndefined();
  });

  it('ignores visible alignment for impossible page-normalized bbox marks', async () => {
    const valid = mark({ mark_id: 'mark_valid', seq: 1 });
    const invalid = mark({ mark_id: 'mark_invalid', seq: 2, bbox: [-0.403, -5.222, 1.819, 61.111] });
    const store = memoryOutbox([
      event({
        event_id: runtimeSyncEventIdForMarkId(invalid.mark_id),
        status: 'sent',
        payload: { mark_id: invalid.mark_id },
        ack_id: 'ack_invalid',
      }),
    ]);

    const result = await requeueVisibleRuntimeMarksForCloudAlignment({
      docId: 'doc_align',
      marks: [valid, invalid],
      runtimeStore: store,
      now: () => '2026-07-08T00:00:10.000Z',
    });

    expect(result).toMatchObject({
      visible_marks: 1,
      missing_event_ids: [runtimeSyncEventIdForMarkId(valid.mark_id)],
      requeued_event_ids: [],
    });
    expect(store.events[0]).toMatchObject({ status: 'sent', ack_id: 'ack_invalid' });
    expect(visibleRuntimeMarkSignature([valid, invalid])).toBe(visibleRuntimeMarkSignature([valid]));
  });
});
