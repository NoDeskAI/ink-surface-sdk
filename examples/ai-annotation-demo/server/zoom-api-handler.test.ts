import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      resolveAuthorizedHostUserIds: () => ['host'],
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

  it('isolates account-wide Zoom sources and transcripts by authenticated InkLoop user', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-tenant-route-'));
    roots.push(root);
    const now = '2026-07-17T09:00:00.000Z';
    const syncPath = join(root, 'sync.json');
    writeFileSync(syncPath, JSON.stringify({
      schema_version: 'inkloop.zoom_sync.v1',
      fetched_at: now,
      meetings: [
        {
          platform: 'zoom', meeting_id: '111', topic: 'Ada private meeting', scheduled_at: '2026-07-17T10:00:00.000Z',
          duration_minutes: 30, join_url: 'https://zoom.us/j/111', host_user_id: 'zoom-ada',
        },
        {
          platform: 'zoom', meeting_id: '222', topic: 'Bob private meeting', scheduled_at: '2026-07-17T11:00:00.000Z',
          duration_minutes: 30, join_url: 'https://zoom.us/j/222', host_user_id: 'zoom-bob',
        },
      ],
    }));
    const fetchImpl = vi.fn(async () => { throw new Error('unauthorized request reached Zoom'); });
    const sessions: Record<string, { tenant_id: string; user_id: string }> = {
      'Bearer ada': { tenant_id: 'tenant-a', user_id: 'ada' },
      'Bearer bob': { tenant_id: 'tenant-a', user_id: 'bob' },
      'Bearer unmapped': { tenant_id: 'tenant-a', user_id: 'mallory' },
    };
    const handler = createZoomApiHandler({
      env: {
        ZOOM_S2S_ACCOUNT_ID: 'account', ZOOM_S2S_CLIENT_ID: 'client', ZOOM_S2S_CLIENT_SECRET: 'secret',
        ZOOM_HOST_USER_IDS: 'zoom-ada,zoom-bob',
      },
      syncRef: { path: syncPath },
      recordsRef: { path: join(root, 'records.json') },
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => Date.parse(now),
      minSyncIntervalMs: 60_000,
      requireDeviceSession: async (req) => sessions[String(req.headers.authorization)] || null,
      resolveAuthorizedHostUserIds: (session) => {
        const userId = (session as { user_id?: string }).user_id;
        return userId === 'ada' ? ['zoom-ada'] : userId === 'bob' ? ['zoom-bob'] : [];
      },
    });

    const adaSources = await invoke(handler, '/api/zoom/meeting-sources', { authorization: 'Bearer ada' });
    expect(adaSources).toMatchObject({ status: 200, body: { source_count: 1, sources: [{ meeting_id: '111' }] } });
    expect(JSON.stringify(adaSources.body)).not.toContain('Bob private meeting');

    const bobReadingAda = await invoke(
      handler,
      '/api/zoom/meeting-transcript?space_name=111&scheduled_at=2026-07-17T10%3A00%3A00Z',
      { authorization: 'Bearer bob' },
    );
    expect(bobReadingAda).toMatchObject({
      status: 403,
      body: { error: { code: 'zoom_meeting_not_authorized' } },
    });

    const unmapped = await invoke(handler, '/api/zoom/meeting-sources', { authorization: 'Bearer unmapped' });
    expect(unmapped).toMatchObject({
      status: 403,
      body: { sources: [], error: { code: 'zoom_identity_not_authorized' } },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when a device host mapping is outside the configured sync hosts', async () => {
    const handler = createZoomApiHandler({
      env: {
        ZOOM_S2S_ACCOUNT_ID: 'account', ZOOM_S2S_CLIENT_ID: 'client', ZOOM_S2S_CLIENT_SECRET: 'secret',
        ZOOM_HOST_USER_IDS: 'zoom-ada',
      },
      requireDeviceSession: async () => ({ tenant_id: 'tenant-a', user_id: 'bob' }),
      resolveAuthorizedHostUserIds: () => ['zoom-bob'],
    });

    expect(await invoke(handler, '/api/zoom/meeting-sources')).toMatchObject({
      status: 503,
      body: { sources: [], error: { code: 'zoom_host_access_misconfigured' } },
    });
  });

  it('serves the meeting transcript response contract behind the device session gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-transcript-route-'));
    roots.push(root);
    const syncPath = join(root, 'sync.json');
    writeFileSync(syncPath, JSON.stringify({
      schema_version: 'inkloop.zoom_sync.v1',
      meetings: [{
        platform: 'zoom', meeting_id: '123456789', topic: 'Authorized',
        scheduled_at: '2026-07-17T10:00:00.000Z', duration_minutes: 5,
        join_url: 'https://zoom.us/j/123456789', host_user_id: 'host-a',
      }],
    }));
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/123456789/instances') {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
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
      syncRef: { path: syncPath },
      recordsRef: { path: join(root, 'records.json') },
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => Date.parse('2026-07-17T10:05:00Z'),
      requireDeviceSession: async () => ({ active: true }),
      resolveAuthorizedHostUserIds: () => ['host-a'],
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

  it('serves Companion fallback and the official Zoom summary through the device API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-companion-route-'));
    roots.push(root);
    const syncPath = join(root, 'sync.json');
    writeFileSync(syncPath, JSON.stringify({
      schema_version: 'inkloop.zoom_sync.v1',
      meetings: [{
        platform: 'zoom', meeting_id: '246813579', topic: 'Companion route',
        scheduled_at: '2026-07-17T10:00:00.000Z', duration_minutes: 5,
        join_url: 'https://zoom.us/j/246813579', host_user_id: 'host-a',
      }],
    }));
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/246813579/instances') {
        return new Response(JSON.stringify({ meetings: [{ uuid: 'companion-route' }] }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/companion-route') {
        return new Response(JSON.stringify({
          start_time: '2026-07-17T10:00:00Z', duration: 5, has_meeting_summary: true,
        }), { status: 200 });
      }
      if (url.pathname === '/v2/meetings/companion-route/recordings') {
        return new Response(JSON.stringify({ recording_files: [] }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/companion-route/participants') {
        return new Response(JSON.stringify({ participants: [] }), { status: 200 });
      }
      if (url.pathname === '/v2/meetings/companion-route/transcript') {
        return new Response(JSON.stringify({ download_url: 'https://download.zoom.us/companion-route.vtt' }), { status: 200 });
      }
      if (url.pathname === '/v2/meetings/companion-route/meeting_summary') {
        return new Response(JSON.stringify({
          summary_title: 'Companion route summary',
          summary_content: '## Decision\n\nShip the fallback.',
          summary_details: [],
          next_steps: ['Rebuild APK'],
        }), { status: 200 });
      }
      if (url.pathname === '/companion-route.vtt') {
        return new Response('WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nAda: companion route', {
          status: 200, headers: { 'content-type': 'text/vtt' },
        });
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
      syncRef: { path: syncPath },
      recordsRef: { path: join(root, 'records.json') },
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => Date.parse('2026-07-17T10:05:00Z'),
      requireDeviceSession: async () => ({ active: true }),
      resolveAuthorizedHostUserIds: () => ['host-a'],
    });

    const result = await invoke(handler, '/api/zoom/meeting-transcript?space_name=246813579&scheduled_at=2026-07-17T10%3A00%3A00Z');
    expect(result).toMatchObject({
      status: 200,
      body: {
        status: 'ready',
        timestamp_quality: 'companion_offset_anchor',
        transcript: {
          lines: [{ start_time: '2026-07-17T10:00:03.000Z', text: 'companion route' }],
        },
        smart_note: {
          title: 'Companion route summary',
          text: '## Decision\n\nShip the fallback.',
          next_steps: ['Rebuild APK'],
        },
      },
    });
  });

  it('keeps no_record status compatible while exposing instance_not_found reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-reason-route-'));
    roots.push(root);
    const syncPath = join(root, 'sync.json');
    writeFileSync(syncPath, JSON.stringify({
      schema_version: 'inkloop.zoom_sync.v1',
      meetings: [{
        platform: 'zoom', meeting_id: '987654321', topic: 'Authorized',
        scheduled_at: '2026-07-17T10:00:00.000Z', duration_minutes: 10,
        join_url: 'https://zoom.us/j/987654321', host_user_id: 'host-a',
      }],
    }));
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      if (url.pathname === '/v2/past_meetings/987654321/instances') {
        return new Response(JSON.stringify({ meetings: [] }), { status: 200 });
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
      syncRef: { path: syncPath },
      recordsRef: { path: join(root, 'records.json') },
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => Date.parse('2026-07-17T12:10:00Z'),
      requireDeviceSession: async () => ({ active: true }),
      resolveAuthorizedHostUserIds: () => ['host-a'],
    });
    const result = await invoke(handler, '/api/zoom/meeting-transcript?space_name=987654321&scheduled_at=2026-07-17T10%3A00%3A00Z');
    expect(result).toMatchObject({
      status: 200,
      body: { status: 'no_record', reason: 'instance_not_found' },
    });
    expect(result.body).not.toHaveProperty('participants');
  });

  it('propagates request abort into the meeting-sources fetch chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkloop-zoom-abort-route-'));
    roots.push(root);
    let apiSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'zoom.us') {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
      }
      apiSignal = init?.signal || undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        apiSignal?.addEventListener('abort', () => reject(apiSignal?.reason), { once: true });
      });
    });
    const handler = createZoomApiHandler({
      env: {
        ZOOM_S2S_ACCOUNT_ID: 'account',
        ZOOM_S2S_CLIENT_ID: 'client',
        ZOOM_S2S_CLIENT_SECRET: 'secret',
        ZOOM_HOST_USER_IDS: 'host',
      },
      syncRef: { path: join(root, 'sync.json') },
      fetchImpl: fetchImpl as typeof fetch,
      minSyncIntervalMs: 0,
      requireDeviceSession: async () => ({ active: true }),
      resolveAuthorizedHostUserIds: () => ['host'],
    });
    const request = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/zoom/meeting-sources',
      headers: { authorization: 'Bearer device-session' },
      aborted: false,
    }) as unknown as IncomingMessage;
    const response = {
      statusCode: 200,
      setHeader() {},
      end() {},
    } as unknown as ServerResponse;
    const pending = handler(request, response);
    await started;
    request.emit('aborted');
    await pending;
    expect(apiSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(500);
  });
});
