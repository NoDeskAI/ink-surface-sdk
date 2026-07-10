# InkLoop AI Pen Kickstarter Project

This directory is the current project source of truth for the 2026-10 Kickstarter launch. The product baseline is no longer an e-paper SDK project. The launch product is **InkLoop AI Pen Starter Kit** for education and business whiteboard meetings.

## Decision Baseline

- Kickstarter hero product: **AI Pen + Capture Surface + Host App + Live Board + InkLoop Studio**.
- First scenarios: **education board teaching** and **business whiteboard meetings**.
- First surface: real whiteboard with Capture Surface. E-paper remains **InkLoop Paper**, the second product loop and runtime host, not the October 2026 delivery promise.
- Source of truth: append-only pen and ink event ledger. UI, AI results, Obsidian Markdown, exports, and cloud views are derived outputs.
- Moat: **InkGraph** and traceable `source_refs`, not a generic chat layer.

## Current Operating Snapshot

| Item | Current Status | Evidence |
| --- | --- | --- |
| Local V1 software demo | `local_demo_ready` | `test-results/ai-pen-demo-evidence/README.md` |
| AI Pen browser smoke | `browser.ok=true` | `test-results/ai-pen-browser-smoke/result.json` |
| Launch operations queue | `86 P0 inputs` | `test-results/ai-pen-kickstarter-ops-refresh/README.md` |
| Ops refresh | `ops_refresh_launch_not_ready` | `test-results/ai-pen-kickstarter-ops-refresh/ops-refresh.json` |
| Pre-launch page | `prelaunch_page_not_ready` | `test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json` |
| Launch freeze | `launch_freeze_not_ready`, `0/13 gates ready` | `test-results/ai-pen-kickstarter-launch-freeze/launch-freeze.json` |

The snapshot means the repo is demo-ready for the local V1 software chain, not Kickstarter launch-ready. Real hardware logs, Capture Surface calibration, supplier quote artifacts, page/legal review, GTM proof, proof-shot evidence, and owner signoff still gate the public campaign.

## V1 Product Chain

```text
RawPenFrame
-> Stroke
-> InkEvent
-> HMP / Evidence Builder
-> BoardObject
-> BoardGraph / InkGraph
-> SceneView / InferenceView
-> LessonGraph or MeetingGraph
-> Result Validator
-> user accept / edit / dismiss
-> KnowledgeObject
-> Studio / Obsidian projection / export
```

The meeting scene follows the same chain. Meeting audio, subtitles, agenda, speaker, and timeline data are optional context. V1 does **not** make audio the main path. The required meeting path is: whiteboard events are marked, enter the evidence pipeline, align to the InkGraph schema, then post-process into candidate actions, decisions, risks, and diagrams.

## October 2026 Launch Scope

| Area | Must Commit | Defer / Do Not Promise |
| --- | --- | --- |
| Hardware | Single AI whiteboard pen, real dry-erase writing, pen down/up, coordinate stream, local cache | Perfect multi-pen/multi-color |
| Surface | A3/A2 Capture Surface, calibration, stable demo | Any ordinary whiteboard without setup |
| Web/Desktop | Capture Host, Live Board Viewer, session replay, Studio confirmation/export | Deep Zoom/Teams/Jira/Slack integrations |
| AI | Lesson notes, step replay, meeting action/decision/risk candidates, traceable source_refs | Perfect formula/diagram recognition |
| Sync/Export | Local-first session cache, Markdown/PDF/PNG/Mermaid export, Obsidian projection | Obsidian as primary capture truth |
| E-paper | Runtime reuse and roadmap demo | Full e-paper tablet delivery in Kickstarter base tier |

## Three Runtime Roles

