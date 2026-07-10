import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AckCloudDeviceCommandInput,
  CloudDeviceNamespace,
  EnqueueCloudDeviceCommandInput,
  JsonCloudDeviceStore,
  UpsertCloudDeviceInput,
} from './cloud-device-store';

interface DeviceSessionContext {
  active?: boolean;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
}

export interface CloudDeviceHandlerOptions {
  store: JsonCloudDeviceStore;
  resolveSession?: (req: IncomingMessage) => Promise<DeviceSessionContext | null>;
  requireSession?: boolean;
}

const MAX_BODY = 1024 * 1024;

function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBody = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function resolveNamespace(req: IncomingMessage, options: CloudDeviceHandlerOptions): Promise<{ namespace: CloudDeviceNamespace; deviceId?: string }> {
  let session: DeviceSessionContext | null = null;
  const hasSessionToken = !!(header(req, 'authorization') || header(req, 'x-inkloop-session'));
  if (options.resolveSession && hasSessionToken) {
    try {
      session = await options.resolveSession(req);
    } catch {
      session = null;
    }
  }
  if (options.requireSession && !session) {
    throw Object.assign(new Error('missing_session_token'), { status: 401 });
  }
  return {
    namespace: {
      tenant_id: session?.tenant_id || header(req, 'x-inkloop-tenant-id') || process.env.INKLOOP_TENANT_ID || 'local',
      user_id: session?.user_id || header(req, 'x-inkloop-user-id') || process.env.INKLOOP_USER_ID || 'local_demo',
    },
    deviceId: session?.device_id || header(req, 'x-inkloop-device-id') || undefined,
  };
}

function decodeDeviceId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/devices\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function decodeCommandId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/devices\/commands\/([^/]+)\/ack$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function createCloudDeviceHandler(options: CloudDeviceHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = parsed.pathname;
    if (!path.startsWith('/v1/devices')) return false;

    try {
      const { namespace, deviceId } = await resolveNamespace(req, options);

      if (req.method === 'GET' && path === '/v1/devices/manifest') {
        sendJson(res, 200, await options.store.list(namespace));
        return true;
      }

      if (req.method === 'POST' && path === '/v1/devices/commands') {
        const body = JSON.parse(await readBody(req) || '{}') as EnqueueCloudDeviceCommandInput;
        const command = await options.store.enqueueCommand(namespace, {
          ...body,
          source_device_id: body.source_device_id || deviceId,
        });
        sendJson(res, 200, {
          ok: true,
          schema_version: 'inkloop.cloud_device.command_enqueue_ack.v1',
          command,
        });
        return true;
      }

      if (req.method === 'GET' && path === '/v1/devices/commands:pull') {
        const targetDeviceId = deviceId || parsed.searchParams.get('device_id') || '';
        const commands = await options.store.pullCommands(namespace, targetDeviceId);
        sendJson(res, 200, {
          ok: true,
          schema_version: 'inkloop.cloud_device.command_pull.v1',
          device_id: targetDeviceId,
          commands,
        });
        return true;
      }

      if (req.method === 'POST' && path.startsWith('/v1/devices/commands/')) {
        const commandId = decodeCommandId(path);
        if (!commandId) {
          sendJson(res, 404, { error: 'not_found' });
          return true;
        }
        const body = JSON.parse(await readBody(req) || '{}') as AckCloudDeviceCommandInput;
        const resultDeviceId = body.result && typeof body.result.device_id === 'string' ? body.result.device_id : '';
        const command = await options.store.ackCommand(namespace, deviceId || resultDeviceId, commandId, body);
        sendJson(res, 200, {
          ok: true,
          schema_version: 'inkloop.cloud_device.command_ack.v1',
          command,
        });
        return true;
      }

      if (req.method === 'GET' && path.startsWith('/v1/devices/')) {
        const requestedDeviceId = decodeDeviceId(path);
        if (!requestedDeviceId) {
          sendJson(res, 404, { error: 'not_found' });
          return true;
        }
        const device = await options.store.get(namespace, requestedDeviceId);
        sendJson(res, device ? 200 : 404, device || { error: 'device_not_found' });
        return true;
      }

      if (req.method === 'POST' && path === '/v1/devices/heartbeat') {
        const body = JSON.parse(await readBody(req) || '{}') as UpsertCloudDeviceInput & { device_id?: string };
        const record = await options.store.upsertHeartbeat(namespace, deviceId || body.device_id || '', body);
        sendJson(res, 200, {
          ok: true,
          schema_version: 'inkloop.cloud_device.heartbeat_ack.v1',
          device: record,
        });
        return true;
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    } catch (error) {
      sendJson(res, Number((error as { status?: number })?.status) || 500, { error: String((error as Error)?.message || error) });
      return true;
    }
  };
}
