# InkLoop V1 Demo Handoff

Date: 2026-07-03

This handoff is the narrow demo path for the first product loop:

```text
Web import
-> InkLoop Paper reading and marking
-> Obsidian knowledge projection
```

It is intentionally smaller than the Kickstarter launch runbook. Use it when the goal is to show a working V1 loop without presenting supplier, GTM, proof-shot, or launch-readiness operations.

## Demo Scope

The V1 demo should prove these three user-visible jobs:

| Step | Surface | User Job | Pass Signal |
| ---: | --- | --- | --- |
| 1 | Web / desktop | Import or prepare a source document/session where desktop input is convenient | Source content can enter the InkLoop runtime and produce reviewed knowledge outputs |
| 2 | InkLoop Paper / Android | Open the source document, read it, and create marks locally, including same-LAN file import on the reader device | The Android app loads `mobile.html`, supports local file browsing, supports Wi-Fi inbox import, and stays local-first |
| 3 | Obsidian | Receive only reviewed knowledge projections grouped by source file/session | Reading notes, highlights, tasks, decisions, risks, and diagrams render as Markdown projection files with `inkloop://doc/...` backlinks |

## What To Demo First

1. Start the Web AI Pen demo:

```bash
npm run demo:ai-pen
```

Open `http://127.0.0.1:8765/ai-pen-demo.html`.

2. Run the browser smoke when preparing a handoff:

```bash
npm run demo:smoke:ai-pen
```

Expected output:

```text
test-results/ai-pen-browser-smoke/result.json
test-results/ai-pen-browser-smoke/education-projection.png
test-results/ai-pen-browser-smoke/meeting-projection.png
```

3. Generate the Obsidian demo vault:

```bash
npm run obsidian:demo-vault
```

Open these files in the generated vault:

```text
test-results/obsidian-demo-vault/InkLoop/Reading/AI Pen Lesson Demo/AI Pen Lesson Demo.md
test-results/obsidian-demo-vault/InkLoop/Meetings/2026-07-03 AI Pen Meeting Demo/AI Pen Meeting Demo.md
```

4. Build and install the Paper APK when the e-paper device is connected:

```bash
npm run android:assemble:debug
adb install -r examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.inkloop.app/.MainActivity
```

The Paper app should show the clean reader shell. Its Android bridge exposes:

- `window.InkLoopFiles` for local `/sdcard` file browsing.
- `window.InkLoopLanImport` for same-LAN upload into the device inbox.
- `window.InkLoopRuntime.getManifest()` with `Web import -> Paper reading/marking -> Obsidian projection`.

## Acceptance Checklist

| Requirement | Evidence |
| --- | --- |
| Web import and review flow works | `npm run demo:smoke:ai-pen` returns `ok: true` |
| Education output projects to Obsidian | `education-projection.png` and generated Reading vault files exist |
| Meeting output projects to Obsidian | `meeting-projection.png` and generated Meetings vault files exist |
| Dismissed outputs are not promoted | Browser smoke confirms dismissed meeting risk is excluded |
| Obsidian stays projection-only | Generated files include source-unit frontmatter and `inkloop://doc/...` backlinks |
| Paper app is local-first and clean | APK launches `mobile.html`; runtime boundary is hidden from the reader UI |
| Reader-side import is available | Android verifier confirms `InkLoopFiles` and `InkLoopLanImport` paths |
| Runtime sync path exists | `npm run demo:smoke:runtime-sync` returns `ok: true` and `release_path_used=false` |

## Direct Verification Commands

Use these for the V1 demo loop only:

```bash
npm run demo:smoke:ai-pen
npm run demo:smoke:runtime-sync
npm run verify:obsidian-v1-plugin
npm run obsidian:demo-vault
npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets
npm run android:assemble:debug
```

Use the heavier handoff only before an external demo:

```bash
npm run verify:local-demo-handoff
npm run demo:evidence:bundle
```

## Non-Claims

Do not use this V1 demo to claim:

- real AI Pen BLE or firmware ingestion is complete
- physical Capture Surface calibration has passed
- the e-paper tablet is the October 2026 Kickstarter base reward
- Obsidian is the canonical capture source
- arbitrary Obsidian PDF marks or arbitrary Markdown edits are parsed back into canonical InkEvents
- Kickstarter supplier, GTM, follower, page/legal review, proof-shot, or launch-freeze gates are ready

The demo is a product-chain proof. Kickstarter launch readiness still requires the full evidence records and launch gates in `launch-readiness-tracker.md`.
