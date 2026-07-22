import type { ClassroomClient } from './classroom-client';

export type ClassroomAudioUnavailableReason = 'secure_context_required' | 'media_devices_unavailable';
export type ClassroomAudioSignalType = 'ready' | 'offer' | 'answer' | 'ice' | 'leave';

export interface ClassroomAudioSignal {
  signal_sequence: number;
  message_id: string;
  participant_id: string;
  negotiation_generation: number;
  type: ClassroomAudioSignalType;
  payload: Record<string, unknown>;
}

export interface ClassroomRecordingState {
  recording_id: string;
  recording_generation: number;
  state: 'recording' | 'stopped' | 'interrupted';
  health: 'healthy' | 'incomplete';
  chunk_count: number;
  byte_count: number;
  last_sequence: number;
  last_relative_end_ms: number;
}

export function classroomAudioTransportAvailability(environment: { isSecureContext: boolean; protocol?: string }): { available: true } | { available: false; reason: 'secure_context_required' } {
  return !environment.isSecureContext || (environment.protocol !== undefined && environment.protocol !== 'https:')
    ? { available: false, reason: 'secure_context_required' }
    : { available: true };
}

export function classroomAudioAvailability(environment: { isSecureContext: boolean; mediaDevices?: MediaDevices; protocol?: string }): { available: true } | { available: false; reason: ClassroomAudioUnavailableReason } {
  const transport = classroomAudioTransportAvailability(environment);
  if (!transport.available) return transport;
  if (!environment.mediaDevices?.getUserMedia) return { available: false, reason: 'media_devices_unavailable' };
  return { available: true };
}

export class ClassroomAudioCapture {
  private stream: MediaStream | null = null;
  constructor(private readonly environment: { isSecureContext: boolean; mediaDevices?: MediaDevices; protocol?: string }) {}

  async acquire(): Promise<MediaStream> {
    const availability = classroomAudioAvailability(this.environment);
    if (!availability.available) throw new Error(availability.reason);
    this.stream = await this.environment.mediaDevices!.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false,
    });
    return this.stream;
  }

  stop(): void { for (const track of this.stream?.getTracks() ?? []) track.stop(); this.stream = null; }
}

export class ClassroomAudioApi {
  constructor(private readonly client: ClassroomClient, private readonly classroomId: string) {}
  signals(cursor: number): Promise<{ messages: ClassroomAudioSignal[]; cursor: number }> { return this.client.get(`/v1/classrooms/${this.classroomId}/audio/signals?cursor=${cursor}`); }
  signal(input: { message_id: string; negotiation_generation: number; participant_id?: string; type: ClassroomAudioSignalType; payload: Record<string, unknown> }): Promise<{ signal: ClassroomAudioSignal }> { return this.client.post(`/v1/classrooms/${this.classroomId}/audio/signals`, input); }
  startRecording(): Promise<{ recording: ClassroomRecordingState }> { return this.client.post(`/v1/classrooms/${this.classroomId}/audio/recording/start`); }
  recording(): Promise<{ recording: ClassroomRecordingState | null }> { return this.client.get(`/v1/classrooms/${this.classroomId}/audio/recording`); }
  appendChunk(recordingId: string, input: Record<string, unknown>): Promise<{ inserted: boolean; recording: ClassroomRecordingState }> { return this.client.post(`/v1/classrooms/${this.classroomId}/audio/recording/${recordingId}/chunks`, input); }
  stopRecording(recording: ClassroomRecordingState): Promise<{ recording: ClassroomRecordingState }> { return this.client.post(`/v1/classrooms/${this.classroomId}/audio/recording/${recording.recording_id}/stop`, { recording_generation: recording.recording_generation, health: recording.health }); }
}

function id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }

export class TeacherAudioPeers {
  private cursor = 0;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly generations = new Map<string, number>();
  private stopped = false;

  constructor(private readonly api: ClassroomAudioApi, private readonly stream: MediaStream, private readonly peerFactory: () => RTCPeerConnection = () => new RTCPeerConnection()) {}

  private async peer(participantId: string): Promise<RTCPeerConnection> {
    const existing = this.peers.get(participantId); if (existing) return existing;
    const peer = this.peerFactory(); this.peers.set(participantId, peer);
    for (const track of this.stream.getAudioTracks()) peer.addTrack(track, this.stream);
    peer.onicecandidate = (event) => { if (event.candidate) void this.api.signal({ message_id: id('ice'), participant_id: participantId, negotiation_generation: this.generations.get(participantId) ?? 1, type: 'ice', payload: { candidate: event.candidate.toJSON() } }); };
    return peer;
  }

