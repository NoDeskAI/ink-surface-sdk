import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonCloudDeviceStore } from './cloud-device-store';

describe('JsonCloudDeviceStore', () => {
  it('persists device heartbeat records per tenant/user namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-device-store-'));
    try {
      const store = new JsonCloudDeviceStore(root);
      await store.upsertHeartbeat({ tenant_id: 'tenant_a', user_id: 'user_a' }, 'paper_a', {
        platform: 'android-webview',
        status: 'syncing',
        lan_import: { running: true, port: 8787 },
      });
      await store.upsertHeartbeat({ tenant_id: 'tenant_a', user_id: 'user_b' }, 'paper_a', {
        platform: 'android-webview',
        status: 'online',
      });

      const reloaded = new JsonCloudDeviceStore(root);
      const userA = await reloaded.list({ tenant_id: 'tenant_a', user_id: 'user_a' });
      const userB = await reloaded.list({ tenant_id: 'tenant_a', user_id: 'user_b' });

      expect(userA.devices).toHaveLength(1);
      expect(userA.devices[0]).toMatchObject({
        schema_version: 'inkloop.cloud_device.record.v1',
        tenant_id: 'tenant_a',
        user_id: 'user_a',
        device_id: 'paper_a',
        platform: 'android-webview',
        status: 'syncing',
        lan_import: { running: true, port: 8787 },
      });
      expect(userB.devices).toHaveLength(1);
      expect(userB.devices[0].user_id).toBe('user_b');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists open-source commands per user and supports pull/ack lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkloop-device-commands-'));
    try {
      const store = new JsonCloudDeviceStore(root);
      const userA = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const userB = { tenant_id: 'tenant_a', user_id: 'user_b' };
      await store.upsertHeartbeat(userA, 'paper_a', {
        platform: 'android-webview',
        status: 'online',
        capabilities: { reading: true },
      });
      await store.upsertHeartbeat(userB, 'paper_b', {
        platform: 'android-webview',
        status: 'online',
        capabilities: { reading: true },
      });

      const command = await store.enqueueCommand(userA, {
        type: 'open_source',
        source_device_id: 'obsidian_a',
        payload: { uri: 'inkloop://doc/doc_a?anchor=mark_1' },
      });
      expect(command).toMatchObject({
        schema_version: 'inkloop.cloud_device.command.v1',
        tenant_id: 'tenant_a',
        user_id: 'user_a',
        target_device_id: 'paper_a',
        source_device_id: 'obsidian_a',
        type: 'open_source',
        status: 'pending',
      });

      await expect(store.pullCommands(userB, 'paper_b')).resolves.toEqual([]);
      const delivered = await store.pullCommands(userA, 'paper_a');
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ command_id: command.command_id, status: 'delivered' });

      const acked = await store.ackCommand(userA, 'paper_a', command.command_id, {
        ok: true,
        result: { ok: true, page_index: 4 },
      });
      expect(acked).toMatchObject({
        command_id: command.command_id,
        status: 'acked',
        result: { ok: true, page_index: 4 },
      });
      await expect(store.pullCommands(userA, 'paper_a')).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
