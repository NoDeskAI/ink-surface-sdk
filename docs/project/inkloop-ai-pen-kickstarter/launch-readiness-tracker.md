# Kickstarter Launch Readiness Tracker

Date: 2026-07-03

This tracker converts the source-package gates into current evidence. It is the working board for deciding whether InkLoop AI Pen can credibly launch on Kickstarter by the end of October 2026.

Source basis:

- `source/05_目标与里程碑_10月底Kickstarter倒排.md`
- `source/06_Kickstarter_GTM与众筹页面方案.md`
- `source/07_风险_验收指标_降级方案.md`
- `source/03_各模块技术方案.md`
- `source/04_AI与InkGraph数据契约.md`

Status labels:

- `Verified`: current repository or external evidence proves the gate.
- `Demo-only`: local demo proves the shape, but not the real launch requirement.
- `Missing evidence`: requirement may be planned, but proof is absent.
- `Blocked until hardware`: cannot be proven without real pen, firmware, or Capture Surface.
- `External`: requires GTM, supplier, Kickstarter, user, or finance evidence outside this repository.

Evidence records:

- [Evidence index](./evidence/README.md)
- [Hardware prototype run log](./evidence/hardware-prototype-run-log.md)
- [Capture Surface calibration report](./evidence/capture-surface-calibration-report.md)
- [Live Board latency report](./evidence/live-board-latency-report.md)
- [Education demo review record](./evidence/education-demo-review.md)
- [Business meeting demo review record](./evidence/business-meeting-demo-review.md)
- [BOM and supplier tracker](./evidence/bom-supplier-tracker.md)
- [GTM metrics tracker](./evidence/gtm-metrics-tracker.md)
- [Kickstarter page and risk checklist](./evidence/kickstarter-page-risk-checklist.md)
- [Launch freeze signoff](./evidence/launch-freeze-signoff.md)

## Launch Window

| Item | Target |
| --- | --- |
| Preferred launch | 2026-10-27 or 2026-10-28 US time |
| Latest fallback | 2026-10-30 |
| Avoid | 2026-10-31 Saturday launch |
| Product promise | AI Pen + Capture Surface + Host App + Live Board + InkLoop Studio |
| First scenarios | Education board teaching and business whiteboard meetings |
| Explicit non-promise | Full e-paper tablet, arbitrary whiteboard compatibility, perfect formula/diagram recognition, deep meeting-tool integrations |

## Technical Gates

| Gate | Source target | Current evidence | Status | Next evidence needed |
| --- | --- | --- | --- | --- |
| G-Tech-1 Engineering prototypes | 5 AI Pen prototypes can demonstrate for 30 minutes | No real AI Pen prototype evidence in repo | Blocked until hardware | Fill [hardware prototype run log](./evidence/hardware-prototype-run-log.md) with inventory, firmware, 30-minute run logs, video, and replay links |
| G-Tech-2 Capture Surface accuracy | A2 Surface error <= 5mm; A3/A2 stable in >= 95% sessions | CSV/JSON calibration analyzer and sample fixture exist; no physical calibration report in repo | Demo-only | Fill [Capture Surface calibration report](./evidence/capture-surface-calibration-report.md) with real sample size, lighting, edge cases, raw traces, and analyzer report |
| G-Tech-3 Live Board latency | P50 <= 150ms, P95 <= 300ms | Live Board latency analyzer and sample fixture exist; no real BLE/wired render timing report | Demo-only | Fill [Live Board latency report](./evidence/live-board-latency-report.md) from real BLE or wired prototype logs |
| G-Tech-4 Session replay | Replay stable for education and meeting sessions | `ai-pen-demo.html` replay path exists; `npm run demo:verify` and AI Pen V1 smoke pass | Demo-only | 30-minute real session replay logs with no crash and complete event ledger |
| G-Tech-5 Source traceability | AI source_refs traceability >= 90%; schema pass >= 95% | `packages/runtime-schema` validators; `packages/knowledge-schema` promotion gate; AI Pen V1 smoke verifies source_refs and audio boundary | Verified for demo contract | Real-session traceability report across education and meeting samples |
| G-Tech-5a AI graph job boundary | AI outputs must be generated from retained board evidence before review | Local `AiGraphJob` contract, Web demo queue, and `npm run demo:smoke:ai-graph-worker` show completed/retried/rejected worker paths before LessonGraph/MeetingGraph candidates enter review | Demo-only | Production hosted worker deployment, auth, production observability, and real-session load tests |
| G-Tech-6 Local-first safety | Network loss does not lose strokes | Offline/runtime packages and runtime sync smoke exist | Demo-only | Real host test: capture while offline, reconnect, verify no stroke loss |
| G-Tech-7 Education output | Editable lesson notes from board teaching | Education LessonGraph smoke promotes formula_step and concept; demo review analyzer validates simulated teacher-review rows; no real teacher session evidence | Demo-only | Fill [education demo review record](./evidence/education-demo-review.md) from a 5-8 minute real lesson with raw session, video, exported note, reviewer table, and analyzer report |
| G-Tech-8 Meeting output | Actions, decisions, risks, and diagram beta from board meetings | MeetingGraph smoke promotes decision/action/diagram; demo review analyzer validates simulated meeting-review rows and blocks audio-only items; no real meeting evidence | Demo-only | Fill [business meeting demo review record](./evidence/business-meeting-demo-review.md) from a real whiteboard meeting with raw session, video, exported note, reviewer table, and analyzer report |

