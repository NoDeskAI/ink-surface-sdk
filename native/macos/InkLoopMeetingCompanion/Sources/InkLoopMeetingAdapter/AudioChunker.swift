import CryptoKit
import Foundation

public actor PCMMeetingAudioChunker {
  private struct TrackBuffer: Sendable {
    var bytes = Data()
    var sequence = 0
    var startMilliseconds: Int64?
    var endMilliseconds: Int64?
    var realtimeFrameSequence = 0
    var pending: [CapturedAudioChunk] = []
    var emitting = false
  }

  public let sessionID: String
  public let chunkDurationMilliseconds: Int64
  private let sampleRateHertz: Int
  private let channelCount: Int
  private let codec: String
  private let realtimeSpeechProjectionEnabled: Bool
  private let onRealtimeFrame:
    (@Sendable (CapturedRealtimeAudioFrame) async -> Void)?
  private let onSealedChunk: @Sendable (CapturedAudioChunk) async throws -> Void
  private var tracks: [MeetingAudioTrack: TrackBuffer] = [:]
  private var speechProcessors: [MeetingAudioTrack: AdaptiveMicSpeechProcessor] = [:]

  public init(
    sessionID: String,
    chunkDurationMilliseconds: Int64 = 5_000,
    sampleRateHertz: Int = 16_000,
    channelCount: Int = 1,
    codec: String = "pcm_s16le",
    realtimeSpeechProjectionEnabled: Bool = false,
    onRealtimeFrame: (@Sendable (CapturedRealtimeAudioFrame) async -> Void)? = nil,
    onSealedChunk: @escaping @Sendable (CapturedAudioChunk) async throws -> Void
  ) {
    self.sessionID = sessionID
    self.chunkDurationMilliseconds = max(1_000, chunkDurationMilliseconds)
    self.sampleRateHertz = sampleRateHertz
    self.channelCount = channelCount
    self.codec = codec
    self.realtimeSpeechProjectionEnabled = realtimeSpeechProjectionEnabled
    self.onRealtimeFrame = onRealtimeFrame
    self.onSealedChunk = onSealedChunk
  }

  public func append(
    track: MeetingAudioTrack,
    bytes: Data,
    startMilliseconds: Int64,
    endMilliseconds: Int64,
    projectRealtimeFrame: Bool = true,
    realtimeAudioDerivation: MeetingRealtimeAudioDerivation? = nil
  ) async throws {
    guard !bytes.isEmpty, startMilliseconds >= 0, endMilliseconds > startMilliseconds else { return }
    var buffer = tracks[track] ?? TrackBuffer()
    let sourceChunkID = "\(sessionID):\(track.rawValue):\(buffer.sequence)"
    let frameSequence = buffer.realtimeFrameSequence
    if projectRealtimeFrame, onRealtimeFrame != nil {
      buffer.realtimeFrameSequence += 1
    }
    if buffer.startMilliseconds == nil { buffer.startMilliseconds = startMilliseconds }
    buffer.endMilliseconds = max(buffer.endMilliseconds ?? endMilliseconds, endMilliseconds)
    buffer.bytes.append(bytes)
    tracks[track] = buffer
    if projectRealtimeFrame, let onRealtimeFrame,
      let metadata = try? MeetingRealtimeAudioFrame(
        frameID: "\(sessionID):\(track.rawValue):frame:\(frameSequence)",
        sessionID: sessionID,
        track: track,
        frameSequence: frameSequence,
        sourceChunkID: sourceChunkID,
        startMonotonicMilliseconds: startMilliseconds,
        endMonotonicMilliseconds: endMilliseconds,
        codec: codec,
        sampleRateHertz: sampleRateHertz,
        channelCount: channelCount,
        audioDerivation: realtimeAudioDerivation
      )
    {
      let frame = CapturedRealtimeAudioFrame(metadata: metadata, bytes: bytes)
      if realtimeSpeechProjectionEnabled {
        var processor = speechProcessors[track] ?? AdaptiveMicSpeechProcessor()
        let projected = processor.process(frame)
        speechProcessors[track] = processor
        for value in projected { await onRealtimeFrame(value) }
      } else {
        await onRealtimeFrame(frame)
      }
    }
    if let start = buffer.startMilliseconds,
      let end = buffer.endMilliseconds,
      end - start >= chunkDurationMilliseconds
    {
      await flushSpeechProjectionCoverage(
        track: track,
        sourceChunkID: "\(sessionID):\(track.rawValue):\(buffer.sequence)")
      if let chunk = try seal(track: track) {
        var next = tracks[track] ?? TrackBuffer()
        next.pending.append(chunk)
        tracks[track] = next
      }
    }
    try await emitPending(track: track)
  }

  /// Emits an ephemeral ASR frame whose samples may be derived from the raw
  /// microphone. It advances the same realtime sequence as raw projection, but
  /// never appends bytes to the authoritative five-second fact buffer.
  public func projectRealtimeFrame(
    track: MeetingAudioTrack,
    bytes: Data,
    startMilliseconds: Int64,
    endMilliseconds: Int64,
    audioDerivation: MeetingRealtimeAudioDerivation
  ) async {
    guard let onRealtimeFrame, !bytes.isEmpty,
      startMilliseconds >= 0, endMilliseconds > startMilliseconds
    else { return }
    var buffer = tracks[track] ?? TrackBuffer()
    let frameSequence = buffer.realtimeFrameSequence
    buffer.realtimeFrameSequence += 1
    let sourceChunkID = "\(sessionID):\(track.rawValue):\(buffer.sequence)"
    tracks[track] = buffer
    guard let metadata = try? MeetingRealtimeAudioFrame(
      frameID: "\(sessionID):\(track.rawValue):frame:\(frameSequence)",
      sessionID: sessionID,
      track: track,
      frameSequence: frameSequence,
      sourceChunkID: sourceChunkID,
      startMonotonicMilliseconds: startMilliseconds,
      endMonotonicMilliseconds: endMilliseconds,
      codec: codec,
      sampleRateHertz: sampleRateHertz,
      channelCount: channelCount,
      audioDerivation: audioDerivation
    ) else { return }
    await onRealtimeFrame(CapturedRealtimeAudioFrame(metadata: metadata, bytes: bytes))
  }

  public func sealAll() async throws -> [CapturedAudioChunk] {
    var sealed: [CapturedAudioChunk] = []
    for track in MeetingAudioTrack.allCases {
      await finishSpeechProjection(track: track)
      let sequence = tracks[track]?.sequence ?? 0
      await flushSpeechProjectionCoverage(
        track: track,
        sourceChunkID: "\(sessionID):\(track.rawValue):\(sequence)")
      var buffer = tracks[track] ?? TrackBuffer()
      var result = buffer.pending
      buffer.pending = []
      tracks[track] = buffer
      if let tail = try seal(track: track) { result.append(tail) }
      sealed.append(contentsOf: result)
    }
    return sealed
  }

  public func flushPending() async throws {
    for track in MeetingAudioTrack.allCases {
      try await emitPending(track: track)
    }
  }

  /// A sealed chunk remains in memory until the evidence sink confirms that
  /// it reached durable storage. Callback failures are surfaced to the caller
  /// and retried on the next append; `sealAll` also returns every pending
  /// chunk so pause/stop can persist it through the controller path.
  private func emitPending(track: MeetingAudioTrack) async throws {
    var buffer = tracks[track] ?? TrackBuffer()
    guard !buffer.emitting else { return }
    buffer.emitting = true
    tracks[track] = buffer
    defer {
      var latest = tracks[track] ?? TrackBuffer()
      latest.emitting = false
      tracks[track] = latest
    }
    while let chunk = tracks[track]?.pending.first {
      try await onSealedChunk(chunk)
      var latest = tracks[track] ?? TrackBuffer()
      if latest.pending.first?.metadata.chunkID == chunk.metadata.chunkID {
        latest.pending.removeFirst()
      }
      tracks[track] = latest
    }
  }

  private func flushSpeechProjectionCoverage(
    track: MeetingAudioTrack,
    sourceChunkID: String
  ) async {
    guard realtimeSpeechProjectionEnabled, let onRealtimeFrame,
      var processor = speechProcessors[track]
    else { return }
    let coverage = processor.flushCoverage(sourceChunkID: sourceChunkID)
    speechProcessors[track] = processor
    for frame in coverage { await onRealtimeFrame(frame) }
  }

  private func finishSpeechProjection(track: MeetingAudioTrack) async {
    guard realtimeSpeechProjectionEnabled, let onRealtimeFrame,
      var processor = speechProcessors[track]
    else { return }
    let endpoint = processor.finish()
    speechProcessors[track] = processor
    for frame in endpoint { await onRealtimeFrame(frame) }
  }

  private func seal(track: MeetingAudioTrack) throws -> CapturedAudioChunk? {
    guard var buffer = tracks[track], !buffer.bytes.isEmpty,
      let start = buffer.startMilliseconds, let end = buffer.endMilliseconds, end > start
    else { return nil }
    let bytes = buffer.bytes
    let sequence = buffer.sequence
    buffer.sequence += 1
    buffer.bytes = Data()
    buffer.startMilliseconds = nil
    buffer.endMilliseconds = nil
    tracks[track] = buffer
    let metadata = try MeetingAudioChunk(
      chunkID: "\(sessionID):\(track.rawValue):\(sequence)",
      sessionID: sessionID,
      track: track,
      sequence: sequence,
      startMonotonicMilliseconds: start,
      endMonotonicMilliseconds: end,
      checksum: "sha256:\(SHA256.hash(data: bytes).hexString)",
      byteLength: bytes.count,
      codec: codec,
      sampleRateHertz: sampleRateHertz,
      channelCount: channelCount
    )
    return try CapturedAudioChunk(metadata: metadata, bytes: bytes)
  }
}

extension Digest {
  fileprivate var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
