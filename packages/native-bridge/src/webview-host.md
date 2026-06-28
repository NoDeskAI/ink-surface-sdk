# WebView Host Contract

Native and desktop WebView hosts must load InkSurface renderer assets from the app bundle or a verified local cache. They must not boot the document surface from a remote URL.

The host runtime owns:

- local document store and cache
- platform file permissions
- secure token storage
- background sync scheduling
- asset downloads and cache eviction
- bridge request handling

The WebView owns:

- rendering from a supplied snapshot
- collecting local UI mutations
- sending bridge requests
- applying host responses

All bridge requests use `inksurface.native_bridge.v1`.
