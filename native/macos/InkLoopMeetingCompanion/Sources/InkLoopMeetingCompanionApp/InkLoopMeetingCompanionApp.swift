import AppKit
import InkLoopMeetingAdapter
import SwiftUI
import UserNotifications

@MainActor
private final class CompanionAppDelegate: NSObject, NSApplicationDelegate {
  var reopenCompanionWindow: (() -> Void)?

  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    if !flag {
      reopenCompanionWindow?()
    }
    return true
  }
}

@main
struct InkLoopMeetingCompanionApp: App {
  @NSApplicationDelegateAdaptor(CompanionAppDelegate.self) private var appDelegate
  @StateObject private var model = CompanionMenuModel()
  @Environment(\.openWindow) private var openWindow

  init() {
    // Keep both entry points available: a persistent MenuBarExtra for
    // recording controls and a regular Dock app with a reopenable main window.
    NSApplication.shared.setActivationPolicy(.regular)
  }

  var body: some Scene {
    WindowGroup("InkLoop Meeting Companion", id: "companion") {
      CompanionDockView(
        model: model,
        openFirstRun: {
          openWindow(id: "first-run")
          NSApplication.shared.activate(ignoringOtherApps: true)
        }
      )
      .onAppear {
        appDelegate.reopenCompanionWindow = {
          openWindow(id: "companion")
          NSApplication.shared.activate(ignoringOtherApps: true)
        }
      }
    }
    .defaultSize(width: 520, height: 430)

    MenuBarExtra {
      VStack(alignment: .leading, spacing: 12) {
        Label(model.statusTitle, systemImage: model.statusSymbol)
          .font(.headline)

        Text(model.statusDetail)
          .font(.caption)
          .foregroundStyle(.secondary)

        Divider()

        if model.hasActiveRecording {
          HStack {
            Button(model.isActiveRecordingPaused ? "继续" : "暂停") {
              Task { await model.togglePause() }
            }
            Button("停止本场", role: .destructive) {
              Task { await model.stopRecording() }
            }
          }
          Divider()
        } else {
          HStack {
            Button("手动开始 Meet") {
              Task { await model.startRecordingManually(platform: .googleMeet) }
            }
            Button("手动开始 Zoom") {
              Task { await model.startRecordingManually(platform: .zoom) }
            }
          }
          .disabled(!model.permissions.recordingReady)
          Text("自动检测漏报时使用；仍只采集所选目标应用与本机麦克风。")
            .font(.caption2)
            .foregroundStyle(.secondary)
          Divider()
        }

        Toggle("自动记录支持的会议", isOn: $model.automaticallyRecord)
        Text("支持范围：Chrome Google Meet、Zoom macOS")
          .font(.caption2)
          .foregroundStyle(.secondary)

        Divider()

        Button {
          model.openTeacherMonitor()
        } label: {
          Label("打开教师监看（正向）", systemImage: "rectangle.on.rectangle")
        }
        Text("Meet 只会把自己的摄像头预览镜像；远端参会者看到的是正向画面。请用此窗口监看板书，不要翻转 OBS 输出。")
          .font(.caption2)
          .foregroundStyle(.secondary)

        Divider()

        Button {
          NSApplication.shared.sendAction(
            Selector(("showSettingsWindow:")),
            to: nil,
            from: nil
          )
          NSApplication.shared.activate(ignoringOtherApps: true)
        } label: {
          Label("首次设置与权限", systemImage: "gearshape")
        }
        Button("退出 InkLoop Meeting Companion") {
          NSApplication.shared.terminate(nil)
        }
      }
      .padding(14)
      .frame(width: 320)
    } label: {
      Label("InkLoop Meeting Companion", systemImage: model.statusSymbol)
    }
    .menuBarExtraStyle(.window)
    .onChange(of: model.shouldPresentFirstRun) { shouldPresent in
      guard shouldPresent else { return }
      openWindow(id: "first-run")
      NSApplication.shared.activate(ignoringOtherApps: true)
    }

    Window("InkLoop 首次设置", id: "first-run") {
      FirstRunPermissionView(model: model)
    }
    .defaultSize(width: 520, height: 420)

    Settings {
      Form {
        Toggle("自动记录支持的会议", isOn: $model.automaticallyRecord)
        LabeledContent("麦克风权限", value: model.permissionLabel(model.permissions.microphone))
        LabeledContent("目标应用音频", value: model.permissionLabel(model.permissions.screenAndSystemAudio))
        LabeledContent("会议识别权限", value: model.permissionLabel(model.permissions.accessibility))
        Button(model.nextPermissionButtonTitle) { Task { await model.requestNextPermission() } }
          .disabled(model.permissions.nextRequiredPermission == nil || model.isRequestingPermission)
        Button("刷新权限状态") { model.refreshPermissions() }
        Text("录制原始双轨会长期保存在本机；云端只临时处理实时转写所需分片。自动记录开始时会发送通知，菜单栏始终显示状态并可立即停止。请按所在地区和组织要求告知参会人。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(20)
      .frame(width: 460)
      .task { model.prepareFirstRunIfNeeded() }
    }
  }
}

private struct CompanionDockView: View {
  @ObservedObject var model: CompanionMenuModel
  let openFirstRun: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 12) {
        Image(systemName: model.statusSymbol)
          .font(.system(size: 30))
          .foregroundStyle(model.hasActiveRecording ? Color.red : Color.accentColor)
        VStack(alignment: .leading, spacing: 4) {
          Text(model.statusTitle)
            .font(.title2.bold())
          Text(model.statusDetail)
            .foregroundStyle(.secondary)
        }
      }

      Divider()

      if model.hasActiveRecording {
        HStack {
          Button(model.isActiveRecordingPaused ? "继续" : "暂停") {
            Task { await model.togglePause() }
          }
          .buttonStyle(.borderedProminent)
          Button("停止本场", role: .destructive) {
            Task { await model.stopRecording() }
          }
        }
      } else {
        HStack {
          Button("手动开始 Meet") {
            Task { await model.startRecordingManually(platform: .googleMeet) }
          }
          Button("手动开始 Zoom") {
            Task { await model.startRecordingManually(platform: .zoom) }
          }
        }
        .disabled(!model.permissions.recordingReady)
      }

      Toggle("自动记录支持的会议", isOn: $model.automaticallyRecord)

      Grid(alignment: .leading, horizontalSpacing: 22, verticalSpacing: 8) {
        GridRow {
          Text("本机麦克风")
          Text(model.permissionLabel(model.permissions.microphone))
        }
        GridRow {
          Text("目标应用音频")
          Text(model.permissionLabel(model.permissions.screenAndSystemAudio))
        }
        GridRow {
          Text("会议自动识别")
          Text(model.permissionLabel(model.permissions.accessibility))
        }
      }
      .foregroundStyle(.secondary)

      Spacer()

      HStack {
        Button("打开教师监看") { model.openTeacherMonitor() }
        Button("首次设置与权限") { openFirstRun() }
        Button("刷新状态") { model.refreshPermissions() }
      }
    }
    .padding(24)
    .frame(minWidth: 500, minHeight: 400)
  }
}

