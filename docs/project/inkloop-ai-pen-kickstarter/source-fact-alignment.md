# InkLoop AI Pen Source Fact Alignment

Date: 2026-07-03

This matrix is the traceability layer between the uploaded source package and the current repository implementation. Treat [`source/`](./source/) as the unique current factual basis until a newer source package explicitly supersedes it.

Derived docs, demo UI, Android/Paper wording, Obsidian plugin wording, scripts, and generated artifacts must not override the source package. If a derived artifact conflicts with the source package, the source package wins and the derived artifact must be updated.

## Source Package Files

| Source file | Controls |
| --- | --- |
| [`00_README.md`](./source/00_README.md) | Strategic pivot from e-paper-first device to InkLoop AI Pen Kickstarter package |
| [`01_产品战略与Kickstarter总方案.md`](./source/01_产品战略与Kickstarter总方案.md) | Hero product, target users, reward boundaries, and non-claims |
| [`02_系统架构设计.md`](./source/02_系统架构设计.md) | Pen-first Surface Intelligence OS, runtime layers, and reuse relationship with InkLoop Paper |
| [`03_各模块技术方案.md`](./source/03_各模块技术方案.md) | AI Pen hardware, Capture Surface, Host, InkGraph, AI, App, Cloud, and module priority |
| [`04_AI与InkGraph数据契约.md`](./source/04_AI与InkGraph数据契约.md) | RawPenFrame, Stroke, InkEvent, BoardGraph/InkGraph, SceneView, LessonGraph, MeetingGraph, KnowledgeObject, and source_refs |
| [`05_目标与里程碑_10月底Kickstarter倒排.md`](./source/05_目标与里程碑_10月底Kickstarter倒排.md) | 2026-10 launch window, KRs, gates, weekly milestones, and launch evidence thresholds |
| [`06_Kickstarter_GTM与众筹页面方案.md`](./source/06_Kickstarter_GTM与众筹页面方案.md) | Kickstarter page story, video scripts, rewards, FAQ, AI/privacy disclosure, and GTM metrics |
| [`07_风险_验收指标_降级方案.md`](./source/07_风险_验收指标_降级方案.md) | Technical, supply, GTM, claim, and launch downgrade rules |
| [`08_依据与变更记录.md`](./source/08_依据与变更记录.md) | Evidence basis, external Kickstarter references, and decision log |
| [`InkLoop_AI_Pen_Kickstarter_方案合集.md`](./source/InkLoop_AI_Pen_Kickstarter_方案合集.md) | Combined read-through copy of the current source package |

## Non-Negotiable Source Facts