## Product Scope Gates

| Gate | Source target | Current evidence | Status | Next evidence needed |
| --- | --- | --- | --- | --- |
| Scope freeze | Only promise AI Pen + Capture Surface + App; e-paper moved to roadmap | Root README, project README, architecture, Android docs, runbook all state e-paper is second-loop | Verified |
| Capture Surface requirement | Page must clearly say Capture Surface is required | Project docs and runbook state this | Verified in docs | Kickstarter page draft must carry the same FAQ wording |
| Single-pen core promise | Multi-pen and multi-color are beta/future | Source docs and project docs state this boundary | Verified in docs | Reward tiers must not sell multi-pen as base commitment |
| AI reviewability | AI notes/actions are editable and reviewable | Web demo Accept/Edit/Dismiss; KnowledgeObject promotion only after accepted/edited/follow_up | Verified for demo contract | Real user review metrics: accept/edit/follow-up rate |
| Meeting audio boundary | Audio/subtitles are context, not main evidence path | Runtime validator and knowledge tests prevent audio-only meeting promotion | Verified |
| Obsidian boundary | Obsidian receives projections grouped by source file/session units with backlinks, not arbitrary InkEvent truth | Adapter README, plugin settings, project docs, smoke output | Verified |

## GTM And Market Gates

| Gate | Source target | Current evidence | Status | Next evidence needed |
| --- | --- | --- | --- | --- |
| Email list | >= 1,000 before launch; >= 500 by 9/30 | GTM metrics analyzer and sample checkpoint fixture exist; no real CRM export in repo | External | Weekly CRM/export snapshot in [GTM metrics tracker](./evidence/gtm-metrics-tracker.md) |
| Kickstarter followers | >= 300 before launch; >= 150 by 9/30 | GTM metrics analyzer and sample checkpoint fixture exist; no real Kickstarter dashboard export in repo | External | Kickstarter dashboard export in [GTM metrics tracker](./evidence/gtm-metrics-tracker.md) |
| Public testimonials | >= 8 public testimonials | GTM metrics analyzer models testimonial target; no real consent-backed testimonial evidence in repo | External | Consent-backed quote list in [GTM metrics tracker](./evidence/gtm-metrics-tracker.md) |
| First-day support list | >= 50 likely first-day backers | GTM metrics analyzer models first-day support target; no real launch list evidence in repo | External | Named or segmented commitment evidence in [GTM metrics tracker](./evidence/gtm-metrics-tracker.md) |
| Education demo assets | 1 complete 5-8 minute demo minimum; ideal 3 samples | Simulated demo review analyzer exists; no recorded real prototype education video or reviewed teacher session | Missing evidence | Recorded real prototype education video, exported lesson output, reviewer CSV, and analyzer report linked from [education demo review](./evidence/education-demo-review.md) |
| Business demo assets | 1 complete meeting whiteboard demo minimum; ideal 3 samples | Simulated demo review analyzer exists; no recorded real prototype meeting video or reviewed business session | Missing evidence | Recorded real prototype meeting video, export artifacts, reviewer CSV, and analyzer report linked from [business meeting demo review](./evidence/business-meeting-demo-review.md) |
| Kickstarter page completion | >= 90% by 9/30 | First campaign draft pack exists under [campaign/](./campaign/); publish evidence still missing | Demo-only / Missing publish evidence | Fill real proof links and outside review in [Kickstarter page checklist](./evidence/kickstarter-page-risk-checklist.md) |

