# InkLoop Knowledge Schema

Shared KnowledgeObject and DocumentProjection contracts for the InkLoop AI Pen V1 product chain.

This package sits after the reviewed AI output step:

```text
LessonGraph / MeetingGraph
-> user accept / edit / follow_up
-> KnowledgeObject
-> Export / Obsidian projection
```

It owns:

- V1 `KnowledgeObject` kinds for lesson notes, formula steps, meeting actions, meeting decisions, meeting risks, diagrams, reading notes, highlights, and tasks
- `DocumentProjection` and export envelope contracts
- source-reference preservation through `inkloop://doc/...` backlinks
- promotion helpers from LessonGraph and MeetingGraph into exportable knowledge objects

It is not the capture truth source. Raw AI Pen events, strokes, BoardGraph, and source reference validation live in `packages/runtime-schema`.
