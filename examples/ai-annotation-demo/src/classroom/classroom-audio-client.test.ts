import { describe, expect, it, vi } from 'vitest';
import { classroomAudioAvailability, classroomAudioTransportAvailability, ClassroomAudioCapture, floatToPcmBase64, playClassroomAudio, StudentAudioPeer, TeacherAudioPeers } from './classroom-audio-client';

describe('classroom audio client', () => {
  it('blocks microphone requests outside a secure context', async () => {
    const getUserMedia = vi.fn();
    expect(classroomAudioAvailability({ isSecureContext: false, mediaDevices: { getUserMedia } as unknown as MediaDevices })).toEqual({ available: false, reason: 'secure_context_required' });
    const capture = new ClassroomAudioCapture({ isSecureContext: false, mediaDevices: { getUserMedia } as unknown as MediaDevices });
    await expect(capture.acquire()).rejects.toThrow('secure_context_required');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('blocks student audio signaling on HTTP without consulting media devices', () => {
    expect(classroomAudioTransportAvailability({ isSecureContext: false, protocol: 'http:' })).toEqual({ available: false, reason: 'secure_context_required' });
    expect(classroomAudioTransportAvailability({ isSecureContext: true, protocol: 'https:' })).toEqual({ available: true });
  });

  it('requests teacher audio only and stops every acquired track', async () => {
    const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const capture = new ClassroomAudioCapture({ isSecureContext: true, mediaDevices: { getUserMedia } as unknown as MediaDevices });
    expect(await capture.acquire()).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.any(Object), video: false });
    capture.stop(); expect(stop).toHaveBeenCalledOnce();
  });

  it('encodes clipped float samples as little-endian signed PCM', () => {
    const bytes = Uint8Array.from(atob(floatToPcmBase64(new Float32Array([-2, 0, 2]))), (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect([view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)]).toEqual([-32767, 0, 32767]);
  });

  it('offers only teacher audio tracks and ignores stale answers', async () => {
    const audioTrack = { kind: 'audio' } as MediaStreamTrack;
    const videoTrack = { kind: 'video' } as MediaStreamTrack;
    const stream = { getAudioTracks: () => [audioTrack], getTracks: () => [audioTrack, videoTrack] } as unknown as MediaStream;
    const addTrack = vi.fn(); const setRemoteDescription = vi.fn(); const close = vi.fn();
    const createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'audio-only-offer' }));
    const peer = { addTrack, createOffer, setLocalDescription: vi.fn(), setRemoteDescription, addIceCandidate: vi.fn(), close, onicecandidate: null } as unknown as RTCPeerConnection;
    const signal = vi.fn(async () => ({ signal: {} }));
    let call = 0;
    const api = {
      signals: vi.fn(async () => call++ === 0 ? { cursor: 1, messages: [{ signal_sequence: 1, message_id: 'ready', participant_id: 'participant_1', negotiation_generation: 2, type: 'ready', payload: {} }] } : { cursor: 2, messages: [{ signal_sequence: 2, message_id: 'stale', participant_id: 'participant_1', negotiation_generation: 1, type: 'answer', payload: { type: 'answer', sdp: 'stale' } }] }),
      signal,
    };
    const peers = new TeacherAudioPeers(api as never, stream, () => peer);
    await peers.pollOnce(); await peers.pollOnce();
    expect(addTrack).toHaveBeenCalledTimes(1); expect(addTrack).toHaveBeenCalledWith(audioTrack, stream);
    expect(createOffer).toHaveBeenCalledWith({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({ type: 'offer', negotiation_generation: 2 }));
    expect(setRemoteDescription).not.toHaveBeenCalled();
  });

  it('student peer receives audio without requesting any local media and ignores stale offers', async () => {
    const getUserMedia = vi.fn();
    const setRemoteDescription = vi.fn(); const createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'answer' }));
    const peer = { setRemoteDescription, createAnswer, setLocalDescription: vi.fn(), addIceCandidate: vi.fn(), close: vi.fn(), ontrack: null, onicecandidate: null } as unknown as RTCPeerConnection;
    const api = {
      signal: vi.fn(async () => ({ signal: {} })),
      signals: vi.fn(async () => ({ cursor: 2, messages: [
        { signal_sequence: 1, message_id: 'stale', participant_id: 'participant_1', negotiation_generation: 2, type: 'offer', payload: { type: 'offer', sdp: 'stale' } },
        { signal_sequence: 2, message_id: 'current', participant_id: 'participant_1', negotiation_generation: 3, type: 'offer', payload: { type: 'offer', sdp: 'current' } },
      ] })),
    };
    const student = new StudentAudioPeer(api as never, vi.fn(), 3, () => peer);
    await student.start(); await student.pollOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(setRemoteDescription).toHaveBeenCalledOnce(); expect(setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'current' });
    expect(api.signal).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', negotiation_generation: 3 }));
    student.stop(); expect(api.signal).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'leave', negotiation_generation: 3 }));
  });

  it('reports autoplay rejection instead of claiming classroom audio is playing', async () => {
    const element = { srcObject: null, play: vi.fn(async () => { throw new DOMException('blocked', 'NotAllowedError'); }) } as unknown as HTMLMediaElement;
    const stream = {} as MediaStream;
    await expect(playClassroomAudio(element, stream)).resolves.toBe('autoplay_blocked');
    expect(element.srcObject).toBe(stream);
  });
});
