# AI Pen V1 Implementation Alignment

Date: 2026-07-03

This file maps the Kickstarter V1 product chain to the current repository. It is the working checklist and current-state evidence for turning the existing SDK/e-paper/Obsidian prototype into an AI Pen system demo.

## P0 Capability Map

| P0 Capability | Current Repo Asset | Current Status |
| --- | --- | --- |
| RawPenFrame / InkEvent shared contract | `packages/runtime-schema/src/index.ts` | Added AI Pen / InkGraph V1 types and source_refs validators |
| Whiteboard writing surface | `examples/ai-annotation-demo/src/ai-pen-demo.ts`, `examples/ai-annotation-demo/src/capture/ink.ts`, `examples/ai-annotation-demo/src/core/store-format.ts` | Added AI Pen Capture Surface simulator; existing PDF/reader capture remains validation infrastructure |
| Live Board Viewer | `examples/ai-annotation-demo/ai-pen-demo.html` | Added explicit Kickstarter V1 Capture Host with education/meeting modes, status cards, and event ledger |
| Session replay and hardware ingress | AI Pen demo state ledger, RawPenFrame import, `window.InkLoopRawPen` browser/native bridge, mark ledger, meeting timeline, runtime sidecar blocks | Added demo replay for recorded strokes plus a validated RawPenFrame ingress target for Android native, Web Serial, or Web Bluetooth adapters; production replay still needs real hardware/BLE logs and latency evidence |
| Education Lesson Notes | `LessonGraph`, `KnowledgeObject`, export infrastructure | Added LessonGraph-shaped candidate output with source_refs validation before review |
| Business Meeting Actions/Decisions/Risks | `MeetingGraph`, `src/features/meeting/`, Obsidian projection | Added whiteboard-event-first MeetingGraph demo candidates; transcript/audio remains optional context |
| AI graph job queue | `AiGraphJob`, `validateAiGraphJob`, Web Capture Host demo, `smoke-ai-graph-worker.ts` | Added a local job contract, browser-visible queue state, worker smoke, retry telemetry, and rejected-job observability before LessonGraph/MeetingGraph output; hosted worker deployment remains outside local demo scope |
| Obsidian projection | `packages/knowledge-schema/`, `packages/adapter-obsidian/`, `plugins/obsidian/inkloop-sync/` | Added reviewed-result builders from LessonGraph/MeetingGraph to KnowledgeObject, V1 callouts, source file/session unit frontmatter (`inkloop_document_id`, `inkloop_document_uri`, `inkloop_projection_role`), `inkloop://doc/...` backlinks, settings-page V1 boundary panel with `Launch Ops Queue: 86 P0 inputs`, launch-freeze Go/No-Go boundary, and explicit sidecar runtime sync while excluding arbitrary Markdown/PDF reverse parsing |
| E-paper Android runtime | `examples/ai-annotation-demo/android/`, mobile WebView host | Repositioned as InkLoop Paper local-first runtime reuse/roadmap, not Kickstarter base delivery; in-APK `InkLoopRuntime` manifest identifies the Web import -> Paper reading/marking -> Obsidian projection demo loop while keeping the Android UI clean; `window.InkLoopLanImport` adds same-LAN document upload into the mobile reader inbox |
| Traceability | HMP, inference view, source_refs, runtime sidecar | Enforce source_refs validation for LessonGraph / MeetingGraph before KnowledgeObject promotion |

## Data Contract Status

Implemented now:

- `RawPenFrame`
- `InkLoopStroke`
- `InkEvent`
- `BoardObject`
- `BoardGraph`
- `SceneView`
- `AiGraphJob`
- `LessonGraph`
- `MeetingGraph`
- `InkLoopSourceRef`
- `validateInkLoopSourceRefs`
- `validateAiGraphJob`
- `validateLessonGraphSourceRefs`
- `validateMeetingGraphSourceRefs`

Verification:

```bash
npm run test -- packages/runtime-schema/src/runtime-schema.test.ts
```