| Runtime | V1 Role | Boundary |
| --- | --- | --- |
| Web / Desktop Host | Primary Kickstarter demo surface: connect or simulate AI Pen, render Live Board, record sessions, run Studio, queue AI jobs | Owns capture session UX, not long-term external knowledge editing |
| Android / e-paper host | Second-loop InkLoop Paper runtime host for reading, review, local cache, and future pen surface reuse | Must not be described as the October hardware promise |
| Obsidian plugin | Knowledge projection and runtime sidecar host for accepted/edited outputs grouped by source file/session units, Reading Notes, Highlights, Tasks, Decisions, Risks, diagrams, `inkloop_document_id` / `inkloop_document_uri` frontmatter, and `inkloop://doc/...` back links | Does not reverse-parse arbitrary PDF marks or arbitrary Markdown edits into canonical InkEvents |

## Canonical Source Files

The latest strategy package is preserved under [`source/`](./source/). Treat these files as the unique factual basis until a newer package explicitly supersedes them.

| File | Use |
| --- | --- |
| `00_README.md` | Package overview and strategic pivot |
| `01_产品战略与Kickstarter总方案.md` | Product positioning, launch promise, product matrix |
| `02_系统架构设计.md` | Surface Intelligence OS and layered architecture |
| `03_各模块技术方案.md` | Hardware, Capture Surface, Host, InkGraph, AI, App, Cloud modules |
| `04_AI与InkGraph数据契约.md` | RawPenFrame, InkEvent, BoardGraph, SceneView, LessonGraph, MeetingGraph, SourceRefs |
| `05_目标与里程碑_10月底Kickstarter倒排.md` | Gates, KRs, month/week plan |
| `06_Kickstarter_GTM与众筹页面方案.md` | Page story, rewards, FAQ, AI/privacy disclosure |
| `07_风险_验收指标_降级方案.md` | Technical, supply, campaign risk and downgrade matrix |
| `08_依据与变更记录.md` | Internal/external evidence and decision log |

## Engineering Entry Points

| Layer | Repo Surface |
| --- | --- |
| Shared AI Pen / InkGraph contract | `packages/runtime-schema/src/index.ts` |
| Reviewed AI result to KnowledgeObject projection | `packages/knowledge-schema/src/index.ts` |
| Runtime sync / sidecar store | `packages/offline-store/`, `packages/sync-client/` |
| Web/desktop validation app | `examples/ai-annotation-demo/` |
| Whiteboard / meeting app surfaces | `examples/ai-annotation-demo/src/mobile-main.ts`, `src/features/meeting/`, `src/mobile/meeting.ts` |
| Meeting export into knowledge projection | `examples/ai-annotation-demo/src/integration/inksurface/meeting-export.ts` |
| Obsidian runtime host | `plugins/obsidian/inkloop-sync/` |
| Obsidian clean projection renderer | `packages/adapter-obsidian/` |
| Android WebView/e-paper shell | `examples/ai-annotation-demo/android/` |

## Demo Runbook

Use [v1-demo-handoff.md](./v1-demo-handoff.md) for the narrow V1 loop demo: Web import -> InkLoop Paper reading/marking -> Obsidian knowledge projection. It is the fastest entry point when the goal is to show the product-chain starting point without opening the full Kickstarter operations board.

Use [demo-runbook.md](./demo-runbook.md) as the fuller local demo script. It covers the Web/Desktop AI Pen V1 flow, Obsidian projection boundary, Android/InkLoop Paper runtime reuse flow, launch boundary, acceptance checklist, and explicit non-claims.

## Source Fact Alignment

Use [source-fact-alignment.md](./source-fact-alignment.md) as the traceability map from the uploaded source package to the current repo docs, Web/Desktop host, Android/Paper runtime, Obsidian plugin, launch gates, campaign drafts, and verifiers. This file is the quickest audit surface for checking whether a derived artifact still follows the unique source facts.

## Launch Readiness Tracker

Use [launch-readiness-tracker.md](./launch-readiness-tracker.md) as the working Kickstarter gate board. It maps the source-package technical, GTM, supply, finance, and risk-disclosure requirements to current evidence, missing proof, and downgrade boundaries.

