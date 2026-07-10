# InkLoop AI Pen Runtime

This repository is the system runtime, product contract workspace, and validation host for the InkLoop AI Pen Kickstarter V1.

The October 2026 launch product is **InkLoop AI Pen Starter Kit**: a real dry-erase smart pen, Capture Surface, Web/Desktop Host, Live Board, InkLoop Studio, education notes, and business meeting outputs. The e-paper product line remains InkLoop Paper, a second product loop that reuses the same runtime and sidecar contracts but is not the Kickstarter base hardware promise.

InkSurface SDK remains the document-surface renderer package inside this system. It renders native document text, margin notes, AI notes, highlights, boxes, and freehand pen/highlighter strokes from a sidecar-friendly visual model.

The repository root still publishes the compatibility npm package `ink-surface-sdk`, but the project baseline is now the AI Pen system. Demo and integration hosts live under `examples/`.

## Current V1 Status

| Item | Current Status | Evidence |
| --- | --- | --- |
| Local V1 software demo | `local_demo_ready` | `test-results/ai-pen-demo-evidence/README.md` |
| AI Pen browser smoke | `browser.ok=true` | `test-results/ai-pen-browser-smoke/result.json` |
| Launch operations queue | `86 P0 inputs` | `test-results/ai-pen-kickstarter-ops-refresh/README.md` |
| Kickstarter readiness | `ops_refresh_launch_not_ready`, `prelaunch_page_not_ready`, `launch_freeze_not_ready` | `docs/project/inkloop-ai-pen-kickstarter/README.md` |

This means the local AI Pen V1 software chain is demoable, while the October 2026 Kickstarter launch still requires real hardware logs, Capture Surface calibration, supplier quotes, GTM proof, page/legal review, proof-shot evidence, and owner signoff.

## Product And Package Shape

- npm package: `ink-surface-sdk`
- Kickstarter product baseline: `docs/project/inkloop-ai-pen-kickstarter/`
- AI Pen / InkGraph shared contract: `packages/runtime-schema/`
- Adapter contracts package: `packages/adapter-contracts/`
- Native bridge package: `packages/native-bridge/`
- Offline store package: `packages/offline-store/`
- Runtime schema package: `packages/runtime-schema/`
- Surface model package: `packages/surface-model/`
- Sync client package: `packages/sync-client/`
- Surface renderer package: `packages/surface-web/`
- Public compatibility entry: `src/index.ts`
- SDK build output: `dist/`
- Obsidian plugin source: `plugins/obsidian/inkloop-sync/`
- Obsidian plugin package output: `dist/obsidian-plugin/inkloop-sync/`
- IIFE global: `window.InkLoopSurfaceSDK`
- Web/Obsidian validation app: `examples/ai-annotation-demo/`
- Sync API contract app: `apps/sync-api/`

The renderer package is side-effect-free on import. Hosts must explicitly install styles and mount rendered DOM nodes.

Public npm consumers should import the shipped package entrypoints from `ink-surface-sdk`. The `packages/*`
folders are workspace source modules used to build those entrypoints; they are not separate published packages
in the current compatibility package release.

## Install

```bash
npm install ink-surface-sdk
```

Local development:

```bash
npm install
npm run build
npm run verify
```

The root package has a `prepare` script so GitHub dependency installs build the renderer bundle and declaration files before consumers import it.

## ESM Usage

```ts
import {
  installInkLoopSurfaceStyles,
  renderInkLoopVisualModel,
  type InkLoopVisualModel,
} from 'ink-surface-sdk';

const model: InkLoopVisualModel = {
  documentTitle: 'Demo document',
  blocks: [
    {
      id: 'blk_intro',
      kind: 'paragraph',
      region: 'editable',
      content: 'A paragraph with a highlighted phrase and a margin note.',
      annotations: [],
    },
  ],
};

installInkLoopSurfaceStyles();
document.querySelector('#app')?.replaceChildren(renderInkLoopVisualModel(model));
```

Runtime hosts can import the non-rendering modules through root subpaths:

```ts
import { resolveOfflineOpenState } from 'ink-surface-sdk/offline-store';
import { SidecarRuntimeStore } from 'ink-surface-sdk/offline-store/file-sidecar';
import { IndexedDbOfflineRuntimeStore } from 'ink-surface-sdk/offline-store/indexeddb';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { RuntimeSyncRunner, HttpRuntimeSyncTransport } from 'ink-surface-sdk/sync-client';
```

`HttpRuntimeSyncTransport` requires a stable `deviceId` because both push and pull contracts are scoped to a
device identity:

```ts
const transport = new HttpRuntimeSyncTransport({
  endpoint: '/v1/runtime/events:push',
  pullEndpoint: '/v1/runtime/events:pull',
  deviceId: 'dev_current_device',
});
```

## Runtime Sync Vs Knowledge Export

InkSurface has two separate cross-app paths:

- Runtime Sync is the canonical live path for Web/WebView/e-paper hosts and the Obsidian plugin. It synchronizes hidden runtime snapshots, sidecars, handwriting, annotation edits, reading progress, outbox/inbox events, acks, retries, device cursors, and conflicts.
- Knowledge Export is the clean publishing/backup path. It renders native Markdown vault files today and is the reusable boundary for future Notion, MCP, CLI, OpenAPI, and backup targets. Export code must not mutate runtime outboxes, inboxes, or cursors.

