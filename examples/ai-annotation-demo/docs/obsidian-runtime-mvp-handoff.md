# InkLoop Obsidian Runtime MVP Handoff

## Status

The local MVP is implemented as a runnable Obsidian Runtime host:

- Visible user documents stay native Markdown under `InkLoop/`.
- InkLoop runtime state lives in the hidden sidecar directory `.inkloop/`.
- The Obsidian plugin runs as a quiet runtime host: it observes edits, renders the shared InkLoop surface, writes sidecar changes, and posts sync events back to the local adapter endpoint.
- Web Lab and Obsidian consume the same surface/runtime shape for document blocks, annotations, freehand strokes, color, opacity, margin notes, and text edits.
- Obsidian does not run InkLoop AI. AI-generated annotations are displayed and edited as document/runtime data.

## Product Modes

- Focus reading: hides InkLoop overlays and disables editing.
- Mark thinking: enables native text edits, pen/highlighter drawing, color selection, margin notes, and sidecar sync.

## Source And Sidecar Layout

```text
obsidian-vault/
  InkLoop/
    Hello SurfaceIndex Title - doc_b559594f7d7e.md
  .inkloop/
    docs/<doc_id>/
      document.json
      source.json
      surfaces/markdown.blocks.jsonl
      canvas/canvas.json
      canvas/nodes.jsonl
      sync/outbox.jsonl
    .inkloop-adapter-state.json
    watch-events.jsonl
```

User-facing Markdown remains clean. Generated block identity, annotations, strokes, canvas nodes, sync events, and adapter state stay hidden.

## From-Scratch Smoke Run

```bash
npm install
npm run verify
npm run obsidian:smoke -- --out-dir .inkloop-smoke-runs/obsidian-runtime-mvp --force-clean
npm run build
npm run obsidian:install-plugin -- --vault .inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
INKLOOP_LAB_RUN_DIR=.inkloop-smoke-runs/obsidian-runtime-mvp npm run demo:dev -- --host 0.0.0.0
```

Open:

```text
http://localhost:8765/obsidian-lab.html
```

Then open this vault in Obsidian:

```text
.inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
```

The visible document to inspect is under `InkLoop/`.

## Current Local Acceptance Run

The latest local run used:

```text
.inkloop-smoke-runs/20260627-sidecar-smoke-3
```

Current Web Lab:

```text
http://localhost:8765/obsidian-lab.html
```

Current Obsidian vault:

```text
.inkloop-smoke-runs/20260627-sidecar-smoke-3/obsidian-vault
```

## Web Lab Checks

Use the Web Lab to verify:

- Focus reading hides overlays.
- Mark thinking enables direct text edits and freehand drawing.
- Pen and highlighter share the same interaction model but keep separate color defaults.
- Color picker and swatches persist chosen colors per tool.
- One-click reset restores the fixture state.
- Web edits write through sidecar/runtime APIs.

Useful endpoints:

```bash
curl -fsS http://localhost:8765/api/obsidian-lab/state
curl -fsS -X POST http://localhost:8765/api/obsidian-lab/update-block \
  -H 'content-type: application/json' \
  -d '{"block_id":"blk_p001_body","content":"Updated paragraph from API smoke."}'
curl -fsS -X POST http://localhost:8765/api/obsidian-lab/update-annotation \
  -H 'content-type: application/json' \
  -d '{"ko_id":"ko_example","patch":{"title":"Updated margin note","body_md":"Edited from API smoke."}}'
curl -fsS -X POST http://localhost:8765/api/obsidian-lab/add-annotation \
  -H 'content-type: application/json' \
  -d '{"block_id":"blk_p001_body","kind":"annotation","title":"API hand mark","render_mode":"stroke_only","visual_strokes":[{"tool":"pen","color":"#38bdf8","points":[{"x":0.1,"y":0.2},{"x":0.3,"y":0.25}]}]}'
curl -fsS -X POST http://localhost:8765/api/obsidian-lab/pull
curl -fsS -X POST http://localhost:8765/api/obsidian-lab/sync-runtime
curl -fsS -X POST http://localhost:8765/api/obsidian-lab/reset
```

Discover live `block_id` and `ko_id` values from `/api/obsidian-lab/state` before running mutation smoke calls.
Mutation endpoints accept loopback requests, same-origin Web Lab requests, or `x-inkloop-lab-token: $INKLOOP_LAB_WRITE_TOKEN` for direct LAN scripts.

## Obsidian Checks

Use the opened Markdown document to verify:

- The file explorer shows only the user-facing `InkLoop/` document by default.
- Hidden `.inkloop/` contains runtime data and does not pollute the visible knowledge tree.
- Native Obsidian preview renders the InkLoop surface with highlights, boxes, pen strokes, margin notes, and AI notes.
- The plugin toolbar exposes Focus Reading, Text, Pen, Highlighter, and Color Pick controls.
- Dark theme keeps pen/highlighter visible.
- Editing document text in Mark Thinking mode updates the source Markdown and sidecar block state.
- Drawing pen/highlighter strokes adds sidecar annotations and runtime sync events.

## Roundtrip Evidence

The smoke script validates the adapter path end to end:

- Builds fixture PDF/document data.
- Builds knowledge objects and document projection.
- Exports the visible source Markdown file.
- Writes hidden sidecar runtime files.
- Installs and enables the Obsidian plugin.
- Simulates Obsidian document edits and task metadata edits.
- Detects file modifications through the watcher.
- Pulls external edits back into adapter state.
- Persists external edits for local and future cloud/device sync.

The script prints `real-flow-report.json`, `scenario-export.json`, and `scenario-export-with-external-edits.json` paths.

## Known Limits

- The cloud transport is a local JSONL-backed stand-in. Production cloud storage still needs a concrete transport and conflict policy.
- The plugin manifest is desktop-only for now.
- The smoke document is fixture-backed. Production import should bind real PDF/native document sources into the same sidecar shape.
- Obsidian does not run AI workflows; it renders and edits already generated runtime data.
- The current lab server is a dev host, not a packaged production service.

## Post-Deploy Monitoring & Validation

For local MVP validation, watch:

- `/api/obsidian-lab/state` returns `ok: true`.
- `/api/obsidian-lab/pull` returns no unexpected `document_conflicts`.
- `/api/obsidian-lab/sync-runtime` reports acknowledged runtime events.
- `.inkloop/docs/<doc_id>/sync/outbox.jsonl` grows when users edit text or draw in Obsidian.
- The lab run's `runtime-cloud-inbox.jsonl` receives synced events.
- Obsidian developer console has no plugin load errors after restart.

Rollback for local testing is `POST /api/obsidian-lab/reset`, or regenerate a new smoke vault with `npm run obsidian:smoke -- --out-dir <run-dir> --force-clean`.
