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
});
