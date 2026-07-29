import Foundation

/// Produces a speech-focused ASR projection while leaving the durable
/// CapturedAudioChunk byte-for-byte unchanged.
public struct AdaptiveMicSpeechProcessor: Sendable {
  private struct Subframe: Sendable {
    let bytes: Data
    let sessionID: String
    let track: MeetingAudioTrack
    let sourceChunkID: String
    let startMilliseconds: Int64
    let endMilliseconds: Int64
  }

  private let frameDurationMilliseconds: Int64
  private let preRollFrameCount: Int
  private let minimumSpeechFrameCount: Int
  private let hangoverFrameCount: Int
  private var noiseFloorDecibels: Double = -60
  private var noiseFloorInitialized = false
  private var preRoll: [Subframe] = []
  private var candidateSpeech: [Subframe] = []
  private var pendingCoverage: [Subframe] = []
  private var speechActive = false
  private var hangoverRemaining = 0
  private var outputSequence = 0
  private var previousInput: Float = 0
  private var previousOutput: Float = 0
  private var observedFrameCount = 0
  private var currentSessionID: String?
  private var currentTrack: MeetingAudioTrack?

  public init(
    frameDurationMilliseconds: Int64 = 20,
    preRollMilliseconds: Int64 = 200,
    minimumSpeechMilliseconds: Int64 = 60,
    hangoverMilliseconds: Int64 = 500
  ) {
    self.frameDurationMilliseconds = max(20, frameDurationMilliseconds)
    preRollFrameCount = Int(max(0, preRollMilliseconds) / self.frameDurationMilliseconds)
    minimumSpeechFrameCount = max(
      1, Int(ceil(Double(max(1, minimumSpeechMilliseconds))
        / Double(self.frameDurationMilliseconds))))
    hangoverFrameCount = Int(max(0, hangoverMilliseconds) / self.frameDurationMilliseconds)
  }

  public mutating func process(
    _ frame: CapturedRealtimeAudioFrame
  ) -> [CapturedRealtimeAudioFrame] {
    guard frame.metadata.codec == "pcm_s16le",
      frame.metadata.channelCount == 1,
      frame.metadata.sampleRateHertz > 0,
      frame.bytes.count >= 2
    else { return [frame] }
    if currentSessionID != frame.metadata.sessionID {
      reset()
      currentSessionID = frame.metadata.sessionID
      currentTrack = frame.metadata.track
    }

    var output: [CapturedRealtimeAudioFrame] = []
    let subframes = splitAndFilter(frame)
    for subframe in subframes {
      let decibels = rmsDecibels(subframe.bytes)
      observedFrameCount += 1
      if observedFrameCount <= 10, !speechActive {
        noiseFloorDecibels = noiseFloorInitialized
          ? noiseFloorDecibels * 0.8 + decibels * 0.2
          : decibels
        noiseFloorInitialized = true
        for evicted in appendPreRoll(subframe) {
          appendCoverage(evicted)
        }
        continue
      }
      let threshold = max(-48, min(-26, noiseFloorDecibels + 8))
      let likelySpeech = decibels >= threshold
      if !likelySpeech {
        let adaptation = speechActive ? 0.002 : 0.04
        noiseFloorDecibels = noiseFloorInitialized
          ? noiseFloorDecibels * (1 - adaptation) + decibels * adaptation
          : decibels
        noiseFloorInitialized = true
      }

      if likelySpeech {
        if speechActive {
          output.append(makeOutput(subframe, applyGain: true))
        } else {
          candidateSpeech.append(subframe)
          if candidateSpeech.count >= minimumSpeechFrameCount {
        speechActive = true
        hangoverRemaining = hangoverFrameCount
        output.append(contentsOf: drainCoverage())
        output.append(contentsOf: preRoll.map { makeOutput($0, applyGain: false) })
        output.append(contentsOf: candidateSpeech.map { makeOutput($0, applyGain: true) })
            preRoll.removeAll(keepingCapacity: true)
            candidateSpeech.removeAll(keepingCapacity: true)
          }
        }
        hangoverRemaining = hangoverFrameCount
        continue
      }

      if speechActive, hangoverRemaining > 0 {
        hangoverRemaining -= 1
        if hangoverRemaining == 0 {
          // This frame is already known to be silence. Use it as the explicit
          // endpoint marker so buffered ASR flushes immediately after the
          // hangover, rather than waiting for the next fact-chunk boundary.
          output.append(makeCoverageOutput(subframe))
          speechActive = false
        } else {
          output.append(makeOutput(subframe, applyGain: false))
        }
      } else {
        if !candidateSpeech.isEmpty {
          for candidate in candidateSpeech {
            for evicted in appendPreRoll(candidate) {
              appendCoverage(evicted)
            }
          }
          candidateSpeech.removeAll(keepingCapacity: true)
        }
        for evicted in appendPreRoll(subframe) {
          appendCoverage(evicted)
        }
      }
    }
    return coalesce(output)
  }

