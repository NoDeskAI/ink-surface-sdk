# Offline Store

`packages/offline-store` defines the local-first cache and offline-open contract used by InkSurface Runtime Hosts. In the public SDK package, import it from `ink-surface-sdk/offline-store`.

It ships two concrete local implementations:

- `SidecarRuntimeStore` in `./file-sidecar` for Obsidian vaults and desktop file sidecars.
- `IndexedDbOfflineRuntimeStore` in `./indexeddb` for Web/WebView app shells.

Both implementations preserve the same behavior: cached documents open without network, missing large assets produce partial states, local mutations are applied before sync, and pending user events are never evicted.

## Public Imports

```ts
import { resolveOfflineOpenState } from 'ink-surface-sdk/offline-store';
import { SidecarRuntimeStore } from 'ink-surface-sdk/offline-store/file-sidecar';
import { IndexedDbOfflineRuntimeStore } from 'ink-surface-sdk/offline-store/indexeddb';
```

## Mutation Durability

Local mutations update the document snapshot and append the corresponding outbox event as one logical store write. IndexedDB hosts write the snapshot and event in a single `documents` + `outbox` transaction so a local edit cannot be persisted without its sync event, or vice versa.
