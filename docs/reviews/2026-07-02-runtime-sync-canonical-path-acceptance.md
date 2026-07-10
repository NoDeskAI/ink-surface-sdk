---
title: Runtime Sync Canonical Path Acceptance
date: 2026-07-02
status: implemented
scope: Web/e-paper runtime store, local dev sync transport, Obsidian runtime host, Knowledge Export boundary
---

# Runtime Sync Canonical Path Acceptance

## Decision

Runtime Sync is now the canonical day-to-day synchronization path between the InkLoop Web/e-paper host and the Obsidian runtime plugin. Clean Markdown vault release remains Knowledge Export only: useful for publishing, backup, and future Notion/MCP/CLI/OpenAPI targets, but not used to make live handwriting or annotation edits visible across hosts.

## Implemented Path

- Web/e-paper marks are observed after the durable mark ledger append.
- The runtime bridge writes an IndexedDB runtime snapshot and one idempotent runtime event per mark/tombstone.
- The Web host uses `RuntimeSyncRunner` with HTTP push/pull endpoints.
- The Vite dev server exposes local/cloud-shaped runtime endpoints:
  - `POST /v1/runtime/events:push`
  - `GET /v1/runtime/events:pull`
- The Obsidian plugin reads `.inkloop/outbox/runtime-events.jsonl`, pushes pending events, pulls remote events by device cursor, applies them into hidden sidecars, records conflicts, and refreshes previews only when remote state changes.
- Whole-vault release functions remain export-only and are not called by the runtime sync loop.

## Validation Evidence

Automated checks run during implementation:

```bash
node --check plugins/obsidian/inkloop-sync/main.js
npx vitest run packages/runtime-schema/src/runtime-schema.test.ts packages/offline-store/src/file-sidecar-store.test.ts packages/offline-store/src/indexeddb-store.test.ts packages/sync-client/src/sync-client.test.ts packages/sync-client/src/local-event-log-transport.test.ts
npm --workspace ./examples/ai-annotation-demo run test -- server/runtime-sync-dev.test.ts src/integration/inksurface/runtime-sync-flow.test.ts src/integration/inksurface/runtime-identity.test.ts src/integration/inksurface/runtime-sync-bridge.test.ts src/integration/inksurface/runtime-inbox.test.ts
npm --workspace ./examples/ai-annotation-demo exec -- tsx scripts/smoke-runtime-sync-flow.ts
npm --workspace ./examples/ai-annotation-demo run check
npm run check
npm test
npm --workspace ./examples/ai-annotation-demo test
npm run lint:ci
npm run build
npm --workspace ./examples/ai-annotation-demo run build
npm run pack:check
npm run verify:consumer
```

Smoke output:

```json
{
  "ok": true,
  "web_to_obsidian": {
    "obsidian_annotation_count": 1,
    "obsidian_stroke_color": "#38bdf8"
  },
  "obsidian_to_web": {
    "web_text": "Edited from Obsidian smoke.",
    "web_annotation_count": 1
  },
  "release_path_used": false
}
```

## Acceptance Matrix

| Requirement | Evidence |
|---|---|
| Runtime sync does not depend on whole-vault release | `scripts/smoke-runtime-sync-flow.ts` reports `release_path_used: false`. |
| Web/e-paper mark reaches Obsidian sidecar | `runtime-sync-flow.test.ts` and smoke script apply one Web pen event into the Obsidian-shaped store. |
| Stroke color survives sync | Smoke script reports `obsidian_stroke_color: "#38bdf8"`; surface renderer tests assert inline SVG color/opacity styles. |
| Obsidian edit returns to Web runtime store | `runtime-sync-flow.test.ts` and smoke script update the Web block text from an Obsidian-origin `block.update`. |
| Duplicate/echo delivery does not duplicate strokes | `RuntimeStoreInbox` tests skip same-device echo and repeated pull by cursor; flow test re-pulls without duplicating `ko_obs_pen`. |
| Cursor does not advance on conflict | `runtime-inbox.test.ts` verifies conflict throws and preserves cursor. |
| Dev transport is local/cloud-shaped | `server/runtime-sync-dev.test.ts` verifies push/pull, dedupe, cursor pull, and token rejection. |
| Obsidian plugin uses runtime push/pull | `plugins/obsidian/inkloop-sync/main.js` now has `pushRuntimeOutbox`, `pullRuntimeInbox`, device cursor files, applied-event logs, and conflict records. |
| Knowledge Export remains separate | UI/docs label vault release as export; adapter/export README state export code must not mutate runtime outbox, cursors, or inbox state. |

## Remaining Product Gaps

- Runtime pull now returns applied document ids and the Web/WebView host rehydrates remote annotation strokes into the active canvas. Rich native text rerendering for every source format remains a renderer-level enhancement; block text changes are durable in the runtime store and emitted through `runtime-sync:remote-applied` for host refresh hooks.
- Production cloud auth/device registration remains behind `apps/sync-api`; this implementation lands the local/dev contract and SDK/client semantics.
- Live Obsidian visual smoke is still recommended after plugin install because Obsidian's internal Markdown view APIs are not fully covered by deterministic tests.
