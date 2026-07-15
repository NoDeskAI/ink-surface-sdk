import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGoogleMeetingSources } from './google-calendar-sync';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('google calendar sync', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function statePath(): string {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-google-calendar-'));
    roots.push(root);
    return join(root, 'calendar-sync.json');
  }

  it('paginates and normalizes Meet instances while skipping ordinary events', async () => {
    const path = statePath();
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      expect(url.searchParams.get('singleEvents')).toBe('true');
      expect(url.searchParams.get('timeMin')).toBeTruthy();
      expect(url.searchParams.get('timeMax')).toBeTruthy();
      if (!url.searchParams.get('pageToken')) {
        return jsonResponse({
          items: [
            {
              id: 'event-meet-1',
              iCalUID: 'uid-1@google.com',
              summary: 'Product review',
              status: 'confirmed',
              start: { dateTime: '2026-07-15T09:00:00+08:00' },
              end: { dateTime: '2026-07-15T10:00:00+08:00' },
              organizer: { email: 'owner@example.com' },
              conferenceData: {
                conferenceId: 'abc-defg-hij',
                conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
                entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
              },
            },
            {
              id: 'ordinary-event',
              summary: 'Focus time',
              status: 'confirmed',
              start: { dateTime: '2026-07-15T11:00:00Z' },
              end: { dateTime: '2026-07-15T12:00:00Z' },
            },
          ],
          nextPageToken: 'page-2',
        });
      }
      expect(url.searchParams.get('pageToken')).toBe('page-2');
      return jsonResponse({
        items: [
          {
            id: 'recurring-instance-20260716',
            iCalUID: 'weekly@google.com',
            recurringEventId: 'weekly-master',
            originalStartTime: { dateTime: '2026-07-16T09:00:00+08:00' },
            summary: 'Weekly sync',
            status: 'confirmed',
            start: { dateTime: '2026-07-16T09:30:00+08:00' },
            end: { dateTime: '2026-07-16T10:00:00+08:00' },
            hangoutLink: 'https://meet.google.com/weekly-meet',
            conferenceData: {
              conferenceId: 'weekly-meet',
              conferenceSolution: { key: { type: 'hangoutsMeet' } },
            },
          },
          {
            id: 'cancelled-instance',
            summary: 'Cancelled Meet',
            status: 'cancelled',
            start: { dateTime: '2026-07-17T09:00:00Z' },
            conferenceData: {
              conferenceId: 'cancel-meet',
              conferenceSolution: { name: 'Google Meet' },
              entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/cancel-meet' }],
            },
          },
        ],
        nextSyncToken: 'sync-token-1',
      });
    });

    const result = await fetchGoogleMeetingSources('access-token', { path }, {
      nowMs: Date.parse('2026-07-14T00:00:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ source_count: 3, full_sync: true, cursor_reset: false, sync_token_present: true });
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'google_meet',
        calendar_event_id: 'event-meet-1',
        scheduled_at: '2026-07-15T01:00:00.000Z',
        scheduled_end_at: '2026-07-15T02:00:00.000Z',
        meeting_code: 'abc-defg-hij',
        meeting_url: 'https://meet.google.com/abc-defg-hij',
        organizer_email: 'owner@example.com',
        status: 'confirmed',
      }),
      expect.objectContaining({
        calendar_event_id: 'recurring-instance-20260716',
        recurring_event_id: 'weekly-master',
        original_start_time: '2026-07-16T01:00:00.000Z',
      }),
      expect.objectContaining({ calendar_event_id: 'cancelled-instance', status: 'cancelled' }),
    ]));
    expect(result.sources.some((source) => source.calendar_event_id === 'ordinary-event')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clears a 410 cursor, performs a full reload, and emits cached cancelled instances', async () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({
      schema_version: 'inkloop.google_calendar_sync.v1',
      sync_token: 'stale-token',
      meet_events: {
        'cancelled-from-cache': {
          platform: 'google_meet',
          calendar_event_id: 'cancelled-from-cache',
          title: 'Old weekly occurrence',
          scheduled_at: '2026-07-13T01:00:00.000Z',
          meeting_code: 'old-code',
          meeting_url: 'https://meet.google.com/old-code',
          status: 'confirmed',
        },
      },
    }));
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      urls.push(url);
      if (url.searchParams.get('syncToken')) return jsonResponse({ error: { message: 'Sync token is no longer valid' } }, 410);
      return jsonResponse({
        items: [{ id: 'cancelled-from-cache', status: 'cancelled' }],
        nextSyncToken: 'replacement-token',
      });
    });

    const result = await fetchGoogleMeetingSources('access-token', { path }, {
      nowMs: Date.parse('2026-07-14T00:00:00.000Z'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ cursor_reset: true, full_sync: true, source_count: 1 });
    expect(result.sources[0]).toMatchObject({ calendar_event_id: 'cancelled-from-cache', status: 'cancelled' });
    expect(urls[0].searchParams.get('syncToken')).toBe('stale-token');
    expect(urls[1].searchParams.get('syncToken')).toBeNull();
    expect(urls[1].searchParams.get('timeMin')).toBeTruthy();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ sync_token: 'replacement-token', meet_events: {} });
  });

  it('refreshes once on 401 and retries 429/5xx with bounded backoff', async () => {
    const path = statePath();
    const sleepImpl = vi.fn(async () => {});
    const refreshAccessToken = vi.fn(async () => 'fresh-token');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextSyncToken: 'sync-after-retry' }));

    const result = await fetchGoogleMeetingSources('expired-token', { path }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refreshAccessToken,
      sleepImpl,
    });

    expect(result.source_count).toBe(0);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(250);
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({ headers: { authorization: 'Bearer fresh-token' } });
  });

  it('returns the persisted current snapshot when an incremental page has no changes', async () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({
      schema_version: 'inkloop.google_calendar_sync.v1',
      sync_token: 'current-token',
      meet_events: {
        'cached-event': {
          platform: 'google_meet',
          calendar_event_id: 'cached-event',
          title: 'Cached Meet',
          scheduled_at: '2026-07-15T01:00:00.000Z',
          meeting_url: 'https://meet.google.com/cached',
          status: 'confirmed',
        },
      },
    }));
    const fetchImpl = vi.fn(async (urlValue: string) => {
      const url = new URL(urlValue);
      expect(url.searchParams.get('syncToken')).toBe('current-token');
      expect(url.searchParams.get('timeMin')).toBeNull();
      return jsonResponse({ items: [], nextSyncToken: 'next-token' });
    });

    const result = await fetchGoogleMeetingSources('access-token', { path }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ full_sync: false, source_count: 1 });
    expect(result.sources[0]).toMatchObject({ calendar_event_id: 'cached-event', status: 'confirmed' });
  });
});
