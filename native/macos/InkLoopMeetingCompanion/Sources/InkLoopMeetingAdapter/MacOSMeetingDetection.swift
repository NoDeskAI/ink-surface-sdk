@preconcurrency import ApplicationServices
import AppKit
import CryptoKit
import Foundation

public enum MeetingWindowCallState: String, Equatable, Sendable {
  case active
  case preJoin = "pre_join"
  case ended
  case unknown
}

public struct MeetingWindowSnapshot: Equatable, Sendable {
  public let processIdentifier: pid_t
  public let bundleIdentifier: String
  public let title: String
  public let url: String?
  public let callState: MeetingWindowCallState

  public init(
    processIdentifier: pid_t,
    bundleIdentifier: String,
    title: String,
    url: String? = nil,
    callState: MeetingWindowCallState = .unknown
  ) {
    self.processIdentifier = processIdentifier
    self.bundleIdentifier = bundleIdentifier
    self.title = title
    self.url = url
    self.callState = callState
  }
}

public struct MacOSMeetingWindowClassifier: Sendable {
  public init() {}

  public func detectedMeetings(in windows: [MeetingWindowSnapshot], now: Int64) -> [DetectedMeeting] {
    var result: [String: DetectedMeeting] = [:]
    for window in windows {
      // A valid Meet URL is also present on the pre-join lobby. Automatic
      // recording requires positive in-call evidence; unknown AX state falls
      // back to the explicit menu-bar start action instead of risking a lobby
      // microphone recording.
      if window.callState == .active, let code = googleMeetCode(window.url) {
        let reference = "google_meet:\(code)"
        result[reference] = DetectedMeeting(
          platform: .googleMeet,
          meetingReference: reference,
          detectionID: stableDetectionID(reference),
          detectedAtMonotonicMilliseconds: now
        )
        continue
      }
      if isZoomMeetingWindow(window) {
        let identity = "\(window.processIdentifier):\(window.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
        let reference = "zoom:\(SHA256.hash(data: Data(identity.utf8)).hexString.prefix(20))"
        result[reference] = DetectedMeeting(
          platform: .zoom,
          meetingReference: reference,
          detectionID: stableDetectionID(reference),
          detectedAtMonotonicMilliseconds: now
        )
      }
    }
    return result.values.sorted { $0.meetingReference < $1.meetingReference }
  }

  public func indeterminateMeetingReferences(in windows: [MeetingWindowSnapshot]) -> Set<String> {
    Set(windows.compactMap { window in
      guard window.bundleIdentifier == "com.google.Chrome",
        window.callState == .unknown,
        let code = googleMeetCode(window.url)
      else { return nil }
      return "google_meet:\(code)"
    })
  }

  public func confirmedEndedMeetingReferences(in windows: [MeetingWindowSnapshot]) -> Set<String> {
    Set(windows.compactMap { window in
      guard window.bundleIdentifier == "com.google.Chrome",
        window.callState == .ended,
        let code = googleMeetCode(window.url)
      else { return nil }
      return "google_meet:\(code)"
    })
  }

  /// The explicit menu action is the fallback when Accessibility cannot prove
  /// active-call state. Reuse the provider occurrence visible in the current
  /// window so recorder leases, confirmed-end signals, and postprocessing all
  /// stay on one identity. A post-leave window is never a start candidate.
  public func manualMeetingCandidate(
    in windows: [MeetingWindowSnapshot],
    platform: MeetingPlatform,
    now: Int64
  ) -> DetectedMeeting? {
    switch platform {
    case .googleMeet:
      let references = Set(windows.compactMap { window -> String? in
        guard window.bundleIdentifier == "com.google.Chrome",
          window.callState != .ended,
          let code = googleMeetCode(window.url)
        else { return nil }
        return "google_meet:\(code)"
      })
      guard references.count == 1, let reference = references.first else { return nil }
      return DetectedMeeting(
        platform: .googleMeet,
        meetingReference: reference,
        detectionID: stableDetectionID(reference),
        detectedAtMonotonicMilliseconds: now
      )
    case .zoom:
      return detectedMeetings(in: windows, now: now).first { $0.platform == .zoom }
    }
  }

