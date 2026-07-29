# InkLoop Meeting Companion for macOS

This package is the native macOS boundary for InkLoop's owned meeting evidence chain. The reusable meeting lifecycle remains in `packages/meeting-media-core`; this package owns macOS detection, permissions, capture, local evidence storage, and persistent recording status.

## Current implementation

- A Swift contract mirroring the v1 meeting-session and audio-chunk JSON contracts.
- A platform adapter protocol for meeting detection and Mic/Remote capture.
- An actor-based session controller with automatic/manual start and immediate stop on confirmed meeting-end evidence.
- Atomic local writes for immutable audio chunks, recoverable session state, and a sealed per-track sequence manifest consumed by formal convergence.
- Startup recovery that seals a process-interrupted session at its last durable event, preserves the distinct `interrupted_session_recovered` reason, and resumes idempotent upload/formalization without fabricating a platform meeting-end signal.
- Explicit degraded status when only one audio track is available.
- A menu-bar shell for persistent recording visibility and the one-time auto-record preference.
- Explicit manual Google Meet / Zoom start actions that reuse the same fact chain when automatic Accessibility detection misses a meeting.
- Tenant/meeting-occurrence recorder ownership: one authenticated device holds a renewable lease, competing Companion instances remain idle, and an unavailable lease service degrades to local-only evidence instead of discarding facts or creating duplicate cloud transcripts.

The package now includes production-shaped adapters for Chrome Meet/Zoom detection, target-application Remote audio through ScreenCaptureKit, an independent microphone track, five-second immutable 16 kHz mono PCM16 chunks, pause/resume, authenticated chunk upload, and private local evidence storage. This reduces the structural first-provisional wait and lowers a 45-minute dual-track raw session from roughly 1.93 GiB (48 kHz stereo Float32) to about 165 MiB before filesystem overhead. Detection and capture are implemented but remain **unverified for release** until the four real-device 45-minute matrix runs are complete. Chrome capture is application-scoped, not single-tab scoped.

The current `.macOS(.v13)` declaration is a provisional compile floor because `MenuBarExtra` requires macOS 13. Unit 0 must freeze the shipped minimum version after ScreenCaptureKit, permission, signing, and Meet/Zoom compatibility tests.

## Verify

```bash
cd native/macos/InkLoopMeetingCompanion
swift test
swift build
```

Real-device results and the required 45-minute Meet/Zoom matrix are tracked in `docs/reviews/meeting-media-phase0-evaluation.md`.

Build a runnable locally signed app bundle with:

```bash
./scripts/build-app.sh
open ".build/app/debug/InkLoop Meeting Companion.app"
```

The build includes microphone and screen-capture usage descriptions. The script prefers the stable `AhaKey Local Dev` identity when it is installed, and falls back to ad-hoc signing only when no local identity is available. Neither development path replaces Developer ID signing and notarization for distribution.

The first-run window never requests privacy access during app launch. Each explicit click advances one macOS TCC permission (microphone, target-app system audio, then Accessibility), and every row includes a direct recovery link to the matching Privacy & Security pane. The bundle launches as a foreground-capable app because macOS defers TCC sheets from an `LSUIElement` process; while setup is incomplete it uses the regular activation policy, then returns to menu-bar-only accessory mode after all permissions are ready. This avoids a deferred microphone sheet blocking every later permission request.

The audio callback path is ordered and drainable. Pause/stop first stops the
hardware producers, waits for every callback that already entered the process,
then returns pending and tail chunks to the session controller for durable
storage. A failed evidence-store callback keeps the immutable sealed chunk in
memory for retry; it is never silently discarded while the UI continues to
claim that recording succeeded.

On relaunch, any session still marked `detected`, `recording`, or `paused` is
sealed before new meeting detection starts. Its already-written raw chunks
remain authoritative; missing tracks or the interrupted tail are represented
as a partial formal transcript rather than leaving the meeting permanently
stuck in a live state. A session interrupted before its first durable audio
chunk is registered as sealed for lifecycle accuracy but deliberately skips
ASR/formalization, so it cannot create an empty meeting summary.

After a real recording, generate the read-only acceptance report from the demo
workspace:

```bash
npm run accept:real-meeting-media -- --session latest
```

The report checks local/server sequence parity, both tracks, ACKs, ASR queue
drain, transcript text, formal/partial state, and confirmed-end stop evidence.

For the Google Meet interview projection, start the Live Board dev server and
run the one-shot Camera Adapter launcher from the demo workspace:

```bash
npm run launch:obs-interview-camera
```

The launcher preserves the user's original OBS WebSocket configuration, uses
an authenticated IPv4-localhost control endpoint with a random password only
while creating the `InkLoop Interview` scene, restores the original settings,
then relaunches OBS with the persisted scene and virtual camera. The Browser
Source renders Board, transcript, and status; OBS's native macOS camera source
owns the physical camera PiP, so Meet and the Browser Source do not compete for
that device. A successful machine report requires both the native camera video
and OBS virtual-camera output to be active. The first real run still requires
macOS Camera permission and approval of the official OBS Camera Extension.

For local development, start the configured ingress after the ASR Provider is
listening on `127.0.0.1:8081`:

```bash
cd examples/ai-annotation-demo
npm run serve:meeting-media
```

This command enables the local Companion device identity, reads or creates a
private 256-bit token under `.inkloop/meeting-validation/`, and configures the
default `ggml-large-v3-turbo-q5_0` Chinese Provider. The model name is request
metadata; the local
`whisper-server` must be started with the matching model file.
Override the `INKLOOP_STREAMING_ASR_*` variables to test another Provider.
Verify the complete real HTTP protocol without changing existing meeting data:

```bash
npm run smoke:meeting-media-http
```

The smoke creates isolated temporary Media/Postprocess roots, acquires a
recorder lease, uploads real 16 kHz mono PCM16 Mandarin audio on both tracks,
checks durable ACK, ASR, formal convergence, lease release, and raw-media
deletion, then removes the temporary state.