  /// The five-second durable fact upload is the boundary at which no more
  /// speech can retroactively confirm buffered pre-roll for that source chunk.
  /// Emit explicit silent coverage before the fact reaches the server so the
  /// server can decide whether a durable ASR fallback is necessary.
  public mutating func flushCoverage(
    sourceChunkID: String
  ) -> [CapturedRealtimeAudioFrame] {
    let buffered = (pendingCoverage + preRoll + candidateSpeech)
      .filter { $0.sourceChunkID == sourceChunkID }
      .sorted {
        $0.startMilliseconds < $1.startMilliseconds
          || ($0.startMilliseconds == $1.startMilliseconds
            && $0.endMilliseconds < $1.endMilliseconds)
      }
    preRoll.removeAll { $0.sourceChunkID == sourceChunkID }
    candidateSpeech.removeAll { $0.sourceChunkID == sourceChunkID }
    pendingCoverage.removeAll { $0.sourceChunkID == sourceChunkID }
    var coverage: [CapturedRealtimeAudioFrame] = []
    for frame in buffered {
      coverage.append(makeCoverageOutput(frame))
    }
    return coalesce(coverage)
  }

  public mutating func finish() -> [CapturedRealtimeAudioFrame] {
    let buffered = (pendingCoverage + preRoll + candidateSpeech).sorted {
      $0.startMilliseconds < $1.startMilliseconds
        || ($0.startMilliseconds == $1.startMilliseconds
          && $0.endMilliseconds < $1.endMilliseconds)
    }
    pendingCoverage.removeAll(keepingCapacity: true)
    preRoll.removeAll(keepingCapacity: true)
    candidateSpeech.removeAll(keepingCapacity: true)
    let tail = buffered.last
    var output = buffered.map { makeCoverageOutput($0) }
    if speechActive, output.last?.metadata.speechPresent != false,
      let sessionID = currentSessionID,
      let track = currentTrack
    {
      let end = max(1, tail?.endMilliseconds ?? 1)
      output.append(makeCoverageOutput(.init(
        bytes: Data(),
        sessionID: sessionID,
        track: track,
        sourceChunkID: tail?.sourceChunkID
          ?? "\(sessionID):\(track.rawValue):endpoint",
        startMilliseconds: max(0, end - 1),
        endMilliseconds: end
      )))
    }
    speechActive = false
    hangoverRemaining = 0
    return coalesce(output)
  }

  public mutating func reset() {
    noiseFloorDecibels = -60
    noiseFloorInitialized = false
    preRoll.removeAll(keepingCapacity: true)
    candidateSpeech.removeAll(keepingCapacity: true)
    pendingCoverage.removeAll(keepingCapacity: true)
    speechActive = false
    hangoverRemaining = 0
    previousInput = 0
    previousOutput = 0
    observedFrameCount = 0
    outputSequence = 0
    currentSessionID = nil
    currentTrack = nil
  }

  private mutating func splitAndFilter(
    _ frame: CapturedRealtimeAudioFrame
  ) -> [Subframe] {
    let samplesPerFrame = max(
      1, frame.metadata.sampleRateHertz * Int(frameDurationMilliseconds) / 1_000)
    let bytesPerFrame = samplesPerFrame * 2
    let sampleCount = frame.bytes.count / 2
    let duration = frame.metadata.endMonotonicMilliseconds
      - frame.metadata.startMonotonicMilliseconds
    var result: [Subframe] = []
    var offset = 0
    while offset + 2 <= frame.bytes.count {
      let endOffset = min(frame.bytes.count, offset + bytesPerFrame)
      let input = frame.bytes.subdata(in: offset..<endOffset)
      let filtered = highPass(input)
      let startSample = offset / 2
      let endSample = endOffset / 2
      result.append(.init(
        bytes: filtered,
        sessionID: frame.metadata.sessionID,
        track: frame.metadata.track,
        sourceChunkID: frame.metadata.sourceChunkID,
        startMilliseconds: frame.metadata.startMonotonicMilliseconds
          + Int64(startSample) * duration / Int64(max(1, sampleCount)),
        endMilliseconds: frame.metadata.startMonotonicMilliseconds
          + Int64(endSample) * duration / Int64(max(1, sampleCount))
      ))
      offset = endOffset
    }
    return result
  }

