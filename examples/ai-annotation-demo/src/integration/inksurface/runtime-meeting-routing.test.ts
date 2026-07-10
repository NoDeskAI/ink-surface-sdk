import { describe, expect, it } from 'vitest';
import { meetingContextId, meetingIdFromContextId, meetingIdFromRuntimeDocumentId, runtimeDocumentIdForLedgerMark, runtimeDocumentIdForSyncRequest } from './runtime-meeting-routing';

describe('runtime meeting routing', () => {
  it('routes marks captured in a meeting context to the meeting source-unit runtime document', () => {
    expect(meetingIdFromContextId('mtg_mtg_demo1')).toBe('mtg_demo1');
    expect(meetingContextId('mtg_demo1')).toBe('mtg_mtg_demo1');
    expect(runtimeDocumentIdForLedgerMark({
      document_id: 'mtgboard_mtg_demo1',
      context_id: 'mtg_mtg_demo1',
    })).toBe('mtgdoc_mtg_demo1');
    expect(runtimeDocumentIdForSyncRequest('mtgboard_mtg_demo1')).toBe('mtgdoc_mtg_demo1');
    expect(runtimeDocumentIdForSyncRequest('mtgdoc_mtg_demo1')).toBe('mtgdoc_mtg_demo1');
  });

  it('keeps ordinary document marks on the document runtime id', () => {
    expect(meetingIdFromContextId('__reader__')).toBeNull();
    expect(meetingIdFromRuntimeDocumentId('doc_reader')).toBeNull();
    expect(runtimeDocumentIdForLedgerMark({
      document_id: 'doc_reader',
      context_id: '__reader__',
    })).toBe('doc_reader');
    expect(runtimeDocumentIdForSyncRequest('doc_reader')).toBe('doc_reader');
  });
});
