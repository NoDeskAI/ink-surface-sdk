# Platform Renderer Strategy

InkSurface uses one model contract and allows multiple renderers.

## Short Term

Use `packages/surface-web` as the shared renderer for:

- Web app
- Obsidian plugin host
- mobile WebView hosts
- desktop WebView/Tauri/Electron-style hosts

The renderer must be bundled locally for WebView hosts so cached documents can open offline.

## Medium Term

Add native renderers only where product quality requires platform-native behavior, such as high-frequency stylus input, accessibility, document compositing, or battery-sensitive reading modes.

Native renderers must consume the same `packages/surface-model` fixtures and mutation contracts as the Web renderer.

## Parity Contract

Renderer parity is measured against:

- visual model fixtures
- stroke and highlighter fixtures
- margin note and AI note fixtures
- overflow canvas marks
- offline mutation fixtures
- sync conflict fixtures

Pixel-perfect parity is required only for selected critical fixtures. Structural model parity is required for every renderer.
