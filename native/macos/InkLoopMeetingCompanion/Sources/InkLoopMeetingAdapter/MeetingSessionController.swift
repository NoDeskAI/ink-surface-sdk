import Foundation

public struct MeetingCompanionConfiguration: Equatable, Sendable {
  public var automaticallyRecordSupportedMeetings: Bool

  public init(automaticallyRecordSupportedMeetings: Bool) {
    self.automaticallyRecordSupportedMeetings = automaticallyRecordSupportedMeetings
  }
}

public actor MeetingSessionController {
  private var configuration: MeetingCompanionConfiguration
  private let captureAdapter: any MeetingAudioCaptureAdapter
  private let evidenceStore: any MeetingEvidenceStore
  private let recorderLeaseCoordinator: (any MeetingRecorderLeaseCoordinator)?
  private let statusSink: any CompanionStatusSink
  private var activeSession: MeetingSessionState?
  private var activeTracks: Set<MeetingAudioTrack> = []
  private var unavailableTracks: Set<MeetingAudioTrack> = []
  private var captureTransitionInProgress = false

  public init(
    configuration: MeetingCompanionConfiguration,
    captureAdapter: any MeetingAudioCaptureAdapter,
    evidenceStore: any MeetingEvidenceStore,
    recorderLeaseCoordinator: (any MeetingRecorderLeaseCoordinator)? = nil,
    statusSink: (any CompanionStatusSink)? = nil
  ) {
    self.configuration = configuration
    self.captureAdapter = captureAdapter
    self.evidenceStore = evidenceStore
    self.recorderLeaseCoordinator = recorderLeaseCoordinator
    self.statusSink = statusSink ?? NullCompanionStatusSink()
  }

  public func setAutomaticallyRecordSupportedMeetings(_ enabled: Bool) {
    configuration.automaticallyRecordSupportedMeetings = enabled
  }

  @discardableResult
  public func handleDetectedMeeting(
    _ meeting: DetectedMeeting,
    wallClockAnchorMilliseconds: Int64,
    sessionID: String = UUID().uuidString
  ) async throws -> MeetingSessionState? {
    guard configuration.automaticallyRecordSupportedMeetings else {
      await statusSink.publish(
        .init(
          state: .detected,
          platform: meeting.platform,
          message: "Supported meeting detected; automatic recording is disabled."
        ))
      return nil
    }
    do {
      return try await start(
        meeting: meeting,
        mode: .automatic,
        wallClockAnchorMilliseconds: wallClockAnchorMilliseconds,
        sessionID: sessionID
      )
    } catch MeetingAdapterError.recorderLeaseHeldByAnotherDevice {
      return nil
    }
  }

  @discardableResult
  public func startManually(
    meeting: DetectedMeeting,
    wallClockAnchorMilliseconds: Int64,
    sessionID: String = UUID().uuidString
  ) async throws -> MeetingSessionState {
    try await start(
      meeting: meeting,
      mode: .manual,
      wallClockAnchorMilliseconds: wallClockAnchorMilliseconds,
      sessionID: sessionID
    )
  }

  public func ingestSealedChunk(_ chunk: CapturedAudioChunk) async throws {
    guard var session = activeSession, session.status == .recording else {
      throw MeetingAdapterError.noActiveRecording
    }
    do {
      try await persistCapturedChunk(chunk, in: &session)
      activeSession = session
      try await evidenceStore.persistSession(session)
    } catch {
      await statusSink.publish(
        status(for: session, state: .error, message: "Failed to persist a sealed audio chunk."))
      throw error
    }
  }

  public func handleTrackUnavailable(
    _ track: MeetingAudioTrack,
    atMonotonicMilliseconds: Int64,
    reason: String
  ) async {
    guard !captureTransitionInProgress,
      var session = activeSession,
      session.status == .recording,
      activeTracks.contains(track)
    else { return }
    activeTracks.remove(track)
    unavailableTracks.insert(track)
    session.events.append(
      .init(
        eventID: nextEventID(session),
        type: .audioTrackUnavailable,
        atMonotonicMilliseconds: atMonotonicMilliseconds,
        evidence: nil,
        chunkReference: nil,
        stopReason: nil,
        track: track,
        unavailabilityReason: String(reason.prefix(160))
      ))
    activeSession = session
    do {
      try await evidenceStore.persistSession(session)
      await statusSink.publish(
        status(
          for: session,
          state: .degraded,
          message: "The \(track.rawValue) track stopped; remaining evidence is still recording."
        ))
    } catch {
      await statusSink.publish(
        status(
          for: session,
          state: .error,
          message: "A track stopped and its degraded boundary could not be persisted."
        ))
    }
  }

  /// Confirmed end is intentionally immediate: capture is stopped before any
  /// tail-chunk persistence or manifest work, and there is no countdown state.
  @discardableResult
  public func stopForConfirmedEnd(
    meetingReference: String,
    atMonotonicMilliseconds: Int64,
    evidence: ConfirmedMeetingEndEvidence
  ) async throws -> MeetingSessionState {
    guard !captureTransitionInProgress else {
      throw MeetingAdapterError.captureTransitionInProgress
    }
    guard let session = activeSession,
      session.status == .recording || session.status == .paused
    else {
      throw MeetingAdapterError.noActiveRecording
    }
    guard session.meetingReference == meetingReference else {
      throw MeetingAdapterError.confirmedEndBelongsToAnotherMeeting
    }

    return try await stop(
      session: session,
      atMonotonicMilliseconds: atMonotonicMilliseconds,
      reason: .meetingEndConfirmed,
      evidence: evidence
    )
  }

  @discardableResult
  public func stopManually(atMonotonicMilliseconds: Int64) async throws -> MeetingSessionState {
    guard !captureTransitionInProgress else {
      throw MeetingAdapterError.captureTransitionInProgress
    }
    guard let session = activeSession,
      session.status == .recording || session.status == .paused
    else {
      throw MeetingAdapterError.noActiveRecording
    }
    return try await stop(
      session: session,
      atMonotonicMilliseconds: atMonotonicMilliseconds,
      reason: .manual,
      evidence: nil
    )
  }

  public func currentSession() -> MeetingSessionState? {
    activeSession
  }

  /// Seals sessions left active by a previous process crash or system restart.
  /// Recovery never invents platform end evidence and never resumes capture:
  /// already-persisted chunks are the complete authoritative boundary.
  @discardableResult
  public func recoverInterruptedSessions() async throws -> [MeetingSessionState] {
    let interrupted = try await evidenceStore.loadRecoverableSessions()
    var recovered: [MeetingSessionState] = []
    for var session in interrupted {
      let endedAt = session.events.map(\.atMonotonicMilliseconds).max()
        ?? session.startedMonotonicMilliseconds
        ?? session.monotonicAnchorMilliseconds
      session.events.append(
        .init(
          eventID: nextEventID(session),
          type: .interruptedSessionRecovered,
          atMonotonicMilliseconds: endedAt,
          evidence: nil,
          chunkReference: nil,
          stopReason: .interruptedSessionRecovered
        ))
      session.events.append(
        .init(
          eventID: nextEventID(session),
          type: .recordingStopped,
          atMonotonicMilliseconds: endedAt,
          evidence: nil,
          chunkReference: nil,
          stopReason: .interruptedSessionRecovered
        ))
      session.status = .sealed
      session.endedMonotonicMilliseconds = endedAt
      session.stopReason = .interruptedSessionRecovered
      try await evidenceStore.persistSession(session)
      recovered.append(session)
    }
    return recovered
  }

  @discardableResult
  public func pause(atMonotonicMilliseconds: Int64) async throws -> MeetingSessionState {
    guard !captureTransitionInProgress else {
      throw MeetingAdapterError.captureTransitionInProgress
    }
    guard var session = activeSession, session.status == .recording else {
      if activeSession?.status == .paused { throw MeetingAdapterError.captureAlreadyPaused }
      throw MeetingAdapterError.noActiveRecording
    }
    captureTransitionInProgress = true
    defer { captureTransitionInProgress = false }

    let tails = try await captureAdapter.pauseAndSealCapture()
    // The capture adapter waits for audio callbacks already in flight. Those
    // callbacks re-enter this actor and may append chunk events while the
    // pause call is suspended, so continue from the latest session snapshot.
    guard let current = activeSession, current.sessionID == session.sessionID,
      current.status == .recording
    else { throw MeetingAdapterError.noActiveRecording }
    session = current
    do {
      for chunk in tails {
        try await persistCapturedChunk(chunk, in: &session)
      }
      session.status = .paused
      session.events.append(
        .init(
          eventID: nextEventID(session),
          type: .recordingPaused,
          atMonotonicMilliseconds: atMonotonicMilliseconds,
          evidence: nil,
          chunkReference: nil,
          stopReason: nil
        ))
      activeSession = session
      activeTracks = []
      try await evidenceStore.persistSession(session)
    } catch {
      // Capture is already stopped at this point. Keep the in-memory state on
      // the safe side of that hardware boundary even when a tail or lifecycle
      // write fails, then make a best-effort durable paused projection.
      session.status = .paused
      if session.events.last?.type != .recordingPaused {
        session.events.append(
          .init(
            eventID: nextEventID(session),
            type: .recordingPaused,
            atMonotonicMilliseconds: atMonotonicMilliseconds,
            evidence: nil,
            chunkReference: nil,
            stopReason: nil
          ))
      }
      activeSession = session
      activeTracks = []
      try? await evidenceStore.persistSession(session)
      await statusSink.publish(
        status(
          for: session,
          state: .error,
          message: "Capture is paused, but its latest evidence state could not be persisted."
        ))
      throw error
    }
    await statusSink.publish(
      status(for: session, state: .paused, message: "Recording is paused; sealed evidence remains safe."))
    return session
  }

  @discardableResult
  public func resume(atMonotonicMilliseconds: Int64) async throws -> MeetingSessionState {
    guard !captureTransitionInProgress else {
      throw MeetingAdapterError.captureTransitionInProgress
    }
    guard var session = activeSession, session.status == .paused else {
      throw MeetingAdapterError.captureNotPaused
    }
    captureTransitionInProgress = true
    defer { captureTransitionInProgress = false }

    let pausedSession = session
    let capture = try await captureAdapter.resumeCapture()
    activeTracks = capture.activeTracks
    unavailableTracks = capture.unavailableTracks
    session.status = .recording
    session.events.append(
      .init(
        eventID: nextEventID(session),
        type: .recordingResumed,
        atMonotonicMilliseconds: atMonotonicMilliseconds,
        evidence: nil,
        chunkReference: nil,
        stopReason: nil
      ))
    activeSession = session
    do {
      try await evidenceStore.persistSession(session)
    } catch {
      // Do not report a paused durable state while hardware keeps recording.
      // Roll the adapter back to paused and preserve any frames already sealed
      // during that short failed resume window.
      var rollback = pausedSession
      let rollbackTails = (try? await captureAdapter.pauseAndSealCapture()) ?? []
      for chunk in rollbackTails {
        try? await persistCapturedChunk(chunk, in: &rollback)
      }
      rollback.status = .paused
      activeSession = rollback
      activeTracks = []
      try? await evidenceStore.persistSession(rollback)
      await statusSink.publish(
        status(
          for: rollback,
          state: .error,
          message: "Recording was paused again because the resumed state could not be persisted."
        ))
      throw error
    }
    await statusSink.publish(
      status(
        for: session,
        state: capture.unavailableTracks.isEmpty ? .recording : .degraded,
        message: capture.unavailableTracks.isEmpty
          ? "Recording resumed on Mic and Remote tracks."
          : "Recording resumed with an unavailable audio track."
      ))
    return session
  }

  private func stop(
    session originalSession: MeetingSessionState,
    atMonotonicMilliseconds: Int64,
    reason: MeetingStopReason,
    evidence: ConfirmedMeetingEndEvidence?
  ) async throws -> MeetingSessionState {
    var session = originalSession
    captureTransitionInProgress = true
    defer { captureTransitionInProgress = false }

    do {
      let tailChunks = try await captureAdapter.stopAndSealCapture()
      // stopAndSealCapture drains callbacks before returning. Merge any chunk
      // events persisted by those re-entrant callbacks before sealing the
      // authoritative manifest instead of overwriting them with the snapshot
      // captured before the await.
      if let current = activeSession, current.sessionID == session.sessionID {
        session = current
      }
      for chunk in tailChunks {
        try await persistCapturedChunk(chunk, in: &session)
      }

      if reason == .meetingEndConfirmed {
        session.events.append(
          .init(
            eventID: nextEventID(session),
            type: .meetingEndConfirmed,
            atMonotonicMilliseconds: atMonotonicMilliseconds,
            evidence: evidence,
            chunkReference: nil,
            stopReason: nil
          ))
      }
      session.events.append(
        .init(
          eventID: nextEventID(session),
          type: .recordingStopped,
          atMonotonicMilliseconds: atMonotonicMilliseconds,
          evidence: nil,
          chunkReference: nil,
          stopReason: reason
        ))
      session.status = .sealed
      session.endedMonotonicMilliseconds = atMonotonicMilliseconds
      session.stopReason = reason
      activeSession = nil
      activeTracks = []
      unavailableTracks = []
      try await evidenceStore.persistSession(session)
      await statusSink.publish(
        status(
          for: session,
          state: .sealed,
          message: reason == .meetingEndConfirmed
            ? "Meeting ended; recording stopped immediately."
            : "Recording stopped manually."
        ))
      return session
    } catch {
      // Once stop has been requested, never represent the session as still
      // recording. This avoids accidental continuation after a disk error.
      session.status = .sealed
      session.endedMonotonicMilliseconds = atMonotonicMilliseconds
      session.stopReason = reason
      activeSession = nil
      activeTracks = []
      unavailableTracks = []
      await statusSink.publish(
        status(
          for: session, state: .error,
          message: "Recording stopped, but final evidence persistence failed."))
      throw error
    }
  }

  private func start(
    meeting: DetectedMeeting,
    mode: MeetingStartMode,
    wallClockAnchorMilliseconds: Int64,
    sessionID: String
  ) async throws -> MeetingSessionState {
    guard activeSession == nil, !captureTransitionInProgress else {
      throw MeetingAdapterError.alreadyRecording
    }
    captureTransitionInProgress = true
    defer { captureTransitionInProgress = false }
    let ownership = await recorderLeaseCoordinator?.claimRecorderLease(
      for: meeting, sessionID: sessionID) ?? .granted
    if case .heldByAnotherDevice(let ownerDeviceID) = ownership {
      await statusSink.publish(
        .init(
          state: .detected,
          platform: meeting.platform,
          message: "另一台已登录设备正在记录本场会议，本机保持待命。"
        ))
      throw MeetingAdapterError.recorderLeaseHeldByAnotherDevice(ownerDeviceID)
    }
    let ownershipUnconfirmed = ownership == .unavailable
    var session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: sessionID,
      platform: meeting.platform,
      meetingReference: meeting.meetingReference,
      startMode: mode,
      status: .detected,
      wallClockAnchorMilliseconds: wallClockAnchorMilliseconds,
      monotonicAnchorMilliseconds: meeting.detectedAtMonotonicMilliseconds,
      startedMonotonicMilliseconds: nil,
      endedMonotonicMilliseconds: nil,
      stopReason: nil,
      events: []
    )
    session.events.append(
      .init(
        eventID: nextEventID(session),
        type: .sessionDetected,
        atMonotonicMilliseconds: meeting.detectedAtMonotonicMilliseconds,
        evidence: nil,
        chunkReference: nil,
        stopReason: nil
      ))
    // Reserve the lifecycle before the first suspension point. Swift actors
    // are re-entrant across await, so a concurrent detection cannot start a
    // second capture while this one persists its initial manifest.
    activeSession = session
    do {
      try await evidenceStore.persistSession(session)
    } catch {
      activeSession = nil
      await recorderLeaseCoordinator?.relinquishRecorderLease(sessionID: sessionID)
      await statusSink.publish(
        status(
          for: session, state: .error,
          message: "Cannot start because the session manifest could not be persisted."))
      throw error
    }

    let capture: AudioCaptureStartResult
    do {
      capture = try await captureAdapter.startCapture(
        for: session,
        onSealedChunk: { [weak self] chunk in
          guard let self else { return }
          try await self.ingestSealedChunk(chunk)
        },
        onTrackUnavailable: { [weak self] track, at, reason in
          await self?.handleTrackUnavailable(
            track, atMonotonicMilliseconds: at, reason: reason)
        }
      )
    } catch {
      activeSession = nil
      await recorderLeaseCoordinator?.relinquishRecorderLease(sessionID: sessionID)
      await statusSink.publish(
        status(for: session, state: .error, message: "No supported audio track could start."))
      throw error
    }
    activeTracks = capture.activeTracks
    unavailableTracks = capture.unavailableTracks
    session.status = .recording
    session.startedMonotonicMilliseconds = meeting.detectedAtMonotonicMilliseconds
    session.events.append(
      .init(
        eventID: nextEventID(session),
        type: .recordingStarted,
        atMonotonicMilliseconds: meeting.detectedAtMonotonicMilliseconds,
        evidence: nil,
        chunkReference: nil,
        stopReason: nil
      ))
    activeSession = session
    do {
      try await evidenceStore.persistSession(session)
    } catch {
      _ = try? await captureAdapter.stopAndSealCapture()
      activeSession = nil
      activeTracks = []
      unavailableTracks = []
      await recorderLeaseCoordinator?.relinquishRecorderLease(sessionID: sessionID)
      await statusSink.publish(
        status(
          for: session, state: .error,
          message: "Capture was stopped because recording state could not be persisted."))
      throw error
    }
    await statusSink.publish(
      .init(
        state: capture.unavailableTracks.isEmpty && !ownershipUnconfirmed ? .recording : .degraded,
        sessionID: session.sessionID,
        platform: session.platform,
        activeTracks: capture.activeTracks,
        unavailableTracks: capture.unavailableTracks,
        captureActive: true,
        message: ownershipUnconfirmed
          ? "租约服务暂不可用；正在仅本地记录，取得云端归属后再补传。"
          : capture.unavailableTracks.isEmpty
          ? "Recording Mic and Remote tracks."
          : "Recording continues with an unavailable audio track."
      ))
    return session
  }

  private func appendChunkEvent(_ chunk: MeetingAudioChunk, to session: inout MeetingSessionState) {
    session.events.append(
      .init(
        eventID: nextEventID(session),
        type: .audioChunkSealed,
        atMonotonicMilliseconds: chunk.endMonotonicMilliseconds,
        evidence: nil,
        chunkReference: .init(
          chunkID: chunk.chunkID,
          track: chunk.track,
          sequence: chunk.sequence,
          checksum: chunk.checksum
        ),
        stopReason: nil
      ))
  }

  private func persistCapturedChunk(
    _ chunk: CapturedAudioChunk,
    in session: inout MeetingSessionState
  ) async throws {
    guard chunk.metadata.sessionID == session.sessionID else {
      throw MeetingAdapterError.chunkBelongsToAnotherSession
    }
    if let existing = session.events.first(where: {
      $0.chunkReference?.track == chunk.metadata.track
        && $0.chunkReference?.sequence == chunk.metadata.sequence
    }) {
      guard existing.chunkReference == MeetingChunkReference(
        chunkID: chunk.metadata.chunkID,
        track: chunk.metadata.track,
        sequence: chunk.metadata.sequence,
        checksum: chunk.metadata.checksum
      ) else { throw MeetingAdapterError.chunkConflict(chunk.metadata.chunkID) }
      try await evidenceStore.persistChunk(chunk)
      return
    }
    try await evidenceStore.persistChunk(chunk)
    appendChunkEvent(chunk.metadata, to: &session)
  }

  private func nextEventID(_ session: MeetingSessionState) -> String {
    "\(session.sessionID):event:\(session.events.count)"
  }

  private func status(
    for session: MeetingSessionState,
    state: CompanionOperatingState,
    message: String
  ) -> CompanionStatusSnapshot {
    .init(
      state: state,
      sessionID: session.sessionID,
      platform: session.platform,
      activeTracks: activeTracks,
      unavailableTracks: unavailableTracks,
      captureActive: activeSession?.sessionID == session.sessionID
        && activeSession?.status == .recording,
      message: message
    )
  }
}
