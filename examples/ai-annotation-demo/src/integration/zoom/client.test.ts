import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../core/api';
import { fetchZoomMeetingLiveState, fetchZoomMeetingSources, fetchZoomMeetingTranscript, fetchZoomStatus } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Zoom device client', () => {
  it('uses authenticated GET routes for status, sources, and filtered live state', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('x-inkloop-user-id')).toBe('local_demo');
      if (url.endsWith('/api/zoom/status')) {
        return new Response(JSON.stringify({ configured: true, connected: true }), { status: 200 });
      }
      if (url.endsWith('/api/zoom/meeting-sources')) {
        return new Response(JSON.stringify({
          configured: true,
          connected: true,
          source: 'zoom',
          source_count: 1,
          sources: [{
            platform: 'zoom',
            meeting_id: '987654321',
            topic: 'Zoom planning',
            scheduled_at: '2026-07-18T01:00:00.000Z',
            duration_minutes: 45,
            join_url: 'https://zoom.us/j/987654321?pwd=secret',
            host_user_id: 'host-1',
          }],
          throttled: false,
        }), { status: 200 });
      }
      if (url.endsWith('/api/meeting-providers/live-state?platform=zoom')) {
        return new Response(JSON.stringify({ connected: true, source: 'mtl_receiver', windows: [] }), { status: 200 });
      }
      if (url.includes('/api/zoom/meeting-transcript?')) {
        const parsed = new URL(url, 'http://inkloop.local');
        expect(parsed.searchParams.get('space_name')).toBe('987654321');
        expect(parsed.searchParams.get('scheduled_at')).toBe('2026-07-18T01:00:00.000Z');
        return new Response(JSON.stringify({
          status: 'ready',
          participants: [],
          instance_uuid: '/zoom-instance-1',
          t0: '2026-07-18T01:02:00.000Z',
          started_at: '2026-07-18T01:02:00.000Z',
          ended_at: '2026-07-18T01:47:00.000Z',
          srt: '1\n00:00:01,000 --> 00:00:02,000\nAda: Ready',
          timestamp_quality: 'derived_no_pause',
        }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchZoomStatus()).resolves.toEqual({ configured: true, connected: true });
    await expect(fetchZoomMeetingSources()).resolves.toMatchObject({
      source: 'zoom',
      sources: [expect.objectContaining({ meeting_id: '987654321' })],
    });
    await expect(fetchZoomMeetingLiveState()).resolves.toEqual({ connected: true, source: 'mtl_receiver', windows: [] });
    await expect(fetchZoomMeetingTranscript('987654321', '2026-07-18T01:00:00.000Z')).resolves.toMatchObject({
      status: 'ready',
      instance_uuid: '/zoom-instance-1',
      timestamp_quality: 'derived_no_pause',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves core/api structured error semantics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'zoom_s2s_not_configured', message: 'Zoom S2S is not configured' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })));

    await expect(fetchZoomMeetingTranscript('987654321', '2026-07-18T01:00:00.000Z')).rejects.toEqual(expect.objectContaining({
      name: 'ApiError',
      status: 401,
      code: 'zoom_s2s_not_configured',
    } satisfies Partial<ApiError>));
  });
});
