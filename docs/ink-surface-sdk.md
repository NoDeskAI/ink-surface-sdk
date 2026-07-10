# InkSurface SDK

InkSurface SDK is the shared document-surface renderer used by the InkLoop Web validation host, InkLoop Paper runtime host, and Obsidian runtime host.

It renders native document text, anchored annotations, margin notes, highlights, boxes, and freehand pen/highlighter strokes from the same sidecar-friendly data model.

## Name

- Product name: `InkSurface SDK`
- Repository/package name: `ink-surface-sdk`
- Current compatibility bundle name: `inkloop-surface-sdk`
- Current IIFE global: `InkLoopSurfaceSDK`

The compatibility names are intentionally kept for now so the Obsidian plugin can load the existing bundle path without migration churn.

## Package Layout

```text
apps/sync-api/          Future cloud sync API contract fixtures
packages/adapter-contracts/ Adapter execution authority and placement rules
packages/adapter-obsidian/ Clean Obsidian Markdown vault renderer
packages/export-core/   Deterministic export and concept/topology helpers
packages/knowledge-schema/ KO, DocumentProjection, entity, relation, and hash contracts
packages/native-bridge/  Local WebView bridge message contract
packages/offline-store/  Offline document cache state and eviction policy contract
packages/runtime-schema/ Runtime records and sync event contracts
packages/surface-model/  Visual model, Markdown projection parser, and pure edit helpers
packages/sync-client/    Runtime outbox sync runner and transport contracts
packages/surface-web/  DOM/SVG renderer and pure edit helpers
src/index.ts           Root package compatibility re-export
dist/                  Generated ESM/IIFE bundles and declarations
```

The workspace packages are source modules. The current npm release publishes one package, `ink-surface-sdk`,
with root subpath exports for runtime modules:

```text
ink-surface-sdk
ink-surface-sdk/adapter-contracts
ink-surface-sdk/adapters/obsidian
ink-surface-sdk/export-core
ink-surface-sdk/knowledge-schema
ink-surface-sdk/native-bridge
ink-surface-sdk/offline-store
ink-surface-sdk/offline-store/file-sidecar
ink-surface-sdk/offline-store/indexeddb
ink-surface-sdk/runtime-schema
ink-surface-sdk/surface-model
ink-surface-sdk/surface-web
ink-surface-sdk/sync-client
```

`packages/surface-model` is the platform-neutral parser/model/edit-helper layer.

`packages/surface-web` is the DOM/SVG renderer source consumed by Web, Obsidian, and future WebView hosts. The public npm package remains `ink-surface-sdk`.

`packages/runtime-schema` is the platform contract used by runtime hosts and future bridge/sync packages. It intentionally stays free of DOM, file-system, Obsidian, and cloud dependencies.

`packages/sync-client` is the reusable outbox push layer. It handles local pending events, dedupe, retry state, HTTP transport validation, and per-event acknowledgements without owning the backing store or cloud deployment.

`packages/offline-store` defines the cache-state contract for offline open, partial missing-asset states, migration-required states, and eviction protection for pinned documents or pending mutations.

`packages/native-bridge` defines the local WebView/native message protocol. It assumes the renderer bundle is shipped as local app assets, not loaded from a remote page.

`packages/adapter-contracts` classifies adapters by execution authority so local vault/file adapters remain client-side and cloud API adapters run backend-side.

`packages/knowledge-schema` exposes the stable KO, DocumentProjection, entity membership, KO relation, export
envelope, and content-hash helpers consumed by adapters.

`packages/export-core` exposes deterministic export helpers for taxonomy tags, entity mode inference, concept
layers, and stored-membership topology.

`packages/adapter-obsidian` renders canonical export artifacts into clean Obsidian Markdown vault files. It is a
pure renderer: it does not watch files, write to disk, call Obsidian APIs, or start sync.

`apps/sync-api` documents the future backend sync boundary. It provides contract docs and fixtures only; no production server is shipped in this SDK package.

## Side-Effect Policy

The SDK is side-effect-free on import.

- Importing the module does not touch the DOM.
- Importing the module does not inject CSS.
- Importing the module does not start timers, watchers, network calls, storage writes, or sync jobs.
- `render...` functions create and return DOM nodes, but do not append them to the page.
- `installInkLoopSurfaceStyles()` appends a `<style>` tag only when explicitly called.
- Markdown edit helpers are pure string transformations.

The package declares:

```json
{
  "sideEffects": false
}
```

## Build

```bash
npm run build
```

Outputs:

```text
dist/inkloop-surface-sdk.es.js
dist/inkloop-surface-sdk.iife.js
dist/index.d.ts
dist/packages/*/src/*.js
dist/packages/*/src/*.d.ts
dist/obsidian-plugin/inkloop-sync/
```

