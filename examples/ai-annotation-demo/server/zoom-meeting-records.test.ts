import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backfillZoomMeetingTranscripts,
  chooseZoomMeetingCandidate,
  fetchZoomMeetingTranscript,
  parseZoomVtt,
  type ZoomMeetingRecordsEnv,
} from './zoom-meeting-records';
import { resetZoomS2SStateForTests } from './zoom-oauth-state';

const roots: string[] = [];
const baseEnv: ZoomMeetingRecordsEnv = {
  ZOOM_S2S_ACCOUNT_ID: 'account-id',
  ZOOM_S2S_CLIENT_ID: 'client-id',
  ZOOM_S2S_CLIENT_SECRET: 'client-secret',
  ZOOM_MEETING_TRANSCRIPT_PROBE: '0',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function token(): Response {
  return json({ access_token: 'zoom-access-token', expires_in: 3600 });
}

function vtt(body: string): Response {
  return new Response(`WEBVTT\n\n${body}`, { status: 200, headers: { 'content-type': 'text/vtt' } });
}

function statePaths(): { records: string; sync: string } {
  const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-records-'));
  roots.push(root);
  return { records: join(root, 'records.json'), sync: join(root, 'sync.json') };
}

function apiPath(input: string | URL): string {
  return new URL(String(input)).pathname;
}

afterEach(() => {
  resetZoomS2SStateForTests();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('zoom meeting records', () => {
  it('prefers attendance and schedule windows before using transcript availability as the last tie-break', () => {
    const scheduledAt = '2026-07-17T10:00:00.000Z';
    const transcriptSession = {
      uuid: 'session-with-transcript',
      start_time: '2026-07-17T09:40:00.000Z',
      end_time: '2026-07-17T09:50:00.000Z',
      recordings: [{ id: 'tx', file_type: 'TRANSCRIPT' }],
    };
    const attendedSession = {
      uuid: 'session-attended',
      start_time: '2026-07-17T10:01:00.000Z',
      end_time: '2026-07-17T10:30:00.000Z',
      recordings: [],
    };
    expect(chooseZoomMeetingCandidate([
      attendedSession,
      transcriptSession,
    ], scheduledAt, '2026-07-17T10:30:00.000Z', [{
      startMs: Date.parse('2026-07-17T10:02:00.000Z'),
      endMs: Date.parse('2026-07-17T10:20:00.000Z'),
    }])?.uuid).toBe('session-attended');
    expect(chooseZoomMeetingCandidate([
      attendedSession,
      { ...transcriptSession, recordings: [] },
    ], scheduledAt, '2026-07-17T10:30:00.000Z', [{
      startMs: Date.parse('2026-07-17T10:02:00.000Z'),
      endMs: Date.parse('2026-07-17T10:20:00.000Z'),
    }])?.uuid).toBe('session-attended');
    expect(chooseZoomMeetingCandidate([
      { ...attendedSession, uuid: 'same-window-without-transcript' },
      { ...attendedSession, uuid: 'same-window-with-transcript', recordings: [{ id: 'tx', file_type: 'TRANSCRIPT' }] },
    ], scheduledAt, '2026-07-17T10:30:00.000Z')?.uuid).toBe('same-window-with-transcript');
  });

  it('chooses this week in-window occurrence over last week transcript for the same recurring meeting id', () => {
    expect(chooseZoomMeetingCandidate([
      {
        uuid: 'last-week-with-transcript',
        start_time: '2026-07-10T10:00:00.000Z',
        end_time: '2026-07-10T10:30:00.000Z',
        recordings: [{ id: 'old-tx', file_type: 'TRANSCRIPT' }],
      },
      {
        uuid: 'this-week-without-transcript',
        start_time: '2026-07-17T10:01:00.000Z',
        end_time: '2026-07-17T10:30:00.000Z',
        recordings: [],
      },
    ], '2026-07-17T10:00:00.000Z', '2026-07-17T10:30:00.000Z')?.uuid).toBe('this-week-without-transcript');
  });

  it('filters every occurrence outside the attendance and scheduled plausibility window', () => {
    expect(chooseZoomMeetingCandidate([{
      uuid: 'last-week-only',
      start_time: '2026-07-10T10:00:00.000Z',
      end_time: '2026-07-10T11:00:00.000Z',
      recordings: [{ id: 'old-tx', file_type: 'TRANSCRIPT' }],
    }], '2026-07-17T10:00:00.000Z', '2026-07-17T11:00:00.000Z')).toBeUndefined();
  });

  it('uses scheduled overlap duration before start distance when attendance overlap is tied', () => {
    expect(chooseZoomMeetingCandidate([
      {
        uuid: 'long-overlap',
        start_time: '2026-07-17T10:20:00.000Z',
        end_time: '2026-07-17T11:00:00.000Z',
        recordings: [],
      },
      {
        uuid: 'near-start-short-overlap',
        start_time: '2026-07-17T09:59:00.000Z',
        end_time: '2026-07-17T10:01:00.000Z',
        recordings: [],
      },
    ], '2026-07-17T10:00:00.000Z', '2026-07-17T11:00:00.000Z')?.uuid).toBe('long-overlap');
  });

  it('keeps rechecking when only last week exists and selects this week after it appears', async () => {
    const { records } = statePaths();
    let thisWeekAvailable = false;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/110/instances') {
        return json({ meetings: [
          { uuid: 'last-week' },
          ...(thisWeekAvailable ? [{ uuid: 'this-week' }] : []),
        ] });
      }
      if (url.pathname === '/v2/past_meetings/last-week') return json({ start_time: '2026-07-10T10:00:00Z', duration: 30 });
      if (url.pathname === '/v2/past_meetings/this-week') return json({ start_time: '2026-07-17T10:00:00Z', duration: 30 });
      if (url.pathname === '/v2/meetings/last-week/recordings') return json({ recording_files: [{
        id: 'old-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-10T10:00:00Z',
        download_url: 'https://download.zoom.us/old.vtt',
      }] });
      if (url.pathname === '/v2/meetings/this-week/recordings') return json({ recording_files: [{
        id: 'new-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:00:05Z', download_url: 'https://download.zoom.us/new.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/this-week/participants') return json({ participants: [] });
      if (url.pathname === '/new.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: this week');
      throw new Error(`unexpected ${url}`);
    });
    const input = {
      meetingId: '110',
      scheduledAt: '2026-07-17T10:00:00Z',
      scheduledEndAt: '2026-07-17T10:30:00Z',
    };
    const first = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T10:31:00Z'),
    });
    expect(first).toMatchObject({
      status: 'no_record',
      reason: 'instance_not_found',
      next_check_at: '2026-07-17T10:32:00.000Z',
    });
    expect(first).not.toHaveProperty('participants');

    thisWeekAvailable = true;
    const second = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse(first.next_check_at || ''),
    });
    expect(second).toMatchObject({ status: 'ready', instance_uuid: 'this-week', srt: expect.stringContaining('this week') });
  });

  it('stores both discovered instances and chooses the scheduled session through the full fetch chain', async () => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/111/instances') {
        return json({ meetings: [{ uuid: 'near-rejoin' }, { uuid: 'main-session' }] });
      }
      if (url.pathname === '/v2/past_meetings/near-rejoin') {
        return json({ start_time: '2026-07-17T10:01:00Z', duration: 10 });
      }
      if (url.pathname === '/v2/past_meetings/main-session') {
        return json({ start_time: '2026-07-17T09:40:00Z', duration: 10 });
      }
      if (url.pathname === '/v2/meetings/near-rejoin/recordings') {
        return json({ recording_files: [{ id: 'video', file_type: 'MP4' }] });
      }
      if (url.pathname === '/v2/meetings/main-session/recordings') {
        return json({ recording_files: [{
          id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T09:40:00Z',
          recording_end: '2026-07-17T09:40:05Z', download_url: 'https://download.zoom.us/main.vtt',
        }] });
      }
      if (url.pathname === '/v2/past_meetings/near-rejoin/participants') return json({ participants: [] });
      if (url.pathname === '/v2/past_meetings/main-session/participants') return json({ participants: [] });
      if (url.pathname === '/main.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: main');
      throw new Error(`unexpected ${url}`);
    });
    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '111', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:12:00Z'),
    });
    expect(result).toMatchObject({ status: 'not_generated', reason: 'transcript_not_generated', instance_uuid: 'near-rejoin' });
    const job = Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as {
      candidates: Array<{ uuid: string }>;
      chosen_instance_uuid: string;
      selection_input_hash: string;
    };
    expect(job.candidates.map((candidate) => candidate.uuid).sort()).toEqual(['main-session', 'near-rejoin']);
    expect(job.chosen_instance_uuid).toBe('near-rejoin');
    expect(job.selection_input_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rediscovers and reselects a ready job when the attendance selection hash changes', async () => {
    const { records } = statePaths();
    let instancesCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/112/instances') {
        instancesCalls += 1;
        return json({ meetings: [{ uuid: 'first-instance' }, { uuid: 'second-instance' }] });
      }
      if (url.pathname === '/v2/past_meetings/first-instance') return json({ start_time: '2026-07-17T10:00:00Z', duration: 20 });
      if (url.pathname === '/v2/past_meetings/second-instance') return json({ start_time: '2026-07-17T10:20:00Z', duration: 20 });
      if (url.pathname === '/v2/meetings/first-instance/recordings') return json({ recording_files: [{
        id: 'first-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:00:05Z', download_url: 'https://download.zoom.us/first.vtt',
      }] });
      if (url.pathname === '/v2/meetings/second-instance/recordings') return json({ recording_files: [] });
      if (url.pathname === '/v2/past_meetings/first-instance/participants') return json({ participants: [] });
      if (url.pathname === '/v2/past_meetings/second-instance/participants') return json({ participants: [] });
      if (url.pathname === '/first.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: first');
      throw new Error(`unexpected ${url}`);
    });
    const input = {
      meetingId: '112',
      scheduledAt: '2026-07-17T10:00:00Z',
      scheduledEndAt: '2026-07-17T11:00:00Z',
    };
    const first = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      ...input,
      attendance: [{ startMs: Date.parse('2026-07-17T10:01:00Z'), endMs: Date.parse('2026-07-17T10:10:00Z') }],
    }, { fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T11:00:00Z') });
    const firstHash = (Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as { selection_input_hash: string }).selection_input_hash;
    expect(first).toMatchObject({ status: 'ready', instance_uuid: 'first-instance' });

    const second = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      ...input,
      attendance: [{ startMs: Date.parse('2026-07-17T10:21:00Z'), endMs: Date.parse('2026-07-17T10:30:00Z') }],
    }, { fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T11:00:01Z') });
    const secondHash = (Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as { selection_input_hash: string }).selection_input_hash;
    expect(second).toMatchObject({ status: 'no_record', reason: 'recording_missing', instance_uuid: 'second-instance' });
    expect(instancesCalls).toBe(2);
    expect(secondHash).not.toBe(firstHash);
  });

  it('periodically rechecks ready jobs and rebinds when a better in-window UUID appears', async () => {
    const { records } = statePaths();
    let betterAvailable = false;
    let instancesCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/113/instances') {
        instancesCalls += 1;
        return json({ meetings: [{ uuid: 'short-session' }, ...(betterAvailable ? [{ uuid: 'full-session' }] : [])] });
      }
      if (url.pathname === '/v2/past_meetings/short-session') return json({ start_time: '2026-07-17T09:59:00Z', duration: 2 });
      if (url.pathname === '/v2/past_meetings/full-session') return json({ start_time: '2026-07-17T10:20:00Z', duration: 40 });
      if (url.pathname === '/v2/meetings/short-session/recordings') return json({ recording_files: [{
        id: 'short-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T09:59:00Z',
        recording_end: '2026-07-17T09:59:05Z', download_url: 'https://download.zoom.us/short.vtt',
      }] });
      if (url.pathname === '/v2/meetings/full-session/recordings') return json({ recording_files: [{
        id: 'full-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:20:00Z',
        recording_end: '2026-07-17T10:20:05Z', download_url: 'https://download.zoom.us/full.vtt',
      }] });
      if (url.pathname.endsWith('/participants')) return json({ participants: [] });
      if (url.pathname === '/short.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: short');
      if (url.pathname === '/full.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: full');
      throw new Error(`unexpected ${url}`);
    });
    const input = { meetingId: '113', scheduledAt: '2026-07-17T10:00:00Z', scheduledEndAt: '2026-07-17T11:00:00Z' };
    const first = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T11:00:00Z'),
    });
    expect(first).toMatchObject({ status: 'ready', instance_uuid: 'short-session' });

    betterAvailable = true;
    const rebound = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T11:10:00Z'),
    });
    expect(rebound).toMatchObject({ status: 'ready', instance_uuid: 'full-session', srt: expect.stringContaining('full') });
    expect(instancesCalls).toBe(2);
  });

  it('reruns after a pending request when the later attendance input hash differs', async () => {
    const { records } = statePaths();
    let releaseInstances!: () => void;
    let markInstancesStarted!: () => void;
    const instancesGate = new Promise<void>((resolve) => { releaseInstances = resolve; });
    const instancesStarted = new Promise<void>((resolve) => { markInstancesStarted = resolve; });
    let instancesCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/114/instances') {
        instancesCalls += 1;
        if (instancesCalls === 1) {
          markInstancesStarted();
          await instancesGate;
        }
        return json({ meetings: [{ uuid: 'first-window' }, { uuid: 'second-window' }] });
      }
      if (url.pathname === '/v2/past_meetings/first-window') return json({ start_time: '2026-07-17T10:00:00Z', duration: 20 });
      if (url.pathname === '/v2/past_meetings/second-window') return json({ start_time: '2026-07-17T10:30:00Z', duration: 20 });
      if (url.pathname.endsWith('/recordings')) return json({ recording_files: [] });
      if (url.pathname.endsWith('/participants')) return json({ participants: [] });
      throw new Error(`unexpected ${url}`);
    });
    const input = { meetingId: '114', scheduledAt: '2026-07-17T10:00:00Z', scheduledEndAt: '2026-07-17T11:00:00Z' };
    const first = fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      ...input,
      attendance: [{ startMs: Date.parse('2026-07-17T10:01:00Z'), endMs: Date.parse('2026-07-17T10:10:00Z') }],
    }, { fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T11:01:00Z') });
    await instancesStarted;
    const second = fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      ...input,
      attendance: [{ startMs: Date.parse('2026-07-17T10:31:00Z'), endMs: Date.parse('2026-07-17T10:40:00Z') }],
    }, { fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T11:01:00Z') });
    releaseInstances();

    await expect(first).resolves.toMatchObject({ instance_uuid: 'first-window' });
    await expect(second).resolves.toMatchObject({ instance_uuid: 'second-window' });
    expect(instancesCalls).toBe(2);
    const job = Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as { chosen_instance_uuid: string };
    expect(job.chosen_instance_uuid).toBe('second-window');
  });

  it('double-encodes every UUID path when an instance UUID starts with slash', async () => {
    const { records } = statePaths();
    const uuid = '/abc//def';
    const visited: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      visited.push(url.pathname);
      if (url.pathname === '/v2/past_meetings/123456789/instances') return json({ meetings: [{ uuid }] });
      if (url.pathname === '/v2/past_meetings/%252Fabc%252F%252Fdef') {
        return json({ uuid, start_time: '2026-07-17T10:00:00Z', duration: 10 });
      }
      if (url.pathname === '/v2/meetings/%252Fabc%252F%252Fdef/recordings') return json({ recording_files: [] });
      if (url.pathname === '/v2/past_meetings/%252Fabc%252F%252Fdef/participants') return json({ participants: [] });
      throw new Error(`unexpected ${url}`);
    });

    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '123456789',
      scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T10:10:00Z'),
    });
    expect(result).toMatchObject({ status: 'no_record', reason: 'recording_missing', instance_uuid: uuid });
    expect(visited).toEqual(expect.arrayContaining([
      '/v2/past_meetings/%252Fabc%252F%252Fdef',
      '/v2/meetings/%252Fabc%252F%252Fdef/recordings',
      '/v2/past_meetings/%252Fabc%252F%252Fdef/participants',
    ]));
    expect(visited.some((path) => path.includes('/abc//def'))).toBe(false);
  });

  it('downloads every TRANSCRIPT file and merges cues by derived absolute time', async () => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/200/instances') return json({ meetings: [{ uuid: 'main' }] });
      if (url.pathname === '/v2/past_meetings/main') {
        return json({ start_time: '2026-07-17T10:00:00Z', duration: 30 });
      }
      if (url.pathname === '/v2/meetings/main/recordings') {
        expect(url.searchParams.get('include_fields')).toBe('download_access_token');
        return json({
          recording_files: [
            {
              id: 'late', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:05:00Z',
              recording_end: '2026-07-17T10:05:05Z', download_url: 'https://download.zoom.us/late.vtt',
            },
            { id: 'video', file_type: 'MP4', download_url: 'https://download.zoom.us/video.mp4' },
            {
              id: 'early', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:02:00Z',
              recording_end: '2026-07-17T10:02:05Z', download_url: 'https://download.zoom.us/early.vtt',
            },
          ],
        });
      }
      if (url.pathname === '/v2/past_meetings/main/participants') return json({ participants: [] });
      if (url.pathname === '/early.vtt') return vtt('00:00:01.000 --> 00:00:02.000\nGrace: early line');
      if (url.pathname === '/late.vtt') return vtt('00:00:02.000 --> 00:00:03.000\nAda: late: colon stays');
      throw new Error(`unexpected ${url}`);
    });

    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '200',
      scheduledAt: '2026-07-17T10:00:00Z',
      scheduledEndAt: '2026-07-17T10:30:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T10:31:00Z'),
    });

    expect(result.status).toBe('ready');
    expect(result.transcript?.lines.map((line) => [line.recording_file_id, line.text])).toEqual([
      ['early', 'early line'],
      ['late', 'late: colon stays'],
    ]);
    expect(result.srt).toContain('00:02:01,000 --> 00:02:02,000\nGrace: early line');
    expect(result.srt).toContain('00:05:02,000 --> 00:05:03,000\nAda: late: colon stays');
    expect(result.timestamp_quality).toBe('approximate_pause_unknown');
    expect(fetchImpl.mock.calls.map(([input]) => apiPath(input)).filter((path) => path.endsWith('.vtt'))).toEqual([
      '/late.vtt',
      '/early.vtt',
    ]);
  });

  it('falls back to the instance start when a transcript file omits recording_start', async () => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/201/instances') return json({ meetings: [{ uuid: 'fallback-start' }] });
      if (url.pathname === '/v2/past_meetings/fallback-start') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/fallback-start/recordings') return json({ recording_files: [{
        id: 'fallback-tx', file_type: 'TRANSCRIPT', recording_end: '2026-07-17T10:00:05Z',
        download_url: 'https://download.zoom.us/fallback.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/fallback-start/participants') return json({ participants: [] });
      if (url.pathname === '/fallback.vtt') return vtt('00:00:01.000 --> 00:00:02.000\nAda: fallback start');
      throw new Error(`unexpected ${url}`);
    });
    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '201', scheduledAt: '2026-07-17T10:00:00Z',
    }, { fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T10:10:00Z') });
    expect(result).toMatchObject({
      status: 'ready',
      timestamp_quality: 'approximate_pause_unknown',
      transcript: { lines: [{ start_time: '2026-07-17T10:00:01.000Z', text: 'fallback start' }] },
    });
  });

  it('sorts out-of-order VTT cues by start and end offset', () => {
    const cues = parseZoomVtt(`WEBVTT

00:00:05.000 --> 00:00:06.000
Ada: later

00:00:01.000 --> 00:00:03.000
Grace: earlier long

00:00:01.000 --> 00:00:02.000
Lin: earlier short`);
    expect(cues.map((cue) => [cue.startOffsetMs, cue.endOffsetMs, cue.text])).toEqual([
      [1_000, 2_000, 'earlier short'],
      [1_000, 3_000, 'earlier long'],
      [5_000, 6_000, 'later'],
    ]);
  });

  it('consumes participant pagination immediately and preserves rejoin intervals and missing anonymous fields', async () => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/300/instances') return json({ meetings: [{ uuid: 'attended' }] });
      if (url.pathname === '/v2/past_meetings/attended') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/attended/recordings') return json({ recording_files: [{
        id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:00:10Z', download_url: 'https://download.zoom.us/tx.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/attended/participants' && !url.searchParams.get('next_page_token')) {
        return json({
          participants: [
            { id: 'signed-1', name: 'Ada', join_time: '2026-07-17T10:00:00Z', leave_time: '2026-07-17T10:02:00Z' },
            { id: 'signed-1', name: 'Ada', join_time: '2026-07-17T10:03:00Z', leave_time: '2026-07-17T10:08:00Z' },
            { user_email: 'guest@example.com', name: 'Guest', join_time: '2026-07-17T10:01:00Z', leave_time: '2026-07-17T10:09:00Z' },
          ],
          next_page_token: 'page-2',
        });
      }
      if (url.pathname === '/v2/past_meetings/attended/participants' && url.searchParams.get('next_page_token') === 'page-2') {
        return json({ participants: [{ join_time: '2026-07-17T10:04:00Z' }] });
      }
      if (url.pathname === '/tx.vtt') return vtt('00:00:00.000 --> 00:00:10.000\nUnknown Speaker: hello');
      throw new Error(`unexpected ${url}`);
    });

    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '300', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T10:10:00Z'),
    });
    const participants = result.participants || [];
    expect(participants).toHaveLength(4);
    expect(participants.map((participant) => participant.identity_quality)).toEqual([
      'signed_in', 'signed_in', 'external_email', 'anonymous',
    ]);
    expect(participants[3]).toEqual({
      join_time: '2026-07-17T10:04:00.000Z',
      display_name: '',
      identity_quality: 'anonymous',
    });
    const participantCalls = fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith('/participants'));
    expect(participantCalls).toHaveLength(2);
    expect(participantCalls[1].searchParams.get('next_page_token')).toBe('page-2');
  });

  it('honors Retry-After for 429 responses', async () => {
    const { records } = statePaths();
    let attempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/400/instances') {
        attempts += 1;
        return attempts === 1 ? json({ code: 429 }, 429, { 'retry-after': '120' }) : json({ meetings: [] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const sleepImpl = vi.fn(async () => {});
    await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '400', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl,
      nowMs: Date.parse('2026-07-17T10:01:00Z'),
    });
    expect(attempts).toBe(2);
    expect(sleepImpl).toHaveBeenCalledWith(30_000);
  });

  it('rejects a repeated participant next_page_token instead of looping forever', async () => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/401/instances') return json({ meetings: [{ uuid: 'looping' }] });
      if (url.pathname === '/v2/past_meetings/looping') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/looping/recordings') return json({ recording_files: [{
        id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        download_url: 'https://download.zoom.us/loop.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/looping/participants') return json({ participants: [], next_page_token: 'same-token' });
      if (url.pathname === '/loop.vtt') return vtt('00:00:00.000 --> 00:00:01.000\nAda: loop');
      throw new Error(`unexpected ${url}`);
    });
    await expect(fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '401', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T10:11:00Z'),
    })).rejects.toMatchObject({ code: 'zoom_pagination_token_loop' });
    expect(fetchImpl.mock.calls.filter(([input]) => apiPath(input).endsWith('/participants'))).toHaveLength(2);
  });

  it('advances the Meeting transcript probe from NOT_READY to ready without making it the main source', async () => {
    const { records } = statePaths();
    let nowMs = Date.parse('2026-07-17T10:10:00Z');
    let probeReady = false;
    const logger = vi.fn();
    const env = { ...baseEnv, ZOOM_MEETING_TRANSCRIPT_PROBE: '1' };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/500/instances') return json({ meetings: [{ uuid: 'probe-session' }] });
      if (url.pathname === '/v2/past_meetings/probe-session') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/probe-session/recordings') return json({
        recording_files: [{ id: 'video', file_type: 'MP4', recording_start: '2026-07-17T10:00:00Z' }],
      });
      if (url.pathname === '/v2/past_meetings/probe-session/participants') return json({ participants: [] });
      if (url.pathname === '/v2/meetings/probe-session/transcript') {
        return probeReady
          ? json({ can_download: true, download_url: 'https://download.zoom.us/probe.vtt' })
          : json({ can_download: false, download_restriction_reason: 'NOT_READY' });
      }
      if (url.pathname === '/probe.vtt') return vtt('00:00:01.000 --> 00:00:02.000\nProbe: ready');
      throw new Error(`unexpected ${url}`);
    });
    const input = { meetingId: '500', scheduledAt: '2026-07-17T10:00:00Z' };
    const first = await fetchZoomMeetingTranscript(env, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs, logger,
    });
    expect(first.status).toBe('pending');
    expect((Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as { probe: { status: string } }).probe.status).toBe('not_ready');

    probeReady = true;
    nowMs += 60_000;
    const second = await fetchZoomMeetingTranscript(env, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs, logger,
    });
    expect(second.status).toBe('pending');
    const job = Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as { probe: { status: string; cue_count: number } };
    expect(job.probe).toMatchObject({ status: 'ready', cue_count: 1 });
    expect(logger).toHaveBeenCalledWith('provider_zoom_transcript_probe', expect.objectContaining({
      provider_probe_cue_count: 1,
      provider_classic_cue_count: 0,
    }));
  });

  it('observes an aborted probe rejection when the main participant branch fails first', async () => {
    const { records } = statePaths();
    const controller = new AbortController();
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === 'zoom.us') return token();
        if (url.pathname === '/v2/past_meetings/501/instances') return json({ meetings: [{ uuid: 'probe-abort' }] });
        if (url.pathname === '/v2/past_meetings/probe-abort') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
        if (url.pathname === '/v2/meetings/probe-abort/recordings') return json({
          recording_files: [{ id: 'video', file_type: 'MP4' }],
        });
        if (url.pathname === '/v2/meetings/probe-abort/transcript') {
          markProbeStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          });
        }
        if (url.pathname === '/v2/past_meetings/probe-abort/participants') {
          await probeStarted;
          throw new Error('participants_failed');
        }
        throw new Error(`unexpected ${url}`);
      });
      const request = fetchZoomMeetingTranscript({ ...baseEnv, ZOOM_MEETING_TRANSCRIPT_PROBE: '1' }, { path: records }, {
        meetingId: '501', scheduledAt: '2026-07-17T10:00:00Z',
      }, {
        fetchImpl: fetchImpl as typeof fetch,
        nowMs: Date.parse('2026-07-17T10:10:00Z'),
        signal: controller.signal,
      });
      await expect(request).rejects.toThrow('participants_failed');
      controller.abort(new Error('probe_aborted'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rechecks no_record and flips the terminal state when a late UUID and transcript appear', async () => {
    const { records } = statePaths();
    let available = false;
    let instancesCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/600/instances') {
        instancesCalls += 1;
        return json({ meetings: available ? [{ uuid: 'late-session' }] : [] });
      }
      if (url.pathname === '/v2/past_meetings/late-session') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/late-session/recordings') return json({ recording_files: [{
        id: 'late-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:00:05Z', download_url: 'https://download.zoom.us/late-tx.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/late-session/participants') return json({ participants: [] });
      if (url.pathname === '/late-tx.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: arrived');
      throw new Error(`unexpected ${url}`);
    });
    const input = {
      meetingId: '600',
      scheduledAt: '2026-07-17T09:50:00Z',
      scheduledEndAt: '2026-07-17T10:00:00Z',
    };
    const first = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:00:00Z'),
    });
    expect(first).toMatchObject({ status: 'no_record', reason: 'instance_not_found' });
    expect(first.next_check_at).toBeUndefined();

    available = true;
    await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:05:00Z'),
    });
    expect(instancesCalls).toBe(1);
    const flipped = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:10:00Z'),
    });
    expect(flipped).toMatchObject({ status: 'ready', instance_uuid: 'late-session' });
    expect(instancesCalls).toBe(2);
  });

  it('rechecks not_generated and flips when a TRANSCRIPT file is added to an existing recording', async () => {
    const { records } = statePaths();
    let transcriptAvailable = false;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/650/instances') return json({ meetings: [{ uuid: 'same-session' }] });
      if (url.pathname === '/v2/past_meetings/same-session') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/same-session/recordings') return json({ recording_files: transcriptAvailable ? [{
        id: 'late-tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:00:05Z', download_url: 'https://download.zoom.us/same-session.vtt',
      }] : [{ id: 'video', file_type: 'MP4', recording_start: '2026-07-17T10:00:00Z' }] });
      if (url.pathname === '/v2/past_meetings/same-session/participants') return json({ participants: [{
        id: 'ada', name: 'Ada', join_time: '2026-07-17T10:00:00Z', leave_time: '2026-07-17T10:09:00Z',
      }] });
      if (url.pathname === '/same-session.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: late transcript');
      throw new Error(`unexpected ${url}`);
    });
    const input = { meetingId: '650', scheduledAt: '2026-07-17T10:00:00Z' };
    const first = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:10:00Z'),
    });
    expect(first).toMatchObject({
      status: 'not_generated',
      reason: 'transcript_not_generated',
      participants: [{ display_name: 'Ada', identity_quality: 'signed_in' }],
    });
    transcriptAvailable = true;
    const flipped = await fetchZoomMeetingTranscript(baseEnv, { path: records }, input, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:20:00Z'),
    });
    expect(flipped).toMatchObject({ status: 'ready', srt: expect.stringContaining('late transcript') });
  });

  it('downgrades timestamp quality when recording duration and transcript span clearly diverge', async () => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/700/instances') return json({ meetings: [{ uuid: 'paused' }] });
      if (url.pathname === '/v2/past_meetings/paused') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/paused/recordings') return json({ recording_files: [{
        id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:10:00Z', download_url: 'https://download.zoom.us/paused.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/paused/participants') return json({ participants: [] });
      if (url.pathname === '/paused.vtt') return vtt('00:00:00.000 --> 00:00:10.000\nAda: short span');
      throw new Error(`unexpected ${url}`);
    });
    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '700', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T10:11:00Z'),
    });
    expect(result.timestamp_quality).toBe('approximate_pause_unknown');
  });

  it.each([
    ['empty VTT', '', 'text/vtt'],
    ['HTML body', '<!doctype html><html><body>login</body></html>', 'text/html'],
  ])('keeps %s out of ready state', async (_label, body, contentType) => {
    const { records } = statePaths();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/710/instances') return json({ meetings: [{ uuid: 'invalid-vtt' }] });
      if (url.pathname === '/v2/past_meetings/invalid-vtt') return json({ start_time: '2026-07-17T10:00:00Z', duration: 10 });
      if (url.pathname === '/v2/meetings/invalid-vtt/recordings') return json({ recording_files: [{
        id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        download_url: 'https://download.zoom.us/invalid.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/invalid-vtt/participants') return json({ participants: [] });
      if (url.pathname === '/invalid.vtt') return new Response(body, { status: 200, headers: { 'content-type': contentType } });
      throw new Error(`unexpected ${url}`);
    });
    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '710', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T12:10:00Z'),
    });
    expect(result).toMatchObject({ status: 'not_generated', reason: 'transcript_not_generated' });
    expect(result.srt).toBeUndefined();
  });

  it('keeps a classic transcript ready when the new-route probe fails', async () => {
    const { records } = statePaths();
    const env = { ...baseEnv, ZOOM_MEETING_TRANSCRIPT_PROBE: '1' };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/800/instances') return json({ meetings: [{ uuid: 'classic' }] });
      if (url.pathname === '/v2/past_meetings/classic') return json({ start_time: '2026-07-17T10:00:00Z', duration: 1 });
      if (url.pathname === '/v2/meetings/classic/recordings') return json({ recording_files: [{
        id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
        recording_end: '2026-07-17T10:00:05Z', download_url: 'https://download.zoom.us/classic.vtt',
      }] });
      if (url.pathname === '/v2/past_meetings/classic/participants') return json({ participants: [] });
      if (url.pathname === '/v2/meetings/classic/transcript') return json({ code: 500 }, 500);
      if (url.pathname === '/classic.vtt') return vtt('00:00:00.000 --> 00:00:05.000\nAda: classic wins');
      throw new Error(`unexpected ${url}`);
    });
    const result = await fetchZoomMeetingTranscript(env, { path: records }, {
      meetingId: '800', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
      nowMs: Date.parse('2026-07-17T10:01:00Z'),
    });
    expect(result).toMatchObject({ status: 'ready', srt: expect.stringContaining('classic wins') });
    const job = Object.values(JSON.parse(readFileSync(records, 'utf8')).meetings)[0] as { probe: { status: string } };
    expect(job.probe.status).toBe('error');
  });

  it('uses OAuth Bearer first and falls back to download_access_token without persisting the token', async () => {
    const { records } = statePaths();
    let oauthDownloadSeen = false;
    let fallbackSeen = false;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/850/instances') return json({ meetings: [{ uuid: 'protected' }] });
      if (url.pathname === '/v2/past_meetings/protected') return json({ start_time: '2026-07-17T10:00:00Z', duration: 1 });
      if (url.pathname === '/v2/meetings/protected/recordings') return json({
        download_access_token: 'short-lived-download-secret',
        recording_files: [{
          id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
          recording_end: '2026-07-17T10:00:05Z', download_url: 'https://download.zoom.us/protected.vtt',
        }],
      });
      if (url.pathname === '/v2/past_meetings/protected/participants') return json({ participants: [] });
      if (url.pathname === '/protected.vtt' && !url.searchParams.get('access_token')) {
        oauthDownloadSeen = new Headers(init?.headers).get('authorization') === 'Bearer zoom-access-token';
        return json({ code: 403 }, 403);
      }
      if (url.pathname === '/protected.vtt' && url.searchParams.get('access_token') === 'short-lived-download-secret') {
        fallbackSeen = true;
        return vtt('00:00:00.000 --> 00:00:05.000\nAda: protected');
      }
      throw new Error(`unexpected ${url}`);
    });
    const result = await fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '850', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T10:01:00Z'),
    });
    expect(result.status).toBe('ready');
    expect(oauthDownloadSeen).toBe(true);
    expect(fallbackSeen).toBe(true);
    expect(readFileSync(records, 'utf8')).not.toContain('short-lived-download-secret');
  });

  it('never sends credentials to an untrusted transcript download_url', async () => {
    const { records } = statePaths();
    const evilCalls: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.hostname === 'evil.example') {
        evilCalls.push(init);
        return vtt('00:00:00.000 --> 00:00:01.000\nStolen: secret');
      }
      if (url.pathname === '/v2/past_meetings/851/instances') return json({ meetings: [{ uuid: 'malicious' }] });
      if (url.pathname === '/v2/past_meetings/malicious') return json({ start_time: '2026-07-17T10:00:00Z', duration: 1 });
      if (url.pathname === '/v2/meetings/malicious/recordings') return json({
        download_access_token: 'must-not-leak',
        recording_files: [{
          id: 'tx', file_type: 'TRANSCRIPT', recording_start: '2026-07-17T10:00:00Z',
          download_url: 'https://evil.example/steal.vtt',
        }],
      });
      if (url.pathname === '/v2/past_meetings/malicious/participants') return json({ participants: [] });
      throw new Error(`unexpected ${url}`);
    });
    await expect(fetchZoomMeetingTranscript(baseEnv, { path: records }, {
      meetingId: '851', scheduledAt: '2026-07-17T10:00:00Z',
    }, {
      fetchImpl: fetchImpl as typeof fetch, nowMs: Date.parse('2026-07-17T10:02:00Z'),
    })).rejects.toMatchObject({ code: 'zoom_credential_url_untrusted' });
    expect(evilCalls).toEqual([]);
  });

  it('backfills only Zoom sync entries whose scheduled window has ended', async () => {
    const { records, sync } = statePaths();
    writeFileSync(sync, JSON.stringify({
      schema_version: 'inkloop.zoom_sync.v1',
      meetings: [
        {
          platform: 'zoom', meeting_id: '900', topic: 'Past', scheduled_at: '2026-07-17T10:00:00Z',
          duration_minutes: 10, join_url: 'https://zoom.us/j/900', host_user_id: 'host',
        },
        {
          platform: 'zoom', meeting_id: '901', topic: 'Future', scheduled_at: '2026-07-17T12:00:00Z',
          duration_minutes: 10, join_url: 'https://zoom.us/j/901', host_user_id: 'host',
        },
      ],
    }), 'utf8');
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/past_meetings/900/instances') return json({ meetings: [] });
      throw new Error(`unexpected ${url}`);
    });
    const result = await backfillZoomMeetingTranscripts(baseEnv, { path: records }, { path: sync }, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: Date.parse('2026-07-17T11:00:00Z'),
    });
    expect(result).toMatchObject({ scanned: 1, advanced: 1, completed: 0, errors: [] });
    expect(fetchImpl.mock.calls.map(([input]) => apiPath(input))).not.toContain('/v2/past_meetings/901/instances');
  });
});
