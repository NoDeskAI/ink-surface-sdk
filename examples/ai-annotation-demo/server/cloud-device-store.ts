import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CloudDeviceNamespace {
  tenant_id?: string;
  user_id?: string;
}

export type CloudDeviceStatus = 'online' | 'idle' | 'syncing' | 'offline' | 'error';

export interface CloudDeviceRecord {
  schema_version: 'inkloop.cloud_device.record.v1';
  tenant_id?: string;
  user_id?: string;
  device_id: string;
  device_label?: string;
  platform?: string;
  app_version?: string;
  app_surface?: string;
  status: CloudDeviceStatus;
  api_base?: string;
  capabilities?: Record<string, unknown>;
  health?: Record<string, unknown>;
  network?: Record<string, unknown>;
  battery?: Record<string, unknown>;
  library?: Record<string, unknown>;
  runtime_sync?: Record<string, unknown>;
  lan_import?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface CloudDeviceManifest {
  schema_version: 'inkloop.cloud_device.manifest.v1';
  tenant_id?: string;
  user_id?: string;
  generated_at: string;
  devices: CloudDeviceRecord[];
}

export type CloudDeviceCommandStatus = 'pending' | 'delivered' | 'acked' | 'failed';
export type CloudDeviceCommandType = 'open_source';

export interface CloudDeviceCommand {
  schema_version: 'inkloop.cloud_device.command.v1';
  command_id: string;
  tenant_id?: string;
  user_id?: string;
  target_device_id: string;
  source_device_id?: string;
  type: CloudDeviceCommandType;
  payload: {
    uri: string;
    requested_by?: string;
    source?: string;
  };
  status: CloudDeviceCommandStatus;
  created_at: string;
  updated_at: string;
  delivered_at?: string;
  acked_at?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface CloudDeviceCommandsManifest {
  schema_version: 'inkloop.cloud_device.commands_manifest.v1';
  tenant_id?: string;
  user_id?: string;
  generated_at: string;
  commands: CloudDeviceCommand[];
}

export interface UpsertCloudDeviceInput {
  device_label?: string;
  platform?: string;
  app_version?: string;
  app_surface?: string;
  status?: CloudDeviceStatus;
  api_base?: string;
  capabilities?: Record<string, unknown>;
  health?: Record<string, unknown>;
  network?: Record<string, unknown>;
  battery?: Record<string, unknown>;
  library?: Record<string, unknown>;
  runtime_sync?: Record<string, unknown>;
  lan_import?: Record<string, unknown>;
}

export interface EnqueueCloudDeviceCommandInput {
  target_device_id?: string;
  source_device_id?: string;
  type: CloudDeviceCommandType;
  payload?: Record<string, unknown>;
  requested_by?: string;
}

export interface AckCloudDeviceCommandInput {
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function safeSegment(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim() || fallback;
  return encodeURIComponent(raw).replace(/%/g, '_');
}

function safeDeviceId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function statusOf(value: unknown): CloudDeviceStatus {
  return value === 'idle' || value === 'syncing' || value === 'offline' || value === 'error' ? value : 'online';
}

function emptyManifest(namespace: CloudDeviceNamespace): CloudDeviceManifest {
  return {
    schema_version: 'inkloop.cloud_device.manifest.v1',
    tenant_id: namespace.tenant_id,
    user_id: namespace.user_id,
    generated_at: new Date().toISOString(),
    devices: [],
  };
}

function emptyCommandsManifest(namespace: CloudDeviceNamespace): CloudDeviceCommandsManifest {
  return {
    schema_version: 'inkloop.cloud_device.commands_manifest.v1',
    tenant_id: namespace.tenant_id,
    user_id: namespace.user_id,
    generated_at: new Date().toISOString(),
    commands: [],
  };
}

function commandId(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function looksLikeReadableDevice(device: CloudDeviceRecord): boolean {
  if (device.status === 'offline' || device.status === 'error') return false;
  const text = `${device.platform || ''} ${device.app_surface || ''}`.toLowerCase();
  if (text.includes('obsidian')) return false;
  if (text.includes('android') || text.includes('paper') || text.includes('webview')) return true;
  return device.capabilities?.reading === true;
}

export class JsonCloudDeviceStore {
  constructor(private readonly rootDir: string) {}

  private namespaceDir(namespace: CloudDeviceNamespace): string {
    return join(this.rootDir, safeSegment(namespace.tenant_id, 'local'), safeSegment(namespace.user_id, 'local_demo'));
  }

  private manifestPath(namespace: CloudDeviceNamespace): string {
    return join(this.namespaceDir(namespace), 'devices.json');
  }

  private commandsPath(namespace: CloudDeviceNamespace): string {
    return join(this.namespaceDir(namespace), 'device-commands.json');
  }

  private async readManifest(namespace: CloudDeviceNamespace): Promise<CloudDeviceManifest> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath(namespace), 'utf8')) as CloudDeviceManifest;
      if (parsed?.schema_version === 'inkloop.cloud_device.manifest.v1' && Array.isArray(parsed.devices)) {
        return { ...emptyManifest(namespace), ...parsed, tenant_id: namespace.tenant_id, user_id: namespace.user_id };
      }
    } catch {
      // Device state is advisory; a missing/corrupt manifest should not block file sync.
    }
    return emptyManifest(namespace);
  }

