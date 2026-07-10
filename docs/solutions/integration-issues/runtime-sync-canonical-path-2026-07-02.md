---
title: Make Runtime Sync the Canonical Obsidian Path
date: 2026-07-02
category: integration-issues
module: Runtime Sync
problem_type: architecture_boundary
component: sync
symptoms:
  - Obsidian sync behaved like whole-vault replacement instead of incremental runtime convergence.
  - Web and Obsidian could diverge because live marks were not flowing through shared outbox/inbox semantics.
  - Manual refresh and clean Markdown release were overloaded as if they were product sync.
root_cause: wrong_boundary
resolution_type: architecture_upgrade
severity: high
tags: [runtime-sync, obsidian, offline-store, sidecar, knowledge-export]
---

# Make Runtime Sync the Canonical Obsidian Path

## Problem

The updated demo introduced a clean Markdown vault release path that is useful for publishing and backup, but it was too coarse for the normal InkLoop to Obsidian user loop. It replaced whole vault folders, depended on manual refresh, and could not naturally support bidirectional handwriting, annotation edits, reading progress, cursors, dedupe, or conflict handling.

The correct product boundary is:

- Runtime Sync owns ongoing reading, writing, handwriting, annotation edits, progress, sidecar state, outbox, inbox, ack, retry, dedupe, cursor, and conflicts.
- Knowledge Export owns clean Markdown publishing/backup and future Notion/MCP/CLI/OpenAPI targets.

## Solution

Extend the runtime contract before wiring hosts:

- Add stable runtime document identity and source revision metadata.
- Add `runtime.bootstrap`, `annotation.delete`, `progress.update`, and `source.rename` operations.
- Add `origin.device_id` for echo suppression.
- Add applied-event logs, device cursors, conflict records, and remote event application to both file-sidecar and IndexedDB stores.

Wire the Web/e-paper app above the existing mark ledger:

- Keep pen capture and firmware/WebView paths unchanged.
- After a mark ledger entry is durable, bridge it into an IndexedDB runtime snapshot plus one pending runtime event.
- Persist bridge watermarks so replay does not duplicate strokes.
- Use the same `RuntimeSyncRunner` for push/pull and inbox application.

Wire Obsidian as a runtime host:

- Read `.inkloop/outbox/runtime-events.jsonl`.
- Push pending local events to `/v1/runtime/events:push`.
- Pull remote events from `/v1/runtime/events:pull` using a plugin device cursor.
- Apply remote events into `.inkloop/docs/<doc_id>` sidecars.
- Record conflicts and keep the previous cursor when apply fails.
- Refresh native Markdown preview only for remote state changes; local writes update signatures instead of repainting immediately.

Keep export separate:

- Label vault release and downloader code as Knowledge Export.
- Do not invoke `publishVaultRelease` from normal mark/text edit runtime paths.
- Do not write runtime outbox, inbox, cursors, or conflicts from export renderers.

## Validation Pattern

Use deterministic store/transport tests first, then live Obsidian smoke:

```bash
npx vitest run packages/runtime-schema/src/runtime-schema.test.ts packages/offline-store/src/file-sidecar-store.test.ts packages/offline-store/src/indexeddb-store.test.ts packages/sync-client/src/sync-client.test.ts packages/sync-client/src/local-event-log-transport.test.ts
npm --workspace ./examples/ai-annotation-demo run test -- server/runtime-sync-dev.test.ts src/integration/inksurface/runtime-sync-flow.test.ts src/integration/inksurface/runtime-identity.test.ts src/integration/inksurface/runtime-sync-bridge.test.ts src/integration/inksurface/runtime-inbox.test.ts
npm --workspace ./examples/ai-annotation-demo exec -- tsx scripts/smoke-runtime-sync-flow.ts
```

Expected smoke signals:

- `ok: true`
- Web to Obsidian annotation count is `1`.
- Stroke color remains the selected color, not theme black.
- Obsidian to Web text edit is visible in the Web runtime store.
- `release_path_used: false`.

## Prevention

- Treat whole-vault release as export-only in naming, docs, UI labels, and code comments.
- Any new host should implement runtime store + sync runner semantics before adding export actions.
- Cursor advancement must happen only after inbox application succeeds without conflicts.
- Echo suppression must use stable `origin.device_id`; do not rely on source labels alone.
- Test duplicate delivery and same-device echo for every new transport.
- Keep clean user Markdown/PDF files native. Put InkLoop runtime state in `.inkloop` sidecars or local stores.

## Related Files

- `packages/runtime-schema/src/index.ts`
- `packages/offline-store/src/file-sidecar-store.ts`
- `packages/offline-store/src/indexeddb-store.ts`
- `packages/sync-client/src/index.ts`
- `packages/sync-client/src/local-event-log-transport.ts`
- `examples/ai-annotation-demo/src/integration/inksurface/runtime-sync-bridge.ts`
- `examples/ai-annotation-demo/src/integration/inksurface/runtime-inbox.ts`
- `examples/ai-annotation-demo/src/integration/inksurface/runtime-sync-host.ts`
- `examples/ai-annotation-demo/server/runtime-sync-dev.ts`
- `plugins/obsidian/inkloop-sync/main.js`
