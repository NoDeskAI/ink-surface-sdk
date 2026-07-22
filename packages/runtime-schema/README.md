# InkLoop Runtime Schema

`packages/runtime-schema` is the platform-neutral runtime contract source package for InkLoop hosts. It defines document runtime records, surface blocks, annotations, strokes, AI Pen V1 records, mutation inputs, and sync events without depending on DOM, Node file APIs, Obsidian, PDF parsing, or cloud infrastructure.

For the AI Pen Kickstarter V1 chain, this package owns the shared contracts for `RawPenFrame`, `InkEvent`, `BoardGraph`, `SceneView`, `AiGraphJob`, `LessonGraph`, `MeetingGraph`, and traceable source references.

For reusable classroom rendering and evidence exchange it owns platform-neutral geometry, source references, durable board events, ephemeral previews, snapshots, and evidence checkpoints. Host/API workflow models such as participant-private AI jobs and teacher review candidates live under the education example and are intentionally not SDK exports.

Classroom geometry has two explicit read branches. Historical records without a
`geometry_version` (or with `normalized_v1`) retain their original 0–1
`InkEvent`/`InkLoopStroke` geometry. New infinite-teaching-canvas records use
`classroom_page_world_v1`, a matching textbook-page surface, finite world
points/bounds, and authoritative scale=1 PDF page geometry. Hosts project legacy
records at read time; they must not rewrite history or persist both normalized
and world geometry. The general AI Pen, meeting, and reading contracts remain
normalized and unchanged.

`ClassroomPreview` follows the same discriminator but is transient only. A
preview must never be appended to the board ledger or copied into the timeline.
Timeline board entries continue to contain stable event/sequence/surface
references without points or duplicated geometry.

Public SDK consumers should import it from the root package subpath:

```ts
import type { RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
```