| Fact | Current repo alignment |
| --- | --- |
| Kickstarter hero product is InkLoop AI Pen Starter Kit: real dry-erase AI Pen, Capture Surface, Host App, Live Board, InkLoop Studio, education notes, and business meeting outputs | [README](../../../README.md), [project README](./README.md), [demo runbook](./demo-runbook.md), [AI Pen demo](../../../examples/ai-annotation-demo/src/ai-pen-demo.ts) |
| Launch target is the end of October 2026, with preferred US launch dates 2026-10-27 or 2026-10-28, fallback no later than 2026-10-30 | [launch readiness tracker](./launch-readiness-tracker.md), [completion audit](./completion-audit.md), launch critical path and launch-freeze scripts |
| First scenes are education board teaching and business whiteboard meetings | [project README](./README.md), [demo runbook](./demo-runbook.md), browser smoke, demo review analyzer |
| E-paper is InkLoop Paper / second product loop and must not be the October 2026 Kickstarter base hardware promise | [native Android README](../../../native/android/README.md), [Android integration doc](../../../examples/ai-annotation-demo/android/INTEGRATION.md), [mobile runtime boundary](../../../examples/ai-annotation-demo/mobile.html), Android/Paper verifier |
| Truth source is the append-only pen/ink event ledger, not Obsidian Markdown, exported files, screenshots, or AI prose | [architecture](../../architecture.md), runtime schema tests, Runtime Sync smoke, Obsidian V1 plugin verifier |
| V1 data chain is RawPenFrame -> Stroke -> InkEvent -> HMP / Evidence Builder -> BoardObject -> BoardGraph / InkGraph -> LessonGraph or MeetingGraph -> KnowledgeObject | [runtime schema](../../../packages/runtime-schema/src/index.ts), [knowledge schema](../../../packages/knowledge-schema/src/index.ts), [AI Pen demo](../../../examples/ai-annotation-demo/src/ai-pen-demo.ts), AI Pen V1 smoke |
| Meeting audio, subtitles, agenda, speaker, and timeline data are optional context only; board/ink events are required evidence for MeetingGraph output | [runtime schema tests](../../../packages/runtime-schema/src/runtime-schema.test.ts), [AI Pen demo smoke](../../../examples/ai-annotation-demo/scripts/smoke-ai-pen-v1.ts), [demo runbook](./demo-runbook.md) |
| Obsidian receives reviewed KnowledgeObject projections grouped by source file/session units plus hidden sidecar runtime events; arbitrary Markdown/PDF edits are not reverse-parsed into canonical InkEvents in V1 | [adapter README](../../../packages/adapter-obsidian/README.md), [Obsidian plugin settings panel](../../../plugins/obsidian/inkloop-sync/main.js), Obsidian V1 plugin verifier |
| Launch readiness requires real hardware, Capture Surface calibration, education demo, business meeting demo, GTM, BOM/supplier, Kickstarter pre-launch page, Kickstarter page, legal/privacy, proof-shot evidence, final owner signoff, and a manual launch-day operating plan | [evidence records](./evidence/README.md), [launch readiness tracker](./launch-readiness-tracker.md), [launch freeze signoff](./evidence/launch-freeze-signoff.md), [pre-launch page pack](./campaign/prelaunch-page-pack.md), [supplier quote intake script](../../../scripts/create-kickstarter-supplier-quote-intake.mjs), [supplier quote audit script](../../../scripts/audit-kickstarter-supplier-quotes.mjs), [page review intake script](../../../scripts/create-kickstarter-page-review-intake.mjs), [page review audit script](../../../scripts/audit-kickstarter-page-review.mjs), [pre-launch page intake script](../../../scripts/create-kickstarter-prelaunch-page-intake.mjs), [pre-launch page intake audit script](../../../scripts/audit-kickstarter-prelaunch-page-intake.mjs), [pre-launch page pack script](../../../scripts/build-kickstarter-prelaunch-page-pack.mjs), [launch signoff audit script](../../../scripts/audit-kickstarter-launch-signoff.mjs), [launch freeze pack script](../../../scripts/build-kickstarter-launch-freeze-pack.mjs), [launch-day command-center script](../../../scripts/build-kickstarter-launch-day-command-center.mjs) |

## Source-To-Artifact Matrix

| Source | Active derived artifacts | Required verification |
| --- | --- | --- |
| `00_README.md` | [project README](./README.md), [root README](../../../README.md), [AGENTS](../../../AGENTS.md) | `npm run verify:ai-pen-kickstarter` checks source package presence and entrypoint boundary wording |
| `01_产品战略与Kickstarter总方案.md` | [campaign README](./campaign/README.md), [Kickstarter page draft](./campaign/kickstarter-page-draft.md), [rewards FAQ draft](./campaign/rewards-faq-draft.md) | `npm run verify:kickstarter-claims`, public copy lock, claim downgrade pack |
| `02_系统架构设计.md` | [architecture](../../architecture.md), [implementation alignment](./implementation-alignment.md), [AI Pen demo](../../../examples/ai-annotation-demo/src/ai-pen-demo.ts) | runtime schema tests, AI Pen browser smoke, demo evidence bundle |
| `03_各模块技术方案.md` | Android/Paper runtime host, Web/Desktop Capture Host, Obsidian projection plugin, evidence analyzers | Android/Paper asset verifier, Obsidian V1 verifier, demo verify, evidence analyzer smokes |
| `04_AI与InkGraph数据契约.md` | `packages/runtime-schema`, `packages/knowledge-schema`, `packages/adapter-obsidian`, AI graph worker smoke | `npm run test`, `npm run demo:smoke:ai-graph-worker`, `npm run demo:smoke:ai-pen` |
| `05_目标与里程碑_10月底Kickstarter倒排.md` | [launch readiness tracker](./launch-readiness-tracker.md), launch action plan, critical path, weekly sprint, KPI dashboard, supplier quote intake/audit, page review intake/audit, launch signoff audit | `npm run kickstarter:supplier-quote-audit`, `npm run kickstarter:page-review-audit`, `npm run kickstarter:launch-signoff-audit`, `npm run kickstarter:ops-refresh`, launch freeze pack |
| `06_Kickstarter_GTM与众筹页面方案.md` | [campaign draft pack](./campaign/README.md), page review intake/audit, pre-launch page intake/audit, pre-launch page pack, launch-day comms pack, GTM tracker, public copy lock, proof-shot intake/audit, launch-day command center | `npm run verify:kickstarter-claims`, GTM analyzer smoke, public copy lock, `npm run kickstarter:page-review-audit`, `npm run kickstarter:prelaunch-page-intake-audit`, `npm run kickstarter:prelaunch-page-pack`, proof-shot audit, `npm run kickstarter:launch-day-command-center` |
| `07_风险_验收指标_降级方案.md` | [evidence records](./evidence/README.md), supplier quote intake/audit, page review intake/audit, launch signoff audit, risk register, launch evidence audit, launch freeze pack | `npm run launch:evidence:audit`, `npm run kickstarter:supplier-quote-audit`, `npm run kickstarter:page-review-audit`, `npm run kickstarter:launch-signoff-audit`, `npm run kickstarter:risk-register`, `npm run kickstarter:launch-freeze-pack` |
| `08_依据与变更记录.md` | This alignment matrix, project README, documentation summary, completion audit | `npm run verify:ai-pen-kickstarter` and markdown link verification |
| `InkLoop_AI_Pen_Kickstarter_方案合集.md` | Human review backup only; do not manually fork from it when individual source files are available | Source file presence check |

