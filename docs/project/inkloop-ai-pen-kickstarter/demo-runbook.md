# InkLoop AI Pen V1 Demo Runbook

Date: 2026-07-03

This runbook is the local demo path for the October 2026 Kickstarter V1 direction. It proves the current repository can demonstrate the AI Pen product chain with a hardware-faithful simulated pen stream plus a validated RawPenFrame ingress bridge, while keeping the remaining real-hardware and campaign gates explicit.

## Demo Promise

Show InkLoop as an AI Pen system, not as a standalone SDK:

```text
AI Pen / Capture Surface
-> Live Board
-> InkEvent ledger
-> InkGraph candidates
-> AI Graph Job
-> LessonGraph or MeetingGraph
-> accept / edit / dismiss
-> KnowledgeObject
-> Obsidian projection / export
```

The demo must focus on two V1 scenarios:

- Education: board teaching becomes reviewed lesson notes and formula steps.
- Business meeting: marked whiteboard events become candidate decisions, actions, risks, and diagrams.

Do not claim in this demo:

- real BLE/firmware ingestion is complete
- A2/A3 Capture Surface calibration has passed
- production cloud agents are deployed
- e-paper tablet is the October base Kickstarter reward
- Kickstarter supplier, testimonial, follower, or market gates are already met

## Required Local State

From repository root:

```bash
npm install
npm run verify
```

Expected current evidence:

```text
npm run verify:
- root check/lint/test/build/pack/consumer verification passed
- root tests: 14 test files, 66 tests passed
- Kickstarter campaign claim verifier confirms evidence-bound copy and unsupported-claim guardrails
- Obsidian V1 plugin verifier confirms source/dist plugin package, runtime sync settings, sidecar boundary, AI Pen projection description, source file/session unit boundary (`source-unit boundary`), and temp vault installer smoke that clears a legacy syncEndpoint into V1 runtime settings
- demo verification: 30 demo test files, 238 tests passed
- Vite build includes ai-pen-demo.html, index.html, and mobile.html
- Android/Paper asset verifier confirms the same entries and referenced JS/CSS are mirrored into Android assets
- SDK bundle, declarations, and Obsidian plugin package build
- Runtime Sync smoke proves Web/WebView/Paper-shaped sidecar events can sync with Obsidian-shaped sidecar events without using vault release; expected evidence includes `release_path_used=false`
- AI Pen V1 smoke and evidence analyzer smokes passed
```

Before handing the demo to someone else or presenting it, run the heavier local handoff verifier:

```bash
npm run verify:local-demo-handoff
```

Expected handoff evidence:

```text
npm run verify:local-demo-handoff:
- Runtime Sync smoke passes with `release_path_used=false`
- Browser smoke imports RawPenFrame JSONL, pushes the same fixture through `window.InkLoopRawPen`, clicks education/meeting flows, verifies Accept/Edit/Dismiss, and writes screenshots/result JSON under `test-results/ai-pen-browser-smoke/`
- AI Graph worker smoke validates completed/retried/rejected jobs and writes `test-results/ai-graph-worker-smoke/worker-report.json`
- Android/Paper debug APK builds at `examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk`
- Android/Paper verifier checks the M103 `hqunifiedsocket` -> RawPenFrame adapter and `window.InkLoopM103RawPenCapture.exportJsonl()` QA path
- Android/Paper verifier checks `window.InkLoopLanImport` and the mobile 「局域网上传」/「Wi-Fi 收件箱」 path so a same-LAN desktop can upload a document into the e-paper reader before local import
- Obsidian demo vault generation installs the plugin and writes education/meeting projection Markdown under `test-results/obsidian-demo-vault/`
- Kickstarter ops refresh updates pre-launch page, launch freeze, and launch-day status before the demo evidence bundle is written
- Demo evidence bundle collects the browser smoke result, AI Graph worker report, projection screenshots, Android/Paper APK, boundary artifacts, Obsidian package, pre-launch page status, operator pack status, ops refresh status, and current V1 docs into `test-results/ai-pen-demo-evidence/`
```

Useful direct checks:

