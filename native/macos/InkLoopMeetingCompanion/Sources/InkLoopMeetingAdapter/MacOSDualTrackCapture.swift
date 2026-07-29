import AVFoundation
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

/// ScreenCaptureKit uses an application filter, so Remote is the target
/// application's output rather than an uncontrollable whole-system mix.
/// Microphone remains an independent AVAudioEngine input on macOS 13+.
public actor MacOSDualTrackCaptureAdapter: MeetingAudioCaptureAdapter {
  public nonisolated let capabilities = MeetingPlatformCapabilities(
    adapterID: "macos_screencapturekit_dual_track.v1",
    supportedPlatforms: [.googleMeet, .zoom],
    microphoneCaptureAvailable: true,
    applicationAudioScope: .targetApplication,
    confirmedEndDetectionAvailable: false
  )

  private let chunkDurationMilliseconds: Int64
  private let realtimeFrameSink: (any MeetingRealtimeAudioFrameSink)?
  private let appleVoiceProcessingEnabled: Bool
  private let concurrentMicrophoneEnginesVerified: Bool
  private let realtimeMicrophoneProjectionSelector: RealtimeMicrophoneProjectionSelector?
  private let trackStallTimeoutMilliseconds: Int64
  private let healthWatchdog: AudioTrackHealthWatchdog
  private var activeSession: MeetingSessionState?
  private var callback: (@Sendable (CapturedAudioChunk) async throws -> Void)?
  private var trackUnavailableCallback:
    (@Sendable (MeetingAudioTrack, Int64, String) async -> Void)?
  private var chunker: PCMMeetingAudioChunker?
  private var remoteStream: SCStream?
  private var remoteOutput: RemoteAudioOutput?
  private var microphoneEngine: AVAudioEngine?
  private var realtimeMicrophoneEngine: AVAudioEngine?
  private var appendCoordinator: AudioAppendCoordinator?
  private var healthMonitorTask: Task<Void, Never>?
  private var paused = false

  private static let captureSampleRateHertz = 16_000
  private static let captureChannelCount = 1

  public init(
    chunkDurationMilliseconds: Int64 = 5_000,
    realtimeFrameSink: (any MeetingRealtimeAudioFrameSink)? = nil,
    appleVoiceProcessingEnabled: Bool = true,
    concurrentMicrophoneEnginesVerified: Bool = false,
    trackStallTimeoutMilliseconds: Int64 = 15_000
  ) {
    self.chunkDurationMilliseconds = chunkDurationMilliseconds
    self.realtimeFrameSink = realtimeFrameSink
    self.appleVoiceProcessingEnabled = appleVoiceProcessingEnabled
    self.concurrentMicrophoneEnginesVerified = concurrentMicrophoneEnginesVerified
    realtimeMicrophoneProjectionSelector = realtimeFrameSink == nil
      ? nil : RealtimeMicrophoneProjectionSelector()
    self.trackStallTimeoutMilliseconds = max(1_000, trackStallTimeoutMilliseconds)
    healthWatchdog = AudioTrackHealthWatchdog(
      stallAfterMilliseconds: max(1_000, trackStallTimeoutMilliseconds))
  }

  public func startCapture(
    for session: MeetingSessionState,
    onSealedChunk: @escaping @Sendable (CapturedAudioChunk) async throws -> Void,
    onTrackUnavailable: @escaping @Sendable (MeetingAudioTrack, Int64, String) async -> Void
  ) async throws -> AudioCaptureStartResult {
    guard activeSession == nil else { throw MeetingAdapterError.alreadyRecording }
    activeSession = session
    callback = onSealedChunk
    trackUnavailableCallback = onTrackUnavailable
    paused = false
    let chunker = PCMMeetingAudioChunker(
      sessionID: session.sessionID,
      chunkDurationMilliseconds: chunkDurationMilliseconds,
      sampleRateHertz: Self.captureSampleRateHertz,
      channelCount: Self.captureChannelCount,
      realtimeSpeechProjectionEnabled: true,
      onRealtimeFrame: { [realtimeFrameSink] frame in
        await realtimeFrameSink?.enqueueRealtimeFrame(frame)
      },
      onSealedChunk: onSealedChunk
    )
    self.chunker = chunker
    let appendCoordinator = AudioAppendCoordinator()
    self.appendCoordinator = appendCoordinator
    let result = try await startHardware(
      session: session, chunker: chunker, appendCoordinator: appendCoordinator)
    return try AudioCaptureStartResult(
      activeTracks: result.active,
      unavailableTracks: Set(MeetingAudioTrack.allCases).subtracting(result.active)
    )
  }

  public func pauseAndSealCapture() async throws -> [CapturedAudioChunk] {
    guard activeSession != nil, !paused else { throw MeetingAdapterError.captureAlreadyPaused }
    await stopHardware()
    await appendCoordinator?.waitForIdle()
    paused = true
    let tails = try await chunker?.sealAll() ?? []
    return tails
  }

  public func resumeCapture() async throws -> AudioCaptureStartResult {
    guard let session = activeSession, let chunker, paused else {
      throw MeetingAdapterError.captureNotPaused
    }
    let appendCoordinator = self.appendCoordinator ?? AudioAppendCoordinator()
    self.appendCoordinator = appendCoordinator
    let result = try await startHardware(
      session: session, chunker: chunker, appendCoordinator: appendCoordinator)
    paused = false
    return try AudioCaptureStartResult(
      activeTracks: result.active,
      unavailableTracks: Set(MeetingAudioTrack.allCases).subtracting(result.active)
    )
  }

  public func stopAndSealCapture() async throws -> [CapturedAudioChunk] {
    guard activeSession != nil else { throw MeetingAdapterError.noActiveRecording }
    await stopHardware()
    await appendCoordinator?.waitForIdle()
    defer {
      activeSession = nil
      callback = nil
      trackUnavailableCallback = nil
      chunker = nil
      appendCoordinator = nil
      paused = false
    }
    let tails = try await chunker?.sealAll() ?? []
    return tails
  }

  private func startHardware(
    session: MeetingSessionState,
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator
  ) async throws -> (active: Set<MeetingAudioTrack>, errors: [Error]) {
    var active: Set<MeetingAudioTrack> = []
    var errors: [Error] = []
    realtimeMicrophoneProjectionSelector?.select(.raw)
    do {
      try startMicrophone(
        chunker: chunker,
        appendCoordinator: appendCoordinator,
        projectionSelector: realtimeMicrophoneProjectionSelector)
      active.insert(.mic)
    } catch { errors.append(error) }
    if Self.shouldStartIndependentVoiceProcessingEngine(
      rawEvidenceEngineActive: active.contains(.mic),
      realtimeFrameSinkAvailable: realtimeFrameSink != nil,
      voiceProcessingRequested: appleVoiceProcessingEnabled,
      concurrentMicrophoneEnginesVerified: concurrentMicrophoneEnginesVerified
    ) {
      do {
        try startRealtimeMicrophoneProjection(
          chunker: chunker,
          appendCoordinator: appendCoordinator,
          projectionSelector: realtimeMicrophoneProjectionSelector)
      } catch {
        // Voice Processing is an ASR-only enhancement. The raw fact track
        // remains active and its projection was never disabled.
      }
    }
    do {
      try await startRemote(
        session: session, chunker: chunker, appendCoordinator: appendCoordinator)
      active.insert(.remote)
    } catch { errors.append(error) }
    guard !active.isEmpty else {
      await stopHardware()
      throw errors.first ?? MeetingAdapterError.noAudioTracksAvailable
    }
    startHealthMonitor(for: active)
    return (active, errors)
  }

  private func startMicrophone(
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator,
    projectionSelector: RealtimeMicrophoneProjectionSelector?
  ) throws {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      throw MeetingAdapterError.capturePermissionDenied("microphone")
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    let captureFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Double(Self.captureSampleRateHertz),
      channels: AVAudioChannelCount(Self.captureChannelCount),
      interleaved: false
    )
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let captureFormat,
      let converter = AVAudioConverter(from: inputFormat, to: captureFormat)
    else {
      throw MeetingAdapterError.unsupportedAudioFormat
    }
    // AVAudioEngine invokes the tap on its realtime queue. Capturing this
    // actor from that callback triggers Swift 6's executor precondition at
    // runtime, even though the captured members are independently thread-safe.
    // Keep the callback in a Sendable helper that owns no adapter state.
    let tapHandler = MicrophoneAudioTapHandler(
      converter: converter,
      captureFormat: captureFormat,
      chunker: chunker,
      appendCoordinator: appendCoordinator,
      healthWatchdog: healthWatchdog,
      projectionSelector: projectionSelector
    )
    input.installTap(onBus: 0, bufferSize: 4_800, format: inputFormat) { buffer, _ in
      tapHandler.process(buffer)
    }
    engine.prepare()
    try engine.start()
    microphoneEngine = engine
  }

  private func startRealtimeMicrophoneProjection(
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator,
    projectionSelector: RealtimeMicrophoneProjectionSelector?
  ) throws {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    try input.setVoiceProcessingEnabled(true)
    guard input.isVoiceProcessingEnabled else {
      throw MeetingAdapterError.unsupportedAudioFormat
    }
    let inputFormat = input.outputFormat(forBus: 0)
    let captureFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Double(Self.captureSampleRateHertz),
      channels: AVAudioChannelCount(Self.captureChannelCount),
      interleaved: false)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let captureFormat,
      let converter = AVAudioConverter(from: inputFormat, to: captureFormat)
    else { throw MeetingAdapterError.unsupportedAudioFormat }
    let tapHandler = RealtimeMicrophoneProjectionTapHandler(
      converter: converter,
      captureFormat: captureFormat,
      chunker: chunker,
      appendCoordinator: appendCoordinator,
      projectionSelector: projectionSelector)
    input.installTap(onBus: 0, bufferSize: 4_800, format: inputFormat) { buffer, _ in
      tapHandler.process(buffer)
    }
    engine.prepare()
    try engine.start()
    realtimeMicrophoneEngine = engine
    projectionSelector?.select(.appleVoiceProcessing)
  }

  private func startRemote(
    session: MeetingSessionState,
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator
  ) async throws {
    guard CGPreflightScreenCaptureAccess() else {
      throw MeetingAdapterError.capturePermissionDenied("screen_and_system_audio")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let targetBundle = session.platform == .googleMeet ? "com.google.Chrome" : "us.zoom.xos"
    let applications = content.applications.filter { $0.bundleIdentifier == targetBundle }
    guard !applications.isEmpty else { throw MeetingAdapterError.targetApplicationUnavailable(session.platform) }
    guard let display = content.displays.first else {
      throw MeetingAdapterError.targetApplicationUnavailable(session.platform)
    }
    let filter = SCContentFilter(display: display, including: applications, exceptingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = Self.captureSampleRateHertz
    configuration.channelCount = Self.captureChannelCount
    configuration.width = 2
    configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3
    configuration.showsCursor = false
    let output = RemoteAudioOutput(
      chunker: chunker,
      appendCoordinator: appendCoordinator,
      healthWatchdog: healthWatchdog,
      onTrackUnavailable: trackUnavailableCallback
        ?? { _, _, _ in })
    let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
    try await stream.startCapture()
    remoteOutput = output
    remoteStream = stream
  }

  private func stopHardware() async {
    healthMonitorTask?.cancel()
    healthMonitorTask = nil
    healthWatchdog.reset()
    if let stream = remoteStream { try? await stream.stopCapture() }
    remoteStream = nil
    remoteOutput = nil
    if let engine = microphoneEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    microphoneEngine = nil
    if let engine = realtimeMicrophoneEngine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    realtimeMicrophoneEngine = nil
  }

  private func startHealthMonitor(for tracks: Set<MeetingAudioTrack>) {
    healthMonitorTask?.cancel()
    let now = Self.monotonicMilliseconds()
    healthWatchdog.activate(tracks, at: now)
    let watchdog = healthWatchdog
    let timeout = trackStallTimeoutMilliseconds
    let callback = trackUnavailableCallback ?? { _, _, _ in }
    healthMonitorTask = Task {
      let interval = Duration.milliseconds(max(500, min(2_000, timeout / 3)))
      while !Task.isCancelled {
        try? await Task.sleep(for: interval)
        guard !Task.isCancelled else { return }
        let observedAt = Self.monotonicMilliseconds()
        for track in watchdog.stalled(at: observedAt) {
          await callback(track, observedAt, "audio_callback_stalled")
        }
      }
    }
  }

  fileprivate static func monotonicMilliseconds() -> Int64 {
    Int64(ProcessInfo.processInfo.systemUptime * 1_000)
  }

  /// AVAudioEngine does not guarantee that two independent input nodes may
  /// concurrently own the same physical microphone. On affected Macs the
  /// second Voice Processing engine starts successfully but silently stops the
  /// raw evidence tap. Keep the authoritative fact track on one engine unless
  /// a future implementation verifies a shared/aggregate capture topology.
  static func shouldStartIndependentVoiceProcessingEngine(
    rawEvidenceEngineActive: Bool,
    realtimeFrameSinkAvailable: Bool,
    voiceProcessingRequested: Bool,
    concurrentMicrophoneEnginesVerified: Bool
  ) -> Bool {
    rawEvidenceEngineActive
      && realtimeFrameSinkAvailable
      && voiceProcessingRequested
      && concurrentMicrophoneEnginesVerified
  }

  private static func signed16BitPCMData(_ buffer: AVAudioPCMBuffer) -> Data? {
    guard let channels = buffer.floatChannelData else { return nil }
    let frames = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    var values = [Int16](repeating: 0, count: frames * channelCount)
    for frame in 0..<frames {
      for channel in 0..<channelCount {
        let sample = max(-1, min(1, channels[channel][frame]))
        values[frame * channelCount + channel] = Int16(
          max(Double(Int16.min), min(Double(Int16.max), Double(sample) * 32_767)))
      }
    }
    return values.withUnsafeBytes { Data($0) }
  }

  static func conversionOutputFrameCapacity(
    inputFrameLength: AVAudioFrameCount,
    inputSampleRate: Double,
    outputSampleRate: Double
  ) -> AVAudioFrameCount {
    let ratio = outputSampleRate / inputSampleRate
    let resampledFrameCapacity =
      AVAudioFrameCount(ceil(Double(inputFrameLength) * ratio)) + 1
    return max(inputFrameLength, resampledFrameCapacity)
  }

  static func convert(
    _ buffer: AVAudioPCMBuffer,
    with converter: AVAudioConverter,
    to format: AVAudioFormat
  ) -> AVAudioPCMBuffer? {
    let capacity = conversionOutputFrameCapacity(
      inputFrameLength: buffer.frameLength,
      inputSampleRate: buffer.format.sampleRate,
      outputSampleRate: format.sampleRate)
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    let inputState = AudioConverterInputState(buffer)
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
      guard !inputState.supplied else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      inputState.supplied = true
      inputStatus.pointee = .haveData
      return inputState.buffer
    }
    guard conversionError == nil, status != .error else { return nil }
    guard output.frameLength > 0 else { return nil }
    return output
  }
}

