/**
 * Summarize one real macOS Companion recording against its server-side
 * Meeting Media state. The report is evidence only: it never mutates or
 * deletes the authoritative local/remote media stores.
 *
 * Usage:
 *   npm run accept:real-meeting-media -- --session latest
 *   npm run accept:real-meeting-media -- --session <uuid> --out /tmp/report.json
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  evaluateTranscriptDedupe,
  type LabeledDedupePair,
} from '../server/meeting-media/dedupe-evaluation';
import type {
  FormalTranscriptArtifact,
} from '../server/meeting-media/transcript-finalizer';

type Track = 'mic' | 'remote';

type SessionRecord = {
  session_id: string;
  platform: string;
  meeting_ref: string;
  status: string;
  start_mode: string;
  wall_clock_anchor_ms: number;
  monotonic_anchor_ms: number;
  started_monotonic_ms?: number;
  ended_monotonic_ms?: number;
  stop_reason?: string;
  events: Array<{
    type: string;
    at_monotonic_ms: number;
    evidence?: { signal?: string; observed_at_wall_clock_ms?: number };
    chunk_ref?: { track: Track; sequence: number; chunk_id: string };
  }>;
};

type SequenceManifest = {
  expected_tracks: Track[];
  expected_last_sequence: Partial<Record<Track, number>>;
};

type ChunkRecord = {
  chunk_id: string;
  track: Track;
  sequence: number;
  start_monotonic_ms: number;
  end_monotonic_ms: number;
  checksum: string;
  byte_length: number;
};

type DeliveryRecord = {
  chunks?: Record<string, ChunkRecord>;
  acknowledgements?: Record<string, { chunk_id: string; checksum: string; acknowledged_at_ms: number }>;
};

type OutboxRecord = {
  pending?: Record<string, unknown>;
  completed?: Record<string, { provider_id: string; completed_at_ms: number }>;
};

type TranscriptRecord = {
  status?: string;
  revision?: number;
  utterances?: Array<{ utterance_id: string; track: Track; start_ms: number; end_ms: number; text: string }>;
};

type FormalTranscriptRecord = {
  artifact?: FormalTranscriptArtifact;
};

type TelemetryRecord = {
  registered_at_ms?: number;
  first_chunk_received_at_ms?: number;
  last_chunk_acknowledged_at_ms?: number;
  acknowledgement_count?: number;
  replay_count?: number;
  peak_pending_chunk_count?: number;
  ack_persist_duration_ms?: number[];
  provider_attempt_count?: number;
  provider_failure_count?: number;
  provider_timeout_count?: number;
  provider_duration_ms?: number[];
  realtime_frame_count?: number;
  realtime_audio_duration_ms?: number;
  realtime_provider_duration_ms?: number[];
  realtime_provider_ids?: Partial<Record<Track, string>>;
  realtime_audio_derivations?: Partial<Record<Track, string>>;
  formal_converger_id?: string;
  first_provisional_at_ms?: number;
  asr_drained_at_ms?: number;
  formalized_at_ms?: number;
};

export type RealMeetingMediaAcceptanceOptions = {
  session: string;
  localRoot: string;
  serverRoot: string;
  tenantId: string;
  userId: string;
  dedupeLabels?: LabeledDedupePair[];
  now?: number;
};

function encodedSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function latestLocalSessionId(root: string): Promise<string | null> {
  let latest: { id: string; modifiedAt: number } | null = null;
  for (const id of await directories(root)) {
    try {
      const modifiedAt = (await stat(resolve(root, id, 'session.json'))).mtimeMs;
      if (!latest || modifiedAt > latest.modifiedAt) latest = { id, modifiedAt };
    } catch { /* incomplete directory */ }
  }
  return latest?.id || null;
}

function expectedSequences(manifest: SequenceManifest | null, track: Track): number[] {
  const last = manifest?.expected_last_sequence?.[track];
  return Number.isInteger(last) && Number(last) >= 0
    ? Array.from({ length: Number(last) + 1 }, (_, sequence) => sequence)
    : [];
}

