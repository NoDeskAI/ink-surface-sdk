import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
  MEETING_TRANSCRIPT_SCHEMA_VERSION,
  acknowledgeChunk,
  assertMeetingAudioChunk,
  assertMeetingRealtimeAudioFrame,
  createChunkDeliveryState,
  recordChunk,
  upsertProvisionalUtterance,
  type MeetingAudioChunk,
  type MeetingAudioChunkAcknowledgement,
  type MeetingAudioTrack,
  type MeetingChunkDeliveryState,
  type MeetingRealtimeAudioFrame,
  type MeetingTranscriptState,
  type MeetingUtterance,
} from '../../../../packages/meeting-media-core/src/index';
import type {
  FormalTranscriptConverger,
  StreamingAsrChunkInput,
  StreamingAsrProviderRouter,
} from './provider';
import { inferAcousticCrossTrackDuplicateAssessments } from './acoustic-dedupe';
import {
  buildFormalTranscriptArtifact,
  type CrossTrackDuplicateAssessment,
  type FormalTranscriptArtifact,
  type SpeakerIdentityMatch,
} from './transcript-finalizer';

export interface MeetingMediaIdentity {
  tenant_id: string;
  user_id: string;
  device_id?: string;
}

interface PendingProviderChunk {
  chunk: MeetingAudioChunk;
  attempts: number;
  next_attempt_at_ms?: number;
  last_error?: string;
  provider_result?: MeetingUtterance[];
  terminal?: boolean;
  terminal_at_ms?: number;
}

interface ProviderOutboxState {
  schema_version: 'inkloop.meeting_asr_outbox.v1';
  identity: MeetingMediaIdentity;
  pending: Record<string, PendingProviderChunk>;
  failed: Record<string, PendingProviderChunk>;
  completed: Record<string, { provider_id: string; completed_at_ms: number }>;
}

export interface MeetingMediaIngressOptions {
  root: string;
  providers: StreamingAsrProviderRouter;
  formal_converger?: FormalTranscriptConverger;
  now?: () => number;
  auto_process?: boolean;
  provider_timeout_ms?: number;
  realtime_provider_timeout_ms?: number;
  provider_max_attempts?: number;
  provider_retry_base_ms?: number;
  provider_retry_max_ms?: number;
  recorder_lease_required?: boolean;
  resolve_meeting_document_id?: (
    identity: MeetingMediaIdentity,
    input: RegisterMeetingMediaSessionInput,
  ) => string
    | { meeting_document_id: string; provider_occurrence_id?: string }
    | null
    | Promise<string | { meeting_document_id: string; provider_occurrence_id?: string } | null>;
}

export interface IngestMeetingChunkInput extends MeetingMediaIdentity {
  chunk: MeetingAudioChunk;
  audio: Uint8Array;
  meeting_ref?: string;
  recorder_device_id?: string;
  recorder_lease_token?: string;
}

export interface IngestMeetingChunkResult {
  acknowledgement: MeetingAudioChunkAcknowledgement;
  replay: boolean;
}

export interface IngestRealtimeAudioFrameInput extends MeetingMediaIdentity {
  frame: MeetingRealtimeAudioFrame;
  audio: Uint8Array;
  meeting_ref?: string;
  recorder_device_id?: string;
  recorder_lease_token?: string;
}

const DELIVERY_FILE = 'delivery.json';
const OUTBOX_FILE = 'provider-outbox.json';
const REALTIME_ASR_STATE_FILE = 'realtime-asr-state.json';
const TRANSCRIPT_FILE = 'transcript.json';
const FORMAL_TRANSCRIPT_FILE = 'formal-transcript.json';
const FINALIZE_INTENT_FILE = 'finalize-intent.json';
const RAW_MEDIA_LIFECYCLE_FILE = 'raw-media-lifecycle.json';
const SESSION_SCOPE_FILE = 'session-scope.json';
const TELEMETRY_FILE = 'telemetry.json';
const RECORDER_LEASE_DIRECTORY = '.recorder-leases';
const DELETED_SESSION_DIRECTORY = '.deleted-sessions';
const MEETING_DELETION_DIRECTORY = '.meeting-deletions';
const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;
const DEFAULT_REALTIME_PROVIDER_TIMEOUT_MS = 5_000;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 1_000;
const DEFAULT_PROVIDER_RETRY_MAX_MS = 60_000;
const DEFAULT_PROVIDER_MAX_ATTEMPTS = 5;
const DEFAULT_RECORDER_LEASE_TTL_MS = 30_000;
const MIN_RECORDER_LEASE_TTL_MS = 15_000;
const MAX_RECORDER_LEASE_TTL_MS = 120_000;
// Durable fact chunks are five seconds long. A 24-hour ceiling keeps a
// malformed finalize manifest from allocating an attacker-controlled array.
const MAX_EXPECTED_LAST_SEQUENCE = 17_279;

interface FormalTranscriptRecord {
  schema_version: 'inkloop.formal_transcript_record.v1';
  convergence_fingerprint: string;
  artifact: FormalTranscriptArtifact;
}

interface RawMediaLifecycleRecord {
  schema_version: 'inkloop.raw_media_lifecycle.v1';
  status: 'deleting' | 'deleted' | 'delete_failed';
  reason: 'formal_transcript_terminal' | 'user_requested';
  updated_at_ms: number;
  abandoned_chunk_ids?: string[];
  error?: string;
}

interface RealtimeAsrState {
  schema_version: 'inkloop.meeting_realtime_asr_state.v1';
  tracks: Partial<Record<MeetingAudioTrack, {
    last_frame_sequence: number;
    last_end_monotonic_ms: number;
    last_source_chunk_id?: string;
    incomplete_source_chunk_ids?: string[];
  }>>;
}

export interface MeetingMediaSessionTelemetry {
  schema_version: 'inkloop.meeting_media_telemetry.v1';
  registered_at_ms?: number;
  first_chunk_received_at_ms?: number;
  last_chunk_acknowledged_at_ms?: number;
  acknowledgement_count: number;
  replay_count: number;
  peak_pending_chunk_count: number;
  ack_persist_duration_ms: number[];
  provider_attempt_count: number;
  provider_failure_count: number;
  provider_timeout_count: number;
  provider_duration_ms: number[];
  realtime_frame_count: number;
  realtime_audio_duration_ms: number;
  realtime_provider_duration_ms: number[];
  realtime_provider_ids: Partial<Record<MeetingAudioTrack, string>>;
  realtime_audio_derivations: Partial<Record<MeetingAudioTrack, string>>;
  formal_converger_id?: string;
  first_provisional_at_ms?: number;
  asr_drained_at_ms?: number;
  formalized_at_ms?: number;
}

export interface MeetingDeletionCommand {
  schema_version: 'inkloop.meeting_deletion_command.v1';
  command_id: string;
  meeting_doc_id: string;
  meeting_refs: string[];
  required_device_ids: string[];
  requested_at_ms: number;
  occurrence_started_at_ms?: number;
  occurrence_ended_at_ms?: number;
  device_acknowledgements: Record<string, {
    acknowledged_at_ms: number;
    deleted_session_ids: string[];
  }>;
}

interface DeletedMeetingSessionRecord {
  schema_version: 'inkloop.deleted_meeting_session.v1';
  session_id: string;
  meeting_doc_id: string;
  command_id: string;
  deleted_at_ms: number;
}

interface FinalizeIntentRecord {
  schema_version: 'inkloop.meeting_finalize_intent.v1';
  request: MeetingMediaFinalizeRequest;
  expected_tracks: Array<'mic' | 'remote'>;
  expected_last_sequence: Partial<Record<'mic' | 'remote', number>>;
  known_missing_chunk_ids: string[];
  duplicate_assessments: CrossTrackDuplicateAssessment[];
  duplicate_assessment_source?: 'external_request' | 'acoustic_adapter';
  acoustic_dedupe_input_fingerprint?: string;
  speaker_identity_matches: SpeakerIdentityMatch[];
  notified_convergence_fingerprint?: string;
  notification_attempts?: number;
  next_notification_attempt_at_ms?: number;
  last_notification_error?: string;
}

export interface MeetingMediaSessionScope {
  schema_version: 'inkloop.meeting_media_session_scope.v1';
  session_id: string;
  platform: 'google_meet' | 'zoom';
  meeting_ref: string;
  meeting_doc_id: string;
  provider_occurrence_id?: string;
  status: 'recording' | 'paused' | 'sealed';
  started_at_ms?: number;
  ended_at_ms?: number;
  recorder_device_id?: string;
  updated_at_ms: number;
}

export interface RegisterMeetingMediaSessionInput {
  session_id: string;
  platform: 'google_meet' | 'zoom';
  meeting_ref: string;
  status: 'recording' | 'paused' | 'sealed';
  started_at_ms?: number;
  ended_at_ms?: number;
  recorder_device_id?: string;
  recorder_lease_token?: string;
}

export interface RecorderLeaseClaimInput {
  meeting_ref: string;
  session_id: string;
  device_id: string;
  ttl_ms?: number;
}

export interface RecorderLeaseRenewInput extends RecorderLeaseClaimInput {
  lease_token: string;
}

export interface RecorderLeaseGrant {
  schema_version: 'inkloop.meeting_recorder_lease.v1';
  granted: boolean;
  meeting_ref: string;
  owner_session_id: string;
  owner_device_id: string;
  acquired_at_ms: number;
  expires_at_ms: number;
  retry_after_ms: number;
  lease_token?: string;
}

export interface AcknowledgeMeetingDeletionInput {
  command_id: string;
  device_id: string;
  deleted_session_ids?: string[];
}

export interface LocalMeetingDeletionCandidate {
  meeting_ref: string;
  started_at_ms?: number;
  ended_at_ms?: number;
}

interface RecorderLeaseRecord {
  schema_version: 'inkloop.meeting_recorder_lease_record.v1';
  meeting_ref: string;
  owner_user_id: string;
  owner_session_id: string;
  owner_device_id: string;
  lease_token: string;
  acquired_at_ms: number;
  renewed_at_ms: number;
  expires_at_ms: number;
  ttl_ms: number;
  released_at_ms?: number;
}

function meetingDocumentId(meetingReference: string): string {
  const [platform, reference] = meetingReference.split(':', 2);
  if ((platform !== 'google_meet' && platform !== 'zoom')
    || !reference
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(reference)) {
    throw Object.assign(new Error('meeting_media_meeting_reference_invalid'), { status: 400 });
  }
  return `mtgdoc_${reference}`;
}

function recorderLeaseSubject(value: string, code: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) {
    throw Object.assign(new Error(code), { status: 400 });
  }
  return normalized;
}

function recorderLeaseTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECORDER_LEASE_TTL_MS;
  if (!Number.isFinite(value) || value < MIN_RECORDER_LEASE_TTL_MS || value > MAX_RECORDER_LEASE_TTL_MS) {
    throw Object.assign(new Error('meeting_media_recorder_lease_ttl_invalid'), { status: 400 });
  }
  return Math.floor(value);
}

function validatedMeetingDocumentId(value: string | null | undefined): string | null {
  const raw = String(value || '').trim();
  return /^mtgdoc_[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(raw) ? raw : null;
}

function encodedSegment(value: string): string {
  if (!value) throw Object.assign(new Error('meeting_media_scope_required'), { status: 400 });
  return Buffer.from(value, 'utf8').toString('base64url');
}

function checksum(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const MEETING_OCCURRENCE_MATCH_TOLERANCE_MS = 6 * 60 * 60 * 1_000;

function deletionOccurrenceMatches(
  command: { occurrence_started_at_ms?: number; occurrence_ended_at_ms?: number },
  candidateStartedAtMs?: number,
  candidateEndedAtMs?: number,
): boolean {
  const commandStart = Number(command.occurrence_started_at_ms);
  const candidateStart = Number(candidateStartedAtMs);
  if (Number.isFinite(commandStart) && Number.isFinite(candidateStart)) {
    return Math.abs(commandStart - candidateStart) <= MEETING_OCCURRENCE_MATCH_TOLERANCE_MS;
  }
  const commandEnd = Number(command.occurrence_ended_at_ms);
  const candidateEnd = Number(candidateEndedAtMs);
  if (Number.isFinite(commandEnd) && Number.isFinite(candidateEnd)) {
    return Math.abs(commandEnd - candidateEnd) <= MEETING_OCCURRENCE_MATCH_TOLERANCE_MS;
  }
  // Legacy and completely offline evidence may not have a server-side time
  // anchor. In that case reference equality remains the only recoverable key.
  return true;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function validateExpectedTracks(input?: Array<'mic' | 'remote'>): Array<'mic' | 'remote'> {
  const tracks = input === undefined ? ['mic', 'remote'] as Array<'mic' | 'remote'> : [...new Set(input)];
  if (tracks.length === 0 || tracks.some((track) => track !== 'mic' && track !== 'remote')) {
    throw Object.assign(new Error('meeting_media_expected_tracks_invalid'), { status: 400 });
  }
  return tracks;
}

function validatedProviderOccurrenceId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512) {
    throw Object.assign(new Error('meeting_media_provider_occurrence_invalid'), { status: 400 });
  }
  return value.trim();
}

function validateExpectedLastSequence(
  tracks: Array<'mic' | 'remote'>,
  input?: Partial<Record<'mic' | 'remote', number>>,
): Partial<Record<'mic' | 'remote', number>> {
  if (!input) throw Object.assign(new Error('meeting_media_sequence_manifest_required'), { status: 400 });
  const result: Partial<Record<'mic' | 'remote', number>> = {};
  for (const track of tracks) {
    const sequence = input[track];
    // An expected track may have produced no chunk at all. Its missing
    // sequence entry is intentional and becomes `missing_track:*` after the
    // persisted delivery state is inspected below.
    if (sequence === undefined) continue;
    if (
      !Number.isInteger(sequence)
      || Number(sequence) < 0
      || Number(sequence) > MAX_EXPECTED_LAST_SEQUENCE
    ) {
      throw Object.assign(new Error('meeting_media_sequence_manifest_invalid'), { status: 400 });
    }
    result[track] = Number(sequence);
  }
  return result;
}

function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  code: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolveWork, rejectWork) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      rejectWork(new Error(code));
    }, timeoutMs);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolveWork(value); },
      (error) => { clearTimeout(timer); rejectWork(error); },
    );
  });
}

