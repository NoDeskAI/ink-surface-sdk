import Foundation

public let meetingSessionSchemaVersion = "inkloop.meeting_session.v1"
public let meetingAudioChunkSchemaVersion = "inkloop.meeting_audio_chunk.v1"
public let meetingRealtimeAudioFrameSchemaVersion = "inkloop.meeting_realtime_audio_frame.v1"

public enum MeetingPlatform: String, Codable, Sendable {
  case googleMeet = "google_meet"
  case zoom
}

public enum MeetingStartMode: String, Codable, Sendable {
  case automatic
  case manual
}

public enum MeetingSessionStatus: String, Codable, Sendable {
  case detected
  case recording
  case paused
  case sealed
}

public enum MeetingAudioTrack: String, Codable, CaseIterable, Sendable {
  case mic
  case remote
}

public enum MeetingStopReason: String, Codable, Sendable {
  case meetingEndConfirmed = "meeting_end_confirmed"
  case manual
  case interruptedSessionRecovered = "interrupted_session_recovered"
}

public struct DetectedMeeting: Equatable, Sendable {
  public let platform: MeetingPlatform
  public let meetingReference: String
  public let detectionID: String
  public let detectedAtMonotonicMilliseconds: Int64

  public init(
    platform: MeetingPlatform,
    meetingReference: String,
    detectionID: String,
    detectedAtMonotonicMilliseconds: Int64
  ) {
    self.platform = platform
    self.meetingReference = meetingReference
    self.detectionID = detectionID
    self.detectedAtMonotonicMilliseconds = detectedAtMonotonicMilliseconds
  }
}

public struct ConfirmedMeetingEndEvidence: Codable, Equatable, Sendable {
  public let adapter: String
  public let signal: String
  public let providerEventID: String?
  public let observedAtWallClockMilliseconds: Int64?

  public init(
    validatingAdapter adapter: String,
    signal: String,
    providerEventID: String? = nil,
    observedAtWallClockMilliseconds: Int64? = nil
  ) throws {
    guard !adapter.isEmpty, !signal.isEmpty else {
      throw MeetingAdapterError.invalidConfirmedEndEvidence
    }
    guard Self.confirmedSignals.contains(signal) else {
      throw MeetingAdapterError.weakMeetingEndSignal(signal)
    }
    self.adapter = adapter
    self.signal = signal
    self.providerEventID = providerEventID
    self.observedAtWallClockMilliseconds = observedAtWallClockMilliseconds
  }

  private static let confirmedSignals: Set<String> = [
    "meeting_call_ended",
    "platform_meeting_ended",
    "user_left_meeting",
  ]

  enum CodingKeys: String, CodingKey {
    case adapter
    case signal
    case providerEventID = "provider_event_id"
    case observedAtWallClockMilliseconds = "observed_at_wall_clock_ms"
  }
}

public struct MeetingAudioChunk: Codable, Equatable, Sendable {
  public let schemaVersion: String
  public let chunkID: String
  public let sessionID: String
  public let track: MeetingAudioTrack
  public let sequence: Int
  public let startMonotonicMilliseconds: Int64
  public let endMonotonicMilliseconds: Int64
  public let checksum: String
  public let byteLength: Int
  public let sealed: Bool
  public let codec: String?
  public let sampleRateHertz: Int?
  public let channelCount: Int?

