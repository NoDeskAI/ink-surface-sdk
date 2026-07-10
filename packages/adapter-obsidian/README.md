# InkLoop Obsidian Projection Adapter

Renders accepted InkLoop knowledge projections into a clean Markdown vault.

This package is part of **Knowledge Export**, not Runtime Sync.

- It consumes canonical export artifacts and returns vault-relative Markdown files.
- It keeps each imported reading document or meeting session as a source file unit with `inkloop_document_id`, `inkloop_document_uri`, and `inkloop_projection_role: "source_file_unit"` frontmatter.
- It renders AI Pen V1 projections for lesson notes, formula steps, meeting actions, meeting decisions, meeting risks, diagrams, reading notes, highlights, and tasks.
- It preserves `inkloop://doc/...` backlinks so a Markdown note can jump back to the InkLoop source document/session.
- It does not watch files, write to disk, call Obsidian APIs, open plugin views, or own cursors.
- It must not write `.inkloop` runtime outbox, inbox, device cursor, conflict, or sidecar source-of-truth files.
- Live reading, writing, freehand marks, progress, and runtime sidecar sync belong to runtime hosts plus `packages/sync-client`.

Obsidian is intentionally a projection surface in V1. Arbitrary Markdown edits and arbitrary PDF annotations inside Obsidian are not reverse-parsed into canonical AI Pen `InkEvent`, `KnowledgeObject`, `LessonGraph`, or `MeetingGraph` records. The plugin may sync explicit hidden sidecar events, but visible Markdown edits remain local projection edits unless a future controlled adapter records a reviewed event.

Launch Ops Queue and Launch Freeze Go/No-Go are separate from projection correctness. The current package still exposes `Launch Ops Queue: 86 P0 inputs` plus `0/13 gates ready` for public Kickstarter launch because preview, legal/privacy, BOM, GTM, proof-shot evidence, and final human signoff are still missing.
