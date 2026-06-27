# InkLoop AI Annotation Demo

This example app validates InkSurface SDK inside the original InkLoop PDF/Web/Obsidian workflow. It is intentionally separate from the SDK package root and consumes the SDK as `ink-surface-sdk`.

## Run

```bash
npm install
npm run demo:dev
```

Open:

```text
http://127.0.0.1:8765/
```

From inside this directory, the same command is:

```bash
npm run dev -- --host 127.0.0.1
```

## Obsidian Runtime Smoke

From the repository root:

```bash
npm run build
npm run obsidian:smoke -- --out-dir .inkloop-smoke-runs/obsidian-runtime-mvp --force-clean
npm run obsidian:install-plugin -- --vault examples/ai-annotation-demo/.inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
INKLOOP_LAB_RUN_DIR="$(pwd)/examples/ai-annotation-demo/.inkloop-smoke-runs/obsidian-runtime-mvp" npm run demo:dev -- --host 0.0.0.0
```

The generated vault is under:

```text
examples/ai-annotation-demo/.inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
```

## AI Keys

Copy the example environment file into this example app:

```bash
cp examples/ai-annotation-demo/.env.example examples/ai-annotation-demo/.env
```

`LLM_GATEWAY_KEY` is read only by the local demo server. Without a key, PDF import, rendering, local marking, and SDK rendering still work; model-backed OCR, AI notes, and reflow calls will fail or degrade.

## What This Example Covers

- PDF.js document rendering and text-layer extraction.
- Pen, highlighter, erase, undo, and geometric mark classification.
- InkLoop KnowledgeObject and DocumentProjection fixtures.
- Obsidian filesystem adapter, hidden `.inkloop` sidecar runtime, and plugin host.
- Web Lab verification for sidecar rendering, annotation editing, and sync events.
- Android wrapper and OCR prototype assets.

Demo design and implementation notes live in this directory's `docs/` folder.