## Completion Audit

Use [completion-audit.md](./completion-audit.md) for the current objective-level review. It separates what is done, what is demo-ready, and what still requires real hardware, GTM, supply, or Kickstarter evidence before a public launch claim.

## Launch Evidence Records

Use [evidence/](./evidence/) as the fillable record set for converting launch gates into proof. The records cover hardware prototype runs, Capture Surface calibration, Live Board latency, education and business demo reviews, BOM/supplier tracking, GTM metrics, and Kickstarter page/risk review.

| Evidence Area | Record |
| --- | --- |
| Hardware prototype runs | [evidence/hardware-prototype-run-log.md](./evidence/hardware-prototype-run-log.md) |
| Capture Surface calibration | [evidence/capture-surface-calibration-report.md](./evidence/capture-surface-calibration-report.md) |
| Live Board latency | [evidence/live-board-latency-report.md](./evidence/live-board-latency-report.md) |
| Education demo review | [evidence/education-demo-review.md](./evidence/education-demo-review.md) |
| Business meeting demo review | [evidence/business-meeting-demo-review.md](./evidence/business-meeting-demo-review.md) |
| BOM and supplier readiness | [evidence/bom-supplier-tracker.md](./evidence/bom-supplier-tracker.md) |
| GTM demand metrics | [evidence/gtm-metrics-tracker.md](./evidence/gtm-metrics-tracker.md) |
| Kickstarter page and risk claims | [evidence/kickstarter-page-risk-checklist.md](./evidence/kickstarter-page-risk-checklist.md) |
| Launch freeze owner signoff | [evidence/launch-freeze-signoff.md](./evidence/launch-freeze-signoff.md) |

The Kickstarter pre-launch page intake is generated by `npm run kickstarter:prelaunch-page-intake`. It writes `test-results/ai-pen-kickstarter-prelaunch-page-intake/YYYY-MM-DD/` with page field rows, Notify me tracking rows, owner review rows, founder review, screenshots, exports, and artifacts folders. `npm run kickstarter:prelaunch-page-intake-audit` checks the latest intake before the pre-launch page pack uses it. This is staging only; template rows and TBD values are not page readiness.

The Kickstarter pre-launch page pack is generated by `npm run kickstarter:prelaunch-page-pack`. It reads the pre-launch page draft, pre-launch page intake audit, public copy lock, claim downgrade pack, launch evidence audit, GTM tracker, page checklist, and source GTM plan, then writes `test-results/ai-pen-kickstarter-prelaunch-page/`. This is the Notify me funnel and pre-launch URL readiness check only; it is not publish approval and does not prove demand without real Kickstarter dashboard and GTM exports.

The final Kickstarter launch-day command center is generated by `npm run kickstarter:launch-day-command-center`. It reads the launch freeze pack, owner signoff record, GTM tracker, page checklist, campaign drafts, launch-day comms pack, public copy lock, risk register, proof-shot audit, and source GTM timeline, then writes `test-results/ai-pen-kickstarter-launch-day-command-center/`. This is a T-24h to T+24h command center only; Kickstarter launch remains a manual action and still requires human Go/No-Go approval.

## Campaign Draft Pack

Use [campaign/](./campaign/) as the first formal Kickstarter page draft pack. It contains the main campaign page draft, 90-second video script, reward/FAQ draft, and claim evidence matrix. These files are structured for review, but not publish-ready until the evidence records above contain real artifacts.

| Campaign Area | Draft |
| --- | --- |
| Page draft | [campaign/kickstarter-page-draft.md](./campaign/kickstarter-page-draft.md) |
| Video script | [campaign/campaign-video-script.md](./campaign/campaign-video-script.md) |
| Rewards, FAQ, AI/privacy, risks | [campaign/rewards-faq-draft.md](./campaign/rewards-faq-draft.md) |
| Claim guardrails | [campaign/claim-evidence-matrix.md](./campaign/claim-evidence-matrix.md) |
| Pre-launch page and Notify me funnel | [campaign/prelaunch-page-pack.md](./campaign/prelaunch-page-pack.md) |
| Launch-day emails, comments, updates, and support | [campaign/launch-day-comms-pack.md](./campaign/launch-day-comms-pack.md) |

