import Foundation
import Testing

@testable import InkLoopMeetingAdapter

@Suite("macOS meeting detection")
struct MacOSMeetingDetectionTests {
  @Test("scans deeply enough for current Chrome Meet call controls")
  func scansCurrentChromeMeetHierarchyDepth() {
    // Chrome 138 exposes the Meet web area's leave button at AX depth 20.
    #expect(MacOSAccessibilitySnapshot.maximumControlDepth >= 20)
  }

  @Test("detects only an actual Meet call URL and ignores the landing page")
  func detectsGoogleMeetCall() {
    let classifier = MacOSMeetingWindowClassifier()
    let meetings = classifier.detectedMeetings(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Weekly sync",
        url: "https://meet.google.com/abc-defg-hij?authuser=0",
        callState: .active),
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Google Meet",
        url: "https://meet.google.com/"),
    ], now: 123)

    #expect(meetings.count == 1)
    #expect(meetings.first?.platform == .googleMeet)
    #expect(meetings.first?.meetingReference == "google_meet:abc-defg-hij")
  }

  @Test("does not auto-record when Meet call state is unknown")
  func ignoresUnknownGoogleMeetState() {
    let classifier = MacOSMeetingWindowClassifier()
    let meetings = classifier.detectedMeetings(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Weekly sync",
        url: "https://meet.google.com/abc-defg-hij")
    ], now: 123)

    #expect(meetings.isEmpty)
  }

  @Test("ignores the Meet pre-join page even though it has a meeting code URL")
  func ignoresGoogleMeetPreJoin() {
    let classifier = MacOSMeetingWindowClassifier()
    let meetings = classifier.detectedMeetings(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Ready to join?",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .preJoin),
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Weekly sync",
        url: "https://meet.google.com/xyz-abcd-uvw",
        callState: .active),
    ], now: 123)

    #expect(meetings.map(\.meetingReference) == ["google_meet:xyz-abcd-uvw"])
  }

  @Test("manual fallback reuses the real Meet occurrence instead of fabricating a manual reference")
  func resolvesRealMeetOccurrenceForManualStart() {
    let classifier = MacOSMeetingWindowClassifier()
    let meeting = classifier.manualMeetingCandidate(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Weekly sync",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .unknown),
    ], platform: .googleMeet, now: 123)

    #expect(meeting?.meetingReference == "google_meet:abc-defg-hij")
    #expect(meeting?.detectionID.hasPrefix("detect_") == true)
  }

  @Test("manual fallback never reuses a post-leave Meet occurrence")
  func doesNotResolveEndedMeetForManualStart() {
    let classifier = MacOSMeetingWindowClassifier()
    let meeting = classifier.manualMeetingCandidate(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "You left the meeting",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .ended),
    ], platform: .googleMeet, now: 123)

    #expect(meeting == nil)
  }

  @Test("detects a Zoom call window but not the Zoom home window")
  func detectsZoomMeetingWindow() {
    let classifier = MacOSMeetingWindowClassifier()
    let meetings = classifier.detectedMeetings(in: [
      .init(processIdentifier: 9, bundleIdentifier: "us.zoom.xos", title: "Zoom Workplace"),
      .init(processIdentifier: 9, bundleIdentifier: "us.zoom.xos", title: "Zoom Meeting - Design Review"),
    ], now: 123)

    #expect(meetings.count == 1)
    #expect(meetings.first?.platform == .zoom)
    #expect(meetings.first?.meetingReference.hasPrefix("zoom:") == true)
  }

  @Test("an Accessibility read error and missing window never become meeting-end evidence")
  func readFailureDoesNotEndMeeting() async throws {
    let calls = ScanSequence([
      .success([.init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Meet",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .active)]),
      .failure(TestError.failed),
      .success([]),
      .success([.init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "You left the meeting",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .ended)]),
    ])
    let adapter = MacOSMeetingDetectionAdapter(pollInterval: 0.001) { try calls.next() }
    var iterator = adapter.events().makeAsyncIterator()

    let first = try await iterator.next()
    let second = try await iterator.next()

    guard case .detected = first else { Issue.record("expected detection"); return }
    guard case .endConfirmed = second else { Issue.record("expected confirmed end"); return }
    #expect(calls.callCount == 4)
  }

  @Test("an unknown Meet control state never counts as confirmed absence")
  func unknownMeetStateDoesNotEndMeeting() async throws {
    let active = MeetingWindowSnapshot(
      processIdentifier: 1,
      bundleIdentifier: "com.google.Chrome",
      title: "Meet",
      url: "https://meet.google.com/abc-defg-hij",
      callState: .active)
    let unknown = MeetingWindowSnapshot(
      processIdentifier: 1,
      bundleIdentifier: "com.google.Chrome",
      title: "Meet",
      url: "https://meet.google.com/abc-defg-hij",
      callState: .unknown)
    let calls = ScanSequence([
      .success([active]),
      .success([unknown]),
      .success([unknown]),
      .success([]),
      .success([.init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "You left the meeting",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .ended)]),
    ])
    let adapter = MacOSMeetingDetectionAdapter(pollInterval: 0.001) { try calls.next() }
    var iterator = adapter.events().makeAsyncIterator()

    let first = try await iterator.next()
    let second = try await iterator.next()

    guard case .detected = first else { Issue.record("expected detection"); return }
    guard case .endConfirmed = second else { Issue.record("expected confirmed end"); return }
    #expect(calls.callCount == 5)
  }

  @Test("only an explicit post-leave Meet state confirms the occurrence ended")
  func classifiesExplicitMeetEnd() {
    let classifier = MacOSMeetingWindowClassifier()
    let reference = "google_meet:abc-defg-hij"
    #expect(classifier.confirmedEndedMeetingReferences(in: []).isEmpty)
    #expect(classifier.confirmedEndedMeetingReferences(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "Meet in background",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .unknown),
    ]).isEmpty)
    #expect(classifier.confirmedEndedMeetingReferences(in: [
      .init(
        processIdentifier: 1,
        bundleIdentifier: "com.google.Chrome",
        title: "You left the meeting",
        url: "https://meet.google.com/abc-defg-hij",
        callState: .ended),
    ]) == [reference])
  }
}

private enum TestError: Error { case failed }

private final class ScanSequence: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Result<[MeetingWindowSnapshot], any Error>]
  private(set) var callCount = 0

  init(_ values: [Result<[MeetingWindowSnapshot], any Error>]) { self.values = values }

  func next() throws -> [MeetingWindowSnapshot] {
    lock.lock()
    defer { lock.unlock() }
    callCount += 1
    return try values.removeFirst().get()
  }
}
