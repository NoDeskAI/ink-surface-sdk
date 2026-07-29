import Foundation

public struct MeetingMediaUploadConfiguration: Sendable {
  public let baseURL: URL
  public let bearerToken: String
  public let deviceID: String
  public let recorderLeaseRequired: Bool
  public let recorderLeaseRenewalInterval: Duration

  public init(
    baseURL: URL,
    bearerToken: String,
    deviceID: String = "inkloop-device",
    recorderLeaseRequired: Bool = false,
    recorderLeaseRenewalInterval: Duration = .seconds(10)
  ) {
    self.baseURL = baseURL
    self.bearerToken = bearerToken
    self.deviceID = deviceID
    self.recorderLeaseRequired = recorderLeaseRequired
    self.recorderLeaseRenewalInterval = recorderLeaseRenewalInterval
  }
}

public struct MeetingMediaChunkAcknowledgement: Codable, Equatable, Sendable {
  public let sessionID: String
  public let track: MeetingAudioTrack
  public let sequence: Int
  public let chunkID: String
  public let checksum: String
  public let acknowledgedAtMilliseconds: Int64

  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case track
    case sequence
    case chunkID = "chunk_id"
    case checksum
    case acknowledgedAtMilliseconds = "acknowledged_at_ms"
  }
}

public struct MeetingMediaFinalizeResponse: Codable, Equatable, Sendable {
  public let replay: Bool
  public let artifact: FormalTranscriptSummary
}

public struct FormalTranscriptSummary: Codable, Equatable, Sendable {
  public let finality: String
  public let missingChunkIDs: [String]
  enum CodingKeys: String, CodingKey { case finality; case missingChunkIDs = "missing_chunk_ids" }
}

public struct MeetingMediaSessionScope: Decodable, Sendable {
  public let sessionID: String
  public let meetingDocumentID: String
  public let status: String

  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case meetingDocumentID = "meeting_doc_id"
    case status
  }
}

public struct MeetingDeletionCommand: Codable, Equatable, Sendable {
  public let commandID: String
  public let meetingDocumentID: String
  public let meetingReferences: [String]
  public let requestedAtMilliseconds: Int64
  public let occurrenceStartedAtMilliseconds: Int64?
  public let occurrenceEndedAtMilliseconds: Int64?

  enum CodingKeys: String, CodingKey {
    case commandID = "command_id"
    case meetingDocumentID = "meeting_doc_id"
    case meetingReferences = "meeting_refs"
    case requestedAtMilliseconds = "requested_at_ms"
    case occurrenceStartedAtMilliseconds = "occurrence_started_at_ms"
    case occurrenceEndedAtMilliseconds = "occurrence_ended_at_ms"
  }
}

public struct MeetingDeletionCandidate: Equatable, Sendable {
  public let meetingReference: String
  public let startedAtMilliseconds: Int64?
  public let endedAtMilliseconds: Int64?

  public init(session: MeetingSessionState) {
    meetingReference = session.meetingReference
    startedAtMilliseconds = session.startedMonotonicMilliseconds.map {
      session.wallClockAnchorMilliseconds + ($0 - session.monotonicAnchorMilliseconds)
    }
    endedAtMilliseconds = session.endedMonotonicMilliseconds.map {
      session.wallClockAnchorMilliseconds + ($0 - session.monotonicAnchorMilliseconds)
    }
  }
}

private struct RecorderLeaseResponse: Decodable, Sendable {
  let granted: Bool
  let meetingReference: String
  let ownerSessionID: String
  let ownerDeviceID: String
  let expiresAtMilliseconds: Int64
  let retryAfterMilliseconds: Int64
  let leaseToken: String?

  enum CodingKeys: String, CodingKey {
    case granted
    case meetingReference = "meeting_ref"
    case ownerSessionID = "owner_session_id"
    case ownerDeviceID = "owner_device_id"
    case expiresAtMilliseconds = "expires_at_ms"
    case retryAfterMilliseconds = "retry_after_ms"
    case leaseToken = "lease_token"
  }
}

