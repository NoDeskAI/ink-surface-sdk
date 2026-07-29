import AVFoundation
import ApplicationServices
import CoreGraphics
import Foundation

public enum MeetingPermissionStatus: String, Codable, Sendable {
  case notDetermined = "not_determined"
  case granted
  case denied
  case restricted
}

public enum MeetingPermissionKind: String, Codable, CaseIterable, Sendable {
  case microphone
  case screenAndSystemAudio = "screen_and_system_audio"
  case accessibility
}

public struct MeetingPermissionSnapshot: Codable, Equatable, Sendable {
  public let microphone: MeetingPermissionStatus
  public let screenAndSystemAudio: MeetingPermissionStatus
  public let accessibility: MeetingPermissionStatus

  public var recordingReady: Bool {
    microphone == .granted && screenAndSystemAudio == .granted
  }

  /// macOS owns each privacy prompt independently. Requesting all three from
  /// one async task can leave later prompts permanently queued behind the
  /// first TCC sheet, so the first-run UI advances one permission at a time.
  public var nextRequiredPermission: MeetingPermissionKind? {
    if microphone != .granted { return .microphone }
    if screenAndSystemAudio != .granted { return .screenAndSystemAudio }
    if accessibility != .granted { return .accessibility }
    return nil
  }

  public init(
    microphone: MeetingPermissionStatus,
    screenAndSystemAudio: MeetingPermissionStatus,
    accessibility: MeetingPermissionStatus
  ) {
    self.microphone = microphone
    self.screenAndSystemAudio = screenAndSystemAudio
    self.accessibility = accessibility
  }
}

/// TCC permissions are deliberately requested only from the first-run UI.
/// Merely launching the background menu-bar process never prompts the user.
public enum MacOSMeetingPermissionService {
  public static func current() -> MeetingPermissionSnapshot {
    .init(
      microphone: microphoneStatus(),
      screenAndSystemAudio: CGPreflightScreenCaptureAccess() ? .granted : .notDetermined,
      accessibility: AXIsProcessTrusted() ? .granted : .notDetermined
    )
  }

  public static func requestMicrophone() async -> MeetingPermissionStatus {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else {
      return microphoneStatus()
    }
    return await AVCaptureDevice.requestAccess(for: .audio) ? .granted : .denied
  }

  public static func requestScreenAndSystemAudio() -> MeetingPermissionStatus {
    CGRequestScreenCaptureAccess() ? .granted : .denied
  }

  public static func requestAccessibility() -> MeetingPermissionStatus {
    let trusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    return trusted ? .granted : .notDetermined
  }

  private static func microphoneStatus() -> MeetingPermissionStatus {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: .granted
    case .notDetermined: .notDetermined
    case .denied: .denied
    case .restricted: .restricted
    @unknown default: .restricted
    }
  }
}
