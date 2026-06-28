# Runtime Schema

`packages/runtime-schema` is the platform-neutral runtime contract source package for InkSurface hosts. It defines document runtime records, surface blocks, annotations, strokes, mutation inputs, and sync events without depending on DOM, Node file APIs, Obsidian, PDF parsing, or cloud infrastructure.

Public SDK consumers should import it from the root package subpath:

```ts
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
```
