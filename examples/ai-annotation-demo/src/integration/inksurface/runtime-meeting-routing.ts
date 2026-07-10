import type { PersistedMark } from '../../core/store-format';
import { meetingDocId } from './meeting-export';

const MEETING_CONTEXT_PREFIX = 'mtg_';
const MEETING_DOC_PREFIX = 'mtgdoc_';
const MEETING_BOARD_PREFIX = 'mtgboard_';

export function meetingIdFromRuntimeDocumentId(documentId: string): string | null {
  return documentId.startsWith(MEETING_DOC_PREFIX) ? documentId.slice(MEETING_DOC_PREFIX.length) : null;
}

export function meetingIdFromContextId(contextId?: string): string | null {
  return contextId?.startsWith(MEETING_CONTEXT_PREFIX) ? contextId.slice(MEETING_CONTEXT_PREFIX.length) : null;
}

export function meetingContextId(meetingId: string): string {
  return `${MEETING_CONTEXT_PREFIX}${meetingId}`;
}

export function runtimeDocumentIdForLedgerMark(mark: Pick<PersistedMark, 'document_id' | 'context_id'>): string {
  const meetingId = meetingIdFromContextId(mark.context_id);
  return meetingId ? meetingDocId(meetingId) : mark.document_id;
}

export function runtimeDocumentIdForSyncRequest(documentId: string): string {
  if (documentId.startsWith(MEETING_DOC_PREFIX)) return documentId;
  return documentId.startsWith(MEETING_BOARD_PREFIX) ? meetingDocId(documentId.slice(MEETING_BOARD_PREFIX.length)) : documentId;
}
