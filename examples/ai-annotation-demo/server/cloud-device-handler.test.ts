import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudDeviceHandler } from './cloud-device-handler';
import { JsonCloudDeviceStore } from './cloud-device-store';

let server: Server | null = null;

async function start(store: JsonCloudDeviceStore): Promise<string> {
  const handler = createCloudDeviceHandler({
    store,
    requireSession: true,
    async resolveSession(req) {
      const auth = String(req.headers.authorization || '');
      if (auth !== 'Bearer session_a') return null;
      return {
        active: true,
        tenant_id: 'tenant_session',
        user_id: 'user_session',
        device_id: 'paper_session',
      };
    },
  });
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe('cloud device handler', () => {
  it('uses the authenticated session namespace and device id over spoofable headers/body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-device-handler-'));
    try {
      const base = await start(new JsonCloudDeviceStore(dir));
      const unauth = await fetch(`${base}/v1/devices/manifest`);
      expect(unauth.status).toBe(401);

      const heartbeat = await fetch(`${base}/v1/devices/heartbeat`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer session_a',
          'content-type': 'application/json',
          'x-inkloop-tenant-id': 'tenant_spoof',
          'x-inkloop-user-id': 'user_spoof',
          'x-inkloop-device-id': 'device_spoof',
        },
        body: JSON.stringify({
          device_id: 'body_spoof',
          platform: 'android-webview',
          status: 'online',
        }),
      });
      expect(heartbeat.status).toBe(200);
      const ack = await heartbeat.json() as { device: { tenant_id?: string; user_id?: string; device_id?: string } };
      expect(ack.device).toMatchObject({
        tenant_id: 'tenant_session',
        user_id: 'user_session',
        device_id: 'paper_session',
      });

      const manifest = await (await fetch(`${base}/v1/devices/manifest`, {
        headers: { authorization: 'Bearer session_a' },
      })).json() as { devices: Array<{ device_id: string }> };
      expect(manifest.devices.map((device) => device.device_id)).toEqual(['paper_session']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enqueues, delivers, and acks open-source commands through authenticated device routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-device-commands-handler-'));
    try {
      const base = await start(new JsonCloudDeviceStore(dir));
      await fetch(`${base}/v1/devices/heartbeat`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer session_a',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          platform: 'android-webview',
          status: 'online',
          capabilities: { reading: true },
        }),
      });

      const enqueue = await fetch(`${base}/v1/devices/commands`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer session_a',
          'content-type': 'application/json',
          'x-inkloop-tenant-id': 'tenant_spoof',
          'x-inkloop-user-id': 'user_spoof',
        },
        body: JSON.stringify({
          type: 'open_source',
          payload: { uri: 'inkloop://doc/doc_demo?anchor=mark_demo' },
        }),
      });
      expect(enqueue.status).toBe(200);
      const enqueued = await enqueue.json() as { command: { command_id: string; tenant_id?: string; user_id?: string; target_device_id?: string } };
      expect(enqueued.command).toMatchObject({
        tenant_id: 'tenant_session',
        user_id: 'user_session',
        target_device_id: 'paper_session',
      });

      const pull = await fetch(`${base}/v1/devices/commands:pull`, {
        headers: { authorization: 'Bearer session_a' },
      });
      expect(pull.status).toBe(200);
      const pulled = await pull.json() as { commands: Array<{ command_id: string; status: string; payload: { uri: string } }> };
      expect(pulled.commands).toHaveLength(1);
      expect(pulled.commands[0]).toMatchObject({
        command_id: enqueued.command.command_id,
        status: 'delivered',
        payload: { uri: 'inkloop://doc/doc_demo?anchor=mark_demo' },
      });

      const ack = await fetch(`${base}/v1/devices/commands/${encodeURIComponent(enqueued.command.command_id)}/ack`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer session_a',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ok: true, result: { ok: true, page_index: 2 } }),
      });
      expect(ack.status).toBe(200);
      const acked = await ack.json() as { command: { status: string; result?: { page_index?: number } } };
      expect(acked.command).toMatchObject({ status: 'acked', result: { page_index: 2 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