## Supply And Finance Gates

| Gate | Source target | Current evidence | Status | Next evidence needed |
| --- | --- | --- | --- | --- |
| BOM v0.2 | Starter Kit rough BOM locked; BOM >= 80% by 9/30 | Reward pricing analyzer and sample BOM fixture exist; no real supplier BOM artifact in repo | External | BOM lines, unit cost, MOQ, lead time, supplier, and confidence in [BOM and supplier tracker](./evidence/bom-supplier-tracker.md) |
| Supplier options | >= 2 suppliers or backups for core components and Surface | No supplier quote evidence in repo | External | Quote PDFs/emails linked from [BOM and supplier tracker](./evidence/bom-supplier-tracker.md) |
| Surface material test | Ink, glare, wipe, calibration, and material test pass | No material report in repo | Blocked until hardware | Material and calibration evidence linked from [Capture Surface calibration report](./evidence/capture-surface-calibration-report.md) |
| Assembly route | Production/assembly route has quote and lead time | No production route evidence in repo | External | EVT/DVT/PVT plan, assembly quote, and test fixture plan linked from [BOM and supplier tracker](./evidence/bom-supplier-tracker.md) |
| Pricing model | Reward price includes BOM, assembly, packaging, shipping, tax, failure buffer, Kickstarter/Stripe fees, AI credits | Reward pricing analyzer exists; no real supplier-backed pricing report | External | Real BOM CSV and analyzer output linked from [BOM and supplier tracker](./evidence/bom-supplier-tracker.md) |
| Certification/safety | Battery/charging risks controlled with mature solution | No certification plan evidence in repo | External | Battery/charging module decision and disclosure tracked in [Kickstarter page checklist](./evidence/kickstarter-page-risk-checklist.md) |

## Current Repository Evidence

