import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';

type Point = { x: number; y: number };

type AddStrokeInput = {
  documentId: string;
  annotationId: string;
  eventId: string;
  pageIndex: number;
  points: Point[];
  createdAt?: string;
  color?: string;
};

type DeleteStrokeInput = {
  documentId: string;
  annotationId: string;
  eventId: string;
  createdAt?: string;
};

type PushOptions = {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  endpoint?: string;
  deviceId?: string;
};

function normalizedPoints(points: readonly Point[]): Point[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: Math.max(0, Math.min(1, point.x)),
      y: Math.max(0, Math.min(1, point.y)),
    }));
}

export function createLiveBoardStrokeAddEvent(input: AddStrokeInput): RuntimeSyncEvent {
  const timestamp = input.createdAt || new Date().toISOString();
  const points = normalizedPoints(input.points);
  if (points.length < 2) throw new Error('live_board_stroke_requires_two_points');
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.eventId,
    source: 'inkloop_web',
    doc_id: input.documentId,
    operation: 'annotation.add',
    target: { type: 'annotation', id: input.annotationId },
    payload: {
      page_index: Math.max(0, Math.floor(input.pageIndex)),
      annotation: {
        ko_id: input.annotationId,
        kind: 'meeting_ink',
        render_mode: 'stroke_only',
        visual_strokes: [{
          tool: 'pen',
          color: input.color || '#172522',
          opacity: 1,
          coord_space: 'page_norm',
          capture_surface: 'web_live_board',
          points,
        }],
        created_at: timestamp,
        updated_at: timestamp,
      },
    },
    origin: { device_id: 'meeting-live-board' },
    status: 'pending',
    dedupe_key: input.eventId,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function createLiveBoardStrokeDeleteEvent(input: DeleteStrokeInput): RuntimeSyncEvent {
  const timestamp = input.createdAt || new Date().toISOString();
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.eventId,
    source: 'inkloop_web',
    doc_id: input.documentId,
    operation: 'annotation.delete',
    target: { type: 'annotation', id: input.annotationId },
    payload: { ko_id: input.annotationId },
    origin: { device_id: 'meeting-live-board' },
    status: 'pending',
    dedupe_key: input.eventId,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function pushLiveBoardEvents(
  events: readonly RuntimeSyncEvent[],
  options: PushOptions = {},
): Promise<string[]> {
  if (!events.length) return [];
  const response = await (options.fetchImpl || fetch)(
    options.endpoint || 'http://127.0.0.1:3000/v1/runtime/events:push',
    {
      method: 'POST',
      headers: {
        ...options.headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: options.deviceId || 'meeting-live-board',
        events,
      }),
    },
  );
  if (!response.ok) throw new Error(`runtime_sync_push_http_${response.status}`);
  const body = await response.json() as {
    acks?: Array<{
      event_id?: string;
      ok?: boolean;
      dropped?: boolean;
      reason?: string;
      error?: string;
    }>;
  };
  const acknowledgements = new Map((body.acks || []).map((ack) => [ack.event_id, ack]));
  for (const event of events) {
    const ack = acknowledgements.get(event.event_id);
    if (!ack) throw new Error(`runtime_sync_ack_missing:${event.event_id}`);
    if (ack.dropped) throw new Error(`runtime_sync_event_dropped:${ack.reason || 'unknown'}`);
    if (!ack.ok) throw new Error(`runtime_sync_event_rejected:${ack.error || event.event_id}`);
  }
  return events.map((event) => event.event_id);
}
