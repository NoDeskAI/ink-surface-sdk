import { describe, expect, it } from 'vitest';
import { fitMeetingNotePage, MEETING_NOTE_PAGE_ASPECT } from './meeting-note-layout';

describe('fitMeetingNotePage', () => {
  it('fills a portrait host by width without changing the page aspect', () => {
    const size = fitMeetingNotePage(992, 1233);

    expect(size.width).toBe(992);
    expect(size.height).toBe(1232);
    expect(size.width / size.height).toBeCloseTo(MEETING_NOTE_PAGE_ASPECT, 3);
  });

  it('fits a portrait page into a landscape host without stretching strokes', () => {
    const size = fitMeetingNotePage(1322, 902);

    expect(size.height).toBe(902);
    expect(size.width).toBe(726);
    expect(size.width / size.height).toBeCloseTo(MEETING_NOTE_PAGE_ASPECT, 3);
  });

  it('falls back to the standard meeting-note aspect for invalid input', () => {
    const size = fitMeetingNotePage(1322, 902, Number.NaN);

    expect(size).toEqual(fitMeetingNotePage(1322, 902));
  });
});
