# InkSurface SDK

InkSurface SDK is the standalone InkLoop document-surface renderer. It renders native document text, margin notes, AI notes, highlights, boxes, and freehand pen/highlighter strokes from a sidecar-friendly visual model.

The repository root is the SDK package. Demo and integration hosts live under `examples/`.

## Package Shape

- npm package: `ink-surface-sdk`
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

The SDK is side-effect-free on import. Hosts must explicitly install styles and mount rendered DOM nodes.

Public npm consumers should import the shipped package entrypoints from `ink-surface-sdk`. The `packages/*`
folders are workspace source modules used to build those entrypoints; they are not separate published packages
in the current SDK release.

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

The root package has a `prepare` script so GitHub dependency installs build the SDK bundle and declaration files before consumers import it.

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
npm run check             # Type-check the SDK package
npm run test              # SDK unit tests
npm run build             # ESM/IIFE bundle + .d.ts output + installable Obsidian plugin bundle
npm run build:obsidian-plugin # Rebuild the Obsidian plugin package after SDK build
npm run pack:check        # Verify npm package contents
npm run verify:consumer   # Install packed SDK into a temp consumer and test imports/types
npm run verify            # SDK checks + package checks + demo verification
```

Demo host commands:

```bash
npm run demo:dev
npm run demo:verify
npm run obsidian:smoke
npm run obsidian:install-plugin -- --vault <vault-path>
```

The full Web/PDF/Obsidian validation app is documented in [examples/ai-annotation-demo/README.md](./examples/ai-annotation-demo/README.md).

## Documentation

- [SDK usage](./docs/ink-surface-sdk.md)
- [Architecture](./docs/architecture.md)
- [Cross-platform offline runtime](./docs/cross-platform-offline-runtime.md)
- [Platform renderer strategy](./docs/platform-renderer-strategy.md)
- [Documentation structure](./docs/documentation-structure-summary.md)
- [Documented solutions](./docs/solutions/README.md)

## Repository Map

```text
apps/sync-api/               Future cloud sync API contract fixtures
packages/adapter-contracts/  Adapter execution authority and placement rules
packages/native-bridge/      Local WebView bridge message contract
packages/offline-store/      File sidecar, IndexedDB, offline cache state, and eviction policy
packages/surface-model/      Platform-neutral visual model and pure edit helpers
packages/surface-web/        DOM/SVG surface renderer and pure edit helpers
packages/runtime-schema/     Platform-neutral runtime records and sync event contracts
packages/sync-client/        Runtime push, pull, retry, dedupe, ack, inbox, and cursor handling
src/                         Root compatibility re-export for existing SDK consumers
dist/                        Generated SDK bundles, declarations, and Obsidian plugin package
plugins/obsidian/inkloop-sync/ Obsidian runtime host plugin source
docs/                        SDK architecture, CE workflow docs, and reusable solution docs
examples/ai-annotation-demo/ Web, PDF, Obsidian, Android, adapter validation host
native/                      Native host integration notes
packages/ko-schema/          Protocol fixture data owned outside the SDK runtime layer
```