## Launch Readiness Gates

| Gate | Target |
| --- | --- |
| Technical | 5 working prototypes, A2 error <= 5 mm, Live Board P50 <= 150 ms, replay stable, source_refs traceability >= 90% |
| Market | Email list >= 1,000, Kickstarter followers >= 300, 8 public testimonials, education and business demo complete |
| Supply | BOM v0.2, two core supplier options, Surface material test pass, quoted assembly/production route |

## Verification

Current contract-level verification:

```bash
npm run verify
```

This locks the current local V1 demo baseline: root type/lint/test/build/pack/consumer checks, V1 project consistency verification, Kickstarter campaign claim verification, Obsidian V1 plugin verification, demo type/lint/test/build, Android/Paper asset verification, Runtime Sync smoke, AI Pen V1 smoke, RawPenFrame analyzer smoke, Capture Surface calibration analyzer smoke, Live Board latency analyzer smoke, reward pricing analyzer smoke, GTM metrics analyzer smoke, and demo-review analyzer smoke.

The V1 consistency verifier can also be run directly:

```bash
npm run verify:ai-pen-kickstarter
```

It checks that source package files, launch evidence templates, campaign drafts, core V1 boundary wording, project markdown links, analyzer scripts/fixtures, Kickstarter campaign claim verification, Obsidian V1 plugin verification, Android/Paper asset verification, and demo verification scripts remain aligned.

Campaign copy guardrail verification can also be run directly:

```bash
npm run verify:kickstarter-claims
```

It checks that campaign draft files keep required evidence-bound wording and do not accidentally publish unsupported claims such as any-whiteboard compatibility, perfect AI, zero latency, guaranteed pricing/delivery, e-paper base-kit inclusion, or Obsidian as the capture source of truth.

Obsidian plugin package verification can also be run directly after `npm run build`:

```bash
npm run verify:obsidian-v1-plugin
```

It checks the source and built plugin package, including manifest consistency, packaged SDK IIFE, runtime sync push/pull settings, hidden sidecar boundary, AI Pen knowledge projection description, and temp vault installer smoke that clears a legacy syncEndpoint into V1 runtime settings.

For presentation setup, use the shortcut that rebuilds the plugin before running the same package and temp vault smoke:

```bash
npm run obsidian:smoke
```

To generate an Obsidian vault that can be opened directly for demo:

```bash
npm run obsidian:demo-vault
```

Output:

```text
test-results/obsidian-demo-vault/
```

The vault contains the `inkloop-sync` plugin, an education projection hub, a meeting projection hub, source file/session frontmatter (`inkloop_projection_role: "source_file_unit"`), accepted/edited/follow-up notes, `inkloop://doc/...` backlinks, and intentionally excludes the dismissed meeting risk. It is a local demo vault built from demo data, not live Obsidian app proof or real hardware evidence.

Runtime Sync can also be smoke-tested directly without the browser or Obsidian app:

```bash
npm run demo:smoke:runtime-sync
```

Expected evidence includes `ok=true` and `release_path_used=false`, proving this is the Web/WebView/Paper sidecar sync path rather than a vault release.

Optional browser-level smoke:

```bash
npm run demo:smoke:ai-pen
```

The browser smoke imports a RawPenFrame JSONL fixture into the Live Board, pushes the same fixture through the `window.InkLoopRawPen` browser/native bridge, verifies both paths produce InkEvents that can reach `AI Graph Job completed`, clicks Education and Meeting flows, verifies Accept/Edit/Dismiss review gates, manually edits a reviewed body and confirms edited review body overrides are rendered into Obsidian projection, checks that a dismissed meeting risk is absent from projection, verifies visible source_refs status, and captures Obsidian projection screenshots under `test-results/ai-pen-browser-smoke/`. This proves the local hardware ingress boundary and fixture parser; it does not prove a specific BLE, Serial, Android native, or firmware transport.

