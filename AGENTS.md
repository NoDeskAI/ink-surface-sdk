# InkLoop AI Pen Agent Guide

This repository is the InkLoop AI Pen Kickstarter V1 system workspace. The root npm package remains `ink-surface-sdk` for compatibility, but the current product baseline is AI Pen + Capture Surface + Web/Desktop Host + Live Board + InkLoop Studio, with education and business meeting outputs as the October 2026 Kickstarter focus.

## Working Rules

- Keep the SDK package root side-effect-free and independent from demo-only behavior. Demo and validation code belongs under `examples/`.
- Treat AI Pen / InkGraph contracts as product contracts, not demo-only helpers. Shared schema and export behavior belongs in `packages/*`.
- Preserve side-effect-free imports for SDK entrypoints. Hosts explicitly install styles, stores, transports, and render targets.
- Treat `plugins/obsidian/inkloop-sync/` as a runtime host plugin, not a separate renderer fork. Shared behavior should move into `packages/*` when practical.
- Keep user-visible Markdown/PDF files native and clean. InkLoop runtime state belongs in hidden sidecars such as `.inkloop/`.
- Keep Android/e-paper positioned as InkLoop Paper runtime reuse unless a task explicitly changes the Kickstarter hardware scope.
- Treat `docs/project/inkloop-ai-pen-kickstarter/source/` as the unique current source package for October 2026 Kickstarter scope. `docs/project/inkloop-eink/` is legacy InkLoop Paper / historical material and must not override AI Pen V1 launch commitments.
- Run targeted checks for touched packages, then broader checks before committing:

```bash
npm run check
npm run lint:ci
npm test
npm run build
```

## Documentation Store

`docs/` is the project knowledge base. It contains stable architecture docs, CE workflow artifacts, and reusable solution writeups.

`docs/solutions/` stores documented solutions to recurring bugs, integration issues, best practices, and workflow patterns. Entries are organized by category and include YAML frontmatter fields such as `module`, `problem_type`, `component`, `severity`, and `tags`. It is relevant when debugging, implementing in documented areas, or deciding whether a problem has already been solved.

Use [docs/documentation-structure-summary.md](./docs/documentation-structure-summary.md) as the map for where new documentation belongs.
