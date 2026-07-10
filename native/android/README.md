# InkSurface Android Host

The Android host is now an InkLoop Paper runtime reuse path for the second product loop. It should load the generated InkSurface WebView bundle from local app assets and connect it to a native Runtime Host through `ink-surface-sdk/native-bridge`.

For the 2026-10 Kickstarter V1, Android/e-paper is not the base delivery promise. The launch demo path is AI Pen + Capture Surface + Web/Desktop Capture Host. Android still matters because it proves local-first runtime storage, WebView packaging, native file access, and future e-paper review/annotation surfaces can share the same event and sidecar contracts.

The native layer owns SAF/file access, secure token storage, asset cache, offline store, network reachability, and background sync. The WebView must be able to open cached documents without network.

The Android shell exposes a read-only `window.InkLoopRuntime.getManifest()` bridge so the packaged `mobile.html` can identify the current local V1 demo loop: Web import -> Paper reading/marking -> Obsidian projection, local-first. Launch readiness gates stay in the project tracker and Obsidian settings boundary panel; the Android reader UI stays clean for the on-device demo instead of showing campaign operations status.

The Android shell also exposes `window.InkLoopLanImport` for local Wi-Fi file transfer into the e-paper reader. When the user opens the mobile file import sheet, the bridge can start a temporary same-LAN upload page, save incoming PDFs/EPUB/Markdown into the app `lan-inbox`, and let `mobile.html` import those files through the same local-first `loadFile` path as `/sdcard` browsing.

On M103-class devices, the Android/Paper shell can also adapt vendor `hqunifiedsocket` stylus strokes into `inkloop.ai_pen.v1` RawPenFrame batches through `window.InkLoopM103RawPenCapture`. This is a device-ingress evidence path for local QA and future prototype logs; it does not by itself prove BLE/firmware readiness, physical Capture Surface calibration, or Kickstarter launch readiness.