Full local demo handoff verification:

```bash
npm run verify:local-demo-handoff
```

This is the presentation handoff gate. It runs Runtime Sync smoke, browser AI Pen smoke, Android/Paper debug APK assembly, Obsidian demo vault generation, and the local demo evidence bundle. It is intentionally heavier than `npm run verify` because it produces handoff artifacts instead of only checking the contract baseline.

Launch evidence intake package:

```bash
npm run launch:evidence:intake
```

This creates `test-results/ai-pen-launch-evidence-intake/YYYY-MM-DD/` with one folder per launch gate, raw/report/artifact subfolders, CSV/JSONL templates, analyzer commands, and the exact evidence-record fields to update. It is the handoff package for real rehearsals, supplier quote reviews, GTM exports, and Kickstarter page review. It is not launch proof until the generated folders contain real artifacts and the Markdown evidence records are updated.

Real launch evidence audit:

```bash
npm run kickstarter:ops-refresh
```

This is the weekly operating shortcut. It refreshes the launch evidence intake audit, evidence record update plan, evidence record apply dry run, launch evidence audit, action plan, critical path, weekly sprint, KPI dashboard, claim downgrade pack, proof-shot audit, public copy lock, supplier quote audit, page review audit, pre-launch page intake audit, pre-launch page pack, risk register, launch signoff audit, launch review pack, rehearsal pack, Launch operator pack, launch freeze pack, and launch-day command center, then writes `test-results/ai-pen-kickstarter-ops-refresh/README.md` and `ops-refresh.json`. It does not create a new proof-shot intake package, supplier quote intake package, page review intake package, or pre-launch page intake package and it is not launch approval.

Manual refresh chain:

```bash
npm run launch:evidence:audit
npm run launch:evidence:intake-audit
npm run launch:evidence:record-update-plan
npm run launch:evidence:apply-record-updates
npm run launch:action-plan
npm run launch:critical-path
npm run launch:weekly-sprint
npm run launch:kpi-dashboard
npm run kickstarter:claim-downgrade
npm run kickstarter:proof-shot-audit
npm run kickstarter:public-copy-lock
npm run kickstarter:supplier-quote-audit
npm run kickstarter:page-review-audit
npm run kickstarter:prelaunch-page-intake-audit
npm run kickstarter:prelaunch-page-pack
npm run kickstarter:risk-register
npm run kickstarter:launch-signoff-audit
npm run launch:review-pack
npm run kickstarter:rehearsal-pack
npm run kickstarter:proof-shot-intake
npm run launch:operator-pack
npm run kickstarter:launch-freeze-pack
npm run launch:evidence:audit:strict
```

The default audit writes a `not_launch_ready` or `launch_ready_evidence_present` report under `test-results/ai-pen-launch-evidence-audit/` without blocking local demo work. The strict mode is the pre-Kickstarter gate: it fails while real hardware, Capture Surface, education, meeting, GTM, supplier, or page-review evidence records still contain placeholders, unresolved artifact links, missing launch-positive decisions, or local analyzer reports that fail required `gate_checks`.

The Launch evidence intake audit writes `test-results/ai-pen-launch-evidence-intake-audit/README.md` and `report.json`. Run it after copying real raw files into the intake package and running analyzers, before editing evidence records. It checks non-template raw files, expected analyzer inputs/reports, analyzer `ok=true`, passing `gate_checks`, and supporting artifacts. It is not launch approval.

The evidence record update plan writes `test-results/ai-pen-launch-evidence-record-update-plan/README.md` and `record-update-plan.json`. Run it after the intake audit and before editing Markdown records. It converts ready intake gates into proposed field values and keeps blocked gates marked `blocked_do_not_update_record`, so template folders cannot be pasted into official evidence records.