```bash
npm run verify:kickstarter-claims
npm run verify:obsidian-v1-plugin
npm run obsidian:smoke
npm run obsidian:demo-vault
npm run demo:smoke:runtime-sync
npm run demo:smoke:ai-graph-worker
npm run verify:local-demo-handoff
npm run kickstarter:ops-refresh
npm run launch:evidence:intake
npm run launch:evidence:intake-audit
npm run launch:evidence:record-update-plan
npm run launch:evidence:apply-record-updates
npm run launch:evidence:audit
npm run launch:action-plan
npm run launch:critical-path
npm run launch:weekly-sprint
npm run launch:kpi-dashboard
npm run kickstarter:claim-downgrade
npm run kickstarter:public-copy-lock
npm run kickstarter:supplier-quote-audit
npm run kickstarter:page-review-audit
npm run kickstarter:prelaunch-page-intake-audit
npm run kickstarter:prelaunch-page-pack
npm run kickstarter:risk-register
npm run kickstarter:launch-signoff-audit
npm run kickstarter:launch-freeze-pack
npm run kickstarter:launch-day-command-center
npm run launch:review-pack
npm run kickstarter:rehearsal-pack
npm run kickstarter:proof-shot-intake
npm run kickstarter:proof-shot-audit
npm run launch:operator-pack
npm run launch:evidence:audit:strict
npm run demo:evidence:bundle
npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-v1
```

`npm run launch:evidence:intake` creates a dated staging package under `test-results/ai-pen-launch-evidence-intake/` for real hardware, Capture Surface, education, meeting, supplier, GTM, and Kickstarter page review evidence. Use it before rehearsals or supplier/GTM reviews so raw artifacts, analyzer reports, and record fields land in a predictable structure.

`npm run launch:evidence:intake-audit` writes the Launch evidence intake audit under `test-results/ai-pen-launch-evidence-intake-audit/`. Run it after copying real artifacts into the intake package and before editing evidence records: it checks non-template raw files, expected analyzer input/output, analyzer `ok=true`, passing `gate_checks`, and supporting artifacts. It is a staging QA step only, not launch approval.

`npm run launch:evidence:record-update-plan` writes the evidence record update plan under `test-results/ai-pen-launch-evidence-record-update-plan/`. Run it after the intake audit and before editing Markdown evidence records; only rows marked `ready_to_update_record` should be copied into official evidence records.

`npm run launch:evidence:apply-record-updates` writes the evidence record apply dry run under `test-results/ai-pen-launch-evidence-record-apply/`. It previews exactly which eligible path fields could be written from `ready_to_update_record` rows. Only after checking the raw files, analyzer reports, artifacts, and reviewer notes should you run `npm run launch:evidence:apply-record-updates:write`; even then, the `Decision` row stays manual.

`npm run launch:evidence:audit` is the real launch evidence report. It should remain `not_launch_ready` while hardware, Capture Surface, education, meeting, GTM, supplier, or page-review records still contain placeholders, unresolved artifact links, missing launch-positive decisions, or local analyzer reports that do not pass required `gate_checks`. `npm run launch:evidence:audit:strict` is the pre-Kickstarter hard gate and should only pass when those records include resolvable raw artifact links, local analyzer reports, and human-readable pass or conditional-pass decisions.

`npm run launch:action-plan` converts the latest audit report into the weekly execution queue under `test-results/ai-pen-launch-action-plan/`, including priority, owner role, source milestone, due target, analyzer command, evidence record, and done condition for each red gate.

`npm run launch:critical-path` writes the Kickstarter critical path under `test-results/ai-pen-kickstarter-critical-path/`. Use it before the weekly project review to see dated milestone pressure from the source countdown plan, including due-this-week, at-risk, overdue, and red-gate pressure against the 2026-10-27 / 2026-10-30 launch window.

`npm run launch:weekly-sprint` writes the Kickstarter weekly sprint under `test-results/ai-pen-kickstarter-weekly-sprint/`. Use it after refreshing the critical path and intake audit to turn the next 7 days of milestone pressure into assigned launch tasks with current intake folder, expected raw/report targets, runnable analyzer commands, First 48 Hours capture plan, evidence record, and done condition. It is an execution queue, not launch approval.

`npm run launch:kpi-dashboard` writes the Launch KPI dashboard under `test-results/ai-pen-launch-kpi-dashboard/`. Use it before the weekly project review to see the source KR board and launch gates in one place: prototypes, Capture Surface, Live Board latency, trial users, testimonials, email list, Kickstarter followers, AI usefulness, source_refs, BOM, and page-claim readiness.

`npm run kickstarter:claim-downgrade` writes the Kickstarter claim downgrade pack under `test-results/ai-pen-kickstarter-claim-downgrade/`. Use it before copying any campaign claim into Kickstarter, video narration, ads, landing pages, launch emails, social posts, or comment replies; it tells you which claims are public allowed, guardrail-only, demo wording only, or draft-only until real evidence is linked.

`npm run kickstarter:public-copy-lock` writes the Kickstarter public copy lock under `test-results/ai-pen-kickstarter-public-copy-lock/`. Use it before campaign-copy review: it combines claim downgrade decisions, latest proof-shot audit state, campaign draft sources, and launch audit state into one pre-publish copy lock for Kickstarter page, video narration, ads, landing pages, launch emails, social posts, and comment replies. It is not publish approval.