| Evidence | Command or file | What it proves | Limit |
| --- | --- | --- | --- |
| Full verification | `npm run verify` | check, lint, V1 consistency verifier, Kickstarter campaign claim verifier, root tests, build, Obsidian V1 plugin verifier, pack check, consumer verification, demo verification, Android/Paper asset verifier, Runtime Sync smoke, AI Pen V1 smoke, AI Pen evidence smoke, Capture Surface evidence smoke, Live Board latency evidence smoke, Reward pricing evidence smoke, GTM metrics evidence smoke, Demo review evidence smoke | Software/demo contract baseline only; use local handoff verification for browser screenshots, APK assembly, and evidence bundle |
| Local demo handoff verification | `npm run verify:local-demo-handoff` | Runs Runtime Sync smoke, browser AI Pen smoke, Android/Paper debug APK assembly, Obsidian demo vault generation, Kickstarter ops refresh, and demo evidence bundle generation | Local presentation package plus current launch-boundary snapshot only; still not launch evidence |
| Launch evidence intake | `npm run launch:evidence:intake` | Creates a dated staging package with one folder per launch gate, raw/report/artifact folders, CSV/JSONL templates, analyzer commands, and evidence-record field mapping | Intake structure only; real artifacts and evidence records still decide launch readiness |
| Launch evidence intake audit | `npm run launch:evidence:intake-audit` / `npm run launch:evidence:intake-audit:strict` | Reads the latest intake package and reports whether non-template raw files, expected analyzer inputs, analyzer JSON reports, passing `gate_checks`, and supporting artifacts are staged before evidence records are edited | Staging QA only; it does not replace launch evidence audit or strict launch gate |
| Evidence record update plan | `npm run launch:evidence:record-update-plan` / `npm run launch:evidence:record-update-plan:strict` | Converts the latest intake audit into `test-results/ai-pen-launch-evidence-record-update-plan/` with proposed Markdown evidence-record field values only for gates marked `ready_to_update_record`, while blocked gates stay `blocked_do_not_update_record` | Writeback guardrail only; it does not edit records or prove launch evidence |
| Evidence record apply dry run | `npm run launch:evidence:apply-record-updates` / `npm run launch:evidence:apply-record-updates:write` | Reads the update plan and writes `test-results/ai-pen-launch-evidence-record-apply/`, previewing eligible path-field writes before the explicit write command updates Markdown evidence records | Controlled writeback only; human `Decision` rows stay manual and this does not prove launch evidence |
| Launch evidence audit | `npm run launch:evidence:audit` / `npm run launch:evidence:audit:strict` | Reads the real evidence records and reports `not_launch_ready` until hardware, Capture Surface, education, meeting, GTM, supplier, and Kickstarter page records are filled with resolvable raw artifact links, local analyzer reports passing required `gate_checks`, and launch-positive decisions | Default audit is non-blocking; strict mode is the pre-Kickstarter launch gate |
| Launch action plan | `npm run launch:action-plan` | Converts the latest launch audit report into `test-results/ai-pen-launch-action-plan/` with priority, owner role, source milestone, due target, analyzer command, evidence record, and done condition for every red gate | Execution queue only; it does not replace evidence records or strict launch audit |
| Kickstarter critical path | `npm run launch:critical-path` / `npm run launch:critical-path:strict` | Converts the source milestone dates and red-gate action plan into `test-results/ai-pen-kickstarter-critical-path/`, showing days to preferred launch, due-this-week items, at-risk milestones, overdue milestones, and gate pressure | Countdown/project-management view only; it does not prove launch evidence |
| Kickstarter weekly sprint | `npm run launch:weekly-sprint` / `npm run launch:weekly-sprint:strict` | Converts the Kickstarter critical path, red-gate action plan, and latest intake audit into `test-results/ai-pen-kickstarter-weekly-sprint/` with next 7-day tasks, current intake folder, expected raw/report targets, runnable analyzer commands, First 48 Hours capture plan, evidence record, owner role, and done condition | Execution queue only; it does not prove launch evidence |
| Launch operator pack | `npm run launch:operator-pack` / `npm run launch:operator-pack:strict` | Combines the latest action plan, weekly sprint, intake audit, evidence record update plan, launch audit, proof-shot audit, and Kickstarter pre-launch page pack into `test-results/ai-pen-launch-operator-pack/` with First 48 Hours capture sessions, all 8 launch-gate field work orders, Pre-Launch / Notify me work order, raw/report/artifact file targets, after-capture command loop, evidence-record writeback guard, and proof-shot capture queue | Field-operator handoff only; strict readiness requires launch evidence readiness plus `prelaunch_page_ready` and does not approve launch |
| Launch KPI dashboard | `npm run launch:kpi-dashboard` / `npm run launch:kpi-dashboard:strict` | Converts the source KR board and current launch gates into `test-results/ai-pen-launch-kpi-dashboard/`, showing metric current state, target, pressure, evidence state, and next-week action | Weekly management view only; demo fixtures do not count as real KPI values |
| Kickstarter claim downgrade pack | `npm run kickstarter:claim-downgrade` / `npm run kickstarter:claim-downgrade:strict` | Converts the claim evidence matrix and current launch evidence audit into `test-results/ai-pen-kickstarter-claim-downgrade/`, classifying each claim as public allowed, guardrail copy allowed, demo wording only, or draft-only until evidence | Public-copy decision guardrail only; it is not publish approval |
| Kickstarter public copy lock | `npm run kickstarter:public-copy-lock` / `npm run kickstarter:public-copy-lock:strict` | Combines claim downgrade decisions, proof-shot audit, launch evidence audit, and campaign draft sources into `test-results/ai-pen-kickstarter-public-copy-lock/` for page, video, ad, landing-page, launch email, social, and comment copy review | Pre-publish copy lock only; it is not publish approval |
| Kickstarter supplier quote intake / Supplier quote audit | `npm run kickstarter:supplier-quote-intake` / `npm run kickstarter:supplier-quote-audit` | Creates and audits `test-results/ai-pen-kickstarter-supplier-quote-intake/YYYY-MM-DD/` with BOM rows, primary/backup supplier quote rows, quote artifacts, reward-pricing analyzer output, and human supply review | Supplier/pricing staging QA only; it is not reward pricing approval |
| Kickstarter page review intake / Page review audit | `npm run kickstarter:page-review-intake` / `npm run kickstarter:page-review-audit` | Creates and audits `test-results/ai-pen-kickstarter-page-review-intake/YYYY-MM-DD/` with formal preview URL rows, page-section review rows, AI/privacy and legal/privacy checks, screenshots, exports, and owner/founder review | Formal page/legal staging QA only; it is not publish approval |
| Kickstarter pre-launch page intake | `npm run kickstarter:prelaunch-page-intake` / `npm run kickstarter:prelaunch-page-intake-audit` | Creates and audits `test-results/ai-pen-kickstarter-prelaunch-page-intake/YYYY-MM-DD/` with preview/live URL rows, Notify me UTM rows, screenshots, exports, owner review, and founder review | Intake and staging QA only; template rows with TBD do not count as page readiness |
| Kickstarter pre-launch page pack | `npm run kickstarter:prelaunch-page-pack` / `npm run kickstarter:prelaunch-page-pack:strict` | Turns the pre-launch page draft, pre-launch page intake audit, and Notify me funnel into `test-results/ai-pen-kickstarter-prelaunch-page/`, checking page fields, preview URL, pre-launch URL, owner review, public copy lock, claim downgrade, launch evidence, intake readiness, and GTM readiness | Pre-launch readiness check only; it is not publish approval and does not prove demand without real Kickstarter dashboard and GTM exports |
| Kickstarter risk register | `npm run kickstarter:risk-register` / `npm run kickstarter:risk-register:strict` | Converts the source risk matrix, current launch gates, weekly sprint, Launch KPI dashboard, claim downgrade pack, and public copy lock into `test-results/ai-pen-kickstarter-risk-register/` with weekly risk board, open P0 queue, next-week action, and downgrade path | P0 management view only; it is not launch approval |
| Kickstarter launch signoff audit | `npm run kickstarter:launch-signoff-audit` / `npm run kickstarter:launch-signoff-audit:strict` | Reads [launch-freeze-signoff.md](./evidence/launch-freeze-signoff.md) and writes `test-results/ai-pen-kickstarter-launch-signoff-audit/`, checking owner signoffs, manual launch operator, launch-room coverage, final decision, and T-24h to T+24h task evidence | Human signoff QA only; it is not launch approval and owners must update the record manually |
| Kickstarter ops refresh | `npm run kickstarter:ops-refresh` / `npm run kickstarter:ops-refresh:strict` | Runs the weekly operating chain and writes `test-results/ai-pen-kickstarter-ops-refresh/` with command results, launch snapshot, red-gate actions, risk state, rehearsal state, public-copy lock state, supplier quote state, page review state, pre-launch intake/page state, proof-shot audit state, launch-signoff state, launch-freeze state, and launch-day command-center state | Weekly refresh shortcut only; strict mode should fail until launch evidence, P0 risk, final-cut proof-shot, public-copy lock, supplier quotes, page review, pre-launch intake, pre-launch page, launch signoff, launch-freeze, and launch-day command-center gates are ready |
| Kickstarter launch freeze pack | `npm run kickstarter:launch-freeze-pack` / `npm run kickstarter:launch-freeze-pack:strict` | Combines launch audit, public copy lock, risk register, proof-shot audit, supplier quote audit, page review audit, launch signoff audit, Kickstarter page checklist, BOM/supplier tracker, GTM tracker, launch freeze signoff, rehearsal pack, operator pack, and launch review pack into `test-results/ai-pen-kickstarter-launch-freeze/` | Final Go/No-Go evidence package only; it requires explicit owner signoff and is not launch approval by itself |
| Kickstarter launch-day command center | `npm run kickstarter:launch-day-command-center` / `npm run kickstarter:launch-day-command-center:strict` | Combines launch freeze, launch signoff audit, owner signoff, GTM/page/campaign sources, public copy lock, risk register, proof-shot audit, and the source T-24h to T+24h launch script into `test-results/ai-pen-kickstarter-launch-day-command-center/` | Launch-day operating board only; Kickstarter launch is a manual action and still requires human Go/No-Go approval |
| Launch review pack | `npm run launch:review-pack` | Combines local demo evidence, browser smoke, launch evidence intake audit, evidence record update plan, evidence record apply dry run, Kickstarter critical path, Kickstarter weekly sprint, Launch KPI dashboard, Kickstarter claim downgrade pack, public copy lock, supplier quote audit, page review audit, Kickstarter risk register, launch audit status, and `test-results/ai-pen-launch-action-plan/` into `test-results/ai-pen-launch-review-pack/` for the Weekly Launch Review Pack | Weekly review handoff only; local demo readiness remains separate from Kickstarter readiness |
| Kickstarter rehearsal pack | `npm run kickstarter:rehearsal-pack` | Combines local demo assets, Android/Paper APK, Obsidian demo vault, campaign draft pack, proof-shot gaps, claim boundaries, public copy lock status, supplier quote audit, page review audit, and launch review status into `test-results/ai-pen-kickstarter-rehearsal/` | External-demo and campaign-video rehearsal handoff only; it is not publish approval |
| Kickstarter proof-shot intake | `npm run kickstarter:proof-shot-intake` | Converts the campaign-video final-cut checklist into `test-results/ai-pen-kickstarter-proof-shot-intake/YYYY-MM-DD/` with one folder per proof shot, shot logs, claim-review CSVs, required artifacts, and linked evidence records | Filming intake only; shot folders become evidence only after real artifacts and decisions are linked from evidence records |
| Kickstarter proof-shot audit | `npm run kickstarter:proof-shot-audit` / `npm run kickstarter:proof-shot-audit:strict` | Reads the latest proof-shot intake and reports whether usable clips, public approvals, required visibility fields, and claim-review decisions are complete enough for final-cut review | Final-cut proof-shot check only; it does not replace strict launch audit or outside review |
| V1 consistency verifier | `npm run verify:ai-pen-kickstarter` | Validates source package files, readiness/evidence/campaign docs, V1 boundary wording, legacy e-paper boundary wording, analyzer scripts and fixtures, demo verify smoke coverage, stale verification text, and project markdown links | Repository consistency only; does not prove real hardware, GTM, supplier, or campaign evidence |
| Kickstarter campaign claim verifier | `npm run verify:kickstarter-claims` | Checks campaign README, page draft, rewards/FAQ, video script, claim evidence matrix, risk checklist, downgrade rules, required non-claims, and unsupported public-claim phrases such as any-whiteboard, perfect AI, zero latency, guaranteed delivery, e-paper base kit, and Obsidian-as-truth | Copy safety only; does not provide missing real evidence |
| AI Pen V1 smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-v1` | Built Web/Mobile/AI Pen entries exist; Education and Meeting projection works; audio-only meeting boundary enforced | No browser interaction or real pen |
| Runtime Sync smoke | `npm run demo:smoke:runtime-sync` | Pushes a Web/WebView/Paper-shaped annotation event into an Obsidian-shaped sidecar store, then pushes an Obsidian plugin block update back to Web, verifies event ids, cursors, echo skipping, no conflicts, `ok=true`, and `release_path_used=false` | Local sidecar/runtime transport only; no production cloud or live Obsidian app |
| AI Pen browser smoke | `npm run demo:smoke:ai-pen` | Headless Chrome imports a RawPenFrame JSONL fixture, pushes the same fixture through `window.InkLoopRawPen`, verifies imported/bridge-pushed InkEvents can produce LessonGraph through `AI Graph Job completed`, checks the `V1 Launch Chain` panel keeps AI Pen + Capture Surface, Hardware Ingress, InkGraph output, Meeting Event Marks, user review gate, Obsidian projection-only role, `Launch Ops Queue: 86 P0 inputs`, and launch-freeze Go/No-Go boundary visible, clicks Education and Meeting flows, verifies Accept/Edit/Dismiss, manually edits a reviewed body and confirms edited review body is rendered into projection, confirms meeting action keeps board/ink evidence while retaining audio context only as optional context, confirms a dismissed risk is absent from projection, verifies SourceRefs validator and Obsidian projection, captures screenshots and `result.json` under `test-results/ai-pen-browser-smoke/` | Fixture import plus local browser/native bridge; real BLE/firmware transport and physical hardware log still missing |
| AI Graph worker smoke | `npm run demo:smoke:ai-graph-worker` | Writes `test-results/ai-graph-worker-smoke/worker-report.json`, completed job JSONL, and rejected job JSONL; verifies completed teach/meeting jobs, retry telemetry, and audio-only rejection | Local worker contract only; not hosted cloud proof |
| Demo evidence bundle | `npm run demo:evidence:bundle` | Builds `test-results/ai-pen-demo-evidence/manifest.json` and README from browser smoke output, AI Graph worker report, projection screenshots, RawPenFrame ingress bridge source, Android/Paper APK, Android/Paper runtime boundary artifacts, Obsidian package/settings boundary, and V1 docs | Local software demo handoff only; not launch evidence |
| Obsidian V1 plugin verifier | `npm run verify:obsidian-v1-plugin` / `npm run obsidian:smoke` | Confirms source/dist Obsidian plugin manifests match, AI Pen knowledge projection description is present, packaged plugin files and SDK IIFE are aligned, runtime push/pull settings exist, hidden sidecar boundaries remain, the settings page exposes the `InkLoop AI Pen V1 boundary` panel plus source-unit boundary, stale capture-truth wording is absent, and temp vault installer smoke clears a legacy syncEndpoint into V1 runtime settings. `obsidian:smoke` rebuilds the package before running the verifier. | Does not replace live Obsidian app smoke |
| Obsidian demo vault | `npm run obsidian:demo-vault` | Installs `inkloop-sync`, writes education and meeting projection hubs, accepted/edited/follow-up notes, and backlinks under `test-results/obsidian-demo-vault/`; dismissed meeting risk is absent | Demo data only; not live user vault proof |
| Android/Paper asset verifier | `npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets` | Syncs `dist/` into Android assets, verifies `ai-pen-demo.html`, `index.html`, `mobile.html`, referenced JS/CSS, PDF runtime assets, Android label, `mobile.html` launch URL, RawPenFrame JSON/JSONL file chooser support for asset QA, the `InkLoopRuntime` in-APK local demo-loop manifest, M103 `hqunifiedsocket` -> RawPenFrame adapter, `window.InkLoopM103RawPenCapture` JSONL export path, and clean InkLoop Paper local-first boundary text | Does not prove real e-paper refresh, BLE/firmware transport, or device performance |
| RawPenFrame analyzer smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-evidence` | Validates JSONL RawPenFrame contract, stroke completeness, and pen-to-host latency statistics from sample run log | Sample fixture only; real hardware log still missing |
| Capture Surface analyzer smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:capture-surface-evidence` | Validates calibration point table, computes per-point error, P50/P95/max error, per-run stability, and A2/A3 edge/corner coverage gates | Sample fixture only; real physical calibration still missing |
| Live Board latency analyzer smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:live-board-latency-evidence` | Validates render timing table, computes pen-to-host, host-to-InkEvent, InkEvent-to-render, and end-to-end P50/P95/P99 latency gates | Sample fixture only; real BLE/wired timing still missing |
| Reward pricing analyzer smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:reward-pricing-evidence` | Validates BOM/pricing table, computes landed cost, minimum pledge price, fee buffers, BOM completeness, quote coverage, and backup supplier coverage | Sample fixture only; real supplier quotes still missing |
| GTM metrics analyzer smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:gtm-metrics-evidence` | Validates weekly GTM snapshot table, computes latest metrics, week-over-week deltas, 9/30 checkpoint status, launch target progress, and education/business segment split | Sample fixture only; real CRM/Kickstarter/testimonial exports still missing |
| Demo review analyzer smoke | `npm --workspace ./examples/ai-annotation-demo run smoke:demo-review-evidence` | Validates reviewed education and meeting candidate tables, promoted-item source_refs, education formula/concept usability, meeting decision/action/risk/diagram usability, and audio-only blocking | Sample fixture only; real education and meeting recordings still missing |
| Campaign draft pack | [campaign/](./campaign/) + `npm run verify:kickstarter-claims` | Page draft, 90-second video script, rewards/FAQ/risk copy, claim evidence matrix, and automated unsupported-claim guard exist | Draft only; real hardware, GTM, supply, and legal review still missing |
| Runtime schema tests | `packages/runtime-schema/src/runtime-schema.test.ts` | RawPenFrame, InkEvent, AiGraphJob, LessonGraph, MeetingGraph, source_refs validators | Contract only |
| Knowledge projection tests | `packages/knowledge-schema/src/index.test.ts` | Accepted/edited/follow_up promotion and audio boundary | Contract only |
| Obsidian adapter tests | `packages/adapter-obsidian/src/index.test.ts` | Clean Markdown callouts and backlinks | Adapter only |
| Android APK build | `npm run android:assemble:debug` | Builds the Web demo, verifies Android/Paper assets, uses the local project JDK when needed, and produces the Android/Paper WebView debug APK | Not real e-paper refresh verification |
| Demo runbook | `demo-runbook.md` | Manual Web, Obsidian, Android/Paper demo path and non-claims | Must still be run live for presentations |

