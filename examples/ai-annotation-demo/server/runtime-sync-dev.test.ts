import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { createRuntimeSyncDevHandler, type RuntimeSyncSessionContext } from './runtime-sync-dev';
import { JsonlRuntimeSyncEventStore } from './runtime-sync-store';

let server: Server | null = null;

function event(id: string): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: id,
    source: 'inkloop_device',
    doc_id: 'doc_runtime_dev',
    operation: 'annotation.add',
    target: { type: 'annotation', id: 'ko_runtime_dev', block_id: 'blk_runtime_dev' },
    payload: {
      block_id: 'blk_runtime_dev',
      annotation: {
        ko_id: 'ko_runtime_dev',
        title: 'Runtime dev mark',
        render_mode: 'stroke_only',
        visual_strokes: [{ tool: 'pen', color: '#38bdf8', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      },
    },
    origin: { device_id: 'web-demo' },
    status: 'pending',
    dedupe_key: id,
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
  };
}

function bootstrapEvent(id: string, contentHash: string): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: id,
    source: 'inkloop_device',
    doc_id: 'doc_bootstrap_loop',
    operation: 'runtime.bootstrap',
    target: { type: 'document', id: 'doc_bootstrap_loop' },
    payload: {
      snapshot: {
        doc_id: 'doc_bootstrap_loop',
        doc_dir: 'indexeddb://doc_bootstrap_loop',
        document: {
          doc_id: 'doc_bootstrap_loop',
          title: 'Bootstrap Loop Demo',
          source_type: 'pdf',
          updated_at: '2026-07-08T00:00:00.000Z',
        },
        source: {
          doc_id: 'doc_bootstrap_loop',
          kind: 'imported_pdf',
          identity: {
            stable_key: 'pdf:file_bootstrap_loop',
            file_hash: 'file_bootstrap_loop',
            current_content_hash: contentHash,
          },
        },
        source_revision: {
          revision_id: `rev_${id}`,
          content_hash: contentHash,
          updated_at: '2026-07-08T00:00:00.000Z',
        },
        blocks: [{
          schema_version: 'inkloop.surface_object.v1',
          object_id: 'blk_bootstrap_loop',
          doc_id: 'doc_bootstrap_loop',
          text: '同一个标记快照',
          projection: {
            block_id: 'blk_bootstrap_loop',
            page_index: 0,
          },
          annotations: [{
            ko_id: 'ko_bootstrap_loop',
            kind: 'markup',
            title: '同一个标记快照',
            render_mode: 'stroke_only',
            visual_bbox: [0.1, 0.2, 0.3, 0.04],
            visual_strokes: [{
              tool: 'pen',
              color: '#1A1A1A',
              points: [
                { x: 0.1, y: 0.22, pressure: 0.12 },
                { x: 0.4, y: 0.22, pressure: 0.12 },
              ],
            }],
            inkloop_mark: {
              mark_id: 'mark_bootstrap_loop',
            },
          }],
        }],
        nodes: [],
      },
    },
    origin: { device_id: 'web-old-tab' },
    status: 'pending',
    dedupe_key: `doc_bootstrap_loop:runtime.bootstrap:${contentHash}`,
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
  };
}