/// Owns everything used by AVAudioEngine's realtime callback so the closure
/// does not inherit `MacOSDualTrackCaptureAdapter` actor isolation.
final class MicrophoneAudioTapHandler: @unchecked Sendable {
  private let converter: AVAudioConverter
  private let captureFormat: AVAudioFormat
  private let chunker: PCMMeetingAudioChunker
  private let appendCoordinator: AudioAppendCoordinator
  private let healthWatchdog: AudioTrackHealthWatchdog
  private let projectionSelector: RealtimeMicrophoneProjectionSelector?

  init(
    converter: AVAudioConverter,
    captureFormat: AVAudioFormat,
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator,
    healthWatchdog: AudioTrackHealthWatchdog,
    projectionSelector: RealtimeMicrophoneProjectionSelector? = nil
  ) {
    self.converter = converter
    self.captureFormat = captureFormat
    self.chunker = chunker
    self.appendCoordinator = appendCoordinator
    self.healthWatchdog = healthWatchdog
    self.projectionSelector = projectionSelector
  }

  func process(_ buffer: AVAudioPCMBuffer) {
    guard
      let converted = MacOSDualTrackCaptureAdapter.convert(
        buffer, with: converter, to: captureFormat),
      let bytes = Self.signed16BitPCMData(converted)
    else { return }
    let end = MacOSDualTrackCaptureAdapter.monotonicMilliseconds()
    healthWatchdog.observe(.mic, at: end)
    let duration = Int64(
      Double(converted.frameLength) / captureFormat.sampleRate * 1_000)
    appendCoordinator.schedule { [chunker, projectionSelector] in
      let projectRealtimeFrame = projectionSelector?.shouldProject(.raw) ?? true
      do {
        try await chunker.append(
          track: .mic,
          bytes: bytes,
          startMilliseconds: max(0, end - duration),
          endMilliseconds: end,
          projectRealtimeFrame: projectRealtimeFrame,
          realtimeAudioDerivation: .raw
        )
      } catch { /* retained by chunker and retried by the next frame or stop */ }
    }
  }

