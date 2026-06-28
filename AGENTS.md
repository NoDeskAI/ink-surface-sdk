# InkSurface SDK Agent Guide

This repository is the standalone InkSurface SDK plus validation hosts for Web, Obsidian, and future native runtimes.

## Working Rules

- Keep the SDK package root independent from demo-only behavior. Demo and validation code belongs under `examples/`.
- Preserve side-effect-free imports for SDK entrypoints. Hosts explicitly install styles, stores, transports, and render targets.
- Treat `plugins/obsidian/inkloop-sync/` as a runtime host plugin, not a separate renderer fork. Shared behavior should move into `packages/*` when practical.
- Keep user-visible Markdown/PDF files native and clean. InkLoop runtime state belongs in hidden sidecars such as `.inkloop/`.
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
