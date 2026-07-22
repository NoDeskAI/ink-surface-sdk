# Education Classroom Validation Runbook

## Evidence tracks

Keep these tracks separate in every acceptance report:

1. Browser simulation: iPad/desktop pointer input through the LAN classroom host to browser SVG render. Gate: P50 ≤ 150 ms and P95 ≤ 300 ms.
2. E-paper Student Viewer: explicitly open `student-classroom.html`; record stream buffering, full/partial refresh, flicker, ghosting and human usability. Do not apply the browser latency gate.
3. Real AI: run the gateway acceptance script and manually review usefulness and every source jump. Deterministic fallback is reliability evidence only.
4. Physical AI Pen/Capture Surface: separate hardware evidence; the browser simulation does not prove physical pen latency.

## Browser and local service

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:education-classroom-browser
npm --workspace ./examples/ai-annotation-demo run evidence:education-classroom-latency -- test-results/education-classroom-latency.csv --out test-results/education-classroom-latency-report.json
```

The smoke uses one teacher and three isolated student browser profiles. It verifies one clipped teaching viewport with no nested textbook scroll, world-only new strokes, per-page cameras and ledgers, transient/durable teacher views, follow/free-browse/return, visible-path culling, late join, legacy normalized projection, world and legacy source navigation, current/missed/selected actions, whole-class post-class practice, correction staleness, service restart, participant/job/signal isolation, zero student media capture, teacher review recovery, raw-audio deletion and classroom deletion.

### Trusted HTTPS audio entry

Audio acceptance must use the same trusted HTTPS origin for the launcher, teacher/student HTML, classroom API, SSE and WebRTC signaling:

```bash
npm --workspace ./examples/ai-annotation-demo run serve:classroom:https
```

The default launcher is `https://localhost:8872/classroom`; the command also prints current LAN URLs. On first use, import the printed `.inkloop/classroom-cert/classroom.cert.pem` into macOS Keychain Access and set it to **Always Trust**, then fully restart the teacher and student browsers. If `8871/8872` are occupied, override both ports, for example `PORT=18731 INKLOOP_HTTPS_PORT=18732 npm ... run serve:classroom:https`.

Acceptance checks:

1. Teacher clicks “开始录制并直播声音” before any microphone prompt appears.
2. Student clicks “开启课堂声音”; the student browser must show zero microphone and camera permission requests.
3. Teacher speaks for at least 6 seconds. Student hears only the teacher track, while teacher status reports saved PCM chunks.
4. Stop audio and confirm the final sub-two-second tail is flushed; no pending upload is finalized silently as healthy.
5. Restart during an active recording and confirm it restores as `interrupted / incomplete` exactly once.
6. Delete the ended classroom and confirm stored PCM plus ephemeral signaling are no longer accessible.

### Live transcript and correction

Configure a loopback transcription provider before starting the HTTPS classroom:

```bash
INKLOOP_CLASSROOM_TRANSCRIPTION_URL=http://127.0.0.1:8178/v1/transcribe \
INKLOOP_CLASSROOM_TRANSCRIPTION_MODE=local \
npm --workspace ./examples/ai-annotation-demo run serve:classroom:https
```

Use `examples/ai-annotation-demo/fixtures/education-completing-square-audio.wav` or read the same script aloud. Acceptance checks:

1. Final subtitles include “移项”“两边加四”“完全平方”“正负三”“一或者负五” in recording-relative order; final subtitle P95 is at most 5 seconds.
2. A low-confidence “正三” segment is visually marked. After class, the teacher corrects it to “正负三”; the corrected revision replaces the projection while the original final revision remains auditable.
3. Block student audio playback while leaving transcription available: the student mode becomes `subtitles_only`. Stop the provider: the mode becomes `textbook_board_only`, with textbook and board still usable.
4. The student browser never requests microphone/camera permission and cannot call the correction API.
5. Restart after a failed provider call and retry from durable PCM. Then delete raw audio and confirm subtitles/corrections remain readable with `audio_available=false`.
6. External mode requires HTTPS, server opt-in and the teacher’s per-recording checkbox. No API key, bearer token, nickname, PCM or transcript text may appear in logs or error responses.

`http://localhost:8765` remains the board/textbook development entry. It must disable teacher audio and display “当前是 HTTP 开发入口 · 音频需受信任 HTTPS”; it does not count as audio acceptance.

## Real AI

```bash
npm --workspace ./examples/ai-annotation-demo run verify:education-classroom-real-ai
```