  private mutating func highPass(_ bytes: Data) -> Data {
    var output = Data(count: bytes.count)
    bytes.withUnsafeBytes { rawInput in
      output.withUnsafeMutableBytes { rawOutput in
        guard let source = rawInput.bindMemory(to: Int16.self).baseAddress,
          let destination = rawOutput.bindMemory(to: Int16.self).baseAddress
        else { return }
        for index in 0..<(bytes.count / 2) {
          let input = Float(Int16(littleEndian: source[index])) / 32_768
          let filtered = input - previousInput + 0.985 * previousOutput
          previousInput = input
          previousOutput = filtered
          destination[index] = Int16(max(
            Float(Int16.min),
            min(Float(Int16.max), filtered * 32_767)
          )).littleEndian
        }
      }
    }
    return output
  }

  private func rmsDecibels(_ bytes: Data) -> Double {
    bytes.withUnsafeBytes { raw in
      guard let values = raw.bindMemory(to: Int16.self).baseAddress else { return -120 }
      let count = bytes.count / 2
      var squared = 0.0
      for index in 0..<count {
        let sample = Double(Int16(littleEndian: values[index])) / 32_768
        squared += sample * sample
      }
      return 20 * log10(max(0.000_001, sqrt(squared / Double(max(1, count)))))
    }
  }

  private mutating func makeOutput(
    _ subframe: Subframe,
    applyGain: Bool,
    speechPresent: Bool = true
  ) -> CapturedRealtimeAudioFrame {
    let bytes = applyGain ? speechGain(subframe.bytes) : subframe.bytes
    let sequence = outputSequence
    outputSequence += 1
    let metadata = try! MeetingRealtimeAudioFrame(
      frameID: "\(subframe.sourceChunkID):speech:\(sequence)",
      sessionID: subframe.sessionID,
      track: subframe.track,
      frameSequence: sequence,
      sourceChunkID: subframe.sourceChunkID,
      startMonotonicMilliseconds: subframe.startMilliseconds,
      endMonotonicMilliseconds: subframe.endMilliseconds,
      speechPresent: speechPresent
    )
    return CapturedRealtimeAudioFrame(metadata: metadata, bytes: bytes)
  }

  private mutating func makeCoverageOutput(
    _ subframe: Subframe
  ) -> CapturedRealtimeAudioFrame {
    makeOutput(.init(
      bytes: Data(),
      sessionID: subframe.sessionID,
      track: subframe.track,
      sourceChunkID: subframe.sourceChunkID,
      startMilliseconds: subframe.startMilliseconds,
      endMilliseconds: subframe.endMilliseconds
    ), applyGain: false, speechPresent: false)
  }

  private func speechGain(_ bytes: Data) -> Data {
    let level = rmsDecibels(bytes)
    let gain = min(2, max(1, pow(10, (-20 - level) / 20)))
    guard gain > 1.01 else { return bytes }
    var output = Data(count: bytes.count)
    bytes.withUnsafeBytes { rawInput in
      output.withUnsafeMutableBytes { rawOutput in
        guard let source = rawInput.bindMemory(to: Int16.self).baseAddress,
          let destination = rawOutput.bindMemory(to: Int16.self).baseAddress
        else { return }
        for index in 0..<(bytes.count / 2) {
          let value = Double(Int16(littleEndian: source[index])) * gain
          destination[index] = Int16(max(
            Double(Int16.min), min(Double(Int16.max), value)
          )).littleEndian
        }
      }
    }
    return output
  }

  /// VAD runs at 20 ms, but HTTP does not need one request per analysis
  /// window. Merge adjacent windows with the same speech decision back into
  /// the largest contiguous projection available in the current callback.
  private mutating func coalesce(
    _ frames: [CapturedRealtimeAudioFrame]
  ) -> [CapturedRealtimeAudioFrame] {
    guard !frames.isEmpty else { return [] }
    let firstSequence = outputSequence - frames.count
    var groups: [CapturedRealtimeAudioFrame] = []
    for frame in frames {
      guard let prior = groups.last,
        prior.metadata.sessionID == frame.metadata.sessionID,
        prior.metadata.track == frame.metadata.track,
        prior.metadata.sourceChunkID == frame.metadata.sourceChunkID,
        prior.metadata.speechPresent == frame.metadata.speechPresent,
        prior.metadata.endMonotonicMilliseconds
          == frame.metadata.startMonotonicMilliseconds
      else {
        groups.append(frame)
        continue
      }
      groups.removeLast()
      let metadata = try! MeetingRealtimeAudioFrame(
        frameID: prior.metadata.frameID,
        sessionID: prior.metadata.sessionID,
        track: prior.metadata.track,
        frameSequence: prior.metadata.frameSequence,
        sourceChunkID: prior.metadata.sourceChunkID,
        startMonotonicMilliseconds: prior.metadata.startMonotonicMilliseconds,
        endMonotonicMilliseconds: frame.metadata.endMonotonicMilliseconds,
        speechPresent: prior.metadata.speechPresent
      )
      var bytes = prior.bytes
      bytes.append(frame.bytes)
      groups.append(CapturedRealtimeAudioFrame(metadata: metadata, bytes: bytes))
    }
    let result = groups.enumerated().map { index, frame in
      let sequence = firstSequence + index
      let metadata = try! MeetingRealtimeAudioFrame(
        frameID: "\(frame.metadata.sourceChunkID):projection:\(sequence)",
        sessionID: frame.metadata.sessionID,
        track: frame.metadata.track,
        frameSequence: sequence,
        sourceChunkID: frame.metadata.sourceChunkID,
        startMonotonicMilliseconds: frame.metadata.startMonotonicMilliseconds,
        endMonotonicMilliseconds: frame.metadata.endMonotonicMilliseconds,
        speechPresent: frame.metadata.speechPresent
      )
      return CapturedRealtimeAudioFrame(metadata: metadata, bytes: frame.bytes)
    }
    outputSequence = firstSequence + result.count
    return result
  }