`npm run kickstarter:supplier-quote-intake` writes the Kickstarter supplier quote intake package under `test-results/ai-pen-kickstarter-supplier-quote-intake/YYYY-MM-DD/`. Use it before supplier outreach or reward-pricing review: it creates BOM rows, primary/backup quote rows, quote artifact folders, reward pricing report target, and human supply review. It is not reward pricing approval.

`npm run kickstarter:supplier-quote-audit` writes the Kickstarter supplier quote audit under `test-results/ai-pen-kickstarter-supplier-quote-audit/`. Use it after real supplier quote artifacts and a reward-pricing report exist; template rows with TBD remain red.

`npm run kickstarter:page-review-intake` writes the Kickstarter page review intake package under `test-results/ai-pen-kickstarter-page-review-intake/YYYY-MM-DD/`. Use it before formal Kickstarter page/legal/privacy review: it creates preview/review rows, page-section review rows, legal/privacy checks, screenshots/exports/artifacts folders, and owner/legal/founder review files. It is not publish approval.

`npm run kickstarter:page-review-audit` writes the Kickstarter page review audit under `test-results/ai-pen-kickstarter-page-review-audit/`. Use it after filling the formal page review intake with real preview URL, legal/privacy review link, reviewed page sections, legal/privacy decisions, and owner/founder approval; template rows with TBD remain red.

`npm run kickstarter:prelaunch-page-intake` writes the Kickstarter pre-launch page intake package under `test-results/ai-pen-kickstarter-prelaunch-page-intake/YYYY-MM-DD/`. Use it before creating or updating the Kickstarter pre-launch page: it creates page field rows, Notify me tracking rows, owner review rows, founder review, screenshots, exports, and artifacts folders. It is not publish approval.

`npm run kickstarter:prelaunch-page-intake-audit` writes the Kickstarter pre-launch page intake audit under `test-results/ai-pen-kickstarter-prelaunch-page-intake-audit/`. Use it after filling the intake with real preview/live URL values, screenshots, GTM/CRM exports, Notify me rows, and owner/founder review; template rows with TBD remain red.

`npm run kickstarter:prelaunch-page-pack` writes the Kickstarter pre-launch page pack under `test-results/ai-pen-kickstarter-prelaunch-page/`. Use it before publishing or promoting the pre-launch page: it checks Kickstarter preview URL, pre-launch URL, Notify me funnel, UTM tracking, owner review, public copy lock, claim downgrade, launch evidence, and GTM readiness. It is not publish approval and does not prove demand without real Kickstarter follower and GTM exports.

`npm run kickstarter:risk-register` writes the Kickstarter risk register under `test-results/ai-pen-kickstarter-risk-register/`. Use it before the weekly project review to see the source risk matrix, launch gates, KPI pressure, claim downgrade state, public copy lock status, open P0 queue, next-week action, and downgrade path in one place. It is a P0 management view, not launch approval.

`npm run kickstarter:ops-refresh` writes the Kickstarter ops refresh package under `test-results/ai-pen-kickstarter-ops-refresh/`. Use it as the weekly operating shortcut before project review, rehearsal status review, campaign-copy review, supplier review, formal page/legal review, pre-launch page review, or launch signoff review. It refreshes the evidence record apply dry run, launch evidence audit, action plan, critical path, weekly sprint, KPI dashboard, claim downgrade pack, proof-shot audit, public copy lock, supplier quote audit, page review audit, pre-launch page intake audit, pre-launch page pack, risk register, launch signoff audit, launch review pack, rehearsal pack, Launch operator pack, Kickstarter launch freeze pack, and Kickstarter launch-day command center without creating a new proof-shot intake package, supplier quote intake package, page review intake package, or pre-launch page intake package. Strict mode stays red until launch evidence, P0 risk, final-cut proof shots, public copy lock, supplier quotes, page review, pre-launch intake, pre-launch page, launch signoff, launch freeze, and launch-day command center are ready.

`npm run kickstarter:launch-signoff-audit` writes the Kickstarter launch signoff audit under `test-results/ai-pen-kickstarter-launch-signoff-audit/`. Use it before launch freeze review to check final owner signoffs, manual launch operator, launch-room coverage, final Go/No-Go decision, and T-24h to T+24h task evidence. It is not human launch approval.