## Red / Yellow / Green Summary

| Area | Current color | Rationale |
| --- | --- | --- |
| Repository strategy alignment | Green | Docs and package metadata now frame the repo as AI Pen system, not standalone SDK |
| Legacy e-paper boundary | Green | `docs/project/inkloop-eink/` is explicitly marked historical / InkLoop Paper second-loop material, and the V1 verifier blocks old e-paper launch wording from active AI Pen launch docs |
| Local software demo | Green | `npm run verify` passes and AI Pen V1 plus launch-evidence analyzer smokes are in standard demo verification |
| AI/InkGraph contracts | Green for demo, Yellow for real data | Validators and tests exist; real session traceability report missing |
| Web/Desktop host | Yellow | Simulated capture demo, RawPenFrame file import, and `InkLoopRawPen` browser/native ingress bridge work; real BLE/firmware transport and physical render timing evidence missing |
| Android/Paper | Yellow | APK builds, Android/Paper asset verifier passes, `mobile.html` runs as a clean local-first reader/marker with a hidden `InkLoopRuntime` demo-loop manifest, same-LAN `InkLoopLanImport` upload can feed the mobile reader inbox, and M103 vendor socket points can be exported as RawPenFrame JSONL for QA; true e-paper refresh/device QA and launch evidence runs are missing |
| Obsidian | Green for projection | Projection tests, source file/session unit frontmatter, plugin package build, settings-page V1 boundary panel with `Launch Ops Queue: 86 P0 inputs`, temp vault installer smoke, and Obsidian V1 plugin verifier pass; arbitrary reverse parsing correctly excluded |
| Hardware | Red | No real prototype, calibration, or firmware evidence in repo |
| Capture Surface | Red | Calibration analyzer exists; no real material, glare, wipe, or A2/A3 physical error evidence in repo |
| GTM | Red | Campaign draft pack, pre-launch page pack, claim guard, and GTM analyzer exist; no real pre-launch URL, email list, followers, testimonials, or first-day list evidence |
| Supply/finance | Red | Reward pricing analyzer exists; no real BOM, supplier quotes, assembly route, or supplier-backed reward pricing evidence |