## Runtime Alignment

| Runtime | Source fact implemented | Evidence |
| --- | --- | --- |
| Web/Desktop Host | Primary Kickstarter demo path for AI Pen + Capture Surface + Live Board + InkGraph + reviewed education/meeting outputs; RawPenFrame files and `window.InkLoopRawPen` bridge both feed the same validator and InkEvent path | `ai-pen-demo.html`, `examples/ai-annotation-demo/src/capture/raw-pen-stream.ts`, browser smoke, demo evidence bundle |
| Android / InkLoop Paper | Runtime reuse and future review/annotation host; not a Kickstarter base hardware promise; same-LAN document upload supports direct reader import; M103 vendor socket strokes can be exported as RawPenFrame JSONL for QA/evidence capture | clean `mobile.html` local-first reader UI, hidden `InkLoopRuntime` Web import -> Paper reading/marking -> Obsidian projection manifest, `InkLoopLanImport` bridge, `examples/ai-annotation-demo/src/capture/m103-raw-pen-adapter.ts`, Android/Paper verifier, Android integration doc |
| Obsidian | Projection surface for reviewed KnowledgeObjects grouped by source file/session units plus hidden sidecar runtime sync; not capture truth | Adapter README, plugin settings boundary panel with `Launch Ops Queue: 86 P0 inputs`, Obsidian verifier, demo vault |

## Current Boundary

| Boundary Item | Current Status | Evidence |
| --- | --- | --- |
| Local software demo | `local_demo_ready` | `test-results/ai-pen-demo-evidence/README.md` |
| Browser AI Pen smoke | `browser.ok=true` | `test-results/ai-pen-browser-smoke/result.json` |
| Launch operations queue | `86 P0 inputs` | `test-results/ai-pen-kickstarter-ops-refresh/README.md` |
| Ops refresh | `ops_refresh_launch_not_ready` | `test-results/ai-pen-kickstarter-ops-refresh/ops-refresh.json` |
| Pre-launch page | `prelaunch_page_not_ready` | `test-results/ai-pen-kickstarter-prelaunch-page/prelaunch-page.json` |
| Launch freeze | `launch_freeze_not_ready`, `0/13 gates ready` | `test-results/ai-pen-kickstarter-launch-freeze/launch-freeze.json` |

The repository is demo-ready for the local V1 software chain only. It is not Kickstarter launch-ready until the evidence records contain real prototype logs, real Capture Surface measurements, real education and meeting reviews, real GTM exports, supplier-backed BOM/pricing, Kickstarter pre-launch URL and follower exports, Kickstarter preview/legal/privacy review, final proof shots, and owner signoff.