`npm run kickstarter:launch-freeze-pack` writes the Kickstarter launch freeze pack under `test-results/ai-pen-kickstarter-launch-freeze/`. Use it only for final page-freeze or Go/No-Go review: it combines launch evidence, public copy lock, open P0 risk, final-cut proof shots, Kickstarter preview link, page review audit, legal/privacy review, rewards/pricing evidence, GTM demand evidence, launch signoff audit, rehearsal handoff, operator closeout, and weekly review status in one package. It is not human launch approval.

`npm run kickstarter:launch-day-command-center` writes the Kickstarter launch-day command center under `test-results/ai-pen-kickstarter-launch-day-command-center/`. Use it after launch freeze review to turn the source T-24h to T+24h launch script into one operating board with launch signoff audit status, evidence links, blockers, manual launch owner, comment/FAQ rotation, update cadence, conversion review, and support escalation. It is not human launch approval, and Kickstarter launch is a manual action.

`npm run launch:review-pack` writes the Weekly Launch Review Pack under `test-results/ai-pen-launch-review-pack/`. Use it before the weekly project review to combine local demo evidence, browser smoke, launch evidence intake audit, evidence record update plan, evidence record apply dry run, Kickstarter critical path, Kickstarter weekly sprint, Launch KPI dashboard, Kickstarter claim downgrade pack, public copy lock, Kickstarter risk register, launch audit status, and the action plan queue in one place without converting demo readiness into launch readiness.

`npm run kickstarter:rehearsal-pack` writes the Kickstarter rehearsal pack under `test-results/ai-pen-kickstarter-rehearsal/`. Use it before an external demo, founder walkthrough, or campaign-video rehearsal: it links Web screenshots, Android/Paper APK, Obsidian demo vault, campaign drafts, proof-shot gaps, claim boundaries, public copy lock status, and the current launch review status in one handoff.

`npm run kickstarter:proof-shot-intake` writes the Kickstarter proof-shot intake package under `test-results/ai-pen-kickstarter-proof-shot-intake/`. Run it before filming Kickstarter video material: it turns the final-cut checklist into one folder per shot with shot logs, claim review CSVs, required artifacts, and the evidence record that must be updated after capture.

`npm run kickstarter:proof-shot-audit` writes the Kickstarter proof-shot audit under `test-results/ai-pen-kickstarter-proof-shot-audit/`. Run it after filming: it checks shot logs, usable clip paths, public approval decisions, and claim-review decisions before a proof shot can enter final-cut review. `npm run kickstarter:proof-shot-audit:strict` is the hard gate for final-cut proof-shot readiness.

`npm run launch:operator-pack` writes the Launch operator pack under `test-results/ai-pen-launch-operator-pack/`. Use it on real capture days and pre-launch page review after refreshing the action plan, weekly sprint, intake audit, evidence record update plan, proof-shot audit, and Kickstarter pre-launch page pack: it puts all 8 launch-gate field work orders, the First 48 Hours capture queue, Pre-Launch / Notify me work order, raw/report/artifact file targets, after-capture command loop, evidence-record writeback guard, and proof-shot capture queue into one field-operator handoff. It is not launch approval and does not edit evidence records. Strict operator readiness requires launch evidence readiness plus `prelaunch_page_ready`; otherwise the pack stays red.

AI Pen V1 smoke expected evidence includes:

```text
checked_entries: dist/ai-pen-demo.html, dist/index.html, dist/mobile.html
education.objectKinds: formula_step, concept
meeting.objectKinds: meeting_decision, meeting_action, diagram
meeting.invalidContextIssues: meeting results must include ink_event or board_object evidence, not audio/project memory alone
```

The demo workspace verification includes these launch-evidence smoke fixtures:

```bash
npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets
npm --workspace ./examples/ai-annotation-demo run smoke:runtime-sync-flow
npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-evidence
npm --workspace ./examples/ai-annotation-demo run smoke:capture-surface-evidence
npm --workspace ./examples/ai-annotation-demo run smoke:live-board-latency-evidence
npm --workspace ./examples/ai-annotation-demo run smoke:reward-pricing-evidence
npm --workspace ./examples/ai-annotation-demo run smoke:gtm-metrics-evidence
npm --workspace ./examples/ai-annotation-demo run smoke:demo-review-evidence
```

The Android/Paper asset verifier runs after `vite build`. It syncs `dist/` into `android/app/src/main/assets/`, verifies `ai-pen-demo.html`, `index.html`, and `mobile.html` plus their referenced JS/CSS are byte-identical in Android assets, and checks that Android still loads `mobile.html` as InkLoop Paper local-first runtime reuse with the hidden `InkLoopRuntime` demo-loop manifest. It also checks that M103 `hqunifiedsocket` strokes are converted by `m103-raw-pen-adapter.ts` into valid RawPenFrame batches and exposed through `window.InkLoopM103RawPenCapture` for JSONL export.

