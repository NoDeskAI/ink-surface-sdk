import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import type { PersistedMark } from '../../core/store-format';
import { isRuntimeInvalidPageNormMark, isRuntimeSilentMark, runtimeMarkDedupeKey, runtimeSyncEventIdForMarkId } from './runtime-sync-bridge';

export interface VisibleRuntimeMarkAlignmentInput {
  docId: string;
  marks: PersistedMark[];
  runtimeStore: Pick<OfflineRuntimeStorePort, 'listOutboxEvents' | 'appendSyncEvent'>;
  buildEvents?: () => RuntimeSyncEvent[] | Promise<RuntimeSyncEvent[]>;
  now?: () => string;
}

export interface VisibleRuntimeMarkAlignmentResult {
  doc_id: string;
  scanned: number;
  visible_marks: number;
  requeued: number;
  missing_event_ids: string[];
  requeued_event_ids: string[];
  created_event_ids: string[];
}

export function visibleRuntimeMarkSignature(marks: PersistedMark[]): string {
  return marks
    .filter((mark) => !isRuntimeSilentMark(mark) && !isRuntimeInvalidPageNormMark(mark))
    .map((mark) => {
      const strokeShape = (mark.strokes ?? [])
        .map((stroke) => `${stroke.tool}:${stroke.points?.length ?? 0}`)
        .join(',');
      return `${mark.mark_id}:${mark.seq}:${mark.page_id}:${mark.page_index}:${mark.is_tombstone ? 1 : 0}:${strokeShape}`;
    })
    .sort()
    .join('|');
}

function visibleRuntimeMarks(marks: PersistedMark[]): PersistedMark[] {
  return marks.filter((mark) => !isRuntimeSilentMark(mark) && !isRuntimeInvalidPageNormMark(mark));
}

function payloadMarkId(event: RuntimeSyncEvent): string {
  const value = event.payload?.mark_id;
  return typeof value === 'string' ? value : '';
}

/** revision 级覆盖判定：add/update 均算断言了该 mark 的当前可见 revision。 */
function eventCoversVisibleMark(event: RuntimeSyncEvent, docId: string, mark: PersistedMark): boolean {
  if (event.doc_id !== docId
    || (event.operation !== 'annotation.add' && event.operation !== 'annotation.update')) return false;
  if (payloadMarkId(event) !== mark.mark_id) return false;
  return event.payload.mark_seq === mark.seq
    || event.event_id === runtimeSyncEventIdForMarkId(mark.mark_id, mark.seq)
    || event.dedupe_key === runtimeMarkDedupeKey(docId, mark, 'annotation.add')
    || event.dedupe_key === runtimeMarkDedupeKey(docId, mark, 'annotation.update');
}

function missingEventIds(events: RuntimeSyncEvent[], docId: string, marks: PersistedMark[]): string[] {
  return marks
    .filter((mark) => !events.some((event) => eventCoversVisibleMark(event, docId, mark)))
    .map((mark) => runtimeSyncEventIdForMarkId(mark.mark_id, mark.seq))
    .sort();
}

function isVisibleMarkAddEvent(event: RuntimeSyncEvent, docId: string, marks: PersistedMark[]): boolean {
  return marks.some((mark) => eventCoversVisibleMark(event, docId, mark));
}

function newPendingEvent(event: RuntimeSyncEvent, now: string): RuntimeSyncEvent {
  const pending: RuntimeSyncEvent = {
    ...event,
    status: 'pending',
    attempt_count: 0,
    updated_at: now,
  };
  delete pending.last_error;
  delete pending.next_retry_at;
  delete pending.sent_at;
  delete pending.ack_id;
  delete pending.deduped_by_event_id;
  return pending;
}

export async function requeueVisibleRuntimeMarksForCloudAlignment(
  input: VisibleRuntimeMarkAlignmentInput,
): Promise<VisibleRuntimeMarkAlignmentResult> {
  const now = input.now?.() ?? new Date().toISOString();
  const marks = visibleRuntimeMarks(input.marks);
  const nextEvents = await input.runtimeStore.listOutboxEvents();
  const createdEventIds: string[] = [];

  let unresolvedMissingEventIds = missingEventIds(nextEvents, input.docId, marks);
  if (unresolvedMissingEventIds.length && input.buildEvents) {
    const knownEventIds = new Set(nextEvents.map((event) => event.event_id));
    const knownDedupeKeys = new Set(nextEvents.map((event) => event.dedupe_key).filter(Boolean));
    for (const event of await input.buildEvents()) {
      const missingMarks = marks.filter((mark) => !nextEvents.some((candidate) => eventCoversVisibleMark(candidate, input.docId, mark)));
      if (!isVisibleMarkAddEvent(event, input.docId, missingMarks)) continue;
      if (knownEventIds.has(event.event_id)) continue;
      if (event.dedupe_key && knownDedupeKeys.has(event.dedupe_key)) continue;
      const pending = newPendingEvent(event, now);
      await input.runtimeStore.appendSyncEvent(pending);
      nextEvents.push(pending);
      knownEventIds.add(pending.event_id);
      if (pending.dedupe_key) knownDedupeKeys.add(pending.dedupe_key);
      createdEventIds.push(pending.event_id);
    }
    unresolvedMissingEventIds = missingEventIds(nextEvents, input.docId, marks);
  }

  return {
    doc_id: input.docId,
    scanned: input.marks.length,
    visible_marks: marks.length,
    requeued: 0,
    missing_event_ids: unresolvedMissingEventIds,
    requeued_event_ids: [],
    created_event_ids: createdEventIds,
  };
}
