# InkSurface SDK

Standalone SDK package for rendering InkLoop document surfaces in Web apps, Obsidian plugins, and other hosts.

## Build

```bash
npm run build
```

Outputs:

```text
dist/inkloop-surface-sdk.es.js
dist/inkloop-surface-sdk.iife.js
dist/index.d.ts
```

## Usage

```ts
import {
  installInkLoopSurfaceStyles,
  renderInkLoopVisualModel,
} from 'ink-surface-sdk';

installInkLoopSurfaceStyles();
document.querySelector('#app')?.replaceChildren(renderInkLoopVisualModel(model));
```

The package is side-effect-free on import. Hosts must explicitly install styles and mount rendered nodes.
