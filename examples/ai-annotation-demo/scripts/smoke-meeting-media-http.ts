/**
 * Real HTTP smoke for the local Meeting Media chain:
 * PCM16 -> authenticated ingest -> durable ACK -> ASR -> formal convergence
 * -> derived duplicate suppression -> server raw-media deletion.
 *
 * The server and all of its state live under a fresh temporary directory and
 * are removed after the run. An already-running local ASR Provider is the only
 * external dependency.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const TOKEN = 'local-demo-token';

type JsonResult<T> = { status: number; body: T; text: string };

function fail(message: string): never {
  throw new Error(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!address || typeof address === 'string') fail('meeting_media_smoke_port_unavailable');
  return address.port;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit') as [number | null];
  if (code !== 0) fail(`${command}_failed:${output.trim()}`);
}

async function generateMandarinPcm16(root: string): Promise<Buffer> {
  const aiff = join(root, 'mandarin.aiff');
  const pcm = join(root, 'mandarin.pcm');
  await runCommand('/usr/bin/say', [
    '-v', 'Tingting',
    '-o', aiff,
    '今天我们确认实时会议转写链路，下一步测试谷歌会议和远端音频。',
  ]);
  await runCommand(process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff,
    '-f', 's16le', '-ar', '16000', '-ac', '1', pcm,
  ]);
  return await readFile(pcm);
}

async function requestJson<T>(baseUrl: string, path: string, method = 'GET', body?: unknown): Promise<JsonResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { parsed = { raw: text }; }
  if (!response.ok) fail(`${method} ${path} -> ${response.status}: ${text}`);
  return { status: response.status, body: parsed as T, text };
}

async function waitForServer(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) fail(`meeting_media_server_exited:${child.exitCode}:${logs()}`);
    try {
      const status = await requestJson<{ active?: boolean }>(baseUrl, '/api/meeting-media/live-status');
      if (status.status === 200) return;
    } catch { /* server is still starting */ }
    await sleep(100);
  }
  fail(`meeting_media_server_not_ready:${logs()}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
  try { await once(child, 'exit'); }
  finally { clearTimeout(timer); }
}

function encodedSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'inkloop-meeting-media-http-smoke-'));
  const mediaRoot = join(root, 'meeting-media');
  const postprocessRoot = join(root, 'meeting-postprocess');
  const authStore = join(root, 'auth-sessions.json');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tsxCli = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const sessionId = `meeting-media-http-smoke-${Date.now()}`;
  let logs = '';
  let server: ChildProcess | null = null;
  try {
    const audio = await generateMandarinPcm16(root);
    server = spawn(process.execPath, [tsxCli, join(PACKAGE_ROOT, 'server/standalone.ts')], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        INKLOOP_HTTPS_PORT: '0',
        INKLOOP_LOCAL_DEVICE_AUTH: '1',
        INKLOOP_LOCAL_DEVICE_AUTH_AUTO_APPROVE: '1',
        INKLOOP_LOCAL_DEVICE_AUTH_TOKEN: TOKEN,
        INKLOOP_LOCAL_AUTH_STORE: authStore,
        INKLOOP_LOCAL_AUTH_TENANT_ID: 'local',
        INKLOOP_LOCAL_AUTH_USER_ID: 'local_demo',
        INKLOOP_MEETING_MEDIA_ROOT: mediaRoot,
        INKLOOP_MEETING_POSTPROCESS_ROOT: postprocessRoot,
        INKLOOP_STREAMING_ASR_URL: process.env.INKLOOP_STREAMING_ASR_URL || 'http://127.0.0.1:8081/inference',
        INKLOOP_STREAMING_ASR_MODEL: process.env.INKLOOP_STREAMING_ASR_MODEL || 'ggml-large-v3-turbo-q5_0',
        INKLOOP_STREAMING_ASR_LANGUAGE: process.env.INKLOOP_STREAMING_ASR_LANGUAGE || 'zh',
        INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS: process.env.INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS || '8000',
        INKLOOP_LARK_MEETING_RECONCILE_MS: '0',
        INKLOOP_GOOGLE_SMART_NOTE_BACKFILL_MS: '0',
        INKLOOP_ZOOM_RECORDS_BACKFILL_MS: '0',
        LARK_MEETING_SDK_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
    server.stderr?.on('data', (chunk) => { logs += chunk.toString(); });
    await waitForServer(baseUrl, server, () => logs);

    const startedAt = Date.now();
    const durationMs = Math.floor((audio.byteLength / 2 / 16_000) * 1_000);
    const checksum = `sha256:${createHash('sha256').update(audio).digest('hex')}`;
    const meetingRef = `google_meet:${sessionId}`;
    const recorderDeviceId = 'local-demo-device';
    const lease = (await requestJson<{ granted: boolean; lease_token: string }>(baseUrl, '/api/meeting-media/recorder-lease/acquire', 'POST', {
      meeting_ref: meetingRef,
      session_id: sessionId,
      device_id: recorderDeviceId,
    })).body;
    if (!lease.granted || !lease.lease_token) fail('meeting_media_recorder_lease_not_granted');
    const registerStarted = performance.now();
    await requestJson(baseUrl, '/api/meeting-media/sessions', 'POST', {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: meetingRef,
      status: 'recording',
      started_at_ms: startedAt,
      recorder_device_id: recorderDeviceId,
      recorder_lease_token: lease.lease_token,
    });
    const registrationLatencyMs = performance.now() - registerStarted;

    const acknowledgements: Array<Record<string, unknown>> = [];
    const ackLatenciesMs: number[] = [];
    for (const track of ['mic', 'remote'] as const) {
      const chunk = {
        schema_version: 'inkloop.meeting_audio_chunk.v1',
        chunk_id: `${sessionId}:${track}:0`,
        session_id: sessionId,
        track,
        sequence: 0,
        start_monotonic_ms: 0,
        end_monotonic_ms: durationMs,
        checksum,
        byte_length: audio.byteLength,
        sealed: true,
        codec: 'pcm_s16le',
        sample_rate_hz: 16_000,
        channel_count: 1,
      };
      const ackStarted = performance.now();
      const response = await requestJson<{ acknowledgement: Record<string, unknown> }>(baseUrl, '/api/meeting-media/chunks', 'POST', {
        chunk,
        audio_base64: audio.toString('base64'),
        meeting_ref: meetingRef,
        recorder_device_id: recorderDeviceId,
        recorder_lease_token: lease.lease_token,
      });
      ackLatenciesMs.push(performance.now() - ackStarted);
      acknowledgements.push(response.body.acknowledgement);
    }

    const asrStarted = performance.now();
    let provider!: { outbox: { pending: Record<string, unknown>; completed: Record<string, unknown> } };
    for (let attempt = 0; attempt < 240; attempt += 1) {
      provider = (await requestJson<typeof provider>(baseUrl, `/api/meeting-media/provider-status?session_id=${encodeURIComponent(sessionId)}`)).body;
      if (Object.keys(provider.outbox.pending || {}).length === 0) break;
      await sleep(250);
    }
    const asrLatencyMs = performance.now() - asrStarted;
    if (Object.keys(provider.outbox.pending || {}).length > 0) fail(`meeting_media_asr_did_not_drain:${JSON.stringify(provider.outbox.pending)}`);

    const transcript = (await requestJson<{ transcript: { utterances: Array<{ text: string }> } }>(baseUrl, `/api/meeting-media/transcript?session_id=${encodeURIComponent(sessionId)}`)).body.transcript;

    await requestJson(baseUrl, '/api/meeting-media/sessions', 'POST', {
      session_id: sessionId,
      platform: 'google_meet',
      meeting_ref: meetingRef,
      status: 'sealed',
      started_at_ms: startedAt,
      ended_at_ms: Date.now(),
      recorder_device_id: recorderDeviceId,
      recorder_lease_token: lease.lease_token,
    });
    const finalizeStarted = performance.now();
    const finalized = (await requestJson<{ artifact: {
      finality: string;
      raw_utterances: Array<{ text: string }>;
      derived_utterances: Array<{ text: string }>;
      missing_chunk_ids: string[];
    }; replay: boolean }>(baseUrl, '/api/meeting-media/finalize', 'POST', {
      session_id: sessionId,
      meeting_id: sessionId,
      title: 'Meeting Media HTTP Smoke',
      platform: 'google_meet',
      provider_meeting_id: meetingRef,
      started_at_ms: startedAt,
      ended_at_ms: Date.now(),
      expected_tracks: ['mic', 'remote'],
      expected_last_sequence: { mic: 0, remote: 0 },
      ocr_status: 'not_applicable',
    })).body;
    const finalizeLatencyMs = performance.now() - finalizeStarted;
    await requestJson(baseUrl, '/api/meeting-media/recorder-lease/release', 'POST', {
      meeting_ref: meetingRef,
      session_id: sessionId,
      device_id: recorderDeviceId,
      lease_token: lease.lease_token,
    });
    const lifecycle = (await requestJson<{ lifecycle: { status: string; reason: string } }>(baseUrl, `/api/meeting-media/raw-media?session_id=${encodeURIComponent(sessionId)}`)).body.lifecycle;
    const outboxPath = join(mediaRoot, encodedSegment('local'), encodedSegment('local_demo'), encodedSegment(sessionId), 'provider-outbox.json');
    const outboxBytes = (await stat(outboxPath)).size;
    const provisionalHasText = transcript.utterances.some((utterance) => utterance.text.trim());
    const formalHasText = finalized.artifact.raw_utterances.some((utterance) => utterance.text.trim());
    const minimumRealtimeWindowMs = Number(
      process.env.INKLOOP_STREAMING_ASR_MINIMUM_WINDOW_MS || 8_000);

    const gates = {
      two_durable_acks: acknowledgements.length === 2,
      recorder_lease_granted: lease.granted && !!lease.lease_token,
      provider_drained: Object.keys(provider.outbox.pending || {}).length === 0 && Object.keys(provider.outbox.completed || {}).length === 2,
      realtime_text_when_window_reached: durationMs < minimumRealtimeWindowMs || provisionalHasText,
      formal_transcript_has_text: formalHasText,
      formal_final: finalized.artifact.finality === 'final' && finalized.artifact.missing_chunk_ids.length === 0,
      duplicate_suppressed_only_in_derived_timeline: finalized.artifact.raw_utterances.length > finalized.artifact.derived_utterances.length,
      server_raw_deleted: lifecycle.status === 'deleted' && lifecycle.reason === 'formal_transcript_terminal',
      outbox_contains_no_audio_copy: outboxBytes < 20_000,
    };
    const report = {
      schema_version: 'inkloop.meeting_media_http_smoke.v1',
      ok: Object.values(gates).every(Boolean),
      session_id: sessionId,
      provider: process.env.INKLOOP_STREAMING_ASR_MODEL || 'ggml-large-v3-turbo-q5_0',
      audio: { codec: 'pcm_s16le', sample_rate_hz: 16_000, channel_count: 1, bytes_per_track: audio.byteLength, duration_ms: durationMs },
      metrics: {
        registration_latency_ms: Math.round(registrationLatencyMs),
        ack_latency_ms: ackLatenciesMs.map(Math.round),
        asr_drain_latency_ms: Math.round(asrLatencyMs),
        finalize_latency_ms: Math.round(finalizeLatencyMs),
        outbox_bytes_after_convergence: outboxBytes,
      },
      realtime_transcript_text: transcript.utterances.map((utterance) => utterance.text),
      formal_transcript_text: finalized.artifact.raw_utterances.map((utterance) => utterance.text),
      final: {
        finality: finalized.artifact.finality,
        raw_utterance_count: finalized.artifact.raw_utterances.length,
        derived_utterance_count: finalized.artifact.derived_utterances.length,
        missing_chunk_ids: finalized.artifact.missing_chunk_ids,
      },
      raw_media_lifecycle: lifecycle,
      gates,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await stopChild(server);
    if (process.env.INKLOOP_KEEP_MEETING_MEDIA_SMOKE !== '1') await rm(root, { recursive: true, force: true });
    else console.info(`[meeting-media:http-smoke] kept ${root}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
