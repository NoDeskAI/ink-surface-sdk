import Foundation
import Testing

@testable import InkLoopMeetingAdapter

@Suite("PCM meeting audio chunker")
struct AudioChunkerTests {
  @Test("emits immutable per-track sequence chunks at the configured boundary")
  func emitsChunks() async throws {
    let sink = ChunkSink()
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-1",
      chunkDurationMilliseconds: 1_000
    ) { chunk in await sink.append(chunk) }

    try await chunker.append(track: .mic, bytes: Data([1, 2]), startMilliseconds: 100, endMilliseconds: 600)
    try await chunker.append(track: .mic, bytes: Data([3, 4]), startMilliseconds: 600, endMilliseconds: 1_100)
    try await chunker.append(track: .remote, bytes: Data([8]), startMilliseconds: 200, endMilliseconds: 400)
    let tails = try await chunker.sealAll()

    let emitted = await sink.values
    #expect(emitted.count == 1)
    #expect(emitted.first?.metadata.chunkID == "session-1:mic:0")
    #expect(emitted.first?.bytes == Data([1, 2, 3, 4]))
    #expect(emitted.first?.metadata.codec == "pcm_s16le")
    #expect(emitted.first?.metadata.sampleRateHertz == 16_000)
    #expect(emitted.first?.metadata.channelCount == 1)
    #expect(tails.map(\.metadata.chunkID) == ["session-1:remote:0"])
  }

  @Test("retains a sealed chunk until the durable sink accepts it")
  func retriesFailedSink() async throws {
    let sink = RetryingChunkSink()
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-retry",
      chunkDurationMilliseconds: 1_000
    ) { chunk in try await sink.append(chunk) }

    await #expect(throws: RetryingChunkSink.SinkError.firstAttempt) {
      try await chunker.append(
        track: .mic, bytes: Data([1, 2]),
        startMilliseconds: 100, endMilliseconds: 1_100)
    }
    try await chunker.flushPending()

    let accepted = await sink.accepted
    #expect(accepted.map(\.metadata.chunkID) == ["session-retry:mic:0"])
    #expect(accepted.first?.bytes == Data([1, 2]))
    #expect(try await chunker.sealAll().isEmpty)
  }

  @Test("returns a failed pending chunk to the controller seal path")
  func returnsFailedSinkOnSeal() async throws {
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-stop",
      chunkDurationMilliseconds: 1_000
    ) { _ in throw RetryingChunkSink.SinkError.firstAttempt }

    await #expect(throws: RetryingChunkSink.SinkError.firstAttempt) {
      try await chunker.append(
        track: .remote, bytes: Data([8, 9]),
        startMilliseconds: 100, endMilliseconds: 1_100)
    }

    let sealed = try await chunker.sealAll()
    #expect(sealed.map(\.metadata.chunkID) == ["session-stop:remote:0"])
    #expect(sealed.first?.bytes == Data([8, 9]))
  }

  @Test("waits for every audio callback already in flight before sealing")
  func waitsForInflightCallbacks() async {
    let coordinator = AudioAppendCoordinator()
    let gate = AsyncGate()
    let completed = CompletionFlag()
    coordinator.schedule {
      await gate.wait()
      await completed.mark()
    }

    let waiter = Task {
      await coordinator.waitForIdle()
      return await completed.value
    }
    await Task.yield()
    #expect(await completed.value == false)
    await gate.open()
    #expect(await waiter.value == true)
  }

  @Test("preserves audio callback order across asynchronous persistence")
  func preservesCallbackOrder() async {
    let coordinator = AudioAppendCoordinator()
    let gate = AsyncGate()
    let order = OrderedValues()
    coordinator.schedule {
      await gate.wait()
      await order.append(1)
    }
    coordinator.schedule { await order.append(2) }

    await Task.yield()
    #expect(await order.values.isEmpty)
    await gate.open()
    await coordinator.waitForIdle()
    #expect(await order.values == [1, 2])
  }

  @Test("projects low-latency frames without changing the five-second fact boundary")
  func projectsRealtimeFramesSeparatelyFromFactChunks() async throws {
    let durable = ChunkSink()
    let realtime = RealtimeFrameSink()
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-realtime",
      chunkDurationMilliseconds: 5_000,
      onRealtimeFrame: { frame in await realtime.append(frame) }
    ) { chunk in await durable.append(chunk) }

    try await chunker.append(
      track: .mic, bytes: Data(repeating: 1, count: 3_200),
      startMilliseconds: 100, endMilliseconds: 200)
    try await chunker.append(
      track: .mic, bytes: Data(repeating: 2, count: 3_200),
      startMilliseconds: 200, endMilliseconds: 300)
    await realtime.waitForCount(2)

    #expect(await durable.values.isEmpty)
    let frames = await realtime.values
    #expect(frames.map(\.metadata.frameSequence) == [0, 1])
    #expect(frames.map(\.metadata.sourceChunkID) == [
      "session-realtime:mic:0",
      "session-realtime:mic:0",
    ])
    #expect(frames.map(\.bytes.count) == [3_200, 3_200])
    let tails = try await chunker.sealAll()
    #expect(tails.map(\.metadata.chunkID) == ["session-realtime:mic:0"])
  }

  @Test("keeps a derived ASR frame out of the authoritative fact chunk")
  func derivedProjectionDoesNotMutateFacts() async throws {
    let realtime = RealtimeFrameSink()
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-derived",
      chunkDurationMilliseconds: 5_000,
      onRealtimeFrame: { frame in await realtime.append(frame) }
    ) { _ in }

    try await chunker.append(
      track: .mic,
      bytes: Data(repeating: 1, count: 3_200),
      startMilliseconds: 100,
      endMilliseconds: 200,
      projectRealtimeFrame: false)
    await chunker.projectRealtimeFrame(
      track: .mic,
      bytes: Data(repeating: 9, count: 3_200),
      startMilliseconds: 100,
      endMilliseconds: 200,
      audioDerivation: .appleVoiceProcessing)
    await realtime.waitForCount(1)

    let frames = await realtime.values
    #expect(frames.map(\.metadata.frameSequence) == [0])
    #expect(frames.first?.metadata.audioDerivation == .appleVoiceProcessing)
    #expect(frames.first?.bytes == Data(repeating: 9, count: 3_200))
    let tails = try await chunker.sealAll()
    #expect(tails.count == 1)
    #expect(tails.first?.bytes == Data(repeating: 1, count: 3_200))
  }

  @Test("does not create a realtime sequence gap when raw projection is disabled")
  func disabledRawProjectionDoesNotAdvanceSequence() async throws {
    let realtime = RealtimeFrameSink()
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-sequence",
      chunkDurationMilliseconds: 5_000,
      onRealtimeFrame: { frame in await realtime.append(frame) }
    ) { _ in }

    try await chunker.append(
      track: .mic,
      bytes: Data(repeating: 1, count: 3_200),
      startMilliseconds: 100,
      endMilliseconds: 200,
      projectRealtimeFrame: false)
    try await chunker.append(
      track: .mic,
      bytes: Data(repeating: 2, count: 3_200),
      startMilliseconds: 200,
      endMilliseconds: 300,
      realtimeAudioDerivation: .raw)
    await realtime.waitForCount(1)

    #expect(await realtime.values.map(\.metadata.frameSequence) == [0])
    #expect(await realtime.values.first?.metadata.audioDerivation == .raw)
  }

  @Test("speech projection gates ASR frames without changing durable fact bytes")
  func speechProjectionKeepsFactsAuthoritative() async throws {
    let realtime = RealtimeFrameSink()
    let chunker = PCMMeetingAudioChunker(
      sessionID: "session-speech-projection",
      chunkDurationMilliseconds: 5_000,
      realtimeSpeechProjectionEnabled: true,
      onRealtimeFrame: { frame in await realtime.append(frame) }
    ) { _ in }
    var factBytes = Data()

    for sequence in 0..<16 {
      let amplitude: Int16 = sequence < 10 ? 120 : (sequence < 14 ? 7_000 : 120)
      let bytes = pcm(amplitude: amplitude, samples: 1_600)
      factBytes.append(bytes)
      try await chunker.append(
        track: .mic,
        bytes: bytes,
        startMilliseconds: Int64(sequence * 100),
        endMilliseconds: Int64((sequence + 1) * 100),
        realtimeAudioDerivation: .raw)
    }
    let tails = try await chunker.sealAll()
    let projected = await realtime.values

    #expect(tails.count == 1)
    #expect(tails.first?.bytes == factBytes)
    #expect(projected.contains {
      $0.metadata.speechPresent == true && !$0.bytes.isEmpty
    })
    #expect(projected.contains {
      $0.metadata.speechPresent == false && $0.bytes.isEmpty
    })
    #expect(projected.filter { $0.metadata.speechPresent == true }.count < 16)
    #expect(projected.map(\.metadata.frameSequence) == Array(0..<projected.count))
  }

  private func pcm(amplitude: Int16, samples: Int) -> Data {
    var values = [Int16](repeating: 0, count: samples)
    for index in values.indices {
      values[index] = index.isMultiple(of: 2) ? amplitude : -amplitude
    }
    return values.withUnsafeBytes { Data($0) }
  }
}

private actor ChunkSink {
  private(set) var values: [CapturedAudioChunk] = []
  func append(_ chunk: CapturedAudioChunk) { values.append(chunk) }
}

private actor RetryingChunkSink {
  enum SinkError: Error { case firstAttempt }
  private var attempts = 0
  private(set) var accepted: [CapturedAudioChunk] = []

  func append(_ chunk: CapturedAudioChunk) throws {
    attempts += 1
    if attempts == 1 { throw SinkError.firstAttempt }
    accepted.append(chunk)
  }
}

private actor RealtimeFrameSink {
  private(set) var values: [CapturedRealtimeAudioFrame] = []

  func append(_ frame: CapturedRealtimeAudioFrame) {
    values.append(frame)
  }

  func waitForCount(_ count: Int) async {
    while values.count < count { await Task.yield() }
  }
}

private actor AsyncGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var isOpen = false

  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { continuation = $0 }
  }

  func open() {
    isOpen = true
    continuation?.resume()
    continuation = nil
  }
}

private actor CompletionFlag {
  private(set) var value = false
  func mark() { value = true }
}

private actor OrderedValues {
  private(set) var values: [Int] = []
  func append(_ value: Int) { values.append(value) }
}
