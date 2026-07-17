/** Zoom S2S 状态与排期会议源客户端。设备请求一律走 core/api 基建。 */
import { getJson } from '../../core/api';

const BASE = '/api/zoom';

export interface ZoomStatusResponse {
  configured: boolean;
  connected: boolean;
}

export interface ZoomMeetingSource {
  platform: 'zoom';
  meeting_id: string;
  topic: string;
  scheduled_at: string;
  duration_minutes: number;
  join_url: string;
  host_user_id: string;
  occurrence_id?: string;
  timezone?: string;
  missing_since?: string;
}

export interface ZoomMeetingSourcesResponse {
  configured: boolean;
  connected: boolean;
  source: 'zoom';
  source_count: number;
  sources: ZoomMeetingSource[];
  fetched_at?: string;
  throttled: boolean;
}

export interface ZoomMeetingLiveWindow {
  platform: string;
  meeting_id: string;
  external_meeting_id?: string;
  meeting_url?: string;
  title?: string;
  started_at_ms: number;
  ended_at_ms?: number;
  detector_source?: string;
  updated_at: string;
}

export interface ZoomMeetingLiveStateResponse {
  connected: boolean;
  source: 'mtl_receiver';
  windows: ZoomMeetingLiveWindow[];
}

export function fetchZoomStatus(opts?: { signal?: AbortSignal }): Promise<ZoomStatusResponse> {
  return getJson<ZoomStatusResponse>(`${BASE}/status`, { ...opts, auth: true });
}

export function fetchZoomMeetingSources(opts?: { signal?: AbortSignal }): Promise<ZoomMeetingSourcesResponse> {
  return getJson<ZoomMeetingSourcesResponse>(`${BASE}/meeting-sources`, { ...opts, auth: true });
}

export function fetchZoomMeetingLiveState(opts?: { signal?: AbortSignal }): Promise<ZoomMeetingLiveStateResponse> {
  return getJson<ZoomMeetingLiveStateResponse>('/api/meeting-providers/live-state?platform=zoom', { ...opts, auth: true });
}
