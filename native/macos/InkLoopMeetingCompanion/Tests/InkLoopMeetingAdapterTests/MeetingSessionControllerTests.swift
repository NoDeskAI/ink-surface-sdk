import CryptoKit
import Foundation
import Testing

@testable import InkLoopMeetingAdapter

@Suite("macOS meeting permission progression")
struct MeetingPermissionProgressionTests {
  @Test("requests TCC permissions one at a time in capture dependency order")
  func progressesInDependencyOrder() {
    #expect(snapshot(.notDetermined, .notDetermined, .notDetermined).nextRequiredPermission == .microphone)
    #expect(snapshot(.granted, .notDetermined, .notDetermined).nextRequiredPermission == .screenAndSystemAudio)
    #expect(snapshot(.granted, .granted, .notDetermined).nextRequiredPermission == .accessibility)
    #expect(snapshot(.granted, .granted, .granted).nextRequiredPermission == nil)
  }

  @Test("a denied earlier dependency remains the next recoverable permission")
  func deniedDependencyRemainsActionable() {
    #expect(snapshot(.denied, .granted, .granted).nextRequiredPermission == .microphone)
  }

  private func snapshot(
    _ microphone: MeetingPermissionStatus,
    _ screen: MeetingPermissionStatus,
    _ accessibility: MeetingPermissionStatus
  ) -> MeetingPermissionSnapshot {
    .init(microphone: microphone, screenAndSystemAudio: screen, accessibility: accessibility)
  }
}

