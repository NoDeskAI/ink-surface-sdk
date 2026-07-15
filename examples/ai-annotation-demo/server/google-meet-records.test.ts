import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseGoogleMeetCandidate,
  chooseGoogleMeetRecord,
  fetchGoogleMeetingTranscript,
  googleMeetingLinesToSrt,
} from './google-meet-records';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('google meet records', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function statePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-google-meet-'));
    roots.push(root);
    return join(root, 'meet-records.json');
  }

  it('prefers the session with a ready transcript over a closer transcript-less rejoin', async () => {
    // 真机事故还原：11:50 开的正主场次（转写已生成）离 12:00 计划时间反而比 11:58 的复进场次远，
    // 纯时间就近会选中没转写的复进场次、永远 pending。
    const scheduledAt = '2026-07-15T04:00:00.000Z';
    const main = {
      record: { name: 'conferenceRecords/main', startTime: '2026-07-15T03:50:48.000Z', endTime: '2026-07-15T03:57:00.000Z' },
      transcripts: [{ name: 'conferenceRecords/main/transcripts/t1', state: 'FILE_GENERATED' }],
    };
    const rejoin = {
      record: { name: 'conferenceRecords/rejoin', startTime: '2026-07-15T03:58:22.000Z', endTime: '2026-07-15T04:06:13.000Z' },
      transcripts: [],
    };
    expect(chooseGoogleMeetCandidate([rejoin, main], scheduledAt)?.record.name).toBe('conferenceRecords/main');
    // 都没转写时退回时间就近
    expect(chooseGoogleMeetCandidate([rejoin, { ...main, transcripts: [] }], scheduledAt)?.record.name).toBe('conferenceRecords/rejoin');
  });

  it('persists all record candidates and chooses the start nearest to the calendar schedule', async () => {
    const path = statePath();
    const scheduledAt = '2026-07-15T01:00:00.000Z';
    const records = [
      { name: 'conferenceRecords/rehearsal', startTime: '2026-07-15T00:10:00.000Z', endTime: '2026-07-15T00:20:00.000Z' },
      { name: 'conferenceRecords/main', startTime: '2026-07-15T01:03:00.000Z', endTime: '2026-07-15T02:00:00.000Z' },
      { name: 'conferenceRecords/rejoin', startTime: '2026-07-15T03:00:00.000Z', endTime: '2026-07-15T03:05:00.000Z' },
    ];
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') {
        expect(url.searchParams.get('filter')).toBe('space.meeting_code="abc-defg-hij"');
        return jsonResponse({ conferenceRecords: records });
      }
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      throw new Error(`unexpected ${url.pathname}`);
    });

    const result = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt,
    }, {
      nowMs: Date.parse('2026-07-15T02:00:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(chooseGoogleMeetRecord(records, scheduledAt)?.name).toBe('conferenceRecords/main');
    expect(result).toMatchObject({ status: 'pending', record: { name: 'conferenceRecords/main' } });
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const job = Object.values(stored.meetings)[0] as { records: unknown[]; chosen_record_name: string };
    expect(job.records).toHaveLength(3);
    expect(job.chosen_record_name).toBe('conferenceRecords/main');
  });

  it('moves from pending to FILE_GENERATED, joins participants, paginates entries, and persists them', async () => {
    const path = statePath();
    const record = {
      name: 'conferenceRecords/main',
      startTime: '2026-07-15T01:00:00.000Z',
      endTime: '2026-07-15T02:00:00.000Z',
    };
    let ready = false;
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [record] });
      if (url.pathname === '/v2/conferenceRecords/main/transcripts') {
        return jsonResponse({ transcripts: [{ name: 'conferenceRecords/main/transcripts/tx1', state: ready ? 'FILE_GENERATED' : 'STARTED' }] });
      }
      if (url.pathname === '/v2/conferenceRecords/main/participants') {
        return jsonResponse({ participants: [{ name: 'conferenceRecords/main/participants/p1', signedinUser: { displayName: 'Ada' } }] });
      }
      if (url.pathname.endsWith('/transcripts/tx1/entries') && !url.searchParams.get('pageToken')) {
        return jsonResponse({
          transcriptEntries: [{
            name: 'conferenceRecords/main/transcripts/tx1/entries/e1',
            participant: 'conferenceRecords/main/participants/p1',
            startTime: '2026-07-15T01:00:01.500Z',
            endTime: '2026-07-15T01:00:03.000Z',
            text: 'First line',
          }],
          nextPageToken: 'page-2',
        });
      }
      if (url.pathname.endsWith('/transcripts/tx1/entries') && url.searchParams.get('pageToken') === 'page-2') {
        return jsonResponse({ transcriptEntries: [{
          name: 'conferenceRecords/main/transcripts/tx1/entries/e2',
          participant: 'conferenceRecords/main/participants/p1',
          startTime: '2026-07-15T01:00:04.000Z',
          endTime: '2026-07-15T01:00:05.250Z',
          text: 'Second line',
        }] });
      }
      throw new Error(`unexpected ${url.toString()}`);
    });

    const pending = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt: record.startTime,
    }, {
      nowMs: Date.parse('2026-07-15T02:02:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(pending).toMatchObject({ status: 'pending', next_check_at: '2026-07-15T02:05:00.000Z' });

    ready = true;
    const result = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt: record.startTime,
    }, {
      nowMs: Date.parse('2026-07-15T02:05:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe('ready');
    expect(result.transcript?.lines).toEqual([
      expect.objectContaining({ speaker_id: 'p1', speaker_name: 'Ada', text: 'First line' }),
      expect.objectContaining({ speaker_id: 'p1', speaker_name: 'Ada', text: 'Second line' }),
    ]);
    expect(result.transcript?.srt).toContain('00:00:01,500 --> 00:00:03,000\nAda: First line');
    expect(result.transcript?.srt).toContain('00:00:04,000 --> 00:00:05,250\nAda: Second line');
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const job = Object.values(stored.meetings)[0] as { status: string; terminal: boolean; entries: unknown[] };
    expect(job).toMatchObject({ status: 'ready', terminal: true });
    expect(job.entries).toHaveLength(2);
  });

  it('advances the durable 2/5/15/30/60/120 minute ladder and terminates as not_generated', async () => {
    const path = statePath();
    const endMs = Date.parse('2026-07-15T02:00:00.000Z');
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [{
        name: 'conferenceRecords/main',
        startTime: '2026-07-15T01:00:00.000Z',
        endTime: new Date(endMs).toISOString(),
      }] });
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [{ name: 'conferenceRecords/main/transcripts/tx1', state: 'STARTED' }] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const expectedNext = [2, 5, 15, 30, 60, 120];
    for (let index = 0; index < expectedNext.length; index += 1) {
      const nowMinutes = index === 0 ? 0 : expectedNext[index - 1];
      const result = await fetchGoogleMeetingTranscript('token', { path }, {
        meetingCode: 'ladder-code',
        scheduledAt: '2026-07-15T01:00:00.000Z',
      }, {
        nowMs: endMs + nowMinutes * 60_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result).toMatchObject({ status: 'pending', next_check_at: new Date(endMs + expectedNext[index] * 60_000).toISOString() });
    }

    const terminal = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'ladder-code',
      scheduledAt: '2026-07-15T01:00:00.000Z',
    }, {
      nowMs: endMs + 120 * 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(terminal).toMatchObject({ status: 'not_generated' });
    expect(terminal.next_check_at).toBeUndefined();
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const job = Object.values(stored.meetings)[0] as { attempt: number; terminal: boolean };
    expect(job).toMatchObject({ attempt: 6, terminal: true });
  });

  it('converts absolute transcript times to relative SRT times', () => {
    expect(googleMeetingLinesToSrt([{
      start_time: '2026-07-15T01:00:00.125Z',
      end_time: '2026-07-15T01:00:02.500Z',
      speaker_id: 'p1',
      speaker_name: 'Grace',
      text: 'Hello',
    }], '2026-07-15T01:00:00.000Z')).toBe('1\n00:00:00,125 --> 00:00:02,500\nGrace: Hello');
  });
});