  private static func signed16BitPCMData(_ buffer: AVAudioPCMBuffer) -> Data? {
    guard let channels = buffer.floatChannelData else { return nil }
    let frames = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    var values = [Int16](repeating: 0, count: frames * channelCount)
    for frame in 0..<frames {
      for channel in 0..<channelCount {
        let sample = max(-1, min(1, channels[channel][frame]))
        values[frame * channelCount + channel] = Int16(
          max(Double(Int16.min), min(Double(Int16.max), Double(sample) * 32_767)))
      }
    }
    return values.withUnsafeBytes { Data($0) }
  }
}

/// A second AVAudioEngine is intentionally ASR-only. Its samples can use
/// Apple's Voice Processing IO without replacing the raw microphone evidence
/// written by `MicrophoneAudioTapHandler`.
final class RealtimeMicrophoneProjectionTapHandler: @unchecked Sendable {
  private let converter: AVAudioConverter
  private let captureFormat: AVAudioFormat
  private let chunker: PCMMeetingAudioChunker
  private let appendCoordinator: AudioAppendCoordinator
  private let projectionSelector: RealtimeMicrophoneProjectionSelector?

  init(
    converter: AVAudioConverter,
    captureFormat: AVAudioFormat,
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator,
    projectionSelector: RealtimeMicrophoneProjectionSelector?
  ) {
    self.converter = converter
    self.captureFormat = captureFormat
    self.chunker = chunker
    self.appendCoordinator = appendCoordinator
    self.projectionSelector = projectionSelector
  }

