# AI Annotation Demo Architecture Alignment Review

Date: 2026-07-03
Supersedes: 2026-07-02 architecture gap review
Status: updated for InkLoop AI Pen Kickstarter V1

## Scope

This review records the current alignment state after the repo moved from an SDK/e-paper-centered validation workspace to the InkLoop AI Pen Kickstarter V1 system baseline.

Current fact inputs:

- `docs/project/inkloop-ai-pen-kickstarter/source/`
- `docs/project/inkloop-ai-pen-kickstarter/README.md`
- `docs/architecture.md`
- `docs/cross-platform-offline-runtime.md`
- `docs/reviews/2026-07-02-runtime-sync-canonical-path-acceptance.md`

## Current Result

The repo is no longer positioned as only an SDK workspace example. The root npm package remains `ink-surface-sdk` for compatibility, but the active product baseline is:

```text
AI Pen + Capture Surface + Web/Desktop Host + Live Board + InkLoop Studio
-> education LessonGraph outputs
-> business MeetingGraph outputs
-> reviewed KnowledgeObjects
-> Obsidian projection / export
```

The demo host at `examples/ai-annotation-demo` is now the local validation app for this V1 chain. It still includes PDF reading and e-paper reuse surfaces, but those support InkLoop Paper as the second product loop rather than the October 2026 Kickstarter base promise.

## Resolved Findings

| Previous finding | Current status | Evidence |
| --- | --- | --- |
| Obsidian architecture was split between whole-vault release and runtime plugin | Resolved for the normal product loop | Runtime Sync is canonical; clean Markdown release is Knowledge Export only |
| Sync model was not unified | Resolved for local/dev contract | `packages/sync-client`, `packages/offline-store`, dev push/pull endpoints, and Obsidian plugin runtime outbox/inbox are wired |
| Sidecar runtime was not the default sync path | Resolved for runtime sync | `.inkloop` sidecars and IndexedDB runtime stores are the sync source of truth; export renderers do not own cursors/outbox/inbox |
| Android/e-paper automation was not part of standard verification | Resolved for asset/boundary verification | `verify:android-paper-assets` runs in demo verification and checks Android assets plus InkLoop Paper boundary text |
| SDK subpaths needed package/consumer coverage | Resolved | `verify:consumer` imports root, runtime, sync, knowledge-schema, export-core, and Obsidian projection subpaths |
| AI Pen V1 product chain was not explicit in the demo surface | Resolved for local demo | `ai-pen-demo.html` and smoke tests cover education and meeting KnowledgeObject promotion |

## Remaining Gaps

These are real remaining gaps, but they are not caused by the older architecture split:

| Gap | Why it matters | Current boundary |
| --- | --- | --- |
| Real AI Pen hardware ingestion | Kickstarter claims need firmware/BLE or wired pen evidence | Simulated RawPenFrame stream is enough for local software demo only |
| Physical Capture Surface calibration | A2/A3 accuracy and material claims need measured evidence | Analyzer and templates exist; real calibration data is still missing |
| Production cloud sync/auth | Local/dev runtime sync proves contracts, not deployed multi-user infrastructure | `apps/sync-api` remains contract-level |
| Live Obsidian app smoke | Plugin behavior has deterministic tests and package build, but real app rendering can still drift | Run manual/live smoke before user-facing presentation |
| Vendored reference projects | Reference folders are useful during design, but should not be part of clean public packaging | Keep ignored or move to documented references before public release |
| Production AI result validation | Demo candidates and schema gates exist; launch claims need real education and meeting review records | Use `evidence/education-demo-review.md` and `evidence/business-meeting-demo-review.md` |

## Current Verification Baseline

The current baseline is:

```bash
npm run verify
```

This includes:

- root typecheck, lint, tests, build, pack dry-run, and consumer verification
- V1 consistency verifier
- demo typecheck, lint, 238 tests, and Vite multi-page build
- Android/Paper asset verifier
- AI Pen V1 smoke
- RawPenFrame, Capture Surface, Live Board latency, reward pricing, GTM, and demo-review analyzer smokes

The Android/Paper asset verifier specifically confirms that `ai-pen-demo.html`, `index.html`, `mobile.html`, their referenced JS/CSS assets, PDF runtime assets, Android label, `mobile.html` launch URL, and InkLoop Paper runtime reuse boundary text remain aligned.

## Recommendation

Use `docs/project/inkloop-ai-pen-kickstarter/` as the current product management surface and this review only as the technical alignment checkpoint. Do not treat the old whole-vault sync gap list as current status; the current unresolved work is hardware evidence, production infrastructure, live app QA, supplier/GTM proof, and public Kickstarter claim review.
