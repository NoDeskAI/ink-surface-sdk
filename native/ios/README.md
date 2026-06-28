# InkSurface iOS Host

The first iOS host should embed the generated InkSurface WebView bundle as local app assets and connect it to a native Runtime Host through `ink-surface-sdk/native-bridge`.

The native layer owns Files access, secure token storage, asset cache, offline store, network reachability, and background sync. The WebView must be able to open cached documents without network.