The evidence record apply dry run writes `test-results/ai-pen-launch-evidence-record-apply/README.md` and `apply-report.json`. Run `npm run launch:evidence:apply-record-updates` before touching records; it previews only rows marked `ready_to_update_record`. After human review, `npm run launch:evidence:apply-record-updates:write` can write eligible path fields, but it never writes the `Decision` row. The human reviewer must still mark Pass, Conditional pass, or Fail manually.

The action plan writes `test-results/ai-pen-launch-action-plan/README.md` and `action-plan.json`. It turns the audit result into a weekly execution queue with priority, owner role, source milestone, due target, analyzer command, evidence record, and done condition for each not-ready launch gate.

The Kickstarter critical path writes `test-results/ai-pen-kickstarter-critical-path/README.md` and `critical-path.json`. It converts the 10 月 Kickstarter milestone dates into a countdown and risk-pressure view, showing due-this-week, at-risk, overdue, and red-gate pressure without converting project-management dates into launch evidence.

The Kickstarter weekly sprint writes `test-results/ai-pen-kickstarter-weekly-sprint/README.md` and `weekly-sprint.json`. It converts the critical path, red-gate action plan, and latest intake audit into the next 7-day execution queue, with current intake folder, expected raw/report targets, runnable analyzer commands, First 48 Hours capture plan, owner role, and done condition for each selected gate. It is an execution package only, not launch approval.

The Launch operator pack writes `test-results/ai-pen-launch-operator-pack/README.md` and `operator-pack.json`. It combines all 8 launch-gate field work orders, the First 48 Hours capture queue, the Pre-Launch / Notify me work order, raw/report/artifact file targets, evidence-record writeback guard, proof-shot capture queue, and post-capture command loop into one field handoff. It is not launch approval and it does not edit evidence records. Strict operator readiness requires both launch evidence readiness and `prelaunch_page_ready`; if launch evidence becomes ready while the pre-launch page is still blocked, the pack must stay red as `operator_pack_prelaunch_not_ready`.

The Launch KPI dashboard writes `test-results/ai-pen-launch-kpi-dashboard/README.md` and `dashboard.json`. It converts the source KR and weekly meeting board into a current-state dashboard, mapping AI Pen prototypes, Capture Surface, Live Board latency, trial users, testimonials, email list, Kickstarter followers, AI usefulness, source_refs, BOM, and page-claim readiness to the current launch evidence gates. It is a management dashboard only, not launch approval.

The Kickstarter claim downgrade pack writes `test-results/ai-pen-kickstarter-claim-downgrade/README.md` and `claim-downgrade.json`. It converts the claim evidence matrix and current launch audit into public-copy decisions: public claim allowed, guardrail copy allowed, demo wording only, or draft only until evidence. It is the required check before moving copy into Kickstarter, video narration, ads, landing pages, launch emails, social posts, or comment replies.

The Kickstarter public copy lock writes `test-results/ai-pen-kickstarter-public-copy-lock/README.md` and `copy-lock.json`. It combines the claim downgrade decisions, proof-shot audit, campaign drafts, and launch audit into a pre-publish lock for Kickstarter page, video narration, ads, landing pages, launch emails, social posts, and comment replies. It is not publish approval.

The Kickstarter supplier quote intake writes `test-results/ai-pen-kickstarter-supplier-quote-intake/YYYY-MM-DD/README.md` and `manifest.json`. It creates the concrete staging package for BOM rows, primary supplier quotes, backup supplier quotes, MOQ, lead time, quote artifacts, reward pricing analyzer output, and human supply review.

The Kickstarter supplier quote audit writes `test-results/ai-pen-kickstarter-supplier-quote-audit/README.md` and `report.json`. It checks the latest supplier quote intake for BOM completeness, confirmed quote coverage, backup supplier coverage, usable quote artifacts, a passing reward-pricing analyzer report, and human supply review. It is not reward pricing approval and template rows with TBD are expected to fail.

