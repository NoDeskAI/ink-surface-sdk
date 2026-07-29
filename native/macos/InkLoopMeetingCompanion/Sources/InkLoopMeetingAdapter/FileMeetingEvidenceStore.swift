import CryptoKit
import Foundation

public actor FileMeetingEvidenceStore: MeetingEvidenceStore {
  public let rootDirectory: URL
  private let encoder: JSONEncoder

  public init(rootDirectory: URL) {
    self.rootDirectory = rootDirectory
    self.encoder = JSONEncoder()
    self.encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  }

  public func persistSession(_ session: MeetingSessionState) async throws {
    let directory = try sessionDirectory(session.sessionID)
    try createPrivateDirectory(directory)
    let data = try encoder.encode(session)
    let sessionURL = directory.appendingPathComponent("session.json")
    try data.write(to: sessionURL, options: [.atomic])
    try setPrivateFilePermissions(sessionURL)
    if session.status == .sealed {
      let manifest = try SealedMeetingSequenceManifest(sealedSession: session)
      let manifestURL = directory.appendingPathComponent("sequence-manifest.json")
      try encoder.encode(manifest).write(to: manifestURL, options: [.atomic])
      try setPrivateFilePermissions(manifestURL)
    }
  }

  public func persistChunk(_ chunk: CapturedAudioChunk) async throws {
    let actualChecksum = "sha256:\(SHA256.hash(data: chunk.bytes).hexString)"
    guard actualChecksum == chunk.metadata.checksum else {
      throw MeetingAdapterError.chunkConflict(chunk.metadata.chunkID)
    }

    let trackDirectory = try sessionDirectory(chunk.metadata.sessionID)
      .appendingPathComponent("raw", isDirectory: true)
      .appendingPathComponent(chunk.metadata.track.rawValue, isDirectory: true)
    try createPrivateDirectory(trackDirectory)

    let audioURL = trackDirectory.appendingPathComponent(
      String(format: "%08d.audio", chunk.metadata.sequence))
    let metadataURL = trackDirectory.appendingPathComponent(
      String(format: "%08d.json", chunk.metadata.sequence))
    let audioExists = FileManager.default.fileExists(atPath: audioURL.path)
    let metadataExists = FileManager.default.fileExists(atPath: metadataURL.path)
    if audioExists, try Data(contentsOf: audioURL) != chunk.bytes {
      throw MeetingAdapterError.chunkConflict(chunk.metadata.chunkID)
    }
    if metadataExists {
      let existingMetadata = try JSONDecoder().decode(
        MeetingAudioChunk.self, from: Data(contentsOf: metadataURL))
      guard existingMetadata == chunk.metadata else {
        throw MeetingAdapterError.chunkConflict(chunk.metadata.chunkID)
      }
    }
    if audioExists, metadataExists {
      return
    }

    if !audioExists {
      try chunk.bytes.write(to: audioURL, options: [.atomic])
      try setPrivateFilePermissions(audioURL)
    }
    do {
      if !metadataExists {
        try encoder.encode(chunk.metadata).write(to: metadataURL, options: [.atomic])
        try setPrivateFilePermissions(metadataURL)
      }
    } catch {
      if !audioExists {
        try? FileManager.default.removeItem(at: audioURL)
      }
      throw error
    }
  }

  public func loadRecoverableSessions() async throws -> [MeetingSessionState] {
    try await loadSessions().filter { $0.status != .sealed }
  }

  public func loadSessions() async throws -> [MeetingSessionState] {
    guard FileManager.default.fileExists(atPath: rootDirectory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(
      at: rootDirectory, includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ).compactMap { directory in
      let sessionURL = directory.appendingPathComponent("session.json")
      guard FileManager.default.fileExists(atPath: sessionURL.path),
        let session = try? JSONDecoder().decode(
          MeetingSessionState.self, from: Data(contentsOf: sessionURL))
      else { return nil }
      return session
    }.sorted { $0.wallClockAnchorMilliseconds < $1.wallClockAnchorMilliseconds }
  }

  /// Apply a Hub-issued whole-meeting deletion command to the authoritative
  /// local evidence store. Active sessions are never removed: the server also
  /// refuses to issue a command while a registered session is active.
  public func deleteSealedSessions(
    meetingReferences: Set<String>,
    occurrenceStartedAtMilliseconds: Int64? = nil,
    occurrenceEndedAtMilliseconds: Int64? = nil
  ) async throws -> [String] {
    guard !meetingReferences.isEmpty else { return [] }
    let sessions = try await loadSessions()
    var deleted: [String] = []
    for session in sessions where meetingReferences.contains(session.meetingReference)
      && sessionMatchesDeletionOccurrence(
        session,
        startedAtMilliseconds: occurrenceStartedAtMilliseconds,
        endedAtMilliseconds: occurrenceEndedAtMilliseconds)
    {
      guard session.status == .sealed else {
        throw MeetingAdapterError.sessionNotSealed
      }
      try FileManager.default.removeItem(at: sessionDirectory(session.sessionID))
      deleted.append(session.sessionID)
    }
    return deleted.sorted()
  }

  private func sessionMatchesDeletionOccurrence(
    _ session: MeetingSessionState,
    startedAtMilliseconds: Int64?,
    endedAtMilliseconds: Int64?
  ) -> Bool {
    let tolerance: Int64 = 6 * 60 * 60 * 1_000
    let sessionStart = session.startedMonotonicMilliseconds.map {
      session.wallClockAnchorMilliseconds + ($0 - session.monotonicAnchorMilliseconds)
    }
    if let requested = startedAtMilliseconds, let candidate = sessionStart {
      return abs(requested - candidate) <= tolerance
    }
    let sessionEnd = session.endedMonotonicMilliseconds.map {
      session.wallClockAnchorMilliseconds + ($0 - session.monotonicAnchorMilliseconds)
    }
    if let requested = endedAtMilliseconds, let candidate = sessionEnd {
      return abs(requested - candidate) <= tolerance
    }
    return true
  }

  public func loadPendingChunks(sessionID: String) async throws -> [CapturedAudioChunk] {
    try await loadChunks(sessionID: sessionID).filter { chunk in
      let acknowledgementURL = try acknowledgementPath(for: chunk.metadata)
      guard FileManager.default.fileExists(atPath: acknowledgementURL.path),
        let acknowledgement = try? JSONDecoder().decode(
          MeetingMediaChunkAcknowledgement.self,
          from: Data(contentsOf: acknowledgementURL)
        )
      else { return true }
      return acknowledgement.sessionID != chunk.metadata.sessionID
        || acknowledgement.track != chunk.metadata.track
        || acknowledgement.sequence != chunk.metadata.sequence
        || acknowledgement.chunkID != chunk.metadata.chunkID
        || acknowledgement.checksum != chunk.metadata.checksum
    }
  }

  public func loadChunks(sessionID: String) async throws -> [CapturedAudioChunk] {
    let sessionDirectory = try sessionDirectory(sessionID)
    return try MeetingAudioTrack.allCases.flatMap { track -> [CapturedAudioChunk] in
      let trackDirectory = sessionDirectory.appendingPathComponent("raw/\(track.rawValue)")
      guard FileManager.default.fileExists(atPath: trackDirectory.path) else { return [] }
      return try FileManager.default.contentsOfDirectory(
        at: trackDirectory, includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
      ).filter { $0.pathExtension == "json" }.compactMap { metadataURL in
        let metadata = try JSONDecoder().decode(MeetingAudioChunk.self, from: Data(contentsOf: metadataURL))
        let audioURL = metadataURL.deletingPathExtension().appendingPathExtension("audio")
        guard FileManager.default.fileExists(atPath: audioURL.path) else { return nil }
        return try CapturedAudioChunk(metadata: metadata, bytes: Data(contentsOf: audioURL))
      }
    }.sorted {
      if $0.metadata.track != $1.metadata.track {
        return $0.metadata.track.rawValue < $1.metadata.track.rawValue
      }
      return $0.metadata.sequence < $1.metadata.sequence
    }
  }

  public func persistAcknowledgement(
    _ acknowledgement: MeetingMediaChunkAcknowledgement
  ) async throws {
    let chunks = try await loadChunks(sessionID: acknowledgement.sessionID)
    guard let chunk = chunks.first(where: {
      $0.metadata.track == acknowledgement.track
        && $0.metadata.sequence == acknowledgement.sequence
    }),
      chunk.metadata.chunkID == acknowledgement.chunkID,
      chunk.metadata.checksum == acknowledgement.checksum
    else { throw MeetingAdapterError.invalidAcknowledgement }
    let path = try acknowledgementPath(for: chunk.metadata)
    try createPrivateDirectory(path.deletingLastPathComponent())
    try encoder.encode(acknowledgement).write(to: path, options: [.atomic])
    try setPrivateFilePermissions(path)
  }

  public func persistFinalizationReceipt(
    _ receipt: MeetingMediaFinalizeResponse,
    sessionID: String
  ) async throws {
    let directory = try sessionDirectory(sessionID)
    try createPrivateDirectory(directory)
    let path = directory.appendingPathComponent("formalization-receipt.json")
    try encoder.encode(receipt).write(to: path, options: [.atomic])
    try setPrivateFilePermissions(path)
  }

  public func loadFinalizationReceipt(
    sessionID: String
  ) async throws -> MeetingMediaFinalizeResponse? {
    let path = try sessionDirectory(sessionID)
      .appendingPathComponent("formalization-receipt.json")
    guard FileManager.default.fileExists(atPath: path.path) else { return nil }
    return try JSONDecoder().decode(
      MeetingMediaFinalizeResponse.self,
      from: Data(contentsOf: path)
    )
  }

  private func sessionDirectory(_ sessionID: String) throws -> URL {
    guard sessionID.range(of: #"^[A-Za-z0-9._-]{1,160}$"#, options: .regularExpression) != nil,
      sessionID != ".", sessionID != ".."
    else { throw MeetingAdapterError.invalidStorageIdentifier(sessionID) }
    return rootDirectory.appendingPathComponent(sessionID, isDirectory: true)
  }

  private func acknowledgementPath(for chunk: MeetingAudioChunk) throws -> URL {
    try sessionDirectory(chunk.sessionID)
      .appendingPathComponent("delivery", isDirectory: true)
      .appendingPathComponent(chunk.track.rawValue, isDirectory: true)
      .appendingPathComponent(String(format: "%08d.ack.json", chunk.sequence))
  }

  private func createPrivateDirectory(_ directory: URL) throws {
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    var cursor = directory
    while cursor.path.hasPrefix(rootDirectory.path), cursor.path.count >= rootDirectory.path.count {
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cursor.path)
      if cursor.standardizedFileURL == rootDirectory.standardizedFileURL { break }
      cursor.deleteLastPathComponent()
    }
  }

  private func setPrivateFilePermissions(_ url: URL) throws {
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
}

extension Digest {
  fileprivate var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