The same verifier now checks the Android/Paper Wi-Fi document import path. `window.InkLoopLanImport` starts a temporary same-LAN upload page from the e-paper app, writes uploads into the local `lan-inbox`, and the mobile file browser shows those files under 「Wi-Fi 收件箱」 before importing through the same local-first document path. This proves the demo import surface for the reader device; it is not cloud sync or Kickstarter launch evidence.

This M103 adapter is a QA/evidence-capture bridge. A real Kickstarter hardware claim still needs a real exported JSONL run, analyzer report, video/replay proof, and evidence-record decision.

These smokes prove analyzer readiness only. They use fixtures and must not be counted as real hardware, real supplier, real GTM, or real campaign evidence.

Browser interaction smoke, when Chrome is available on the machine:

```bash
npm run demo:smoke:ai-pen
```

Expected evidence:

```text
ok: true
V1 Launch Chain panel keeps AI Pen + Capture Surface, InkGraph output, user review gate, source file unit, Obsidian projection-only role, launch operations queue, pre-launch page boundary, and launch-freeze Go/No-Go boundary visible
Education Run Demo -> Generate AI -> Accept/Edit -> Obsidian projection
Meeting Run Demo -> Generate AI -> Accept/Edit/Dismiss -> Obsidian projection
Meeting action keeps board/ink evidence as required proof while retaining audio context only as optional context
Edited review body is rendered into Obsidian projection
Dismissed meeting risk is not promoted into projection
SourceRefs validator visible in both scenarios
screenshots.education: .../education-projection.png
screenshots.meeting: .../meeting-projection.png
```

Default output location:

```text
test-results/ai-pen-browser-smoke/result.json
test-results/ai-pen-browser-smoke/education-projection.png
test-results/ai-pen-browser-smoke/meeting-projection.png
```

Demo evidence bundle:

```bash
npm run demo:evidence:bundle
```

Expected output:

```text
test-results/ai-pen-demo-evidence/README.md
test-results/ai-pen-demo-evidence/manifest.json
```

Use this bundle for internal demo handoff only. It packages local software evidence, including Android/Paper runtime boundary bridge/status assets, the Obsidian V1 settings boundary panel, the current pre-launch page status, and the Kickstarter ops refresh status. It keeps explicit non-claims for real hardware, Capture Surface calibration, GTM, supplier, published pre-launch page, follower demand, and public Kickstarter readiness.

Hardware log analyzer smoke:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-evidence
```

Real run analysis:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:ai-pen-run -- /path/to/raw-pen-run.jsonl --out /tmp/ai-pen-run-report.json
```

Capture Surface calibration analyzer smoke:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:capture-surface-evidence
```

Real calibration analysis:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:capture-surface -- /path/to/calibration.csv --out /tmp/capture-surface-report.json
```

Live Board latency analyzer smoke:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:live-board-latency-evidence
```

Real render timing analysis:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:live-board-latency -- /path/to/live-board-timing.csv --out /tmp/live-board-latency-report.json
```

Reward pricing model smoke:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:reward-pricing-evidence
```

Real BOM and supplier pricing analysis:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- /path/to/bom.csv --out /tmp/reward-pricing-report.json
```

GTM metrics smoke:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:gtm-metrics-evidence
```

Real CRM/Kickstarter/testimonial snapshot analysis:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:gtm-metrics -- /path/to/gtm-snapshots.csv --out /tmp/gtm-report.json
```

Education and business demo-review smoke:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:demo-review-evidence
```

Real reviewed demo analysis:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:demo-review -- /path/to/demo-review.csv --out /tmp/demo-review-report.json
```

## Web/Desktop Primary Demo

Start the demo host:

```bash
npm run demo:ai-pen
```

Open the URL printed by Vite, usually:

```text
http://127.0.0.1:8765/ai-pen-demo.html
```

### Education Flow

1. Select `Education`.
2. Click `Run Demo`.
3. Confirm the `V1 Launch Chain` panel shows AI Pen + Capture Surface capture state, InkGraph output, user review gate, `Source File Unit`, Obsidian projection-only role, `Launch Ops Queue` with `86 P0 inputs`, `Pre-Launch / Notify me` with `prelaunch_page_not_ready`, and `Launch Freeze Go/No-Go` with `0/13 gates ready`.
4. Confirm the Live Board draws the teacher board sequence and the event ledger increments.
5. Click `Generate AI`.
6. Confirm the `AI Graph Job` card reaches `AI Graph Job completed`, then confirm `LessonGraph` candidates show source_refs.
7. Click `Accept` on the first lesson candidate.
8. Click `Edit` on the formula candidate, revise the edited body in the inline editor, then click `Apply Edit`.
9. Confirm Obsidian Projection Preview renders clean Markdown with source file/session unit frontmatter, the applied edit, and an `inkloop://doc/doc_ai_pen_lesson_demo` backlink.

