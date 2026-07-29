import CryptoKit
import Foundation
import Testing

@testable import InkLoopMeetingAdapter

@Suite("meeting media uploader", .serialized)
struct MeetingMediaUploaderTests {
  @Test("rejects detected-only sessions before issuing a registration request")
  func rejectsDetectedRegistration() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    nonisolated(unsafe) var requests = 0
    protocolClass.handler = { request in
      requests += 1
      return (
        HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!,
        Data()
      )
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!,
        bearerToken: "token"
      ),
      session: urlSession
    )
    let state = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "detected-session",
      platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic,
      status: .detected,
      wallClockAnchorMilliseconds: 1_000,
      monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: nil,
      endedMonotonicMilliseconds: nil,
      stopReason: nil,
      events: []
    )

    await #expect(throws: MeetingMediaUploadError.invalidSessionScope) {
      _ = try await uploader.register(state)
    }
    #expect(requests == 0)
  }

  @Test("bounds realtime projection backlog per session track")
  func boundsRealtimeProjectionBacklog() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    protocolClass.handler = { request in
      Thread.sleep(forTimeInterval: 0.05)
      return (
        HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!,
        Data("{\"accepted\":true,\"utterances\":[]}".utf8)
      )
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!,
        bearerToken: "token"
      ),
      session: urlSession
    )
    for sequence in 0..<20 {
      let frame = CapturedRealtimeAudioFrame(
        metadata: try MeetingRealtimeAudioFrame(
          frameID: "session-1:mic:frame:\(sequence)",
          sessionID: "session-1",
          track: .mic,
          frameSequence: sequence,
          sourceChunkID: "session-1:mic:\(sequence / 5)",
          startMonotonicMilliseconds: Int64(sequence * 100),
          endMonotonicMilliseconds: Int64((sequence + 1) * 100),
          speechPresent: true
        ),
        bytes: Data(repeating: 1, count: 3_200)
      )
      await uploader.enqueueRealtimeFrame(frame)
    }

    #expect(await uploader.pendingRealtimeFrameCountForTesting(
      sessionID: "session-1",
      track: .mic
    ) <= 8)
    await uploader.waitForRealtimeFramesForTesting(
      sessionID: "session-1",
      track: .mic
    )
  }

  @Test("claims recorder ownership and attaches it to scope and chunk uploads")
  func claimsAndAttachesRecorderLease() async throws {
    let chunk = try fixture()
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let lock = NSLock()
    nonisolated(unsafe) var paths: [String] = []
    protocolClass.handler = { request in
      lock.lock()
      paths.append(request.url?.path ?? "")
      lock.unlock()
      let path = request.url?.path ?? ""
      if path.hasSuffix("/recorder-lease/acquire") {
        let payload = try JSONDecoder().decode(RecorderLeasePayload.self, from: #require(requestBody(request)))
        #expect(payload.meetingReference == "google_meet:abc-defg-hij")
        #expect(payload.sessionID == "session-1")
        #expect(payload.deviceID == "device-a")
        let body = "{\"granted\":true,\"meeting_ref\":\"google_meet:abc-defg-hij\",\"owner_session_id\":\"session-1\",\"owner_device_id\":\"device-a\",\"expires_at_ms\":31000,\"retry_after_ms\":30000,\"lease_token\":\"lease-token\"}"
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
      }
      if path == "/api/meeting-media/sessions" {
        let payload = try JSONDecoder().decode(OwnedSessionScopePayload.self, from: #require(requestBody(request)))
        #expect(payload.recorderDeviceID == "device-a")
        #expect(payload.recorderLeaseToken == "lease-token")
        let body = "{\"session_id\":\"session-1\",\"meeting_doc_id\":\"mtgdoc_abc\",\"status\":\"recording\"}"
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
      }
      let payload = try JSONDecoder().decode(OwnedChunkPayload.self, from: #require(requestBody(request)))
      #expect(payload.meetingReference == "google_meet:abc-defg-hij")
      #expect(payload.recorderDeviceID == "device-a")
      #expect(payload.recorderLeaseToken == "lease-token")
      let body = "{\"acknowledgement\":{\"session_id\":\"session-1\",\"track\":\"mic\",\"sequence\":0,\"chunk_id\":\"session-1:mic:0\",\"checksum\":\"\(chunk.metadata.checksum)\",\"acknowledged_at_ms\":123}}"
      return (HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token",
        deviceID: "device-a", recorderLeaseRequired: true),
      session: urlSession)
    let meeting = DetectedMeeting(
      platform: .googleMeet, meetingReference: "google_meet:abc-defg-hij",
      detectionID: "detect", detectedAtMonotonicMilliseconds: 100)
    let session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-1", platform: .googleMeet,
      meetingReference: meeting.meetingReference, startMode: .automatic, status: .recording,
      wallClockAnchorMilliseconds: 1_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: nil,
      stopReason: nil, events: [])

    #expect(await uploader.claimRecorderLease(for: meeting, sessionID: "session-1") == .granted)
    _ = try await uploader.register(session)
    _ = try await uploader.upload(chunk)

    #expect(paths == [
      "/api/meeting-media/recorder-lease/acquire", "/api/meeting-media/sessions",
      "/api/meeting-media/chunks",
    ])
  }

  @Test("reports a competing recorder without retaining its lease token")
  func reportsCompetingRecorder() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    protocolClass.handler = { request in
      let body = "{\"granted\":false,\"meeting_ref\":\"zoom:123\",\"owner_session_id\":\"other-session\",\"owner_device_id\":\"other-device\",\"expires_at_ms\":31000,\"retry_after_ms\":30000}"
      return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token",
        deviceID: "device-a", recorderLeaseRequired: true),
      session: urlSession)
    let meeting = DetectedMeeting(
      platform: .zoom, meetingReference: "zoom:123", detectionID: "detect",
      detectedAtMonotonicMilliseconds: 100)

    #expect(await uploader.claimRecorderLease(for: meeting, sessionID: "session-1")
      == .heldByAnotherDevice(ownerDeviceID: "other-device"))
    await #expect(throws: MeetingMediaUploadError.recorderLeaseRequired) {
      try await uploader.upload(fixture())
    }
  }

  @Test("renews recorder ownership even while a meeting is silent")
  func renewsSilentMeetingLease() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let lock = NSLock()
    nonisolated(unsafe) var renewalCount = 0
    protocolClass.handler = { request in
      let path = request.url?.path ?? ""
      if path.hasSuffix("/recorder-lease/renew") {
        lock.lock()
        renewalCount += 1
        lock.unlock()
      }
      let body = "{\"granted\":true,\"meeting_ref\":\"zoom:123\",\"owner_session_id\":\"session-1\",\"owner_device_id\":\"device-a\",\"expires_at_ms\":31000,\"retry_after_ms\":30000,\"lease_token\":\"lease-token\"}"
      return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token",
        deviceID: "device-a", recorderLeaseRequired: true,
        recorderLeaseRenewalInterval: .milliseconds(10)),
      session: urlSession)
    let meeting = DetectedMeeting(
      platform: .zoom, meetingReference: "zoom:123", detectionID: "detect",
      detectedAtMonotonicMilliseconds: 100)

    #expect(await uploader.claimRecorderLease(for: meeting, sessionID: "session-1") == .granted)
    try await Task.sleep(for: .milliseconds(50))
    let observed = lock.withLock { renewalCount }
    #expect(observed > 0)
    await uploader.relinquishRecorderLease(sessionID: "session-1")
  }

  @Test("relinquishes ownership and stops renewal after terminal local capture")
  func relinquishesRecorderLease() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let lock = NSLock()
    nonisolated(unsafe) var paths: [String] = []
    protocolClass.handler = { request in
      let path = request.url?.path ?? ""
      lock.withLock { paths.append(path) }
      if path.hasSuffix("/recorder-lease/release") {
        // A real network release yields the uploader actor. Keep this request
        // open beyond one renewal interval so the test proves terminal local
        // capture cancels renewal before starting best-effort HTTP release.
        Thread.sleep(forTimeInterval: 0.03)
      }
      let body = "{\"granted\":true,\"meeting_ref\":\"zoom:123\",\"owner_session_id\":\"session-1\",\"owner_device_id\":\"device-a\",\"expires_at_ms\":31000,\"retry_after_ms\":30000,\"lease_token\":\"lease-token\"}"
      return (HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
        Data(body.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token",
        deviceID: "device-a", recorderLeaseRequired: true,
        recorderLeaseRenewalInterval: .milliseconds(10)),
      session: urlSession)
    let meeting = DetectedMeeting(
      platform: .zoom, meetingReference: "zoom:123", detectionID: "detect",
      detectedAtMonotonicMilliseconds: 100)

    #expect(await uploader.claimRecorderLease(for: meeting, sessionID: "session-1") == .granted)
    await uploader.relinquishRecorderLease(sessionID: "session-1")
    try await Task.sleep(for: .milliseconds(40))

    let observed = lock.withLock { paths }
    #expect(observed == [
      "/api/meeting-media/recorder-lease/acquire",
      "/api/meeting-media/recorder-lease/release",
    ])
  }

  @Test("accepts only an ACK matching the immutable chunk identity")
  func validatesAcknowledgement() async throws {
    let chunk = try fixture()
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    protocolClass.handler = { request in
      #expect(request.value(forHTTPHeaderField: "authorization") == "Bearer session-token")
      let body: Data
      if let direct = request.httpBody { body = direct }
      else if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var value = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          guard count > 0 else { break }
          value.append(buffer, count: count)
        }
        body = value
      } else { body = Data() }
      #expect(!body.isEmpty)
      #expect(String(data: body, encoding: .utf8)?.contains("audio_base64") == true)
      let response = HTTPURLResponse(
        url: try #require(request.url), statusCode: 202,
        httpVersion: nil, headerFields: ["content-type": "application/json"])!
      let json = "{\"acknowledgement\":{\"session_id\":\"session-1\",\"track\":\"mic\",\"sequence\":0,\"chunk_id\":\"session-1:mic:0\",\"checksum\":\"\(chunk.metadata.checksum)\",\"acknowledged_at_ms\":123}}"
      return (response, Data(json.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(baseURL: URL(string: "https://inkloop.test")!, bearerToken: "session-token"),
      session: urlSession
    )

    let ack = try await uploader.upload(chunk)

    #expect(ack.chunkID == chunk.metadata.chunkID)
    #expect(ack.acknowledgedAtMilliseconds == 123)
  }

  @Test("uploads the durable fact chunk while realtime projection is still pending")
  func durableFactDoesNotWaitForRealtimeProjection() async throws {
    let chunk = try fixture()
    let protocolClass = AsyncUploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let lock = NSLock()
    nonisolated(unsafe) var pendingRealtime: AsyncUploadURLProtocol?
    nonisolated(unsafe) var factObservedWhileRealtimePending = false
    protocolClass.handler = { transport, request in
      if request.url?.path == "/api/meeting-media/realtime-frames" {
        lock.withLock { pendingRealtime = transport }
        return
      }
      if request.url?.path == "/api/meeting-media/chunks" {
        lock.withLock { factObservedWhileRealtimePending = pendingRealtime != nil }
        let json = "{\"acknowledgement\":{\"session_id\":\"session-1\",\"track\":\"mic\",\"sequence\":0,\"chunk_id\":\"session-1:mic:0\",\"checksum\":\"\(chunk.metadata.checksum)\",\"acknowledged_at_ms\":123}}"
        transport.complete(
          HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!,
          data: Data(json.utf8))
        return
      }
      transport.complete(
        HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!,
        data: Data())
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
      session: urlSession)
    let frame = CapturedRealtimeAudioFrame(
      metadata: try MeetingRealtimeAudioFrame(
        frameID: "session-1:mic:frame:0",
        sessionID: "session-1",
        track: .mic,
        frameSequence: 0,
        sourceChunkID: "session-1:mic:0",
        startMonotonicMilliseconds: 0,
        endMonotonicMilliseconds: 100,
        speechPresent: true
      ),
      bytes: Data(repeating: 1, count: 3_200))

    await uploader.enqueueRealtimeFrame(frame)
    for _ in 0..<1_000 {
      if lock.withLock({ pendingRealtime != nil }) { break }
      await Task.yield()
    }
    #expect(lock.withLock { pendingRealtime != nil })
    _ = try await uploader.upload(chunk)

    #expect(lock.withLock { factObservedWhileRealtimePending })
    let realtime = lock.withLock { pendingRealtime }
    realtime?.complete(
      HTTPURLResponse(
        url: try #require(realtime?.request.url),
        statusCode: 202,
        httpVersion: nil,
        headerFields: nil
      )!,
      data: Data("{\"accepted\":true,\"utterances\":[]}".utf8)
    )
    await uploader.waitForRealtimeFramesForTesting(sessionID: "session-1", track: .mic)
  }

  @Test("uploads continuous microphone PCM without client-side speech clipping or gain")
  func preservesContinuousMicrophoneProjection() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let sourceBytes = Data((0..<3_200).map { UInt8($0 % 251) })
    let lock = NSLock()
    nonisolated(unsafe) var observed: RealtimeFramePayload?
    protocolClass.handler = { request in
      if request.url?.path == "/api/meeting-media/realtime-frames" {
        let payload = try JSONDecoder().decode(
          RealtimeFramePayload.self, from: #require(requestBody(request)))
        lock.withLock { observed = payload }
        return (
          HTTPURLResponse(
            url: request.url!, statusCode: 202, httpVersion: nil,
            headerFields: nil)!,
          Data("{\"accepted\":true,\"utterances\":[]}".utf8))
      }
      return (
        HTTPURLResponse(
          url: request.url!, statusCode: 500, httpVersion: nil,
          headerFields: nil)!,
        Data())
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
      session: urlSession)
    let frame = CapturedRealtimeAudioFrame(
      metadata: try MeetingRealtimeAudioFrame(
        frameID: "session-1:mic:frame:0",
        sessionID: "session-1",
        track: .mic,
        frameSequence: 0,
        sourceChunkID: "session-1:mic:0",
        startMonotonicMilliseconds: 0,
        endMonotonicMilliseconds: 100
      ),
      bytes: sourceBytes)

    await uploader.enqueueRealtimeFrame(frame)
    try await Task.sleep(for: .milliseconds(100))

    let payload = try #require(lock.withLock { observed })
    #expect(payload.frame.speechPresent == nil)
    #expect(Data(base64Encoded: payload.audioBase64) == sourceBytes)
  }

  @Test("finalize submits the sealed sequence manifest only after chunks can be acknowledged")
  func finalizesSealedManifest() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    protocolClass.handler = { request in
      let body = try #require(requestBody(request))
      let payload = try JSONDecoder().decode(FinalizePayload.self, from: body)
      #expect(payload.expectedTracks == ["mic", "remote"])
      #expect(payload.expectedLastSequence == ["mic": 0])
      #expect(payload.knownMissingChunkIDs == ["track_unavailable:remote:1500"])
      #expect(payload.providerMeetingID == "zoom:meeting")
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (response, Data("{\"replay\":false,\"artifact\":{\"finality\":\"partial\",\"missing_chunk_ids\":[\"missing_track:remote\"]}}".utf8))
    }
    let uploader = MeetingMediaUploader(configuration: .init(baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"), session: urlSession)
    let session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-1", platform: .zoom,
      meetingReference: "zoom:meeting", startMode: .automatic, status: .sealed,
      wallClockAnchorMilliseconds: 1_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: 2_100,
      stopReason: .manual,
      events: [.init(
        eventID: "event-1", type: .audioChunkSealed, atMonotonicMilliseconds: 2_000,
        evidence: nil,
        chunkReference: .init(chunkID: "session-1:mic:0", track: .mic, sequence: 0, checksum: "sha256:test"),
        stopReason: nil), .init(
          eventID: "event-2", type: .audioTrackUnavailable,
          atMonotonicMilliseconds: 1_500, evidence: nil, chunkReference: nil,
          stopReason: nil, track: .remote,
          unavailabilityReason: "screen_capture_stream_stopped")]
    )

    let result = try await uploader.finalize(session)

    #expect(result.artifact.finality == "partial")
    #expect(result.artifact.missingChunkIDs == ["missing_track:remote"])
  }

  @Test("registers the active meeting scope before media chunks arrive")
  func registersSessionScope() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    protocolClass.handler = { request in
      #expect(request.url?.path == "/api/meeting-media/sessions")
      let body = try #require(requestBody(request))
      let payload = try JSONDecoder().decode(SessionScopePayload.self, from: body)
      #expect(payload.sessionID == "session-1")
      #expect(payload.meetingReference == "google_meet:abc-defg-hij")
      #expect(payload.status == "recording")
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["content-type": "application/json"])!
      let json = "{\"schema_version\":\"inkloop.meeting_media_session_scope.v1\",\"session_id\":\"session-1\",\"platform\":\"google_meet\",\"meeting_ref\":\"google_meet:abc-defg-hij\",\"meeting_doc_id\":\"mtgdoc_abc-defg-hij\",\"status\":\"recording\",\"updated_at_ms\":123}"
      return (response, Data(json.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
      session: urlSession)
    let session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-1", platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij", startMode: .automatic, status: .recording,
      wallClockAnchorMilliseconds: 1_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: nil,
      stopReason: nil, events: [])

    let registered = try await uploader.register(session)

    #expect(registered.meetingDocumentID == "mtgdoc_abc-defg-hij")
    #expect(registered.status == "recording")
  }

  @Test("does not re-register the session for every sealed audio chunk")
  func avoidsPerChunkSessionRegistration() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-registration-frequency-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let lock = NSLock()
    nonisolated(unsafe) var sessionRegistrations = 0
    protocolClass.handler = { request in
      if request.url?.path == "/api/meeting-media/sessions" {
        lock.withLock { sessionRegistrations += 1 }
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["content-type": "application/json"])!
      let body = "{\"session_id\":\"session-1\",\"meeting_doc_id\":\"mtgdoc_abc\",\"status\":\"recording\"}"
      return (response, Data(body.utf8))
    }
    let store = UploadingMeetingEvidenceStore(
      local: FileMeetingEvidenceStore(rootDirectory: root),
      uploader: MeetingMediaUploader(
        configuration: .init(
          baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
        session: urlSession)
    )
    let base = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion, sessionID: "session-1", platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij", startMode: .automatic, status: .recording,
      wallClockAnchorMilliseconds: 1_000, monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100, endedMonotonicMilliseconds: nil,
      stopReason: nil, events: [.init(
        eventID: "started", type: .recordingStarted, atMonotonicMilliseconds: 100,
        evidence: nil, chunkReference: nil, stopReason: nil)])
    try await store.persistSession(base)
    try await Task.sleep(for: .milliseconds(10))
    var withChunk = base
    withChunk.events.append(.init(
      eventID: "chunk", type: .audioChunkSealed, atMonotonicMilliseconds: 1_000,
      evidence: nil,
      chunkReference: .init(
        chunkID: "session-1:mic:0", track: .mic, sequence: 0, checksum: "sha256:test"),
      stopReason: nil))
    try await store.persistSession(withChunk)
    try await Task.sleep(for: .milliseconds(10))

    #expect(lock.withLock { sessionRegistrations } == 1)
  }

  @Test("does not formalize a recovered session with no durable audio chunks")
  func skipsEmptyRecoveredSession() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-empty-recovery-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let local = FileMeetingEvidenceStore(rootDirectory: root)
    let session = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "session-empty",
      platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic,
      status: .sealed,
      wallClockAnchorMilliseconds: 1_000,
      monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100,
      endedMonotonicMilliseconds: 100,
      stopReason: .interruptedSessionRecovered,
      events: []
    )
    try await local.persistSession(session)
    let lock = NSLock()
    nonisolated(unsafe) var paths: [String] = []
    protocolClass.handler = { request in
      lock.lock()
      paths.append(request.url?.path ?? "")
      lock.unlock()
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["content-type": "application/json"])!
      let body = "{\"schema_version\":\"inkloop.meeting_media_session_scope.v1\",\"session_id\":\"session-empty\",\"platform\":\"google_meet\",\"meeting_ref\":\"google_meet:abc-defg-hij\",\"meeting_doc_id\":\"mtgdoc_abc-defg-hij\",\"status\":\"sealed\",\"updated_at_ms\":123}"
      return (response, Data(body.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
      session: urlSession)
    let store = UploadingMeetingEvidenceStore(local: local, uploader: uploader)

    let result = try await store.flushAndFinalizeIfPresent(session)

    #expect(result == nil)
    #expect(paths == ["/api/meeting-media/sessions"])
  }

  @Test("upload recovery releases an empty sealed session instead of renewing it forever")
  func releasesEmptySealedSessionDuringRecovery() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-empty-lease-recovery-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let local = FileMeetingEvidenceStore(rootDirectory: root)
    let sealed = MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "session-empty",
      platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic,
      status: .sealed,
      wallClockAnchorMilliseconds: 1_000,
      monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: nil,
      endedMonotonicMilliseconds: 100,
      stopReason: .interruptedSessionRecovered,
      events: [])
    try await local.persistSession(sealed)
    let lock = NSLock()
    nonisolated(unsafe) var paths: [String] = []
    protocolClass.handler = { request in
      lock.withLock { paths.append(request.url?.path ?? "") }
      let path = request.url?.path ?? ""
      if path.hasSuffix("/recorder-lease/acquire") {
        let body = "{\"granted\":true,\"meeting_ref\":\"google_meet:abc-defg-hij\",\"owner_session_id\":\"session-empty\",\"owner_device_id\":\"device-a\",\"expires_at_ms\":31000,\"retry_after_ms\":30000,\"lease_token\":\"lease-token\"}"
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
      }
      if path.hasSuffix("/recorder-lease/release") {
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{\"released\":true}".utf8))
      }
      let body = "{\"session_id\":\"session-empty\",\"meeting_doc_id\":\"mtgdoc_abc\",\"status\":\"sealed\"}"
      return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token",
        deviceID: "device-a", recorderLeaseRequired: true),
      session: urlSession)
    let meeting = DetectedMeeting(
      platform: .googleMeet, meetingReference: sealed.meetingReference,
      detectionID: "recover", detectedAtMonotonicMilliseconds: 100)
    #expect(await uploader.claimRecorderLease(for: meeting, sessionID: sealed.sessionID) == .granted)
    let store = UploadingMeetingEvidenceStore(local: local, uploader: uploader)

    await store.resumePendingUploads()
    try await Task.sleep(for: .milliseconds(10))

    #expect(paths == [
      "/api/meeting-media/recorder-lease/acquire",
      "/api/meeting-media/sessions",
      "/api/meeting-media/sessions",
      "/api/meeting-media/recorder-lease/release",
    ])
  }

  @Test("durably records ACKs and does not replay the same chunk after restart")
  func persistsAcknowledgementAcrossRestart() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-ack-restart-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let local = FileMeetingEvidenceStore(rootDirectory: root)
    let chunk = try fixture()
    let lock = NSLock()
    nonisolated(unsafe) var chunkUploads = 0
    protocolClass.handler = { request in
      if request.url?.path == "/api/meeting-media/chunks" {
        lock.lock()
        chunkUploads += 1
        lock.unlock()
        let response = HTTPURLResponse(
          url: request.url!, statusCode: 202, httpVersion: nil,
          headerFields: ["content-type": "application/json"])!
        let json = "{\"acknowledgement\":{\"session_id\":\"session-1\",\"track\":\"mic\",\"sequence\":0,\"chunk_id\":\"session-1:mic:0\",\"checksum\":\"\(chunk.metadata.checksum)\",\"acknowledged_at_ms\":123}}"
        return (response, Data(json.utf8))
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["content-type": "application/json"])!
      return (response, Data("{}".utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
      session: urlSession)
    let firstStore = UploadingMeetingEvidenceStore(local: local, uploader: uploader)

    try await firstStore.persistChunk(chunk)
    for _ in 0..<100 where try await !local.loadPendingChunks(sessionID: "session-1").isEmpty {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(try await local.loadPendingChunks(sessionID: "session-1").isEmpty)

    let restartedStore = UploadingMeetingEvidenceStore(
      local: local,
      uploader: MeetingMediaUploader(
        configuration: .init(baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token"),
        session: urlSession)
    )
    await restartedStore.resumePendingUploads()

    #expect(chunkUploads == 1)
  }

  @Test("applies Hub meeting deletion commands to local sealed evidence and acknowledges them")
  func appliesMeetingDeletionCommands() async throws {
    let protocolClass = UploadURLProtocol.self
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    let urlSession = URLSession(configuration: configuration)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("inkloop-command-delete-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let local = FileMeetingEvidenceStore(rootDirectory: root)
    try await local.persistSession(MeetingSessionState(
      schemaVersion: meetingSessionSchemaVersion,
      sessionID: "session-delete",
      platform: .googleMeet,
      meetingReference: "google_meet:abc-defg-hij",
      startMode: .automatic,
      status: .sealed,
      wallClockAnchorMilliseconds: 1_000,
      monotonicAnchorMilliseconds: 100,
      startedMonotonicMilliseconds: 100,
      endedMonotonicMilliseconds: 200,
      stopReason: .manual,
      events: []
    ))
    let lock = NSLock()
    nonisolated(unsafe) var acknowledgementBody = Data()
    protocolClass.handler = { request in
      if request.url?.path == "/api/meeting-media/deletion-commands" {
        #expect(request.url?.query?.contains("device_id=device-a") == true)
        #expect(request.url?.query?.contains("meeting_ref=google_meet:abc-defg-hij") == true)
        #expect(request.url?.query?.contains("meeting_started_at_ms=1000") == true)
        let body = #"{"commands":[{"command_id":"meeting_delete_1","meeting_doc_id":"mtgdoc_abc-defg-hij","meeting_refs":["google_meet:abc-defg-hij"],"requested_at_ms":123,"occurrence_started_at_ms":1100,"occurrence_ended_at_ms":1200}]}"#
        return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(body.utf8))
      }
      lock.lock()
      acknowledgementBody = try #require(requestBody(request))
      lock.unlock()
      return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
    }
    let uploader = MeetingMediaUploader(
      configuration: .init(
        baseURL: URL(string: "https://inkloop.test")!, bearerToken: "token",
        deviceID: "device-a"),
      session: urlSession)
    let store = UploadingMeetingEvidenceStore(local: local, uploader: uploader)

    #expect(try await store.applyPendingMeetingDeletions() == 1)
    #expect(try await local.loadSessions().isEmpty)
    let acknowledgement = try JSONSerialization.jsonObject(with: acknowledgementBody) as? [String: Any]
    #expect(acknowledgement?["command_id"] as? String == "meeting_delete_1")
    #expect(acknowledgement?["device_id"] as? String == "device-a")
    #expect(acknowledgement?["deleted_session_ids"] as? [String] == ["session-delete"])
  }

  private func fixture() throws -> CapturedAudioChunk {
    let bytes = Data("audio".utf8)
    return try CapturedAudioChunk(
      metadata: MeetingAudioChunk(
        chunkID: "session-1:mic:0",
        sessionID: "session-1",
        track: .mic,
        sequence: 0,
        startMonotonicMilliseconds: 1,
        endMonotonicMilliseconds: 2,
        checksum: "sha256:\(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())",
        byteLength: bytes.count
      ),
      bytes: bytes
    )
  }
}

private struct FinalizePayload: Decodable {
  let expectedTracks: [String]
  let expectedLastSequence: [String: Int]
  let knownMissingChunkIDs: [String]
  let providerMeetingID: String

  enum CodingKeys: String, CodingKey {
    case expectedTracks = "expected_tracks"
    case expectedLastSequence = "expected_last_sequence"
    case knownMissingChunkIDs = "known_missing_chunk_ids"
    case providerMeetingID = "provider_meeting_id"
  }
}

private struct SessionScopePayload: Decodable {
  let sessionID: String
  let meetingReference: String
  let status: String

  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case meetingReference = "meeting_ref"
    case status
  }
}

private struct RecorderLeasePayload: Decodable {
  let meetingReference: String
  let sessionID: String
  let deviceID: String
  enum CodingKeys: String, CodingKey {
    case meetingReference = "meeting_ref"
    case sessionID = "session_id"
    case deviceID = "device_id"
  }
}

private struct OwnedSessionScopePayload: Decodable {
  let recorderDeviceID: String
  let recorderLeaseToken: String
  enum CodingKeys: String, CodingKey {
    case recorderDeviceID = "recorder_device_id"
    case recorderLeaseToken = "recorder_lease_token"
  }
}

private struct OwnedChunkPayload: Decodable {
  let meetingReference: String
  let recorderDeviceID: String
  let recorderLeaseToken: String
  enum CodingKeys: String, CodingKey {
    case meetingReference = "meeting_ref"
    case recorderDeviceID = "recorder_device_id"
    case recorderLeaseToken = "recorder_lease_token"
  }
}

private struct RealtimeFramePayload: Decodable {
  let frame: MeetingRealtimeAudioFrame
  let audioBase64: String

  enum CodingKeys: String, CodingKey {
    case frame
    case audioBase64 = "audio_base64"
  }
}

private func requestBody(_ request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return nil }
  stream.open()
  defer { stream.close() }
  var value = Data()
  var buffer = [UInt8](repeating: 0, count: 4_096)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    guard count > 0 else { break }
    value.append(buffer, count: count)
  }
  return value
}

private final class UploadURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let (response, data) = try Self.handler!(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private final class AsyncUploadURLProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var handler:
    ((AsyncUploadURLProtocol, URLRequest) -> Void)?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.unknown))
      return
    }
    handler(self, request)
  }

  func complete(_ response: HTTPURLResponse, data: Data) {
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