@Suite("Meeting session controller")
struct MeetingSessionControllerTests {
  @Test("automatic start records and confirmed end stops capture immediately")
  func automaticStartAndImmediateStop() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let store = EvidenceStoreSpy()
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: store,
      statusSink: statuses
    )

    let started = try #require(
      await controller.handleDetectedMeeting(
        meeting(),
        wallClockAnchorMilliseconds: 10_000,
        sessionID: "session-1"
      ))
    let evidence = try ConfirmedMeetingEndEvidence(
      validatingAdapter: "zoom_macos",
      signal: "meeting_call_ended"
    )
    let sealed = try await controller.stopForConfirmedEnd(
      meetingReference: "zoom:123",
      atMonotonicMilliseconds: 5_000,
      evidence: evidence
    )

    #expect(started.status == .recording)
    #expect(await capture.stopCount == 1)
    #expect(sealed.status == .sealed)
    #expect(sealed.endedMonotonicMilliseconds == 5_000)
    #expect(sealed.events.suffix(2).map(\.type) == [.meetingEndConfirmed, .recordingStopped])
    #expect(await controller.currentSession() == nil)
    #expect(await statuses.values.last?.state == .sealed)
  }

  @Test("automatic detection stays idle when another signed-in device owns the recorder lease")
  func respectsRecorderOwnership() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy(),
      recorderLeaseCoordinator: RecorderLeaseSpy(
        disposition: .heldByAnotherDevice(ownerDeviceID: "other-mac")),
      statusSink: statuses
    )

    let result = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000, sessionID: "session-local")

    #expect(result == nil)
    #expect(await controller.currentSession() == nil)
    #expect(await capture.startCount == 0)
    #expect(await statuses.values.last?.state == .detected)
    #expect(await statuses.values.last?.message?.contains("另一台") == true)
  }

  @Test("lease network failure degrades to local authoritative capture")
  func recordsLocallyWhenLeaseServiceIsUnavailable() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy(),
      recorderLeaseCoordinator: RecorderLeaseSpy(disposition: .unavailable),
      statusSink: statuses
    )

    let result = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000, sessionID: "session-offline")

    #expect(result?.status == .recording)
    #expect(await capture.startCount == 1)
    #expect(await statuses.values.last?.state == .degraded)
    #expect(await statuses.values.last?.message?.contains("仅本地记录") == true)
  }

  @Test("confirmed end for another meeting cannot stop the active recording")
  func ignoresForeignConfirmedEnd() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy()
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(),
      wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-1"
    )
    let evidence = try ConfirmedMeetingEndEvidence(
      validatingAdapter: "zoom_macos",
      signal: "meeting_call_ended"
    )

    await #expect(throws: MeetingAdapterError.confirmedEndBelongsToAnotherMeeting) {
      try await controller.stopForConfirmedEnd(
        meetingReference: "zoom:another",
        atMonotonicMilliseconds: 5_000,
        evidence: evidence
      )
    }
    #expect(await capture.stopCount == 0)
    #expect(await controller.currentSession()?.status == .recording)
  }

  @Test("manual stop seals without fabricating confirmed-end evidence")
  func manualStop() async throws {
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: CaptureSpy(
        startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: [])),
      evidenceStore: EvidenceStoreSpy()
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(),
      wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-1"
    )

    let sealed = try await controller.stopManually(atMonotonicMilliseconds: 2_000)

    #expect(sealed.stopReason == .manual)
    #expect(sealed.events.last?.type == .recordingStopped)
    #expect(!sealed.events.contains { $0.type == .meetingEndConfirmed })
  }

  @Test("manual start remains available when automatic recording is disabled")
  func manualStartWhenAutomaticRecordingIsDisabled() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: false),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy()
    )

    let started = try await controller.startManually(
      meeting: meeting(),
      wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-manual"
    )

    #expect(started.startMode == .manual)
    #expect(started.status == .recording)
    #expect(await capture.startCount == 1)
  }

  @Test("automatic detection stays non-blocking when preference is disabled")
  func autoRecordDisabled() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: false),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy(),
      statusSink: statuses
    )

    let result = try await controller.handleDetectedMeeting(
      meeting(),
      wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-1"
    )

    #expect(result == nil)
    #expect(await capture.startCount == 0)
    #expect(await statuses.values.last?.state == .detected)
  }

  @Test("single-track capture reports degradation and keeps recording")
  func degradedCapture() async throws {
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: CaptureSpy(
        startResult: try .init(activeTracks: [.mic], unavailableTracks: [.remote])),
      evidenceStore: EvidenceStoreSpy(),
      statusSink: statuses
    )

    let session = try #require(
      await controller.handleDetectedMeeting(
        meeting(),
        wallClockAnchorMilliseconds: 10_000,
        sessionID: "session-1"
      ))

    #expect(session.status == .recording)
    #expect(await statuses.values.last?.state == .degraded)
    #expect(await statuses.values.last?.unavailableTracks == [.remote])
    #expect(await statuses.values.last?.captureActive == true)
  }

  @Test("a track lost during recording becomes an auditable partial boundary")
  func runtimeTrackLossBecomesPartialEvidence() async throws {
    let statuses = StatusSinkSpy()
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy(),
      statusSink: statuses
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000, sessionID: "session-1")

    await capture.reportUnavailable(
      track: .remote,
      atMonotonicMilliseconds: 1_500,
      reason: "screen_capture_stream_stopped")

    let session = try #require(await controller.currentSession())
    #expect(session.events.last?.type == .audioTrackUnavailable)
    #expect(session.events.last?.track == .remote)
    #expect(session.events.last?.unavailabilityReason == "screen_capture_stream_stopped")
    #expect(await statuses.values.last?.state == .degraded)
    #expect(await statuses.values.last?.activeTracks == [.mic])
    #expect(await statuses.values.last?.unavailableTracks == [.remote])
    #expect(await statuses.values.last?.captureActive == true)
  }

  @Test("pause seals tails and resume returns to recording without creating a new session")
  func pauseAndResume() async throws {
    let bytes = Data("tail".utf8)
    let tail = try CapturedAudioChunk(
      metadata: MeetingAudioChunk(
        chunkID: "session-1:mic:0",
        sessionID: "session-1",
        track: .mic,
        sequence: 0,
        startMonotonicMilliseconds: 100,
        endMonotonicMilliseconds: 200,
        checksum: "sha256:\(SHA256.hash(data: bytes).hexString)",
        byteLength: bytes.count
      ),
      bytes: bytes
    )
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []),
      pauseChunks: [tail]
    )
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: EvidenceStoreSpy(),
      statusSink: statuses
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000, sessionID: "session-1")

    let paused = try await controller.pause(atMonotonicMilliseconds: 500)
    let resumed = try await controller.resume(atMonotonicMilliseconds: 700)

    #expect(paused.status == .paused)
    #expect(paused.events.suffix(2).map(\.type) == [.audioChunkSealed, .recordingPaused])
    #expect(resumed.status == .recording)
    #expect(resumed.events.last?.type == .recordingResumed)
    #expect(await capture.pauseCount == 1)
    #expect(await capture.resumeCount == 1)
    #expect(await statuses.values.contains { $0.state == .paused })
  }

  @Test("pause persistence failure keeps the hardware and controller paused")
  func pausePersistenceFailureStaysPaused() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let store = FailingEvidenceStore(failOnSessionPersistCalls: [3])
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: store,
      statusSink: statuses
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000, sessionID: "session-pause-failure")

    await #expect(throws: TestEvidenceStoreError.persistFailed) {
      _ = try await controller.pause(atMonotonicMilliseconds: 500)
    }

    #expect(await capture.pauseCount == 1)
    #expect(await controller.currentSession()?.status == .paused)
    #expect(await statuses.values.last?.state == .error)
    #expect(await statuses.values.last?.captureActive == false)
    #expect(await store.sessions.last?.status == .paused)
  }

  @Test("resume persistence failure rolls hardware back to paused")
  func resumePersistenceFailureRollsBackCapture() async throws {
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let store = FailingEvidenceStore(failOnSessionPersistCalls: [4])
    let statuses = StatusSinkSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: store,
      statusSink: statuses
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000, sessionID: "session-resume-failure")
    _ = try await controller.pause(atMonotonicMilliseconds: 500)

    await #expect(throws: TestEvidenceStoreError.persistFailed) {
      _ = try await controller.resume(atMonotonicMilliseconds: 700)
    }

    #expect(await capture.pauseCount == 2)
    #expect(await capture.resumeCount == 1)
    #expect(await controller.currentSession()?.status == .paused)
    #expect(await statuses.values.last?.state == .error)
    #expect(await statuses.values.last?.captureActive == false)
    #expect(await store.sessions.last?.status == .paused)
  }

  @Test("pause retains a chunk emitted by an in-flight audio callback")
  func pauseRetainsInflightCallbackChunk() async throws {
    let chunk = try capturedChunk(sessionID: "session-pause-inflight")
    let capture = InflightCallbackCaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []),
      pauseChunk: chunk
    )
    let store = EvidenceStoreSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: store
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-pause-inflight")

    let paused = try await controller.pause(atMonotonicMilliseconds: 2_000)

    #expect(paused.events.filter { $0.type == .audioChunkSealed }.count == 1)
    #expect(paused.events.contains { $0.chunkReference?.chunkID == chunk.metadata.chunkID })
    #expect(await store.chunks.contains { $0.metadata.chunkID == chunk.metadata.chunkID })
  }

  @Test("stop retains a chunk emitted by an in-flight audio callback")
  func stopRetainsInflightCallbackChunk() async throws {
    let chunk = try capturedChunk(sessionID: "session-stop-inflight")
    let capture = InflightCallbackCaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []),
      stopChunk: chunk
    )
    let store = EvidenceStoreSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: store
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(), wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-stop-inflight")

    let sealed = try await controller.stopManually(atMonotonicMilliseconds: 2_000)

    #expect(sealed.events.filter { $0.type == .audioChunkSealed }.count == 1)
    #expect(sealed.events.contains { $0.chunkReference?.chunkID == chunk.metadata.chunkID })
    #expect(await store.chunks.contains { $0.metadata.chunkID == chunk.metadata.chunkID })
  }

  @Test("replaying the same sealed chunk is idempotent")
  func sealedChunkReplay() async throws {
    let store = EvidenceStoreSpy()
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: CaptureSpy(
        startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: [])),
      evidenceStore: store
    )
    _ = try await controller.handleDetectedMeeting(
      meeting(),
      wallClockAnchorMilliseconds: 10_000,
      sessionID: "session-1"
    )
    let bytes = Data("audio".utf8)
    let metadata = try MeetingAudioChunk(
      chunkID: "session-1:mic:0",
      sessionID: "session-1",
      track: .mic,
      sequence: 0,
      startMonotonicMilliseconds: 100,
      endMonotonicMilliseconds: 1_100,
      checksum: "sha256:\(SHA256.hash(data: bytes).hexString)",
      byteLength: bytes.count
    )
    let chunk = try CapturedAudioChunk(metadata: metadata, bytes: bytes)

    try await controller.ingestSealedChunk(chunk)
    try await controller.ingestSealedChunk(chunk)

    let chunkEvents = await controller.currentSession()?.events.filter {
      $0.type == .audioChunkSealed
    }
    #expect(chunkEvents?.count == 1)
  }

  private func capturedChunk(sessionID: String) throws -> CapturedAudioChunk {
    let bytes = Data("inflight-audio".utf8)
    return try CapturedAudioChunk(
      metadata: MeetingAudioChunk(
        chunkID: "\(sessionID):mic:0",
        sessionID: sessionID,
        track: .mic,
        sequence: 0,
        startMonotonicMilliseconds: 100,
        endMonotonicMilliseconds: 1_100,
        checksum: "sha256:\(SHA256.hash(data: bytes).hexString)",
        byteLength: bytes.count
      ),
      bytes: bytes
    )
  }

  @Test("restart recovery seals persisted active sessions without fabricating a meeting end")
  func recoversInterruptedSession() async throws {
    let interrupted = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "session-interrupted",
      platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic,
      status: .recording,
      wallClockAnchorMilliseconds: 10_000,
      monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100,
      endedMonotonicMilliseconds: nil,
      stopReason: nil,
      events: [
        .init(
          eventID: "session-interrupted:event:0",
          type: .recordingStarted,
          atMonotonicMilliseconds: 100,
          evidence: nil,
          chunkReference: nil,
          stopReason: nil
        )
      ]
    )
    let store = EvidenceStoreSpy(recoverableSessions: [interrupted])
    let capture = CaptureSpy(
      startResult: try .init(activeTracks: [.mic, .remote], unavailableTracks: []))
    let controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: true),
      captureAdapter: capture,
      evidenceStore: store
    )

    let recovered = try await controller.recoverInterruptedSessions()

    #expect(recovered.count == 1)
    #expect(recovered[0].status == .sealed)
    #expect(recovered[0].stopReason == .interruptedSessionRecovered)
    #expect(recovered[0].endedMonotonicMilliseconds == 100)
    #expect(recovered[0].events.suffix(2).map(\.type) == [
      .interruptedSessionRecovered, .recordingStopped,
    ])
    #expect(!recovered[0].events.contains { $0.type == .meetingEndConfirmed })
    #expect(await capture.stopCount == 0)
    #expect(await store.sessions.last?.status == .sealed)
  }

  @Test(arguments: [
    "window_blurred",
    "tab_hidden",
    "application_backgrounded",
    "audio_silence",
    "network_disconnected",
  ])
  func weakSignalsCannotBecomeConfirmedEnd(_ signal: String) {
    #expect(throws: MeetingAdapterError.weakMeetingEndSignal(signal)) {
      try ConfirmedMeetingEndEvidence(validatingAdapter: "test", signal: signal)
    }
  }

  private func meeting() -> DetectedMeeting {
    .init(
      platform: .zoom,
      meetingReference: "zoom:123",
      detectionID: "detect-1",
      detectedAtMonotonicMilliseconds: 100
    )
  }
}