  private async writeManifest(namespace: CloudDeviceNamespace, manifest: CloudDeviceManifest): Promise<void> {
    await mkdir(this.namespaceDir(namespace), { recursive: true });
    await writeFile(this.manifestPath(namespace), JSON.stringify({ ...manifest, generated_at: new Date().toISOString() }, null, 2), 'utf8');
  }

  private async readCommandsManifest(namespace: CloudDeviceNamespace): Promise<CloudDeviceCommandsManifest> {
    try {
      const parsed = JSON.parse(await readFile(this.commandsPath(namespace), 'utf8')) as CloudDeviceCommandsManifest;
      if (parsed?.schema_version === 'inkloop.cloud_device.commands_manifest.v1' && Array.isArray(parsed.commands)) {
        return { ...emptyCommandsManifest(namespace), ...parsed, tenant_id: namespace.tenant_id, user_id: namespace.user_id };
      }
    } catch {
      // Command state is local Cloud Hub state; missing/corrupt files are treated as an empty queue.
    }
    return emptyCommandsManifest(namespace);
  }

  private async writeCommandsManifest(namespace: CloudDeviceNamespace, manifest: CloudDeviceCommandsManifest): Promise<void> {
    await mkdir(this.namespaceDir(namespace), { recursive: true });
    await writeFile(this.commandsPath(namespace), JSON.stringify({ ...manifest, generated_at: new Date().toISOString() }, null, 2), 'utf8');
  }

