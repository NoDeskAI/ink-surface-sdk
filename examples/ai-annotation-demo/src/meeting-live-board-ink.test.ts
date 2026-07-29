import { describe, expect, it } from 'vitest';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import {
  MeetingLiveBoardInkProjection,
  liveBoardMeetingDocumentId,
} from './meeting-live-board-ink';

function event(input: {
  id: string;
  doc?: string;
  operation?: RuntimeSyncEvent['operation'];
  ko?: string;
  payload?: Record<string, unknown>;
}): RuntimeSyncEvent {
  const operation = input.operation ?? 'annotation.add';
  const ko = input.ko ?? 'ko-1';
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.id,
    source: 'inkloop_device',
    doc_id: input.doc ?? 'mtgdoc_interview-1',
    operation,
    target: { type: 'annotation', id: ko },
    payload: input.payload ?? {
      page_index: 0,
      annotation: {
        ko_id: ko,
        visual_strokes: [{
          tool: 'pen',
          color: '#123456',
          opacity: 0.8,
          coord_space: 'page_norm',
          points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }],
        }],
      },
    },
    status: 'sent',
    dedupe_key: input.id,
    created_at: '2026-07-22T00:00:00.000Z',
    updated_at: '2026-07-22T00:00:00.000Z',
  };
}

describe('liveBoardMeetingDocumentId', () => {
  it('normalizes explicit meeting and legacy meeting-board identifiers', () => {
    expect(liveBoardMeetingDocumentId('meeting-1')).toBe('mtgdoc_meeting-1');
    expect(liveBoardMeetingDocumentId('mtgboard_meeting-1')).toBe('mtgdoc_meeting-1');
    expect(liveBoardMeetingDocumentId('mtgdoc_meeting-1')).toBe('mtgdoc_meeting-1');
    expect(liveBoardMeetingDocumentId('../meeting-1')).toBeNull();
  });
});

describe('MeetingLiveBoardInkProjection', () => {
  it('only projects the explicitly selected meeting and ignores duplicate delivery', () => {
    const projection = new MeetingLiveBoardInkProjection('mtgdoc_interview-1');
    const selected = event({ id: 'evt-1' });

    expect(projection.apply([
      event({ id: 'evt-other', doc: 'mtgdoc_other' }),
      selected,
      selected,
      event({ id: 'evt-document', operation: 'block.update' }),
    ])).toBe(true);
    expect(projection.strokes()).toEqual([expect.objectContaining({
      id: 'ko-1:0',
      path: 'M 0.1000 0.2000 L 0.4000 0.5000',
      color: '#123456',
      opacity: 0.8,
      pageIndex: 0,
    })]);
  });

  it('locks an unscoped board to the first future meeting document', () => {
    const projection = new MeetingLiveBoardInkProjection();

    projection.apply([
      event({ id: 'evt-non-meeting', doc: 'doc_notes' }),
      event({ id: 'evt-first', doc: 'mtgdoc_interview-1' }),
      event({ id: 'evt-second', doc: 'mtgdoc_interview-2', ko: 'ko-2' }),
    ]);

    expect(projection.meetingDocumentId).toBe('mtgdoc_interview-1');
    expect(projection.strokes()).toHaveLength(1);
  });

  it('replaces annotation strokes on update and removes them on delete', () => {
    const projection = new MeetingLiveBoardInkProjection('mtgdoc_interview-1');
    projection.apply([event({ id: 'evt-add' })]);
    projection.apply([event({
      id: 'evt-update',
      operation: 'annotation.update',
      payload: {
        page_index: 1,
        ko_id: 'ko-1',
        patch: {
          ko_id: 'ko-1',
          visual_strokes: [{
            tool: 'highlighter',
            color: '#ffcc00',
            coord_space: 'page_norm',
            points: [{ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 }],
          }],
        },
      },
    })]);

    expect(projection.activePageIndex).toBe(1);
    expect(projection.strokes()).toEqual([expect.objectContaining({
      id: 'ko-1:0',
      color: '#ffcc00',
      width: 0.012,
      pageIndex: 1,
    })]);

    projection.apply([event({
      id: 'evt-delete',
      operation: 'annotation.delete',
      payload: { ko_id: 'ko-1' },
    })]);
    expect(projection.strokes()).toEqual([]);
  });

  it('uses surface strokes when visual strokes are absent and maps block-normalized points through the annotation bbox', () => {
    const projection = new MeetingLiveBoardInkProjection('mtgdoc_interview-1');
    projection.apply([event({
      id: 'evt-surface',
      payload: {
        annotation: {
          ko_id: 'ko-surface',
          visual_bbox: [0.2, 0.3, 0.4, 0.2],
          surface_strokes: [{
            tool: 'aipen',
            color: 'not-a-safe-color\"',
            coord_space: 'block_norm',
            capture_surface: 'whiteboard',
            points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          }],
        },
      },
    })]);

    expect(projection.strokes()).toEqual([expect.objectContaining({
      id: 'ko-surface:0',
      path: 'M 0.2000 0.3000 L 0.6000 0.5000',
      color: '#172522',
    })]);
  });

  it('keeps prior geometry for metadata-only updates and can switch to a server-bound meeting', () => {
    const projection = new MeetingLiveBoardInkProjection('mtgdoc_interview-1');
    projection.apply([event({ id: 'evt-add' })]);
    expect(projection.apply([event({
      id: 'evt-metadata',
      operation: 'annotation.update',
      payload: { ko_id: 'ko-1', patch: { ko_id: 'ko-1', title: 'updated title' } },
    })])).toBe(false);
    expect(projection.strokes()).toHaveLength(1);

    expect(projection.selectMeeting('mtgdoc_interview-2')).toBe(true);
    expect(projection.strokes()).toEqual([]);
    expect(projection.meetingDocumentId).toBe('mtgdoc_interview-2');
  });

  it('returns and optimistically clears annotation identities so clear can publish tombstones', () => {
    const projection = new MeetingLiveBoardInkProjection('mtgdoc_interview-1');
    projection.apply([
      event({ id: 'evt-add-1', ko: 'ko-1' }),
      event({ id: 'evt-add-2', ko: 'ko-2' }),
    ]);

    expect(projection.clear()).toEqual(['ko-1', 'ko-2']);
    expect(projection.strokes()).toEqual([]);
  });
});
