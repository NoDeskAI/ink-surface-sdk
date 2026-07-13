import type {
  RuntimeDeviceCursor,
  RuntimeInboxApplyResult,
  RuntimeInboxPort,
} from 'ink-surface-sdk/sync-client';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';

export interface RuntimeStoreInboxOptions {
  deviceId: string;
  advanceCursorOnRecoverableConflicts?: boolean;
}

export class RuntimeStoreInbox implements RuntimeInboxPort {
  constructor(
    private readonly store: OfflineRuntimeStorePort,
    private readonly options: RuntimeStoreInboxOptions,
  ) {}

  async getDeviceCursor(deviceId: string): Promise<RuntimeDeviceCursor | null> {
    return this.store.getDeviceCursor(deviceId);
  }

  async writeDeviceCursor(cursor: RuntimeDeviceCursor): Promise<void> {
    await this.store.writeDeviceCursor(cursor);
  }

  async applyRemoteEvents(events: RuntimeSyncEvent[]): Promise<RuntimeInboxApplyResult> {
    const result: RuntimeInboxApplyResult = {
      applied: 0,
      skipped: 0,
      conflicted: 0,
      applied_event_ids: [],
      skipped_event_ids: [],
      conflict_event_ids: [],
      applied_doc_ids: [],
      skipped_doc_ids: [],
      conflict_doc_ids: [],
    };

    for (const event of events) {
      if (event.origin?.device_id === this.options.deviceId) {
        result.skipped += 1;
        result.skipped_event_ids.push(event.event_id);
        result.skipped_doc_ids?.push(event.doc_id);
        continue;
      }
      const applied = await this.store.applyRemoteEvent(enrichRuntimeAnnotationEvent(event));
      if (applied.status === 'applied') {
        result.applied += 1;
        result.applied_event_ids.push(event.event_id);
        result.applied_doc_ids?.push(event.doc_id);
      } else if (applied.status === 'skipped') {
        result.skipped += 1;
        result.skipped_event_ids.push(event.event_id);
        result.skipped_doc_ids?.push(event.doc_id);
      } else if (
        isMissingRuntimeDocumentConflict(applied.conflict?.reason)
        || (this.options.advanceCursorOnRecoverableConflicts && isRecoverableRuntimeBacklogConflict(applied.conflict?.reason))
      ) {
        result.skipped += 1;
        result.skipped_event_ids.push(event.event_id);
        result.skipped_doc_ids?.push(event.doc_id);
      } else {
        result.conflicted += 1;
        result.conflict_event_ids.push(event.event_id);
        result.conflict_doc_ids?.push(event.doc_id);
      }
    }

    result.applied_doc_ids = [...new Set(result.applied_doc_ids)];
    result.skipped_doc_ids = [...new Set(result.skipped_doc_ids)];
    result.conflict_doc_ids = [...new Set(result.conflict_doc_ids)];

    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function enrichRuntimeAnnotationEvent(event: RuntimeSyncEvent): RuntimeSyncEvent {
  // update 的注解体在 payload.patch（annotation.update 语义），add 在 payload.annotation。
  const annotationKey = event.operation === 'annotation.add'
    ? 'annotation'
    : event.operation === 'annotation.update'
      ? 'patch'
      : null;
  if (!annotationKey) return event;
  const annotation = event.payload[annotationKey];
  if (!isRecord(annotation)) return event;
  const markMeta = {
    mark_id: event.payload.mark_id,
    mark_seq: event.payload.mark_seq,
    marked_text: event.payload.marked_text,
    kind: event.payload.kind,
    feature_type: event.payload.feature_type,
    tool: event.payload.tool,
    origin: event.payload.origin,
    scored_type: event.payload.scored_type,
    hmp_action: event.payload.hmp_action,
    page_id: event.payload.page_id,
    page_index: event.payload.page_index,
    bbox: event.payload.bbox,
    created_at: event.created_at,
    updated_at: event.updated_at,
    source_device_id: event.origin?.device_id,
  };
  return {
    ...event,
    payload: {
      ...event.payload,
      [annotationKey]: {
        ...annotation,
        inkloop_mark: {
          ...(isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : {}),
          ...Object.fromEntries(Object.entries(markMeta).filter(([, value]) => value !== undefined && value !== null && value !== '')),
        },
      },
    },
  };
}

function isMissingRuntimeDocumentConflict(reason: unknown): boolean {
  return typeof reason === 'string' && /runtime document is missing/i.test(reason);
}

function isRecoverableRuntimeBacklogConflict(reason: unknown): boolean {
  return typeof reason === 'string' && (
    /Remote (annotation )?block was not found/i.test(reason)
    || /Remote annotation was not found/i.test(reason)
    || /Remote bootstrap snapshot is missing or mismatched/i.test(reason)
  );
}
