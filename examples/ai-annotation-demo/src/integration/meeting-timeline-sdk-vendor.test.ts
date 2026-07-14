import { describe, expect, it } from 'vitest';
// @ts-ignore - declarations are adjacent to this vendor ESM outside src; Node/Vitest verify the import.
import { normalizeGoogleMeetTranscriptEntries } from '../../vendor/meeting-timeline-sdk/adapters/transcript.mjs';
// @ts-ignore - declarations are adjacent to this vendor ESM outside src; Node/Vitest verify the import.
import { normalizeAbsoluteMs } from '../../vendor/meeting-timeline-sdk/time.mjs';

describe('meeting timeline SDK vendor subset', () => {
  it('normalizes a Google Meet transcript entry', () => {
    const entry = {
      name: 'conferenceRecords/record-1/transcripts/transcript-1/entries/entry-1',
      participant: 'conferenceRecords/record-1/participants/participant-1',
      startTime: '2026-07-14T10:00:00.000Z',
      endTime: '2026-07-14T10:00:02.500Z',
      text: 'Project review starts now.',
    };

    expect(normalizeGoogleMeetTranscriptEntries({ transcriptEntries: [entry] })).toEqual([{
      id: 'entry-1',
      start_time: entry.startTime,
      end_time: entry.endTime,
      speaker_id: 'participant-1',
      text: entry.text,
      source: 'google_meet_transcript',
      raw: entry,
    }]);
  });

  it('normalizes RFC3339 and millisecond timestamps', () => {
    const rfc3339 = '2026-07-14T10:00:00.000Z';
    const milliseconds = Date.parse(rfc3339);

    expect(normalizeAbsoluteMs(rfc3339)).toBe(milliseconds);
    expect(normalizeAbsoluteMs(milliseconds)).toBe(milliseconds);
  });
});