@Suite("File meeting evidence store")
struct FileMeetingEvidenceStoreTests {
  @Test("persists immutable raw chunks and an interoperable manifest")
  func persistsEvidence() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-meeting-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = FileMeetingEvidenceStore(rootDirectory: root)
    let bytes = Data("audio".utf8)
    let checksum = "sha256:\(SHA256.hash(data: bytes).hexString)"
    let metadata = try MeetingAudioChunk(
      chunkID: "session-1:mic:0",
      sessionID: "session-1",
      track: .mic,
      sequence: 0,
      startMonotonicMilliseconds: 100,
      endMonotonicMilliseconds: 1_100,
      checksum: checksum,
      byteLength: bytes.count,
      codec: "pcm_s16le",
      sampleRateHertz: 16_000,
      channelCount: 1
    )
    let session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "session-1",
      platform: .googleMeet,
      meetingReference: "meet:abc",
      startMode: .automatic,
      status: .sealed,
      wallClockAnchorMilliseconds: 10_000,
      monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100,
      endedMonotonicMilliseconds: nil,
      stopReason: nil,
      events: [
        .init(
          eventID: "session-1:event:0", type: .audioChunkSealed,
          atMonotonicMilliseconds: 1_100, evidence: nil,
          chunkReference: .init(
            chunkID: metadata.chunkID, track: metadata.track, sequence: metadata.sequence,
            checksum: metadata.checksum),
          stopReason: nil)
      ]
    )

    try await store.persistSession(session)
    try await store.persistChunk(try .init(metadata: metadata, bytes: bytes))
    try await store.persistChunk(try .init(metadata: metadata, bytes: bytes))

    let sessionURL = root.appendingPathComponent("session-1/session.json")
    let audioURL = root.appendingPathComponent("session-1/raw/mic/00000000.audio")
    let sequenceManifestURL = root.appendingPathComponent("session-1/sequence-manifest.json")
    let decoded = try JSONDecoder().decode(
      MeetingSessionState.self, from: Data(contentsOf: sessionURL))
    #expect(decoded == session)
    #expect(try Data(contentsOf: audioURL) == bytes)
    let audioMode = try FileManager.default.attributesOfItem(atPath: audioURL.path)[.posixPermissions] as? NSNumber
    let sessionMode = try FileManager.default.attributesOfItem(atPath: sessionURL.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber
    #expect(audioMode?.intValue == 0o600)
    #expect(sessionMode?.intValue == 0o700)
    let manifest = try JSONDecoder().decode(
      SealedMeetingSequenceManifest.self, from: Data(contentsOf: sequenceManifestURL))
    #expect(manifest.expectedTracks == [.mic, .remote])
    #expect(manifest.expectedLastSequence == [.mic: 0])
    let manifestJSON = try #require(
      JSONSerialization.jsonObject(with: Data(contentsOf: sequenceManifestURL))
        as? [String: Any])
    let manifestLastSequence = try #require(
      manifestJSON["expected_last_sequence"] as? [String: Any])
    #expect((manifestLastSequence["mic"] as? NSNumber)?.intValue == 0)
  }

  @Test("whole-meeting deletion removes only matching sealed local evidence")
  func deletesSealedMeetingEvidence() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-delete-meeting-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = FileMeetingEvidenceStore(rootDirectory: root)
    let deletedSession = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-delete",
      platform: .googleMeet, meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic, status: .sealed,
      wallClockAnchorMilliseconds: 1_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: 200,
      stopReason: .manual, events: [])
    let retainedSession = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-keep",
      platform: .zoom, meetingReference: "zoom:123",
      startMode: .automatic, status: .sealed,
      wallClockAnchorMilliseconds: 1_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: 200,
      stopReason: .manual, events: [])
    let futureOccurrence = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-future-occurrence",
      platform: .googleMeet, meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic, status: .sealed,
      wallClockAnchorMilliseconds: 605_800_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: 200,
      stopReason: .manual, events: [])
    try await store.persistSession(deletedSession)
    try await store.persistSession(retainedSession)
    try await store.persistSession(futureOccurrence)

    let deleted = try await store.deleteSealedSessions(
      meetingReferences: ["google_meet:abc-defg-hij"],
      occurrenceStartedAtMilliseconds: 1_100,
      occurrenceEndedAtMilliseconds: 1_200)

    #expect(deleted == ["session-delete"])
    #expect(try await store.loadSessions().map(\.sessionID) == ["session-keep", "session-future-occurrence"])
  }

  @Test("rejects session identifiers that could escape the evidence root")
  func rejectsUnsafeSessionIdentifier() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-meeting-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "../escape",
      platform: .zoom,
      meetingReference: "zoom:test",
      startMode: .manual,
      status: .detected,
      wallClockAnchorMilliseconds: 1,
      monotonicAnchorMilliseconds: 1,
      startedMonotonicMilliseconds: nil,
      endedMonotonicMilliseconds: nil,
      stopReason: nil,
      events: []
    )

    await #expect(throws: MeetingAdapterError.invalidStorageIdentifier("../escape")) {
      try await FileMeetingEvidenceStore(rootDirectory: root).persistSession(session)
    }
  }

  @Test("rejects a chunk whose declared checksum does not match its bytes")
  func rejectsChecksumMismatch() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-meeting-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let metadata = try MeetingAudioChunk(
      chunkID: "session-1:remote:0",
      sessionID: "session-1",
      track: .remote,
      sequence: 0,
      startMonotonicMilliseconds: 100,
      endMonotonicMilliseconds: 1_100,
      checksum: "sha256:wrong",
      byteLength: 5
    )

    await #expect(throws: MeetingAdapterError.chunkConflict("session-1:remote:0")) {
      try await FileMeetingEvidenceStore(rootDirectory: root)
        .persistChunk(try .init(metadata: metadata, bytes: Data("audio".utf8)))
    }
  }

  @Test("persists ACK sidecars so restart replay only loads unacknowledged chunks")
  func persistsAcknowledgementSidecar() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-meeting-ack-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = FileMeetingEvidenceStore(rootDirectory: root)
    let bytes = Data("audio".utf8)
    let chunk = try CapturedAudioChunk(
      metadata: MeetingAudioChunk(
        chunkID: "session-ack:mic:0",
        sessionID: "session-ack",
        track: .mic,
        sequence: 0,
        startMonotonicMilliseconds: 100,
        endMonotonicMilliseconds: 1_100,
        checksum: "sha256:\(SHA256.hash(data: bytes).hexString)",
        byteLength: bytes.count
      ),
      bytes: bytes
    )
    try await store.persistChunk(chunk)
    #expect(try await store.loadPendingChunks(sessionID: "session-ack").count == 1)

    try await store.persistAcknowledgement(.init(
      sessionID: "session-ack",
      track: .mic,
      sequence: 0,
      chunkID: chunk.metadata.chunkID,
      checksum: chunk.metadata.checksum,
      acknowledgedAtMilliseconds: 123
    ))

    #expect(try await store.loadChunks(sessionID: "session-ack").count == 1)
    #expect(try await store.loadPendingChunks(sessionID: "session-ack").isEmpty)
    let acknowledgementURL = root.appendingPathComponent(
      "session-ack/delivery/mic/00000000.ack.json")
    let mode = try FileManager.default.attributesOfItem(
      atPath: acknowledgementURL.path)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o600)
  }
}

