# InkSurface Android Host

The first Android host should load the generated InkSurface WebView bundle from local app assets and connect it to a native Runtime Host through `ink-surface-sdk/native-bridge`.

The native layer owns SAF/file access, secure token storage, asset cache, offline store, network reachability, and background sync. The WebView must be able to open cached documents without network.