  public init(
    chunkID: String,
    sessionID: String,
    track: MeetingAudioTrack,
    sequence: Int,
    startMonotonicMilliseconds: Int64,
    endMonotonicMilliseconds: Int64,
    checksum: String,
    byteLength: Int,
    codec: String? = nil,
    sampleRateHertz: Int? = nil,
    channelCount: Int? = nil
  ) throws {
    guard !chunkID.isEmpty,
      !sessionID.isEmpty,
      sequence >= 0,
      startMonotonicMilliseconds >= 0,
      endMonotonicMilliseconds > startMonotonicMilliseconds,
      !checksum.isEmpty,
      byteLength >= 0
    else {
      throw MeetingAdapterError.invalidAudioChunk
    }
    self.schemaVersion = meetingAudioChunkSchemaVersion
    self.chunkID = chunkID
    self.sessionID = sessionID
    self.track = track
    self.sequence = sequence
    self.startMonotonicMilliseconds = startMonotonicMilliseconds
    self.endMonotonicMilliseconds = endMonotonicMilliseconds
    self.checksum = checksum
    self.byteLength = byteLength
    self.sealed = true
    self.codec = codec
    self.sampleRateHertz = sampleRateHertz
    self.channelCount = channelCount
  }

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case chunkID = "chunk_id"
    case sessionID = "session_id"
    case track
    case sequence
    case startMonotonicMilliseconds = "start_monotonic_ms"
    case endMonotonicMilliseconds = "end_monotonic_ms"
    case checksum
    case byteLength = "byte_length"
    case sealed
    case codec
    case sampleRateHertz = "sample_rate_hz"
    case channelCount = "channel_count"
  }
}

public struct CapturedAudioChunk: Equatable, Sendable {
  public let metadata: MeetingAudioChunk
  public let bytes: Data

  public init(metadata: MeetingAudioChunk, bytes: Data) throws {
    guard metadata.byteLength == bytes.count else {
      throw MeetingAdapterError.audioChunkLengthMismatch
    }
    self.metadata = metadata
    self.bytes = bytes
  }
}

public enum MeetingRealtimeAudioDerivation: String, Codable, Equatable, Sendable {
  case raw
  case appleVoiceProcessing = "apple_voice_processing"
}

public struct MeetingRealtimeAudioFrame: Codable, Equatable, Sendable {
  public let schemaVersion: String
  public let frameID: String
  public let sessionID: String
  public let track: MeetingAudioTrack
  public let frameSequence: Int
  public let sourceChunkID: String
  public let startMonotonicMilliseconds: Int64
  public let endMonotonicMilliseconds: Int64
  public let codec: String
  public let sampleRateHertz: Int
  public let channelCount: Int
  public let speechPresent: Bool?
  public let audioDerivation: MeetingRealtimeAudioDerivation?

  public init(
    frameID: String,
    sessionID: String,
    track: MeetingAudioTrack,
    frameSequence: Int,
    sourceChunkID: String,
    startMonotonicMilliseconds: Int64,
    endMonotonicMilliseconds: Int64,
    codec: String = "pcm_s16le",
    sampleRateHertz: Int = 16_000,
    channelCount: Int = 1,
    speechPresent: Bool? = nil,
    audioDerivation: MeetingRealtimeAudioDerivation? = nil
  ) throws {
    guard !frameID.isEmpty, !sessionID.isEmpty, frameSequence >= 0,
      !sourceChunkID.isEmpty, startMonotonicMilliseconds >= 0,
      endMonotonicMilliseconds > startMonotonicMilliseconds,
      codec == "pcm_s16le", sampleRateHertz == 16_000, channelCount == 1
    else { throw MeetingAdapterError.invalidAudioChunk }
    schemaVersion = meetingRealtimeAudioFrameSchemaVersion
    self.frameID = frameID
    self.sessionID = sessionID
    self.track = track
    self.frameSequence = frameSequence
    self.sourceChunkID = sourceChunkID
    self.startMonotonicMilliseconds = startMonotonicMilliseconds
    self.endMonotonicMilliseconds = endMonotonicMilliseconds
    self.codec = codec
    self.sampleRateHertz = sampleRateHertz
    self.channelCount = channelCount
    self.speechPresent = speechPresent
    self.audioDerivation = audioDerivation
  }

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case frameID = "frame_id"
    case sessionID = "session_id"
    case track
    case frameSequence = "frame_sequence"
    case sourceChunkID = "source_chunk_id"
    case startMonotonicMilliseconds = "start_monotonic_ms"
    case endMonotonicMilliseconds = "end_monotonic_ms"
    case codec
    case sampleRateHertz = "sample_rate_hz"
    case channelCount = "channel_count"
    case speechPresent = "speech_present"
    case audioDerivation = "audio_derivation"
  }
}