  async list(namespace: CloudDeviceNamespace): Promise<CloudDeviceManifest> {
    const manifest = await this.readManifest(namespace);
    return {
      ...manifest,
      generated_at: new Date().toISOString(),
      devices: [...manifest.devices].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at)),
    };
  }

  async get(namespace: CloudDeviceNamespace, deviceId: string): Promise<CloudDeviceRecord | null> {
    const safeId = safeDeviceId(deviceId);
    const manifest = await this.readManifest(namespace);
    return manifest.devices.find((device) => device.device_id === safeId) ?? null;
  }

  async upsertHeartbeat(namespace: CloudDeviceNamespace, deviceId: string, input: UpsertCloudDeviceInput = {}): Promise<CloudDeviceRecord> {
    const safeId = safeDeviceId(deviceId);
    if (!safeId) throw Object.assign(new Error('device_id_required'), { status: 400 });
    const manifest = await this.readManifest(namespace);
    const existing = manifest.devices.find((device) => device.device_id === safeId);
    const now = new Date().toISOString();
    const record: CloudDeviceRecord = {
      schema_version: 'inkloop.cloud_device.record.v1',
      tenant_id: namespace.tenant_id,
      user_id: namespace.user_id,
      device_id: safeId,
      device_label: input.device_label || existing?.device_label,
      platform: input.platform || existing?.platform,
      app_version: input.app_version || existing?.app_version,
      app_surface: input.app_surface || existing?.app_surface,
      status: statusOf(input.status || existing?.status),
      api_base: input.api_base || existing?.api_base,
      capabilities: recordObject(input.capabilities) || existing?.capabilities,
      health: recordObject(input.health) || existing?.health,
      network: recordObject(input.network) || existing?.network,
      battery: recordObject(input.battery) || existing?.battery,
      library: recordObject(input.library) || existing?.library,
      runtime_sync: recordObject(input.runtime_sync) || existing?.runtime_sync,
      lan_import: recordObject(input.lan_import) || existing?.lan_import,
      created_at: existing?.created_at || now,
      updated_at: now,
      last_seen_at: now,
    };
    const next = manifest.devices.filter((device) => device.device_id !== safeId);
    next.push(record);
    await this.writeManifest(namespace, { ...manifest, devices: next });
    return record;
  }

  async enqueueCommand(namespace: CloudDeviceNamespace, input: EnqueueCloudDeviceCommandInput): Promise<CloudDeviceCommand> {
    if (input.type !== 'open_source') throw Object.assign(new Error('unsupported_device_command_type'), { status: 400 });
    const uri = String(input.payload?.uri || '').trim();
    if (!/^inkloop:\/\/doc\//i.test(uri)) throw Object.assign(new Error('invalid_open_source_uri'), { status: 400 });
    const devices = (await this.list(namespace)).devices;
    const targetDeviceId = input.target_device_id
      ? safeDeviceId(input.target_device_id)
      : devices.find(looksLikeReadableDevice)?.device_id || '';
    if (!targetDeviceId) throw Object.assign(new Error('no_reading_device_available'), { status: 404 });
    if (!devices.some((device) => device.device_id === targetDeviceId)) {
      throw Object.assign(new Error('target_device_not_found'), { status: 404 });
    }
    const now = new Date().toISOString();
    const command: CloudDeviceCommand = {
      schema_version: 'inkloop.cloud_device.command.v1',
      command_id: commandId(),
      tenant_id: namespace.tenant_id,
      user_id: namespace.user_id,
      target_device_id: targetDeviceId,
      source_device_id: input.source_device_id ? safeDeviceId(input.source_device_id) : undefined,
      type: input.type,
      payload: {
        uri,
        requested_by: input.requested_by,
        source: String(input.payload?.source || 'obsidian-plugin'),
      },
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    const manifest = await this.readCommandsManifest(namespace);
    const retained = manifest.commands.filter((item) => item.status !== 'acked' || Date.now() - Date.parse(item.updated_at || item.created_at) < 24 * 60 * 60 * 1000);
    retained.push(command);
    await this.writeCommandsManifest(namespace, { ...manifest, commands: retained });
    return command;
  }

  async pullCommands(namespace: CloudDeviceNamespace, deviceId: string): Promise<CloudDeviceCommand[]> {
    const safeId = safeDeviceId(deviceId);
    if (!safeId) throw Object.assign(new Error('device_id_required'), { status: 400 });
    const manifest = await this.readCommandsManifest(namespace);
    const now = new Date().toISOString();
    const commands = manifest.commands.filter((command) =>
      command.target_device_id === safeId && (command.status === 'pending' || command.status === 'delivered'),
    );
    if (!commands.length) return [];
    const commandIds = new Set(commands.map((command) => command.command_id));
    const next = manifest.commands.map((command) => commandIds.has(command.command_id)
      ? { ...command, status: 'delivered' as const, delivered_at: command.delivered_at || now, updated_at: now }
      : command);
    await this.writeCommandsManifest(namespace, { ...manifest, commands: next });
    return next.filter((command) => commandIds.has(command.command_id));
  }

  async ackCommand(namespace: CloudDeviceNamespace, deviceId: string, commandIdValue: string, input: AckCloudDeviceCommandInput): Promise<CloudDeviceCommand> {
    const safeId = safeDeviceId(deviceId);
    if (!safeId) throw Object.assign(new Error('device_id_required'), { status: 400 });
    const manifest = await this.readCommandsManifest(namespace);
    const command = manifest.commands.find((item) => item.command_id === commandIdValue && item.target_device_id === safeId);
    if (!command) throw Object.assign(new Error('command_not_found'), { status: 404 });
    const now = new Date().toISOString();
    const nextCommand: CloudDeviceCommand = {
      ...command,
      status: input.ok === false ? 'failed' : 'acked',
      acked_at: now,
      updated_at: now,
      result: recordObject(input.result),
      error: input.ok === false ? String(input.error || 'command_failed') : undefined,
    };
    await this.writeCommandsManifest(namespace, {
      ...manifest,
      commands: manifest.commands.map((item) => item.command_id === command.command_id ? nextCommand : item),
    });
    return nextCommand;
  }
}
