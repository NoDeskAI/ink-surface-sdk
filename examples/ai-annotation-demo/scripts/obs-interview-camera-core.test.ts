import { describe, expect, it } from 'vitest';
import {
  assertObsResponse,
  cameraSourceActivityRequest,
  interviewBrowserInputSettings,
  interviewCameraInputSettings,
  interviewCameraSceneItemTransform,
  interviewSceneItemTransform,
  obsAuthentication,
  obsExecutableProcessPattern,
  obsRelaunchArgs,
  obsRequest,
  obsSentinelBackupName,
  obsStartupBlocker,
  obsVirtualCameraStarted,
  parseObsProcessIds,
  projectionUrl,
  selectMacOSCameraDevice,
  selectMacOSCameraPreset,
  temporaryObsWebSocketConfig,
} from './obs-interview-camera-core';

describe('OBS interview camera core', () => {
  it('implements the OBS WebSocket v5 authentication digest', () => {
    expect(obsAuthentication('password', 'salt', 'challenge')).toBe('zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=');
  });

  it('temporarily enables authenticated localhost automation without dropping existing settings', () => {
    expect(temporaryObsWebSocketConfig({ custom: 'preserved', server_enabled: false }, 'secret')).toEqual({
      custom: 'preserved',
      first_load: false,
      server_enabled: true,
      server_port: 4455,
      alerts_enabled: false,
      auth_required: true,
      server_password: 'secret',
    });
    expect(() => temporaryObsWebSocketConfig({}, '')).toThrow('obs_websocket_password_required');
  });

  it('parses only safe OBS process ids for the graceful quit fallback', () => {
    expect(parseObsProcessIds('50312\n  50401  \n')).toEqual([50312, 50401]);
    expect(parseObsProcessIds('0\n1\nnot-a-pid\n')).toEqual([]);
  });

  it('matches only the exact OBS executable in POSIX pgrep syntax', () => {
    expect(obsExecutableProcessPattern('/Applications/OBS.app/Contents/MacOS/OBS'))
      .toBe('^/Applications/OBS\\.app/Contents/MacOS/OBS($| )');
  });

  it('creates auditable names for stale OBS sentinel recovery', () => {
    expect(obsSentinelBackupName('/tmp/run_abc-123', 'abc-456')).toBe('abc-456-run_abc-123');
    expect(() => obsSentinelBackupName('/tmp/not-a-sentinel', 'abc-456')).toThrow('obs_sentinel_name_invalid');
    expect(() => obsSentinelBackupName('/tmp/run_abc', '../escape')).toThrow('obs_sentinel_batch_invalid');
  });

  it('turns macOS permission logs into actionable startup blockers', () => {
    expect(obsStartupBlocker('[macOS] Permission for video device access denied.'))
      .toBe('obs_camera_permission_required');
    expect(obsStartupBlocker('[macOS] Permission for screen capture denied.'))
      .toBe('obs_screen_capture_permission_required');
    expect(obsStartupBlocker('[macOS] Permission for video device access granted.')).toBeNull();
  });

  it('recognizes real OBS virtual-camera start evidence in the final process log', () => {
    expect(obsVirtualCameraStarted('==== Virtual Camera Start =========================================='))
      .toBe(true);
    expect(obsVirtualCameraStarted('[mac-virtualcam] macOS Camera Extension activated successfully.'))
      .toBe(false);
  });

  it('starts the virtual camera only after successful scene configuration', () => {
    expect(obsRelaunchArgs(true, false)).toEqual([
      '--startvirtualcam', '--scene', 'InkLoop Interview',
    ]);
    expect(obsRelaunchArgs(false, true)).toEqual(['--scene', 'InkLoop Interview']);
    expect(obsRelaunchArgs(false, false)).toBeNull();
  });

  it('builds a local projection URL without competing for the physical camera', () => {
    expect(projectionUrl()).toBe('http://127.0.0.1:8765/meeting-live-board.html?projection=1');
    expect(interviewBrowserInputSettings(projectionUrl())).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      reroute_audio: false,
    });
  });

  it('selects a physical macOS camera and excludes the OBS loopback device', () => {
    const devices = [
      { itemName: 'OBS Virtual Camera', itemValue: 'obs-camera', itemEnabled: true },
      { itemName: 'External Camera', itemValue: 'external', itemEnabled: true },
      { itemName: 'MacBook Pro相机', itemValue: 'built-in', itemEnabled: true },
    ];
    expect(selectMacOSCameraDevice(devices, 'MacBook Pro相机')).toEqual(devices[2]);
    expect(selectMacOSCameraDevice(devices)).toEqual(devices[2]);
    expect(interviewCameraInputSettings(devices[2])).toMatchObject({
      device: 'built-in',
      device_name: 'MacBook Pro相机',
      use_preset: true,
    });
    const presets = [
      { itemName: 'High', itemValue: 'high' },
      { itemName: '1280x720', itemValue: '720p' },
      { itemName: '1920x1080', itemValue: '1080p' },
    ];
    expect(selectMacOSCameraPreset(presets)).toEqual(presets[2]);
    expect(interviewCameraInputSettings(devices[2], presets[2])).toMatchObject({ preset: '1080p' });
  });

  it('positions the native camera over the Live Board camera frame', () => {
    expect(interviewCameraSceneItemTransform()).toMatchObject({
      positionX: 1460,
      positionY: 86,
      boundsType: 'OBS_BOUNDS_SCALE_OUTER',
      boundsWidth: 440,
      boundsHeight: 248,
      cropToBounds: true,
    });
  });

  it('uses the OBS WebSocket v5 source-activity request for the camera', () => {
    expect(cameraSourceActivityRequest()).toEqual({
      requestType: 'GetSourceActive',
      requestData: { sourceName: 'InkLoop Camera PiP' },
    });
  });

  it('fills the full 1080p canvas and rejects failed OBS requests', () => {
    expect(interviewSceneItemTransform()).toMatchObject({
      boundsType: 'OBS_BOUNDS_STRETCH',
      boundsWidth: 1920,
      boundsHeight: 1080,
    });
    const request = obsRequest('GetVersion');
    expect(request.op).toBe(6);
    expect(request.d.requestType).toBe('GetVersion');
    expect(() => assertObsResponse({
      op: 7,
      d: {
        requestType: 'GetVersion',
        requestId: request.d.requestId,
        requestStatus: { result: false, code: 500, comment: 'boom' },
      },
    }, 'GetVersion')).toThrow('obs_request_failed:GetVersion:500:boom');
  });
});