private struct FirstRunPermissionView: View {
  @ObservedObject var model: CompanionMenuModel

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Label("InkLoop Meeting Companion", systemImage: "waveform.circle.fill")
        .font(.title2.bold())
      Text("只需完成一次授权。之后检测到 Google Meet 时，InkLoop 会自动保存本机麦克风和 Meet 应用音频双轨；菜单栏始终显示录制状态并可立即停止。")
        .foregroundStyle(.secondary)

      Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 12) {
        permissionRow("本机麦克风", model.permissions.microphone, .microphone)
        permissionRow("Meet 应用音频", model.permissions.screenAndSystemAudio, .screenAndSystemAudio)
        permissionRow("会议识别", model.permissions.accessibility, .accessibility)
      }

      Toggle("自动记录支持的会议", isOn: $model.automaticallyRecord)
      HStack {
        Button(model.nextPermissionButtonTitle) { Task { await model.requestNextPermission() } }
          .buttonStyle(.borderedProminent)
          .disabled(model.permissions.nextRequiredPermission == nil || model.isRequestingPermission)
        Button("刷新状态") { model.refreshPermissions() }
        if model.permissions.recordingReady && model.permissions.accessibility == .granted {
          Label("已完成，可关闭此窗口", systemImage: "checkmark.circle.fill")
            .foregroundStyle(.green)
        }
      }
      Text(model.permissionGuidance)
        .font(.caption)
        .foregroundStyle(.secondary)
      Text("原始音频默认保存在本机私有目录；服务端仅接收已封存分片用于实时转写。请按当地法律和组织要求告知参会人。")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(28)
    .frame(minWidth: 500, minHeight: 380)
    .task { model.prepareFirstRunIfNeeded() }
  }

  @ViewBuilder
  private func permissionRow(
    _ title: String,
    _ status: MeetingPermissionStatus,
    _ kind: MeetingPermissionKind
  ) -> some View {
    GridRow {
      Text(title)
      Label(model.permissionLabel(status), systemImage: status == .granted ? "checkmark.circle.fill" : "exclamationmark.circle")
        .foregroundStyle(status == .granted ? .green : .orange)
      if status != .granted {
        Button("打开系统设置") { model.openSystemSettings(for: kind) }
          .buttonStyle(.link)
      }
    }
  }
}