private actor CaptureSpy: MeetingAudioCaptureAdapter {
  nonisolated let capabilities = MeetingPlatformCapabilities(
    adapterID: "capture-spy",
    supportedPlatforms: [.googleMeet, .zoom],
    microphoneCaptureAvailable: true,
    applicationAudioScope: .unverified,
    confirmedEndDetectionAvailable: false
  )
  private(set) var startCount = 0
  private(set) var stopCount = 0
  private(set) var pauseCount = 0
  private(set) var resumeCount = 0
  let startResult: AudioCaptureStartResult
  let pauseChunks: [CapturedAudioChunk]
  private var onTrackUnavailable:
    (@Sendable (MeetingAudioTrack, Int64, String) async -> Void)?

  init(startResult: AudioCaptureStartResult, pauseChunks: [CapturedAudioChunk] = []) {
    self.startResult = startResult
    self.pauseChunks = pauseChunks
  }

  func startCapture(
    for session: MeetingSessionState,
    onSealedChunk: @escaping @Sendable (CapturedAudioChunk) async throws -> Void,
    onTrackUnavailable: @escaping @Sendable (MeetingAudioTrack, Int64, String) async -> Void
  ) async throws -> AudioCaptureStartResult {
    startCount += 1
    self.onTrackUnavailable = onTrackUnavailable
    return startResult
  }

  func reportUnavailable(
    track: MeetingAudioTrack,
    atMonotonicMilliseconds: Int64,
    reason: String
  ) async {
    await onTrackUnavailable?(track, atMonotonicMilliseconds, reason)
  }

  func pauseAndSealCapture() async throws -> [CapturedAudioChunk] {
    pauseCount += 1
    return pauseChunks
  }

  func resumeCapture() async throws -> AudioCaptureStartResult {
    resumeCount += 1
    return startResult
  }

  func stopAndSealCapture() async throws -> [CapturedAudioChunk] {
    stopCount += 1
    return []
  }
}