public struct CapturedRealtimeAudioFrame: Equatable, Sendable {
  public let metadata: MeetingRealtimeAudioFrame
  public let bytes: Data

  public init(metadata: MeetingRealtimeAudioFrame, bytes: Data) {
    self.metadata = metadata
    self.bytes = bytes
  }
}

public struct MeetingChunkReference: Codable, Equatable, Sendable {
  public let chunkID: String
  public let track: MeetingAudioTrack
  public let sequence: Int
  public let checksum: String

  enum CodingKeys: String, CodingKey {
    case chunkID = "chunk_id"
    case track
    case sequence
    case checksum
  }
}

public enum MeetingSessionAuditEventType: String, Codable, Sendable {
  case sessionDetected = "session.detected"
  case recordingStarted = "recording.started"
  case recordingPaused = "recording.paused"
  case recordingResumed = "recording.resumed"
  case audioChunkSealed = "audio.chunk.sealed"
  case audioTrackUnavailable = "audio.track.unavailable"
  case meetingEndConfirmed = "meeting.end.confirmed"
  case interruptedSessionRecovered = "session.interrupted.recovered"
  case recordingStopped = "recording.stopped"
}

public struct MeetingSessionAuditEvent: Codable, Equatable, Sendable {
  public let eventID: String
  public let type: MeetingSessionAuditEventType
  public let atMonotonicMilliseconds: Int64
  public let evidence: ConfirmedMeetingEndEvidence?
  public let chunkReference: MeetingChunkReference?
  public let stopReason: MeetingStopReason?
  public let track: MeetingAudioTrack?
  public let unavailabilityReason: String?

  public init(
    eventID: String,
    type: MeetingSessionAuditEventType,
    atMonotonicMilliseconds: Int64,
    evidence: ConfirmedMeetingEndEvidence?,
    chunkReference: MeetingChunkReference?,
    stopReason: MeetingStopReason?,
    track: MeetingAudioTrack? = nil,
    unavailabilityReason: String? = nil
  ) {
    self.eventID = eventID
    self.type = type
    self.atMonotonicMilliseconds = atMonotonicMilliseconds
    self.evidence = evidence
    self.chunkReference = chunkReference
    self.stopReason = stopReason
    self.track = track
    self.unavailabilityReason = unavailabilityReason
  }

  enum CodingKeys: String, CodingKey {
    case eventID = "event_id"
    case type
    case atMonotonicMilliseconds = "at_monotonic_ms"
    case evidence
    case chunkReference = "chunk_ref"
    case stopReason = "stop_reason"
    case track
    case unavailabilityReason = "unavailability_reason"
  }
}

public struct MeetingSessionState: Codable, Equatable, Sendable {
  public let schemaVersion: String
  public let sessionID: String
  public let platform: MeetingPlatform
  public let meetingReference: String
  public let startMode: MeetingStartMode
  public var status: MeetingSessionStatus
  public let wallClockAnchorMilliseconds: Int64
  public let monotonicAnchorMilliseconds: Int64
  public var startedMonotonicMilliseconds: Int64?
  public var endedMonotonicMilliseconds: Int64?
  public var stopReason: MeetingStopReason?
  public var events: [MeetingSessionAuditEvent]

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case sessionID = "session_id"
    case platform
    case meetingReference = "meeting_ref"
    case startMode = "start_mode"
    case status
    case wallClockAnchorMilliseconds = "wall_clock_anchor_ms"
    case monotonicAnchorMilliseconds = "monotonic_anchor_ms"
    case startedMonotonicMilliseconds = "started_monotonic_ms"
    case endedMonotonicMilliseconds = "ended_monotonic_ms"
    case stopReason = "stop_reason"
    case events
  }
}