  func process(_ buffer: AVAudioPCMBuffer) {
    guard let converted = MacOSDualTrackCaptureAdapter.convert(
      buffer, with: converter, to: captureFormat),
      let bytes = MicrophonePCMEncoding.signed16BitData(converted)
    else { return }
    let end = MacOSDualTrackCaptureAdapter.monotonicMilliseconds()
    let duration = Int64(Double(converted.frameLength) / captureFormat.sampleRate * 1_000)
    appendCoordinator.schedule { [chunker, projectionSelector] in
      guard projectionSelector?.shouldProject(.appleVoiceProcessing) ?? true else { return }
      await chunker.projectRealtimeFrame(
        track: .mic,
        bytes: bytes,
        startMilliseconds: max(0, end - duration),
        endMilliseconds: end,
        audioDerivation: .appleVoiceProcessing)
    }
  }
}

final class RealtimeMicrophoneProjectionSelector: @unchecked Sendable {
  private let lock = NSLock()
  private var selected: MeetingRealtimeAudioDerivation = .raw

  func select(_ derivation: MeetingRealtimeAudioDerivation) {
    lock.withLock { selected = derivation }
  }

  func shouldProject(_ derivation: MeetingRealtimeAudioDerivation) -> Bool {
    lock.withLock { selected == derivation }
  }
}

