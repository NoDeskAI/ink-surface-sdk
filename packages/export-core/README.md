# InkLoop Export Core

Deterministic export helpers shared by hosts and adapters.

This package is the reusable base for explicit export, publish, and backup targets in the InkLoop AI Pen V1 system:

- Obsidian clean Markdown releases through `packages/adapter-obsidian`
- future Notion, MCP, CLI, OpenAPI, or backup exporters
- deterministic taxonomy, concept, and topology projections

It is intentionally separate from Runtime Sync. Export code consumes canonical artifacts and should not mutate runtime stores, append runtime sync events, advance device cursors, or treat exported Markdown as the live source of truth.
