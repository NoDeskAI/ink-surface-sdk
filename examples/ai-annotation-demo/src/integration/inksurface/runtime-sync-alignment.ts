import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import type { OfflineRuntimeStorePort } from 'ink-surface-sdk/offline-store';
import type { PersistedMark } from '../../core/store-format';
import { isRuntimeInvalidPageNormMark, isRuntimeSilentMark, runtimeMarkDedupeKey, runtimeSyncEventIdForMarkId } from './runtime-sync-bridge';

export interface VisibleRuntimeMarkAlignmentInput {
  docId: string;
  marks: PersistedMark[];
  runtimeStore: Pick<OfflineRuntimeStorePort, 'listOutboxEvents' | 'writeOutboxEvents'>;
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

function latestBootstrapIndex(events: RuntimeSyncEvent[], docId: string): number {
  let latest = -1;
  events.forEach((event, index) => {
    if (event.doc_id === docId && event.operation === 'runtime.bootstrap') latest = index;
  });
  return latest;
}

function shouldRequeue(event: RuntimeSyncEvent): boolean {
  return event.status === 'sent' || event.status === 'failed';
}

function resetForCloudReassert(event: RuntimeSyncEvent, now: string): RuntimeSyncEvent {
  const next: RuntimeSyncEvent = {
    ...event,
    status: 'pending',
    attempt_count: 0,
    updated_at: now,
  };
  delete next.last_error;
  delete next.next_retry_at;
  delete next.sent_at;
  delete next.ack_id;
  delete next.deduped_by_event_id;
  return next;
}

export async function requeueVisibleRuntimeMarksForCloudAlignment(
  input: VisibleRuntimeMarkAlignmentInput,
): Promise<VisibleRuntimeMarkAlignmentResult> {
  const now = input.now?.() ?? new Date().toISOString();
  const marks = visibleRuntimeMarks(input.marks);
  const events = await input.runtimeStore.listOutboxEvents();
  const bootstrapIndex = latestBootstrapIndex(events, input.docId);
  const requeuedEventIds: string[] = [];
  const createdEventIds: string[] = [];
  let changed = false;

  const nextEvents = events.map((event, index) => {
    const localVisibleEvent = isVisibleMarkAddEvent(event, input.docId, marks);
    const latestBootstrap = index === bootstrapIndex && marks.length > 0;
    if ((!localVisibleEvent && !latestBootstrap) || !shouldRequeue(event)) return event;
    changed = true;
    requeuedEventIds.push(event.event_id);
    return resetForCloudReassert(event, now);
  });

  let unresolvedMissingEventIds = missingEventIds(nextEvents, input.docId, marks);
  if (unresolvedMissingEventIds.length && input.buildEvents) {
    const knownEventIds = new Set(nextEvents.map((event) => event.event_id));
    const knownDedupeKeys = new Set(nextEvents.map((event) => event.dedupe_key).filter(Boolean));
    for (const event of await input.buildEvents()) {
      if (event.doc_id !== input.docId
        || (event.operation !== 'annotation.add' && event.operation !== 'annotation.update')) continue;
      if (!isVisibleMarkAddEvent(event, input.docId, marks)) continue;
      if (knownEventIds.has(event.event_id)) continue;
      if (event.dedupe_key && knownDedupeKeys.has(event.dedupe_key)) continue;
      const pending = resetForCloudReassert(event, now);
      nextEvents.push(pending);
      knownEventIds.add(pending.event_id);
      if (pending.dedupe_key) knownDedupeKeys.add(pending.dedupe_key);
      createdEventIds.push(pending.event_id);
      changed = true;
    }
    unresolvedMissingEventIds = missingEventIds(nextEvents, input.docId, marks);
  }

  if (changed) await input.runtimeStore.writeOutboxEvents(nextEvents);

  return {
    doc_id: input.docId,
    scanned: input.marks.length,
    visible_marks: marks.length,
    requeued: requeuedEventIds.length,
    missing_event_ids: unresolvedMissingEventIds,
    requeued_event_ids: requeuedEventIds,
    created_event_ids: createdEventIds,
  };
}
