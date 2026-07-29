/**
 * Idempotently configures OBS as the macOS Camera Adapter for InkLoop.
 *
 * OBS must be running with its localhost WebSocket server enabled. The
 * camera launcher supplies a temporary password; this script never stores it
 * or exposes the server beyond localhost.
 */
import {
  assertObsResponse,
  cameraSourceActivityRequest,
  interviewBrowserInputSettings,
  interviewCameraInputSettings,
  interviewCameraSceneItemTransform,
  interviewSceneItemTransform,
  OBS_INTERVIEW_CAMERA_SOURCE,
  OBS_INTERVIEW_SCENE,
  OBS_INTERVIEW_SOURCE,
  OBS_MACOS_CAMERA_INPUT_KIND,
  obsAuthentication,
  obsRequest,
  projectionUrl,
  selectMacOSCameraDevice,
  selectMacOSCameraPreset,
  type ObsPropertyListItem,
  type ObsResponse,
} from './obs-interview-camera-core';

const endpoint = process.env.INKLOOP_OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455';
const password = process.env.INKLOOP_OBS_WEBSOCKET_PASSWORD || '';
const sourceUrl = projectionUrl(process.env.INKLOOP_LIVE_BOARD_BASE_URL || 'http://127.0.0.1:8765');
const preferredCamera = process.env.INKLOOP_OBS_CAMERA_NAME || '';

type Envelope = { op: number; d?: Record<string, unknown> };

class ObsClient {
  private readonly socket = new WebSocket(endpoint);
  private readonly messages: Envelope[] = [];
  private readonly waiters: Array<(message: Envelope) => void> = [];

  async connect(): Promise<void> {
    // OBS can emit Hello immediately after the TCP upgrade. Subscribe before
    // awaiting `open`, otherwise a fast localhost server can race this client
    // and leave it waiting forever for a message that was already delivered.
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Envelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('obs_websocket_open_timeout')), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('obs_websocket_open_failed')); }, { once: true });
    });
    const hello = await this.next();
    if (hello.op !== 0) throw new Error('obs_websocket_missing_hello');
    const authentication = hello.d?.authentication as { salt?: string; challenge?: string } | undefined;
    this.send({
      op: 1,
      d: {
        rpcVersion: 1,
        eventSubscriptions: 0,
        ...(authentication?.salt && authentication.challenge
          ? { authentication: obsAuthentication(password, authentication.salt, authentication.challenge) }
          : {}),
      },
    });
    const identified = await this.next();
    if (identified.op !== 2) throw new Error('obs_websocket_identification_failed');
  }

  async request(requestType: string, requestData: Record<string, unknown> = {}): Promise<ObsResponse> {
    const request = obsRequest(requestType, requestData);
    this.send(request);
    for (;;) {
      const message = await this.next();
      if (message.op !== 7 || message.d?.requestId !== request.d.requestId) continue;
      return assertObsResponse(message, requestType);
    }
  }

  close(): void { this.socket.close(); }

  private send(value: unknown): void { this.socket.send(JSON.stringify(value)); }

  private async next(): Promise<Envelope> {
    const buffered = this.messages.shift();
    if (buffered) return buffered;
    return await new Promise<Envelope>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('obs_websocket_message_timeout')), 10_000);
      this.waiters.push((message) => { clearTimeout(timeout); resolve(message); });
    });
  }
}

async function requestIgnoringCode(client: ObsClient, requestType: string, requestData: Record<string, unknown>): Promise<ObsResponse | null> {
  try { return await client.request(requestType, requestData); }
  catch (error) {
    if (String(error).includes('obs_request_failed')) return null;
    throw error;
  }
}

async function ensureSceneItem(
  client: ObsClient,
  sourceName: string,
): Promise<number> {
  let existing = await requestIgnoringCode(client, 'GetSceneItemId', {
    sceneName: OBS_INTERVIEW_SCENE,
    sourceName,
  });
  if (!existing) {
    await client.request('CreateSceneItem', {
      sceneName: OBS_INTERVIEW_SCENE,
      sourceName,
      sceneItemEnabled: true,
    });
    existing = await client.request('GetSceneItemId', {
      sceneName: OBS_INTERVIEW_SCENE,
      sourceName,
    });
  }
  const sceneItemId = Number(existing.responseData?.sceneItemId);
  if (!Number.isInteger(sceneItemId)) throw new Error(`obs_scene_item_id_missing:${sourceName}`);
  return sceneItemId;
}