private actor InflightCallbackCaptureSpy: MeetingAudioCaptureAdapter {
  nonisolated let capabilities = MeetingPlatformCapabilities(
    adapterID: "inflight-callback-capture-spy",
    supportedPlatforms: [.googleMeet, .zoom],
    microphoneCaptureAvailable: true,
    applicationAudioScope: .unverified,
    confirmedEndDetectionAvailable: false
  )
  let startResult: AudioCaptureStartResult
  let pauseChunk: CapturedAudioChunk?
  let stopChunk: CapturedAudioChunk?
  private var onSealedChunk: (@Sendable (CapturedAudioChunk) async throws -> Void)?

  init(
    startResult: AudioCaptureStartResult,
    pauseChunk: CapturedAudioChunk? = nil,
    stopChunk: CapturedAudioChunk? = nil
  ) {
    self.startResult = startResult
    self.pauseChunk = pauseChunk
    self.stopChunk = stopChunk
  }

  func startCapture(
    for session: MeetingSessionState,
    onSealedChunk: @escaping @Sendable (CapturedAudioChunk) async throws -> Void,
    onTrackUnavailable: @escaping @Sendable (MeetingAudioTrack, Int64, String) async -> Void
  ) async throws -> AudioCaptureStartResult {
    self.onSealedChunk = onSealedChunk
    return startResult
  }

  func pauseAndSealCapture() async throws -> [CapturedAudioChunk] {
    if let pauseChunk { try await onSealedChunk?(pauseChunk) }
    return []
  }

  func resumeCapture() async throws -> AudioCaptureStartResult { startResult }

  func stopAndSealCapture() async throws -> [CapturedAudioChunk] {
    if let stopChunk { try await onSealedChunk?(stopChunk) }
    return []
  }
}