### RawPenFrame Import Flow

Use this path when a real or fixture AI Pen raw frame log is available.

1. Select `Education` or `Meeting`.
2. Click `Import Raw Log`.
3. Choose a `.jsonl` or `.json` file containing RawPenFrame records. The importer accepts JSONL, JSON arrays, `{ frame }`, or `{ raw_pen_frame }` wrappers.
4. Confirm the board status says the file was imported and the Live Board shows generated InkEvents.
5. Click `Generate AI`.
6. Confirm the imported RawPenFrame log follows the same chain: `RawPenFrame JSONL import -> InkEvents -> AI Graph Job -> LessonGraph` or MeetingGraph.

The browser smoke covers this with `examples/ai-annotation-demo/fixtures/ai-pen-run-sample.jsonl`. It also calls `window.InkLoopRawPen.pushJsonl(...)` against the same fixture so Android native, Web Serial, or Web Bluetooth adapters have a stable RawPenFrame ingress target. Real hardware logs should still be analyzed with `evidence:ai-pen-run` and attached to [Hardware prototype run log](./evidence/hardware-prototype-run-log.md); the local bridge does not prove a specific transport.

### Hardware Ingress Bridge

The Web/Desktop AI Pen page exposes a local bridge named `window.InkLoopRawPen`. It accepts validated RawPenFrame payloads through:

```js
window.InkLoopRawPen.pushFrame(frame, 'source name', 'android_native')
window.InkLoopRawPen.pushFrames([frameA, frameB], 'source name', 'web_serial')
window.InkLoopRawPen.pushJsonl(jsonlText, 'source name', 'web_bluetooth')
```

All three calls feed the same parser, `validateRawPenFrame` contract, stroke grouping, InkEvent ledger, and AI Graph Job path used by `Import Raw Log`. Use it as the integration target for Android native or hardware transport adapters. Do not describe it as BLE verified until a real device run produces raw logs, latency reports, and evidence-record decisions.

### Business Meeting Flow

1. Select `Meeting`.
2. Click `Run Demo`.
3. Confirm the `V1 Launch Chain` panel remains visible and still marks `Meeting Event Marks` with `board/ink evidence required` and `audio/subtitles/timeline optional context`, while `Launch Ops Queue` stays `86 P0 inputs`, `Pre-Launch / Notify me` stays `prelaunch_page_not_ready`, and `Launch Freeze Go/No-Go` stays `preview/legal/BOM/GTM/proof shots/human signoff missing`.
4. Confirm the Live Board draws diagram nodes, arrow, action item, and risk mark.
5. Click `Generate AI`.
6. Confirm the `AI Graph Job` card reaches `AI Graph Job completed`, then confirm `MeetingGraph` contains decisions, actions, risks, and diagram beta from board/ink source refs.
7. Confirm validator says SourceRefs passed.
8. Click `Accept` on the decision candidate.
9. Click `Edit` on the action candidate, revise the edited body in the inline editor, then click `Apply Edit`.
10. Click `Dismiss` on the risk candidate.
11. Confirm Obsidian Projection Preview contains:
   - `InkLoop/Meetings/...`
   - Markdown callouts such as `[!tip]` or `[!todo]`
   - `inkloop://doc/doc_ai_pen_meeting_demo`
   - optional context such as `audio:900-6200 Facilitator` attached to an already board-backed action
   - the applied action edit, without the dismissed risk text

Meeting audio, subtitles, agenda, speaker, and timeline data are only optional context. A meeting item must still include `ink_event` or `board_object` evidence before it can become a KnowledgeObject.

## Obsidian Projection Demo

The live web demo previews projection Markdown directly. For plugin packaging:

```bash
npm run build
```

Plugin output:

```text
dist/obsidian-plugin/inkloop-sync
```

`npm run verify:obsidian-v1-plugin` also installs the package into a temp vault, enables `inkloop-sync`, copies the SDK IIFE, verifies that stale legacy syncEndpoint settings are replaced by the V1 runtime push/pull endpoints with `previewEditing=false`, and checks that the plugin settings page contains the `InkLoop AI Pen V1 boundary` panel, `Meeting Event Marks` board/ink evidence boundary, plus `Launch Ops Queue: 86 P0 inputs` and `Launch Freeze Go/No-Go` status.