private enum MicrophonePCMEncoding {
  static func signed16BitData(_ buffer: AVAudioPCMBuffer) -> Data? {
    guard let channels = buffer.floatChannelData else { return nil }
    let frames = Int(buffer.frameLength)
    let channelCount = Int(buffer.format.channelCount)
    var values = [Int16](repeating: 0, count: frames * channelCount)
    for frame in 0..<frames {
      for channel in 0..<channelCount {
        let sample = max(-1, min(1, channels[channel][frame]))
        values[frame * channelCount + channel] = Int16(
          max(Double(Int16.min), min(Double(Int16.max), Double(sample) * 32_767)))
      }
    }
    return values.withUnsafeBytes { Data($0) }
  }
}

private final class AudioConverterInputState: @unchecked Sendable {
  let buffer: AVAudioPCMBuffer
  var supplied = false

  init(_ buffer: AVAudioPCMBuffer) {
    self.buffer = buffer
  }
}

private final class RemoteAudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "ai.inkloop.meeting.remote-audio")
  private let chunker: PCMMeetingAudioChunker
  private let appendCoordinator: AudioAppendCoordinator
  private let healthWatchdog: AudioTrackHealthWatchdog
  private let onTrackUnavailable:
    @Sendable (MeetingAudioTrack, Int64, String) async -> Void

  init(
    chunker: PCMMeetingAudioChunker,
    appendCoordinator: AudioAppendCoordinator,
    healthWatchdog: AudioTrackHealthWatchdog,
    onTrackUnavailable: @escaping @Sendable (MeetingAudioTrack, Int64, String) async -> Void
  ) {
    self.chunker = chunker
    self.appendCoordinator = appendCoordinator
    self.healthWatchdog = healthWatchdog
    self.onTrackUnavailable = onTrackUnavailable
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sampleBuffer.isValid else { return }
    let data: Data
    do { data = try Self.signed16BitPCMData(sampleBuffer) }
    catch { return }
    guard !data.isEmpty else { return }
    let end = MacOSDualTrackCaptureAdapter.monotonicMilliseconds()
    healthWatchdog.observe(.remote, at: end)
    let duration = Int64(CMTimeGetSeconds(sampleBuffer.duration) * 1_000)
    appendCoordinator.schedule {
      do {
        try await self.chunker.append(
          track: .remote, bytes: data,
          startMilliseconds: max(0, end - max(1, duration)), endMilliseconds: end)
      } catch { /* retained by chunker and retried by the next frame or stop */ }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: any Error) {
    let reason = String(describing: error)
    Task {
      await onTrackUnavailable(
        .remote,
        MacOSDualTrackCaptureAdapter.monotonicMilliseconds(),
        reason.isEmpty ? "screen_capture_stream_stopped" : reason
      )
    }
  }

  private static func signed16BitPCMData(_ sampleBuffer: CMSampleBuffer) throws -> Data {
    guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
      let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
      basic.mFormatID == kAudioFormatLinearPCM,
      basic.mBitsPerChannel == 32,
      basic.mFormatFlags & kAudioFormatFlagIsFloat != 0
    else { throw MeetingAdapterError.unsupportedAudioFormat }
    return try sampleBuffer.withAudioBufferList { buffers, _ -> Data in
      guard !buffers.isEmpty else { return Data() }
      if basic.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 {
        guard let pointer = buffers[0].mData else { return Data() }
        let count = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
        let source = pointer.assumingMemoryBound(to: Float.self)
        return quantize(source: source, count: count)
      }
      let channelCount = buffers.count
      let frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
      var interleaved = [Int16](repeating: 0, count: frames * channelCount)
      for channel in 0..<channelCount {
        guard let source = buffers[channel].mData?.assumingMemoryBound(to: Float.self) else {
          return Data()
        }
        for frame in 0..<frames {
          interleaved[frame * channelCount + channel] = quantize(source[frame])
        }
      }
      return interleaved.withUnsafeBytes { Data($0) }
    }
  }

  private static func quantize(source: UnsafePointer<Float>, count: Int) -> Data {
    var output = [Int16](repeating: 0, count: count)
    for index in 0..<count { output[index] = quantize(source[index]) }
    return output.withUnsafeBytes { Data($0) }
  }

  private static func quantize(_ sample: Float) -> Int16 {
    let clamped = max(-1, min(1, sample))
    return Int16(max(Double(Int16.min), min(Double(Int16.max), Double(clamped) * 32_767)))
  }
}

/// Audio callbacks are synchronous but persistence is asynchronous. The
/// coordinator registers work before a Task can be delayed by the scheduler,
/// allowing pause/stop to wait until every callback that already entered the
/// process has either persisted or moved its chunk into the retry queue.
final class AudioAppendCoordinator: @unchecked Sendable {
  private let lock = NSLock()
  private var activeCount = 0
  private var tail: Task<Void, Never>?
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func schedule(_ work: @escaping @Sendable () async -> Void) {
    lock.lock()
    activeCount += 1
    let predecessor = tail
    let task = Task {
      await predecessor?.value
      await work()
      self.didFinish()
    }
    tail = task
    lock.unlock()
  }

  func waitForIdle() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if activeCount == 0 {
        lock.unlock()
        continuation.resume()
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  private func didFinish() {
    lock.lock()
    activeCount -= 1
    guard activeCount == 0 else {
      lock.unlock()
      return
    }
    let pendingWaiters = waiters
    waiters = []
    tail = nil
    lock.unlock()
    pendingWaiters.forEach { $0.resume() }
  }
}
