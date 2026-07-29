import { describe, expect, it, vi } from 'vitest';
import { validateRuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import {
  createLiveBoardStrokeAddEvent,
  createLiveBoardStrokeDeleteEvent,
  pushLiveBoardEvents,
} from './meeting-live-board-publisher';

describe('meeting live board publisher', () => {
  it('creates a page-normalized annotation event whose projected identity matches the optimistic stroke', () => {
    const value = createLiveBoardStrokeAddEvent({
      documentId: 'mtgdoc_google_meet:abc-defg-hij',
      annotationId: 'ko_live_stroke-1',
      eventId: 'evt_live_stroke-1',
      pageIndex: 2,
      points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }],
      createdAt: '2026-07-27T12:00:00.000Z',
    });

    expect(validateRuntimeSyncEvent(value)).toEqual([]);
    expect(value).toEqual(expect.objectContaining({
      event_id: 'evt_live_stroke-1',
      source: 'inkloop_web',
      doc_id: 'mtgdoc_google_meet:abc-defg-hij',
      operation: 'annotation.add',
      target: { type: 'annotation', id: 'ko_live_stroke-1' },
      payload: {
        page_index: 2,
        annotation: expect.objectContaining({
          ko_id: 'ko_live_stroke-1',
          visual_strokes: [expect.objectContaining({
            coord_space: 'page_norm',
            points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }],
          })],
        }),
      },
    }));
  });

  it('publishes the runtime batch with auth headers and rejects a dropped acknowledgement', async () => {
    const event = createLiveBoardStrokeAddEvent({
      documentId: 'mtgdoc_meeting-1',
      annotationId: 'ko_live_stroke-1',
      eventId: 'evt_live_stroke-1',
      pageIndex: 0,
      points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }],
      createdAt: '2026-07-27T12:00:00.000Z',
    });
    const acceptedFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual(expect.objectContaining({
        authorization: 'Bearer test',
        'content-type': 'application/json',
      }));
      expect(JSON.parse(String(init?.body))).toEqual({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: 'meeting-live-board',
        events: [event],
      });
      return new Response(JSON.stringify({
        schema_version: 'inkloop.runtime_sync_ack_batch.v1',
        acks: [{ event_id: event.event_id, ok: true, ack_id: 'ack-1', server_sequence: 1 }],
      }), { status: 200 });
    });

    await expect(pushLiveBoardEvents([event], {
      fetchImpl: acceptedFetch,
      headers: { authorization: 'Bearer test' },
    })).resolves.toEqual([event.event_id]);

    await expect(pushLiveBoardEvents([event], {
      fetchImpl: async () => new Response(JSON.stringify({
        acks: [{ event_id: event.event_id, ok: true, dropped: true, reason: 'document_deleted' }],
      }), { status: 200 }),
    })).rejects.toThrow('runtime_sync_event_dropped:document_deleted');
  });

  it('creates a valid annotation tombstone for clearing published ink', () => {
    const value = createLiveBoardStrokeDeleteEvent({
      documentId: 'mtgdoc_meeting-1',
      annotationId: 'ko_live_stroke-1',
      eventId: 'evt_delete_stroke-1',
      createdAt: '2026-07-27T12:05:00.000Z',
    });

    expect(validateRuntimeSyncEvent(value)).toEqual([]);
    expect(value).toEqual(expect.objectContaining({
      operation: 'annotation.delete',
      target: { type: 'annotation', id: 'ko_live_stroke-1' },
      payload: { ko_id: 'ko_live_stroke-1' },
    }));
  });
});