  private func googleMeetCode(_ rawURL: String?) -> String? {
    guard let rawURL, let components = URLComponents(string: rawURL),
      components.host?.lowercased() == "meet.google.com"
    else { return nil }
    let first = components.path.split(separator: "/").first.map(String.init) ?? ""
    guard first.range(of: #"^[a-z]{3}-[a-z]{4}-[a-z]{3}$"#, options: .regularExpression) != nil
    else { return nil }
    return first
  }

  private func isZoomMeetingWindow(_ window: MeetingWindowSnapshot) -> Bool {
    let bundle = window.bundleIdentifier.lowercased()
    guard bundle == "us.zoom.xos" || bundle == "us.zoom.xos.helper" else { return false }
    let title = window.title.lowercased()
    let weakTitles: Set<String> = ["zoom", "zoom workplace", "settings", "preferences"]
    if title.isEmpty || weakTitles.contains(title) { return false }
    return title.contains("zoom meeting") || title.contains("zoom webinar")
      || title.contains("meeting controls") || title.contains("会议") || title.contains("研讨会")
  }

  private func stableDetectionID(_ reference: String) -> String {
    "detect_\(SHA256.hash(data: Data(reference.utf8)).hexString.prefix(24))"
  }
}

/// Polls trusted Accessibility state. A missing/background window is unknown,
/// not meeting-end evidence. End is emitted only when the same Meet occurrence
/// exposes an explicit post-leave control state.
public final class MacOSMeetingDetectionAdapter: MeetingDetectionAdapter, @unchecked Sendable {
  public let capabilities = MeetingPlatformCapabilities(
    adapterID: "macos_accessibility_meeting_detector.v1",
    supportedPlatforms: [.googleMeet, .zoom],
    microphoneCaptureAvailable: true,
    applicationAudioScope: .targetApplication,
    confirmedEndDetectionAvailable: true
  )

  private let pollNanoseconds: UInt64
  private let snapshot: @Sendable () throws -> [MeetingWindowSnapshot]
  private let classifier = MacOSMeetingWindowClassifier()

  public init(
    pollInterval: TimeInterval = 1.0,
    snapshot: @escaping @Sendable () throws -> [MeetingWindowSnapshot] = MacOSAccessibilitySnapshot.capture
  ) {
    pollNanoseconds = UInt64(max(0.2, pollInterval) * 1_000_000_000)
    self.snapshot = snapshot
  }

  public func currentMeetingCandidate(
    platform: MeetingPlatform,
    now: Int64
  ) throws -> DetectedMeeting? {
    classifier.manualMeetingCandidate(in: try snapshot(), platform: platform, now: now)
  }

  public func events() -> AsyncThrowingStream<MeetingDetectionEvent, any Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        var active: [String: DetectedMeeting] = [:]
        while !Task.isCancelled {
          do {
            let now = Self.monotonicMilliseconds()
            let windows = try snapshot()
            let current = Dictionary(
              uniqueKeysWithValues: classifier.detectedMeetings(in: windows, now: now)
                .map { ($0.meetingReference, $0) })
            let ended = classifier.confirmedEndedMeetingReferences(in: windows)
            for (reference, meeting) in current where active[reference] == nil {
              active[reference] = meeting
              continuation.yield(.detected(meeting))
            }
            for reference in active.keys where ended.contains(reference) {
              let evidence = try ConfirmedMeetingEndEvidence(
                validatingAdapter: capabilities.adapterID,
                signal: "user_left_meeting",
                observedAtWallClockMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000)
              )
              continuation.yield(
                .endConfirmed(
                  meetingReference: reference,
                  atMonotonicMilliseconds: now,
                  evidence: evidence
                ))
              active.removeValue(forKey: reference)
            }
          } catch {
            // Permission loss or an AX read failure is an unknown state, not
            // evidence that a meeting ended. Keep polling without yielding end.
          }
          try await Task.sleep(nanoseconds: pollNanoseconds)
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  private static func monotonicMilliseconds() -> Int64 {
    Int64(ProcessInfo.processInfo.systemUptime * 1_000)
  }
}

public enum MacOSAccessibilitySnapshot {
  /// Chrome 138 nests Meet controls inside its browser chrome and AX web area
  /// at depth 20. Keep the traversal bounded, but deep enough to reach the
  /// explicit join/leave controls that make automatic recording safe.
  public static let maximumControlDepth = 24