private actor EvidenceStoreSpy: MeetingEvidenceStore {
  private(set) var sessions: [MeetingSessionState] = []
  private(set) var chunks: [CapturedAudioChunk] = []
  private let recoverableSessions: [MeetingSessionState]

  init(recoverableSessions: [MeetingSessionState] = []) {
    self.recoverableSessions = recoverableSessions
  }

  func persistSession(_ session: MeetingSessionState) async throws {
    sessions.append(session)
  }

  func persistChunk(_ chunk: CapturedAudioChunk) async throws {
    chunks.append(chunk)
  }

  func loadRecoverableSessions() async throws -> [MeetingSessionState] {
    recoverableSessions
  }
}

private enum TestEvidenceStoreError: Error, Equatable {
  case persistFailed
}

private actor FailingEvidenceStore: MeetingEvidenceStore {
  private(set) var sessions: [MeetingSessionState] = []
  private var sessionPersistCallCount = 0
  private let failOnSessionPersistCalls: Set<Int>

  init(failOnSessionPersistCalls: Set<Int>) {
    self.failOnSessionPersistCalls = failOnSessionPersistCalls
  }

  func persistSession(_ session: MeetingSessionState) async throws {
    sessionPersistCallCount += 1
    if failOnSessionPersistCalls.contains(sessionPersistCallCount) {
      throw TestEvidenceStoreError.persistFailed
    }
    sessions.append(session)
  }

  func persistChunk(_ chunk: CapturedAudioChunk) async throws {}

  func loadRecoverableSessions() async throws -> [MeetingSessionState] { [] }
}

private actor StatusSinkSpy: CompanionStatusSink {
  private(set) var values: [CompanionStatusSnapshot] = []

  func publish(_ status: CompanionStatusSnapshot) async {
    values.append(status)
  }
}

private actor RecorderLeaseSpy: MeetingRecorderLeaseCoordinator {
  let disposition: MeetingRecorderLeaseDisposition

  init(disposition: MeetingRecorderLeaseDisposition) {
    self.disposition = disposition
  }

  func claimRecorderLease(
    for meeting: DetectedMeeting,
    sessionID: String
  ) async -> MeetingRecorderLeaseDisposition {
    disposition
  }
}

extension Digest {
  fileprivate var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
