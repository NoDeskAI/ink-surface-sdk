# Native Bridge

`packages/native-bridge` defines the local message protocol between a bundled WebView renderer and a native/offline Runtime Host.

The bridge assumes the WebView loads local app assets. Network is used only by the host runtime for sync and asset download, not to boot the renderer.

Public SDK consumers should import it from the root package subpath:

```ts
import type { NativeBridgeRequest } from 'ink-surface-sdk/native-bridge';
```