`dist/obsidian-plugin/inkloop-sync/` is an installable Obsidian plugin bundle. It contains the plugin's `main.js`, `manifest.json`, `styles.css`, and the SDK IIFE bundle used by the plugin host.

Native clients should bundle `dist/inkloop-surface-sdk.iife.js` or the generated ESM bundle as local app assets for WebView use. Hosts should not depend on loading this renderer from a remote URL at runtime.

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
      annotations: [
        {
          ko_id: 'ko_note_1',
          kind: 'annotation',
          title: 'Margin note',
          body_md: 'This note is anchored to the paragraph.',
          visual_strokes: [
            {
              tool: 'highlighter',
              color: '#facc15',
              opacity: 0.56,
              points: [
                { x: 0.02, y: 0.28 },
                { x: 0.88, y: 0.28 },
              ],
            },
          ],
        },
      ],
    },
  ],
};

installInkLoopSurfaceStyles();
document.querySelector('#app')?.replaceChildren(renderInkLoopVisualModel(model));
```

## Runtime Module Usage

Runtime hosts import non-rendering modules through SDK subpaths:

```ts
import { IndexedDbOfflineRuntimeStore } from 'ink-surface-sdk/offline-store/indexeddb';
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { HttpRuntimeSyncTransport, RuntimeSyncRunner } from 'ink-surface-sdk/sync-client';

const store = new IndexedDbOfflineRuntimeStore();
const transport = new HttpRuntimeSyncTransport({
  endpoint: '/v1/runtime/events:push',
  pullEndpoint: '/v1/runtime/events:pull',
  deviceId: 'dev_current_device',
});

void store;
void transport;
void RuntimeSyncRunner;
void (null as RuntimeSyncEvent | null);
```

`HttpRuntimeSyncTransport` includes `device_id` in push request bodies and pull query parameters. `pullEndpoint`
supports absolute and relative URLs for WebView/current-origin hosts. Pull cursors advance only after the host
inbox applies all returned events without conflicts.

## IIFE Usage

```html
<script src="./dist/inkloop-surface-sdk.iife.js"></script>
<script>
  const {
    installInkLoopSurfaceStyles,
    renderInkLoopVisualModel,
  } = window.InkLoopSurfaceSDK;

  installInkLoopSurfaceStyles();
  document.querySelector('#app').replaceChildren(renderInkLoopVisualModel(model));
</script>
```

## Markdown Projection Usage

The SDK can parse and render Markdown documents that contain InkLoop projection comments:

```ts
import {
  parseInkLoopVisualModel,
  renderInkLoopDocument,
} from 'ink-surface-sdk';

const model = parseInkLoopVisualModel(markdown);
const node = renderInkLoopDocument(markdown);
```

If the Markdown does not contain an InkLoop projection, `renderInkLoopDocument()` returns a simple normalized text fallback.

## Edit Helpers

These helpers are pure string functions for host runtimes that need to update controlled projection sections:

```ts
replaceInkLoopBlockContent(markdown, blockId, nextContent);
appendInkLoopAnnotation(markdown, blockId, annotation);
updateInkLoopAnnotation(markdown, koId, patch);
```

They throw when the target block or annotation does not exist.

## Data Model Notes

`InkLoopVisualModel` is intentionally small:

- `documentTitle`: visible document title.
- `blocks`: ordered render blocks.
- `block.id`: stable block id used for edits and annotations.
- `block.region`: usually `editable` or generated/read-only host state.
- `annotation.visual_strokes`: freehand strokes stored as normalized block coordinates.
- `stroke.color` and `stroke.opacity`: explicit display styling for dark/light themes.

Stroke points are normalized to the block coordinate space:

```ts
{ x: 0, y: 0 } // block top-left
{ x: 1, y: 1 } // block bottom-right
```

Hosts can allow points outside `[0, 1]` for infinite-canvas style overflow. The renderer keeps SVG overflow visible.

## Example

After building the SDK and starting the dev server:

```bash
npm run build
npm run demo:dev -- --host 127.0.0.1
```

Open the current AI Pen V1 validation host:

```text
http://127.0.0.1:8765/ai-pen-demo.html
```

The AI Pen page exercises the shared runtime schema, Capture Surface simulator, Live Board, LessonGraph/MeetingGraph candidates, and `source_refs` validator. For the legacy source-document renderer, open `http://127.0.0.1:8765/`.

## Host Responsibilities

The SDK does not own:

- PDF parsing
- OCR
- AI generation
- Obsidian plugin lifecycle
- file watching
- cloud/device sync
- persistence

Those belong to host applications. The SDK only renders and edits the document-surface projection that those hosts provide.
