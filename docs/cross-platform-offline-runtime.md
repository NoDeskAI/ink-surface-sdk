# Cross-Platform Offline Runtime

InkSurface is designed around a local-first Runtime Host model. The Web renderer is shared where it is practical, but cross-platform behavior is defined by runtime contracts, local cache state, mutation events, and sync acknowledgements.

## Runtime Split

| Layer | Owner |
|---|---|
| Runtime Schema | Shared package: `packages/runtime-schema` |
| Visual Model | Shared package: `packages/surface-model` |
| Web Renderer | Shared package: `packages/surface-web` |
| Offline Cache Contract | Shared package: `packages/offline-store` |
| Sync Client | Shared package: `packages/sync-client` |
| WebView Bridge | Shared package: `packages/native-bridge` |
| Adapter Authority | Shared package: `packages/adapter-contracts` |
| Cloud Sync API Boundary | Contract app: `apps/sync-api` |

## Offline Behavior

Cached documents must open without network when metadata, surface data, and required assets are present. If large assets are missing but the surface model is cached, hosts should render a partial state instead of failing the whole document.

Pending local mutations are protected data. Cache cleanup must not evict documents or outbox records with unsent user changes.

`packages/offline-store` now includes the two MVP store implementations:

- File sidecar store for Obsidian vaults and desktop filesystem hosts.
- IndexedDB store for Web and WebView hosts that need local document snapshots, cache records, and outbox persistence.

Both stores can now act as Runtime Sync inbox targets. They persist applied event ids, device cursors, and conflict records separately from local outbox events so duplicate delivery, echo suppression, and cursor-safe retries can be tested without a production backend.

## Local WebView Bundle

Mobile and desktop WebView hosts should load HTML, JS, CSS, and renderer assets from the app bundle or a verified local cache. Network is used for sync and asset download only.

The native host owns file permissions, secure token storage, asset cache, background sync, and bridge request handling. The WebView owns rendering and UI mutation capture.

## Sync

Clients apply local mutations immediately and append outbox events. The sync client uploads events when online, requires explicit per-event acknowledgements, pulls remote events by device cursor, applies them through a host inbox, and then persists the next cursor.

If the host inbox reports conflicts, the cursor must not advance. The host keeps the previous cursor, records or surfaces the conflict, and retries after merge or resolution.

Cold start uses `runtime.bootstrap` snapshots followed by incremental events. Exported Markdown releases are not required for normal runtime sync.

The local/dev transport in `packages/sync-client` is a validation transport for the MVP. It is token/origin guarded, idempotent by event id, pullable by cursor, and logs only ids/counts/latency by default.

The future cloud backend still owns authenticated device identity, global event ordering, conflict records, asset authorization, and cloud API adapter jobs.

## Knowledge Export Boundary

Clean Markdown releases remain an explicit Knowledge Export path for Obsidian Markdown, backups, and future Notion/MCP/CLI/OpenAPI targets. Exporters consume canonical artifacts and must not write runtime outbox, inbox, cursors, conflicts, or sidecar truth. Runtime Sync remains the canonical path for live reading, writing, marks, progress, and host convergence through explicit runtime events. In V1, Obsidian visible Markdown edits stay local to the projection unless a future controlled adapter records a reviewed sidecar event; they are not reverse-parsed into AI Pen capture truth.