  public static func capture() throws -> [MeetingWindowSnapshot] {
    guard AXIsProcessTrusted() else {
      throw MeetingAdapterError.capturePermissionDenied("accessibility")
    }
    return NSWorkspace.shared.runningApplications.flatMap { application -> [MeetingWindowSnapshot] in
      guard let bundle = application.bundleIdentifier,
        bundle == "com.google.Chrome" || bundle == "us.zoom.xos"
      else { return [] }
      return windows(for: application.processIdentifier, bundleIdentifier: bundle)
    }
  }

  private static func windows(for pid: pid_t, bundleIdentifier: String) -> [MeetingWindowSnapshot] {
    let application = AXUIElementCreateApplication(pid)
    guard let windows = attributeElements(application, kAXWindowsAttribute as String) else { return [] }
    return windows.map { window in
      MeetingWindowSnapshot(
        processIdentifier: pid,
        bundleIdentifier: bundleIdentifier,
        title: attributeString(window, kAXTitleAttribute as String) ?? "",
        url: firstURL(in: window),
        callState: callState(in: window, bundleIdentifier: bundleIdentifier)
      )
    }
  }

  private static func firstURL(in root: AXUIElement) -> String? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    while !queue.isEmpty, visited < 500 {
      let (element, depth) = queue.removeFirst()
      visited += 1
      if let url = attributeString(element, kAXURLAttribute as String), !url.isEmpty { return url }
      guard depth < maximumControlDepth,
        let children = attributeElements(element, kAXChildrenAttribute as String)
      else {
        continue
      }
      queue.append(contentsOf: children.map { ($0, depth + 1) })
    }
    return nil
  }

  /// Only inspect button/control labels needed to distinguish the Meet lobby
  /// from an active call. Meeting chat, captions, documents, and free-form
  /// content are deliberately outside this detector's data boundary.
  private static func callState(
    in root: AXUIElement,
    bundleIdentifier: String
  ) -> MeetingWindowCallState {
    guard bundleIdentifier == "com.google.Chrome" else { return .unknown }
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    var sawPreJoinControl = false
    while !queue.isEmpty, visited < 500 {
      let (element, depth) = queue.removeFirst()
      visited += 1
      let role = attributeString(element, kAXRoleAttribute as String) ?? ""
      if role == (kAXButtonRole as String) {
        let label = [
          attributeString(element, kAXTitleAttribute as String),
          attributeString(element, kAXDescriptionAttribute as String),
          attributeString(element, kAXHelpAttribute as String),
        ].compactMap { $0 }.joined(separator: " ").lowercased()
        if matchesAny(label, [
          "leave call", "leave meeting", "离开通话", "离开会议", "退出通话", "退出会议",
        ]) { return .active }
        if matchesAny(label, [
          "join now", "ask to join", "立即加入", "请求加入", "加入会议", "准备好加入",
        ]) { sawPreJoinControl = true }
        if matchesAny(label, [
          "rejoin", "return to home screen", "重新加入", "返回主屏幕", "返回首页",
        ]) { return .ended }
      }
      guard depth < maximumControlDepth,
        let children = attributeElements(element, kAXChildrenAttribute as String)
      else { continue }
      queue.append(contentsOf: children.map { ($0, depth + 1) })
    }
    return sawPreJoinControl ? .preJoin : .unknown
  }

  private static func matchesAny(_ value: String, _ needles: [String]) -> Bool {
    needles.contains(where: value.contains)
  }

  private static func attributeString(_ element: AXUIElement, _ name: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
      return nil
    }
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    return nil
  }

  private static func attributeElements(_ element: AXUIElement, _ name: String) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
      return nil
    }
    return value as? [AXUIElement]
  }
}

extension Digest {
  fileprivate var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
