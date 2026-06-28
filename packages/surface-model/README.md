# Surface Model

`packages/surface-model` contains the platform-neutral visual model contract, Markdown projection parser, normalization helpers, and pure edit helpers.

It has no DOM dependency. Web, Obsidian, WebView, and future native renderers should consume this model package before rendering through their own platform surface.

Public SDK consumers should import it from the root package subpath:

```ts
import { parseInkLoopVisualModel } from 'ink-surface-sdk/surface-model';
```