function duration(session: SessionRecord | null): number | null {
  if (!session || !Number.isFinite(session.started_monotonic_ms) || !Number.isFinite(session.ended_monotonic_ms)) return null;
  return Math.max(0, Number(session.ended_monotonic_ms) - Number(session.started_monotonic_ms));
}

function percentile(values: readonly number[], value: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(value * sorted.length) - 1))];
}

function difference(end?: number, start?: number): number | null {
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, Number(end) - Number(start)) : null;
}

export async function analyzeRealMeetingMedia(options: RealMeetingMediaAcceptanceOptions) {
  const requestedSession = options.session.trim();
  const sessionId = requestedSession === 'latest'
    ? await latestLocalSessionId(options.localRoot)
    : requestedSession;
  if (!sessionId) throw new Error('real_meeting_media_session_not_found');

  const localDirectory = resolve(options.localRoot, sessionId);
  const serverDirectory = resolve(
    options.serverRoot,
    encodedSegment(options.tenantId),
    encodedSegment(options.userId),
    encodedSegment(sessionId),
  );
  const session = await readJson<SessionRecord>(resolve(localDirectory, 'session.json'));
  if (!session) throw new Error(`real_meeting_media_session_manifest_missing:${sessionId}`);
  const manifest = await readJson<SequenceManifest>(resolve(localDirectory, 'sequence-manifest.json'));
  const delivery = await readJson<DeliveryRecord>(resolve(serverDirectory, 'delivery.json'));
  const outbox = await readJson<OutboxRecord>(resolve(serverDirectory, 'provider-outbox.json'));
  const transcript = await readJson<TranscriptRecord>(resolve(serverDirectory, 'transcript.json'));
  const formal = await readJson<FormalTranscriptRecord>(resolve(serverDirectory, 'formal-transcript.json'));
  const telemetry = await readJson<TelemetryRecord>(resolve(serverDirectory, 'telemetry.json'));
  const chunks = Object.values(delivery?.chunks || {});
  const acknowledgements = delivery?.acknowledgements || {};

  const tracks = Object.fromEntries((['mic', 'remote'] as Track[]).map((track) => {
    const localSequences = session.events
      .filter((event) => event.chunk_ref?.track === track)
      .map((event) => Number(event.chunk_ref?.sequence))
      .sort((left, right) => left - right);
    const serverChunks = chunks
      .filter((chunk) => chunk.track === track)
      .sort((left, right) => left.sequence - right.sequence);
    const expected = expectedSequences(manifest, track);
    const present = new Set(serverChunks.map((chunk) => chunk.sequence));
    return [track, {
      expected: manifest?.expected_tracks?.includes(track) === true,
      local_chunk_count: localSequences.length,
      server_chunk_count: serverChunks.length,
      ack_count: serverChunks.filter((chunk) => acknowledgements[`${track}:${chunk.sequence}`]?.chunk_id === chunk.chunk_id).length,
      byte_count: serverChunks.reduce((sum, chunk) => sum + Number(chunk.byte_length || 0), 0),
      first_sequence: serverChunks.at(0)?.sequence ?? null,
      last_sequence: serverChunks.at(-1)?.sequence ?? null,
      missing_sequences: expected.filter((sequence) => !present.has(sequence)),
      local_server_sequence_match: localSequences.join(',') === serverChunks.map((chunk) => chunk.sequence).join(','),
    }];
  })) as Record<Track, {
    expected: boolean;
    local_chunk_count: number;
    server_chunk_count: number;
    ack_count: number;
    byte_count: number;
    first_sequence: number | null;
    last_sequence: number | null;
    missing_sequences: number[];
    local_server_sequence_match: boolean;
  }>;

  const endConfirmed = session.events.find((event) => event.type === 'meeting.end.confirmed');
  const recordingStopped = session.events.find((event) => event.type === 'recording.stopped');
  const stoppedAfterConfirmationMs = endConfirmed && recordingStopped
    ? recordingStopped.at_monotonic_ms - endConfirmed.at_monotonic_ms
    : null;
  const gates = {
    sealed: session.status === 'sealed' && !!manifest,
    both_tracks_have_chunks: tracks.mic.server_chunk_count > 0 && tracks.remote.server_chunk_count > 0,
    all_chunks_acknowledged: chunks.length > 0 && chunks.length === Object.keys(acknowledgements).length,
    no_sequence_gaps: tracks.mic.missing_sequences.length === 0 && tracks.remote.missing_sequences.length === 0,
    local_server_sequences_match: tracks.mic.local_server_sequence_match && tracks.remote.local_server_sequence_match,
    asr_queue_drained: Object.keys(outbox?.pending || {}).length === 0,
    transcript_has_text: (transcript?.utterances || []).some((utterance) => utterance.text.trim().length > 0),
    confirmed_end_recorded: !!endConfirmed && session.stop_reason === 'meeting_end_confirmed',
    stop_immediate_after_confirmation: stoppedAfterConfirmationMs !== null && stoppedAfterConfirmationMs >= 0 && stoppedAfterConfirmationMs <= 2_000,
    formalized: formal?.artifact?.finality === 'final' || formal?.artifact?.finality === 'partial',
  };
  const dedupeEvaluation = options.dedupeLabels && formal?.artifact?.raw_utterances
    && formal.artifact.derived_utterances && formal.artifact.duplicate_assessments
    ? evaluateTranscriptDedupe(formal.artifact, options.dedupeLabels)
    : null;

  return {
    schema_version: 'inkloop.real_meeting_media_acceptance.v1',
    generated_at_ms: options.now ?? Date.now(),
    ok: Object.values(gates).every(Boolean),
    session: {
      session_id: sessionId,
      platform: session.platform,
      meeting_ref: session.meeting_ref,
      start_mode: session.start_mode,
      status: session.status,
      stop_reason: session.stop_reason || null,
      duration_ms: duration(session),
      end_signal: endConfirmed?.evidence?.signal || null,
      stopped_after_confirmation_ms: stoppedAfterConfirmationMs,
    },
    tracks,
    delivery: {
      chunk_count: chunks.length,
      acknowledgement_count: Object.keys(acknowledgements).length,
      pending_chunk_count: Object.keys(outbox?.pending || {}).length,
      completed_asr_chunk_count: Object.keys(outbox?.completed || {}).length,
    },
    performance: {
      first_server_ack_after_registration_ms: difference(
        telemetry?.first_chunk_received_at_ms,
        telemetry?.registered_at_ms,
      ),
      ack_p50_persist_ms: percentile(telemetry?.ack_persist_duration_ms || [], 0.5),
      ack_p95_persist_ms: percentile(telemetry?.ack_persist_duration_ms || [], 0.95),
      provider_p50_ms: percentile(telemetry?.provider_duration_ms || [], 0.5),
      provider_p95_ms: percentile(telemetry?.provider_duration_ms || [], 0.95),
      realtime_provider_p50_ms: percentile(telemetry?.realtime_provider_duration_ms || [], 0.5),
      realtime_provider_p95_ms: percentile(telemetry?.realtime_provider_duration_ms || [], 0.95),
      first_provisional_after_first_chunk_ms: difference(
        telemetry?.first_provisional_at_ms,
        telemetry?.first_chunk_received_at_ms,
      ),
      asr_drain_after_last_ack_ms: difference(
        telemetry?.asr_drained_at_ms,
        telemetry?.last_chunk_acknowledged_at_ms,
      ),
      formal_after_asr_drain_ms: difference(
        telemetry?.formalized_at_ms,
        telemetry?.asr_drained_at_ms,
      ),
      peak_pending_chunk_count: telemetry?.peak_pending_chunk_count ?? null,
      replay_count: telemetry?.replay_count ?? null,
      provider_attempt_count: telemetry?.provider_attempt_count ?? null,
      provider_failure_count: telemetry?.provider_failure_count ?? null,
      provider_timeout_count: telemetry?.provider_timeout_count ?? null,
    },
    asr_runtime: {
      realtime_frame_count: telemetry?.realtime_frame_count ?? null,
      realtime_audio_duration_ms: telemetry?.realtime_audio_duration_ms ?? null,
      realtime_provider_ids: telemetry?.realtime_provider_ids || {},
      realtime_audio_derivations: telemetry?.realtime_audio_derivations || {},
      formal_converger_id: telemetry?.formal_converger_id || null,
    },
    transcript: {
      status: transcript?.status || null,
      revision: transcript?.revision ?? null,
      utterance_count: transcript?.utterances?.length || 0,
      mic_utterance_count: transcript?.utterances?.filter((utterance) => utterance.track === 'mic').length || 0,
      remote_utterance_count: transcript?.utterances?.filter((utterance) => utterance.track === 'remote').length || 0,
      formal_finality: formal?.artifact?.finality || null,
      missing_chunk_ids: formal?.artifact?.missing_chunk_ids || [],
      dedupe_metrics: formal?.artifact?.dedupe_metrics || null,
      dedupe_evaluation: dedupeEvaluation,
    },
    gates,
    paths: {
      local_session: localDirectory,
      server_session: serverDirectory,
    },
  };
}

