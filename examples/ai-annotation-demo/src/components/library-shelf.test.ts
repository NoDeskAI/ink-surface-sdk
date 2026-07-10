import { describe, expect, it } from 'vitest';
import type { LibraryShelfItem } from '../local/store';
import { coverSigil, libraryItemCoverImage, shelfKindLabel, shelfProgress, shelfTitle } from './library-shelf';

function item(patch: Partial<LibraryShelfItem> = {}): LibraryShelfItem {
  return {
    document_id: 'doc_1',
    file_hash: 'hash',
    filename: 'AI时代的UX范式.pdf',
    mime_type: 'application/pdf',
    size_bytes: 100,
    page_count: 10,
    source: 'web',
    sync_status: 'synced',
    local_available: true,
    cloud_available: true,
    updated_at: '2026-07-06T00:00:00.000Z',
    doc: null,
    ...patch,
  };
}

describe('library shelf presentation helpers', () => {
  it('normalizes document kind and display title', () => {
    expect(shelfKindLabel(item({ filename: 'Elon.epub', mime_type: 'application/octet-stream' }))).toBe('EPUB');
    expect(shelfKindLabel(item({ filename: 'notes.markdown', mime_type: 'text/plain' }))).toBe('MD');
    expect(shelfTitle('AI时代的UX范式.pdf')).toBe('AI时代的UX范式');
    expect(coverSigil('AI时代的UX范式', 'PDF')).toBe('UX');
  });

  it('shows unread state without saved progress', () => {
    expect(shelfProgress(item())).toEqual({ percent: 0, label: '未读' });
  });

  it('uses cloud manifest cover when the local document is not downloaded', () => {
    expect(libraryItemCoverImage(item({
      local_available: false,
      sync_status: 'cloud_only',
      cover_image_data_url: 'data:image/jpeg;base64,cloud-cover',
      doc: null,
    }))).toBe('data:image/jpeg;base64,cloud-cover');
  });

  it('uses reader page mapping for reflow progress when available', () => {
    const progress = shelfProgress(item({
      doc: {
        document_id: 'doc_1',
        file_hash: 'hash',
        filename: 'AI时代的UX范式.pdf',
        page_count: 5,
        saved_at: '2026-07-06T00:00:00.000Z',
        version: '1',
        pages: {},
        last_read_progress: {
          page_index: 1,
          page_count: 5,
          reader_page_index: 1,
          reader_page_count: 2,
          percent: 0.3,
          view_mode: 'reader',
          updated_at: '2026-07-06T00:00:00.000Z',
        },
      },
    }), {
      readerPageInfo: () => ({ current: 4, total: 10, estimated: false }),
    });
    expect(progress).toEqual({ percent: 0.3, label: '4/10 · 30%' });
  });
});
