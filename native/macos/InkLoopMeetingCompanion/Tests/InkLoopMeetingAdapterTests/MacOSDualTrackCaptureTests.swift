@preconcurrency import AVFoundation
import Testing
@testable import InkLoopMeetingAdapter

@Suite("macOS dual-track capture")
struct MacOSDualTrackCaptureTests {
  @Test("downsampling reserves the input frame length required by AVAudioConverter")
  func downsamplingCapacityCoversInputFrames() {
    let inputFrameLength: AVAudioFrameCount = 4_800

    let capacity = MacOSDualTrackCaptureAdapter.conversionOutputFrameCapacity(
      inputFrameLength: inputFrameLength,
      inputSampleRate: 48_000,
      outputSampleRate: 16_000)

    #expect(capacity >= inputFrameLength)
  }

  @Test("downsampling a hardware microphone buffer produces 16 kHz mono frames")
  func downsamplesHardwareMicrophoneBuffer() throws {
    let inputFormat = try #require(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 48_000,
      channels: 2,
      interleaved: false))
    let outputFormat = try #require(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false))
    let input = try #require(AVAudioPCMBuffer(
      pcmFormat: inputFormat,
      frameCapacity: 4_800))
    input.frameLength = 4_800
    let converter = try #require(AVAudioConverter(from: inputFormat, to: outputFormat))

    let output = MacOSDualTrackCaptureAdapter.convert(
      input,
      with: converter,
      to: outputFormat)

    #expect((output?.frameLength ?? 0) > 0)
    #expect((output?.frameLength ?? 0) <= 1_600)
    #expect(output?.format.sampleRate == 16_000)
    #expect(output?.format.channelCount == 1)
  }

  @Test("microphone tap processing is safe from a non-actor realtime queue")
  func processesMicrophoneTapOffActor() async throws {
    let inputFormat = try #require(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 48_000,
      channels: 1,
      interleaved: false))
    let outputFormat = try #require(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false))
    let input = try #require(AVAudioPCMBuffer(
      pcmFormat: inputFormat,
      frameCapacity: 4_800))
    input.frameLength = 4_800
    let converter = try #require(AVAudioConverter(from: inputFormat, to: outputFormat))
    let chunker = PCMMeetingAudioChunker(
      sessionID: "mic-tap-off-actor",
      chunkDurationMilliseconds: 5_000,
      sampleRateHertz: 16_000,
      channelCount: 1,
      onSealedChunk: { _ in })
    let coordinator = AudioAppendCoordinator()
    let handler = MicrophoneAudioTapHandler(
      converter: converter,
      captureFormat: outputFormat,
      chunker: chunker,
      appendCoordinator: coordinator,
      healthWatchdog: AudioTrackHealthWatchdog(stallAfterMilliseconds: 15_000)
    )

    await withCheckedContinuation { continuation in
      DispatchQueue(label: "test.realtime-microphone-callback").async {
        handler.process(input)
        continuation.resume()
      }
    }
    await coordinator.waitForIdle()
    let tails = try await chunker.sealAll()

    #expect(tails.contains { $0.metadata.track == .mic && !$0.bytes.isEmpty })
  }

  @Test("voice processing projection selection is atomic and reversible")
  func switchesRealtimeProjectionMode() {
    let selector = RealtimeMicrophoneProjectionSelector()

    #expect(selector.shouldProject(.raw))
    #expect(!selector.shouldProject(.appleVoiceProcessing))
    selector.select(.appleVoiceProcessing)
    #expect(!selector.shouldProject(.raw))
    #expect(selector.shouldProject(.appleVoiceProcessing))
    selector.select(.raw)
    #expect(selector.shouldProject(.raw))
  }

  @Test("raw evidence capture never starts an unverified second microphone engine")
  func protectsRawEvidenceFromConcurrentVoiceProcessingEngine() {
    #expect(!MacOSDualTrackCaptureAdapter.shouldStartIndependentVoiceProcessingEngine(
      rawEvidenceEngineActive: true,
      realtimeFrameSinkAvailable: true,
      voiceProcessingRequested: true,
      concurrentMicrophoneEnginesVerified: false))
    #expect(MacOSDualTrackCaptureAdapter.shouldStartIndependentVoiceProcessingEngine(
      rawEvidenceEngineActive: true,
      realtimeFrameSinkAvailable: true,
      voiceProcessingRequested: true,
      concurrentMicrophoneEnginesVerified: true))
  }
}
