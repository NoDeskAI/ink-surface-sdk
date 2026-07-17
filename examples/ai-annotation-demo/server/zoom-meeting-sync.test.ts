import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchZoomMeetingSources, type ZoomMeetingSyncEnv } from './zoom-meeting-sync';
import { resetZoomS2SStateForTests } from './zoom-oauth-state';

const NOW_MS = Date.parse('2026-07-17T00:00:00.000Z');
const roots: string[] = [];
const env: ZoomMeetingSyncEnv = {
  ZOOM_S2S_ACCOUNT_ID: 'account-id',
  ZOOM_S2S_CLIENT_ID: 'client-id',
  ZOOM_S2S_CLIENT_SECRET: 'client-secret',
  ZOOM_HOST_USER_IDS: 'host/one',
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

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-sync-'));
  roots.push(root);
  return join(root, 'state.json');
}

afterEach(() => {
  resetZoomS2SStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('zoom meeting sync', () => {
  it('filters type=2, follows list pagination, gets details, and never stores start_url', async () => {
    const path = statePath();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/users/host%2Fone/meetings') {
        if (!url.searchParams.get('next_page_token')) {
          return json({
            meetings: [
              { id: 100, type: 1, topic: 'Instant' },
              { id: 200, type: 2, topic: 'Listed first' },
              { id: 800, type: 8, topic: 'Recurring' },
            ],
            next_page_token: 'page-2',
          });
        }
        expect(url.searchParams.get('next_page_token')).toBe('page-2');
        return json({ meetings: [{ id: 201, type: 2, occurrence_id: 'occ-201' }] });
      }
      if (url.pathname === '/v2/meetings/200') {
        return json({
          id: 200,
          host_id: 'host/one',
          topic: 'Planning review',
          start_time: '2026-07-18T09:00:00Z',
          timezone: 'Asia/Shanghai',
          join_url: 'https://zoom.us/j/200',
          start_url: 'https://zoom.us/s/200?zak=secret',
          duration: 45,
        });
      }
      if (url.pathname === '/v2/meetings/201') {
        return json({
          id: 201,
          topic: 'Design review',
          start_time: '2026-07-19T02:00:00Z',
          join_url: 'https://zoom.us/j/201',
          start_url: 'https://zoom.us/s/201?zak=secret',
          duration: 30,
          occurrence_id: 'occ-201',
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const result = await fetchZoomMeetingSources(env, { path }, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: NOW_MS,
      minIntervalMs: 0,
    });
    expect(result.sources).toEqual([
      {
        platform: 'zoom',
        meeting_id: '200',
        topic: 'Planning review',
        scheduled_at: '2026-07-18T09:00:00.000Z',
        duration_minutes: 45,
        join_url: 'https://zoom.us/j/200',
        host_user_id: 'host/one',
        timezone: 'Asia/Shanghai',
      },
      {
        platform: 'zoom',
        meeting_id: '201',
        topic: 'Design review',
        scheduled_at: '2026-07-19T02:00:00.000Z',
        duration_minutes: 30,
        join_url: 'https://zoom.us/j/201',
        host_user_id: 'host/one',
        occurrence_id: 'occ-201',
      },
    ]);
    const storedText = readFileSync(path, 'utf8');
    expect(storedText).not.toContain('start_url');
    expect(storedText).not.toContain('zak=secret');
    const apiPaths = fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((pathname) => pathname.startsWith('/v2/meetings/'));
    expect(apiPaths).toEqual(['/v2/meetings/200', '/v2/meetings/201']);
  });

  it('keeps a missing meeting and marks missing_since instead of deleting it', async () => {
    const path = statePath();
    let present = true;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname.endsWith('/meetings') && url.pathname.includes('/users/')) {
        return json({ meetings: present ? [{ id: 300, type: 2 }] : [] });
      }
      if (url.pathname === '/v2/meetings/300') {
        return json({
          id: 300,
          topic: 'Weekly sync',
          start_time: '2026-07-20T01:00:00Z',
          join_url: 'https://zoom.us/j/300',
          duration: 20,
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    await fetchZoomMeetingSources(env, { path }, { fetchImpl: fetchImpl as typeof fetch, nowMs: NOW_MS, minIntervalMs: 0 });
    present = false;
    const secondNow = NOW_MS + 60_000;
    const result = await fetchZoomMeetingSources(env, { path }, { fetchImpl: fetchImpl as typeof fetch, nowMs: secondNow, minIntervalMs: 0 });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      meeting_id: '300',
      missing_since: new Date(secondNow).toISOString(),
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).meetings[0].missing_since).toBe(new Date(secondNow).toISOString());
  });

  it('honors Retry-After on 429 before retrying the same page', async () => {
    const path = statePath();
    let listAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname.endsWith('/meetings')) {
        listAttempts += 1;
        if (listAttempts === 1) return json({ code: 429 }, 429, { 'retry-after': '2' });
        return json({ meetings: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const sleepImpl = vi.fn(async () => {});
    await fetchZoomMeetingSources(env, { path }, {
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl,
      nowMs: NOW_MS,
      minIntervalMs: 0,
    });
    expect(listAttempts).toBe(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(2_000);
  });

  it('discovers only licensed active hosts and caps automatic expansion at ten', async () => {
    const path = statePath();
    const discoveredEnv = { ...env, ZOOM_HOST_USER_IDS: '' };
    const visitedHosts: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return token();
      if (url.pathname === '/v2/users') {
        return json({ users: [
          { id: 'basic', type: 1 },
          ...Array.from({ length: 11 }, (_, index) => ({ id: `licensed-${index + 1}`, type: 2 })),
        ] });
      }
      const match = url.pathname.match(/^\/v2\/users\/([^/]+)\/meetings$/);
      if (match) {
        visitedHosts.push(decodeURIComponent(match[1]));
        return json({ meetings: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    await fetchZoomMeetingSources(discoveredEnv, { path }, {
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: NOW_MS,
      minIntervalMs: 0,
    });
    expect(visitedHosts).toHaveLength(10);
    expect(visitedHosts).not.toContain('basic');
    expect(visitedHosts).not.toContain('licensed-11');
  });
});
