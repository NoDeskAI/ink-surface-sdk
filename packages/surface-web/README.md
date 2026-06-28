# Surface Web

`packages/surface-web` is the internal Web renderer source package for InkSurface SDK. It owns the DOM/SVG document-surface renderer and pure Markdown projection edit helpers.

The public npm package is `ink-surface-sdk`. Root package builds bundle this package into:

```text
dist/inkloop-surface-sdk.es.js
dist/inkloop-surface-sdk.iife.js
dist/index.d.ts
```

Host apps should load the generated local bundle from their app package or WebView assets instead of depending on a remote URL.

Public SDK consumers can import DOM renderer helpers from either the root entry or the subpath:

```ts
import { renderInkLoopVisualModel } from 'ink-surface-sdk';
import { installInkLoopSurfaceStyles } from 'ink-surface-sdk/surface-web';
```