@MainActor
private final class CompanionMenuModel: ObservableObject, CompanionStatusSink {
  @AppStorage("automaticallyRecordSupportedMeetings") var automaticallyRecord = true {
    didSet { Task { await controller.setAutomaticallyRecordSupportedMeetings(automaticallyRecord) } }
  }
  @AppStorage("meetingMediaBaseURL") var meetingMediaBaseURL = "http://127.0.0.1:3000" {
    didSet { scheduleMediaPipelineRefresh() }
  }
  @AppStorage("meetingMediaSessionToken") var meetingMediaSessionToken = "" {
    didSet { scheduleMediaPipelineRefresh() }
  }
  @Published var status = CompanionOperatingState.idle
  @Published var permissions = MacOSMeetingPermissionService.current()
  @Published var latestStatus = CompanionStatusSnapshot(state: .idle)
  @Published var shouldPresentFirstRun = false
  @Published var isRequestingPermission = false

  private let evidenceStore: FileMeetingEvidenceStore
  private var mediaUploader: MeetingMediaUploader?
  private var uploadingStore: UploadingMeetingEvidenceStore?
  private var controller: MeetingSessionController!
  private var mediaPipelineFingerprint = ""
  nonisolated(unsafe) private var defaultsObserver: NSObjectProtocol?

  private func configureMediaPipeline(baseURLString: String, token: String) {
    let uploader = URL(string: baseURLString).flatMap { baseURL in
      token.isEmpty ? nil : MeetingMediaUploader(configuration: .init(
        baseURL: baseURL,
        bearerToken: token,
        deviceID: Self.persistentDeviceID(),
        recorderLeaseRequired: true
      ))
    }
    mediaUploader = uploader
    uploadingStore = uploader.map {
      UploadingMeetingEvidenceStore(local: evidenceStore, uploader: $0)
    }
    let captureAdapter = MacOSDualTrackCaptureAdapter(
      chunkDurationMilliseconds: 5_000,
      realtimeFrameSink: uploader)
    controller = MeetingSessionController(
      configuration: .init(automaticallyRecordSupportedMeetings: automaticallyRecord),
      captureAdapter: captureAdapter,
      evidenceStore: uploadingStore ?? evidenceStore,
      recorderLeaseCoordinator: uploader,
      statusSink: self
    )
    mediaPipelineFingerprint = "\(baseURLString)\u{1f}\(token)"
  }
  private let detector = MacOSMeetingDetectionAdapter()
  private var detectionTask: Task<Void, Never>?
  private var deletionTask: Task<Void, Never>?

