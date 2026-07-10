import { describe, expect, it } from 'vitest';

import { state } from '../app/state';
import { readerDocumentPageInfo, readerPageTopForIndex, shouldRenderReplyMarkerState } from './reader';

describe('reader pagination', () => {
  it('advances each virtual page by one full viewport without overlap', () => {
    expect(readerPageTopForIndex(0, 812)).toBe(0);
    expect(readerPageTopForIndex(1, 812)).toBe(812);
    expect(readerPageTopForIndex(27, 812)).toBe(21924);
  });

  it('does not keep resolved AI reply markers on the reader surface', () => {
    expect(shouldRenderReplyMarkerState('shown')).toBe(true);
    expect(shouldRenderReplyMarkerState('accepted')).toBe(false);
    expect(shouldRenderReplyMarkerState('edited')).toBe(false);
    expect(shouldRenderReplyMarkerState('dismissed')).toBe(false);
  });

  it('keeps reader labels aligned when a source page expands into virtual pages', () => {
    const previous = {
      documentId: state.documentId,
      pageIndex: state.pageIndex,
      pageCount: state.pageCount,
      surfaceType: state.surfaceType,
    };
    try {
      state.documentId = 'doc_reader_page_labels';
      state.surfaceType = 'article';
      state.pageIndex = 4;
      state.pageCount = 10;

      const info = readerDocumentPageInfo(4, 10, 1, 2);

      expect(info).toEqual({ current: 10, total: 20, estimated: true });
    } finally {
      state.documentId = previous.documentId;
      state.pageIndex = previous.pageIndex;
      state.pageCount = previous.pageCount;
      state.surfaceType = previous.surfaceType;
    }
  });
});
