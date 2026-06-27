# InkSurface SDK

InkSurface SDK is the shared document-surface renderer used by the InkLoop Web Lab and the Obsidian runtime host.

It renders native document text, anchored annotations, margin notes, highlights, boxes, and freehand pen/highlighter strokes from the same sidecar-friendly data model.

## Name

- Product name: `InkSurface SDK`
- Repository/package name: `ink-surface-sdk`
- Current compatibility bundle name: `inkloop-surface-sdk`
- Current IIFE global: `InkLoopSurfaceSDK`

The compatibility names are intentionally kept for now so the Obsidian plugin can load the existing bundle path without migration churn.

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
dist/obsidian-plugin/inkloop-sync/
```

`dist/obsidian-plugin/inkloop-sync/` is an installable Obsidian plugin bundle. It contains the plugin's `main.js`, `manifest.json`, `styles.css`, and the SDK IIFE bundle used by the plugin host.

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

Open:

```text
http://127.0.0.1:8765/examples/ink-surface/basic.html
```

The example imports `ink-surface-sdk` through the demo host's local alias and renders a local in-memory model. It performs no network calls and does not write storage.

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