`npm run obsidian:smoke` is the presentation-safe shortcut for this path: it rebuilds the plugin package and runs the same Obsidian V1 package plus temp vault installer smoke.

For a directly openable demo vault:

```bash
npm run obsidian:demo-vault
```

Open this folder in Obsidian:

```text
test-results/obsidian-demo-vault
```

Then open:

```text
InkLoop/Reading/AI Pen Lesson Demo/AI Pen Lesson Demo.md
InkLoop/Meetings/2026-07-03 AI Pen Meeting Demo/AI Pen Meeting Demo.md
```

Expected evidence: `inkloop-sync` is installed and enabled, lesson hub and meeting hub include `inkloop_document_id`, `inkloop_document_uri`, and `inkloop_projection_role: "source_file_unit"` frontmatter, lesson hub links to formula/concept notes, meeting hub links to decision/edited-action/diagram notes, dismissed meeting risk is absent, and notes preserve `inkloop://doc/...` backlinks.

Plugin settings evidence: open Obsidian Settings -> Community plugins -> InkLoop Sync and confirm the `InkLoop AI Pen V1 boundary` panel says Obsidian receives accepted/edited KnowledgeObject projections only, source units stay grouped by `inkloop://doc/...`, visible Markdown/PDF edits are not reverse-parsed into InkEvents, Meeting Event Marks require board/ink evidence while audio/subtitles/timeline stay optional context, runtime state uses hidden sidecar sync, `Launch Ops Queue` remains `86 P0 inputs`, and `Launch Freeze Go/No-Go` remains `0/13 gates ready` with `preview/legal/BOM/GTM/proof shots/human signoff missing`.

V1 boundary to explain:

- Obsidian receives reviewed knowledge projection: Reading Note, Highlight, Task, Decision, Risk, Diagram, Lesson Note, Formula Step.
- Obsidian groups projections by source file/session unit with `inkloop_document_id`, `inkloop_document_uri`, and `inkloop_projection_role` frontmatter.
- Obsidian keeps `inkloop://doc/...` backlinks for jumping back to the InkLoop source document/session.
- Obsidian does not become the capture truth source for arbitrary AI Pen events.
- Arbitrary Obsidian PDF marks or arbitrary Markdown edits are not reverse-parsed into canonical InkEvents in V1.
- Launch Ops Queue and Launch Freeze Go/No-Go are visible in settings but separate from Obsidian projection correctness.

## Android / InkLoop Paper Demo

Android is the second-loop InkLoop Paper runtime reuse path. It is useful to show local-first WebView packaging, file import, e-paper refresh, and runtime contract reuse, but it is not the October 2026 Kickstarter base hardware promise.

Build assets and APK:

```bash
npm run android:assemble:debug
```

Manual fallback:

```bash
npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets
cd examples/ai-annotation-demo/android
JAVA_HOME=/Users/ethan/.cache/inkloop-tools/jdks/temurin17/Contents/Home \
ANDROID_HOME=/Users/ethan/Library/Android/sdk \
ANDROID_SDK_ROOT=/Users/ethan/Library/Android/sdk \
JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true' \
./gradlew :app:assembleDebug --no-daemon
```

APK:

```text
examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk
```

Demo talk track:

- The app loads `mobile.html` as InkLoop Paper local-first runtime reuse.
- The first screen is a clean reader/diary/books workspace, with no persistent launch-gate status strip. The hidden Android `InkLoopRuntime` manifest should report `Web import -> Paper reading/marking -> Obsidian projection` and `local-first` for QA/debug use.
- `ai-pen-demo.html`, `index.html`, and `mobile.html` are bundled as assets by the Vite multi-page build.
- Local import, offline cache, runtime sidecars, and future e-paper review/annotation surfaces share the same contracts.
- AI Pen capture remains the Web/Desktop Capture Host path for Kickstarter V1.

## Acceptance Checklist

| Area | Demo Pass Condition |
| --- | --- |
| Strategy source | `docs/project/inkloop-ai-pen-kickstarter/source/` contains all 9 source files plus the combined plan |
| Web V1 | `ai-pen-demo.html` runs Education and Meeting scenarios |
| AI graph job | Demo creates and completes `AiGraphJob` before KnowledgeObject review; worker smoke covers completed/retried/rejected job paths |
| Source refs | LessonGraph and MeetingGraph candidates validate before promotion |
| Review gate | Accept promotes; Edit opens an inline body editor and `Apply Edit` updates projection; Dismiss does not promote |
| Obsidian | Projection preview produces source file/session unit frontmatter, clean Markdown callouts, and `inkloop://doc/...` backlinks |
| Meeting boundary | Audio/project memory cannot promote meeting outputs without ink or board evidence |
| Android | `npm run android:assemble:debug` produces a debug APK from synced assets |
| Analyzer readiness | Hardware, Capture Surface, Live Board, reward pricing, GTM, and demo-review smoke fixtures all pass |
| Product honesty | Demo states local RawPenFrame ingress bridge is ready, while real BLE/firmware, calibration, hosted production cloud agents, and Kickstarter market/supply gates are not yet complete |

