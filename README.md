# InkSurface SDK

InkSurface SDK is the standalone InkLoop document-surface renderer. It renders native document text, margin notes, AI notes, highlights, boxes, and freehand pen/highlighter strokes from a sidecar-friendly visual model.

The repository root is the SDK package. Demo and integration hosts live under `examples/`.

## Package Shape

- npm package: `ink-surface-sdk`
- SDK source: `src/index.ts`
- SDK build output: `dist/`
- IIFE global: `window.InkLoopSurfaceSDK`
- Web/Obsidian validation app: `examples/ai-annotation-demo/`

The SDK is side-effect-free on import. Hosts must explicitly install styles and mount rendered DOM nodes.

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
npm run build             # ESM/IIFE bundle + .d.ts output
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

## Repository Map

```text
src/                         SDK source only
dist/                        Generated SDK bundles and declarations
docs/                        SDK architecture and usage docs
examples/ai-annotation-demo/ Web, PDF, Obsidian, Android, adapter validation host
packages/ko-schema/          Protocol fixture data owned outside the SDK runtime layer
```
