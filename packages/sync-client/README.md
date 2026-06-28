# Sync Client

`packages/sync-client` contains the reusable runtime sync runner and transport contracts. In the public SDK package, import it from `ink-surface-sdk/sync-client`.

It operates on `RuntimeOutboxPort` and `RuntimeSyncEvent` from the runtime schema, so it can run against file sidecars, IndexedDB, native stores, or production cloud transports.

The package handles batching, dedupe, retry metadata, explicit per-event acknowledgements, pull by device cursor, inbox application, and timeout-safe HTTP transport behavior. It does not own authentication, persistence, conflict merge policy, or cloud storage.

`RuntimeSyncRunner.syncOnce()` runs push first and then pull when an inbox and pull-capable transport are configured. `runOnce()` remains push-only for hosts that want manual phase control, and `pullOnce()` can be scheduled independently for foreground refresh or background sync.

## Public Import

```ts
import {
  HttpRuntimeSyncTransport,
  RuntimeSyncPullConflictError,
  RuntimeSyncRunner,
  type RuntimeInboxPort,
} from 'ink-surface-sdk/sync-client';
```

## HTTP Transport

`HttpRuntimeSyncTransport` requires a stable `deviceId`. Push requests include it in the JSON body as `device_id`, and pull requests include it as a query parameter.

```ts
const transport = new HttpRuntimeSyncTransport({
  endpoint: '/v1/runtime/events:push',
  pullEndpoint: '/v1/runtime/events:pull',
  deviceId: 'dev_current_device',
  requestTimeoutMs: 15_000,
});
```

`pullEndpoint` can be absolute or relative, which lets browser and WebView hosts use the same current-origin API path.

## Pull Cursor Semantics

`pullOnce()` reads the local device cursor, pulls remote events, applies them through the host inbox, and writes `next_cursor` only after the inbox reports zero conflicts.

If any event conflicts, `pullOnce()` throws `RuntimeSyncPullConflictError` and leaves the previous cursor intact. Hosts should persist or surface the conflict through their own merge UI or conflict record flow before retrying.