## Product Boundary Rules

1. AI Pen and Capture Surface are the launch promise.
2. E-paper is a second-loop runtime host and roadmap proof.
3. Obsidian is projection/output and sidecar runtime, not the capture truth source.
4. Meeting audio/subtitles are optional context. Whiteboard marks/events are the required V1 evidence path.
5. AI outputs must be candidates until user accepted/edited; dismissed/debug-only outputs do not become trusted KnowledgeObjects.
6. No AI output may enter KnowledgeObject without valid source_refs.

## Demo-Ready Engineering Status

| Area | Status | Verification |
| --- | --- | --- |
| Web demo | Implemented `ai-pen-demo.html` as the primary Kickstarter V1 demo host | `npm run demo:verify`, including AI Pen V1 smoke over built `ai-pen-demo.html`, `index.html`, `mobile.html`, and launch-evidence analyzer smokes |
| Meeting output | Demo MeetingGraph candidates are built from whiteboard InkEvents/BoardObjects first; audio/transcript/project memory can be context only when board evidence is present | `packages/runtime-schema/src/runtime-schema.test.ts`, `packages/knowledge-schema/src/index.test.ts` |
| AI graph job contract | Web demo now creates an `AiGraphJob` from InkEvents/BoardObjects, completes it before user review, and validates the completed job with `validateAiGraphJob`; local worker smoke covers completed, retried, and rejected jobs | `packages/runtime-schema/src/runtime-schema.test.ts`, browser smoke check for `AI Graph Job completed`, `npm run demo:smoke:ai-graph-worker` |
| Obsidian | V1 reviewed outputs become exportable KnowledgeObjects, render into clean callouts, preserve backlinks, and ship through a Runtime Sync sidecar plugin package with a visible V1 boundary panel plus `Launch Ops Queue: 86 P0 inputs` and launch-freeze Go/No-Go boundary; temp vault installer smoke verifies V1 settings and legacy syncEndpoint migration | `packages/knowledge-schema/src/index.test.ts`, `packages/adapter-obsidian/src/index.test.ts`, `npm run verify:obsidian-v1-plugin`, browser projection smoke |
| Android/e-paper | Android shell is documented and labeled as InkLoop Paper local-first runtime reuse; assets sync, entrypoint mirroring, in-APK `InkLoopRuntime` demo-loop manifest, same-LAN `InkLoopLanImport` document upload inbox, M103 `hqunifiedsocket` -> RawPenFrame adapter, and debug APK assembly are guarded by the Android/Paper verifier and root build script | `npm --workspace ./examples/ai-annotation-demo run verify:android-paper-assets`; `npm run android:assemble:debug` verified with local Temurin JDK 17 and Android SDK |
| Docs | `source/` is preserved as the unique fact snapshot; root docs promote only stable V1 decisions; local demo runbook exists | docs review, stale-link search, `docs/project/inkloop-ai-pen-kickstarter/demo-runbook.md` |

## Remaining Production Gaps

These gaps do not block the local demo, but they must be closed before claiming the full Kickstarter V1 product is production-ready:

1. Real AI Pen BLE/firmware ingestion must feed the local `window.InkLoopRawPen` / RawPenFrame parser boundary, while M103 `hqunifiedsocket` export can feed the same evidence shape for Android/Paper QA; both still need hardware logs, latency reports, and evidence-record decisions before launch claims.
2. Capture Surface calibration and A2/A3 error measurement need hardware evidence.
3. Production cloud workers for LessonGraph and MeetingGraph still need hosted deployment, auth, production observability, and real-session load tests; the local `AiGraphJob` contract, demo queue, retry smoke, and rejected-job report are implemented.
4. InkLoop Paper e-paper refresh behavior still needs a current-device verification pass.
5. Real Kickstarter campaign assets, supplier quote artifacts, and public market proof still come from outside the repository; the repo now provides staging/audit packages, but those packages are not proof until filled with real external artifacts and reviewed decisions.