function parseArgs(argv: string[]) {
  const defaults = {
    session: 'latest',
    localRoot: resolve(homedir(), 'Library/Application Support/InkLoop/MeetingEvidence'),
    serverRoot: resolve('.inkloop/meeting-media'),
    tenantId: process.env.INKLOOP_LOCAL_AUTH_TENANT_ID || process.env.INKLOOP_TENANT_ID || 'local',
    userId: process.env.INKLOOP_LOCAL_AUTH_USER_ID || process.env.INKLOOP_USER_ID || 'local_demo',
  };
  let out: string | undefined;
  let dedupeLabelsPath: string | undefined;
  const supported = new Set([
    '--session',
    '--local-root',
    '--server-root',
    '--tenant',
    '--user',
    '--out',
    '--dedupe-labels',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!supported.has(flag)) throw new Error(`unknown_argument:${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${flag}`);
    switch (flag) {
    case '--session': defaults.session = value; index += 1; break;
    case '--local-root': defaults.localRoot = resolve(value); index += 1; break;
    case '--server-root': defaults.serverRoot = resolve(value); index += 1; break;
    case '--tenant': defaults.tenantId = value; index += 1; break;
    case '--user': defaults.userId = value; index += 1; break;
    case '--out': out = resolve(value); index += 1; break;
    case '--dedupe-labels': dedupeLabelsPath = resolve(value); index += 1; break;
    default: throw new Error(`unknown_argument:${flag}`);
    }
  }
  if (!defaults.session || !defaults.tenantId || !defaults.userId) throw new Error('real_meeting_media_scope_required');
  return { options: defaults, out, dedupeLabelsPath };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write('usage: accept-real-meeting-media [--session latest|<uuid>] [--out report.json]\n');
    return;
  }
  const { options, out, dedupeLabelsPath } = parseArgs(argv);
  const dedupeLabels = dedupeLabelsPath
    ? JSON.parse(await readFile(dedupeLabelsPath, 'utf8')) as LabeledDedupePair[]
    : undefined;
  const report = await analyzeRealMeetingMedia({ ...options, dedupeLabels });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) await writeFile(out, json, 'utf8');
  process.stdout.write(out
    ? `${JSON.stringify({ output: out, session_id: report.session.session_id, ok: report.ok })}\n`
    : json);
  if (!report.ok) process.exitCode = 1;
}

if (basename(process.argv[1] || '') === basename(import.meta.filename)) {
  void main().catch((error) => {
    console.error(String((error as Error).message || error));
    process.exitCode = 2;
  });
}
