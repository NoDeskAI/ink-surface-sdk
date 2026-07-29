import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MeetingAudioChunk, MeetingUtterance } from '../../../../packages/meeting-media-core/src/index';
import {
  StreamingAsrProviderRouter,
  type FormalTranscriptConverger,
  type StreamingAsrProvider,
} from './provider';
import { createMeetingMediaService, MeetingMediaStreamingIngress } from './streaming-ingress';

const identity = { tenant_id: 'tenant', user_id: 'user' };
const sessionId = 'session-1';
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function fixture(track: 'mic' | 'remote', sequence: number, text = `${track}:${sequence}`) {
  const audio = Buffer.from(text);
  const chunk: MeetingAudioChunk = {
    schema_version: 'inkloop.meeting_audio_chunk.v1',
    chunk_id: `${sessionId}:${track}:${sequence}`,
    session_id: sessionId,
    track,
    sequence,
    start_monotonic_ms: sequence * 1_000,
    end_monotonic_ms: sequence * 1_000 + 999,
    checksum: `sha256:${createHash('sha256').update(audio).digest('hex')}`,
    byte_length: audio.length,
    sealed: true,
  };
  return { ...identity, chunk, audio };
}

function ingress(provider: StreamingAsrProvider, autoProcess = false, options: {
  now?: () => number;
  provider_timeout_ms?: number;
  realtime_provider_timeout_ms?: number;
  provider_max_attempts?: number;
  provider_retry_base_ms?: number;
  recorder_lease_required?: boolean;
  formal_converger?: FormalTranscriptConverger;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meeting-media-'));
  return {
    root,
    value: new MeetingMediaStreamingIngress({
      root,
      providers: new StreamingAsrProviderRouter({}, provider),
      auto_process: autoProcess,
      now: options.now || (() => 123),
      provider_timeout_ms: options.provider_timeout_ms,
      realtime_provider_timeout_ms: options.realtime_provider_timeout_ms,
      provider_max_attempts: options.provider_max_attempts,
      provider_retry_base_ms: options.provider_retry_base_ms,
      recorder_lease_required: options.recorder_lease_required,
      formal_converger: options.formal_converger,
    }),
  };
}

describe('meeting media streaming ingress', () => {
  it('grants a single recorder lease per meeting occurrence and supports renewal and handoff', async () => {
    let now = 1_000;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider, false, { now: () => now });

    const first = await value.acquireRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: 'session-device-a', device_id: 'device-a',
    });
    expect(first).toMatchObject({ granted: true, owner_session_id: 'session-device-a', expires_at_ms: 31_000 });
    expect(first.lease_token).toBeTruthy();

    const competing = await value.acquireRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: 'session-device-b', device_id: 'device-b',
    });
    expect(competing).toMatchObject({
      granted: false, owner_session_id: 'session-device-a', owner_device_id: 'device-a', retry_after_ms: 30_000,
    });
    expect(competing).not.toHaveProperty('lease_token');

    now = 5_000;
    const renewed = await value.renewRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: 'session-device-a', device_id: 'device-a',
      lease_token: first.lease_token!,
    });
    expect(renewed).toMatchObject({ granted: true, expires_at_ms: 35_000, lease_token: first.lease_token });

    await expect(value.releaseRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: 'session-device-a', device_id: 'device-a',
      lease_token: first.lease_token!,
    })).resolves.toMatchObject({ released: true });
    await expect(value.acquireRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: 'session-device-b', device_id: 'device-b',
    })).resolves.toMatchObject({ granted: true, owner_session_id: 'session-device-b' });
  });

  it('allows exactly one concurrent recorder claimant and permits takeover only after expiry', async () => {
    let now = 1_000;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider, false, { now: () => now });
    const claims = await Promise.all(['a', 'b', 'c'].map(async (suffix) => await value.acquireRecorderLease(identity, {
      meeting_ref: 'zoom:987654321', session_id: `session-${suffix}`, device_id: `device-${suffix}`, ttl_ms: 15_000,
    })));
    expect(claims.filter((claim) => claim.granted)).toHaveLength(1);

    now = 16_001;
    await expect(value.acquireRecorderLease(identity, {
      meeting_ref: 'zoom:987654321', session_id: 'session-takeover', device_id: 'device-takeover', ttl_ms: 15_000,
    })).resolves.toMatchObject({ granted: true, owner_session_id: 'session-takeover' });
  });

  it('arbitrates recorder ownership across users in the same tenant and isolates other tenants', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await expect(value.acquireRecorderLease({ tenant_id: 'tenant', user_id: 'alice' }, {
      meeting_ref: 'google_meet:shared-room-abc', session_id: 'session-alice', device_id: 'alice-mac',
    })).resolves.toMatchObject({ granted: true, owner_session_id: 'session-alice' });
    await expect(value.acquireRecorderLease({ tenant_id: 'tenant', user_id: 'bob' }, {
      meeting_ref: 'google_meet:shared-room-abc', session_id: 'session-bob', device_id: 'bob-mac',
    })).resolves.toMatchObject({ granted: false, owner_session_id: 'session-alice' });
    await expect(value.acquireRecorderLease({ tenant_id: 'other-tenant', user_id: 'bob' }, {
      meeting_ref: 'google_meet:shared-room-abc', session_id: 'session-other', device_id: 'bob-mac',
    })).resolves.toMatchObject({ granted: true, owner_session_id: 'session-other' });
  });

  it('binds recorder device claims to the authenticated session device', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await expect(value.acquireRecorderLease({ ...identity, device_id: 'authenticated-mac' }, {
      meeting_ref: 'zoom:123456789', session_id: sessionId, device_id: 'spoofed-mac',
    })).rejects.toThrow('meeting_media_recorder_device_mismatch');
  });

  it('rejects unowned session and chunk writes when recorder leases are required', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider, false, { recorder_lease_required: true });

    await expect(value.registerSession(identity, {
      session_id: sessionId, platform: 'google_meet', meeting_ref: 'google_meet:abc-defg-hij', status: 'recording',
    })).rejects.toThrow('meeting_media_recorder_lease_required');
    await expect(value.ingest(fixture('mic', 0))).rejects.toThrow('meeting_media_recorder_lease_required');
  });

  it('does not mistake the tenant recorder-lease directory for a media session', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await value.acquireRecorderLease(identity, {
      meeting_ref: 'zoom:123456789', session_id: sessionId, device_id: 'device-a',
    });

    await expect(value.latestSessionId(identity)).resolves.toBeNull();
    await expect(value.liveStatus(identity)).resolves.toMatchObject({ session_id: null, active: false });
  });

  it('prefers an active scope over newer transcript or delivery mtimes from a sealed session', async () => {
    let now = 1_000;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value, root } = ingress(provider, false, { now: () => now });
    await value.registerSession(identity, {
      session_id: 'active-session',
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'recording',
    });
    now = 2_000;
    await value.registerSession(identity, {
      session_id: 'sealed-session',
      platform: 'zoom',
      meeting_ref: 'zoom:123456789',
      status: 'sealed',
    });
    const sealedDirectory = resolve(
      root,
      Buffer.from(identity.tenant_id).toString('base64url'),
      Buffer.from(identity.user_id).toString('base64url'),
      Buffer.from('sealed-session').toString('base64url'),
    );
    writeFileSync(resolve(sealedDirectory, 'transcript.json'), JSON.stringify({
      schema_version: 'inkloop.meeting_transcript.v1',
      session_id: 'sealed-session',
      status: 'provisional',
      revision: 1,
      utterances: [],
    }));

    await expect(value.latestSessionId(identity)).resolves.toBe('active-session');
    await expect(value.liveStatus(identity)).resolves.toMatchObject({
      session_id: 'active-session',
      active: true,
      meeting_ref: 'google_meet:abc-defg-hij',
    });
  });

  it('orders inactive sessions by scope updated_at instead of filesystem mtime', async () => {
    let now = 2_000;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value, root } = ingress(provider, false, { now: () => now });
    await value.registerSession(identity, {
      session_id: 'logical-latest',
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'sealed',
    });
    now = 1_000;
    await value.registerSession(identity, {
      session_id: 'mtime-latest',
      platform: 'zoom',
      meeting_ref: 'zoom:123456789',
      status: 'sealed',
    });
    const newerMtimeDirectory = resolve(
      root,
      Buffer.from(identity.tenant_id).toString('base64url'),
      Buffer.from(identity.user_id).toString('base64url'),
      Buffer.from('mtime-latest').toString('base64url'),
    );
    writeFileSync(resolve(newerMtimeDirectory, 'delivery.json'), JSON.stringify({ chunks: {} }));

    await expect(value.latestSessionId(identity)).resolves.toBe('logical-latest');
  });

  it('requires the active recorder lease when a claimed session is registered', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    const lease = await value.acquireRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: sessionId, device_id: 'device-a',
    });

    await expect(value.registerSession(identity, {
      session_id: sessionId, platform: 'google_meet', meeting_ref: 'google_meet:abc-defg-hij', status: 'recording',
      recorder_device_id: 'device-a', recorder_lease_token: 'wrong-token',
    })).rejects.toThrow('meeting_media_recorder_lease_invalid');
    await expect(value.registerSession(identity, {
      session_id: sessionId, platform: 'google_meet', meeting_ref: 'google_meet:abc-defg-hij', status: 'recording',
      recorder_device_id: 'device-a', recorder_lease_token: lease.lease_token,
    })).resolves.toMatchObject({ recorder_device_id: 'device-a' });
  });

  it('enforces recorder ownership through HTTP and keeps the lease alive with chunk traffic', async () => {
    let now = 1_000;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider, false, { now: () => now });
    const handler = createMeetingMediaService({
      ingress: value,
      readBody: async (req) => await new Promise<string>((resolveBody) => {
        let body = '';
        req.on('data', (part) => { body += part; });
        req.on('end', () => resolveBody(body));
      }),
      resolveIdentity: async () => identity,
    });
    const server = createServer(async (req, res) => {
      if (!await handler(req, res)) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    closers.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const claim = await call(`${base}/api/meeting-media/recorder-lease/acquire`, 'POST', {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: sessionId, device_id: 'device-a', ttl_ms: 15_000,
    });
    expect(claim).toMatchObject({ status: 200, json: { granted: true, owner_device_id: 'device-a' } });

    const chunk = fixture('mic', 0);
    now = 10_000;
    expect(await call(`${base}/api/meeting-media/chunks`, 'POST', {
      chunk: chunk.chunk,
      audio_base64: Buffer.from(chunk.audio).toString('base64'),
      meeting_ref: 'google_meet:abc-defg-hij',
      recorder_device_id: 'device-a',
      recorder_lease_token: claim.json.lease_token,
    })).toMatchObject({ status: 202 });
    now = 16_500;
    expect(await call(`${base}/api/meeting-media/recorder-lease/acquire`, 'POST', {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: 'session-b', device_id: 'device-b', ttl_ms: 15_000,
    })).toMatchObject({ status: 200, json: { granted: false, owner_session_id: sessionId } });

    expect(await call(`${base}/api/meeting-media/chunks`, 'POST', {
      chunk: fixture('remote', 0).chunk,
      audio_base64: Buffer.from(fixture('remote', 0).audio).toString('base64'),
      meeting_ref: 'google_meet:abc-defg-hij',
      recorder_device_id: 'device-b',
      recorder_lease_token: 'not-the-owner',
    })).toMatchObject({ status: 409, json: { error: { code: 'meeting_media_recorder_lease_invalid' } } });
  });

  it('persists out-of-order chunks before ACK and replays idempotently', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { root, value } = ingress(provider);
    await value.ingest(fixture('remote', 2));
    const first = await value.ingest(fixture('mic', 0));
    const replay = await value.ingest(fixture('mic', 0));

    expect(first).toMatchObject({ replay: false, acknowledgement: { acknowledged_at_ms: 123, track: 'mic', sequence: 0 } });
    expect(replay.replay).toBe(true);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    expect(readFileSync(resolve(scoped, 'raw/mic/00000000.audio'), 'utf8')).toBe('mic:0');
    expect(statSync(resolve(scoped, 'raw/mic/00000000.audio')).mode & 0o777).toBe(0o600);
    const outbox = JSON.parse(readFileSync(resolve(scoped, 'provider-outbox.json'), 'utf8'));
    expect(outbox.pending).toHaveProperty(`${sessionId}:mic:0`);
    expect(outbox.identity).toEqual(identity);
    expect(readFileSync(resolve(scoped, 'provider-outbox.json')).byteLength).toBeLessThan(10_000);
    expect(JSON.parse(readFileSync(resolve(scoped, 'delivery.json'), 'utf8')).acknowledgements).toHaveProperty('mic:0');
  });

  it('persists session telemetry for ACK durability, Provider retries, ASR drain, and formalization', async () => {
    let now = 1_000;
    let attempts = 0;
    const provider: StreamingAsrProvider = {
      provider_id: 'telemetry-provider',
      async transcribeChunk(input) {
        attempts += 1;
        if (attempts === 1) throw new Error('provider_busy');
        return [{
          utterance_id: 'utt-telemetry', session_id: sessionId, track: input.chunk.track,
          start_ms: 0, end_ms: 500, text: 'telemetry ready', revision: 1,
          stability: 'provisional', source_chunk_ids: [input.chunk.chunk_id],
        }];
      },
    };
    const { value } = ingress(provider, false, { now: () => now });
    await value.registerSession(identity, {
      session_id: sessionId, platform: 'google_meet', meeting_ref: 'google_meet:telemetry-room', status: 'recording',
    });
    now = 1_100;
    await value.ingest(fixture('mic', 0));
    now = 1_200;
    await value.drainProvider(identity, sessionId);
    now = 2_500;
    await value.drainProvider(identity, sessionId);
    now = 2_600;
    await value.finalizeSession({
      identity, session_id: sessionId, expected_tracks: ['mic'], expected_last_sequence: { mic: 0 },
    });

    const telemetry = await value.sessionTelemetry(identity, sessionId);
    expect(telemetry).toMatchObject({
      schema_version: 'inkloop.meeting_media_telemetry.v1',
      registered_at_ms: 1_000,
      first_chunk_received_at_ms: 1_100,
      last_chunk_acknowledged_at_ms: 1_100,
      acknowledgement_count: 1,
      replay_count: 0,
      peak_pending_chunk_count: 1,
      provider_attempt_count: 2,
      provider_failure_count: 1,
      provider_timeout_count: 0,
      first_provisional_at_ms: 2_500,
      asr_drained_at_ms: 2_500,
      formalized_at_ms: 2_600,
    });
    expect(telemetry.ack_persist_duration_ms).toHaveLength(1);
    expect(telemetry.provider_duration_ms).toHaveLength(2);
    expect(telemetry.ack_persist_duration_ms[0]).toBeGreaterThanOrEqual(0);
  });

  it('keeps corrupt telemetry strictly out of the authoritative ACK and ASR path', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { root, value } = ingress(provider);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    mkdirSync(scoped, { recursive: true });
    writeFileSync(resolve(scoped, 'telemetry.json'), '{not-json');

    await expect(value.ingest(fixture('mic', 0))).resolves.toMatchObject({
      replay: false,
      acknowledgement: { chunk_id: `${sessionId}:mic:0` },
    });
    await expect(value.drainProvider(identity, sessionId)).resolves.toBeUndefined();
    await expect(value.sessionTelemetry(identity, sessionId)).resolves.toMatchObject({
      acknowledgement_count: 1,
      provider_attempt_count: 1,
    });
  });

  it('removes legacy request payloads from the durable outbox identity during restart recovery', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { root, value } = ingress(provider);
    const input = fixture('mic', 0);
    await value.ingest(input);
    await value.drainProvider(identity, sessionId);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    const path = resolve(scoped, 'provider-outbox.json');
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    legacy.identity = { ...identity, chunk: input.chunk, audio: { 0: 1, 1: 2 } };
    writeFileSync(path, JSON.stringify(legacy));

    const restarted = new MeetingMediaStreamingIngress({
      root,
      providers: new StreamingAsrProviderRouter({}, provider),
      auto_process: false,
    });
    await expect(restarted.bootstrapPending()).resolves.toBe(0);

    expect(JSON.parse(readFileSync(path, 'utf8')).identity).toEqual(identity);
  });

  it('deletes raw media independently while retaining the transcript lifecycle', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { root, value } = ingress(provider);
    await value.ingest(fixture('mic', 0));
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    await expect(value.deleteRawMedia(identity, sessionId)).resolves.toEqual({ deleted: true });
    expect(existsSync(resolve(scoped, 'raw'))).toBe(false);
    expect(existsSync(resolve(scoped, 'delivery.json'))).toBe(true);
    expect(Object.keys((await value.providerOutbox(identity, sessionId)).pending)).toHaveLength(0);
    expect(await value.rawMediaLifecycle(identity, sessionId)).toMatchObject({
      status: 'deleted',
      reason: 'user_requested',
      abandoned_chunk_ids: [`${sessionId}:mic:0`],
    });
    const replay = await value.ingest(fixture('mic', 0));
    expect(replay.replay).toBe(true);
    expect(existsSync(resolve(scoped, 'raw'))).toBe(false);
    await expect(value.ingest(fixture('mic', 1))).rejects.toThrow('meeting_media_raw_media_deleted');
    expect(existsSync(resolve(scoped, 'raw'))).toBe(false);
  });

  it('tombstones a whole meeting before deleting cloud sessions and blocks offline resurrection', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { root, value } = ingress(provider);
    const lease = await value.acquireRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij', session_id: sessionId, device_id: 'device-a',
    });
    await value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'sealed',
      recorder_device_id: 'device-a',
      recorder_lease_token: lease.lease_token,
    });
    await value.ingest({
      ...fixture('mic', 0),
      meeting_ref: 'google_meet:abc-defg-hij',
      recorder_device_id: 'device-a',
      recorder_lease_token: lease.lease_token,
    });

    const deleted = await value.deleteMeetingEvidence(identity, 'mtgdoc_abc-defg-hij');

    expect(deleted).toMatchObject({ cloud_sessions_deleted: 1, pending_companion: true });
    expect(deleted.command).toMatchObject({
      meeting_doc_id: 'mtgdoc_abc-defg-hij',
      meeting_refs: ['google_meet:abc-defg-hij'],
      required_device_ids: ['device-a'],
    });
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    expect(existsSync(scoped)).toBe(false);
    await expect(value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'sealed',
      recorder_device_id: 'device-a',
      recorder_lease_token: lease.lease_token,
    })).rejects.toThrow('meeting_media_session_deleted');
    await expect(value.ingest(fixture('mic', 0))).rejects.toThrow('meeting_media_session_deleted');
    await expect(value.finalizeSession({ identity, session_id: sessionId, expected_tracks: ['mic'], expected_last_sequence: { mic: 0 } })).rejects.toThrow('meeting_media_session_deleted');

    const commands = await value.pendingMeetingDeletionCommands({ ...identity, device_id: 'device-a' }, 'device-a');
    expect(commands).toHaveLength(1);
    await value.acknowledgeMeetingDeletion({ ...identity, device_id: 'device-a' }, {
      command_id: deleted.command.command_id,
      device_id: 'device-a',
      deleted_session_ids: [sessionId],
    });
    await expect(value.pendingMeetingDeletionCommands({ ...identity, device_id: 'device-a' }, 'device-a')).resolves.toEqual([]);
    await expect(value.deleteMeetingEvidence(identity, 'mtgdoc_abc-defg-hij')).resolves.toMatchObject({ cloud_sessions_deleted: 0, pending_companion: false });
  });

  it('serializes concurrent whole-meeting deletion into one durable command', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:concurrent-delete',
      status: 'sealed',
    });

    const [left, right] = await Promise.all([
      value.deleteMeetingEvidence(identity, 'mtgdoc_concurrent-delete'),
      value.deleteMeetingEvidence(identity, 'mtgdoc_concurrent-delete'),
    ]);

    expect(left.command.command_id).toBe(right.command.command_id);
    expect(left.cloud_sessions_deleted + right.cloud_sessions_deleted).toBe(1);
    expect(left.command.requested_at_ms).toBe(right.command.requested_at_ms);
  });

  it('deletes the authorized provider occurrence recorded by another user in the tenant', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    const recorder = { tenant_id: 'tenant', user_id: 'alice', device_id: 'alice-mac' };
    const requester = { tenant_id: 'tenant', user_id: 'bob', device_id: 'bob-web' };
    const lease = await value.acquireRecorderLease(recorder, {
      meeting_ref: 'google_meet:tenant-shared-room', session_id: 'session-alice', device_id: 'alice-mac',
    });
    await value.registerSession(recorder, {
      session_id: 'session-alice', platform: 'google_meet', meeting_ref: 'google_meet:tenant-shared-room',
      status: 'sealed', started_at_ms: 1_000_000, ended_at_ms: 1_060_000,
      recorder_device_id: 'alice-mac', recorder_lease_token: lease.lease_token,
    });

    const deleted = await value.deleteMeetingEvidence(requester, 'mtgdoc_bob-local-id', {
      meeting_refs: ['google_meet:tenant-shared-room'],
      occurrence_started_at_ms: 1_000_000,
      occurrence_ended_at_ms: 1_060_000,
    });

    expect(deleted).toMatchObject({ cloud_sessions_deleted: 1, pending_companion: true });
    await expect(value.pendingMeetingDeletionCommands(recorder, 'alice-mac')).resolves.toHaveLength(1);
    await expect(value.registerSession(recorder, {
      session_id: 'session-same-occurrence', platform: 'google_meet', meeting_ref: 'google_meet:tenant-shared-room',
      status: 'sealed', started_at_ms: 1_000_000, ended_at_ms: 1_060_000,
    })).rejects.toThrow('meeting_media_meeting_deleted');
    await expect(value.registerSession(recorder, {
      session_id: 'session-next-occurrence', platform: 'google_meet', meeting_ref: 'google_meet:tenant-shared-room',
      status: 'sealed', started_at_ms: 605_800_000, ended_at_ms: 605_860_000,
    })).resolves.toMatchObject({ session_id: 'session-next-occurrence' });
  });

  it('lets a previously unknown offline Companion claim a matching deletion command', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    const deleted = await value.deleteMeetingEvidence(identity, 'mtgdoc_local-card', {
      meeting_refs: ['zoom:987654321'],
      occurrence_started_at_ms: 2_000_000,
    });
    expect(deleted.pending_companion).toBe(true);

    await expect(value.pendingMeetingDeletionCommands(
      { ...identity, device_id: 'offline-mac' }, 'offline-mac', ['zoom:987654321'],
    )).resolves.toEqual([expect.objectContaining({ command_id: deleted.command.command_id })]);
    await value.acknowledgeMeetingDeletion({ ...identity, device_id: 'offline-mac' }, {
      command_id: deleted.command.command_id, device_id: 'offline-mac', deleted_session_ids: ['offline-session'],
    });
    await expect(value.deleteMeetingEvidence(identity, 'mtgdoc_local-card', {
      meeting_refs: ['zoom:987654321'],
    })).resolves.toMatchObject({ pending_companion: false });
  });

  it('migrates legacy user-scoped deletion commands before an offline Companion polls', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { root, value } = ingress(provider);
    const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
    const legacyDirectory = resolve(root, encoded(identity.tenant_id), encoded(identity.user_id), '.meeting-deletions');
    const tenantDirectory = resolve(root, encoded(identity.tenant_id), '.meeting-deletions');
    const command = {
      schema_version: 'inkloop.meeting_deletion_command.v1',
      command_id: 'meeting_delete_legacy',
      meeting_doc_id: 'mtgdoc_legacy-room',
      meeting_refs: ['google_meet:legacy-room'],
      required_device_ids: [],
      requested_at_ms: 100,
      occurrence_started_at_ms: 2_000_000,
      device_acknowledgements: {},
    };
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyPath = resolve(legacyDirectory, `${encoded(command.meeting_doc_id)}.json`);
    writeFileSync(legacyPath, `${JSON.stringify(command)}\n`);

    await expect(value.pendingMeetingDeletionCommands(
      { ...identity, device_id: 'offline-mac' },
      'offline-mac',
      [{ meeting_ref: 'google_meet:legacy-room', started_at_ms: 2_000_000 }],
    )).resolves.toEqual([expect.objectContaining({ command_id: command.command_id })]);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(resolve(tenantDirectory, `${encoded(command.meeting_doc_id)}.json`))).toBe(true);
    await expect(value.acknowledgeMeetingDeletion({ ...identity, device_id: 'offline-mac' }, {
      command_id: command.command_id,
      device_id: 'offline-mac',
      deleted_session_ids: ['legacy-local-session'],
    })).resolves.toMatchObject({
      device_acknowledgements: { 'offline-mac': { deleted_session_ids: ['legacy-local-session'] } },
    });
  });

  it('refuses to delete an actively recording meeting', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await value.registerSession(identity, {
      session_id: sessionId,
      platform: 'zoom',
      meeting_ref: 'zoom:123456789',
      status: 'recording',
    });
    await expect(value.deleteMeetingEvidence(identity, 'mtgdoc_123456789')).rejects.toThrow('meeting_media_active_meeting_cannot_delete');
  });

  it('reconverges as partial when privacy deletion abandons pending ASR chunks', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'offline',
      async transcribeChunk() { throw new Error('offline'); },
    };
    const { value } = ingress(provider);
    await value.ingest(fixture('mic', 0));
    await value.ingest(fixture('remote', 0));
    await value.drainProvider(identity, sessionId);
    const notified: Array<{ finality: string; missing: string[] }> = [];
    value.setFormalTranscriptHandler(async ({ artifact }) => {
      notified.push({ finality: artifact.finality, missing: artifact.missing_chunk_ids });
    });
    const request = {
      session_id: sessionId,
      meeting_id: 'privacy-delete',
      expected_tracks: ['mic', 'remote'] as Array<'mic' | 'remote'>,
      expected_last_sequence: { mic: 0, remote: 0 },
    };
    const initial = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: request.expected_tracks,
      expected_last_sequence: request.expected_last_sequence,
      request,
    });
    expect(initial.artifact.finality).toBe('partial');

    await value.deleteRawMedia(identity, sessionId);

    const converged = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: request.expected_tracks,
      expected_last_sequence: request.expected_last_sequence,
      request,
    });
    expect(converged.artifact).toMatchObject({
      finality: 'partial',
      missing_chunk_ids: [`${sessionId}:mic:0`, `${sessionId}:remote:0`],
    });
    expect(notified.at(-1)).toEqual({
      finality: 'partial',
      missing: [`${sessionId}:mic:0`, `${sessionId}:remote:0`],
    });
  });

  it('automatically deletes server raw audio after terminal formal convergence', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'terminal',
      async transcribeChunk({ chunk }) {
        return [{
          utterance_id: `u-${chunk.track}`,
          session_id: sessionId,
          track: chunk.track,
          start_ms: chunk.start_monotonic_ms,
          end_ms: chunk.end_monotonic_ms,
          text: chunk.track,
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    const { root, value } = ingress(provider);
    await value.ingest(fixture('mic', 0));
    await value.ingest(fixture('remote', 0));
    await value.drainProvider(identity, sessionId);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));

    const finalized = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic', 'remote'],
      expected_last_sequence: { mic: 0, remote: 0 },
    });

    expect(finalized.artifact.finality).toBe('final');
    expect(existsSync(resolve(scoped, 'formal-transcript.json'))).toBe(true);
    expect(existsSync(resolve(scoped, 'raw'))).toBe(false);
    expect(await value.rawMediaLifecycle(identity, sessionId)).toMatchObject({
      status: 'deleted',
      reason: 'formal_transcript_terminal',
    });
  });

  it('uses the formal raw-audio convergence result before deleting server media', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'noisy-live',
      async transcribeChunk({ chunk }) {
        return [{
          utterance_id: `noisy-${chunk.track}`,
          session_id: sessionId,
          track: chunk.track,
          start_ms: chunk.start_monotonic_ms,
          end_ms: chunk.end_monotonic_ms,
          text: '中文字幕志愿者 杨栋梁',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    const formal_converger: FormalTranscriptConverger = {
      converger_id: 'formal-test-v1',
      async converge({ chunks }) {
        return [{
          utterance_id: 'formal-clean',
          session_id: sessionId,
          track: 'mic',
          start_ms: 0,
          end_ms: 999,
          text: '正式结果',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunks[0].chunk.chunk_id],
        }];
      },
    };
    const { root, value } = ingress(provider, false, { formal_converger });
    await value.ingest(fixture('mic', 0));
    await value.drainProvider(identity, sessionId);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));

    const finalized = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic'],
      expected_last_sequence: { mic: 0 },
    });

    expect(finalized.artifact.raw_utterances.map((value) => value.text)).toEqual(['正式结果']);
    expect(existsSync(resolve(scoped, 'raw'))).toBe(false);
  });

  it('replays the persisted formal result after raw deletion without falling back to provisional text', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'noisy-live',
      async transcribeChunk({ chunk }) {
        return [{
          utterance_id: 'noisy-live',
          session_id: sessionId,
          track: chunk.track,
          start_ms: chunk.start_monotonic_ms,
          end_ms: chunk.end_monotonic_ms,
          text: '实时临时错误',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    let convergenceCalls = 0;
    const formal_converger: FormalTranscriptConverger = {
      converger_id: 'formal-replay-test-v1',
      async converge({ chunks }) {
        convergenceCalls += 1;
        return [{
          utterance_id: 'formal-clean',
          session_id: sessionId,
          track: 'mic',
          start_ms: 0,
          end_ms: 999,
          text: '正式收敛结果',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunks[0].chunk.chunk_id],
        }];
      },
    };
    const { value } = ingress(provider, false, { formal_converger });
    await value.ingest(fixture('mic', 0));
    await value.drainProvider(identity, sessionId);

    const first = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic'],
      expected_last_sequence: { mic: 0 },
    });
    const replay = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic'],
      expected_last_sequence: { mic: 0 },
    });

    expect(convergenceCalls).toBe(1);
    expect(replay).toMatchObject({
      replay: true,
      convergence_fingerprint: first.convergence_fingerprint,
    });
    expect(replay.artifact.raw_utterances.map((value) => value.text)).toEqual(['正式收敛结果']);
  });

  it('accepts ordered ephemeral realtime frames without persisting them as raw fact chunks', async () => {
    const seen: number[] = [];
    const provider: StreamingAsrProvider = {
      provider_id: 'streaming-frame-test',
      async transcribeChunk({ chunk }) {
        seen.push(chunk.sequence);
        return [{
          utterance_id: 'live-mic-0',
          session_id: sessionId,
          track: 'mic',
          start_ms: 0,
          end_ms: chunk.end_monotonic_ms,
          text: chunk.sequence === 0 ? '实时' : '实时字幕',
          revision: chunk.sequence + 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    const { root, value } = ingress(provider);
    const pcm = Buffer.alloc(3_200);
    const frame = (sequence: number) => ({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1' as const,
        frame_id: `${sessionId}:mic:frame:${sequence}`,
        session_id: sessionId,
        track: 'mic' as const,
        frame_sequence: sequence,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: sequence * 100,
        end_monotonic_ms: (sequence + 1) * 100,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1 as const,
        speech_present: true,
      },
      audio: pcm,
    });

    await value.ingestRealtimeFrame(frame(0));
    await value.ingestRealtimeFrame(frame(1));
    await value.ingestRealtimeFrame(frame(1));

    expect(seen).toEqual([0, 1]);
    expect((await value.transcript(identity, sessionId)).utterances).toEqual([
      expect.objectContaining({ text: '实时字幕', revision: 2 }),
    ]);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    expect(existsSync(resolve(scoped, 'raw'))).toBe(false);
  });

  it('serializes concurrent realtime frames before invoking a stateful provider', async () => {
    const seen: number[] = [];
    let releaseFirst = (): void => {};
    let signalFirstStarted = (): void => {};
    const firstPending = new Promise<void>((resolveFirst) => {
      releaseFirst = resolveFirst;
    });
    const firstStarted = new Promise<void>((resolveStarted) => {
      signalFirstStarted = resolveStarted;
    });
    const provider: StreamingAsrProvider = {
      provider_id: 'streaming-order-test',
      async transcribeChunk({ chunk }) {
        seen.push(chunk.sequence);
        if (chunk.sequence === 0) {
          signalFirstStarted();
          await firstPending;
        }
        return [];
      },
    };
    const { value } = ingress(provider);
    const frame = (sequence: number) => value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1' as const,
        frame_id: `${sessionId}:mic:frame:${sequence}`,
        session_id: sessionId,
        track: 'mic' as const,
        frame_sequence: sequence,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: sequence * 100,
        end_monotonic_ms: (sequence + 1) * 100,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1 as const,
        speech_present: true,
      },
      audio: Buffer.alloc(3_200),
    });

    const first = frame(0);
    await firstStarted;
    const second = frame(1);
    expect(seen).toEqual([0]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(seen).toEqual([0, 1]);
  });

  it('records the actual realtime provider identity, frame coverage, and model latency', async () => {
    let now = 1_000;
    const provider: StreamingAsrProvider = {
      provider_id: 'openai-compatible:buffered:127.0.0.1:large-v3-turbo',
      async transcribeChunk({ chunk }) {
        return [{
          utterance_id: 'live-mic-window-0',
          session_id: sessionId,
          track: 'mic',
          start_ms: 0,
          end_ms: chunk.end_monotonic_ms,
          text: '模型可观测',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    const { value } = ingress(provider, false, { now: () => now });
    now = 1_100;
    await value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1',
        frame_id: `${sessionId}:mic:frame:0`,
        session_id: sessionId,
        track: 'mic',
        frame_sequence: 0,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: 0,
        end_monotonic_ms: 100,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        audio_derivation: 'apple_voice_processing',
      },
      audio: Buffer.alloc(3_200),
    });

    const telemetry = await value.sessionTelemetry(identity, sessionId);
    expect(telemetry).toMatchObject({
      realtime_frame_count: 1,
      realtime_audio_duration_ms: 100,
      realtime_provider_ids: {
        mic: 'openai-compatible:buffered:127.0.0.1:large-v3-turbo',
      },
      realtime_audio_derivations: {
        mic: 'apple_voice_processing',
      },
      first_provisional_at_ms: 1_100,
    });
    expect(telemetry.realtime_provider_duration_ms).toHaveLength(1);
  });

  it('requires the active recorder lease for realtime frames when ownership is enabled', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'realtime-lease-test',
      async transcribeChunk() { return []; },
    };
    const { value } = ingress(provider, false, { recorder_lease_required: true });
    const pcm = Buffer.alloc(3_200);
    const frame = {
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1' as const,
        frame_id: `${sessionId}:mic:frame:0`,
        session_id: sessionId,
        track: 'mic' as const,
        frame_sequence: 0,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: 0,
        end_monotonic_ms: 100,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1 as const,
        speech_present: true,
      },
      audio: pcm,
    };

    await expect(value.ingestRealtimeFrame(frame)).rejects.toThrow('meeting_media_recorder_lease_required');
    const lease = await value.acquireRecorderLease(identity, {
      meeting_ref: 'google_meet:abc-defg-hij',
      session_id: sessionId,
      device_id: 'device-a',
    });
    await expect(value.ingestRealtimeFrame({
      ...frame,
      meeting_ref: 'google_meet:abc-defg-hij',
      recorder_device_id: 'device-a',
      recorder_lease_token: lease.lease_token,
    })).resolves.toMatchObject({ accepted: true });
  });

  it('uses silent coverage frames to advance realtime state without invoking ASR', async () => {
    let calls = 0;
    const provider: StreamingAsrProvider = {
      provider_id: 'silent-coverage-test',
      async transcribeChunk() {
        calls += 1;
        return [];
      },
    };
    const { root, value } = ingress(provider);
    await value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1',
        frame_id: `${sessionId}:mic:frame:0`,
        session_id: sessionId,
        track: 'mic',
        frame_sequence: 0,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: 0,
        end_monotonic_ms: 999,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        speech_present: false,
      },
      audio: Buffer.alloc(0),
    });
    await value.ingest(fixture('mic', 0));

    expect(calls).toBe(0);
    expect(Object.keys((await value.providerOutbox(identity, sessionId)).pending)).toEqual([]);
    const scoped = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    expect(existsSync(resolve(scoped, 'raw'))).toBe(true);
  });

  it('flushes an endpoint frame through endSpeech and publishes its utterance', async () => {
    let transcribeCalls = 0;
    let endSpeechCalls = 0;
    const provider: StreamingAsrProvider = {
      provider_id: 'endpoint-flush-test',
      async transcribeChunk() {
        transcribeCalls += 1;
        return [];
      },
      async endSpeech({ chunk, audio }) {
        endSpeechCalls += 1;
        expect(audio).toHaveLength(0);
        return [{
          utterance_id: 'live-mic-endpoint-0',
          session_id: sessionId,
          track: 'mic',
          start_ms: 0,
          end_ms: chunk.end_monotonic_ms,
          text: '端点立即刷新',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    const { value } = ingress(provider);

    await expect(value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1',
        frame_id: `${sessionId}:mic:frame:0`,
        session_id: sessionId,
        track: 'mic',
        frame_sequence: 0,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: 0,
        end_monotonic_ms: 800,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        speech_present: false,
      },
      audio: Buffer.alloc(0),
    })).resolves.toMatchObject({
      accepted: true,
      utterances: [expect.objectContaining({ text: '端点立即刷新' })],
    });

    expect(transcribeCalls).toBe(0);
    expect(endSpeechCalls).toBe(1);
    expect((await value.transcript(identity, sessionId)).utterances).toEqual([
      expect.objectContaining({ text: '端点立即刷新' }),
    ]);
  });

  it('bounds a hung realtime provider and preserves durable ASR fallback', async () => {
    let aborted = false;
    const provider: StreamingAsrProvider = {
      provider_id: 'hung-realtime-test',
      async transcribeChunk(_input, signal) {
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('provider_aborted'));
          }, { once: true });
        });
      },
    };
    const { value } = ingress(provider, false, { realtime_provider_timeout_ms: 10 });

    await expect(value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1',
        frame_id: `${sessionId}:mic:frame:0`,
        session_id: sessionId,
        track: 'mic',
        frame_sequence: 0,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: 0,
        end_monotonic_ms: 100,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
        speech_present: true,
      },
      audio: Buffer.alloc(3_200),
    })).resolves.toEqual({ accepted: true, utterances: [] });

    expect(aborted).toBe(true);
    await value.ingest(fixture('mic', 0));
    expect(Object.keys((await value.providerOutbox(identity, sessionId)).pending)).toEqual([
      `${sessionId}:mic:0`,
    ]);
  });

  it('preserves a timed-out source chunk across the next realtime chunk boundary', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'boundary-timeout-test',
      async transcribeChunk({ chunk }, signal) {
        if (chunk.sequence !== 0) return [];
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('provider_aborted')),
            { once: true },
          );
        });
      },
    };
    const { value } = ingress(provider, false, { realtime_provider_timeout_ms: 10 });
    const realtime = (sequence: number, sourceSequence: number) => value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1' as const,
        frame_id: `${sessionId}:mic:frame:${sequence}`,
        session_id: sessionId,
        track: 'mic' as const,
        frame_sequence: sequence,
        source_chunk_id: `${sessionId}:mic:${sourceSequence}`,
        start_monotonic_ms: sourceSequence * 1_000,
        end_monotonic_ms: sourceSequence * 1_000 + 999,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1 as const,
        speech_present: true,
      },
      audio: Buffer.alloc(3_200),
    });

    await realtime(0, 0);
    await realtime(1, 1);
    // The next fact arrives first and is fully covered. The delayed timed-out
    // fact must still enter fallback rather than inheriting later coverage.
    await value.ingest(fixture('mic', 1));
    await value.ingest(fixture('mic', 0));

    expect(Object.keys((await value.providerOutbox(identity, sessionId)).pending)).toEqual([
      `${sessionId}:mic:0`,
    ]);
  });

  it('falls back to the durable fact chunk when a realtime frame sequence has a gap', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'realtime-gap-test',
      async transcribeChunk() { return []; },
    };
    const { value } = ingress(provider);
    const realtime = (sequence: number, start: number, end: number) => value.ingestRealtimeFrame({
      ...identity,
      frame: {
        schema_version: 'inkloop.meeting_realtime_audio_frame.v1' as const,
        frame_id: `${sessionId}:mic:frame:${sequence}`,
        session_id: sessionId,
        track: 'mic' as const,
        frame_sequence: sequence,
        source_chunk_id: `${sessionId}:mic:0`,
        start_monotonic_ms: start,
        end_monotonic_ms: end,
        codec: 'pcm_s16le' as const,
        sample_rate_hz: 16_000,
        channel_count: 1 as const,
        speech_present: false,
      },
      audio: Buffer.alloc(0),
    });
    await realtime(0, 0, 100);
    await realtime(2, 200, 999);
    await value.ingest(fixture('mic', 0));

    expect(Object.keys((await value.providerOutbox(identity, sessionId)).pending)).toEqual([
      `${sessionId}:mic:0`,
    ]);
  });

  it('rejects checksum and sequence identity conflicts', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    const original = fixture('mic', 0);
    await value.ingest(original);

    await expect(value.ingest({ ...original, audio: Buffer.from('changed') })).rejects.toThrow(/integrity_mismatch/);
    const conflict = fixture('mic', 0, 'other');
    await expect(value.ingest({ ...conflict, chunk: { ...conflict.chunk, chunk_id: 'different-id' } })).rejects.toThrow(/chunk conflict/);
  });

  it('rejects an expected sequence outside the bounded meeting manifest', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);

    await expect(value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic'],
      expected_last_sequence: { mic: 17_280 },
    })).rejects.toThrow('meeting_media_sequence_manifest_invalid');
  });

  it('keeps a provider timeout retryable without revoking the persisted ACK', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'timeout',
      async transcribeChunk() { throw new Error('provider_timeout'); },
    };
    const { value } = ingress(provider);
    const acknowledged = await value.ingest(fixture('remote', 0));
    await value.drainProvider(identity, sessionId);
    const outbox = await value.providerOutbox(identity, sessionId);

    expect(acknowledged.acknowledgement.chunk_id).toBe(`${sessionId}:remote:0`);
    expect(outbox.pending[`${sessionId}:remote:0`]).toMatchObject({ attempts: 1, next_attempt_at_ms: 1_123, last_error: 'provider_timeout' });
  });

  it('dead-letters a permanent provider rejection without retrying it forever', async () => {
    let calls = 0;
    const provider: StreamingAsrProvider = {
      provider_id: 'unauthorized',
      async transcribeChunk() {
        calls += 1;
        throw Object.assign(new Error('streaming_asr_http_401'), { status: 401 });
      },
    };
    const { value } = ingress(provider);
    await value.ingest(fixture('remote', 0));

    await value.drainProvider(identity, sessionId);
    await value.drainProvider(identity, sessionId);

    expect(calls).toBe(1);
    const outbox = await value.providerOutbox(identity, sessionId);
    expect(outbox.pending).not.toHaveProperty(`${sessionId}:remote:0`);
    expect(outbox.failed[`${sessionId}:remote:0`])
      .toMatchObject({
        attempts: 1,
        last_error: 'streaming_asr_http_401',
        terminal: true,
        terminal_at_ms: 123,
      });
  });

  it('formalizes retained PCM after a permanent provider rejection', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'unauthorized',
      async transcribeChunk() {
        throw Object.assign(new Error('streaming_asr_http_401'), { status: 401 });
      },
    };
    let converged = 0;
    const formal_converger: FormalTranscriptConverger = {
      converger_id: 'formal-after-dead-letter',
      async converge({ chunks }) {
        converged += 1;
        expect(await chunks[0].loadAudio()).toHaveLength(fixture('mic', 0).audio.length);
        return [{
          utterance_id: 'formal-after-dead-letter',
          session_id: sessionId,
          track: 'mic',
          start_ms: 0,
          end_ms: 999,
          text: '正式转写保留成功',
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunks[0].chunk.chunk_id],
        }];
      },
    };
    const { value } = ingress(provider, false, { formal_converger });
    await value.ingest(fixture('mic', 0));
    await value.drainProvider(identity, sessionId);
    const outbox = await value.providerOutbox(identity, sessionId);
    expect(outbox.pending).toEqual({});
    expect(outbox.failed).toHaveProperty(`${sessionId}:mic:0`);

    const finalized = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic'],
      expected_last_sequence: { mic: 0 },
    });
    expect(converged).toBe(1);
    expect(finalized.artifact).toMatchObject({
      finality: 'final',
      raw_utterances: [{ text: '正式转写保留成功' }],
    });
    expect(await value.rawMediaLifecycle(identity, sessionId)).toMatchObject({
      status: 'deleted',
      reason: 'formal_transcript_terminal',
    });
  });

  it('stops retrying a transient provider failure at the configured attempt limit', async () => {
    let now = 123;
    let calls = 0;
    const provider: StreamingAsrProvider = {
      provider_id: 'always-busy',
      async transcribeChunk() {
        calls += 1;
        throw new Error('provider_busy');
      },
    };
    const { value } = ingress(provider, false, {
      now: () => now,
      provider_max_attempts: 2,
    });
    await value.ingest(fixture('mic', 0));
    await value.drainProvider(identity, sessionId);
    now = 1_123;
    await value.drainProvider(identity, sessionId);
    now = 10_000;
    await value.drainProvider(identity, sessionId);

    expect(calls).toBe(2);
    const outbox = await value.providerOutbox(identity, sessionId);
    expect(outbox.pending).not.toHaveProperty(`${sessionId}:mic:0`);
    expect(outbox.failed[`${sessionId}:mic:0`])
      .toMatchObject({ attempts: 2, terminal: true, terminal_at_ms: 1_123 });
  });

  it('forces a provider deadline and persists bounded retry timing', async () => {
    let aborted = false;
    const provider: StreamingAsrProvider = {
      provider_id: 'hung',
      async transcribeChunk(_input, signal) {
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('provider_aborted'));
          }, { once: true });
        });
      },
    };
    const { value } = ingress(provider, false, { provider_timeout_ms: 10 });
    await value.ingest(fixture('mic', 0));
    await value.drainProvider(identity, sessionId);
    expect(aborted).toBe(true);
    expect((await value.providerOutbox(identity, sessionId)).pending[`${sessionId}:mic:0`]).toMatchObject({ attempts: 1, last_error: 'streaming_asr_provider_timeout' });
  });

  it('does not block a later ingest while the provider request is pending', async () => {
    let releaseProvider = (): void => {};
    const providerWait = new Promise<void>((resolveProvider) => { releaseProvider = resolveProvider; });
    const provider: StreamingAsrProvider = {
      provider_id: 'slow',
      async transcribeChunk() { await providerWait; return []; },
    };
    const { value } = ingress(provider);
    await value.ingest(fixture('remote', 0));
    const drain = value.drainProvider(identity, sessionId);
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));

    const second = await Promise.race([
      value.ingest(fixture('remote', 1)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ingest_blocked_by_provider')), 100)),
    ]);
    releaseProvider();
    await drain;

    expect(second.acknowledgement.sequence).toBe(1);
  });

  it('applies higher provider revisions to the same stable utterance ID', async () => {
    const provider: StreamingAsrProvider = {
      provider_id: 'revision-provider',
      async transcribeChunk({ chunk }) {
        const utterance: MeetingUtterance = {
          utterance_id: 'utt-stable',
          session_id: sessionId,
          track: chunk.track,
          start_ms: 0,
          end_ms: 900,
          text: chunk.sequence === 0 ? '发布' : '发布计划',
          revision: chunk.sequence + 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        };
        return [utterance];
      },
    };
    const { value } = ingress(provider);
    await value.ingest(fixture('remote', 0));
    await value.ingest(fixture('remote', 1));
    await value.drainProvider(identity, sessionId);
    const transcript = await value.transcript(identity, sessionId);

    expect(transcript.utterances).toHaveLength(1);
    expect(transcript.utterances[0]).toMatchObject({ utterance_id: 'utt-stable', revision: 2, text: '发布计划' });
  });

  it('serves a real authenticated HTTP ACK and provisional transcript', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    const handler = createMeetingMediaService({
      ingress: value,
      readBody: async (req) => await new Promise<string>((resolveBody) => {
        let body = '';
        req.on('data', (part) => { body += part; });
        req.on('end', () => resolveBody(body));
      }),
      resolveIdentity: async () => identity,
    });
    const server = createServer(async (req, res) => {
      if (!await handler(req, res)) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    closers.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const input = fixture('mic', 0);

    const acknowledged = await call(`${base}/api/meeting-media/chunks`, 'POST', {
      chunk: input.chunk,
      audio_base64: input.audio.toString('base64'),
    });
    const transcript = await call(`${base}/api/meeting-media/transcript?session_id=${sessionId}`);
    const latestTranscript = await call(`${base}/api/meeting-media/transcript?session_id=latest`);
    const liveStatus = await call(`${base}/api/meeting-media/live-status`);
    const invalidChunk = await call(`${base}/api/meeting-media/chunks`, 'POST', {
      chunk: { schema_version: 'wrong' },
      audio_base64: 'not base64!',
    });
    const invalidFrame = await call(`${base}/api/meeting-media/realtime-frames`, 'POST', {
      frame: { schema_version: 'inkloop.meeting_realtime_audio_frame.v1' },
      audio_base64: '',
    });
    const invalidSession = await call(`${base}/api/meeting-media/sessions`, 'POST', {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'unknown',
    });

    expect(acknowledged).toMatchObject({ status: 202, json: { acknowledgement: { chunk_id: `${sessionId}:mic:0` } } });
    expect(transcript).toMatchObject({ status: 200, json: { transcript: { status: 'provisional', session_id: sessionId } } });
    expect(latestTranscript).toMatchObject({ status: 200, json: { transcript: { session_id: sessionId } } });
    expect(liveStatus).toMatchObject({ status: 200, json: { session_id: sessionId, active: true, tracks: ['mic'] } });
    expect(invalidChunk).toMatchObject({
      status: 400,
      json: { error: { code: 'meeting_media_chunk_payload_invalid' } },
    });
    expect(invalidFrame).toMatchObject({
      status: 400,
      json: { error: { code: 'meeting_media_realtime_frame_payload_invalid' } },
    });
    expect(invalidSession).toMatchObject({
      status: 400,
      json: { error: { code: 'meeting_media_session_scope_invalid' } },
    });
  });

  it('registers the active meeting scope before the first audio chunk and clears it when sealed', async () => {
    let now = 100;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider, false, { now: () => now });
    const handler = createMeetingMediaService({
      ingress: value,
      readBody: async (req) => await new Promise<string>((resolveBody) => {
        let body = '';
        req.on('data', (part) => { body += part; });
        req.on('end', () => resolveBody(body));
      }),
      resolveIdentity: async () => identity,
    });
    const server = createServer(async (req, res) => {
      if (!await handler(req, res)) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    closers.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    expect(await call(`${base}/api/meeting-media/sessions`, 'POST', {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'recording',
      started_at_ms: 100,
    })).toMatchObject({ status: 200, json: {
      session_id: sessionId,
      meeting_ref: 'google_meet:abc-defg-hij',
      meeting_doc_id: 'mtgdoc_abc-defg-hij',
      status: 'recording',
    } });
    expect(await call(`${base}/api/meeting-media/live-status`)).toMatchObject({ status: 200, json: {
      active: true,
      session_id: sessionId,
      meeting_doc_id: 'mtgdoc_abc-defg-hij',
      transcript: null,
    } });

    now = 200;
    expect(await call(`${base}/api/meeting-media/sessions`, 'POST', {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'sealed',
      started_at_ms: 100,
      ended_at_ms: 200,
    })).toMatchObject({ status: 200, json: { status: 'sealed' } });
    expect(await call(`${base}/api/meeting-media/live-status`)).toMatchObject({ status: 200, json: {
      active: false,
      session_id: sessionId,
      meeting_doc_id: 'mtgdoc_abc-defg-hij',
    } });
  });

  it('rejects a media session scope that changes its meeting identity', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'recording',
    });

    await expect(value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:other-code-x',
      status: 'recording',
    })).rejects.toThrow('meeting_media_session_scope_conflict');
  });

  it('uses the registered InkLoop meeting document when provider identity resolves it', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const root = mkdtempSync(join(tmpdir(), 'meeting-media-resolved-scope-'));
    const value = new MeetingMediaStreamingIngress({
      root,
      providers: new StreamingAsrProviderRouter({}, provider),
      resolve_meeting_document_id: async (_identity, input) => input.meeting_ref === 'google_meet:abc-defg-hij'
        ? 'mtgdoc_internal-meeting-42'
        : null,
    });

    await expect(value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'recording',
    })).resolves.toMatchObject({ meeting_doc_id: 'mtgdoc_internal-meeting-42' });
  });

  it('resolves the latest media session for an InkLoop meeting document', async () => {
    let now = 100;
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider, false, { now: () => now });
    await value.registerSession(identity, {
      session_id: 'session-old', platform: 'google_meet', meeting_ref: 'google_meet:old-code-abc', status: 'sealed',
    });
    now = 200;
    await value.registerSession(identity, {
      session_id: sessionId, platform: 'google_meet', meeting_ref: 'google_meet:meeting-1', status: 'recording',
    });

    await expect(value.latestSessionScopeForMeeting(identity, 'mtgdoc_meeting-1')).resolves.toMatchObject({
      session_id: sessionId,
      meeting_doc_id: 'mtgdoc_meeting-1',
    });
    await expect(value.latestSessionScopeForMeeting(identity, 'doc_other')).rejects.toThrow('meeting_media_meeting_document_invalid');
  });

  it('finalizes idempotently and forwards partial evidence to postprocess', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'pending', async transcribeChunk() { throw new Error('pending'); } };
    const root = mkdtempSync(join(tmpdir(), 'meeting-media-finalize-scope-'));
    const value = new MeetingMediaStreamingIngress({
      root,
      providers: new StreamingAsrProviderRouter({}, provider),
      auto_process: false,
      now: () => 123,
      resolve_meeting_document_id: async () => 'mtgdoc_internal-meeting-42',
    });
    await value.ingest(fixture('mic', 0));
    await value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'recording',
      started_at_ms: 10,
    });
    const forwarded: Array<{ artifact: { finality: string; missing_chunk_ids: string[] }; request: { meeting_id: string } }> = [];
    const handler = createMeetingMediaService({
      ingress: value,
      readBody: async (req) => await new Promise<string>((resolveBody) => {
        let body = '';
        req.on('data', (part) => { body += part; });
        req.on('end', () => resolveBody(body));
      }),
      resolveIdentity: async () => identity,
      onFormalTranscript: async ({ artifact, request }) => {
        forwarded.push({ artifact, request });
        return { run_id: 'run-1' };
      },
    });
    const server = createServer(async (req, res) => {
      if (!await handler(req, res)) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    closers.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const body = { session_id: sessionId, meeting_id: 'google_meet:abc-defg-hij', title: 'Local meeting', expected_tracks: ['mic', 'remote'], expected_last_sequence: { mic: 0, remote: 0 } };

    const premature = await call(`${base}/api/meeting-media/finalize`, 'POST', body);
    expect(premature).toMatchObject({ status: 409, json: { error: { code: 'meeting_media_session_not_sealed' } } });
    await value.registerSession(identity, {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: 'google_meet:abc-defg-hij',
      status: 'sealed',
      started_at_ms: 10,
      ended_at_ms: 20,
    });

    const first = await call(`${base}/api/meeting-media/finalize`, 'POST', body);
    const replay = await call(`${base}/api/meeting-media/finalize`, 'POST', body);

    expect(first.json).toMatchObject({ replay: false, artifact: { finality: 'partial', missing_chunk_ids: expect.arrayContaining([`${sessionId}:mic:0`, 'missing_track:remote']) }, postprocess: { run_id: 'run-1' } });
    expect(replay.json.replay).toBe(true);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ artifact: { finality: 'partial' }, request: {
      meeting_id: 'internal-meeting-42',
      provider_meeting_id: 'google_meet:abc-defg-hij:10',
    } });
  });

  it('persists acoustic dedupe decisions before automatic raw-media deletion', async () => {
    const pcm = (scale: number, shiftBuckets = 0) => {
      const sampleRate = 16_000;
      const bucketSamples = sampleRate / 50;
      const values = new Int16Array(sampleRate * 2);
      for (let bucket = 0; bucket < 100; bucket += 1) {
        const shifted = bucket + shiftBuckets;
        if (shifted >= 100) continue;
        const amplitude = (0.08 + (((bucket * 17) % 31) / 40)) * scale;
        for (let index = shifted * bucketSamples; index < (shifted + 1) * bucketSamples; index += 1) {
          values[index] = Math.round(amplitude * (index % 2 ? 1 : -1) * 30_000);
        }
      }
      return Buffer.from(values.buffer);
    };
    const provider: StreamingAsrProvider = {
      provider_id: 'acoustic-test',
      async transcribeChunk(input) {
        return [{
          utterance_id: `utt-${input.chunk.track}`, session_id: sessionId, track: input.chunk.track,
          start_ms: 100, end_ms: 1_900, text: '发布计划已经确认', revision: 1,
          stability: 'provisional', source_chunk_ids: [input.chunk.chunk_id],
        }];
      },
    };
    const { root, value } = ingress(provider);
    const captured = (track: 'mic' | 'remote', audio: Buffer) => ({
      ...identity,
      chunk: {
        schema_version: 'inkloop.meeting_audio_chunk.v1' as const,
        chunk_id: `${sessionId}:${track}:0`, session_id: sessionId, track, sequence: 0,
        start_monotonic_ms: 0, end_monotonic_ms: 2_000,
        checksum: `sha256:${createHash('sha256').update(audio).digest('hex')}`,
        byte_length: audio.length, sealed: true as const, codec: 'pcm_s16le', sample_rate_hz: 16_000, channel_count: 1,
      },
      audio,
    });
    await value.ingest(captured('remote', pcm(1)));
    await value.ingest(captured('mic', pcm(0.55, 3)));
    await value.drainProvider(identity, sessionId);

    const first = await value.finalizeSession({
      identity, session_id: sessionId, expected_tracks: ['mic', 'remote'],
      expected_last_sequence: { mic: 0, remote: 0 },
    });
    expect(first.artifact.duplicate_assessments).toEqual([expect.objectContaining({
      source: 'external_adapter',
      disposition: 'suppress_derived_duplicate',
      signals: ['aec', 'acoustic_similarity', 'text_similarity', 'time_overlap'],
    })]);
    expect(first.artifact.dedupe_metrics).toMatchObject({
      external_assessment_count: 1,
      inferred_assessment_count: 0,
      suppressed_duplicate_count: 1,
    });
    const sessionDirectory = resolve(root, Buffer.from('tenant').toString('base64url'), Buffer.from('user').toString('base64url'), Buffer.from(sessionId).toString('base64url'));
    const finalizeIntent = JSON.parse(readFileSync(resolve(sessionDirectory, 'finalize-intent.json'), 'utf8')) as {
      duplicate_assessment_source?: string;
      acoustic_dedupe_input_fingerprint?: string;
    };
    expect(finalizeIntent).toMatchObject({
      duplicate_assessment_source: 'acoustic_adapter',
      acoustic_dedupe_input_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(existsSync(resolve(sessionDirectory, 'raw'))).toBe(false);

    const replay = await value.finalizeSession({
      identity, session_id: sessionId, expected_tracks: ['mic', 'remote'],
      expected_last_sequence: { mic: 0, remote: 0 },
    });
    expect(replay.replay).toBe(true);
    expect(replay.artifact.duplicate_assessments).toEqual(first.artifact.duplicate_assessments);
  });

  it('derives internal sequence gaps from the sealed manifest', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    for (const track of ['mic', 'remote'] as const) {
      await value.ingest(fixture(track, 0));
      await value.ingest(fixture(track, 2));
    }
    await value.drainProvider(identity, sessionId);
    const finalized = await value.finalizeSession({ identity, session_id: sessionId, expected_tracks: ['mic', 'remote'], expected_last_sequence: { mic: 2, remote: 2 } });
    expect(finalized.artifact).toMatchObject({ finality: 'partial', missing_chunk_ids: [`${sessionId}:mic:1`, `${sessionId}:remote:1`] });
  });

  it('keeps a completely absent expected track visible as partial evidence', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await value.ingest(fixture('mic', 0));
    await value.drainProvider(identity, sessionId);

    const finalized = await value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic', 'remote'],
      expected_last_sequence: { mic: 0 },
    });

    expect(finalized.artifact).toMatchObject({
      finality: 'partial',
      missing_chunk_ids: ['missing_track:remote'],
    });
  });

  it('rejects a manifest that omits the sequence boundary for a present track', async () => {
    const provider: StreamingAsrProvider = { provider_id: 'test', async transcribeChunk() { return []; } };
    const { value } = ingress(provider);
    await value.ingest(fixture('mic', 0));

    await expect(value.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: ['mic', 'remote'],
      expected_last_sequence: { remote: 0 },
    })).rejects.toThrow('meeting_media_sequence_manifest_invalid');
  });

  it('automatically reconverges a sealed partial transcript after provider recovery', async () => {
    let fail = true;
    const provider: StreamingAsrProvider = { provider_id: 'recovering', async transcribeChunk({ chunk }) { if (fail) throw new Error('offline'); return [{ utterance_id: `u-${chunk.track}`, session_id: sessionId, track: chunk.track, start_ms: 0, end_ms: 999, text: chunk.track, revision: 1, stability: 'provisional', source_chunk_ids: [chunk.chunk_id] }]; } };
    let now = 100;
    const { value } = ingress(provider, false, { now: () => now });
    await value.ingest(fixture('mic', 0)); await value.ingest(fixture('remote', 0));
    await value.drainProvider(identity, sessionId);
    const notified: string[] = [];
    value.setFormalTranscriptHandler(async ({ artifact }) => { notified.push(artifact.finality); });
    const first = await value.finalizeSession({ identity, session_id: sessionId, expected_tracks: ['mic', 'remote'], expected_last_sequence: { mic: 0, remote: 0 }, request: { session_id: sessionId, meeting_id: 'm1', expected_tracks: ['mic', 'remote'], expected_last_sequence: { mic: 0, remote: 0 } } });
    expect(first.artifact.finality).toBe('partial');
    fail = false; now = 2_000;
    await value.drainProvider(identity, sessionId);
    expect(notified).toEqual(['final']);
    expect((await value.finalizeSession({ identity, session_id: sessionId, expected_tracks: ['mic', 'remote'], expected_last_sequence: { mic: 0, remote: 0 } })).artifact.finality).toBe('final');
  });

  it('replays a synthetic 45-minute dual-track session after an offline restart without duplicate utterances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meeting-media-long-'));
    const offlineProvider: StreamingAsrProvider = { provider_id: 'offline', async transcribeChunk() { throw new Error('offline'); } };
    const offline = new MeetingMediaStreamingIngress({ root, providers: new StreamingAsrProviderRouter({}, offlineProvider), auto_process: false, now: () => 123 });
    const chunkCountPerTrack = 90;
    const sealed: ReturnType<typeof fixture>[] = [];
    for (const track of ['mic', 'remote'] as const) {
      for (let sequence = 0; sequence < chunkCountPerTrack; sequence += 1) {
        const item = fixture(track, sequence, `${track}:${sequence}:audio`);
        item.chunk.start_monotonic_ms = sequence * 30_000;
        item.chunk.end_monotonic_ms = (sequence + 1) * 30_000;
        sealed.push(item);
      }
    }
    // Mimic reconnect ordering rather than relying on perfectly interleaved uploads.
    for (const item of [...sealed].reverse()) await offline.ingest(item);

    const provider: StreamingAsrProvider = {
      provider_id: 'recovered',
      async transcribeChunk({ chunk }) {
        return [{
          utterance_id: `utterance:${chunk.track}:${chunk.sequence}`,
          session_id: chunk.session_id,
          track: chunk.track,
          start_ms: chunk.start_monotonic_ms,
          end_ms: chunk.end_monotonic_ms,
          text: `${chunk.track} ${chunk.sequence}`,
          revision: 1,
          stability: 'provisional',
          source_chunk_ids: [chunk.chunk_id],
        }];
      },
    };
    const recovered = new MeetingMediaStreamingIngress({ root, providers: new StreamingAsrProviderRouter({}, provider), auto_process: false, now: () => 456 });
    expect(await recovered.bootstrapPending()).toBe(1);
    await recovered.drainProvider(identity, sessionId);

    const outbox = await recovered.providerOutbox(identity, sessionId);
    const transcript = await recovered.transcript(identity, sessionId);
    expect(Object.keys(outbox.pending)).toHaveLength(0);
    expect(Object.keys(outbox.completed)).toHaveLength(chunkCountPerTrack * 2);
    expect(transcript.utterances).toHaveLength(chunkCountPerTrack * 2);
    expect(new Set(transcript.utterances.map((utterance) => utterance.utterance_id)).size).toBe(chunkCountPerTrack * 2);
    expect(transcript.utterances.at(-1)?.end_ms).toBe(45 * 60_000);

    for (const replay of sealed.slice(0, 4)) expect((await recovered.ingest(replay)).replay).toBe(true);
    expect(Object.keys((await recovered.providerOutbox(identity, sessionId)).pending)).toHaveLength(0);
  }, 30_000);
});

async function call(url: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  return await new Promise((resolveCall, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.on('data', (part) => { text += part; });
      res.on('end', () => resolveCall({ status: res.statusCode || 0, json: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
