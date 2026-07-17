/**
 * Zoom hub HTTP 路由：在设备 session 鉴权后暴露 S2S 状态、排期快照和会后转写。
 * handler 通过依赖注入可在不监听端口的测试中验证，所有 Zoom 子路由共享同一设备鉴权门。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  fetchZoomMeetingSources,
  readZoomMeetingSources,
  zoomMeetingSyncErrorPayload,
  zoomMeetingSyncPath,
  type ZoomMeetingSyncRef,
} from './zoom-meeting-sync';
import {
  fetchZoomMeetingTranscript,
  zoomMeetingRecordsErrorPayload,
  zoomMeetingRecordsPath,
  type ZoomMeetingAttendanceWindow,
  type ZoomMeetingRecordsEnv,
  type ZoomMeetingRecordsRef,
} from './zoom-meeting-records';
import { zoomS2SConfigured, zoomS2SStatus } from './zoom-oauth-state';

export interface ZoomApiHandlerOptions {
  env?: ZoomMeetingRecordsEnv;
  syncRef?: ZoomMeetingSyncRef;
  recordsRef?: ZoomMeetingRecordsRef;
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: () => number;
  minSyncIntervalMs?: number;
  requireDeviceSession: (req: IncomingMessage, res: ServerResponse) => Promise<unknown | null>;
  resolveAttendanceWindows?: (session: unknown, meetingId: string, nowMs: number) => ZoomMeetingAttendanceWindow[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function createZoomApiHandler(options: ZoomApiHandlerOptions) {
  const env = options.env || process.env;
  const syncRef = options.syncRef || { path: zoomMeetingSyncPath(env) };
  const recordsRef = options.recordsRef || { path: zoomMeetingRecordsPath(env) };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/api/zoom', 'http://inkloop.local');
    if (!url.pathname.startsWith('/api/zoom/')) return false;
    if (!['/api/zoom/status', '/api/zoom/meeting-sources', '/api/zoom/meeting-transcript'].includes(url.pathname)) {
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
        ...(url.pathname === '/api/zoom/meeting-sources' ? { sources: [] } : {}),
        error: { code: 'zoom_s2s_not_configured', message: 'Zoom Server-to-Server OAuth is not configured' },
      });
      return true;
    }

    if (url.pathname === '/api/zoom/meeting-transcript') {
      const meetingId = cleanMeetingId(url.searchParams.get('space_name'));
      const scheduledAt = normalizeTime(url.searchParams.get('scheduled_at'));
      if (!meetingId || !scheduledAt) {
        sendJson(res, 400, {
          error: {
            code: 'zoom_meeting_transcript_input_missing',
            message: 'numeric space_name and scheduled_at are required',
          },
        });
        return true;
      }
      try {
        const source = readZoomMeetingSources(syncRef)
          .filter((item) => item.meeting_id === meetingId)
          .sort((left, right) => (
            Math.abs(Date.parse(left.scheduled_at) - Date.parse(scheduledAt))
            - Math.abs(Date.parse(right.scheduled_at) - Date.parse(scheduledAt))
          ))[0];
        const scheduledEndAt = source
          ? new Date(Date.parse(source.scheduled_at) + Math.max(0, source.duration_minutes) * 60_000).toISOString()
          : undefined;
        const result = await fetchZoomMeetingTranscript(env, recordsRef, {
          meetingId,
          scheduledAt,
          ...(scheduledEndAt ? { scheduledEndAt } : {}),
          attendance: options.resolveAttendanceWindows?.(session, meetingId, nowMs) || [],
        }, {
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl,
          nowMs,
        });
        sendJson(res, 200, result);
      } catch (error) {
        const failure = zoomMeetingRecordsErrorPayload(error);
        sendJson(res, failure.status, failure.body);
      }
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

function cleanMeetingId(value: string | null): string {
  const cleaned = String(value || '').trim();
  return /^\d+$/.test(cleaned) ? cleaned : '';
}

function normalizeTime(value: string | null): string {
  const ms = Date.parse(String(value || '').trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}
