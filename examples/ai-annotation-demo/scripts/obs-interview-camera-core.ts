import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

export const OBS_INTERVIEW_SCENE = 'InkLoop Interview';
export const OBS_INTERVIEW_SOURCE = 'InkLoop Live Board';
export const OBS_INTERVIEW_CAMERA_SOURCE = 'InkLoop Camera PiP';
export const OBS_MACOS_CAMERA_INPUT_KIND = 'macos-avcapture';

export type ObsPropertyListItem = {
  itemName?: string;
  itemValue?: string;
  itemEnabled?: boolean;
};

export type ObsWebSocketConfig = Record<string, unknown> & {
  first_load?: boolean;
  server_enabled?: boolean;
  server_port?: number;
  alerts_enabled?: boolean;
  auth_required?: boolean;
  server_password?: string;
};

export type ObsRequestStatus = {
  result: boolean;
  code: number;
  comment?: string;
};

export type ObsResponse = {
  requestType: string;
  requestId: string;
  requestStatus: ObsRequestStatus;
  responseData?: Record<string, unknown>;
};

export function parseObsProcessIds(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 1);
}

export function obsExecutableProcessPattern(executable: string): string {
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}($| )`;
}

export function obsSentinelBackupName(path: string, batchId: string): string {
  const name = basename(path);
  if (!/^run_[0-9a-f-]+$/i.test(name)) throw new Error('obs_sentinel_name_invalid');
  if (!/^[0-9a-f-]+$/i.test(batchId)) throw new Error('obs_sentinel_batch_invalid');
  return `${batchId}-${name}`;
}

export function obsStartupBlocker(log: string): string | null {
  if (log.includes('[macOS] Permission for video device access denied.')) {
    return 'obs_camera_permission_required';
  }
  if (log.includes('[macOS] Permission for screen capture denied.')) {
    return 'obs_screen_capture_permission_required';
  }
  return null;
}

export function obsVirtualCameraStarted(log: string): boolean {
  return log.includes('==== Virtual Camera Start ');
}

export function obsRelaunchArgs(
  configured: boolean,
  wasRunning: boolean,
  scene = OBS_INTERVIEW_SCENE,
): string[] | null {
  if (configured) return ['--startvirtualcam', '--scene', scene];
  return wasRunning ? ['--scene', scene] : null;
}

export function obsAuthentication(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(`${password}${salt}`).digest('base64');
  return createHash('sha256').update(`${secret}${challenge}`).digest('base64');
}

export function temporaryObsWebSocketConfig(
  existing: ObsWebSocketConfig,
  password: string,
  port = 4455,
): ObsWebSocketConfig {
  if (!password) throw new Error('obs_websocket_password_required');
  return {
    ...existing,
    first_load: false,
    server_enabled: true,
    server_port: port,
    alerts_enabled: false,
    auth_required: true,
    server_password: password,
  };
}

export function projectionUrl(baseUrl = 'http://127.0.0.1:8765'): string {
  const url = new URL('/meeting-live-board.html', baseUrl);
  url.searchParams.set('projection', '1');
  return url.toString();
}

export function selectMacOSCameraDevice(
  items: ObsPropertyListItem[],
  preferredName = '',
): ObsPropertyListItem | null {
  const candidates = items.filter((item) => item.itemEnabled !== false
    && typeof item.itemValue === 'string'
    && item.itemValue.length > 0
    && !/obs virtual camera/i.test(item.itemName || ''));
  if (!candidates.length) return null;

  const normalizedPreference = preferredName.trim().toLocaleLowerCase();
  if (normalizedPreference) {
    const exact = candidates.find((item) => item.itemName?.trim().toLocaleLowerCase() === normalizedPreference);
    if (exact) return exact;
    const partial = candidates.find((item) => item.itemName?.toLocaleLowerCase().includes(normalizedPreference));
    if (partial) return partial;
  }
  return candidates.find((item) => /macbook|facetime|内建|built-in/i.test(item.itemName || '')) || candidates[0] || null;
}

export function selectMacOSCameraPreset(items: ObsPropertyListItem[]): ObsPropertyListItem | null {
  const candidates = items.filter((item) => item.itemEnabled !== false
    && typeof item.itemValue === 'string'
    && item.itemValue.length > 0);
  return candidates.find((item) => /1920\s*[x×]\s*1080/i.test(item.itemName || ''))
    || candidates.find((item) => /1280\s*[x×]\s*720/i.test(item.itemName || ''))
    || candidates.find((item) => /^high$/i.test(item.itemName || ''))
    || candidates[0]
    || null;
}

export function interviewCameraInputSettings(
  device: ObsPropertyListItem,
  preset: ObsPropertyListItem | null = null,
): Record<string, unknown> {
  return {
    device: device.itemValue,
    device_name: device.itemName || '',
    use_preset: true,
    ...(preset?.itemValue ? { preset: preset.itemValue } : {}),
  };
}

export function obsRequest(requestType: string, requestData: Record<string, unknown> = {}): {
  op: 6;
  d: { requestType: string; requestId: string; requestData: Record<string, unknown> };
} {
  return {
    op: 6,
    d: { requestType, requestId: randomUUID(), requestData },
  };
}

export function cameraSourceActivityRequest(): {
  requestType: 'GetSourceActive';
  requestData: { sourceName: string };
} {
  return {
    requestType: 'GetSourceActive',
    requestData: { sourceName: OBS_INTERVIEW_CAMERA_SOURCE },
  };
}

export function assertObsResponse(value: unknown, expectedType: string): ObsResponse {
  const envelope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const response = envelope.d && typeof envelope.d === 'object'
    ? envelope.d as unknown as ObsResponse
    : null;
  if (envelope.op !== 7 || !response || response.requestType !== expectedType) {
    throw new Error(`obs_invalid_response:${expectedType}`);
  }
  if (!response.requestStatus?.result) {
    throw new Error(`obs_request_failed:${expectedType}:${response.requestStatus?.code || 0}:${response.requestStatus?.comment || ''}`);
  }
  return response;
}

export function interviewBrowserInputSettings(url: string): Record<string, unknown> {
  return {
    url,
    width: 1920,
    height: 1080,
    fps: 30,
    shutdown: false,
    restart_when_active: true,
    reroute_audio: false,
    css: 'body { background-color: transparent; overflow: hidden; }',
  };
}

export function interviewSceneItemTransform(): Record<string, unknown> {
  return {
    alignment: 5,
    positionX: 0,
    positionY: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    boundsType: 'OBS_BOUNDS_STRETCH',
    boundsAlignment: 5,
    boundsWidth: 1920,
    boundsHeight: 1080,
    cropToBounds: false,
  };
}

export function interviewCameraSceneItemTransform(): Record<string, unknown> {
  return {
    alignment: 5,
    positionX: 1460,
    positionY: 86,
    rotation: 0,
    boundsType: 'OBS_BOUNDS_SCALE_OUTER',
    boundsAlignment: 5,
    boundsWidth: 440,
    boundsHeight: 248,
    cropToBounds: true,
  };
}