## Weekly Review Questions

1. Can we show a real AI Pen writing on Capture Surface this week, or only a simulator?
2. What is the latest measured Live Board P50 and P95 from real transport?
3. What percentage of reviewed AI outputs have valid source_refs?
4. What is the count of education users, business teams, public testimonials, email leads, and KS followers?
5. Which supplier quote or BOM line changed this week?
6. Which Kickstarter page claims need to be removed, downgraded, or backed by fresh evidence?

## Next Evidence To Add

| Priority | Evidence | Owner placeholder | Due target |
| --- | --- | --- | --- |
| P0 | Real pen frame ingestion log: pen down/up + coordinates + firmware version | Hardware / Runtime | [hardware-prototype-run-log.md](./evidence/hardware-prototype-run-log.md) |
| P0 | A2 Capture Surface calibration report with <= 5mm target | Hardware | [capture-surface-calibration-report.md](./evidence/capture-surface-calibration-report.md) |
| P0 | Live Board latency report from real BLE or wired prototype | Runtime | [live-board-latency-report.md](./evidence/live-board-latency-report.md) |
| P0 | 5-8 minute education demo recording, generated lesson notes, reviewer CSV, and analyzer report | Product / AI | [education-demo-review.md](./evidence/education-demo-review.md) |
| P0 | Business whiteboard meeting recording, generated decisions/actions/risks, reviewer CSV, and analyzer report | Product / AI | [business-meeting-demo-review.md](./evidence/business-meeting-demo-review.md) |
| P0 | BOM v0.2 and two supplier options for core components/Surface | Ops / Hardware | [bom-supplier-tracker.md](./evidence/bom-supplier-tracker.md) |
| P0 | Kickstarter pre-launch page draft with risk and AI/privacy disclosure | GTM | [kickstarter-page-risk-checklist.md](./evidence/kickstarter-page-risk-checklist.md) |
| P0 | Email list, KS follower, testimonial, and first-day support evidence | GTM | [gtm-metrics-tracker.md](./evidence/gtm-metrics-tracker.md) |