  init() {
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("InkLoop/MeetingEvidence", isDirectory: true)
    let store = FileMeetingEvidenceStore(rootDirectory: root)
    evidenceStore = store
    configureMediaPipeline(
      baseURLString: meetingMediaBaseURL,
      token: meetingMediaSessionToken
    )
    defaultsObserver = NotificationCenter.default.addObserver(
      forName: UserDefaults.didChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self else { return }
        let defaults = UserDefaults.standard
        let baseURL = defaults.string(forKey: "meetingMediaBaseURL")
          ?? self.meetingMediaBaseURL
        let token = defaults.string(forKey: "meetingMediaSessionToken") ?? ""
        if self.meetingMediaBaseURL != baseURL {
          self.meetingMediaBaseURL = baseURL
        }
        if self.meetingMediaSessionToken != token {
          self.meetingMediaSessionToken = token
        }
        await self.refreshMediaPipelineIfIdle()
      }
    }
    detectionTask = Task { [weak self] in await self?.bootstrapAndRunDetection() }
    Task { [weak self] in
      await Task.yield()
      guard let self else { return }
      self.shouldPresentFirstRun = !self.permissions.recordingReady || self.permissions.accessibility != .granted
    }
  }

  deinit {
    detectionTask?.cancel()
    deletionTask?.cancel()
    if let defaultsObserver {
      NotificationCenter.default.removeObserver(defaultsObserver)
    }
  }

  private func scheduleMediaPipelineRefresh() {
    Task { [weak self] in
      await self?.refreshMediaPipelineIfIdle()
    }
  }

  private func refreshMediaPipelineIfIdle() async {
    let fingerprint = "\(meetingMediaBaseURL)\u{1f}\(meetingMediaSessionToken)"
    guard fingerprint != mediaPipelineFingerprint else { return }
    if let session = await controller.currentSession(),
      session.status == .recording || session.status == .paused
    {
      latestStatus = .init(
        state: .degraded,
        sessionID: session.sessionID,
        platform: session.platform,
        activeTracks: latestStatus.activeTracks,
        unavailableTracks: latestStatus.unavailableTracks,
        captureActive: latestStatus.captureActive,
        message: "Meeting Media 配置已更新；当前录制结束后自动切换。"
      )
      status = .degraded
      return
    }
    configureMediaPipeline(
      baseURLString: meetingMediaBaseURL,
      token: meetingMediaSessionToken
    )
    await uploadingStore?.resumePendingUploads()
  }

  var statusTitle: String {
    return switch status {
    case .idle: "InkLoop 已待命"
    case .detected: "已检测到会议"
    case .recording: "正在记录"
    case .paused: "记录已暂停"
    case .degraded: "正在降级记录"
    case .sealed: "会议记录已封存"
    case .error: "需要处理"
    }
  }

  var hasActiveRecording: Bool {
    latestStatus.captureActive
  }

  var isActiveRecordingPaused: Bool {
    status == .paused
  }

  var statusDetail: String {
    if let message = latestStatus.message, !message.isEmpty { return message }
    return switch status {
    case .idle:
      permissions.recordingReady && permissions.accessibility == .granted
        ? "已就绪；打开 Meet 或 Zoom 后可自动记录。"
        : "完成首次权限设置后，可自动记录支持的会议。"
    case .detected: "会议已识别，正在准备双轨记录。"
    case .recording: "Mic 与 Remote 原始轨正在本地保存。"
    case .paused: "当前已暂停；已封存的原始事实仍安全保留。"
    case .degraded: "至少一条音频轨不可用；现有事实仍会保存。"
    case .sealed: "已确认会议结束并立即停止。"
    case .error: "打开设置查看权限、磁盘或 Adapter 状态。"
    }
  }

  var statusSymbol: String {
    switch status {
    case .recording: "record.circle.fill"
    case .paused: "pause.circle.fill"
    case .degraded, .error: "exclamationmark.triangle.fill"
    case .sealed: "checkmark.circle.fill"
    case .detected: "waveform.badge.magnifyingglass"
    case .idle: "waveform"
    }
  }

  func publish(_ value: CompanionStatusSnapshot) async {
    latestStatus = value
    status = value.state
    if value.state == .recording {
      let content = UNMutableNotificationContent()
      content.title = "InkLoop 已开始记录"
      content.body = "Mic 与目标会议应用音频正在分轨保存；可从菜单栏暂停或停止。"
      try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "recording-\(value.sessionID ?? UUID().uuidString)", content: content, trigger: nil))
    }
  }

  var nextPermissionButtonTitle: String {
    if isRequestingPermission { return "等待系统确认…" }
    switch permissions.nextRequiredPermission {
    case .microphone: return "允许本机麦克风"
    case .screenAndSystemAudio: return "允许 Meet 应用音频"
    case .accessibility: return "允许自动识别会议"
    case nil: return "录制权限已完成"
    }
  }

  var permissionGuidance: String {
    switch permissions.nextRequiredPermission {
    case .microphone:
      return "下一步：允许麦克风。若系统弹窗未出现，请点本行“打开系统设置”，开启 InkLoop Meeting Companion 后再刷新。"
    case .screenAndSystemAudio:
      return "下一步：允许“录屏与系统录音”。InkLoop 只采集目标会议应用音频，不录制桌面画面。"
    case .accessibility:
      return "最后一步：允许辅助功能，用于识别 Google Meet 是否开始或结束；不会读取会议内容。"
    case nil:
      return "三项权限已就绪，Google Meet 检测到后会自动开始双轨记录。"
    }
  }

  /// Advance exactly one TCC permission per explicit user action. macOS may
  /// defer sheets requested during app launch, and awaiting that sheet would
  /// otherwise prevent screen-capture and Accessibility requests from running.
  func requestNextPermission() async {
    guard !isRequestingPermission, let next = permissions.nextRequiredPermission else { return }
    isRequestingPermission = true
    defer { isRequestingPermission = false }
    // TCC can defer sheets from an LSUIElement/accessory process indefinitely.
    // Temporarily become a foreground app while the explicit first-run action
    // is in flight, then return to menu-bar-only mode when setup is complete.
    NSApplication.shared.setActivationPolicy(.regular)
    NSApplication.shared.activate(ignoringOtherApps: true)
    await Task.yield()
    switch next {
    case .microphone:
      _ = await MacOSMeetingPermissionService.requestMicrophone()
    case .screenAndSystemAudio:
      _ = MacOSMeetingPermissionService.requestScreenAndSystemAudio()
    case .accessibility:
      _ = MacOSMeetingPermissionService.requestAccessibility()
    }
    refreshPermissions()
  }

  func refreshPermissions() {
    permissions = MacOSMeetingPermissionService.current()
    shouldPresentFirstRun = !permissions.recordingReady || permissions.accessibility != .granted
  }

  func prepareFirstRunIfNeeded() {
    // Read-only refresh only. TCC prompts must follow an explicit click so they
    // are never delayed behind the first-run window's launch transaction.
    refreshPermissions()
    if permissions.nextRequiredPermission != nil {
      NSApplication.shared.setActivationPolicy(.regular)
      NSApplication.shared.activate(ignoringOtherApps: true)
    }
  }

  func openSystemSettings(for kind: MeetingPermissionKind) {
    let pane: String
    switch kind {
    case .microphone: pane = "Privacy_Microphone"
    case .screenAndSystemAudio: pane = "Privacy_ScreenCapture"
    case .accessibility: pane = "Privacy_Accessibility"
    }
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
    NSWorkspace.shared.open(url)
  }

  func openTeacherMonitor() {
    let monitorBaseURL = ProcessInfo.processInfo.environment["INKLOOP_LIVE_BOARD_BASE_URL"]
      ?? "http://127.0.0.1:8765"
    guard var components = URLComponents(string: monitorBaseURL) else { return }
    var pathParts = components.path
      .split(separator: "/", omittingEmptySubsequences: true)
      .map(String.init)
    pathParts.append("meeting-live-board.html")
    components.path = "/\(pathParts.joined(separator: "/"))"
    components.queryItems = [
      URLQueryItem(name: "projection", value: "1"),
      URLQueryItem(name: "monitor", value: "1"),
    ]
    guard let url = components.url else { return }
    NSWorkspace.shared.open(url)
  }

  func permissionLabel(_ value: MeetingPermissionStatus) -> String {
    switch value {
    case .granted: "已授权"
    case .notDetermined: "待授权"
    case .denied: "已拒绝"
    case .restricted: "受系统限制"
    }
  }

  func togglePause() async {
    do {
      let now = monotonicMilliseconds()
      if status == .paused { _ = try await controller.resume(atMonotonicMilliseconds: now) }
      else { _ = try await controller.pause(atMonotonicMilliseconds: now) }
    } catch { await showError(error) }
  }

  func stopRecording() async {
    do {
      let sealed = try await controller.stopManually(atMonotonicMilliseconds: monotonicMilliseconds())
      try await finalize(sealed)
      await refreshMediaPipelineIfIdle()
    }
    catch { await showError(error) }
  }

  func startRecordingManually(platform: MeetingPlatform) async {
    guard permissions.recordingReady else {
      await showError(MeetingAdapterError.capturePermissionDenied("meeting_recording"))
      return
    }
    let now = monotonicMilliseconds()
    let provider = platform == .googleMeet ? "google_meet" : "zoom"
    do {
      let meeting = try detector.currentMeetingCandidate(platform: platform, now: now)
        ?? DetectedMeeting(
          platform: platform,
          meetingReference: "\(provider):manual-\(Int64(Date().timeIntervalSince1970 * 1_000))",
          detectionID: "manual-\(UUID().uuidString)",
          detectedAtMonotonicMilliseconds: now
        )
      _ = try await controller.startManually(
        meeting: meeting,
        wallClockAnchorMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000)
      )
    } catch { await showError(error) }
  }

  private func runDetection() async {
    do {
      for try await event in detector.events() {
        switch event {
        case .detected(let meeting):
          do {
            _ = try await controller.handleDetectedMeeting(
              meeting,
              wallClockAnchorMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000)
            )
          } catch MeetingAdapterError.alreadyRecording { /* one recorder at a time */ }
          catch { await showError(error) }
        case .endConfirmed(let meetingReference, let at, let evidence):
          guard await controller.currentSession()?.meetingReference == meetingReference else { continue }
          do {
            let sealed = try await controller.stopForConfirmedEnd(meetingReference: meetingReference, atMonotonicMilliseconds: at, evidence: evidence)
            try await finalize(sealed)
            await refreshMediaPipelineIfIdle()
          }
          catch { await showError(error) }
        }
      }
    } catch { await showError(error) }
  }

  private func bootstrapAndRunDetection() async {
    do { _ = try await uploadingStore?.applyPendingMeetingDeletions() }
    catch { await showError(error) }
    deletionTask = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(30)) }
        catch { return }
        guard let self else { return }
        do { _ = try await self.uploadingStore?.applyPendingMeetingDeletions() }
        catch { await self.showError(error) }
        // Apply privacy commands before considering upload recovery. A meeting
        // that ended while offline then catches up without an app restart;
        // completed sessions carry a receipt and do not reclaim recorder leases.
        await self.uploadingStore?.resumePendingUploads()
      }
    }
    do {
      // A process crash can leave an authoritative local session in
      // detected/recording/paused. Seal that historical boundary before
      // observing new meetings, then replay/finalize it as partial if needed.
      let recovered = try await controller.recoverInterruptedSessions()
      for session in recovered {
        do { try await finalize(session) }
        catch { await showError(error) }
      }
    } catch {
      await showError(error)
    }
    await uploadingStore?.resumePendingUploads()
    do { _ = try await uploadingStore?.applyPendingMeetingDeletions() }
    catch { await showError(error) }
    await runDetection()
  }

  private func showError(_ error: any Error) async {
    latestStatus = .init(
      state: .error,
      sessionID: latestStatus.captureActive ? latestStatus.sessionID : nil,
      platform: latestStatus.captureActive ? latestStatus.platform : nil,
      activeTracks: latestStatus.captureActive ? latestStatus.activeTracks : [],
      unavailableTracks: latestStatus.captureActive ? latestStatus.unavailableTracks : [],
      captureActive: latestStatus.captureActive,
      message: String(describing: error)
    )
    status = .error
  }

  private func finalize(_ session: MeetingSessionState) async throws {
    guard let uploadingStore else { return }
    _ = try await uploadingStore.flushAndFinalizeIfPresent(session)
  }

  private func monotonicMilliseconds() -> Int64 {
    Int64(ProcessInfo.processInfo.systemUptime * 1_000)
  }

  private static func persistentDeviceID() -> String {
    let defaults = UserDefaults.standard
    if let existing = defaults.string(forKey: "meetingRecorderDeviceID"), !existing.isEmpty {
      return existing
    }
    let created = UUID().uuidString.lowercased()
    defaults.set(created, forKey: "meetingRecorderDeviceID")
    return created
  }
}
