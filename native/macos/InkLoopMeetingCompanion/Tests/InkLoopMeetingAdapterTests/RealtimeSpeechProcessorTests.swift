import Foundation
import Testing
@testable import InkLoopMeetingAdapter

@Suite("realtime mic speech projection")
struct RealtimeSpeechProcessorTests {
  @Test("wire frames reject sample rates the server contract cannot ingest")
  func rejectsUnsupportedRealtimeSampleRate() {
    #expect(throws: MeetingAdapterError.invalidAudioChunk) {
      _ = try MeetingRealtimeAudioFrame(
        frameID: "session-1:mic:frame:0",
        sessionID: "session-1",
        track: .mic,
        frameSequence: 0,
        sourceChunkID: "session-1:mic:0",
        startMonotonicMilliseconds: 0,
        endMonotonicMilliseconds: 100,
        sampleRateHertz: 44_100
      )
    }
  }

  @Test("rejects a steady noise floor but keeps speech pre-roll and hangover")
  func adaptiveSpeechGate() throws {
    var processor = AdaptiveMicSpeechProcessor(
      preRollMilliseconds: 100,
      minimumSpeechMilliseconds: 60,
      hangoverMilliseconds: 100
    )
    var outputs: [CapturedRealtimeAudioFrame] = []
    var sequence = 0
    for amplitude in Array(repeating: Int16(120), count: 4)
      + Array(repeating: Int16(6_000), count: 1)
      + Array(repeating: Int16(120), count: 2)
    {
      outputs.append(contentsOf: processor.process(try frame(
        sequence: sequence, amplitude: amplitude)))
      sequence += 1
    }

    #expect(outputs.count >= 4)
    #expect(outputs.count < 15)
    #expect(outputs.map(\.metadata.frameSequence)
      == Array(0..<outputs.count))
    #expect(outputs.first?.metadata.startMonotonicMilliseconds ?? 10_000 < 500)
    #expect(outputs.last?.metadata.endMonotonicMilliseconds ?? 0 >= 500)
    #expect(outputs.contains(where: {
      $0.metadata.speechPresent == true && !$0.bytes.isEmpty
    }))
    #expect(outputs.contains(where: {
      $0.metadata.speechPresent == false && $0.bytes.isEmpty
    }))
  }

  @Test("does not rewrite the durable source bytes")
  func leavesFactBytesUntouched() throws {
    var processor = AdaptiveMicSpeechProcessor(minimumSpeechMilliseconds: 20)
    let source = try frame(sequence: 0, amplitude: 8_000)
    let original = source.bytes

    _ = processor.process(source)

    #expect(source.bytes == original)
  }

  @Test("flushes undecided pre-roll as silent coverage at the durable chunk boundary")
  func flushesCoverageAtFactBoundary() throws {
    var processor = AdaptiveMicSpeechProcessor(
      preRollMilliseconds: 200,
      minimumSpeechMilliseconds: 60,
      hangoverMilliseconds: 100
    )
    let source = try frame(sequence: 0, amplitude: 120)

    let projected = processor.process(source)
    let flushed = processor.flushCoverage(sourceChunkID: source.metadata.sourceChunkID)

    #expect(projected.count + flushed.count == 1)
    #expect((projected + flushed).allSatisfy {
      $0.metadata.speechPresent == false && $0.bytes.isEmpty
    })
    #expect((projected + flushed).map(\.metadata.frameSequence) == [0])
  }

  @Test("coalesces long silence into one coverage range")
  func coalescesSilentCoverage() throws {
    var processor = AdaptiveMicSpeechProcessor(
      preRollMilliseconds: 200,
      minimumSpeechMilliseconds: 60,
      hangoverMilliseconds: 100
    )
    var projected: [CapturedRealtimeAudioFrame] = []
    for sequence in 0..<20 {
      projected.append(contentsOf: processor.process(try frame(
        sequence: sequence, amplitude: 120)))
    }
    let flushed = processor.flushCoverage(sourceChunkID: "session:mic:0")

    #expect(projected.isEmpty)
    #expect(flushed.count == 1)
    #expect(flushed.first?.metadata.speechPresent == false)
    #expect(flushed.first?.metadata.startMonotonicMilliseconds == 0)
    #expect(flushed.first?.metadata.endMonotonicMilliseconds == 2_000)
  }

  @Test("preserves the source track in the speech projection")
  func preservesRemoteTrack() throws {
    var processor = AdaptiveMicSpeechProcessor(
      preRollMilliseconds: 0,
      minimumSpeechMilliseconds: 20,
      hangoverMilliseconds: 20
    )
    var output: [CapturedRealtimeAudioFrame] = []
    for sequence in 0..<3 {
      output.append(contentsOf: processor.process(try frame(
        sequence: sequence,
        amplitude: sequence == 2 ? 8_000 : 120,
        track: .remote)))
    }

    #expect(!output.isEmpty)
    #expect(output.allSatisfy { $0.metadata.track == .remote })
  }

  @Test("emits an endpoint when capture stops during active speech")
  func finishesActiveSpeech() throws {
    var processor = AdaptiveMicSpeechProcessor(
      preRollMilliseconds: 0,
      minimumSpeechMilliseconds: 20,
      hangoverMilliseconds: 500
    )
    var output: [CapturedRealtimeAudioFrame] = []
    for sequence in 0..<12 {
      output.append(contentsOf: processor.process(try frame(
        sequence: sequence,
        amplitude: sequence < 10 ? 120 : 8_000)))
    }
    output.append(contentsOf: processor.finish())

    #expect(output.contains { $0.metadata.speechPresent == true })
    #expect(output.last?.metadata.speechPresent == false)
  }

  @Test("watchdog reports a silent callback stall once and recovers after activity")
  func trackStallWatchdog() {
    let watchdog = AudioTrackHealthWatchdog(stallAfterMilliseconds: 1_000)
    watchdog.activate([.mic, .remote], at: 100)
    watchdog.observe(.remote, at: 900)

    #expect(watchdog.stalled(at: 1_200) == [.mic])
    #expect(watchdog.stalled(at: 1_300).isEmpty)
    watchdog.observe(.mic, at: 1_400)
    #expect(watchdog.stalled(at: 2_500) == [.mic, .remote])
  }

  private func frame(
    sequence: Int,
    amplitude: Int16,
    track: MeetingAudioTrack = .mic
  ) throws -> CapturedRealtimeAudioFrame {
    var samples = [Int16](repeating: 0, count: 1_600)
    for index in samples.indices {
      samples[index] = index.isMultiple(of: 2) ? amplitude : -amplitude
    }
    let bytes = samples.withUnsafeBytes { Data($0) }
    return CapturedRealtimeAudioFrame(
      metadata: try MeetingRealtimeAudioFrame(
        frameID: "session:\(track.rawValue):frame:\(sequence)",
        sessionID: "session",
        track: track,
        frameSequence: sequence,
        sourceChunkID: "session:\(track.rawValue):0",
        startMonotonicMilliseconds: Int64(sequence * 100),
        endMonotonicMilliseconds: Int64((sequence + 1) * 100)
      ),
      bytes: bytes
    )
  }
}
