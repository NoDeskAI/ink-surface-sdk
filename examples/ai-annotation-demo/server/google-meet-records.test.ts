import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backfillGoogleMeetSmartNotes,
  chooseGoogleMeetCandidate,
  chooseGoogleMeetRecord,
  fetchGoogleMeetingTranscript,
  googleMeetingLinesToSrt,
  normalizeGoogleMeetRecording,
  normalizeGoogleMeetSmartNote,
} from './google-meet-records';

const smartNotesFixture = JSON.parse(readFileSync(new URL('./fixtures/google-meet-smart-notes-list.json', import.meta.url), 'utf8'));
const recordingsFixture = JSON.parse(readFileSync(new URL('./fixtures/google-meet-recordings-list.json', import.meta.url), 'utf8'));
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const oversizedSmartNoteText = `Gemini overview\n\n${'会议纪要'.repeat(12_000)}`;

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

  it('absolutely prefers records overlapping an attendance window and keeps legacy behavior without one', () => {
    const scheduledAt = '2026-07-15T04:00:00.000Z';
    const transcriptReadyButAbsent = {
      record: { name: 'conferenceRecords/absent', startTime: '2026-07-15T03:58:00.000Z', endTime: '2026-07-15T04:05:00.000Z' },
      transcripts: [{ name: 'conferenceRecords/absent/transcripts/t1', state: 'FILE_GENERATED' }],
    };
    const attended = {
      record: { name: 'conferenceRecords/attended', startTime: '2026-07-15T04:20:00.000Z', endTime: '2026-07-15T05:00:00.000Z' },
      transcripts: [],
    };

    expect(chooseGoogleMeetCandidate([
      transcriptReadyButAbsent,
      attended,
    ], scheduledAt, [{
      startMs: Date.parse('2026-07-15T04:25:00.000Z'),
      endMs: Date.parse('2026-07-15T04:55:00.000Z'),
    }])?.record.name).toBe('conferenceRecords/attended');
    expect(chooseGoogleMeetCandidate([transcriptReadyButAbsent, attended], scheduledAt)?.record.name)
      .toBe('conferenceRecords/absent');
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
      if (url.pathname.endsWith('/smartNotes')) return jsonResponse({ smartNotes: [] });
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
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
      if (url.pathname === '/v2/conferenceRecords/main/smartNotes' && !url.searchParams.get('pageToken')) {
        return jsonResponse({ ...smartNotesFixture, nextPageToken: 'smart-page-2' });
      }
      if (url.pathname === '/v2/conferenceRecords/main/smartNotes' && url.searchParams.get('pageToken') === 'smart-page-2') {
        return jsonResponse({ smartNotes: [] });
      }
      if (url.pathname === '/v2/conferenceRecords/main/recordings') return jsonResponse(recordingsFixture);
      if (url.pathname === '/drive/v3/files/gemini-note-file-1/export') {
        expect(url.searchParams.get('mimeType')).toBe('text/plain');
        return new Response(oversizedSmartNoteText);
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
      grantedScopes: [DRIVE_READONLY_SCOPE],
    });
    expect(pending).toMatchObject({ status: 'pending', next_check_at: '2026-07-15T02:05:00.000Z' });

    ready = true;
    const result = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt: record.startTime,
    }, {
      nowMs: Date.parse('2026-07-15T02:05:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      grantedScopes: [DRIVE_READONLY_SCOPE],
    });

    expect(result.status).toBe('ready');
    expect(result.transcript?.lines).toEqual([
      expect.objectContaining({ speaker_id: 'p1', speaker_name: 'Ada', text: 'First line' }),
      expect.objectContaining({ speaker_id: 'p1', speaker_name: 'Ada', text: 'Second line' }),
    ]);
    expect(result.transcript?.srt).toContain('00:00:01,500 --> 00:00:03,000\nAda: First line');
    expect(result.transcript?.srt).toContain('00:00:04,000 --> 00:00:05,250\nAda: Second line');
    expect(result.smart_note).toMatchObject({
      export_uri: 'https://docs.google.com/document/d/gemini-note-file-1/edit',
    });
    expect(result.smart_note?.text).toMatch(/^Gemini overview/);
    expect(Buffer.byteLength(result.smart_note?.text || '', 'utf8')).toBeLessThanOrEqual(100 * 1024);
    expect(result.recordings).toEqual([{
      export_uri: 'https://drive.google.com/file/d/meeting-recording-file-1/view',
      state: 'FILE_GENERATED',
    }]);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const job = Object.values(stored.meetings)[0] as { status: string; terminal: boolean; entries: unknown[]; smart_note: unknown; recordings: unknown[] };
    expect(job).toMatchObject({ status: 'ready', terminal: true });
    expect(job.entries).toHaveLength(2);
    expect(job.smart_note).toMatchObject({
      name: 'conferenceRecords/main/smartNotes/note-1',
      document: 'documents/gemini-note-file-1',
    });
    expect(job.recordings).toEqual([expect.objectContaining({ drive_file: 'files/meeting-recording-file-1' })]);
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
      if (url.pathname.endsWith('/smartNotes')) return jsonResponse({ smartNotes: [] });
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
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

  it('rechecks a stale terminal job and flips to ready when a new record appears', async () => {
    const path = statePath();
    const scheduledAt = '2026-07-15T01:00:00.000Z';
    const terminalAtMs = Date.parse('2026-07-15T04:00:00.000Z');
    let recordAvailable = false;
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') {
        return jsonResponse({ conferenceRecords: recordAvailable ? [{
          name: 'conferenceRecords/late',
          startTime: '2026-07-15T01:05:00.000Z',
          endTime: '2026-07-15T02:00:00.000Z',
        }] : [] });
      }
      if (url.pathname.endsWith('/transcripts')) {
        return jsonResponse({ transcripts: [{ name: 'conferenceRecords/late/transcripts/tx1', state: 'FILE_GENERATED' }] });
      }
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      if (url.pathname.endsWith('/smartNotes')) return jsonResponse({ smartNotes: [] });
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
      if (url.pathname.endsWith('/transcripts/tx1/entries')) {
        return jsonResponse({ transcriptEntries: [{
          name: 'conferenceRecords/late/transcripts/tx1/entries/e1',
          participant: 'conferenceRecords/late/participants/p1',
          startTime: '2026-07-15T01:05:01.000Z',
          endTime: '2026-07-15T01:05:02.000Z',
          text: 'Late transcript',
        }] });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    const terminal = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt,
    }, {
      nowMs: terminalAtMs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(terminal.status).toBe('no_record');
    const callsAtTerminal = fetchImpl.mock.calls.length;

    recordAvailable = true;
    const stillTerminal = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt,
    }, {
      nowMs: terminalAtMs + 9 * 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(stillTerminal.status).toBe('no_record');
    expect(fetchImpl).toHaveBeenCalledTimes(callsAtTerminal);

    const ready = await fetchGoogleMeetingTranscript('token', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt,
    }, {
      nowMs: terminalAtMs + 10 * 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ready).toMatchObject({
      status: 'ready',
      record: { name: 'conferenceRecords/late' },
      transcript: { name: 'conferenceRecords/late/transcripts/tx1' },
    });
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.values(stored.meetings)[0]).toMatchObject({ status: 'ready', terminal: true });
  });

  it('marks a smart note as scope-missing without blocking a ready transcript', async () => {
    const path = statePath();
    const record = {
      name: 'conferenceRecords/main',
      startTime: '2026-07-15T01:00:00.000Z',
      endTime: '2026-07-15T02:00:00.000Z',
    };
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [record] });
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [{ name: `${record.name}/transcripts/tx1`, state: 'FILE_GENERATED' }] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      if (url.pathname.endsWith('/smartNotes')) return jsonResponse(smartNotesFixture);
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
      if (url.pathname.endsWith('/entries')) return jsonResponse({ transcriptEntries: [] });
      if (url.pathname === '/drive/v3/files/gemini-note-file-1/export') return new Response('Exported after reauthorization.');
      throw new Error(`unexpected ${url.pathname}`);
    });

    const result = await fetchGoogleMeetingTranscript('token-without-drive', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt: record.startTime,
    }, {
      nowMs: Date.parse('2026-07-15T02:05:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      grantedScopes: ['https://www.googleapis.com/auth/meetings.space.readonly'],
    });

    expect(result).toMatchObject({ status: 'ready', smart_note: { scope_missing: true } });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/drive/v3/files/'))).toBe(false);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.values(stored.meetings)[0]).toMatchObject({ smart_note_scope_missing: true });

    const afterReauthorization = await fetchGoogleMeetingTranscript('token-with-drive', { path }, {
      meetingCode: 'abc-defg-hij',
      scheduledAt: record.startTime,
    }, {
      nowMs: Date.parse('2026-07-15T02:05:01.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      grantedScopes: [DRIVE_READONLY_SCOPE],
    });
    expect(afterReauthorization.smart_note).toMatchObject({ text: 'Exported after reauthorization.' });
    const refreshed = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.values(refreshed.meetings)[0]).not.toHaveProperty('smart_note_scope_missing');
  });

  it('backfills a stub smart note (name only) after Gemini finishes exporting the doc', async () => {
    const path = statePath();
    const record = {
      name: 'conferenceRecords/main',
      startTime: '2026-07-15T14:20:00.000Z',
      endTime: '2026-07-15T14:25:00.000Z',
    };
    let noteExported = false;
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [record] });
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [{ name: `${record.name}/transcripts/tx1`, state: 'FILE_GENERATED' }] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      if (url.pathname.endsWith('/smartNotes')) {
        return jsonResponse({ smartNotes: [{
          name: `${record.name}/smartNotes/note1`,
          ...(noteExported ? { docsDestination: { document: 'gemini-doc-1', exportUri: 'https://docs.google.com/document/d/gemini-doc-1/edit' } } : {}),
        }] });
      }
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
      if (url.pathname.endsWith('/entries')) return jsonResponse({ transcriptEntries: [] });
      if (url.pathname === '/drive/v3/files/gemini-doc-1/export') return new Response('Gemini 智能纪要正文');
      throw new Error(`unexpected ${url.pathname}`);
    });
    const options = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      grantedScopes: [DRIVE_READONLY_SCOPE],
    };
    const input = { meetingCode: 'abc-defg-hij', scheduledAt: record.startTime };

    // 会议结束 40 秒后首拉：转写 ready，但 Gemini Doc 还没导出——smart_note 只有资源名。
    const first = await fetchGoogleMeetingTranscript('token', { path }, input, {
      ...options, nowMs: Date.parse('2026-07-15T14:25:40.000Z'),
    });
    expect(first.status).toBe('ready');
    expect(first.smart_note ?? {}).not.toHaveProperty('text');
    const callsAfterFirst = fetchImpl.mock.calls.length;

    // 2 分钟限频内的请求走缓存，不打 Google。
    const throttled = await fetchGoogleMeetingTranscript('token', { path }, input, {
      ...options, nowMs: Date.parse('2026-07-15T14:26:30.000Z'),
    });
    expect(throttled.status).toBe('ready');
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);

    // 3 分钟后 Doc 导出完成：限频窗口过了，回补拉到正文。
    noteExported = true;
    const backfilled = await fetchGoogleMeetingTranscript('token', { path }, input, {
      ...options, nowMs: Date.parse('2026-07-15T14:28:50.000Z'),
    });
    expect(backfilled.smart_note).toMatchObject({ text: 'Gemini 智能纪要正文' });
    expect(backfilled.status).toBe('ready');
    const callsAfterBackfill = fetchImpl.mock.calls.length;
    expect(callsAfterBackfill).toBeGreaterThan(callsAfterFirst);
    // 回补必须是 artifact-only：不重拉 conference records/entries，已到手的 ready 转写不被全量重跑覆盖。
    const backfillRoundPaths = fetchImpl.mock.calls.slice(callsAfterFirst).map(([urlValue]) => new URL(String(urlValue)).pathname);
    expect(backfillRoundPaths.some((p) => p === '/v2/conferenceRecords' || p.endsWith('/entries') || p.endsWith('/transcripts'))).toBe(false);

    // 正文到手 = 终态，后续请求不再回查。
    const settled = await fetchGoogleMeetingTranscript('token', { path }, input, {
      ...options, nowMs: Date.parse('2026-07-15T14:40:00.000Z'),
    });
    expect(settled.smart_note).toMatchObject({ text: 'Gemini 智能纪要正文' });
    expect(fetchImpl.mock.calls.length).toBe(callsAfterBackfill);
  });

  it('hub-side sweep backfills eligible jobs without a device request', async () => {
    const path = statePath();
    const record = {
      name: 'conferenceRecords/main',
      startTime: '2026-07-15T14:20:00.000Z',
      endTime: '2026-07-15T14:25:00.000Z',
    };
    let noteExported = false;
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [record] });
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [{ name: `${record.name}/transcripts/tx1`, state: 'FILE_GENERATED' }] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      if (url.pathname.endsWith('/smartNotes')) {
        return jsonResponse({ smartNotes: [{
          name: `${record.name}/smartNotes/note1`,
          ...(noteExported ? { docsDestination: { document: 'gemini-doc-1' } } : {}),
        }] });
      }
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
      if (url.pathname.endsWith('/entries')) return jsonResponse({ transcriptEntries: [] });
      if (url.pathname === '/drive/v3/files/gemini-doc-1/export') return new Response('后台回补拿到的纪要');
      throw new Error(`unexpected ${url.pathname}`);
    });
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch, grantedScopes: [DRIVE_READONLY_SCOPE] };

    // 设备侧首拉落下空壳。
    await fetchGoogleMeetingTranscript('token', { path }, { meetingCode: 'abc-defg-hij', scheduledAt: record.startTime }, {
      ...options, nowMs: Date.parse('2026-07-15T14:25:40.000Z'),
    });

    // hub 周期扫描（无设备请求）：Doc 已导出 → 回补正文。
    noteExported = true;
    const sweep = await backfillGoogleMeetSmartNotes('token', { path }, {
      ...options, nowMs: Date.parse('2026-07-15T14:28:50.000Z'),
    });
    expect(sweep).toMatchObject({ scanned: 1, backfilled: 1, completed: 1, errors: [] });
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const job = Object.values(stored.meetings)[0] as Record<string, unknown>;
    expect(job.smart_note).toMatchObject({ text: '后台回补拿到的纪要' });
    expect(job.status).toBe('ready');

    // 正文到手后再扫不动它。
    const idle = await backfillGoogleMeetSmartNotes('token', { path }, {
      ...options, nowMs: Date.parse('2026-07-15T14:32:00.000Z'),
    });
    expect(idle).toMatchObject({ scanned: 0, backfilled: 0 });
  });

  it('stops smart-note backfill once the post-meeting window closes', async () => {
    const path = statePath();
    const record = {
      name: 'conferenceRecords/main',
      startTime: '2026-07-15T14:20:00.000Z',
      endTime: '2026-07-15T14:25:00.000Z',
    };
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [record] });
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [{ name: `${record.name}/transcripts/tx1`, state: 'FILE_GENERATED' }] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      if (url.pathname.endsWith('/smartNotes')) return jsonResponse({ smartNotes: [] });
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ recordings: [] });
      if (url.pathname.endsWith('/entries')) return jsonResponse({ transcriptEntries: [] });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const options = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      grantedScopes: [DRIVE_READONLY_SCOPE],
    };
    const input = { meetingCode: 'abc-defg-hij', scheduledAt: record.startTime };

    const first = await fetchGoogleMeetingTranscript('token', { path }, input, {
      ...options, nowMs: Date.parse('2026-07-15T14:25:40.000Z'),
    });
    expect(first.status).toBe('ready');
    const callsAfterFirst = fetchImpl.mock.calls.length;

    // 会议结束一小时后窗口关闭：没有纪要就是没有，回缓存不再打 Google。
    const closed = await fetchGoogleMeetingTranscript('token', { path }, input, {
      ...options, nowMs: Date.parse('2026-07-15T15:30:00.000Z'),
    });
    expect(closed.status).toBe('ready');
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not clobber a concurrent job written to the file mid-flight (review P1-2)', async () => {
    const path = statePath();
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') {
        // 模拟另一场会议的 runCatchUp 在本请求的网络等待期间完成写盘
        writeFileSync(path, JSON.stringify({
          schema_version: 'inkloop.google_meet_records.v1',
          meetings: {
            'other-meeting|2026-07-15T00:00:00.000Z': {
              meeting_code: 'other-meeting', scheduled_at: '2026-07-15T00:00:00.000Z',
              records: [], status: 'ready', attempt: 1, terminal: true, updated_at: '2026-07-15T00:10:00.000Z',
            },
          },
        }), 'utf8');
        return jsonResponse({ conferenceRecords: [] });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    await fetchGoogleMeetingTranscript('token', { path }, { meetingCode: 'abc-defg-hij', scheduledAt: '2026-07-15T01:00:00.000Z' }, {
      nowMs: Date.parse('2026-07-15T01:05:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // 旧实现：本请求开头的旧快照整文件覆盖 → other-meeting 丢失。现在写时重读合并，两个都在。
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(stored.meetings).sort()).toEqual([
      'abc-defg-hij|2026-07-15T01:00:00.000Z',
      'other-meeting|2026-07-15T00:00:00.000Z',
    ]);
  });

  it('keeps the transcript ready when optional artifacts fail to fetch (review P1-3)', async () => {
    const path = statePath();
    const record = {
      name: 'conferenceRecords/main',
      startTime: '2026-07-15T14:20:00.000Z',
      endTime: '2026-07-15T14:25:00.000Z',
    };
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      if (url.pathname === '/v2/conferenceRecords') return jsonResponse({ conferenceRecords: [record] });
      if (url.pathname.endsWith('/transcripts')) return jsonResponse({ transcripts: [{ name: `${record.name}/transcripts/tx1`, state: 'FILE_GENERATED' }] });
      if (url.pathname.endsWith('/participants')) return jsonResponse({ participants: [] });
      if (url.pathname.endsWith('/smartNotes')) return jsonResponse({ error: { message: 'boom' } }, 500);
      if (url.pathname.endsWith('/recordings')) return jsonResponse({ error: { message: 'boom' } }, 500);
      if (url.pathname.endsWith('/entries')) return jsonResponse({ transcriptEntries: [] });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const result = await fetchGoogleMeetingTranscript('token', { path }, { meetingCode: 'abc-defg-hij', scheduledAt: record.startTime }, {
      nowMs: Date.parse('2026-07-15T14:25:40.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {},
      grantedScopes: [DRIVE_READONLY_SCOPE],
    });
    // 可选产物 5xx 不连累主链：转写照常 ready；纪要留空由 backfill 窗口内重试
    expect(result.status).toBe('ready');
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    const job = Object.values(stored.meetings)[0] as Record<string, unknown>;
    expect(job.status).toBe('ready');
    expect(job.smart_note).toBeUndefined();
  });

  it('normalizes smartNotes and recordings from the locked API fixtures', () => {
    expect(normalizeGoogleMeetSmartNote(smartNotesFixture.smartNotes[0])).toEqual({
      name: 'conferenceRecords/main/smartNotes/note-1',
      document: 'documents/gemini-note-file-1',
      exportUri: 'https://docs.google.com/document/d/gemini-note-file-1/edit',
    });
    expect(normalizeGoogleMeetRecording(recordingsFixture.recordings[0])).toEqual({
      name: 'conferenceRecords/main/recordings/recording-1',
      state: 'FILE_GENERATED',
      drive_file: 'files/meeting-recording-file-1',
      export_uri: 'https://drive.google.com/file/d/meeting-recording-file-1/view',
    });
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