  private mutating func appendPreRoll(_ frame: Subframe) -> [Subframe] {
    guard preRollFrameCount > 0 else { return [frame] }
    preRoll.append(frame)
    var evicted: [Subframe] = []
    if preRoll.count > preRollFrameCount {
      evicted = Array(preRoll.prefix(preRoll.count - preRollFrameCount))
      preRoll.removeFirst(evicted.count)
    }
    return evicted
  }

  /// Silence is coverage metadata, not audio. Keep it locally and collapse it
  /// into one range per source chunk instead of issuing one HTTP request for
  /// every 20 ms VAD analysis window.
  private mutating func appendCoverage(_ frame: Subframe) {
    guard let prior = pendingCoverage.last,
      prior.sessionID == frame.sessionID,
      prior.track == frame.track,
      prior.sourceChunkID == frame.sourceChunkID,
      prior.endMilliseconds == frame.startMilliseconds
    else {
      pendingCoverage.append(.init(
        bytes: Data(),
        sessionID: frame.sessionID,
        track: frame.track,
        sourceChunkID: frame.sourceChunkID,
        startMilliseconds: frame.startMilliseconds,
        endMilliseconds: frame.endMilliseconds
      ))
      return
    }
    pendingCoverage.removeLast()
    pendingCoverage.append(.init(
      bytes: Data(),
      sessionID: prior.sessionID,
      track: prior.track,
      sourceChunkID: prior.sourceChunkID,
      startMilliseconds: prior.startMilliseconds,
      endMilliseconds: frame.endMilliseconds
    ))
  }

  private mutating func drainCoverage() -> [CapturedRealtimeAudioFrame] {
    let buffered = pendingCoverage
    pendingCoverage.removeAll(keepingCapacity: true)
    return buffered.map { makeCoverageOutput($0) }
  }
}

/// Callback health is distinct from audio energy: silence still produces
/// callbacks, whereas device loss or a stopped capture graph does not.
final class AudioTrackHealthWatchdog: @unchecked Sendable {
  private let lock = NSLock()
  private let stallAfterMilliseconds: Int64
  private var lastActivity: [MeetingAudioTrack: Int64] = [:]
  private var reported: Set<MeetingAudioTrack> = []

  init(stallAfterMilliseconds: Int64 = 15_000) {
    self.stallAfterMilliseconds = max(1_000, stallAfterMilliseconds)
  }

  func activate(_ tracks: Set<MeetingAudioTrack>, at milliseconds: Int64) {
    lock.lock()
    for track in tracks {
      lastActivity[track] = milliseconds
      reported.remove(track)
    }
    lock.unlock()
  }

  func observe(_ track: MeetingAudioTrack, at milliseconds: Int64) {
    lock.lock()
    lastActivity[track] = milliseconds
    reported.remove(track)
    lock.unlock()
  }

  func stalled(at milliseconds: Int64) -> [MeetingAudioTrack] {
    lock.lock()
    defer { lock.unlock() }
    let stalled = lastActivity.compactMap { track, activity -> MeetingAudioTrack? in
      guard !reported.contains(track),
        milliseconds - activity >= stallAfterMilliseconds
      else { return nil }
      reported.insert(track)
      return track
    }
    return stalled.sorted { $0.rawValue < $1.rawValue }
  }

  func reset() {
    lock.lock()
    lastActivity.removeAll()
    reported.removeAll()
    lock.unlock()
  }
}