  async pollOnce(): Promise<void> {
    const result = await this.api.signals(this.cursor); this.cursor = result.cursor;
    for (const signal of result.messages) {
      if (signal.type === 'ready') {
        this.generations.set(signal.participant_id, signal.negotiation_generation);
        this.peers.get(signal.participant_id)?.close(); this.peers.delete(signal.participant_id);
        const peer = await this.peer(signal.participant_id); const offer = await peer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false }); await peer.setLocalDescription(offer);
        await this.api.signal({ message_id: id('offer'), participant_id: signal.participant_id, negotiation_generation: signal.negotiation_generation, type: 'offer', payload: { sdp: offer.sdp, type: offer.type } });
      } else if (signal.type === 'answer') {
        if (signal.negotiation_generation !== this.generations.get(signal.participant_id)) continue;
        await (await this.peer(signal.participant_id)).setRemoteDescription(signal.payload as unknown as RTCSessionDescriptionInit);
      } else if (signal.type === 'ice' && signal.payload.candidate) {
        if (signal.negotiation_generation !== this.generations.get(signal.participant_id)) continue;
        await (await this.peer(signal.participant_id)).addIceCandidate(signal.payload.candidate as RTCIceCandidateInit);
      } else if (signal.type === 'leave') {
        this.peers.get(signal.participant_id)?.close(); this.peers.delete(signal.participant_id);
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopped) { try { await this.pollOnce(); } catch { /* next poll retries */ } await new Promise((resolve) => setTimeout(resolve, 500)); }
  }

  stop(): void { this.stopped = true; for (const peer of this.peers.values()) peer.close(); this.peers.clear(); this.generations.clear(); }
}

export class StudentAudioPeer {
  private cursor = 0;
  private generation = 1;
  private peer: RTCPeerConnection | null = null;
  private stopped = false;

  constructor(private readonly api: ClassroomAudioApi, private readonly onStream: (stream: MediaStream) => void, generation = 1, private readonly peerFactory: () => RTCPeerConnection = () => new RTCPeerConnection()) { this.generation = generation; }

  async start(): Promise<void> { await this.api.signal({ message_id: id('ready'), negotiation_generation: this.generation, type: 'ready', payload: {} }); }

  async pollOnce(): Promise<void> {
    const result = await this.api.signals(this.cursor); this.cursor = result.cursor;
    for (const signal of result.messages) {
      if (signal.negotiation_generation !== this.generation) continue;
      if (signal.type === 'offer') {
        this.peer?.close(); const peer = this.peerFactory(); this.peer = peer;
        peer.ontrack = (event) => { const stream = event.streams[0] ?? new MediaStream([event.track]); this.onStream(stream); };
        peer.onicecandidate = (event) => { if (event.candidate) void this.api.signal({ message_id: id('ice'), negotiation_generation: this.generation, type: 'ice', payload: { candidate: event.candidate.toJSON() } }); };
        await peer.setRemoteDescription(signal.payload as unknown as RTCSessionDescriptionInit); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer);
        await this.api.signal({ message_id: id('answer'), negotiation_generation: this.generation, type: 'answer', payload: { sdp: answer.sdp, type: answer.type } });
      } else if (signal.type === 'ice' && signal.payload.candidate) await this.peer?.addIceCandidate(signal.payload.candidate as RTCIceCandidateInit);
    }
  }

  async run(signal: AbortSignal): Promise<void> { while (!signal.aborted && !this.stopped) { try { await this.pollOnce(); } catch { /* next poll retries */ } await new Promise((resolve) => setTimeout(resolve, 500)); } }
  stop(): void {
    this.stopped = true; const leavingGeneration = this.generation; this.generation += 1; this.peer?.close(); this.peer = null;
    void this.api.signal({ message_id: id('leave'), negotiation_generation: leavingGeneration, type: 'leave', payload: {} });
  }
}

export async function playClassroomAudio(element: Pick<HTMLMediaElement, 'play'>, stream: MediaStream): Promise<'playing' | 'autoplay_blocked'> {
  (element as HTMLMediaElement).srcObject = stream;
  try { await element.play(); return 'playing'; } catch { return 'autoplay_blocked'; }
}

export function floatToPcmBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2); const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, samples[index])) * 0x7fff), true);
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