For the AI Pen product chain, Runtime Sync and Knowledge Export sit after the capture truth source:

```text
RawPenFrame -> Stroke -> InkEvent -> BoardGraph / InkGraph -> LessonGraph / MeetingGraph -> KnowledgeObject -> Runtime Sync / Knowledge Export
```

Obsidian receives accepted/edited knowledge projections such as Reading Notes, Highlights, Tasks, Decisions, Risks, and diagrams grouped by source file/session units with `inkloop_document_id`, `inkloop_document_uri`, `inkloop_projection_role`, and `inkloop://doc/...` back links. It is not the source of truth for arbitrary AI Pen capture events.

For local validation, the demo dev server exposes the same cloud-shaped runtime endpoints:

```text
POST /v1/runtime/events:push
GET  /v1/runtime/events:pull
```

Run the deterministic runtime smoke without Obsidian:

```bash
npm run demo:smoke:runtime-sync
```

Expected evidence includes `"ok": true` and `"release_path_used": false`.

## IIFE Usage

```html
<script src="./dist/inkloop-surface-sdk.iife.js"></script>
<script>
  const {
    installInkLoopSurfaceStyles,
    renderInkLoopVisualModel,
  } = window.InkLoopSurfaceSDK;
</script>
```

## Commands

```bash
npm run check             # Type-check the system/runtime packages
npm run test              # Unit tests across runtime, sync, knowledge, and renderer packages
npm run build             # ESM/IIFE bundle + .d.ts output + installable Obsidian plugin bundle
npm run build:obsidian-plugin # Rebuild the Obsidian plugin package after SDK build
npm run verify:kickstarter-claims # Verify campaign copy guardrails and unsupported-claim scan
npm run verify:obsidian-v1-plugin # Verify source/dist Obsidian plugin V1 package
npm run pack:check        # Verify npm package contents
npm run verify:consumer   # Install packed SDK into a temp consumer and test imports/types
npm run verify            # Package checks + AI Pen/runtime demo verification
npm run demo:ai-pen       # Start the local AI Pen V1 demo, preferring port 8765
npm run demo:smoke:runtime-sync # Run Web/WebView/Paper <-> Obsidian Runtime Sync smoke without vault release
npm run demo:smoke:ai-pen # Run browser smoke and write projection screenshots/result JSON under test-results/
npm run demo:evidence:bundle # Build local demo evidence manifest from smoke results, APK, plugin, and docs
npm run android:assemble:debug # Build Web demo, verify Android/Paper assets, and assemble debug APK
npm run obsidian:smoke    # Build the plugin and run Obsidian V1 package + temp vault installer smoke
npm run obsidian:demo-vault # Generate a demo vault with plugin + education/meeting Markdown projections
```

Demo host commands:

```bash
npm run demo:ai-pen
npm run demo:smoke:runtime-sync
npm run demo:smoke:ai-pen
npm run demo:evidence:bundle
npm run demo:dev
npm run demo:verify
npm run obsidian:smoke
npm run obsidian:demo-vault
npm run obsidian:install-plugin -- --vault <vault-path>
```

The full Web/PDF/Obsidian validation app is documented in [examples/ai-annotation-demo/README.md](./examples/ai-annotation-demo/README.md).

## Documentation

- [AI Pen Kickstarter baseline](./docs/project/inkloop-ai-pen-kickstarter/README.md)
- [SDK usage](./docs/ink-surface-sdk.md)
- [Architecture](./docs/architecture.md)
- [Cross-platform offline runtime](./docs/cross-platform-offline-runtime.md)
- [Platform renderer strategy](./docs/platform-renderer-strategy.md)
- [Runtime sync acceptance](./docs/reviews/2026-07-02-runtime-sync-canonical-path-acceptance.md)
- [Documentation structure](./docs/documentation-structure-summary.md)
- [Documented solutions](./docs/solutions/README.md)

## Repository Map

```text
apps/sync-api/               Future cloud sync API contract fixtures
packages/adapter-contracts/  Adapter execution authority and placement rules
packages/adapter-obsidian/   Obsidian Markdown projection adapter
packages/export-core/        Export helpers and relation projection
packages/knowledge-schema/   KnowledgeObject, DocumentProjection, and export envelopes
packages/native-bridge/      Local WebView bridge message contract
packages/offline-store/      File sidecar, IndexedDB, offline cache state, and eviction policy
packages/surface-model/      Platform-neutral visual model and pure edit helpers
packages/surface-web/        DOM/SVG surface renderer and pure edit helpers
packages/runtime-schema/     Platform-neutral runtime records and sync event contracts
packages/sync-client/        Runtime push, pull, retry, dedupe, ack, inbox, and cursor handling
src/                         Root compatibility re-export for existing SDK consumers
dist/                        Generated SDK bundles, declarations, and Obsidian plugin package
plugins/obsidian/inkloop-sync/ Obsidian runtime host plugin source
docs/                        System architecture, product baselines, CE workflow docs, and reusable solution docs
examples/ai-annotation-demo/ Web, PDF, Obsidian, Android, adapter validation host
native/                      Native host integration notes
packages/ko-schema/          Legacy protocol fixture data owned outside the SDK runtime layer
```
