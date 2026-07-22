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

export type ZoomTranscriptStatus = 'ready' | 'pending' | 'not_generated' | 'no_record';
export type ZoomTimestampQuality = 'derived_no_pause' | 'approximate_pause_unknown' | 'companion_offset_anchor';

export interface ZoomMeetingSummaryDetail {
  label: string;
  summary: string;
}

export interface ZoomTranscriptParticipant {
  join_time?: string;
  leave_time?: string;
  display_name: string;
  identity_quality: 'signed_in' | 'external_email' | 'anonymous';
}

export interface ZoomTranscriptLine {
  start_time: string;
  end_time: string;
  speaker: {
    display_name?: string;
    stable_id: null;
    attribution_quality: 'display_label';
  };
  text: string;
  recording_file_id: string;
}

export interface ZoomMeetingTranscriptResponse {
  status: ZoomTranscriptStatus;
  reason?: 'instance_not_found' | 'recording_missing' | 'recording_missing_companion_missing' | 'transcript_not_generated';
  record?: { name: string; start_time?: string; end_time?: string };
  transcript?: {
    name: string;
    lines: ZoomTranscriptLine[];
    srt: string;
    timestamp_quality: ZoomTimestampQuality;
  };
  participants: ZoomTranscriptParticipant[];
  instance_uuid?: string;
  t0?: string;
  started_at?: string;
  ended_at?: string;
  srt?: string;
  timestamp_quality?: ZoomTimestampQuality;
  smart_note?: {
    title?: string;
    text: string;
    export_uri?: string;
    overview?: string;
    details: ZoomMeetingSummaryDetail[];
    next_steps: string[];
    created_time?: string;
    fetched_at: string;
  };
  next_check_at?: string;
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

export function fetchZoomMeetingTranscript(
  spaceName: string,
  scheduledAt: string,
  opts?: { signal?: AbortSignal },
): Promise<ZoomMeetingTranscriptResponse> {
  const query = new URLSearchParams({ space_name: spaceName, scheduled_at: scheduledAt });
  return getJson<ZoomMeetingTranscriptResponse>(`${BASE}/meeting-transcript?${query.toString()}`, { ...opts, auth: true });
}