async function main(): Promise<void> {
  const client = new ObsClient();
  await client.connect();
  try {
    const version = await client.request('GetVersion');
    await client.request('SetVideoSettings', {
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 30,
      fpsDenominator: 1,
    });

    const scenes = await client.request('GetSceneList');
    const sceneNames = Array.isArray(scenes.responseData?.scenes)
      ? (scenes.responseData.scenes as Array<{ sceneName?: string }>).map((scene) => scene.sceneName)
      : [];
    if (!sceneNames.includes(OBS_INTERVIEW_SCENE)) {
      await client.request('CreateScene', { sceneName: OBS_INTERVIEW_SCENE });
    }

    const inputs = await client.request('GetInputList');
    const existingInputs = Array.isArray(inputs.responseData?.inputs)
      ? inputs.responseData.inputs as Array<{ inputName?: string; inputKind?: string }>
      : [];
    const inputNames = existingInputs.map((input) => input.inputName);
    if (!inputNames.includes(OBS_INTERVIEW_SOURCE)) {
      await client.request('CreateInput', {
        sceneName: OBS_INTERVIEW_SCENE,
        inputName: OBS_INTERVIEW_SOURCE,
        inputKind: 'browser_source',
        inputSettings: interviewBrowserInputSettings(sourceUrl),
        sceneItemEnabled: true,
      });
    } else {
      await client.request('SetInputSettings', {
        inputName: OBS_INTERVIEW_SOURCE,
        inputSettings: interviewBrowserInputSettings(sourceUrl),
        overlay: true,
      });
    }

    const sceneItemId = await ensureSceneItem(client, OBS_INTERVIEW_SOURCE);
    await client.request('SetSceneItemTransform', {
      sceneName: OBS_INTERVIEW_SCENE,
      sceneItemId,
      sceneItemTransform: interviewSceneItemTransform(),
    });
    await client.request('SetSceneItemIndex', {
      sceneName: OBS_INTERVIEW_SCENE,
      sceneItemId,
      sceneItemIndex: 0,
    });

    const kinds = await client.request('GetInputKindList', { unversioned: true });
    const inputKinds = Array.isArray(kinds.responseData?.inputKinds)
      ? kinds.responseData.inputKinds as string[]
      : [];
    if (!inputKinds.includes(OBS_MACOS_CAMERA_INPUT_KIND)) {
      throw new Error(`obs_input_kind_missing:${OBS_MACOS_CAMERA_INPUT_KIND}`);
    }
    const existingCamera = existingInputs.find((input) => input.inputName === OBS_INTERVIEW_CAMERA_SOURCE);
    if (existingCamera && existingCamera.inputKind !== OBS_MACOS_CAMERA_INPUT_KIND) {
      throw new Error(`obs_camera_input_kind_conflict:${existingCamera.inputKind || 'unknown'}`);
    }
    if (!existingCamera) {
      await client.request('CreateInput', {
        sceneName: OBS_INTERVIEW_SCENE,
        inputName: OBS_INTERVIEW_CAMERA_SOURCE,
        inputKind: OBS_MACOS_CAMERA_INPUT_KIND,
        inputSettings: {},
        sceneItemEnabled: true,
      });
    }

    const deviceProperties = await client.request('GetInputPropertiesListPropertyItems', {
      inputName: OBS_INTERVIEW_CAMERA_SOURCE,
      propertyName: 'device',
    });
    const cameraDevices = Array.isArray(deviceProperties.responseData?.propertyItems)
      ? deviceProperties.responseData.propertyItems as ObsPropertyListItem[]
      : [];
    const selectedCamera = selectMacOSCameraDevice(cameraDevices, preferredCamera);
    if (!selectedCamera) throw new Error('obs_physical_camera_missing');
    await client.request('SetInputSettings', {
      inputName: OBS_INTERVIEW_CAMERA_SOURCE,
      inputSettings: interviewCameraInputSettings(selectedCamera),
      overlay: true,
    });
    const presetProperties = await client.request('GetInputPropertiesListPropertyItems', {
      inputName: OBS_INTERVIEW_CAMERA_SOURCE,
      propertyName: 'preset',
    });
    const cameraPresets = Array.isArray(presetProperties.responseData?.propertyItems)
      ? presetProperties.responseData.propertyItems as ObsPropertyListItem[]
      : [];
    const selectedPreset = selectMacOSCameraPreset(cameraPresets);
    if (selectedPreset) {
      await client.request('SetInputSettings', {
        inputName: OBS_INTERVIEW_CAMERA_SOURCE,
        inputSettings: interviewCameraInputSettings(selectedCamera, selectedPreset),
        overlay: true,
      });
    }
    const cameraSceneItemId = await ensureSceneItem(client, OBS_INTERVIEW_CAMERA_SOURCE);
    await client.request('SetSceneItemTransform', {
      sceneName: OBS_INTERVIEW_SCENE,
      sceneItemId: cameraSceneItemId,
      sceneItemTransform: interviewCameraSceneItemTransform(),
    });
    await client.request('SetSceneItemIndex', {
      sceneName: OBS_INTERVIEW_SCENE,
      sceneItemId: cameraSceneItemId,
      sceneItemIndex: 1,
    });
    await client.request('SetCurrentProgramScene', { sceneName: OBS_INTERVIEW_SCENE });

    const sceneItems = await client.request('GetSceneItemList', { sceneName: OBS_INTERVIEW_SCENE });
    const browserSettings = await client.request('GetInputSettings', { inputName: OBS_INTERVIEW_SOURCE });
    const cameraSettings = await client.request('GetInputSettings', { inputName: OBS_INTERVIEW_CAMERA_SOURCE });
    const cameraActivityRequest = cameraSourceActivityRequest();
    const cameraActive = await client.request(
      cameraActivityRequest.requestType,
      cameraActivityRequest.requestData,
    );
    const browserTransform = await client.request('GetSceneItemTransform', {
      sceneName: OBS_INTERVIEW_SCENE,
      sceneItemId,
    });
    const cameraTransform = await client.request('GetSceneItemTransform', {
      sceneName: OBS_INTERVIEW_SCENE,
      sceneItemId: cameraSceneItemId,
    });
    const cameraVideoActive = cameraActive.responseData?.videoActive === true;
    const report = {
      schema_version: 'inkloop.obs_interview_camera_acceptance.v2',
      ok: cameraVideoActive,
      websocket_version: version.responseData?.obsWebSocketVersion || null,
      obs_version: version.responseData?.obsVersion || null,
      scene: OBS_INTERVIEW_SCENE,
      source: OBS_INTERVIEW_SOURCE,
      source_url: sourceUrl,
      scene_item_id: sceneItemId,
      camera_source: OBS_INTERVIEW_CAMERA_SOURCE,
      camera_input_kind: OBS_MACOS_CAMERA_INPUT_KIND,
      camera_device_name: selectedCamera.itemName || null,
      camera_device_id: selectedCamera.itemValue || null,
      camera_preset_name: selectedPreset?.itemName || null,
      camera_preset_id: selectedPreset?.itemValue || null,
      camera_scene_item_id: cameraSceneItemId,
      camera_video_active: cameraVideoActive,
      virtual_camera_active: false,
      virtual_camera_start_deferred_to_final_process: true,
      browser_settings: browserSettings.responseData?.inputSettings || null,
      camera_settings: cameraSettings.responseData?.inputSettings || null,
      browser_transform: browserTransform.responseData?.sceneItemTransform || null,
      camera_transform: cameraTransform.responseData?.sceneItemTransform || null,
      scene_items: sceneItems.responseData?.sceneItems || [],
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    client.close();
  }
}

await main();
