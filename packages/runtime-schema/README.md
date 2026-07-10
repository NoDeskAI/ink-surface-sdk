# InkLoop Runtime Schema

`packages/runtime-schema` is the platform-neutral runtime contract source package for InkLoop hosts. It defines document runtime records, surface blocks, annotations, strokes, AI Pen V1 records, mutation inputs, and sync events without depending on DOM, Node file APIs, Obsidian, PDF parsing, or cloud infrastructure.

For the AI Pen Kickstarter V1 chain, this package owns the shared contracts for `RawPenFrame`, `InkEvent`, `BoardGraph`, `SceneView`, `AiGraphJob`, `LessonGraph`, `MeetingGraph`, and traceable source references.

Public SDK consumers should import it from the root package subpath:

```ts
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
```