public struct SealedMeetingSequenceManifest: Codable, Equatable, Sendable {
  public let schemaVersion = "inkloop.meeting_sequence_manifest.v1"
  public let sessionID: String
  public let expectedTracks: [MeetingAudioTrack]
  public let expectedLastSequence: [MeetingAudioTrack: Int]
  public let knownMissingChunkIDs: [String]

  public init(sealedSession session: MeetingSessionState) throws {
    guard session.status == .sealed else { throw MeetingAdapterError.sessionNotSealed }
    var lastSequence: [MeetingAudioTrack: Int] = [:]
    for event in session.events {
      guard let chunk = event.chunkReference else { continue }
      lastSequence[chunk.track] = max(lastSequence[chunk.track] ?? -1, chunk.sequence)
    }
    sessionID = session.sessionID
    // A completely silent or failed track is still part of the expected
    // evidence contract. Keeping both tracks here lets the server represent
    // that condition as `missing_track:*` instead of silently upgrading a
    // degraded capture to a complete transcript.
    expectedTracks = MeetingAudioTrack.allCases
    expectedLastSequence = lastSequence
    knownMissingChunkIDs = session.events.compactMap { event in
      guard event.type == .audioTrackUnavailable, let track = event.track else { return nil }
      return "track_unavailable:\(track.rawValue):\(event.atMonotonicMilliseconds)"
    }
  }

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case sessionID = "session_id"
    case expectedTracks = "expected_tracks"
    case expectedLastSequence = "expected_last_sequence"
    case knownMissingChunkIDs = "known_missing_chunk_ids"
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    sessionID = try container.decode(String.self, forKey: .sessionID)
    expectedTracks = try container.decode([MeetingAudioTrack].self, forKey: .expectedTracks)
    knownMissingChunkIDs = try container.decodeIfPresent(
      [String].self, forKey: .knownMissingChunkIDs) ?? []
    let encodedLastSequence = try container.decode(
      [String: Int].self, forKey: .expectedLastSequence)
    var decodedLastSequence: [MeetingAudioTrack: Int] = [:]
    for (rawTrack, sequence) in encodedLastSequence {
      guard let track = MeetingAudioTrack(rawValue: rawTrack) else {
        throw DecodingError.dataCorruptedError(
          forKey: .expectedLastSequence,
          in: container,
          debugDescription: "Unsupported meeting audio track: \(rawTrack)"
        )
      }
      decodedLastSequence[track] = sequence
    }
    expectedLastSequence = decodedLastSequence
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(schemaVersion, forKey: .schemaVersion)
    try container.encode(sessionID, forKey: .sessionID)
    try container.encode(expectedTracks, forKey: .expectedTracks)
    try container.encode(
      Dictionary(uniqueKeysWithValues: expectedLastSequence.map { ($0.key.rawValue, $0.value) }),
      forKey: .expectedLastSequence
    )
    try container.encode(knownMissingChunkIDs, forKey: .knownMissingChunkIDs)
  }
}

public enum MeetingAdapterError: Error, Equatable, Sendable {
  case alreadyRecording
  case noActiveRecording
  case autoRecordDisabled
  case invalidConfirmedEndEvidence
  case weakMeetingEndSignal(String)
  case invalidAudioChunk
  case audioChunkLengthMismatch
  case chunkBelongsToAnotherSession
  case chunkConflict(String)
  case confirmedEndBelongsToAnotherMeeting
  case captureTransitionInProgress
  case noAudioTracksAvailable
  case sessionNotSealed
  case invalidStorageIdentifier(String)
  case capturePermissionDenied(String)
  case targetApplicationUnavailable(MeetingPlatform)
  case unsupportedAudioFormat
  case captureNotPaused
  case captureAlreadyPaused
  case invalidAcknowledgement
  case recorderLeaseHeldByAnotherDevice(String)
}