This is network- and credential-dependent. Preserve `execution_mode=real`, prompt contract, structured-output validation and source validation in the report. Perform a separate human review of Chinese usefulness, formula uncertainty and source navigation.

## E-paper device (future track, excluded from the current two-Web gate)

1. Build and sync Android assets with a Mac LAN API base.
2. Confirm Android still launches `mobile.html` by default.
3. Explicitly navigate the WebView to `student-classroom.html?eink=1` for this test only.
4. Join a live class, observe at least 20 completed strokes, disconnect/reconnect, end the class, open summary/practice history, then clear local data.
5. Record WebView streaming support, buffering, time-to-visible-update, full/partial refresh mode, flicker, ghosting and a human `usable / usable-with-delay / unusable` verdict.

## Freeze gates

Run the existing meeting, reading/reflow, Runtime Sync and Android asset checks without changing their expected semantics. Education pages are additive; `mobile.html`, existing meeting actions and reading knowledge export remain frozen.

## Infinite-canvas automated and headed baseline — 2026-07-20

- Multi-browser smoke: passed with one teacher and three isolated student profiles. The durable ledger ended at sequence 15: 14 new world-coordinate strokes across two textbook pages plus one legacy normalized compatibility fixture. All student digests converged.
- Layout and recovery: single viewport/no nested scroll, per-page camera and ink restoration, free-browse shared-ledger updates, world/legacy source navigation, API restart, PDF failure/retry, quota/restart, final idempotency, deletion fencing and privacy checks passed.
- Browser simulation latency: 31 rendered samples. World stroke P50/P95 `4/5 ms`; transient teacher view `5/11 ms`; durable teacher view `10/67 ms`, all under `150/300 ms`. This is not physical AI Pen or iPad evidence.
- Real gateway: `glm-5.2`; current-step, selected-region, full-summary, practice and five-candidate LessonGraph all passed mathematical semantics and source-ID allowlists. Every operation succeeded on its first attempt in this run; automated tests separately cover structured-output retry behavior.
- Headed desktop Chrome over HTTPS: teacher and student both reported `isSecureContext=true` on `https://localhost:8872`; audio controls were available, one clipped viewport was present, textbook raster loaded, free browse/teacher movement/return worked, and PDF failure retained grid plus ink before recovery.
- LAN same-origin: teacher/student HTML and classroom preflight returned from `https://172.168.20.94:8872`; the headed sessions issued no requests to legacy port `8731`.
- Desktop Safari and physical iPad/Pencil: not tested. The local certificate still needs to be installed and trusted on each real device. Do not claim these device gates passed from Chrome or CDP evidence.

Generated local evidence is written under `examples/ai-annotation-demo/test-results/` and remains intentionally untracked.

## Phase 0 headed rerun — 2026-07-19

- Headed teacher/student verification found and fixed Vite development routing that incorrectly sent classroom requests to the default Cloud Hub port instead of the registered same-origin classroom middleware.
- After the fix, a teacher created and started a class, a student joined, and a real browser mouse stroke committed as exactly one SVG path on both pages.
- Live explanation, post-class summary and practice completed with real AI and source-linked output. The content only described stroke geometry, so workflow passed while mathematical semantics remained unpassed.
- LessonGraph correctly refused one-stroke evidence; the teacher UI now displays the refusal instead of silently re-enabling the button.
- The first committed student-side stroke now replaces the stale empty-board notice without overwriting AI/reconnect status messages.
- The temporary visual-test classroom was deleted and deletion propagated to the student. Full details: `docs/reviews/2026-07-19-education-classroom-phase-0-baseline-acceptance.md`.

## Post-Deploy Monitoring & Validation

- Search server logs for `classroom_not_found`, `education_queue_full`, `education_rate_limited`, `invalid_board_event`, `invalid_preview`, `retry_gateway_unavailable` and `retry_invalid_structured_output`.
- Healthy signals: classroom streams close after delete, no private fields appear in shared stream frames, browser P95 remains at or below 300 ms, and real-AI source validation stays at 100%.
- Failure triggers: repeated stream resync loops, participant cross-access, a late AI write after deletion, source validation failure, or Android default entry changing away from `mobile.html`.
- Mitigation: stop the classroom host, preserve the local `.inkloop/classrooms` directory for diagnosis, and revert the education feature branch without modifying meeting/reading data.
- Validation window/owner: first complete device classroom session after deployment; classroom validation operator owns the checklist and physical e-paper verdict.