async function start(options: Parameters<typeof createRuntimeSyncDevHandler>[0] | string = {}): Promise<string> {
  const handler = createRuntimeSyncDevHandler(typeof options === 'string' ? { token: options } : options);
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
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

function rawRuntimePush(base: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: Number(url.port),
      path: '/v1/runtime/events:push',
      method: 'POST',
      headers: {
        host: url.host,
        'content-type': 'application/json',
        ...headers,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'web-demo', events: [event('evt_raw')] }));
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe('runtime sync dev handler', () => {
  it('pushes, dedupes, and pulls runtime events by cursor', async () => {
    const base = await start();
    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'web-demo', events: [event('evt_dev_1'), event('evt_dev_1')] }),
    });
    const pushPayload = await pushed.json() as { acks: Array<{ event_id: string; ok: boolean; server_sequence: number }> };

    expect(pushed.status).toBe(200);
    expect(pushPayload.acks).toEqual([
      expect.objectContaining({ event_id: 'evt_dev_1', ok: true, server_sequence: 1 }),
      expect.objectContaining({ event_id: 'evt_dev_1', ok: true, server_sequence: 1 }),
    ]);

    const firstPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };
    const secondPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=${firstPull.next_cursor}`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(firstPull.events.map((item) => item.event_id)).toEqual(['evt_dev_1']);
    expect(firstPull.next_cursor).toBe('1');
    expect(secondPull.events).toEqual([]);
    expect(secondPull.next_cursor).toBe('1');
  });

  it('dedupes equivalent runtime bootstrap snapshots even when volatile source hashes change', async () => {
    let acceptedCount = 0;
    const base = await start({
      onAcceptedEvent() {
        acceptedCount += 1;
      },
    });
    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: 'web-old-tab',
        events: [
          bootstrapEvent('evt_bootstrap_loop_1', 'sha256:volatile_a'),
          bootstrapEvent('evt_bootstrap_loop_2', 'sha256:volatile_b'),
        ],
      }),
    });
    const pushPayload = await pushed.json() as { acks: Array<{ event_id: string; ok: boolean; server_sequence: number }> };
    const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=web-other&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(pushed.status).toBe(200);
    expect(pushPayload.acks).toEqual([
      expect.objectContaining({ event_id: 'evt_bootstrap_loop_1', ok: true, server_sequence: 1 }),
      expect.objectContaining({ event_id: 'evt_bootstrap_loop_2', ok: true, server_sequence: 1 }),
    ]);
    expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_bootstrap_loop_1']);
    expect(pulled.next_cursor).toBe('1');
    expect(acceptedCount).toBe(1);
  });

  it('stores runtime bootstrap as document metadata without replaying embedded annotations', async () => {
    const accepted: RuntimeSyncEvent[] = [];
    const bootstrap = bootstrapEvent('evt_bootstrap_sanitized', 'sha256:bootstrap_sanitized');
    const snapshot = bootstrap.payload.snapshot as { blocks: Array<{ projection?: { knowledge_object_ids?: string[] }; annotations?: unknown[] }> };
    snapshot.blocks[0]!.projection = { ...(snapshot.blocks[0]!.projection ?? {}), knowledge_object_ids: ['ko_bootstrap_loop'] };
    const base = await start({
      onAcceptedEvent(event) {
        accepted.push(event);
      },
    });

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: 'web-old-tab',
        events: [bootstrap],
      }),
    });
    const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=web-other&cursor=0`)).json() as { events: RuntimeSyncEvent[] };
    const pulledSnapshot = pulled.events[0]?.payload.snapshot as { blocks?: Array<{ projection?: { knowledge_object_ids?: string[] }; annotations?: unknown[] }> };
    const acceptedSnapshot = accepted[0]?.payload.snapshot as { blocks?: Array<{ projection?: { knowledge_object_ids?: string[] }; annotations?: unknown[] }> };

    expect(pushed.status).toBe(200);
    expect(pulled.events).toHaveLength(1);
    expect(pulledSnapshot.blocks?.[0]?.annotations).toBeUndefined();
    expect(pulledSnapshot.blocks?.[0]?.projection?.knowledge_object_ids).toBeUndefined();
    expect(acceptedSnapshot.blocks?.[0]?.annotations).toBeUndefined();
    expect(acceptedSnapshot.blocks?.[0]?.projection?.knowledge_object_ids).toBeUndefined();
  });

  it('acks but does not store annotation add events with impossible page-normalized bbox', async () => {
    const valid = event('evt_valid_bbox');
    valid.payload = { ...valid.payload, mark_id: 'mark_valid_bbox', bbox: [0.1, 0.2, 0.3, 0.04] };
    const invalid = event('evt_invalid_bbox');
    invalid.payload = { ...invalid.payload, mark_id: 'mark_invalid_bbox', bbox: [-0.403, -5.222, 1.819, 61.111] };
    const base = await start();

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: 'inkloop.runtime_sync_batch.v1',
        device_id: 'web-demo',
        events: [valid, invalid],
      }),
    });
    const pushPayload = await pushed.json() as { acks: Array<{ event_id: string; ok: boolean; server_sequence: number; ack_id: string; dropped?: boolean; reason?: string }> };
    const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=web-other&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(pushed.status).toBe(200);
    expect(pushPayload.acks).toEqual([
      expect.objectContaining({ event_id: 'evt_valid_bbox', ok: true, server_sequence: 1 }),
      expect.objectContaining({
        event_id: 'evt_invalid_bbox',
        ok: true,
        server_sequence: 1,
        ack_id: 'dev_ack_drop_invalid_annotation_bbox',
        dropped: true,
        reason: 'invalid_page_norm_bbox',
      }),
    ]);
    expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_valid_bbox']);
    expect(pulled.next_cursor).toBe('1');
  });

  it('stores concurrent duplicate pushes once and runs accepted-event side effects without blocking acks', async () => {
    let acceptedCount = 0;
    let releaseSideEffect: (() => void) | null = null;
    let finishSideEffect: (() => void) | null = null;
    let markSideEffectStarted: (() => void) | null = null;
    const sideEffectStarted = new Promise<void>((resolve) => { markSideEffectStarted = resolve; });
    const sideEffectFinished = new Promise<void>((resolve) => { finishSideEffect = resolve; });
    const base = await start({
      async onAcceptedEvent() {
        acceptedCount += 1;
        markSideEffectStarted?.();
        await new Promise<void>((resolve) => { releaseSideEffect = resolve; });
        finishSideEffect?.();
      },
    });
    const body = JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'web-demo', events: [event('evt_concurrent_duplicate')] });
    const headers = { 'content-type': 'application/json' };

    const responses = await withTimeout(Promise.all([
      fetch(`${base}/v1/runtime/events:push`, { method: 'POST', headers, body }),
      fetch(`${base}/v1/runtime/events:push`, { method: 'POST', headers, body }),
      fetch(`${base}/v1/runtime/events:push`, { method: 'POST', headers, body }),
    ]), 1000, 'runtime push responses');
    const payloads = await Promise.all(responses.map((response) => response.json())) as Array<{ acks: Array<{ event_id: string; ok: boolean; server_sequence: number }> }>;
    await sideEffectStarted;
    const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(payloads.every((payload) => payload.acks[0].ok && payload.acks[0].server_sequence === 1)).toBe(true);
    expect(acceptedCount).toBe(1);
    expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_concurrent_duplicate']);
    expect(pulled.next_cursor).toBe('1');
    expect(releaseSideEffect).toBeTypeOf('function');
    const release = releaseSideEffect as (() => void) | null;
    if (!release) throw new Error('accepted-event side effect did not start');
    release();
    await sideEffectFinished;
  });

  it('rejects token-protected endpoints before reading runtime payloads', async () => {
    const base = await start('secret');
    const response = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', events: [event('evt_secret')] }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('unauthorized') });
  });

  it('rejects no-origin LAN-shaped writes when no token is configured', async () => {
    const base = await start();
    const response = await rawRuntimePush(base, { host: '192.168.120.2:8765' });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.stringContaining('loopback') });
  });

  it('keeps runtime events isolated by tenant and user when sessions are required', async () => {
    const sessions = new Map<string, RuntimeSyncSessionContext>([
      ['token_a', { active: true, tenant_id: 'tenant_1', user_id: 'user_a', device_id: 'device_a' }],
      ['token_b', { active: true, tenant_id: 'tenant_1', user_id: 'user_b', device_id: 'device_b' }],
    ]);
    const base = await start({
      requireSession: true,
      resolveSession(req) {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        return sessions.get(token) ?? null;
      },
    });

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token_a' },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'device_a', events: [event('evt_user_a')] }),
    });
    const userAPull = await fetch(`${base}/v1/runtime/events:pull?device_id=device_a&cursor=0`, {
      headers: { authorization: 'Bearer token_a' },
    });
    const userBPull = await fetch(`${base}/v1/runtime/events:pull?device_id=device_b&cursor=0`, {
      headers: { authorization: 'Bearer token_b' },
    });

    expect(pushed.status).toBe(200);
    expect((await userAPull.json() as { events: RuntimeSyncEvent[] }).events.map((item) => item.event_id)).toEqual(['evt_user_a']);
    expect((await userBPull.json() as { events: RuntimeSyncEvent[] }).events).toEqual([]);
  });

  it('uses the default local session for no-origin loopback desktop clients', async () => {
    const base = await start({
      defaultSession: { active: true, tenant_id: 'local', user_id: 'local_demo', device_id: 'desktop-default' },
    });

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://appassets.androidplatform.net',
      },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'paper-device', events: [event('evt_default_local')] }),
    });
    const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(pushed.status).toBe(200);
    expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_default_local']);
    expect(pulled.next_cursor).toBe('1');
  });

  it('allows the debug APK http appassets origin to preflight runtime sync', async () => {
    const base = await start();
    const response = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://appassets.androidplatform.net',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization,x-inkloop-tenant-id,x-inkloop-user-id',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://appassets.androidplatform.net');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('allows LAN web origins to preflight runtime sync', async () => {
    const base = await start();
    const response = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://172.168.21.253:8765',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization,x-inkloop-session,x-inkloop-tenant-id,x-inkloop-user-id,x-inkloop-device-id',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://172.168.21.253:8765');
    expect(response.headers.get('access-control-allow-headers')).toContain('x-inkloop-device-id');
  });

  it('lets explicit tenant and user headers override the local default session', async () => {
    const base = await start({
      defaultSession: { active: true, tenant_id: 'local', user_id: 'local_demo', device_id: 'desktop-default' },
    });

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-inkloop-tenant-id': 'tenant_header_override',
        'x-inkloop-user-id': 'user_header_override',
      },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'paper-device', events: [event('evt_header_override')] }),
    });
    const explicitPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`, {
      headers: {
        'x-inkloop-tenant-id': 'tenant_header_override',
        'x-inkloop-user-id': 'user_header_override',
      },
    })).json() as { events: RuntimeSyncEvent[]; next_cursor: string };
    const defaultPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(pushed.status).toBe(200);
    expect(explicitPull.events.map((item) => item.event_id)).toEqual(['evt_header_override']);
    expect(explicitPull.next_cursor).toBe('1');
    expect(defaultPull.events).toEqual([]);
    expect(defaultPull.next_cursor).toBe('0');
  });

  it('uses explicit tenant and user headers only when no default session is forced', async () => {
    const base = await start();

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-inkloop-tenant-id': 'tenant_header',
        'x-inkloop-user-id': 'user_header_a',
      },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'device_a', events: [event('evt_header_user_a')] }),
    });
    const userAPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=device_a&cursor=0`, {
      headers: {
        'x-inkloop-tenant-id': 'tenant_header',
        'x-inkloop-user-id': 'user_header_a',
      },
    })).json() as { events: RuntimeSyncEvent[]; next_cursor: string };
    const userBEmptyPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=device_b&cursor=0`, {
      headers: {
        'x-inkloop-tenant-id': 'tenant_header',
        'x-inkloop-user-id': 'user_header_b',
      },
    })).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

    expect(pushed.status).toBe(200);
    expect(userAPull.events.map((item) => item.event_id)).toEqual(['evt_header_user_a']);
    expect(userAPull.next_cursor).toBe('1');
    expect(userBEmptyPull.events).toEqual([]);
    expect(userBEmptyPull.next_cursor).toBe('0');
  });

  it('runs accepted-event side effects in the resolved namespace after accepting the event', async () => {
    const sideEffects: Array<{ event_id: string; tenant_id?: string; user_id?: string }> = [];
    const base = await start({
      onAcceptedEvent(event, namespace) {
        sideEffects.push({ event_id: event.event_id, tenant_id: namespace.tenant_id, user_id: namespace.user_id });
      },
    });

    const pushed = await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-inkloop-tenant-id': 'tenant_hook',
        'x-inkloop-user-id': 'user_hook',
      },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'device_hook', events: [event('evt_hook')] }),
    });
    const body = await pushed.json() as { acks: Array<{ event_id: string; ok: boolean }> };

    expect(pushed.status).toBe(200);
    expect(body.acks).toEqual([expect.objectContaining({ event_id: 'evt_hook', ok: true })]);
    expect(sideEffects).toEqual([{ event_id: 'evt_hook', tenant_id: 'tenant_hook', user_id: 'user_hook' }]);
  });

  it('acks and stores runtime events even when an accepted-event side effect fails', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      const base = await start({
        onAcceptedEvent() {
          throw new Error('knowledge_object_not_found');
        },
      });

      const pushed = await fetch(`${base}/v1/runtime/events:push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'device_hook', events: [event('evt_hook_fail')] }),
      });
      const body = await pushed.json() as { acks: Array<{ event_id: string; ok: boolean; server_sequence?: number }> };
      const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=device_hook&cursor=0`)).json() as { events: RuntimeSyncEvent[] };

      expect(pushed.status).toBe(200);
      expect(body.acks).toEqual([expect.objectContaining({ event_id: 'evt_hook_fail', ok: true, server_sequence: 1 })]);
      expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_hook_fail']);
      expect(errors.join('\n')).toContain('knowledge_object_not_found');
    } finally {
      console.error = originalError;
    }
  });

  it('does not advance a user cursor to another namespace latest sequence', async () => {
    const sessions = new Map<string, RuntimeSyncSessionContext>([
      ['token_a', { active: true, tenant_id: 'tenant_1', user_id: 'user_a', device_id: 'device_a' }],
      ['token_b', { active: true, tenant_id: 'tenant_1', user_id: 'user_b', device_id: 'device_b' }],
    ]);
    const base = await start({
      requireSession: true,
      resolveSession(req) {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        return sessions.get(token) ?? null;
      },
    });

    await fetch(`${base}/v1/runtime/events:push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token_a' },
      body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'device_a', events: [event('evt_user_a_cursor')] }),
    });
    const userBEmptyPull = await (await fetch(`${base}/v1/runtime/events:pull?device_id=device_b&cursor=0`, {
      headers: { authorization: 'Bearer token_b' },
    })).json() as { events: RuntimeSyncEvent[]; next_cursor: string; has_more: boolean };

    expect(userBEmptyPull.events).toEqual([]);
    expect(userBEmptyPull.next_cursor).toBe('0');
    expect(userBEmptyPull.has_more).toBe(false);
  });

  it('persists runtime events across handler restarts when backed by JSONL storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-runtime-sync-'));
    const file = join(dir, 'runtime-events.jsonl');
    try {
      const firstBase = await start({ store: new JsonlRuntimeSyncEventStore(file) });
      const pushed = await fetch(`${firstBase}/v1/runtime/events:push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: 'inkloop.runtime_sync_batch.v1', device_id: 'web-demo', events: [event('evt_persisted')] }),
      });
      expect(pushed.status).toBe(200);
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = null;

      const secondBase = await start({ store: new JsonlRuntimeSyncEventStore(file) });
      const pulled = await (await fetch(`${secondBase}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

      expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_persisted']);
      expect(pulled.next_cursor).toBe('1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dedupes duplicate JSONL records on startup while keeping the latest sequence cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-runtime-sync-'));
    const file = join(dir, 'runtime-events.jsonl');
    try {
      await writeFile(file, [
        JSON.stringify({ sequence: 1, event: event('evt_jsonl_dup') }),
        JSON.stringify({ sequence: 2, event: event('evt_jsonl_other') }),
        JSON.stringify({ sequence: 3, event: event('evt_jsonl_dup') }),
      ].join('\n') + '\n', 'utf8');
      const base = await start({ store: new JsonlRuntimeSyncEventStore(file) });
      const pulled = await (await fetch(`${base}/v1/runtime/events:pull?device_id=obsidian-plugin&cursor=0`)).json() as { events: RuntimeSyncEvent[]; next_cursor: string };

      expect(pulled.events.map((item) => item.event_id)).toEqual(['evt_jsonl_other', 'evt_jsonl_dup']);
      expect(pulled.next_cursor).toBe('3');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
