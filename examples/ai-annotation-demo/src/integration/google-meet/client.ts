/** Google OAuth + Calendar client. All requests go through core/api so APK appassets resolve to Cloud Hub. */
import { getJson } from '../../core/api';

const BASE = '/api/google';

export interface GoogleOAuthStatusResponse {
  connected: boolean;
  configured: boolean;
  scopes: string[];
  required_scopes: string[];
  missing_scopes: string[];
  expiry?: string;
  refresh_token_present: boolean;
  reauth_required: boolean;
  reason?: string;
}

export interface GoogleDeviceOAuthStartResponse {
  auth_url: string;
  state: string;
  expires_at: number;
  scopes: string[];
}

export interface GoogleDeviceOAuthCompletionResponse {
  status: 'idle' | 'pending' | 'complete' | 'failed';
  connected: boolean;
  expires_at?: number;
  completed_at?: number;
  error?: string;
  oauth?: GoogleOAuthStatusResponse;
}

export interface GoogleMeetingSource {
  platform: 'google_meet';
  calendar_event_id: string;
  ical_uid?: string;
  recurring_event_id?: string;
  original_start_time?: string;
  title: string;
  scheduled_at: string;
  scheduled_end_at?: string;
  meeting_code?: string;
  meeting_url?: string;
  organizer_email?: string;
  status: 'confirmed' | 'cancelled';
}

export interface GoogleMeetingSourcesResponse {
  connected: boolean;
  configured: boolean;
  source: 'google_calendar';
  source_count: number;
  sources: GoogleMeetingSource[];
  sync_token_present: boolean;
  full_sync: boolean;
  cursor_reset: boolean;
}

export interface GoogleMeetingTranscriptLine {
  start_time: string;
  end_time: string;
  speaker_id: string;
  speaker_name?: string;
  text: string;
}

export interface GoogleMeetingTranscriptResponse {
  status: 'ready' | 'pending' | 'not_generated' | 'no_record';
  record?: { name: string; start_time?: string; end_time?: string };
  transcript?: { name: string; lines: GoogleMeetingTranscriptLine[]; srt: string };
  participants?: Array<Record<string, unknown>>;
  next_check_at?: string;
}

export function getGoogleOAuthStatus(opts?: { signal?: AbortSignal }): Promise<GoogleOAuthStatusResponse> {
  return getJson<GoogleOAuthStatusResponse>(`${BASE}/oauth/status`, { ...opts, auth: true });
}

export function startGoogleDeviceOAuth(opts?: { signal?: AbortSignal }): Promise<GoogleDeviceOAuthStartResponse> {
  return getJson<GoogleDeviceOAuthStartResponse>(`${BASE}/oauth/device/start`, { ...opts, auth: true });
}

export function pollGoogleDeviceOAuth(opts?: { signal?: AbortSignal }): Promise<GoogleDeviceOAuthCompletionResponse> {
  return getJson<GoogleDeviceOAuthCompletionResponse>(`${BASE}/oauth/device/complete`, { ...opts, auth: true });
}

export function listGoogleMeetingSources(opts?: { signal?: AbortSignal }): Promise<GoogleMeetingSourcesResponse> {
  return getJson<GoogleMeetingSourcesResponse>(`${BASE}/meeting-sources`, { ...opts, auth: true });
}

export function getGoogleMeetingTranscript(
  input: { meetingCode: string; scheduledAt: string },
  opts?: { signal?: AbortSignal },
): Promise<GoogleMeetingTranscriptResponse> {
  const query = new URLSearchParams({ meeting_code: input.meetingCode, scheduled_at: input.scheduledAt });
  return getJson<GoogleMeetingTranscriptResponse>(`${BASE}/meeting-transcript?${query.toString()}`, { ...opts, auth: true });
}