The Kickstarter page review intake writes `test-results/ai-pen-kickstarter-page-review-intake/YYYY-MM-DD/README.md` and `manifest.json`. It creates the concrete staging package for the formal Kickstarter preview URL, page section review, legal/privacy review, owner review, founder approval, screenshots, exports, and supporting artifacts.

The Kickstarter page review audit writes `test-results/ai-pen-kickstarter-page-review-audit/README.md` and `report.json`. It checks the latest page review intake for actual preview/legal links, reviewed page sections, AI/privacy and risk checks, and owner/founder review decisions. It is not publish approval and template rows with TBD are expected to fail.

The Kickstarter pre-launch page intake writes `test-results/ai-pen-kickstarter-prelaunch-page-intake/YYYY-MM-DD/README.md` and `manifest.json`. It creates the concrete staging package for Kickstarter preview URL, live pre-launch URL, screenshots, Notify me UTM rows, owner review, founder review, exports, and supporting artifacts.

The Kickstarter pre-launch page intake audit writes `test-results/ai-pen-kickstarter-prelaunch-page-intake-audit/README.md` and `report.json`. It checks the latest intake for actual URL values, resolved screenshots or artifacts, ready Notify me tracking rows, and owner/founder review decisions. It is not publish approval and template rows with TBD are expected to fail.

The Kickstarter pre-launch page pack writes `test-results/ai-pen-kickstarter-prelaunch-page/README.md` and `prelaunch-page.json`. It turns the pre-launch page draft and Notify me funnel into a readiness check for Kickstarter preview URL, pre-launch URL, hero asset, owner review, public copy lock, claim downgrade, launch evidence, pre-launch intake audit, and GTM tracking. It is not publish approval and does not count followers without real Kickstarter dashboard and GTM exports.

The Kickstarter risk register writes `test-results/ai-pen-kickstarter-risk-register/README.md` and `risk-register.json`. It converts `source/07_风险_验收指标_降级方案.md`, launch gates, weekly sprint, KPI dashboard, claim downgrade status, and public copy lock status into the weekly risk board, open P0 queue, next-week action, and downgrade path. It is a management view only, not launch approval.

The Kickstarter ops refresh writes `test-results/ai-pen-kickstarter-ops-refresh/README.md` and `ops-refresh.json`. It is the single weekly status refresh entrypoint and should be run before weekly review, rehearsal status review, campaign-copy review, supplier review, formal page/legal review, pre-launch page review, or launch signoff review. Strict mode is `npm run kickstarter:ops-refresh:strict` and should fail until launch evidence, P0 risk, final-cut proof-shot, public-copy lock, supplier quotes, page review, pre-launch page, launch signoff, launch freeze, and launch-day gates are ready.

The Kickstarter launch signoff audit writes `test-results/ai-pen-kickstarter-launch-signoff-audit/README.md` and `report.json`. It checks the final human Go/No-Go record for campaign, hardware, GTM, legal/privacy, operations, and founder signoffs, manual launch operator, launch-room coverage, final decision, and T-24h to T+24h task evidence. It is not launch approval; owners still update the signoff record manually after reviewing real evidence.

The Kickstarter launch freeze pack writes `test-results/ai-pen-kickstarter-launch-freeze/README.md` and `launch-freeze.json`. It is the final Go/No-Go evidence package before page freeze: it requires launch evidence, no open P0 risks, public copy lock, final-cut proof shots, Kickstarter preview link, page review audit, legal/privacy review, supplier quote audit, rewards/pricing evidence, GTM demand evidence, launch signoff audit, rehearsal handoff, operator closeout, weekly review agreement, and owner signoff from campaign, hardware, GTM, legal/privacy, operations, and founder/manual-launch roles. It is not launch approval by itself; the signoff record is the explicit human approval source.

