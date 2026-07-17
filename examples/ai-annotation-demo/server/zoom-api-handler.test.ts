import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createZoomApiHandler } from './zoom-api-handler';
import { resetZoomS2SStateForTests } from './zoom-oauth-state';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const roots: string[] = [];

async function invoke(
  handler: ReturnType<typeof createZoomApiHandler>,
  url: string,
  headers: Record<string, string> = { authorization: 'Bearer device-session' },
): Promise<CapturedResponse> {
  const request = { method: 'GET', url, headers } as unknown as IncomingMessage;
  const capturedHeaders: Record<string, string> = {};
  let body = '';
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) { capturedHeaders[name.toLowerCase()] = String(value); },
    end(value = '') { body = String(value); },
  } as unknown as ServerResponse;
  await handler(request, response);
  return {
    status: response.statusCode,
    headers: capturedHeaders,
    body: body ? JSON.parse(body) as Record<string, unknown> : {},
  };
}

afterEach(() => {
  resetZoomS2SStateForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('zoom API routes', () => {
  it('requires a device session before exposing Zoom status', async () => {
    const handler = createZoomApiHandler({
      env: {},
      requireDeviceSession: async (_req, res) => {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'missing_session_token' }));
        return null;
      },
    });
    const result = await invoke(handler, '/api/zoom/status', {});
    expect(result).toMatchObject({ status: 401, body: { error: 'missing_session_token' } });
  });

  it('reports disconnected status and a clear not_configured error for meeting sources', async () => {
    const handler = createZoomApiHandler({ env: {}, requireDeviceSession: async () => ({ active: true }) });
    expect(await invoke(handler, '/api/zoom/status')).toMatchObject({
      status: 200,
      body: { configured: false, connected: false },
    });
    expect(await invoke(handler, '/api/zoom/meeting-sources')).toMatchObject({
      status: 401,
      body: {
        configured: false,
        connected: false,
        sources: [],
        error: { code: 'zoom_s2s_not_configured' },
      },
    });
  });

  it('probes configured status and serves the cached meeting snapshot inside 60 seconds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-route-'));
    roots.push(root);
    let nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      if (url.pathname === '/v2/users/host/meetings') {
        return new Response(JSON.stringify({ meetings: [] }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const handler = createZoomApiHandler({
      env: {
        ZOOM_S2S_ACCOUNT_ID: 'account',
        ZOOM_S2S_CLIENT_ID: 'client',
        ZOOM_S2S_CLIENT_SECRET: 'secret',
        ZOOM_HOST_USER_IDS: 'host',
      },
      syncRef: { path: join(root, 'state.json') },
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
      minSyncIntervalMs: 60_000,
      requireDeviceSession: async () => ({ active: true }),
    });

    expect(await invoke(handler, '/api/zoom/status')).toMatchObject({
      status: 200,
      body: { configured: true, connected: true },
    });
    const first = await invoke(handler, '/api/zoom/meeting-sources');
    expect(first).toMatchObject({ status: 200, body: { connected: true, throttled: false, sources: [] } });
    const callsAfterFirst = fetchImpl.mock.calls.length;
    nowMs += 30_000;
    const cached = await invoke(handler, '/api/zoom/meeting-sources');
    expect(cached).toMatchObject({ status: 200, body: { connected: true, throttled: true, sources: [] } });
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('serves the meeting transcript response contract behind the device session gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-transcript-route-'));
    roots.push(root);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/123456789/instances') {
        return new Response(JSON.stringify({ meetings: [{ uuid: 'route-session' }] }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/route-session') {
        return new Response(JSON.stringify({ start_time: '2026-07-17T10:00:00Z', duration: 5 }), { status: 200 });
      }
      if (url.pathname === '/v2/meetings/route-session/recordings') {
        return new Response(JSON.stringify({ recording_files: [{
          id: 'tx',
          file_type: 'TRANSCRIPT',
          recording_start: '2026-07-17T10:00:00Z',
          recording_end: '2026-07-17T10:00:05Z',
          download_url: 'https://download.zoom.us/route.vtt',
        }] }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/route-session/participants') {
        return new Response(JSON.stringify({ participants: [] }), { status: 200 });
      }
      if (url.pathname === '/route.vtt') {
        return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nAda: route contract', { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const handler = createZoomApiHandler({
      env: {
        ZOOM_S2S_ACCOUNT_ID: 'account',
        ZOOM_S2S_CLIENT_ID: 'client',
        ZOOM_S2S_CLIENT_SECRET: 'secret',
        ZOOM_MEETING_TRANSCRIPT_PROBE: '0',
      },
      syncRef: { path: join(root, 'sync.json') },
      recordsRef: { path: join(root, 'records.json') },
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => Date.parse('2026-07-17T10:05:00Z'),
      requireDeviceSession: async () => ({ active: true }),
    });

    const result = await invoke(handler, '/api/zoom/meeting-transcript?space_name=123456789&scheduled_at=2026-07-17T10%3A00%3A00Z');
    expect(result.status).toBe(200);
    expect(result.body).toMatchInlineSnapshot(`
      {
        "ended_at": "2026-07-17T10:05:00.000Z",
        "instance_uuid": "route-session",
        "participants": [],
        "record": {
          "end_time": "2026-07-17T10:05:00.000Z",
          "name": "route-session",
          "start_time": "2026-07-17T10:00:00.000Z",
        },
        "srt": "1
      00:00:00,000 --> 00:00:05,000
      Ada: route contract",
        "started_at": "2026-07-17T10:00:00.000Z",
        "status": "ready",
        "t0": "2026-07-17T10:00:00.000Z",
        "timestamp_quality": "derived_no_pause",
        "transcript": {
          "lines": [
            {
              "end_time": "2026-07-17T10:00:05.000Z",
              "recording_file_id": "tx",
              "speaker": {
                "attribution_quality": "display_label",
                "display_name": "Ada",
                "stable_id": null,
              },
              "start_time": "2026-07-17T10:00:00.000Z",
              "text": "route contract",
            },
          ],
          "name": "past_meetings/route-session/transcripts",
          "srt": "1
      00:00:00,000 --> 00:00:05,000
      Ada: route contract",
          "timestamp_quality": "derived_no_pause",
        },
      }
    `);
  });
});
