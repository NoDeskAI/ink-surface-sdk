/**
 * Zoom hub HTTP 路由：在设备 session 鉴权后暴露 S2S 连接状态与排期会议快照。
 * handler 通过依赖注入可在不监听端口的测试中验证；P2 transcript 路由不在本模块范围内。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  fetchZoomMeetingSources,
  zoomMeetingSyncErrorPayload,
  zoomMeetingSyncPath,
  type ZoomMeetingSyncEnv,
  type ZoomMeetingSyncRef,
} from './zoom-meeting-sync';
import { zoomS2SConfigured, zoomS2SStatus } from './zoom-oauth-state';

export interface ZoomApiHandlerOptions {
  env?: ZoomMeetingSyncEnv;
  syncRef?: ZoomMeetingSyncRef;
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: () => number;
  minSyncIntervalMs?: number;
  requireDeviceSession: (req: IncomingMessage, res: ServerResponse) => Promise<unknown | null>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function createZoomApiHandler(options: ZoomApiHandlerOptions) {
  const env = options.env || process.env;
  const syncRef = options.syncRef || { path: zoomMeetingSyncPath(env) };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/api/zoom', 'http://inkloop.local');
    if (!url.pathname.startsWith('/api/zoom/')) return false;
    if (url.pathname !== '/api/zoom/status' && url.pathname !== '/api/zoom/meeting-sources') {
      sendJson(res, 404, { error: { code: 'zoom_route_not_found', message: 'Zoom API route not found' } });
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } });
      return true;
    }
    const session = await options.requireDeviceSession(req, res);
    if (!session) return true;
    res.setHeader('cache-control', 'no-store');
    const nowMs = options.nowMs?.() ?? Date.now();

    if (url.pathname === '/api/zoom/status') {
      const status = await zoomS2SStatus(env, { probe: true, fetchImpl: options.fetchImpl, nowMs });
      sendJson(res, 200, { configured: status.configured, connected: status.token_ok });
      return true;
    }

    if (!zoomS2SConfigured(env)) {
      sendJson(res, 401, {
        configured: false,
        connected: false,
        sources: [],
        error: { code: 'zoom_s2s_not_configured', message: 'Zoom Server-to-Server OAuth is not configured' },
      });
      return true;
    }
    try {
      const result = await fetchZoomMeetingSources(env, syncRef, {
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
        nowMs,
        minIntervalMs: options.minSyncIntervalMs,
      });
      sendJson(res, 200, { configured: true, connected: true, ...result });
    } catch (error) {
      const failure = zoomMeetingSyncErrorPayload(error);
      sendJson(res, failure.status, { configured: true, connected: false, sources: [], ...failure.body });
    }
    return true;
  };
}