The Weekly Launch Review Pack writes `test-results/ai-pen-launch-review-pack/README.md` and `review-pack.json`. It combines local demo evidence, browser smoke, launch evidence intake audit, evidence record update plan, evidence record apply dry run, Kickstarter critical path, Kickstarter weekly sprint, Launch KPI dashboard, Kickstarter claim downgrade pack, public copy lock, supplier quote audit, page review audit, Kickstarter risk register, launch audit, and the red-gate action plan for weekly review, while keeping the launch status explicit: local demo readiness is not Kickstarter readiness.

The Kickstarter rehearsal pack writes `test-results/ai-pen-kickstarter-rehearsal/README.md` and `rehearsal-pack.json`. It combines the local demo assets, campaign draft pack, proof-shot gaps, claim boundaries, public copy lock status, supplier quote audit, page review audit, and launch review status for external demo or campaign-video rehearsal; it is not publish approval.

The Kickstarter proof-shot intake writes `test-results/ai-pen-kickstarter-proof-shot-intake/YYYY-MM-DD/README.md` and `manifest.json`. It converts the campaign video final-cut checklist into one folder per proof shot, with shot logs, claim review CSVs, required artifacts, and linked evidence records for real filming sessions.

The Kickstarter proof-shot audit writes `test-results/ai-pen-kickstarter-proof-shot-audit/README.md` and `report.json`. Run it after filming to check whether shot logs, clip paths, public-approval decisions, and claim-review decisions are complete enough for final-cut review; strict mode is `npm run kickstarter:proof-shot-audit:strict`.

Demo evidence bundle:

```bash
npm run demo:evidence:bundle
```

This writes `test-results/ai-pen-demo-evidence/README.md` and `manifest.json`, collecting the latest browser smoke result, education/meeting projection screenshots, RawPenFrame ingress bridge source, M103 socket RawPenFrame adapter source, Android/Paper same-LAN import bridge source, Android/Paper debug APK hash, Android/Paper runtime boundary bridge/status assets, Obsidian packaged plugin artifacts including the V1 settings boundary panel, Kickstarter ops/pre-launch/operator boundary artifacts, and core project docs. It is a local software demo evidence package only; it does not claim real AI Pen hardware, physical Capture Surface, GTM, supplier, or Kickstarter publish readiness.

For live local presentation, start the local AI Pen V1 demo. It prefers port `8765`; if that port is already in use, use the URL printed by Vite.

```bash
npm run demo:ai-pen
```

Then open the printed URL, usually:

```text
http://127.0.0.1:8765/ai-pen-demo.html
```

Android/Paper verification command:

```bash
npm run android:assemble:debug
```

Verified on 2026-07-03 with Temurin JDK 17.0.19 installed under `/Users/ethan/.cache/inkloop-tools/jdks/temurin17` and Android SDK command-line tools under `/Users/ethan/Library/Android/sdk`. The command builds the Web demo, verifies Android/Paper assets, and runs Gradle `:app:assembleDebug`. Debug APK output:

The Android/Paper verifier also checks the same-LAN document import path: `window.InkLoopLanImport` starts a temporary upload page, writes incoming files into the app `lan-inbox`, and `mobile.html` exposes them in the 「Wi-Fi 收件箱」 before using the same local-first import path as local file browsing. This covers the reader-side “desktop uploads to e-paper over Wi-Fi” V1 demo path.

The verifier also checks the M103 vendor `hqunifiedsocket` RawPenFrame adapter: `src/capture/m103-raw-pen-adapter.ts` maps socket CSS points into `inkloop.ai_pen.v1` frames, `src/capture/ink.ts` publishes successful socket strokes, and `window.InkLoopM103RawPenCapture.exportJsonl()` provides a QA export path for hardware prototype evidence. This remains an adapter and evidence-capture boundary until a real device session is attached to the launch evidence records.

```text
examples/ai-annotation-demo/android/app/build/outputs/apk/debug/app-debug.apk
```
