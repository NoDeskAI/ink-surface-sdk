import Foundation

public enum ApplicationAudioScope: String, Codable, Sendable {
  case exactMeeting = "exact_meeting"
  case targetApplication = "target_application"
  case mixedSystem = "mixed_system"
  case unavailable
  case unverified
}

public struct MeetingPlatformCapabilities: Codable, Equatable, Sendable {
  public let adapterID: String
  public let supportedPlatforms: Set<MeetingPlatform>
  public let microphoneCaptureAvailable: Bool
  public let applicationAudioScope: ApplicationAudioScope
  public let confirmedEndDetectionAvailable: Bool

  public init(
    adapterID: String,
    supportedPlatforms: Set<MeetingPlatform>,
    microphoneCaptureAvailable: Bool,
    applicationAudioScope: ApplicationAudioScope,
    confirmedEndDetectionAvailable: Bool
  ) {
    self.adapterID = adapterID
    self.supportedPlatforms = supportedPlatforms
    self.microphoneCaptureAvailable = microphoneCaptureAvailable
    self.applicationAudioScope = applicationAudioScope
    self.confirmedEndDetectionAvailable = confirmedEndDetectionAvailable
  }
}

public enum MeetingDetectionEvent: Equatable, Sendable {
  case detected(DetectedMeeting)
  case endConfirmed(
    meetingReference: String,
    atMonotonicMilliseconds: Int64,
    evidence: ConfirmedMeetingEndEvidence
  )
}

public protocol MeetingDetectionAdapter: Sendable {
  var capabilities: MeetingPlatformCapabilities { get }
  func events() -> AsyncThrowingStream<MeetingDetectionEvent, any Error>
}

public struct AudioCaptureStartResult: Equatable, Sendable {
  public let activeTracks: Set<MeetingAudioTrack>
  public let unavailableTracks: Set<MeetingAudioTrack>

  public init(activeTracks: Set<MeetingAudioTrack>, unavailableTracks: Set<MeetingAudioTrack>)
    throws
  {
    guard !activeTracks.isEmpty else {
      throw MeetingAdapterError.noAudioTracksAvailable
    }
    self.activeTracks = activeTracks
    self.unavailableTracks = unavailableTracks
  }
}

public protocol MeetingAudioCaptureAdapter: Sendable {
  var capabilities: MeetingPlatformCapabilities { get }
  func startCapture(
    for session: MeetingSessionState,
    onSealedChunk: @escaping @Sendable (CapturedAudioChunk) async throws -> Void,
    onTrackUnavailable: @escaping @Sendable (MeetingAudioTrack, Int64, String) async -> Void
  ) async throws -> AudioCaptureStartResult
  /// Pausing seals the current tail on each active track before capture stops.
  func pauseAndSealCapture() async throws -> [CapturedAudioChunk]
  func resumeCapture() async throws -> AudioCaptureStartResult
  /// Stops both tracks before returning any final sealed tail chunks.
  func stopAndSealCapture() async throws -> [CapturedAudioChunk]
}

public protocol MeetingRealtimeAudioFrameSink: Sendable {
  func enqueueRealtimeFrame(_ frame: CapturedRealtimeAudioFrame) async
}

public extension MeetingAudioCaptureAdapter {
  func pauseAndSealCapture() async throws -> [CapturedAudioChunk] {
    throw MeetingAdapterError.captureNotPaused
  }

  func resumeCapture() async throws -> AudioCaptureStartResult {
    throw MeetingAdapterError.captureNotPaused
  }
}

public protocol MeetingEvidenceStore: Sendable {
  func persistSession(_ session: MeetingSessionState) async throws
  func persistChunk(_ chunk: CapturedAudioChunk) async throws
  func persistAcknowledgement(_ acknowledgement: MeetingMediaChunkAcknowledgement) async throws
  func loadSessions() async throws -> [MeetingSessionState]
  func loadRecoverableSessions() async throws -> [MeetingSessionState]
  func loadChunks(sessionID: String) async throws -> [CapturedAudioChunk]
  func loadPendingChunks(sessionID: String) async throws -> [CapturedAudioChunk]
}

public enum MeetingRecorderLeaseDisposition: Equatable, Sendable {
  case granted
  case heldByAnotherDevice(ownerDeviceID: String)
  case unavailable
}

/// Account-scoped arbitration prevents two Companion instances from creating
/// duplicate cloud transcripts for the same provider meeting occurrence.
/// `unavailable` must not prevent authoritative local capture while offline.
public protocol MeetingRecorderLeaseCoordinator: Sendable {
  func claimRecorderLease(
    for meeting: DetectedMeeting,
    sessionID: String
  ) async -> MeetingRecorderLeaseDisposition
  func relinquishRecorderLease(sessionID: String) async
}

public extension MeetingRecorderLeaseCoordinator {
  func relinquishRecorderLease(sessionID: String) async {}
}

public extension MeetingEvidenceStore {
  func loadSessions() async throws -> [MeetingSessionState] { [] }
  func loadRecoverableSessions() async throws -> [MeetingSessionState] { [] }
  func persistAcknowledgement(_ acknowledgement: MeetingMediaChunkAcknowledgement) async throws {}
  func loadChunks(sessionID: String) async throws -> [CapturedAudioChunk] { [] }
  func loadPendingChunks(sessionID: String) async throws -> [CapturedAudioChunk] { [] }
}

public enum CompanionOperatingState: String, Codable, Sendable {
  case idle
  case detected
  case recording
  case paused
  case degraded
  case sealed
  case error
}

public struct CompanionStatusSnapshot: Codable, Equatable, Sendable {
  public let state: CompanionOperatingState
  public let sessionID: String?
  public let platform: MeetingPlatform?
  public let activeTracks: Set<MeetingAudioTrack>
  public let unavailableTracks: Set<MeetingAudioTrack>
  public let captureActive: Bool
  public let message: String?

  public init(
    state: CompanionOperatingState,
    sessionID: String? = nil,
    platform: MeetingPlatform? = nil,
    activeTracks: Set<MeetingAudioTrack> = [],
    unavailableTracks: Set<MeetingAudioTrack> = [],
    captureActive: Bool = false,
    message: String? = nil
  ) {
    self.state = state
    self.sessionID = sessionID
    self.platform = platform
    self.activeTracks = activeTracks
    self.unavailableTracks = unavailableTracks
    self.captureActive = captureActive
    self.message = message
  }
}

public protocol CompanionStatusSink: Sendable {
  func publish(_ status: CompanionStatusSnapshot) async
}

public actor NullCompanionStatusSink: CompanionStatusSink {
  public init() {}
  public func publish(_ status: CompanionStatusSnapshot) async {}
}