## Evidence Capture Checklist

After any real-hardware rehearsal, update the matching evidence records:

Use `npm run launch:evidence:intake` first when starting a new real rehearsal or external evidence review. It creates raw/report/artifact folders, CSV/JSONL templates, analyzer commands, and the exact evidence-record fields to update for each gate.
After copying real files into the intake package and running any gate analyzer, run `npm run launch:evidence:intake-audit` to catch missing raw files, missing analyzer reports, failing `gate_checks`, or template-only folders before evidence records are edited.
Then run `npm run launch:evidence:record-update-plan` and `npm run launch:evidence:apply-record-updates`; apply only proposed values from records marked `ready_to_update_record`, leave `blocked_do_not_update_record` records unchanged, and keep the `Decision` row as a manual reviewer entry.
After updating evidence records, run `npm run kickstarter:ops-refresh` to refresh the evidence record update plan, evidence record apply dry run, red-gate execution queue, Kickstarter critical path, Kickstarter weekly sprint, Launch KPI dashboard, Kickstarter claim downgrade pack, proof-shot audit, public copy lock, supplier quote audit, page review audit, pre-launch page intake audit, Kickstarter pre-launch page pack, Kickstarter risk register, weekly review package, external-demo rehearsal handoff, Launch operator pack, Kickstarter launch freeze pack, Kickstarter launch-day command center, and latest proof-shot audit. Before a new filming session, run `npm run kickstarter:proof-shot-intake` so shot logs and claim-review CSVs start from the current video checklist. Before supplier outreach or pricing review, run `npm run kickstarter:supplier-quote-intake` so BOM rows, quote artifacts, and supply review start in one dated package. Before formal Kickstarter page/legal review, run `npm run kickstarter:page-review-intake` so preview URL, legal/privacy evidence, section decisions, screenshots, exports, and owner/founder review start in one dated package. Before creating or updating the Kickstarter pre-launch page, run `npm run kickstarter:prelaunch-page-intake` so preview/live URL evidence, screenshots, GTM rows, and owner review start in one dated package. After filming, supplier updates, formal page review, or page updates, run `npm run kickstarter:ops-refresh` again before treating any take, supplier quote package, page review package, or pre-launch page as ready; strict ops remains blocked until launch evidence, P0 risk, final-cut proof shots, public copy lock, supplier quotes, page review, pre-launch intake, pre-launch page, launch freeze, and launch-day command center are all ready.

| Rehearsal Evidence | Record |
| --- | --- |
| Pen unit, firmware, 30-minute run, raw frame log, replay, and failure notes | [Hardware prototype run log](./evidence/hardware-prototype-run-log.md) |
| A3/A2 surface measurement, lighting/material conditions, error distribution, and edge cases | [Capture Surface calibration report](./evidence/capture-surface-calibration-report.md) |
| Pen-to-Live-Board transport timing and render timing | [Live Board latency report](./evidence/live-board-latency-report.md) |
| Teacher session video, raw session, exported lesson notes, and reviewer actions | [Education demo review record](./evidence/education-demo-review.md) |
| Meeting whiteboard video, optional transcript context, exported actions/decisions/risks, and reviewer actions | [Business meeting demo review record](./evidence/business-meeting-demo-review.md) |
| BOM, supplier quotes, MOQ, lead time, assembly route, fees, and reward margin | [BOM and supplier tracker](./evidence/bom-supplier-tracker.md) |
| Email list, Kickstarter followers, testimonials, first-day support list, and segment split | [GTM metrics tracker](./evidence/gtm-metrics-tracker.md) |
| Campaign claims, AI/privacy copy, reward risks, and outside review notes | [Kickstarter page risk checklist](./evidence/kickstarter-page-risk-checklist.md) |

## Related Evidence

- [Project README](./README.md)
- [Implementation Alignment](./implementation-alignment.md)
- [Kickstarter Launch Readiness Tracker](./launch-readiness-tracker.md)
- [Readiness Audit](./readiness-audit.md)
- [Completion Audit](./completion-audit.md)
- [Launch Evidence Templates](./evidence/README.md)
- [Architecture](../../architecture.md)