function retryableProviderError(error: unknown): boolean {
  const status = Number((error as { status?: number })?.status);
  if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  const message = String((error as Error)?.message || error);
  if (/streaming_asr_http_(408|429|5\d\d)\b/.test(message)) return true;
  if (/streaming_asr_http_4\d\d\b|unauthori[sz]ed|forbidden|invalid[_ -]request/i.test(message)) {
    return false;
  }
  // Unknown transport/provider failures are retryable, but the attempt ceiling
  // still guarantees they eventually move to the durable failed collection.
  return true;
}

function currentProviderResult(item: PendingProviderChunk | undefined, fallback: MeetingUtterance[]): MeetingUtterance[] {
  return item?.provider_result || fallback;
}

function boundedTelemetrySample(values: number[], value: number): number[] {
  return [...values, value].slice(-256);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeAtomic(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

function provisionalTranscript(sessionId: string): MeetingTranscriptState {
  return {
    schema_version: MEETING_TRANSCRIPT_SCHEMA_VERSION,
    session_id: sessionId,
    status: 'provisional',
    utterances: [],
    missing_chunks: [],
    revision: 0,
  };
}

function emptyTelemetry(): MeetingMediaSessionTelemetry {
  return {
    schema_version: 'inkloop.meeting_media_telemetry.v1',
    acknowledgement_count: 0,
    replay_count: 0,
    peak_pending_chunk_count: 0,
    ack_persist_duration_ms: [],
    provider_attempt_count: 0,
    provider_failure_count: 0,
    provider_timeout_count: 0,
    provider_duration_ms: [],
    realtime_frame_count: 0,
    realtime_audio_duration_ms: 0,
    realtime_provider_duration_ms: [],
    realtime_provider_ids: {},
    realtime_audio_derivations: {},
  };
}

function scopedIdentity(identity: MeetingMediaIdentity): MeetingMediaIdentity {
  // IngestMeetingChunkInput structurally extends MeetingMediaIdentity. Keep
  // only the scope fields in durable metadata; otherwise JSON.stringify would
  // duplicate the entire raw Uint8Array inside provider-outbox.json.
  return { tenant_id: identity.tenant_id, user_id: identity.user_id };
}

function authenticatedRecorderDevice(identity: MeetingMediaIdentity, requested: string): string {
  const deviceId = recorderLeaseSubject(requested, 'meeting_media_recorder_device_invalid');
  if (identity.device_id && identity.device_id !== deviceId) {
    throw Object.assign(new Error('meeting_media_recorder_device_mismatch'), { status: 403 });
  }
  return identity.device_id || deviceId;
}

function emptyOutbox(identity: MeetingMediaIdentity): ProviderOutboxState {
  return {
    schema_version: 'inkloop.meeting_asr_outbox.v1',
    identity: scopedIdentity(identity),
    pending: {},
    failed: {},
    completed: {},
  };
}

function normalizedOutbox(outbox: ProviderOutboxState): ProviderOutboxState {
  return {
    ...outbox,
    identity: scopedIdentity(outbox.identity),
    pending: outbox.pending || {},
    failed: outbox.failed || {},
    completed: outbox.completed || {},
  };
}

export class MeetingMediaStreamingIngress {
  private readonly root: string;
  private readonly now: () => number;
  private readonly autoProcess: boolean;
  private readonly providerTimeoutMs: number;
  private readonly realtimeProviderTimeoutMs: number;
  private readonly providerMaxAttempts: number;
  private readonly providerRetryBaseMs: number;
  private readonly providerRetryMaxMs: number;
  private readonly recorderLeaseRequired: boolean;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly realtimeProviderLocks = new Map<string, Promise<void>>();
  private readonly providerJobs = new Map<string, Promise<void>>();
  private readonly providerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly migratedLegacyDeletionTenants = new Set<string>();
  private formalTranscriptHandler?: (input: { identity: MeetingMediaIdentity; artifact: FormalTranscriptArtifact; request: MeetingMediaFinalizeRequest }) => Promise<unknown>;

  constructor(private readonly options: MeetingMediaIngressOptions) {
    this.root = resolve(options.root);
    this.now = options.now || Date.now;
    this.autoProcess = options.auto_process !== false;
    this.providerTimeoutMs = positiveDuration(options.provider_timeout_ms, DEFAULT_PROVIDER_TIMEOUT_MS);
    this.realtimeProviderTimeoutMs = positiveDuration(
      options.realtime_provider_timeout_ms,
      DEFAULT_REALTIME_PROVIDER_TIMEOUT_MS,
    );
    this.providerMaxAttempts = positiveDuration(
      options.provider_max_attempts,
      DEFAULT_PROVIDER_MAX_ATTEMPTS,
    );
    this.providerRetryBaseMs = positiveDuration(options.provider_retry_base_ms, DEFAULT_PROVIDER_RETRY_BASE_MS);
    this.providerRetryMaxMs = Math.max(this.providerRetryBaseMs, positiveDuration(options.provider_retry_max_ms, DEFAULT_PROVIDER_RETRY_MAX_MS));
    this.recorderLeaseRequired = options.recorder_lease_required === true;
  }

  setFormalTranscriptHandler(handler: (input: { identity: MeetingMediaIdentity; artifact: FormalTranscriptArtifact; request: MeetingMediaFinalizeRequest }) => Promise<unknown>): void {
    this.formalTranscriptHandler = handler;
  }

  async ingest(input: IngestMeetingChunkInput): Promise<IngestMeetingChunkResult> {
    const ingestStartedAt = performance.now();
    assertMeetingAudioChunk(input.chunk);
    if (input.chunk.byte_length !== input.audio.byteLength || input.chunk.checksum !== checksum(input.audio)) {
      throw Object.assign(new Error('meeting_media_chunk_integrity_mismatch'), { status: 422 });
    }
    const ownershipValues = [input.meeting_ref, input.recorder_device_id, input.recorder_lease_token];
    if (this.recorderLeaseRequired && !ownershipValues.every(Boolean)) {
      throw Object.assign(new Error('meeting_media_recorder_lease_required'), { status: 409 });
    }
    if (ownershipValues.some(Boolean)) {
      if (!ownershipValues.every(Boolean)) {
        throw Object.assign(new Error('meeting_media_recorder_lease_required'), { status: 409 });
      }
      await this.assertRecorderLease(input, {
        meeting_ref: input.meeting_ref!,
        session_id: input.chunk.session_id,
        device_id: input.recorder_device_id!,
        lease_token: input.recorder_lease_token!,
      }, true);
    }

    const key = this.sessionKey(input, input.chunk.session_id);
    const result = await this.withSessionLock(key, async () => {
      await this.assertSessionWritable(input, input.chunk.session_id);
      const sessionDirectory = this.sessionDirectory(input, input.chunk.session_id);
      const deliveryPath = resolve(sessionDirectory, DELIVERY_FILE);
      const existingDelivery = await readJson<MeetingChunkDeliveryState>(
        deliveryPath,
        createChunkDeliveryState(input.chunk.session_id),
      );
      const prior = existingDelivery.chunks[`${input.chunk.track}:${input.chunk.sequence}`];
      const recordedDelivery = recordChunk(existingDelivery, input.chunk);
      const acknowledgement = recordedDelivery.acknowledgements[`${input.chunk.track}:${input.chunk.sequence}`] || {
        session_id: input.chunk.session_id,
        track: input.chunk.track,
        sequence: input.chunk.sequence,
        chunk_id: input.chunk.chunk_id,
        checksum: input.chunk.checksum,
        acknowledged_at_ms: this.now(),
      };
      const nextDelivery = acknowledgeChunk(recordedDelivery, acknowledgement);

      const rawMediaLifecycle = await readJson<RawMediaLifecycleRecord | null>(
        resolve(sessionDirectory, RAW_MEDIA_LIFECYCLE_FILE),
        null,
      );
      if (rawMediaLifecycle?.status === 'deleted') {
        if (!prior || !existingDelivery.acknowledgements[`${input.chunk.track}:${input.chunk.sequence}`]) {
          throw Object.assign(new Error('meeting_media_raw_media_deleted'), { status: 410 });
        }
        // The server ACK may have reached the Companion just before it crashed,
        // while the local ACK sidecar did not. Replay the durable identity only;
        // never resurrect raw audio after its privacy lifecycle is terminal.
        await this.recordIngestTelemetry(
          sessionDirectory,
          acknowledgement,
          true,
          Object.keys((await this.providerOutbox(input, input.chunk.session_id)).pending).length,
          ingestStartedAt,
        );
        return { replay: true, acknowledgement };
      }

      await this.persistRawChunk(sessionDirectory, input.chunk, input.audio);
      const outboxPath = resolve(sessionDirectory, OUTBOX_FILE);
      const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(outboxPath, emptyOutbox(input)));
      if (outbox.identity.tenant_id !== input.tenant_id || outbox.identity.user_id !== input.user_id) {
        throw Object.assign(new Error('meeting_media_identity_conflict'), { status: 409 });
      }
      const realtimeAsr = await readJson<RealtimeAsrState>(
        resolve(sessionDirectory, REALTIME_ASR_STATE_FILE),
        { schema_version: 'inkloop.meeting_realtime_asr_state.v1', tracks: {} },
      );
      const realtimeCovered = (realtimeAsr.tracks[input.chunk.track]?.last_end_monotonic_ms || -1)
        >= input.chunk.end_monotonic_ms
        && !(realtimeAsr.tracks[input.chunk.track]?.incomplete_source_chunk_ids || [])
          .includes(input.chunk.chunk_id);
      if (!realtimeCovered && !outbox.completed[input.chunk.chunk_id] && !outbox.pending[input.chunk.chunk_id]) {
        outbox.pending[input.chunk.chunk_id] = { chunk: input.chunk, attempts: 0 };
      }

      // ACK is only returned after raw media, delivery state, and the durable
      // ASR outbox have all reached disk.
      await writeAtomic(outboxPath, `${JSON.stringify(outbox, null, 2)}\n`);
      await writeAtomic(deliveryPath, `${JSON.stringify(nextDelivery, null, 2)}\n`);
      await this.recordIngestTelemetry(
        sessionDirectory,
        acknowledgement,
        !!prior,
        Object.keys(outbox.pending).length,
        ingestStartedAt,
      );
      return { replay: !!prior, acknowledgement };
    });

    if (this.autoProcess) queueMicrotask(() => this.queueProviderDrain(input, input.chunk.session_id));
    return {
      replay: result.replay,
      acknowledgement: result.acknowledgement,
    };
  }

  async ingestRealtimeFrame(input: IngestRealtimeAudioFrameInput): Promise<{
    accepted: true;
    utterances: MeetingUtterance[];
  }> {
    try {
      assertMeetingRealtimeAudioFrame(input.frame);
    } catch {
      throw Object.assign(new Error('meeting_media_realtime_frame_invalid'), { status: 400 });
    }
    if ((input.frame.speech_present !== false && input.audio.byteLength === 0)
      || (input.frame.speech_present === false && input.audio.byteLength !== 0)
      || input.audio.byteLength % 2 !== 0) {
      throw Object.assign(new Error('meeting_media_realtime_frame_invalid'), { status: 400 });
    }
    await this.assertSessionWritable(input, input.frame.session_id);
    const ownershipValues = [input.meeting_ref, input.recorder_device_id, input.recorder_lease_token];
    if (this.recorderLeaseRequired && !ownershipValues.every(Boolean)) {
      throw Object.assign(new Error('meeting_media_recorder_lease_required'), { status: 409 });
    }
    if (ownershipValues.some(Boolean)) {
      if (!ownershipValues.every(Boolean)) {
        throw Object.assign(new Error('meeting_media_recorder_lease_required'), { status: 409 });
      }
      await this.assertRecorderLease(input, {
        meeting_ref: input.meeting_ref!,
        session_id: input.frame.session_id,
        device_id: input.recorder_device_id!,
        lease_token: input.recorder_lease_token!,
      }, true);
    }
    const key = this.sessionKey(input, input.frame.session_id);
    return await this.withRealtimeProviderLock(`${key}\u0000${input.frame.track}`, async () => {
    const sessionDirectory = this.sessionDirectory(input, input.frame.session_id);
    const disposition = await this.withSessionLock(key, async () => {
      const path = resolve(sessionDirectory, REALTIME_ASR_STATE_FILE);
      const state = await readJson<RealtimeAsrState>(
        path,
        { schema_version: 'inkloop.meeting_realtime_asr_state.v1', tracks: {} },
      );
      const prior = state.tracks[input.frame.track];
      if (prior && input.frame.frame_sequence <= prior.last_frame_sequence) return 'replay';
      const expectedSequence = prior ? prior.last_frame_sequence + 1 : 0;
      return input.frame.frame_sequence === expectedSequence ? 'next' : 'gap';
    });
    if (disposition === 'replay') return { accepted: true, utterances: [] };
    if (disposition === 'gap') {
      await this.withSessionLock(key, async () => {
        const statePath = resolve(sessionDirectory, REALTIME_ASR_STATE_FILE);
        const state = await readJson<RealtimeAsrState>(
          statePath,
          { schema_version: 'inkloop.meeting_realtime_asr_state.v1', tracks: {} },
        );
        const prior = state.tracks[input.frame.track];
        if (prior && input.frame.frame_sequence <= prior.last_frame_sequence) return;
        state.tracks[input.frame.track] = {
          last_frame_sequence: input.frame.frame_sequence,
          last_end_monotonic_ms: Math.max(
            prior?.last_end_monotonic_ms || 0,
            input.frame.end_monotonic_ms,
          ),
          incomplete_source_chunk_ids: [
            ...new Set([
              ...(prior?.incomplete_source_chunk_ids || []),
              ...(prior?.last_source_chunk_id ? [prior.last_source_chunk_id] : []),
              input.frame.source_chunk_id,
            ]),
          ],
          last_source_chunk_id: input.frame.source_chunk_id,
        };
        await writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
      });
      return { accepted: true, utterances: [] };
    }
    const realtimeProvider = this.options.providers.providerFor(input.frame.track);
    const providerStartedAt = performance.now();
    const providerInput: StreamingAsrChunkInput = {
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        speech_present: input.frame.speech_present,
        chunk: {
          schema_version: 'inkloop.meeting_audio_chunk.v1',
          chunk_id: input.frame.source_chunk_id,
          session_id: input.frame.session_id,
          track: input.frame.track,
          sequence: input.frame.frame_sequence,
          start_monotonic_ms: input.frame.start_monotonic_ms,
          end_monotonic_ms: input.frame.end_monotonic_ms,
          checksum: checksum(input.audio),
          byte_length: input.audio.byteLength,
          sealed: true,
          codec: input.frame.codec,
          sample_rate_hz: input.frame.sample_rate_hz,
          channel_count: input.frame.channel_count,
        },
        audio: input.audio,
      };
    const abort = new AbortController();
    let providerFailed = false;
    let utterances: MeetingUtterance[] = [];
    try {
      utterances = await withDeadline(
        input.frame.speech_present === false
          ? realtimeProvider.endSpeech?.(providerInput, abort.signal) || Promise.resolve([])
          : realtimeProvider.transcribeChunk(providerInput, abort.signal),
        this.realtimeProviderTimeoutMs,
        'streaming_asr_realtime_provider_timeout',
        () => abort.abort('streaming_asr_realtime_provider_timeout'),
      );
    } catch {
      // Realtime frames are an ephemeral projection. Receipt the failed
      // sequence as incomplete so later durable PCM necessarily enters the
      // fallback provider/formal path instead of turning a timeout into a
      // silent coverage hole.
      providerFailed = true;
    }
    const providerDurationMs = Math.max(0, performance.now() - providerStartedAt);
    await this.withSessionLock(key, async () => {
      const statePath = resolve(sessionDirectory, REALTIME_ASR_STATE_FILE);
      const state = await readJson<RealtimeAsrState>(
        statePath,
        { schema_version: 'inkloop.meeting_realtime_asr_state.v1', tracks: {} },
      );
      const prior = state.tracks[input.frame.track];
      if (prior && input.frame.frame_sequence <= prior.last_frame_sequence) return;
      if (utterances.length > 0) {
        let transcript = await readJson<MeetingTranscriptState>(
          resolve(sessionDirectory, TRANSCRIPT_FILE),
          provisionalTranscript(input.frame.session_id),
        );
        for (const utterance of utterances) transcript = upsertProvisionalUtterance(transcript, utterance);
        await writeAtomic(resolve(sessionDirectory, TRANSCRIPT_FILE), `${JSON.stringify(transcript, null, 2)}\n`);
      }
      const telemetryPath = resolve(sessionDirectory, TELEMETRY_FILE);
      const telemetry = await readJson<MeetingMediaSessionTelemetry>(
        telemetryPath,
        emptyTelemetry(),
      ).catch(() => emptyTelemetry());
      telemetry.realtime_frame_count = (telemetry.realtime_frame_count || 0) + 1;
      telemetry.realtime_audio_duration_ms = (telemetry.realtime_audio_duration_ms || 0) + Math.max(
        0,
        input.frame.end_monotonic_ms - input.frame.start_monotonic_ms,
      );
      telemetry.realtime_provider_duration_ms = boundedTelemetrySample(
        telemetry.realtime_provider_duration_ms || [],
        providerDurationMs,
      );
      telemetry.realtime_provider_ids ||= {};
      telemetry.realtime_provider_ids[input.frame.track] = realtimeProvider.provider_id;
      telemetry.realtime_audio_derivations ||= {};
      telemetry.realtime_audio_derivations[input.frame.track] = input.frame.audio_derivation || 'raw';
      if (utterances.length > 0) telemetry.first_provisional_at_ms ??= this.now();
      await writeAtomic(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`)
        .catch(() => undefined);
      state.tracks[input.frame.track] = {
        last_frame_sequence: input.frame.frame_sequence,
        last_end_monotonic_ms: Math.max(
          prior?.last_end_monotonic_ms || 0,
          input.frame.end_monotonic_ms,
        ),
        incomplete_source_chunk_ids: [
          ...new Set([
            ...(prior?.incomplete_source_chunk_ids || []),
            ...(providerFailed ? [input.frame.source_chunk_id] : []),
            ...(prior && input.frame.frame_sequence !== prior.last_frame_sequence + 1
              ? [
                ...(prior.last_source_chunk_id ? [prior.last_source_chunk_id] : []),
                input.frame.source_chunk_id,
              ]
              : []),
          ]),
        ],
        last_source_chunk_id: input.frame.source_chunk_id,
      };
      await writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    });
    return { accepted: true, utterances };
    });
  }

  async drainProvider(identity: MeetingMediaIdentity, sessionId: string): Promise<void> {
    const key = this.sessionKey(identity, sessionId);
    const active = this.providerJobs.get(key);
    if (active) return await active;
    const job = this.processPendingProviderChunks(identity, sessionId);
    this.providerJobs.set(key, job);
    try {
      await job;
    } finally {
      if (this.providerJobs.get(key) === job) this.providerJobs.delete(key);
    }
  }

  async disposeProviderSession(
    identity: MeetingMediaIdentity,
    sessionId: string,
  ): Promise<void> {
    await this.options.providers.disposeSession({
      tenant_id: identity.tenant_id,
      user_id: identity.user_id,
      session_id: sessionId,
    });
  }

  async transcript(identity: MeetingMediaIdentity, sessionId: string): Promise<MeetingTranscriptState> {
    return await readJson(
      resolve(this.sessionDirectory(identity, sessionId), TRANSCRIPT_FILE),
      provisionalTranscript(sessionId),
    );
  }

  async providerOutbox(identity: MeetingMediaIdentity, sessionId: string): Promise<ProviderOutboxState> {
    return normalizedOutbox(await readJson(
      resolve(this.sessionDirectory(identity, sessionId), OUTBOX_FILE),
      emptyOutbox(identity),
    ));
  }

  async sessionTelemetry(
    identity: MeetingMediaIdentity,
    sessionId: string,
  ): Promise<MeetingMediaSessionTelemetry> {
    return await readJson<MeetingMediaSessionTelemetry>(
      resolve(this.sessionDirectory(identity, sessionId), TELEMETRY_FILE),
      emptyTelemetry(),
    ).catch(() => emptyTelemetry());
  }

  async acquireRecorderLease(
    identity: MeetingMediaIdentity,
    input: RecorderLeaseClaimInput,
  ): Promise<RecorderLeaseGrant> {
    const meetingRef = input.meeting_ref.trim();
    // Reuse the same provider reference validation as session registration.
    meetingDocumentId(meetingRef);
    const sessionId = recorderLeaseSubject(input.session_id, 'meeting_media_recorder_session_invalid');
    const deviceId = authenticatedRecorderDevice(identity, input.device_id);
    const ttl = recorderLeaseTtl(input.ttl_ms);
    const key = this.recorderLeaseKey(identity, meetingRef);
    return await this.withSessionLock(key, async () => {
      const path = this.recorderLeasePath(identity, meetingRef);
      const existing = await readJson<RecorderLeaseRecord | null>(path, null);
      const now = this.now();
      const active = existing && !existing.released_at_ms && existing.expires_at_ms > now;
      const sameOwner = active
        && existing.owner_user_id === identity.user_id
        && existing.owner_session_id === sessionId
        && existing.owner_device_id === deviceId;
      if (active && !sameOwner) return this.recorderLeaseGrant(existing, false, now);

      const record: RecorderLeaseRecord = sameOwner ? {
        ...existing,
        renewed_at_ms: now,
        expires_at_ms: now + ttl,
        ttl_ms: ttl,
      } : {
        schema_version: 'inkloop.meeting_recorder_lease_record.v1',
        meeting_ref: meetingRef,
        owner_user_id: identity.user_id,
        owner_session_id: sessionId,
        owner_device_id: deviceId,
        lease_token: randomUUID(),
        acquired_at_ms: now,
        renewed_at_ms: now,
        expires_at_ms: now + ttl,
        ttl_ms: ttl,
      };
      await writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      return this.recorderLeaseGrant(record, true, now);
    });
  }

  async renewRecorderLease(
    identity: MeetingMediaIdentity,
    input: RecorderLeaseRenewInput,
  ): Promise<RecorderLeaseGrant> {
    const meetingRef = input.meeting_ref.trim();
    meetingDocumentId(meetingRef);
    const sessionId = recorderLeaseSubject(input.session_id, 'meeting_media_recorder_session_invalid');
    const deviceId = authenticatedRecorderDevice(identity, input.device_id);
    const token = recorderLeaseSubject(input.lease_token, 'meeting_media_recorder_lease_token_invalid');
    const ttl = recorderLeaseTtl(input.ttl_ms);
    const key = this.recorderLeaseKey(identity, meetingRef);
    return await this.withSessionLock(key, async () => {
      const path = this.recorderLeasePath(identity, meetingRef);
      const existing = await readJson<RecorderLeaseRecord | null>(path, null);
      const now = this.now();
      if (!existing
        || existing.released_at_ms
        || existing.expires_at_ms <= now
        || existing.owner_user_id !== identity.user_id
        || existing.owner_session_id !== sessionId
        || existing.owner_device_id !== deviceId
        || existing.lease_token !== token) {
        throw Object.assign(new Error('meeting_media_recorder_lease_invalid'), { status: 409 });
      }
      const renewed: RecorderLeaseRecord = {
        ...existing,
        renewed_at_ms: now,
        expires_at_ms: now + ttl,
        ttl_ms: ttl,
      };
      await writeAtomic(path, `${JSON.stringify(renewed, null, 2)}\n`);
      return this.recorderLeaseGrant(renewed, true, now);
    });
  }

  async releaseRecorderLease(
    identity: MeetingMediaIdentity,
    input: RecorderLeaseRenewInput,
  ): Promise<{ released: boolean }> {
    const meetingRef = input.meeting_ref.trim();
    meetingDocumentId(meetingRef);
    const sessionId = recorderLeaseSubject(input.session_id, 'meeting_media_recorder_session_invalid');
    const deviceId = authenticatedRecorderDevice(identity, input.device_id);
    const token = recorderLeaseSubject(input.lease_token, 'meeting_media_recorder_lease_token_invalid');
    const key = this.recorderLeaseKey(identity, meetingRef);
    return await this.withSessionLock(key, async () => {
      const path = this.recorderLeasePath(identity, meetingRef);
      const existing = await readJson<RecorderLeaseRecord | null>(path, null);
      if (!existing || existing.released_at_ms) return { released: false };
      if (existing.owner_user_id !== identity.user_id
        || existing.owner_session_id !== sessionId
        || existing.owner_device_id !== deviceId
        || existing.lease_token !== token) {
        throw Object.assign(new Error('meeting_media_recorder_lease_invalid'), { status: 409 });
      }
      await writeAtomic(path, `${JSON.stringify({ ...existing, released_at_ms: this.now() }, null, 2)}\n`);
      return { released: true };
    });
  }

  async registerSession(
    identity: MeetingMediaIdentity,
    input: RegisterMeetingMediaSessionInput,
  ): Promise<MeetingMediaSessionScope> {
    if (!input.session_id?.trim()
      || (input.platform !== 'google_meet' && input.platform !== 'zoom')
      || !['recording', 'paused', 'sealed'].includes(input.status)) {
      throw Object.assign(new Error('meeting_media_session_scope_invalid'), { status: 400 });
    }
    const sessionId = input.session_id.trim();
    if (this.recorderLeaseRequired && (!input.recorder_device_id || !input.recorder_lease_token)) {
      throw Object.assign(new Error('meeting_media_recorder_lease_required'), { status: 409 });
    }
    if (input.recorder_device_id || input.recorder_lease_token) {
      if (!input.recorder_device_id || !input.recorder_lease_token) {
        throw Object.assign(new Error('meeting_media_recorder_lease_required'), { status: 409 });
      }
      await this.assertRecorderLease(identity, {
        meeting_ref: input.meeting_ref,
        session_id: sessionId,
        device_id: input.recorder_device_id,
        lease_token: input.recorder_lease_token,
      });
    }
    const key = this.sessionKey(identity, sessionId);
    return await this.withSessionLock(key, async () => {
      await this.assertSessionWritable(identity, sessionId);
      const path = resolve(this.sessionDirectory(identity, sessionId), SESSION_SCOPE_FILE);
      const existing = await readJson<MeetingMediaSessionScope | null>(path, null);
      const meetingRef = input.meeting_ref.trim();
      const fallbackMeetingDocId = meetingDocumentId(meetingRef);
      const resolution = await this.options.resolve_meeting_document_id?.(identity, input);
      const resolvedMeetingDocId = validatedMeetingDocumentId(
        typeof resolution === 'string' ? resolution : resolution?.meeting_document_id,
      );
      const providerOccurrenceId = validatedProviderOccurrenceId(
        typeof resolution === 'string' ? undefined : resolution?.provider_occurrence_id,
      ) || existing?.provider_occurrence_id || `${meetingRef}:${input.started_at_ms ?? sessionId}`;
      const meetingDocId = resolvedMeetingDocId || existing?.meeting_doc_id || fallbackMeetingDocId;
      if (await this.findMeetingDeletionCommand(identity, meetingDocId, [meetingRef], input.started_at_ms, input.ended_at_ms)) {
        throw Object.assign(new Error('meeting_media_meeting_deleted'), { status: 410 });
      }
      if (existing && (existing.platform !== input.platform
        || existing.meeting_ref !== meetingRef)) {
        throw Object.assign(new Error('meeting_media_session_scope_conflict'), { status: 409 });
      }
      if (existing?.status === 'sealed' && input.status !== 'sealed') {
        throw Object.assign(new Error('meeting_media_sealed_session_cannot_reopen'), { status: 409 });
      }
      const startedAt = Number.isFinite(input.started_at_ms)
        ? Number(input.started_at_ms)
        : existing?.started_at_ms;
      const endedAt = input.status === 'sealed' && Number.isFinite(input.ended_at_ms)
        ? Number(input.ended_at_ms)
        : existing?.ended_at_ms;
      const scope: MeetingMediaSessionScope = {
        schema_version: 'inkloop.meeting_media_session_scope.v1',
        session_id: sessionId,
        platform: input.platform,
        meeting_ref: meetingRef,
        meeting_doc_id: meetingDocId,
        provider_occurrence_id: providerOccurrenceId,
        status: input.status,
        ...(startedAt === undefined ? {} : { started_at_ms: startedAt }),
        ...(endedAt === undefined ? {} : { ended_at_ms: endedAt }),
        ...(input.recorder_device_id ? { recorder_device_id: input.recorder_device_id } : {}),
        updated_at_ms: this.now(),
      };
      await writeAtomic(path, `${JSON.stringify(scope, null, 2)}\n`);
      const telemetryPath = resolve(this.sessionDirectory(identity, sessionId), TELEMETRY_FILE);
      const telemetry = await readJson<MeetingMediaSessionTelemetry>(telemetryPath, emptyTelemetry())
        .catch(() => emptyTelemetry());
      telemetry.registered_at_ms ??= this.now();
      await writeAtomic(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`).catch(() => undefined);
      return scope;
    });
  }

  async sessionScope(identity: MeetingMediaIdentity, sessionId: string): Promise<MeetingMediaSessionScope | null> {
    return await readJson<MeetingMediaSessionScope | null>(
      resolve(this.sessionDirectory(identity, sessionId), SESSION_SCOPE_FILE),
      null,
    );
  }

  async latestSessionScopeForMeeting(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
  ): Promise<MeetingMediaSessionScope | null> {
    const normalized = validatedMeetingDocumentId(meetingDocId);
    if (!normalized) {
      throw Object.assign(new Error('meeting_media_meeting_document_invalid'), { status: 400 });
    }
    const identityDirectory = resolve(this.root, encodedSegment(identity.tenant_id), encodedSegment(identity.user_id));
    let latest: MeetingMediaSessionScope | null = null;
    for (const encoded of await directories(identityDirectory)) {
      const scope = await readJson<MeetingMediaSessionScope | null>(
        resolve(identityDirectory, encoded, SESSION_SCOPE_FILE),
        null,
      );
      if (scope?.meeting_doc_id !== normalized) continue;
      if (!latest || scope.updated_at_ms > latest.updated_at_ms) latest = scope;
    }
    return latest;
  }

  async latestSessionId(identity: MeetingMediaIdentity): Promise<string | null> {
    const identityDirectory = resolve(this.root, encodedSegment(identity.tenant_id), encodedSegment(identity.user_id));
    const candidates = await directories(identityDirectory);
    let latest: {
      sessionId: string;
      active: boolean;
      logicalUpdatedAt: number;
      modifiedAt: number;
    } | null = null;
    for (const encoded of candidates) {
      if (encoded.startsWith('.')) continue;
      let sessionId: string;
      try { sessionId = Buffer.from(encoded, 'base64url').toString('utf8'); }
      catch { continue; }
      const scopePath = resolve(identityDirectory, encoded, SESSION_SCOPE_FILE);
      const scope = await readJson<MeetingMediaSessionScope | null>(scopePath, null);
      const transcriptPath = resolve(identityDirectory, encoded, TRANSCRIPT_FILE);
      const deliveryPath = resolve(identityDirectory, encoded, DELIVERY_FILE);
      const modifiedAt = Math.max(
        await modifiedAtOrZero(transcriptPath),
        await modifiedAtOrZero(deliveryPath),
        await modifiedAtOrZero(scopePath),
      );
      if (!scope && modifiedAt === 0) continue;
      const candidate = {
        sessionId,
        active: scope?.status === 'recording' || scope?.status === 'paused',
        logicalUpdatedAt: scope?.updated_at_ms || 0,
        modifiedAt,
      };
      if (!latest
        || Number(candidate.active) > Number(latest.active)
        || (candidate.active === latest.active
          && candidate.logicalUpdatedAt > latest.logicalUpdatedAt)
        || (candidate.active === latest.active
          && candidate.logicalUpdatedAt === latest.logicalUpdatedAt
          && candidate.modifiedAt > latest.modifiedAt)) {
        latest = candidate;
      }
    }
    return latest?.sessionId || null;
  }

  async liveStatus(identity: MeetingMediaIdentity): Promise<{
    session_id: string | null;
    active: boolean;
    last_activity_ms: number | null;
    tracks: Array<'mic' | 'remote'>;
    pending_chunks: number;
    transcript: MeetingTranscriptState | null;
    platform?: 'google_meet' | 'zoom';
    meeting_ref?: string;
    meeting_doc_id?: string;
  }> {
    const sessionId = await this.latestSessionId(identity);
    if (!sessionId) return { session_id: null, active: false, last_activity_ms: null, tracks: [], pending_chunks: 0, transcript: null };
    const sessionDirectory = this.sessionDirectory(identity, sessionId);
    const deliveryPath = resolve(sessionDirectory, DELIVERY_FILE);
    const lastActivity = await modifiedAtOrZero(deliveryPath);
    const delivery = await readJson<MeetingChunkDeliveryState>(deliveryPath, createChunkDeliveryState(sessionId));
    const outbox = await this.providerOutbox(identity, sessionId);
    const scope = await this.sessionScope(identity, sessionId);
    return {
      session_id: sessionId,
      active: scope
        ? scope.status === 'recording' || scope.status === 'paused'
        : lastActivity > 0 && this.now() - lastActivity <= 20_000,
      last_activity_ms: lastActivity || null,
      tracks: [...new Set(Object.values(delivery.chunks).map((chunk) => chunk.track))].sort(),
      pending_chunks: Object.keys(outbox.pending).length,
      transcript: Object.keys(delivery.chunks).length > 0
        ? await this.transcript(identity, sessionId)
        : null,
      ...(scope ? {
        platform: scope.platform,
        meeting_ref: scope.meeting_ref,
        meeting_doc_id: scope.meeting_doc_id,
      } : {}),
    };
  }

  async finalizeSession(input: {
    identity: MeetingMediaIdentity;
    session_id: string;
    expected_tracks?: Array<'mic' | 'remote'>;
    expected_last_sequence?: Partial<Record<'mic' | 'remote', number>>;
    known_missing_chunk_ids?: string[];
    duplicate_assessments?: CrossTrackDuplicateAssessment[];
    speaker_identity_matches?: SpeakerIdentityMatch[];
    request?: MeetingMediaFinalizeRequest;
  }): Promise<{ artifact: FormalTranscriptArtifact; replay: boolean; convergence_fingerprint: string; notified: boolean }> {
    const key = this.sessionKey(input.identity, input.session_id);
    return await this.withSessionLock(key, async () => {
      await this.assertSessionWritable(input.identity, input.session_id);
      const sessionDirectory = this.sessionDirectory(input.identity, input.session_id);
      const expectedTracks = validateExpectedTracks(input.expected_tracks);
      const expectedLastSequence = validateExpectedLastSequence(expectedTracks, input.expected_last_sequence);
      const intent: FinalizeIntentRecord = {
        schema_version: 'inkloop.meeting_finalize_intent.v1',
        request: input.request || { session_id: input.session_id, meeting_id: input.session_id },
        expected_tracks: expectedTracks,
        expected_last_sequence: expectedLastSequence,
        known_missing_chunk_ids: [...new Set(input.known_missing_chunk_ids || [])].sort(),
        duplicate_assessments: input.duplicate_assessments || [],
        speaker_identity_matches: input.speaker_identity_matches || [],
      };
      const existingIntent = await readJson<FinalizeIntentRecord | null>(resolve(sessionDirectory, FINALIZE_INTENT_FILE), null);
      const rawMediaLifecycle = await readJson<RawMediaLifecycleRecord | null>(
        resolve(sessionDirectory, RAW_MEDIA_LIFECYCLE_FILE),
        null,
      );
      const existingFormal = await readJson<FormalTranscriptRecord | null>(
        resolve(sessionDirectory, FORMAL_TRANSCRIPT_FILE),
        null,
      );
      if (rawMediaLifecycle?.status === 'deleted' && existingFormal) {
        return {
          artifact: existingFormal.artifact,
          replay: true,
          convergence_fingerprint: existingFormal.convergence_fingerprint,
          notified: existingIntent?.notified_convergence_fingerprint === existingFormal.convergence_fingerprint,
        };
      }
      if (!input.duplicate_assessments?.length && existingIntent?.duplicate_assessments?.length) {
        intent.duplicate_assessments = existingIntent.duplicate_assessments;
        intent.duplicate_assessment_source = existingIntent.duplicate_assessment_source;
        intent.acoustic_dedupe_input_fingerprint = existingIntent.acoustic_dedupe_input_fingerprint;
      }
      if (!input.speaker_identity_matches?.length && existingIntent?.speaker_identity_matches?.length) {
        intent.speaker_identity_matches = existingIntent.speaker_identity_matches;
      }
      intent.notified_convergence_fingerprint = existingIntent?.notified_convergence_fingerprint;
      intent.notification_attempts = existingIntent?.notification_attempts;
      intent.next_notification_attempt_at_ms = existingIntent?.next_notification_attempt_at_ms;
      intent.last_notification_error = existingIntent?.last_notification_error;
      await writeAtomic(resolve(sessionDirectory, FINALIZE_INTENT_FILE), `${JSON.stringify(intent, null, 2)}\n`);
      const delivery = await readJson<MeetingChunkDeliveryState>(
        resolve(sessionDirectory, DELIVERY_FILE),
        createChunkDeliveryState(input.session_id),
      );
      if (Object.keys(delivery.chunks).length === 0) {
        throw Object.assign(new Error('meeting_media_no_chunks'), { status: 409 });
      }
      const transcript = await readJson<MeetingTranscriptState>(
        resolve(sessionDirectory, TRANSCRIPT_FILE),
        provisionalTranscript(input.session_id),
      );
      const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(
        resolve(sessionDirectory, OUTBOX_FILE),
        emptyOutbox(input.identity),
      ));
      const convergedUtterances = this.options.formal_converger
        && Object.keys(outbox.pending).length === 0
        && rawMediaLifecycle?.status !== 'deleted'
        ? await this.options.formal_converger.converge({
          session_id: input.session_id,
          chunks: Object.values(delivery.chunks)
            .sort((left, right) => left.track.localeCompare(right.track) || left.sequence - right.sequence)
            .map((chunk) => ({
              chunk,
              loadAudio: async () => await readFile(this.audioPath(sessionDirectory, chunk)),
            })),
        })
        : undefined;
      const convergenceTranscript = convergedUtterances
        ? convergedUtterances.reduce(
          (state, utterance) => upsertProvisionalUtterance(state, utterance),
          provisionalTranscript(input.session_id),
        )
        : transcript;
      const acousticDedupeInputFingerprint = createHash('sha256').update(canonical({
        utterances: convergenceTranscript.utterances,
        chunks: Object.values(delivery.chunks).map((chunk) => ({
          chunk_id: chunk.chunk_id,
          checksum: chunk.checksum,
          codec: chunk.codec,
          sample_rate_hz: chunk.sample_rate_hz,
          channel_count: chunk.channel_count,
        })),
      })).digest('hex');
      const duplicateAssessments = input.duplicate_assessments?.length
        ? input.duplicate_assessments
        : existingIntent?.duplicate_assessments?.length
          && (existingIntent.duplicate_assessment_source === 'external_request'
            || existingIntent.acoustic_dedupe_input_fingerprint === acousticDedupeInputFingerprint
            || rawMediaLifecycle?.status === 'deleted')
          ? existingIntent.duplicate_assessments
          : await inferAcousticCrossTrackDuplicateAssessments({
            utterances: convergenceTranscript.utterances,
            chunks: Object.values(delivery.chunks),
            loadAudio: async (chunk) => await readFile(this.audioPath(sessionDirectory, chunk))
              .catch(() => null),
          });
      const speakerIdentityMatches = input.speaker_identity_matches?.length
        ? input.speaker_identity_matches
        : existingIntent?.speaker_identity_matches || [];
      // Persist adapter decisions before raw media is eligible for automatic
      // deletion. A replay after deletion must converge from the same audited
      // evidence rather than silently changing to a text-only decision.
      intent.duplicate_assessments = duplicateAssessments;
      intent.duplicate_assessment_source = input.duplicate_assessments?.length
        ? 'external_request'
        : existingIntent?.duplicate_assessment_source === 'external_request'
          ? 'external_request'
          : 'acoustic_adapter';
      intent.acoustic_dedupe_input_fingerprint = intent.duplicate_assessment_source === 'acoustic_adapter'
        ? acousticDedupeInputFingerprint
        : undefined;
      intent.speaker_identity_matches = speakerIdentityMatches;
      await writeAtomic(resolve(sessionDirectory, FINALIZE_INTENT_FILE), `${JSON.stringify(intent, null, 2)}\n`);
      const presentTracks = new Set(Object.values(delivery.chunks).map((chunk) => chunk.track));
      if (expectedTracks.some((track) => presentTracks.has(track) && expectedLastSequence[track] === undefined)) {
        throw Object.assign(new Error('meeting_media_sequence_manifest_invalid'), { status: 400 });
      }
      const missingTracks = expectedTracks
        .filter((track) => !presentTracks.has(track))
        .map((track) => `missing_track:${track}`);
      const internalMissingChunks = expectedTracks.flatMap((track) => {
        const expectedLast = expectedLastSequence[track];
        if (expectedLast === undefined) return [];
        const present = new Set(Object.values(delivery.chunks).filter((chunk) => chunk.track === track).map((chunk) => chunk.sequence));
        const missing: string[] = [];
        for (let sequence = 0; sequence <= expectedLast; sequence += 1) {
          if (!present.has(sequence)) missing.push(`${input.session_id}:${track}:${sequence}`);
        }
        return missing;
      });
      const convergenceInput = {
        transcript: convergenceTranscript,
        formal_converger_id: convergedUtterances ? this.options.formal_converger?.converger_id : undefined,
        delivery,
        provider_pending_chunk_ids: Object.keys(outbox.pending).sort(),
        known_missing_chunk_ids: [...new Set([
          ...(input.known_missing_chunk_ids || []),
          ...(rawMediaLifecycle?.abandoned_chunk_ids || []),
          ...(convergedUtterances ? [] : Object.keys(outbox.failed)),
          ...missingTracks,
          ...internalMissingChunks,
        ])].sort(),
        duplicate_assessments: duplicateAssessments,
        speaker_identity_matches: speakerIdentityMatches,
      };
      const convergenceFingerprint = createHash('sha256').update(canonical(convergenceInput)).digest('hex');
      const formalPath = resolve(sessionDirectory, FORMAL_TRANSCRIPT_FILE);
      const existing = await readJson<FormalTranscriptRecord | null>(formalPath, null);
      const notified = existingIntent?.notified_convergence_fingerprint === convergenceFingerprint;
      if (existing?.convergence_fingerprint === convergenceFingerprint) {
        return { artifact: existing.artifact, replay: true, convergence_fingerprint: convergenceFingerprint, notified };
      }
      const artifact = buildFormalTranscriptArtifact({
        provisional: convergenceTranscript,
        delivery,
        provider_pending_chunk_ids: convergenceInput.provider_pending_chunk_ids,
        known_missing_chunk_ids: convergenceInput.known_missing_chunk_ids,
        duplicate_assessments: convergenceInput.duplicate_assessments,
        speaker_identity_matches: convergenceInput.speaker_identity_matches,
        finalized_at_ms: this.now(),
      });
      const record: FormalTranscriptRecord = {
        schema_version: 'inkloop.formal_transcript_record.v1',
        convergence_fingerprint: convergenceFingerprint,
        artifact,
      };
      await writeAtomic(formalPath, `${JSON.stringify(record, null, 2)}\n`);
      const telemetryPath = resolve(sessionDirectory, TELEMETRY_FILE);
      const telemetry = await readJson<MeetingMediaSessionTelemetry>(telemetryPath, emptyTelemetry())
        .catch(() => emptyTelemetry());
      telemetry.formalized_at_ms = this.now();
      telemetry.formal_converger_id = convergedUtterances
        ? this.options.formal_converger?.converger_id
        : undefined;
      await writeAtomic(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`).catch(() => undefined);
      if (Object.keys(outbox.pending).length === 0 && rawMediaLifecycle?.status !== 'deleted') {
        // Server raw audio is a temporary ASR projection input. Once a
        // terminal formal/partial artifact is durable and no Provider work
        // remains, delete it independently from the user's authoritative Mac
        // copy. A deletion failure is receipted but never rolls back the
        // transcript artifact.
        await this.deleteRawMediaFiles(
          sessionDirectory,
          outbox,
          'formal_transcript_terminal',
        ).catch(() => undefined);
      }
      return { artifact, replay: false, convergence_fingerprint: convergenceFingerprint, notified };
    });
  }

  async markFormalTranscriptNotified(identity: MeetingMediaIdentity, sessionId: string, convergenceFingerprint: string): Promise<void> {
    const key = this.sessionKey(identity, sessionId);
    await this.withSessionLock(key, async () => {
      const path = resolve(this.sessionDirectory(identity, sessionId), FINALIZE_INTENT_FILE);
      const intent = await readJson<FinalizeIntentRecord | null>(path, null);
      if (!intent || intent.notified_convergence_fingerprint === convergenceFingerprint) return;
      intent.notified_convergence_fingerprint = convergenceFingerprint;
      delete intent.notification_attempts;
      delete intent.next_notification_attempt_at_ms;
      delete intent.last_notification_error;
      await writeAtomic(path, `${JSON.stringify(intent, null, 2)}\n`);
    });
  }

  async deleteRawMedia(identity: MeetingMediaIdentity, sessionId: string): Promise<{ deleted: boolean }> {
    const key = this.sessionKey(identity, sessionId);
    const timer = this.providerRetryTimers.get(key);
    if (timer) clearTimeout(timer);
    this.providerRetryTimers.delete(key);
    const active = this.providerJobs.get(key);
    if (active) await active.catch(() => undefined);
    const retryAfterActive = this.providerRetryTimers.get(key);
    if (retryAfterActive) clearTimeout(retryAfterActive);
    this.providerRetryTimers.delete(key);
    const result = await this.withSessionLock(key, async () => {
      const sessionDirectory = this.sessionDirectory(identity, sessionId);
      const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(resolve(sessionDirectory, OUTBOX_FILE), emptyOutbox(identity)));
      await this.deleteRawMediaFiles(sessionDirectory, outbox, 'user_requested');
      return { deleted: true };
    });
    // If formalization already started while Provider work was pending,
    // privacy deletion makes those chunks permanently unavailable to ASR.
    // Recompute and notify a partial artifact instead of allowing an empty
    // queue to masquerade as complete coverage.
    await this.reconvergeSealedSession(identity, sessionId);
    return result;
  }

  async rawMediaLifecycle(
    identity: MeetingMediaIdentity,
    sessionId: string,
  ): Promise<RawMediaLifecycleRecord | null> {
    return await readJson<RawMediaLifecycleRecord | null>(
      resolve(this.sessionDirectory(identity, sessionId), RAW_MEDIA_LIFECYCLE_FILE),
      null,
    );
  }

  async deleteMeetingEvidence(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
    input: { meeting_refs?: string[]; occurrence_started_at_ms?: number; occurrence_ended_at_ms?: number } = {},
  ): Promise<{ command: MeetingDeletionCommand; cloud_sessions_deleted: number; pending_companion: boolean }> {
    const normalized = validatedMeetingDocumentId(meetingDocId);
    if (!normalized) throw Object.assign(new Error('meeting_media_meeting_document_invalid'), { status: 400 });
    await this.migrateLegacyMeetingDeletionCommands(identity);
    const requestedMeetingRefs = [...new Set((input.meeting_refs || []).map((value) => value.trim()).filter(Boolean))].sort();
    for (const meetingRef of requestedMeetingRefs) meetingDocumentId(meetingRef);
    const deletionKey = `${identity.tenant_id}\u0000meeting-deletion\u0000${requestedMeetingRefs.join('\u0001') || normalized}`;
    return await this.withSessionLock(deletionKey, async () => {
      const prior = await this.findMeetingDeletionCommand(identity, normalized, requestedMeetingRefs, input.occurrence_started_at_ms, input.occurrence_ended_at_ms);
      const commandPath = prior
        ? await this.meetingDeletionCommandFilePath(identity, prior.command_id)
          || this.meetingDeletionCommandPath(identity, prior.meeting_doc_id)
        : await this.availableMeetingDeletionCommandPath(identity, normalized);
      const scopes = await this.sessionScopesForDeletion(
        identity, normalized, requestedMeetingRefs,
        input.occurrence_started_at_ms, input.occurrence_ended_at_ms,
      );
      if (scopes.some(({ scope }) => scope.status === 'recording' || scope.status === 'paused')) {
        throw Object.assign(new Error('meeting_media_active_meeting_cannot_delete'), { status: 409 });
      }
      const command: MeetingDeletionCommand = prior || {
        schema_version: 'inkloop.meeting_deletion_command.v1',
        command_id: `meeting_delete_${randomUUID()}`,
        meeting_doc_id: normalized,
        meeting_refs: [...new Set([...requestedMeetingRefs, ...scopes.map(({ scope }) => scope.meeting_ref)])].sort(),
        required_device_ids: [...new Set(scopes.flatMap(({ scope }) => scope.recorder_device_id ? [scope.recorder_device_id] : []))].sort(),
        requested_at_ms: this.now(),
        ...(Number.isFinite(input.occurrence_started_at_ms) ? { occurrence_started_at_ms: Number(input.occurrence_started_at_ms) } : {}),
        ...(Number.isFinite(input.occurrence_ended_at_ms) ? { occurrence_ended_at_ms: Number(input.occurrence_ended_at_ms) } : {}),
        device_acknowledgements: {},
      };
      // The command is the durable tombstone. Persist it before removing any
      // session directory so a concurrent/restarted Companion cannot recreate
      // evidence that the user already asked us to erase.
      if (!prior) await writeAtomic(commandPath, `${JSON.stringify(command, null, 2)}\n`);

      let deleted = 0;
      for (const { identity: owner, scope } of scopes) {
        const key = this.sessionKey(owner, scope.session_id);
        const timer = this.providerRetryTimers.get(key);
        if (timer) clearTimeout(timer);
        this.providerRetryTimers.delete(key);
        const active = this.providerJobs.get(key);
        if (active) await active.catch(() => undefined);
        await this.withSessionLock(key, async () => {
          await rm(this.sessionDirectory(owner, scope.session_id), { recursive: true, force: true });
          const deletedSession: DeletedMeetingSessionRecord = {
            schema_version: 'inkloop.deleted_meeting_session.v1',
            session_id: scope.session_id,
            meeting_doc_id: normalized,
            command_id: command.command_id,
            deleted_at_ms: this.now(),
          };
          await writeAtomic(this.deletedSessionPath(owner, scope.session_id), `${JSON.stringify(deletedSession, null, 2)}\n`);
          deleted += 1;
        });
      }
      const current = await readJson<MeetingDeletionCommand>(commandPath, command);
      return {
        command: current,
        cloud_sessions_deleted: deleted,
        pending_companion: this.meetingDeletionPending(current),
      };
    });
  }

  async meetingDeletionCommand(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
  ): Promise<MeetingDeletionCommand | null> {
    const normalized = validatedMeetingDocumentId(meetingDocId);
    if (!normalized) throw Object.assign(new Error('meeting_media_meeting_document_invalid'), { status: 400 });
    await this.migrateLegacyMeetingDeletionCommands(identity);
    const exact = await readJson<MeetingDeletionCommand | null>(this.meetingDeletionCommandPath(identity, normalized), null);
    if (exact?.meeting_doc_id === normalized) return exact;
    const commands = await this.meetingDeletionCommands(identity);
    return commands
      .filter((command) => command.meeting_doc_id === normalized)
      .sort((left, right) => right.requested_at_ms - left.requested_at_ms)[0] || null;
  }

  async pendingMeetingDeletionCommands(
    identity: MeetingMediaIdentity,
    requestedDeviceId: string,
    localMeetings: Array<string | LocalMeetingDeletionCandidate> = [],
  ): Promise<MeetingDeletionCommand[]> {
    const deviceId = authenticatedRecorderDevice(identity, requestedDeviceId);
    await this.migrateLegacyMeetingDeletionCommands(identity);
    const candidates = localMeetings.map((value) => typeof value === 'string'
      ? { meeting_ref: value.trim() }
      : { meeting_ref: value.meeting_ref.trim(), started_at_ms: value.started_at_ms, ended_at_ms: value.ended_at_ms })
      .filter((value) => !!value.meeting_ref);
    for (const candidate of candidates) meetingDocumentId(candidate.meeting_ref);
    const directory = this.meetingDeletionDirectory(identity);
    const commands: MeetingDeletionCommand[] = [];
    for (const file of await files(directory)) {
      const path = resolve(directory, file);
      const initial = await readJson<MeetingDeletionCommand | null>(path, null);
      if (!initial || initial.device_acknowledgements[deviceId]) continue;
      const matchesLocalEvidence = candidates.some((candidate) => initial.meeting_refs.includes(candidate.meeting_ref)
        && deletionOccurrenceMatches(initial, candidate.started_at_ms, candidate.ended_at_ms));
      if (!initial.required_device_ids.includes(deviceId) && !matchesLocalEvidence) continue;
      const key = `${identity.tenant_id}\u0000meeting-deletion-command\u0000${initial.command_id}`;
      const command = await this.withSessionLock(key, async () => {
        const latest = await readJson<MeetingDeletionCommand | null>(path, null);
        if (!latest || latest.device_acknowledgements[deviceId]) return null;
        if (!latest.required_device_ids.includes(deviceId)) {
          latest.required_device_ids = [...latest.required_device_ids, deviceId].sort();
          await writeAtomic(path, `${JSON.stringify(latest, null, 2)}\n`);
        }
        return latest;
      });
      if (command) commands.push(command);
    }
    return commands.sort((left, right) => left.requested_at_ms - right.requested_at_ms);
  }

  async acknowledgeMeetingDeletion(
    identity: MeetingMediaIdentity,
    input: AcknowledgeMeetingDeletionInput,
  ): Promise<MeetingDeletionCommand> {
    const commandId = recorderLeaseSubject(input.command_id, 'meeting_media_deletion_command_invalid');
    const deviceId = authenticatedRecorderDevice(identity, input.device_id);
    await this.migrateLegacyMeetingDeletionCommands(identity);
    const directory = this.meetingDeletionDirectory(identity);
    for (const file of await files(directory)) {
      const path = resolve(directory, file);
      const command = await readJson<MeetingDeletionCommand | null>(path, null);
      if (command?.command_id !== commandId) continue;
      if (!command.required_device_ids.includes(deviceId)) {
        throw Object.assign(new Error('meeting_media_deletion_device_not_required'), { status: 409 });
      }
      command.device_acknowledgements[deviceId] = {
        acknowledged_at_ms: this.now(),
        deleted_session_ids: [...new Set(input.deleted_session_ids || [])].sort(),
      };
      await writeAtomic(path, `${JSON.stringify(command, null, 2)}\n`);
      return command;
    }
    throw Object.assign(new Error('meeting_media_deletion_command_not_found'), { status: 404 });
  }

  async bootstrapPending(): Promise<number> {
    let queued = 0;
    for (const tenant of await directories(this.root)) {
      for (const user of await directories(resolve(this.root, tenant))) {
        for (const session of await directories(resolve(this.root, tenant, user))) {
          if (session.startsWith('.')) continue;
          const outboxPath = resolve(this.root, tenant, user, session, OUTBOX_FILE);
          const rawOutbox = await readJson<ProviderOutboxState | null>(
            outboxPath,
            null,
          );
          const intent = await readJson<FinalizeIntentRecord | null>(resolve(this.root, tenant, user, session, FINALIZE_INTENT_FILE), null);
          if (!rawOutbox) continue;
          const outbox = normalizedOutbox(rawOutbox);
          if (canonical(rawOutbox.identity) !== canonical(outbox.identity)) {
            await writeAtomic(outboxPath, `${JSON.stringify(outbox, null, 2)}\n`);
          }
          const hasPendingProvider = !!outbox && Object.keys(outbox.pending).length > 0;
          const hasPendingNotification = !!intent && !!this.formalTranscriptHandler && (!intent.notified_convergence_fingerprint || !!intent.next_notification_attempt_at_ms);
          if (!hasPendingProvider && !hasPendingNotification) continue;
          queued += 1;
          this.queueProviderDrain(outbox.identity, Buffer.from(session, 'base64url').toString('utf8'));
        }
      }
    }
    return queued;
  }

  private queueProviderDrain(identity: MeetingMediaIdentity, sessionId: string): void {
    void this.drainProvider(identity, sessionId).catch((error) => {
      console.warn('[meeting-media] provider drain failed', String(error));
    });
  }

  private async processPendingProviderChunks(identity: MeetingMediaIdentity, sessionId: string): Promise<void> {
    const key = this.sessionKey(identity, sessionId);
    const sessionDirectory = this.sessionDirectory(identity, sessionId);
    const outboxPath = resolve(sessionDirectory, OUTBOX_FILE);
    const pending = await this.withSessionLock(key, async () => {
      const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(outboxPath, emptyOutbox(identity)));
      return Object.values(outbox.pending).filter((item) =>
        !item.terminal && (item.next_attempt_at_ms || 0) <= this.now()).sort(
        (left, right) => left.chunk.track.localeCompare(right.chunk.track) || left.chunk.sequence - right.chunk.sequence,
      );
    });

    // Provider work deliberately happens outside the session write lock, so a
    // slow or failed ASR request cannot block later audio chunks from reaching
    // durable local storage and receiving an ACK.
    for (const item of pending) {
      const provider = this.options.providers.providerFor(item.chunk.track);
      const providerStartedAt = performance.now();
      let providerInvoked = false;
      let providerFailed = false;
      try {
        let utterances = item.provider_result;
        if (!utterances) {
          const audio = await readFile(this.audioPath(sessionDirectory, item.chunk));
          providerInvoked = true;
          const abort = new AbortController();
          try {
            utterances = await withDeadline(
              provider.transcribeChunk({ ...identity, chunk: item.chunk, audio }, abort.signal),
              this.providerTimeoutMs,
              'streaming_asr_provider_timeout',
              () => abort.abort('streaming_asr_provider_timeout'),
            );
          } catch (error) {
            providerFailed = true;
            throw error;
          }
          await this.withSessionLock(key, async () => {
            const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(outboxPath, emptyOutbox(identity)));
            const current = outbox.pending[item.chunk.chunk_id];
            if (!current) return;
            current.provider_result = utterances;
            await writeAtomic(outboxPath, `${JSON.stringify(outbox, null, 2)}\n`);
          });
        }
        await this.withSessionLock(key, async () => {
          const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(outboxPath, emptyOutbox(identity)));
          if (!outbox.pending[item.chunk.chunk_id]) return;
          let transcript = await readJson<MeetingTranscriptState>(
            resolve(sessionDirectory, TRANSCRIPT_FILE),
            provisionalTranscript(sessionId),
          );
          for (const utterance of currentProviderResult(outbox.pending[item.chunk.chunk_id], utterances)) transcript = upsertProvisionalUtterance(transcript, utterance);
          delete outbox.pending[item.chunk.chunk_id];
          outbox.completed[item.chunk.chunk_id] = { provider_id: provider.provider_id, completed_at_ms: this.now() };
          outbox.completed = Object.fromEntries(
            Object.entries(outbox.completed)
              .sort((left, right) => right[1].completed_at_ms - left[1].completed_at_ms)
              .slice(0, 1_024),
          );
          await writeAtomic(resolve(sessionDirectory, TRANSCRIPT_FILE), `${JSON.stringify(transcript, null, 2)}\n`);
          await writeAtomic(outboxPath, `${JSON.stringify(outbox, null, 2)}\n`);
          const telemetryPath = resolve(sessionDirectory, TELEMETRY_FILE);
          const telemetry = await readJson<MeetingMediaSessionTelemetry>(telemetryPath, emptyTelemetry())
            .catch(() => emptyTelemetry());
          if (providerInvoked) {
            telemetry.provider_attempt_count += 1;
            telemetry.provider_duration_ms = boundedTelemetrySample(
              telemetry.provider_duration_ms,
              Math.max(0, performance.now() - providerStartedAt),
            );
          }
          if (transcript.utterances.length > 0) telemetry.first_provisional_at_ms ??= this.now();
          if (Object.keys(outbox.pending).length === 0) telemetry.asr_drained_at_ms = this.now();
          await writeAtomic(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`).catch(() => undefined);
        });
      } catch (error) {
        await this.withSessionLock(key, async () => {
          const outbox = normalizedOutbox(await readJson<ProviderOutboxState>(outboxPath, emptyOutbox(identity)));
          const current = outbox.pending[item.chunk.chunk_id];
          if (!current) return;
          current.attempts += 1;
          current.last_error = String((error as Error).message || error).slice(0, 500);
          if (!retryableProviderError(error) || current.attempts >= this.providerMaxAttempts) {
            current.terminal = true;
            current.terminal_at_ms = this.now();
            delete current.next_attempt_at_ms;
            outbox.failed[item.chunk.chunk_id] = current;
            delete outbox.pending[item.chunk.chunk_id];
          } else {
            current.next_attempt_at_ms = this.now() + Math.min(
              this.providerRetryMaxMs,
              this.providerRetryBaseMs * 2 ** Math.max(0, current.attempts - 1),
            );
          }
          await writeAtomic(outboxPath, `${JSON.stringify(outbox, null, 2)}\n`);
          const telemetryPath = resolve(sessionDirectory, TELEMETRY_FILE);
          const telemetry = await readJson<MeetingMediaSessionTelemetry>(telemetryPath, emptyTelemetry())
            .catch(() => emptyTelemetry());
          if (providerInvoked) {
            telemetry.provider_attempt_count += 1;
            telemetry.provider_duration_ms = boundedTelemetrySample(
              telemetry.provider_duration_ms,
              Math.max(0, performance.now() - providerStartedAt),
            );
          }
          if (providerFailed) {
            telemetry.provider_failure_count += 1;
            if (current.last_error.includes('timeout')) telemetry.provider_timeout_count += 1;
          }
          await writeAtomic(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`).catch(() => undefined);
        });
      }
    }
    await this.reconvergeSealedSession(identity, sessionId);
    await this.armProviderRetry(identity, sessionId);
  }

  private async reconvergeSealedSession(identity: MeetingMediaIdentity, sessionId: string): Promise<void> {
    const sessionDirectory = this.sessionDirectory(identity, sessionId);
    const intent = await readJson<FinalizeIntentRecord | null>(resolve(sessionDirectory, FINALIZE_INTENT_FILE), null);
    if (!intent || !this.formalTranscriptHandler || (intent.next_notification_attempt_at_ms || 0) > this.now()) return;
    const finalized = await this.finalizeSession({
      identity,
      session_id: sessionId,
      expected_tracks: intent.expected_tracks,
      expected_last_sequence: intent.expected_last_sequence,
      known_missing_chunk_ids: intent.known_missing_chunk_ids,
      speaker_identity_matches: intent.speaker_identity_matches || [],
      request: intent.request,
    });
    if (intent.notified_convergence_fingerprint === finalized.convergence_fingerprint) return;
    try {
      await this.formalTranscriptHandler({ identity, artifact: finalized.artifact, request: intent.request });
      await this.markFormalTranscriptNotified(identity, sessionId, finalized.convergence_fingerprint);
    } catch (error) {
      await this.withSessionLock(this.sessionKey(identity, sessionId), async () => {
        const path = resolve(sessionDirectory, FINALIZE_INTENT_FILE);
        const current = await readJson<FinalizeIntentRecord | null>(path, null);
        if (!current) return;
        current.notification_attempts = (current.notification_attempts || 0) + 1;
        current.next_notification_attempt_at_ms = this.now() + Math.min(this.providerRetryMaxMs, this.providerRetryBaseMs * 2 ** Math.max(0, current.notification_attempts - 1));
        current.last_notification_error = String((error as Error).message || error).slice(0, 500);
        await writeAtomic(path, `${JSON.stringify(current, null, 2)}\n`);
      });
    }
  }

  private async armProviderRetry(identity: MeetingMediaIdentity, sessionId: string): Promise<void> {
    if (!this.autoProcess) return;
    const key = this.sessionKey(identity, sessionId);
    const outbox = await this.providerOutbox(identity, sessionId);
    const intent = await readJson<FinalizeIntentRecord | null>(resolve(this.sessionDirectory(identity, sessionId), FINALIZE_INTENT_FILE), null);
    const wakeups = Object.values(outbox.pending)
      .filter((item) => !item.terminal)
      .map((item) => item.next_attempt_at_ms || this.now());
    if (intent?.next_notification_attempt_at_ms) wakeups.push(intent.next_notification_attempt_at_ms);
    const next = wakeups.sort((a, b) => a - b)[0];
    const prior = this.providerRetryTimers.get(key);
    if (prior) clearTimeout(prior);
    if (next === undefined) { this.providerRetryTimers.delete(key); return; }
    const timer = setTimeout(() => {
      this.providerRetryTimers.delete(key);
      this.queueProviderDrain(identity, sessionId);
    }, Math.max(0, next - this.now()));
    timer.unref?.();
    this.providerRetryTimers.set(key, timer);
  }

  private async persistRawChunk(
    sessionDirectory: string,
    chunk: MeetingAudioChunk,
    audio: Uint8Array,
  ): Promise<void> {
    const audioPath = this.audioPath(sessionDirectory, chunk);
    const metadataPath = this.metadataPath(sessionDirectory, chunk);
    const [existingAudio, existingMetadata] = await Promise.all([
      readFile(audioPath).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error))),
      readFile(metadataPath, 'utf8').catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? null : Promise.reject(error)),
    ]);
    if (existingAudio && !existingAudio.equals(Buffer.from(audio))) {
      throw Object.assign(new Error('meeting_media_chunk_conflict'), { status: 409 });
    }
    if (existingMetadata && canonical(JSON.parse(existingMetadata)) !== canonical(chunk)) {
      throw Object.assign(new Error('meeting_media_chunk_conflict'), { status: 409 });
    }
    if (!existingAudio) await writeAtomic(audioPath, audio);
    if (!existingMetadata) await writeAtomic(metadataPath, `${JSON.stringify(chunk, null, 2)}\n`);
  }

  private async recordIngestTelemetry(
    sessionDirectory: string,
    acknowledgement: MeetingAudioChunkAcknowledgement,
    replay: boolean,
    pendingChunkCount: number,
    ingestStartedAt: number,
  ): Promise<void> {
    const telemetryPath = resolve(sessionDirectory, TELEMETRY_FILE);
    const telemetry = await readJson<MeetingMediaSessionTelemetry>(telemetryPath, emptyTelemetry())
      .catch(() => emptyTelemetry());
    telemetry.first_chunk_received_at_ms ??= acknowledgement.acknowledged_at_ms;
    telemetry.last_chunk_acknowledged_at_ms = acknowledgement.acknowledged_at_ms;
    telemetry.acknowledgement_count += replay ? 0 : 1;
    telemetry.replay_count += replay ? 1 : 0;
    telemetry.peak_pending_chunk_count = Math.max(
      telemetry.peak_pending_chunk_count,
      pendingChunkCount,
    );
    telemetry.ack_persist_duration_ms = boundedTelemetrySample(
      telemetry.ack_persist_duration_ms,
      Math.max(0, performance.now() - ingestStartedAt),
    );
    await writeAtomic(telemetryPath, `${JSON.stringify(telemetry, null, 2)}\n`).catch(() => undefined);
  }

  private async deleteRawMediaFiles(
    sessionDirectory: string,
    outbox: ProviderOutboxState,
    reason: RawMediaLifecycleRecord['reason'],
  ): Promise<void> {
    const lifecyclePath = resolve(sessionDirectory, RAW_MEDIA_LIFECYCLE_FILE);
    const abandonedChunkIDs = [
      ...Object.keys(outbox.pending),
      ...Object.keys(outbox.failed),
    ].sort();
    const writeLifecycle = async (
      status: RawMediaLifecycleRecord['status'],
      error?: unknown,
    ) => await writeAtomic(lifecyclePath, `${JSON.stringify({
      schema_version: 'inkloop.raw_media_lifecycle.v1',
      status,
      reason,
      updated_at_ms: this.now(),
      ...(abandonedChunkIDs.length > 0 ? { abandoned_chunk_ids: abandonedChunkIDs } : {}),
      ...(error ? { error: String((error as Error).message || error).slice(0, 500) } : {}),
    } satisfies RawMediaLifecycleRecord, null, 2)}\n`);
    await writeLifecycle('deleting');
    try {
      await rm(resolve(sessionDirectory, 'raw'), { recursive: true, force: true });
      outbox.pending = {};
      await writeAtomic(resolve(sessionDirectory, OUTBOX_FILE), `${JSON.stringify(outbox, null, 2)}\n`);
      await writeLifecycle('deleted');
    } catch (error) {
      await writeLifecycle('delete_failed', error).catch(() => undefined);
      throw error;
    }
  }

  private sessionDirectory(identity: MeetingMediaIdentity, sessionId: string): string {
    return resolve(
      this.root,
      encodedSegment(identity.tenant_id),
      encodedSegment(identity.user_id),
      encodedSegment(sessionId),
    );
  }

  private meetingDeletionDirectory(identity: MeetingMediaIdentity): string {
    return resolve(this.root, encodedSegment(identity.tenant_id), MEETING_DELETION_DIRECTORY);
  }

  private meetingDeletionCommandPath(identity: MeetingMediaIdentity, meetingDocId: string): string {
    return resolve(this.meetingDeletionDirectory(identity), `${encodedSegment(meetingDocId)}.json`);
  }

  private async availableMeetingDeletionCommandPath(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
  ): Promise<string> {
    const canonicalPath = this.meetingDeletionCommandPath(identity, meetingDocId);
    if (!await readJson<MeetingDeletionCommand | null>(canonicalPath, null)) return canonicalPath;
    return resolve(
      this.meetingDeletionDirectory(identity),
      `${encodedSegment(meetingDocId)}.${encodedSegment(`meeting_delete_${randomUUID()}`)}.json`,
    );
  }

  private async meetingDeletionCommands(identity: MeetingMediaIdentity): Promise<MeetingDeletionCommand[]> {
    const directory = this.meetingDeletionDirectory(identity);
    const commands: MeetingDeletionCommand[] = [];
    for (const file of await files(directory)) {
      const command = await readJson<MeetingDeletionCommand | null>(resolve(directory, file), null);
      if (command?.schema_version === 'inkloop.meeting_deletion_command.v1') commands.push(command);
    }
    return commands;
  }

  private async meetingDeletionCommandFilePath(
    identity: MeetingMediaIdentity,
    commandId: string,
  ): Promise<string | null> {
    const directory = this.meetingDeletionDirectory(identity);
    for (const file of await files(directory)) {
      const path = resolve(directory, file);
      const command = await readJson<MeetingDeletionCommand | null>(path, null);
      if (command?.command_id === commandId) return path;
    }
    return null;
  }

  private async migrateLegacyMeetingDeletionCommands(identity: MeetingMediaIdentity): Promise<void> {
    const tenant = encodedSegment(identity.tenant_id);
    if (this.migratedLegacyDeletionTenants.has(tenant)) return;
    const key = `${identity.tenant_id}\u0000meeting-deletion-migration`;
    await this.withSessionLock(key, async () => {
      if (this.migratedLegacyDeletionTenants.has(tenant)) return;
      const tenantDirectory = resolve(this.root, tenant);
      for (const encodedUser of await directories(tenantDirectory)) {
        if (encodedUser.startsWith('.')) continue;
        const legacyDirectory = resolve(tenantDirectory, encodedUser, MEETING_DELETION_DIRECTORY);
        for (const file of await files(legacyDirectory)) {
          const legacyPath = resolve(legacyDirectory, file);
          const command = await readJson<MeetingDeletionCommand | null>(legacyPath, null);
          if (!command || command.schema_version !== 'inkloop.meeting_deletion_command.v1') continue;
          const existingPath = await this.meetingDeletionCommandFilePath(identity, command.command_id);
          let destination = existingPath || this.meetingDeletionCommandPath(identity, command.meeting_doc_id);
          const collision = await readJson<MeetingDeletionCommand | null>(destination, null);
          if (collision && collision.command_id !== command.command_id) {
            destination = resolve(
              this.meetingDeletionDirectory(identity),
              `${encodedSegment(command.meeting_doc_id)}.${encodedSegment(command.command_id)}.json`,
            );
          }
          if (!existingPath) await writeAtomic(destination, `${JSON.stringify(command, null, 2)}\n`);
          // Remove the user-scoped copy only after its tenant-scoped durable
          // replacement exists. This keeps upgrades crash-safe and preserves
          // command IDs already observed by an offline Companion.
          await rm(legacyPath, { force: true });
        }
      }
      this.migratedLegacyDeletionTenants.add(tenant);
    });
  }

  private deletedSessionPath(identity: MeetingMediaIdentity, sessionId: string): string {
    return resolve(
      this.root,
      encodedSegment(identity.tenant_id),
      encodedSegment(identity.user_id),
      DELETED_SESSION_DIRECTORY,
      `${encodedSegment(sessionId)}.json`,
    );
  }

  private async assertSessionWritable(identity: MeetingMediaIdentity, sessionId: string): Promise<void> {
    if (await readJson<DeletedMeetingSessionRecord | null>(this.deletedSessionPath(identity, sessionId), null)) {
      throw Object.assign(new Error('meeting_media_session_deleted'), { status: 410 });
    }
    const scope = await this.sessionScope(identity, sessionId);
    if (scope && await this.findMeetingDeletionCommand(identity, scope.meeting_doc_id, [scope.meeting_ref], scope.started_at_ms, scope.ended_at_ms)) {
      throw Object.assign(new Error('meeting_media_meeting_deleted'), { status: 410 });
    }
  }

  private meetingDeletionPending(command: MeetingDeletionCommand): boolean {
    if (command.required_device_ids.some((device) => !command.device_acknowledgements[device])) return true;
    // A command with provider references but no known device still needs to be
    // discoverable by a completely offline Companion on its next connection.
    return command.meeting_refs.length > 0 && command.required_device_ids.length === 0;
  }

  private async findMeetingDeletionCommand(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
    meetingRefs: string[],
    occurrenceStartedAtMs?: number,
    occurrenceEndedAtMs?: number,
  ): Promise<MeetingDeletionCommand | null> {
    await this.migrateLegacyMeetingDeletionCommands(identity);
    const exact = await readJson<MeetingDeletionCommand | null>(this.meetingDeletionCommandPath(identity, meetingDocId), null);
    if (exact && (exact.meeting_doc_id === meetingDocId && exact.meeting_refs.length === 0
      || deletionOccurrenceMatches(exact, occurrenceStartedAtMs, occurrenceEndedAtMs))) return exact;
    const references = new Set(meetingRefs);
    if (!references.size) return null;
    const directory = this.meetingDeletionDirectory(identity);
    for (const file of await files(directory)) {
      const command = await readJson<MeetingDeletionCommand | null>(resolve(directory, file), null);
      if (command?.meeting_refs.some((reference) => references.has(reference))
        && deletionOccurrenceMatches(command, occurrenceStartedAtMs, occurrenceEndedAtMs)) return command;
    }
    return null;
  }

  private async sessionScopesForMeeting(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
  ): Promise<MeetingMediaSessionScope[]> {
    const identityDirectory = resolve(this.root, encodedSegment(identity.tenant_id), encodedSegment(identity.user_id));
    const scopes: MeetingMediaSessionScope[] = [];
    for (const encoded of await directories(identityDirectory)) {
      if (encoded.startsWith('.')) continue;
      const scope = await readJson<MeetingMediaSessionScope | null>(resolve(identityDirectory, encoded, SESSION_SCOPE_FILE), null);
      if (scope?.meeting_doc_id === meetingDocId) scopes.push(scope);
    }
    return scopes;
  }

  private async sessionScopesForDeletion(
    identity: MeetingMediaIdentity,
    meetingDocId: string,
    meetingRefs: string[],
    occurrenceStartedAtMs?: number,
    occurrenceEndedAtMs?: number,
  ): Promise<Array<{ identity: MeetingMediaIdentity; scope: MeetingMediaSessionScope }>> {
    const tenantDirectory = resolve(this.root, encodedSegment(identity.tenant_id));
    const references = new Set(meetingRefs);
    const scopes: Array<{ identity: MeetingMediaIdentity; scope: MeetingMediaSessionScope }> = [];
    for (const encodedUser of await directories(tenantDirectory)) {
      if (encodedUser.startsWith('.')) continue;
      let userId = '';
      try { userId = Buffer.from(encodedUser, 'base64url').toString('utf8'); } catch { continue; }
      const owner = { tenant_id: identity.tenant_id, user_id: userId };
      const userDirectory = resolve(tenantDirectory, encodedUser);
      for (const encodedSession of await directories(userDirectory)) {
        if (encodedSession.startsWith('.')) continue;
        const scope = await readJson<MeetingMediaSessionScope | null>(resolve(userDirectory, encodedSession, SESSION_SCOPE_FILE), null);
        const matchesIdentity = scope
          && (scope.meeting_doc_id === meetingDocId || references.has(scope.meeting_ref));
        const hasOccurrenceBounds = Number.isFinite(occurrenceStartedAtMs)
          || Number.isFinite(occurrenceEndedAtMs);
        const matchesOccurrence = !hasOccurrenceBounds || deletionOccurrenceMatches(
          {
            occurrence_started_at_ms: occurrenceStartedAtMs,
            occurrence_ended_at_ms: occurrenceEndedAtMs,
          },
          scope?.started_at_ms,
          scope?.ended_at_ms,
        );
        if (scope && matchesIdentity && matchesOccurrence) scopes.push({ identity: owner, scope });
      }
    }
    return scopes;
  }

  private sessionKey(identity: MeetingMediaIdentity, sessionId: string): string {
    return `${identity.tenant_id}\u0000${identity.user_id}\u0000${sessionId}`;
  }

  private recorderLeaseKey(identity: MeetingMediaIdentity, meetingRef: string): string {
    return `${identity.tenant_id}\u0000recorder-lease\u0000${meetingRef}`;
  }

  private recorderLeasePath(identity: MeetingMediaIdentity, meetingRef: string): string {
    return resolve(
      this.root,
      encodedSegment(identity.tenant_id),
      RECORDER_LEASE_DIRECTORY,
      `${encodedSegment(meetingRef)}.json`,
    );
  }

  private recorderLeaseGrant(
    record: RecorderLeaseRecord,
    granted: boolean,
    now: number,
  ): RecorderLeaseGrant {
    return {
      schema_version: 'inkloop.meeting_recorder_lease.v1',
      granted,
      meeting_ref: record.meeting_ref,
      owner_session_id: record.owner_session_id,
      owner_device_id: record.owner_device_id,
      acquired_at_ms: record.acquired_at_ms,
      expires_at_ms: record.expires_at_ms,
      retry_after_ms: Math.max(0, record.expires_at_ms - now),
      ...(granted ? { lease_token: record.lease_token } : {}),
    };
  }

  private async assertRecorderLease(
    identity: MeetingMediaIdentity,
    input: RecorderLeaseRenewInput,
    touch = false,
  ): Promise<void> {
    const meetingRef = input.meeting_ref.trim();
    meetingDocumentId(meetingRef);
    const path = this.recorderLeasePath(identity, meetingRef);
    const key = this.recorderLeaseKey(identity, meetingRef);
    await this.withSessionLock(key, async () => {
      const record = await readJson<RecorderLeaseRecord | null>(path, null);
      const now = this.now();
      if (!record
        || record.released_at_ms
        || record.expires_at_ms <= now
        || record.owner_session_id !== input.session_id
        || record.owner_user_id !== identity.user_id
        || record.owner_device_id !== authenticatedRecorderDevice(identity, input.device_id)
        || record.lease_token !== input.lease_token) {
        throw Object.assign(new Error('meeting_media_recorder_lease_invalid'), { status: 409 });
      }
      if (touch) {
        await writeAtomic(path, `${JSON.stringify({
          ...record,
          renewed_at_ms: now,
          expires_at_ms: now + (record.ttl_ms || DEFAULT_RECORDER_LEASE_TTL_MS),
        }, null, 2)}\n`);
      }
    });
  }

  private audioPath(sessionDirectory: string, chunk: MeetingAudioChunk): string {
    return resolve(sessionDirectory, 'raw', chunk.track, `${String(chunk.sequence).padStart(8, '0')}.audio`);
  }

  private metadataPath(sessionDirectory: string, chunk: MeetingAudioChunk): string {
    return resolve(sessionDirectory, 'raw', chunk.track, `${String(chunk.sequence).padStart(8, '0')}.json`);
  }

  private async withSessionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(key) || Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = prior.then(() => gate);
    this.sessionLocks.set(key, tail);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.sessionLocks.get(key) === tail) this.sessionLocks.delete(key);
    }
  }

  private async withRealtimeProviderLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.realtimeProviderLocks.get(key) || Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = prior.then(() => gate);
    this.realtimeProviderLocks.set(key, tail);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.realtimeProviderLocks.get(key) === tail) this.realtimeProviderLocks.delete(key);
    }
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function files(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface MeetingMediaServiceOptions {
  ingress: MeetingMediaStreamingIngress;
  readBody(req: IncomingMessage, maxBytes?: number): Promise<string>;
  resolveIdentity(req: IncomingMessage, res: ServerResponse): Promise<MeetingMediaIdentity | null>;
  onFormalTranscript?(input: {
    identity: MeetingMediaIdentity;
    artifact: FormalTranscriptArtifact;
    request: MeetingMediaFinalizeRequest;
  }): Promise<unknown>;
}

export interface MeetingMediaFinalizeRequest {
  session_id: string;
  meeting_id: string;
  title?: string;
  platform?: string;
  /** Stable occurrence identity. For Companion capture this is the full
   * normalized provider meeting reference, not the ephemeral recorder session. */
  provider_meeting_id?: string;
  started_at_ms?: number;
  ended_at_ms?: number;
  expected_tracks?: Array<'mic' | 'remote'>;
  expected_last_sequence?: Partial<Record<'mic' | 'remote', number>>;
  known_missing_chunk_ids?: string[];
  duplicate_assessments?: CrossTrackDuplicateAssessment[];
  speaker_identity_matches?: SpeakerIdentityMatch[];
  template_id?: string;
  ocr_status?: 'ready' | 'pending' | 'failed' | 'not_applicable';
  handwriting?: unknown[];
}

const nonEmptyWireString = z.string().trim().min(1).max(512);
const optionalWireMilliseconds = z.number().int().nonnegative().optional();
const recorderLeaseClaimSchema = z.object({
  meeting_ref: nonEmptyWireString,
  session_id: nonEmptyWireString,
  device_id: nonEmptyWireString,
  ttl_ms: z.number().int().positive().optional(),
});
const recorderLeaseRenewSchema = recorderLeaseClaimSchema.extend({
  lease_token: nonEmptyWireString,
});
const registerMeetingMediaSessionSchema = z.object({
  session_id: nonEmptyWireString,
  platform: z.enum(['google_meet', 'zoom']),
  meeting_ref: nonEmptyWireString,
  status: z.enum(['recording', 'paused', 'sealed']),
  started_at_ms: optionalWireMilliseconds,
  ended_at_ms: optionalWireMilliseconds,
  recorder_device_id: nonEmptyWireString.optional(),
  recorder_lease_token: nonEmptyWireString.optional(),
});
const meetingMediaFinalizeRequestSchema = z.object({
  session_id: nonEmptyWireString,
  meeting_id: nonEmptyWireString,
  title: z.string().max(300).optional(),
  platform: z.string().max(64).optional(),
  provider_meeting_id: z.string().max(512).optional(),
  started_at_ms: optionalWireMilliseconds,
  ended_at_ms: optionalWireMilliseconds,
  expected_tracks: z.array(z.enum(['mic', 'remote'])).max(2).optional(),
  expected_last_sequence: z.record(
    z.enum(['mic', 'remote']),
    z.number().int().nonnegative(),
  ).optional(),
  known_missing_chunk_ids: z.array(nonEmptyWireString).max(20_000).optional(),
  duplicate_assessments: z.array(z.unknown()).max(20_000).optional(),
  speaker_identity_matches: z.array(z.unknown()).max(20_000).optional(),
  template_id: z.string().max(128).optional(),
  ocr_status: z.enum(['ready', 'pending', 'failed', 'not_applicable']).optional(),
  handwriting: z.array(z.unknown()).max(20_000).optional(),
});
const acknowledgeMeetingDeletionSchema = z.object({
  command_id: nonEmptyWireString,
  device_id: nonEmptyWireString,
  deleted_session_ids: z.array(nonEmptyWireString).max(20_000).optional(),
});
const wireBase64Schema = z.string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const meetingChunkPayloadSchema = z.object({
  chunk: z.unknown(),
  audio_base64: wireBase64Schema.max(22 * 1024 * 1024),
  meeting_ref: nonEmptyWireString.optional(),
  recorder_device_id: nonEmptyWireString.optional(),
  recorder_lease_token: nonEmptyWireString.optional(),
}).strict();
const meetingRealtimeFramePayloadSchema = z.object({
  frame: z.unknown(),
  audio_base64: wireBase64Schema.max(2 * 1024 * 1024),
  meeting_ref: nonEmptyWireString.optional(),
  recorder_device_id: nonEmptyWireString.optional(),
  recorder_lease_token: nonEmptyWireString.optional(),
}).strict();

function parseWireBody<T>(schema: z.ZodType<T>, text: string, code: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw Object.assign(new Error(code), { status: 400 });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createMeetingMediaService(
  options: MeetingMediaServiceOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  if (options.onFormalTranscript) options.ingress.setFormalTranscriptHandler(options.onFormalTranscript);
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://inkloop.local');
    if (!url.pathname.startsWith('/api/meeting-media/')) return false;
    const identity = await options.resolveIdentity(req, res);
    if (!identity) return true;
    try {
      if (url.pathname === '/api/meeting-media/recorder-lease/acquire' && req.method === 'POST') {
        const body = parseWireBody(
          recorderLeaseClaimSchema,
          await options.readBody(req, 256 * 1024),
          'meeting_media_recorder_lease_payload_invalid',
        );
        sendJson(res, 200, await options.ingress.acquireRecorderLease(identity, body));
        return true;
      }
      if (url.pathname === '/api/meeting-media/recorder-lease/renew' && req.method === 'POST') {
        const body = parseWireBody(
          recorderLeaseRenewSchema,
          await options.readBody(req, 256 * 1024),
          'meeting_media_recorder_lease_payload_invalid',
        );
        sendJson(res, 200, await options.ingress.renewRecorderLease(identity, body));
        return true;
      }
      if (url.pathname === '/api/meeting-media/recorder-lease/release' && req.method === 'POST') {
        const body = parseWireBody(
          recorderLeaseRenewSchema,
          await options.readBody(req, 256 * 1024),
          'meeting_media_recorder_lease_payload_invalid',
        );
        sendJson(res, 200, await options.ingress.releaseRecorderLease(identity, body));
        return true;
      }
      if (url.pathname === '/api/meeting-media/chunks' && req.method === 'POST') {
        const body = parseWireBody(
          meetingChunkPayloadSchema,
          await options.readBody(req, 16 * 1024 * 1024),
          'meeting_media_chunk_payload_invalid',
        );
        try {
          assertMeetingAudioChunk(body.chunk);
        } catch {
          throw Object.assign(new Error('meeting_media_chunk_payload_invalid'), { status: 400 });
        }
        const result = await options.ingress.ingest({
          ...identity,
          chunk: body.chunk,
          audio: Buffer.from(body.audio_base64, 'base64'),
          meeting_ref: body.meeting_ref,
          recorder_device_id: body.recorder_device_id,
          recorder_lease_token: body.recorder_lease_token,
        });
        sendJson(res, 202, result);
        return true;
      }
      if (url.pathname === '/api/meeting-media/realtime-frames' && req.method === 'POST') {
        const body = parseWireBody(
          meetingRealtimeFramePayloadSchema,
          await options.readBody(req, 1024 * 1024),
          'meeting_media_realtime_frame_payload_invalid',
        );
        try {
          assertMeetingRealtimeAudioFrame(body.frame);
        } catch {
          throw Object.assign(
            new Error('meeting_media_realtime_frame_payload_invalid'),
            { status: 400 },
          );
        }
        sendJson(res, 202, await options.ingress.ingestRealtimeFrame({
          ...identity,
          frame: body.frame,
          audio: Buffer.from(body.audio_base64, 'base64'),
          meeting_ref: body.meeting_ref,
          recorder_device_id: body.recorder_device_id,
          recorder_lease_token: body.recorder_lease_token,
        }));
        return true;
      }
      if (url.pathname === '/api/meeting-media/sessions' && req.method === 'POST') {
        const body = parseWireBody(
          registerMeetingMediaSessionSchema,
          await options.readBody(req, 1024 * 1024),
          'meeting_media_session_scope_invalid',
        );
        sendJson(res, 200, await options.ingress.registerSession(identity, body));
        return true;
      }
      if (url.pathname === '/api/meeting-media/finalize' && req.method === 'POST') {
        const body = parseWireBody(
          meetingMediaFinalizeRequestSchema,
          await options.readBody(req, 4 * 1024 * 1024),
          'meeting_media_finalize_payload_invalid',
        ) as MeetingMediaFinalizeRequest;
        const sessionId = body.session_id.trim();
        const scope = await options.ingress.sessionScope(identity, sessionId);
        if (!scope) throw Object.assign(new Error('meeting_media_session_not_registered'), { status: 409 });
        if (scope.status !== 'sealed') {
          throw Object.assign(new Error('meeting_media_session_not_sealed'), { status: 409 });
        }
        // The Companion knows the provider occurrence reference, but the Hub
        // may have resolved that reference to an existing InkLoop meeting
        // document during registration. Formal evidence must use that canonical
        // identity so it cannot create a second postprocess occurrence.
        const request: MeetingMediaFinalizeRequest = {
          ...body,
          session_id: sessionId,
          meeting_id: scope.meeting_doc_id.replace(/^mtgdoc_/, ''),
          platform: scope.platform,
          provider_meeting_id: scope.provider_occurrence_id
            || `${scope.meeting_ref}:${scope.started_at_ms ?? scope.session_id}`,
          started_at_ms: scope.started_at_ms ?? body.started_at_ms,
          ended_at_ms: scope.ended_at_ms ?? body.ended_at_ms,
        };
        const finalized = await options.ingress.finalizeSession({
          identity,
          session_id: sessionId,
          expected_tracks: Array.isArray(body.expected_tracks)
            ? body.expected_tracks.filter((track): track is 'mic' | 'remote' => track === 'mic' || track === 'remote')
            : undefined,
          expected_last_sequence: body.expected_last_sequence,
          known_missing_chunk_ids: Array.isArray(body.known_missing_chunk_ids)
            ? body.known_missing_chunk_ids.filter((item): item is string => typeof item === 'string' && !!item.trim())
            : [],
          duplicate_assessments: Array.isArray(body.duplicate_assessments) ? body.duplicate_assessments : [],
          speaker_identity_matches: Array.isArray(body.speaker_identity_matches) ? body.speaker_identity_matches : [],
          request,
        });
        await options.ingress.disposeProviderSession(identity, sessionId);
        const postprocess = finalized.notified ? undefined : await options.onFormalTranscript?.({ identity, artifact: finalized.artifact, request });
        if (!finalized.notified && options.onFormalTranscript) await options.ingress.markFormalTranscriptNotified(identity, sessionId, finalized.convergence_fingerprint);
        sendJson(res, 200, { ...finalized, postprocess });
        return true;
      }
      if (url.pathname === '/api/meeting-media/live-status' && req.method === 'GET') {
        sendJson(res, 200, await options.ingress.liveStatus(identity));
        return true;
      }
      if (url.pathname === '/api/meeting-media/session-scope' && req.method === 'GET') {
        const meetingDocumentId = url.searchParams.get('meeting_doc_id')?.trim() || '';
        const scope = await options.ingress.latestSessionScopeForMeeting(identity, meetingDocumentId);
        if (!scope) throw Object.assign(new Error('meeting_media_session_not_found'), { status: 404 });
        sendJson(res, 200, scope);
        return true;
      }
      if (url.pathname === '/api/meeting-media/deletion-commands' && req.method === 'GET') {
        const deviceId = url.searchParams.get('device_id')?.trim() || '';
        const localMeetings: LocalMeetingDeletionCandidate[] = [];
        let current: LocalMeetingDeletionCandidate | undefined;
        for (const [name, raw] of url.searchParams.entries()) {
          if (name === 'meeting_ref') {
            if (current) localMeetings.push(current);
            current = { meeting_ref: raw };
          } else if (current && name === 'meeting_started_at_ms' && Number.isFinite(Number(raw))) {
            current.started_at_ms = Number(raw);
          } else if (current && name === 'meeting_ended_at_ms' && Number.isFinite(Number(raw))) {
            current.ended_at_ms = Number(raw);
          }
        }
        if (current) localMeetings.push(current);
        sendJson(res, 200, { commands: await options.ingress.pendingMeetingDeletionCommands(identity, deviceId, localMeetings) });
        return true;
      }
      if (url.pathname === '/api/meeting-media/deletion-commands/ack' && req.method === 'POST') {
        const body = parseWireBody(
          acknowledgeMeetingDeletionSchema,
          await options.readBody(req, 256 * 1024),
          'meeting_media_deletion_ack_invalid',
        );
        sendJson(res, 200, { command: await options.ingress.acknowledgeMeetingDeletion(identity, body) });
        return true;
      }
      const requestedSessionId = url.searchParams.get('session_id')?.trim() || '';
      const sessionId = requestedSessionId === 'latest'
        ? await options.ingress.latestSessionId(identity)
        : requestedSessionId;
      if (!sessionId) throw Object.assign(new Error('meeting_media_session_id_required'), { status: 400 });
      if (url.pathname === '/api/meeting-media/transcript' && req.method === 'GET') {
        sendJson(res, 200, { transcript: await options.ingress.transcript(identity, sessionId) });
        return true;
      }
      if (url.pathname === '/api/meeting-media/provider-status' && req.method === 'GET') {
        sendJson(res, 200, { outbox: await options.ingress.providerOutbox(identity, sessionId) });
        return true;
      }
      if (url.pathname === '/api/meeting-media/telemetry' && req.method === 'GET') {
        sendJson(res, 200, { telemetry: await options.ingress.sessionTelemetry(identity, sessionId) });
        return true;
      }
      if (url.pathname === '/api/meeting-media/raw-media' && req.method === 'GET') {
        sendJson(res, 200, {
          lifecycle: await options.ingress.rawMediaLifecycle(identity, sessionId),
        });
        return true;
      }
      if (url.pathname === '/api/meeting-media/raw-media' && req.method === 'DELETE') {
        sendJson(res, 200, await options.ingress.deleteRawMedia(identity, sessionId));
        return true;
      }
      sendJson(res, 404, { error: { code: 'meeting_media_route_not_found' } });
      return true;
    } catch (error) {
      sendJson(res, Number((error as { status?: number }).status) || 500, {
        error: { code: String((error as Error).message || error) },
      });
      return true;
    }
  };
}

async function modifiedAtOrZero(path: string): Promise<number> {
  try { return (await stat(path)).mtimeMs; }
  catch { return 0; }
}