private struct ActiveRecorderLease: Sendable {
  let meetingReference: String
  let sessionID: String
  let deviceID: String
  let token: String
  let expiresAtMilliseconds: Int64
}

public actor MeetingMediaUploader: MeetingRecorderLeaseCoordinator, MeetingRealtimeAudioFrameSink {
  private struct IngestResponse: Decodable { let acknowledgement: MeetingMediaChunkAcknowledgement }
  private struct MeetingDeletionCommandsResponse: Decodable { let commands: [MeetingDeletionCommand] }
  private let configuration: MeetingMediaUploadConfiguration
  private let session: URLSession
  private var acknowledged: Set<String> = []
  private var recorderLeases: [String: ActiveRecorderLease] = [:]
  private var recorderLeaseRenewalTasks: [String: Task<Void, Never>] = [:]
  private var realtimeFrameUploadTails: [String: Task<Void, Never>] = [:]
  private var realtimeFrameUploadTailTokens: [String: UUID] = [:]
  private var realtimeFrameUploadCounts: [String: Int] = [:]
  private let maximumPendingRealtimeFramesPerTrack = 8

  public init(
    configuration: MeetingMediaUploadConfiguration,
    session: URLSession = .shared
  ) {
    self.configuration = configuration
    self.session = session
  }

  public func upload(_ chunk: CapturedAudioChunk) async throws -> MeetingMediaChunkAcknowledgement {
    if acknowledged.contains(chunk.metadata.chunkID) {
      return .init(
        sessionID: chunk.metadata.sessionID,
        track: chunk.metadata.track,
        sequence: chunk.metadata.sequence,
        chunkID: chunk.metadata.chunkID,
        checksum: chunk.metadata.checksum,
        acknowledgedAtMilliseconds: 0
      )
    }
    var request = URLRequest(url: configuration.baseURL.appendingPathComponent("api/meeting-media/chunks"))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    let lease = recorderLeases[chunk.metadata.sessionID]
    if configuration.recorderLeaseRequired && lease == nil {
      throw MeetingMediaUploadError.recorderLeaseRequired
    }
    request.httpBody = try JSONEncoder().encode(UploadBody(
      chunk: chunk.metadata,
      audioBase64: chunk.bytes.base64EncodedString(),
      meetingReference: lease?.meetingReference,
      recorderDeviceID: lease?.deviceID,
      recorderLeaseToken: lease?.token
    ))
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 202 else {
      if configuration.recorderLeaseRequired,
        (response as? HTTPURLResponse)?.statusCode == 409
      {
        stopRecorderLeaseRenewal(sessionID: chunk.metadata.sessionID, discardLease: true)
        throw MeetingMediaUploadError.recorderLeaseRequired
      }
      throw MeetingMediaUploadError.serverRejected((response as? HTTPURLResponse)?.statusCode ?? 0)
    }
    let value = try JSONDecoder().decode(IngestResponse.self, from: data)
    guard value.acknowledgement.sessionID == chunk.metadata.sessionID,
      value.acknowledgement.track == chunk.metadata.track,
      value.acknowledgement.sequence == chunk.metadata.sequence,
      value.acknowledgement.chunkID == chunk.metadata.chunkID,
      value.acknowledgement.checksum == chunk.metadata.checksum
    else { throw MeetingMediaUploadError.invalidAcknowledgement }
    acknowledged.insert(chunk.metadata.chunkID)
    return value.acknowledgement
  }

  public func uploadRealtimeFrame(_ frame: CapturedRealtimeAudioFrame) async throws {
    var request = URLRequest(
      url: configuration.baseURL.appendingPathComponent("api/meeting-media/realtime-frames"))
    request.httpMethod = "POST"
    request.timeoutInterval = 7
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    let lease = recorderLeases[frame.metadata.sessionID]
    if configuration.recorderLeaseRequired && lease == nil {
      throw MeetingMediaUploadError.recorderLeaseRequired
    }
    request.httpBody = try JSONEncoder().encode(
      RealtimeFrameBody(
        frame: frame.metadata,
        audioBase64: frame.bytes.base64EncodedString(),
        meetingReference: lease?.meetingReference,
        recorderDeviceID: lease?.deviceID,
        recorderLeaseToken: lease?.token
      ))
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 202 else {
      throw MeetingMediaUploadError.serverRejected(
        (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
  }

  /// Realtime projection never blocks the AVAudio callback/chunker path.
  /// Ordering remains strict per session/track so the server can keep one
  /// continuous decoder stream without making frames durable facts. The
  /// authoritative PCM remains in the durable fact track; this path may carry
  /// speech-focused audio plus explicit silent coverage so an endpoint can
  /// flush Whisper promptly without clipping stored evidence.
  public func enqueueRealtimeFrame(_ frame: CapturedRealtimeAudioFrame) {
    enqueueProjectedRealtimeFrame(frame)
  }

  private func enqueueProjectedRealtimeFrame(_ frame: CapturedRealtimeAudioFrame) {
    let key = "\(frame.metadata.sessionID):\(frame.metadata.track.rawValue)"
    let pendingCount = realtimeFrameUploadCounts[key] ?? 0
    guard pendingCount < maximumPendingRealtimeFramesPerTrack else {
      return
    }
    realtimeFrameUploadCounts[key] = pendingCount + 1
    let predecessor = realtimeFrameUploadTails[key]
    let token = UUID()
    realtimeFrameUploadTailTokens[key] = token
    realtimeFrameUploadTails[key] = Task { [weak self] in
      await predecessor?.value
      guard let self else { return }
      try? await self.uploadRealtimeFrame(frame)
      await self.completeRealtimeFrameUpload(key: key, token: token)
    }
  }

  private func completeRealtimeFrameUpload(key: String, token: UUID) {
    let remaining = max(0, (realtimeFrameUploadCounts[key] ?? 1) - 1)
    if remaining == 0 {
      realtimeFrameUploadCounts.removeValue(forKey: key)
    } else {
      realtimeFrameUploadCounts[key] = remaining
    }
    if realtimeFrameUploadTailTokens[key] == token {
      realtimeFrameUploadTails.removeValue(forKey: key)
      realtimeFrameUploadTailTokens.removeValue(forKey: key)
    }
  }

  func pendingRealtimeFrameCountForTesting(sessionID: String, track: MeetingAudioTrack)
    -> Int
  {
    realtimeFrameUploadCounts["\(sessionID):\(track.rawValue)"] ?? 0
  }

  func waitForRealtimeFramesForTesting(sessionID: String, track: MeetingAudioTrack)
    async
  {
    await realtimeFrameUploadTails["\(sessionID):\(track.rawValue)"]?.value
  }

  public func replayPending(_ chunks: [CapturedAudioChunk]) async -> [String: String] {
    var failures: [String: String] = [:]
    for chunk in chunks {
      do { _ = try await upload(chunk) }
      catch { failures[chunk.metadata.chunkID] = String(describing: error) }
    }
    return failures
  }

  public func pendingMeetingDeletionCommands(meetings: [MeetingDeletionCandidate] = []) async throws -> [MeetingDeletionCommand] {
    var components = URLComponents(
      url: configuration.baseURL.appendingPathComponent("api/meeting-media/deletion-commands"),
      resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "device_id", value: configuration.deviceID)]
      + meetings.sorted { $0.meetingReference < $1.meetingReference }.flatMap { candidate in
        [
          URLQueryItem(name: "meeting_ref", value: candidate.meetingReference),
          URLQueryItem(name: "meeting_started_at_ms", value: candidate.startedAtMilliseconds.map(String.init)),
          URLQueryItem(name: "meeting_ended_at_ms", value: candidate.endedAtMilliseconds.map(String.init)),
        ].compactMap { $0.value == nil ? nil : $0 }
      }
    var request = URLRequest(url: components.url!)
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw MeetingMediaUploadError.serverRejected((response as? HTTPURLResponse)?.statusCode ?? 0)
    }
    return try JSONDecoder().decode(MeetingDeletionCommandsResponse.self, from: data).commands
  }

  public func acknowledgeMeetingDeletion(
    commandID: String,
    deletedSessionIDs: [String]
  ) async throws {
    var request = URLRequest(
      url: configuration.baseURL.appendingPathComponent("api/meeting-media/deletion-commands/ack"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    request.httpBody = try JSONEncoder().encode(MeetingDeletionAcknowledgementBody(
      commandID: commandID,
      deviceID: configuration.deviceID,
      deletedSessionIDs: deletedSessionIDs
    ))
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw MeetingMediaUploadError.serverRejected((response as? HTTPURLResponse)?.statusCode ?? 0)
    }
  }

  public func register(_ sessionState: MeetingSessionState) async throws
    -> MeetingMediaSessionScope
  {
    guard sessionState.status != .detected else {
      throw MeetingMediaUploadError.invalidSessionScope
    }
    if configuration.recorderLeaseRequired && recorderLeases[sessionState.sessionID] == nil {
      let meeting = DetectedMeeting(
        platform: sessionState.platform,
        meetingReference: sessionState.meetingReference,
        detectionID: "register-\(sessionState.sessionID)",
        detectedAtMonotonicMilliseconds: sessionState.monotonicAnchorMilliseconds
      )
      let disposition = await claimRecorderLease(for: meeting, sessionID: sessionState.sessionID)
      guard disposition == .granted else {
        throw MeetingMediaUploadError.recorderLeaseRequired
      }
    }
    let lease = recorderLeases[sessionState.sessionID]
    var request = URLRequest(
      url: configuration.baseURL.appendingPathComponent("api/meeting-media/sessions"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    request.httpBody = try JSONEncoder().encode(SessionScopeBody(
      sessionID: sessionState.sessionID,
      platform: sessionState.platform,
      meetingReference: sessionState.meetingReference,
      status: sessionState.status,
      startedAtMilliseconds: wallClock(
        sessionState.startedMonotonicMilliseconds, session: sessionState),
      endedAtMilliseconds: wallClock(
        sessionState.endedMonotonicMilliseconds, session: sessionState),
      recorderDeviceID: lease?.deviceID,
      recorderLeaseToken: lease?.token
    ))
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw MeetingMediaUploadError.serverRejected(
        (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
    let scope = try JSONDecoder().decode(MeetingMediaSessionScope.self, from: data)
    guard scope.sessionID == sessionState.sessionID else {
      throw MeetingMediaUploadError.invalidSessionScope
    }
    return scope
  }

  public func finalize(_ sessionState: MeetingSessionState) async throws -> MeetingMediaFinalizeResponse {
    let manifest = try SealedMeetingSequenceManifest(sealedSession: sessionState)
    var request = URLRequest(url: configuration.baseURL.appendingPathComponent("api/meeting-media/finalize"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    request.httpBody = try JSONEncoder().encode(FinalizeBody(
      sessionID: sessionState.sessionID,
      meetingID: sessionState.meetingReference,
      platform: sessionState.platform,
      providerMeetingID: sessionState.meetingReference,
      startedAtMilliseconds: wallClock(sessionState.startedMonotonicMilliseconds, session: sessionState),
      endedAtMilliseconds: wallClock(sessionState.endedMonotonicMilliseconds, session: sessionState),
      expectedTracks: manifest.expectedTracks,
      expectedLastSequence: Dictionary(
        uniqueKeysWithValues: manifest.expectedLastSequence.map { ($0.key.rawValue, $0.value) }),
      knownMissingChunkIDs: manifest.knownMissingChunkIDs
    ))
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw MeetingMediaUploadError.serverRejected((response as? HTTPURLResponse)?.statusCode ?? 0)
    }
    let value = try JSONDecoder().decode(MeetingMediaFinalizeResponse.self, from: data)
    if configuration.recorderLeaseRequired {
      await relinquishRecorderLease(sessionID: sessionState.sessionID)
    }
    return value
  }

  public func claimRecorderLease(
    for meeting: DetectedMeeting,
    sessionID: String
  ) async -> MeetingRecorderLeaseDisposition {
    do {
      var request = URLRequest(
        url: configuration.baseURL.appendingPathComponent(
          "api/meeting-media/recorder-lease/acquire"))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
      request.httpBody = try JSONEncoder().encode(RecorderLeaseBody(
        meetingReference: meeting.meetingReference,
        sessionID: sessionID,
        deviceID: configuration.deviceID,
        leaseToken: nil
      ))
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        return .unavailable
      }
      let claim = try JSONDecoder().decode(RecorderLeaseResponse.self, from: data)
      guard claim.granted else {
        return .heldByAnotherDevice(ownerDeviceID: claim.ownerDeviceID)
      }
      guard claim.ownerSessionID == sessionID,
        claim.ownerDeviceID == configuration.deviceID,
        let token = claim.leaseToken, !token.isEmpty
      else { return .unavailable }
      recorderLeases[sessionID] = .init(
        meetingReference: meeting.meetingReference,
        sessionID: sessionID,
        deviceID: configuration.deviceID,
        token: token,
        expiresAtMilliseconds: claim.expiresAtMilliseconds
      )
      startRecorderLeaseRenewal(sessionID: sessionID)
      return .granted
    } catch {
      return .unavailable
    }
  }

  public func relinquishRecorderLease(sessionID: String) async {
    guard let lease = recorderLeases[sessionID] else { return }
    // Once local capture is terminal, never keep renewing ownership just
    // because the best-effort release request failed. The Hub lease then
    // expires naturally instead of being held forever by this process.
    // Clear local ownership before awaiting the network. Swift actors are
    // reentrant across suspension points; deferring this cleanup until after
    // `session.data` would let the sleeping renewal task wake and renew a
    // meeting whose local capture is already terminal.
    stopRecorderLeaseRenewal(sessionID: sessionID, discardLease: true)
    var request = URLRequest(
      url: configuration.baseURL.appendingPathComponent(
        "api/meeting-media/recorder-lease/release"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
    guard let body = try? JSONEncoder().encode(RecorderLeaseBody(
      meetingReference: lease.meetingReference,
      sessionID: lease.sessionID,
      deviceID: lease.deviceID,
      leaseToken: lease.token
    )) else { return }
    request.httpBody = body
    _ = try? await session.data(for: request)
  }

  private func startRecorderLeaseRenewal(sessionID: String) {
    recorderLeaseRenewalTasks[sessionID]?.cancel()
    let interval = configuration.recorderLeaseRenewalInterval
    recorderLeaseRenewalTasks[sessionID] = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: interval) }
        catch { return }
        guard let self else { return }
        if !(await self.renewRecorderLease(sessionID: sessionID)) { return }
      }
    }
  }

  /// Network errors retain the local lease and retry: chunk traffic may still
  /// refresh it. A definitive 409 discards ownership immediately.
  private func renewRecorderLease(sessionID: String) async -> Bool {
    guard let lease = recorderLeases[sessionID] else { return false }
    do {
      var request = URLRequest(
        url: configuration.baseURL.appendingPathComponent(
          "api/meeting-media/recorder-lease/renew"))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.setValue("Bearer \(configuration.bearerToken)", forHTTPHeaderField: "authorization")
      request.httpBody = try JSONEncoder().encode(RecorderLeaseBody(
        meetingReference: lease.meetingReference,
        sessionID: lease.sessionID,
        deviceID: lease.deviceID,
        leaseToken: lease.token
      ))
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { return true }
      if http.statusCode == 409 {
        stopRecorderLeaseRenewal(sessionID: sessionID, discardLease: true)
        return false
      }
      guard http.statusCode == 200 else { return true }
      let renewed = try JSONDecoder().decode(RecorderLeaseResponse.self, from: data)
      guard renewed.granted,
        renewed.ownerSessionID == lease.sessionID,
        renewed.ownerDeviceID == lease.deviceID,
        renewed.leaseToken == lease.token
      else {
        stopRecorderLeaseRenewal(sessionID: sessionID, discardLease: true)
        return false
      }
      recorderLeases[sessionID] = .init(
        meetingReference: lease.meetingReference,
        sessionID: lease.sessionID,
        deviceID: lease.deviceID,
        token: lease.token,
        expiresAtMilliseconds: renewed.expiresAtMilliseconds
      )
      return true
    } catch {
      return true
    }
  }

  private func stopRecorderLeaseRenewal(sessionID: String, discardLease: Bool) {
    recorderLeaseRenewalTasks.removeValue(forKey: sessionID)?.cancel()
    if discardLease { recorderLeases.removeValue(forKey: sessionID) }
  }

  private struct UploadBody: Encodable {
    let chunk: MeetingAudioChunk
    let audioBase64: String
    let meetingReference: String?
    let recorderDeviceID: String?
    let recorderLeaseToken: String?
    enum CodingKeys: String, CodingKey {
      case chunk
      case audioBase64 = "audio_base64"
      case meetingReference = "meeting_ref"
      case recorderDeviceID = "recorder_device_id"
      case recorderLeaseToken = "recorder_lease_token"
    }
  }

  private struct RealtimeFrameBody: Encodable {
    let frame: MeetingRealtimeAudioFrame
    let audioBase64: String
    let meetingReference: String?
    let recorderDeviceID: String?
    let recorderLeaseToken: String?

    enum CodingKeys: String, CodingKey {
      case frame
      case audioBase64 = "audio_base64"
      case meetingReference = "meeting_ref"
      case recorderDeviceID = "recorder_device_id"
      case recorderLeaseToken = "recorder_lease_token"
    }
  }

  private struct SessionScopeBody: Encodable {
    let sessionID: String
    let platform: MeetingPlatform
    let meetingReference: String
    let status: MeetingSessionStatus
    let startedAtMilliseconds: Int64?
    let endedAtMilliseconds: Int64?
    let recorderDeviceID: String?
    let recorderLeaseToken: String?

    enum CodingKeys: String, CodingKey {
      case sessionID = "session_id"
      case platform
      case meetingReference = "meeting_ref"
      case status
      case startedAtMilliseconds = "started_at_ms"
      case endedAtMilliseconds = "ended_at_ms"
      case recorderDeviceID = "recorder_device_id"
      case recorderLeaseToken = "recorder_lease_token"
    }
  }

  private struct RecorderLeaseBody: Encodable {
    let meetingReference: String
    let sessionID: String
    let deviceID: String
    let leaseToken: String?

    enum CodingKeys: String, CodingKey {
      case meetingReference = "meeting_ref"
      case sessionID = "session_id"
      case deviceID = "device_id"
      case leaseToken = "lease_token"
    }
  }

  private struct FinalizeBody: Encodable {
    let sessionID: String
    let meetingID: String
    let platform: MeetingPlatform
    let providerMeetingID: String
    let startedAtMilliseconds: Int64?
    let endedAtMilliseconds: Int64?
    let expectedTracks: [MeetingAudioTrack]
    let expectedLastSequence: [String: Int]
    let knownMissingChunkIDs: [String]

    enum CodingKeys: String, CodingKey {
      case sessionID = "session_id"
      case meetingID = "meeting_id"
      case platform
      case providerMeetingID = "provider_meeting_id"
      case startedAtMilliseconds = "started_at_ms"
      case endedAtMilliseconds = "ended_at_ms"
      case expectedTracks = "expected_tracks"
      case expectedLastSequence = "expected_last_sequence"
      case knownMissingChunkIDs = "known_missing_chunk_ids"
    }
  }

  private struct MeetingDeletionAcknowledgementBody: Encodable {
    let commandID: String
    let deviceID: String
    let deletedSessionIDs: [String]

    enum CodingKeys: String, CodingKey {
      case commandID = "command_id"
      case deviceID = "device_id"
      case deletedSessionIDs = "deleted_session_ids"
    }
  }

  private func wallClock(_ monotonic: Int64?, session: MeetingSessionState) -> Int64? {
    guard let monotonic else { return nil }
    return session.wallClockAnchorMilliseconds + (monotonic - session.monotonicAnchorMilliseconds)
  }
}

/// Local evidence is authoritative. Upload failures never roll back a sealed
/// chunk; a later `flushAndFinalize` replays all local chunks idempotently.
public actor UploadingMeetingEvidenceStore: MeetingEvidenceStore {
  private let local: FileMeetingEvidenceStore
  private let uploader: MeetingMediaUploader
  private var lifecycleRegistrationTails: [String: Task<Void, Never>] = [:]
  private var lifecycleRegistrationTailTokens: [String: UUID] = [:]

  public init(local: FileMeetingEvidenceStore, uploader: MeetingMediaUploader) {
    self.local = local
    self.uploader = uploader
  }

  public func persistSession(_ session: MeetingSessionState) async throws {
    try await local.persistSession(session)
    let lastEvent = session.events.last?.type
    let lifecycleProjectionChanged = session.status == .paused
      || session.status == .sealed
      || (session.status == .recording
        && (lastEvent == .recordingStarted || lastEvent == .recordingResumed))
    if lifecycleProjectionChanged {
      // Registration powers the live-board projection, but it is not part of
      // the local evidence transaction. A slow/offline server must never stop
      // local recording after the session was safely persisted. Chunk events
      // do not change this projection and must not create one registration
      // request every five seconds during a long dual-track meeting.
      enqueueLifecycleRegistration(session)
    }
  }

  private func enqueueLifecycleRegistration(_ session: MeetingSessionState) {
    let key = session.sessionID
    let predecessor = lifecycleRegistrationTails[key]
    let token = UUID()
    lifecycleRegistrationTailTokens[key] = token
    lifecycleRegistrationTails[key] = Task { [weak self] in
      await predecessor?.value
      guard let self else { return }
      _ = try? await self.uploader.register(session)
      await self.completeLifecycleRegistration(sessionID: key, token: token)
    }
  }

  private func completeLifecycleRegistration(sessionID: String, token: UUID) {
    guard lifecycleRegistrationTailTokens[sessionID] == token else { return }
    lifecycleRegistrationTails.removeValue(forKey: sessionID)
    lifecycleRegistrationTailTokens.removeValue(forKey: sessionID)
  }

  public func persistChunk(_ chunk: CapturedAudioChunk) async throws {
    try await local.persistChunk(chunk)
    Task { try? await uploadAndAcknowledge(chunk) }
  }

  public func loadSessions() async throws -> [MeetingSessionState] { try await local.loadSessions() }
  public func loadRecoverableSessions() async throws -> [MeetingSessionState] { try await local.loadRecoverableSessions() }
  public func loadChunks(sessionID: String) async throws -> [CapturedAudioChunk] {
    try await local.loadChunks(sessionID: sessionID)
  }
  public func loadPendingChunks(sessionID: String) async throws -> [CapturedAudioChunk] { try await local.loadPendingChunks(sessionID: sessionID) }
  public func persistAcknowledgement(
    _ acknowledgement: MeetingMediaChunkAcknowledgement
  ) async throws {
    try await local.persistAcknowledgement(acknowledgement)
  }

  public func flushAndFinalizeIfPresent(
    _ session: MeetingSessionState
  ) async throws -> MeetingMediaFinalizeResponse? {
    await lifecycleRegistrationTails[session.sessionID]?.value
    if let receipt = try await local.loadFinalizationReceipt(sessionID: session.sessionID) {
      await uploader.relinquishRecorderLease(sessionID: session.sessionID)
      return receipt
    }
    let allChunks = try await local.loadChunks(sessionID: session.sessionID)
    guard !allChunks.isEmpty else {
      // A crash may occur after session detection but before either track has
      // produced a durable chunk. Register the sealed scope, but do not create
      // an empty formal transcript or a postprocess run.
      _ = try? await uploader.register(session)
      await uploader.relinquishRecorderLease(sessionID: session.sessionID)
      return nil
    }
    // A restarted Companion has no in-memory lease token. Re-register first;
    // the same device/session can reclaim its persisted server lease, then
    // pending chunks can be uploaded under that ownership.
    do {
      _ = try await uploader.register(session)
      let chunks = try await local.loadPendingChunks(sessionID: session.sessionID)
      let failures = await replayPending(chunks)
      guard failures.isEmpty else {
        throw MeetingMediaUploadError.pendingChunks(failures.keys.sorted())
      }
      let response = try await uploader.finalize(session)
      try await local.persistFinalizationReceipt(response, sessionID: session.sessionID)
      return response
    } catch {
      await uploader.relinquishRecorderLease(sessionID: session.sessionID)
      throw error
    }
  }

  public func flushAndFinalize(_ session: MeetingSessionState) async throws
    -> MeetingMediaFinalizeResponse
  {
    guard let response = try await flushAndFinalizeIfPresent(session) else {
      throw MeetingMediaUploadError.noAudioChunks
    }
    return response
  }

  public func resumePendingUploads() async {
    guard let sessions = try? await local.loadSessions() else { return }
    for session in sessions {
      if (try? await local.loadFinalizationReceipt(sessionID: session.sessionID)) != nil {
        continue
      }
      guard let chunks = try? await local.loadPendingChunks(sessionID: session.sessionID)
      else { continue }
      guard (try? await uploader.register(session)) != nil else { continue }
      _ = await replayPending(chunks)
      if session.status == .sealed {
        _ = try? await flushAndFinalizeIfPresent(session)
      }
    }
  }

  public func applyPendingMeetingDeletions() async throws -> Int {
    let localSessions = try await local.loadSessions()
    let commands = try await uploader.pendingMeetingDeletionCommands(
      meetings: localSessions.map(MeetingDeletionCandidate.init))
    for command in commands {
      let deleted = try await local.deleteSealedSessions(
        meetingReferences: Set(command.meetingReferences),
        occurrenceStartedAtMilliseconds: command.occurrenceStartedAtMilliseconds,
        occurrenceEndedAtMilliseconds: command.occurrenceEndedAtMilliseconds)
      try await uploader.acknowledgeMeetingDeletion(
        commandID: command.commandID,
        deletedSessionIDs: deleted)
    }
    return commands.count
  }

  private func uploadAndAcknowledge(_ chunk: CapturedAudioChunk) async throws {
    let acknowledgement = try await uploader.upload(chunk)
    try await local.persistAcknowledgement(acknowledgement)
  }

  private func replayPending(_ chunks: [CapturedAudioChunk]) async -> [String: String] {
    var failures: [String: String] = [:]
    for chunk in chunks {
      do { try await uploadAndAcknowledge(chunk) }
      catch { failures[chunk.metadata.chunkID] = String(describing: error) }
    }
    return failures
  }
}

public enum MeetingMediaUploadError: Error, Equatable, Sendable {
  case serverRejected(Int)
  case invalidAcknowledgement
  case invalidSessionScope
  case pendingChunks([String])
  case noAudioChunks
  case recorderLeaseRequired
}
