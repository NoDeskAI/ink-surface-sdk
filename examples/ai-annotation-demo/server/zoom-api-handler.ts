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

const ZOOM_REQUEST_TIMEOUT_MS = 30_000;

export interface ZoomApiHandlerOptions {
  env?: ZoomMeetingRecordsEnv;
  syncRef?: ZoomMeetingSyncRef;
  recordsRef?: ZoomMeetingRecordsRef;
  fetchImpl?: typeof fetch;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowMs?: () => number;
  minSyncIntervalMs?: number;
  requireDeviceSession: (req: IncomingMessage, res: ServerResponse) => Promise<unknown | null>;
  resolveAuthorizedHostUserIds?: (session: unknown) => string[];
  resolveAttendanceWindows?: (session: unknown, meetingId: string, nowMs: number) => ZoomMeetingAttendanceWindow[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function requestAbortScope(req: IncomingMessage): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new DOMException('Request aborted', 'AbortError'));
  if (req.aborted) abortRequest();
  req.once?.('aborted', abortRequest);
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Zoom request timed out', 'TimeoutError'));
  }, ZOOM_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      req.off?.('aborted', abortRequest);
    },
  };
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

    const authorizedHostUserIds = new Set(
      (options.resolveAuthorizedHostUserIds?.(session) || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    const authorizedSources = () => readZoomMeetingSources(syncRef)
      .filter((source) => authorizedHostUserIds.has(source.host_user_id));
    if (!authorizedHostUserIds.size) {
      sendJson(res, 403, {
        configured: true,
        connected: true,
        ...(url.pathname === '/api/zoom/meeting-sources' ? { sources: [] } : {}),
        error: {
          code: 'zoom_identity_not_authorized',
          message: 'This InkLoop user is not mapped to an authorized Zoom host',
        },
      });
      return true;
    }

    const configuredHostUserIds = new Set(
      String(env.ZOOM_HOST_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
    );
    if (configuredHostUserIds.size
      && [...authorizedHostUserIds].some((hostUserId) => !configuredHostUserIds.has(hostUserId))) {
      sendJson(res, 503, {
        configured: true,
        connected: false,
        ...(url.pathname === '/api/zoom/meeting-sources' ? { sources: [] } : {}),
        error: {
          code: 'zoom_host_access_misconfigured',
          message: 'The InkLoop Zoom host mapping is outside ZOOM_HOST_USER_IDS',
        },
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
      const requestScope = requestAbortScope(req);
      try {
        const source = authorizedSources().find((item) => (
          item.meeting_id === meetingId
          && item.scheduled_at === scheduledAt
        ));
        if (!source) {
          sendJson(res, 403, {
            error: {
              code: 'zoom_meeting_not_authorized',
              message: 'The requested Zoom occurrence is not authorized for this InkLoop user',
            },
          });
          return true;
        }
        const scheduledEndAt = new Date(
          Date.parse(source.scheduled_at) + Math.max(0, source.duration_minutes) * 60_000,
        ).toISOString();
        const result = await fetchZoomMeetingTranscript(env, recordsRef, {
          meetingId,
          scheduledAt,
          scheduledEndAt,
          attendance: options.resolveAttendanceWindows?.(session, meetingId, nowMs) || [],
        }, {
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl,
          nowMs,
          signal: requestScope.signal,
        });
        sendJson(res, 200, result);
      } catch (error) {
        const failure = zoomMeetingRecordsErrorPayload(error);
        sendJson(res, failure.status, failure.body);
      } finally {
        requestScope.dispose();
      }
      return true;
    }

    const requestScope = requestAbortScope(req);
    try {
      const result = await fetchZoomMeetingSources(env, syncRef, {
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
        nowMs,
        minIntervalMs: options.minSyncIntervalMs,
        signal: requestScope.signal,
      });
      const sources = result.sources.filter((source) => authorizedHostUserIds.has(source.host_user_id));
      sendJson(res, 200, {
        configured: true,
        connected: true,
        ...result,
        source_count: sources.length,
        sources,
      });
    } catch (error) {
      const failure = zoomMeetingSyncErrorPayload(error);
      sendJson(res, failure.status, { configured: true, connected: false, sources: [], ...failure.body });
    } finally {
      requestScope.dispose();
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
