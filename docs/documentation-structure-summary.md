# InkSurface SDK Documentation Structure

## Purpose

`docs/` is the long-lived knowledge base for InkSurface SDK. It is not only public usage documentation. It carries three kinds of information:

1. Stable baseline: SDK usage, architecture, platform strategy, and cross-platform runtime decisions.
2. CE workflow artifacts: brainstorms, ideation, plans, and reviews.
3. Reusable learnings: `solutions/` documents recurring bugs, integration issues, workflow patterns, and best practices.

## Directory Layout

```text
docs/
  ink-surface-sdk.md
  architecture.md
  cross-platform-offline-runtime.md
  platform-renderer-strategy.md
  documentation-structure-summary.md

  brainstorms/
  ideation/
  plans/
  reviews/
  solutions/
    integration-issues/
```

## Directory Responsibilities

### Root Documents

Root-level docs are stable project baselines:

- `ink-surface-sdk.md`: SDK package shape, public entrypoints, renderer usage, and host responsibilities.
- `architecture.md`: system architecture across runtime schema, surface model, Web renderer, Obsidian plugin, offline store, sync client, and cloud boundary.
- `cross-platform-offline-runtime.md`: offline-first runtime split, WebView bundle strategy, local store behavior, and sync expectations.
- `platform-renderer-strategy.md`: short-term and medium-term renderer strategy across Web, Obsidian, WebView, and native hosts.
- `documentation-structure-summary.md`: this file, the map for documentation placement.

### `brainstorms/`

CE requirement exploration and problem framing. Use this for early ambiguity:

- problem frame
- requirements
- user flows
- success criteria
- scope boundaries
- key decisions
- open questions

### `ideation/`

CE option exploration and prioritization. Use this for:

- alternative approaches
- MVP shape proposals
- product/technical direction comparison
- tradeoff notes before committing to a plan

### `plans/`

CE execution plans. Naming should follow:

```text
YYYY-MM-DD-NN-feat-xxx-plan.md
```

Plans should capture:

- overview
- problem frame
- requirements trace
- scope boundaries
- context and research
- technical decisions
- implementation units
- verification
- risks and dependencies

### `reviews/`

CE review outputs. Use this for phase or implementation review records:

- readiness judgment
- findings
- acceptance matrix
- guardrails
- verification status
- remaining risks

### `solutions/`

Durable, reusable learnings. This is the compounding layer.

Use `solutions/` for solved problems and patterns that future work should discover quickly:

- runtime or integration bugs
- Obsidian/Web sync and rendering failures
- offline store and sync-client patterns
- sidecar data ownership rules
- adapter placement decisions
- SDK packaging and consumer verification issues

Each solution should live in a schema category directory, such as:

```text
docs/solutions/integration-issues/
docs/solutions/ui-bugs/
docs/solutions/runtime-errors/
docs/solutions/best-practices/
docs/solutions/developer-experience/
```

## Suggested Reading Order

### New Contributor

1. `README.md`
2. `AGENTS.md`
3. `docs/ink-surface-sdk.md`
4. `docs/architecture.md`
5. `docs/cross-platform-offline-runtime.md`

### Feature Work

1. Search relevant `docs/solutions/`.
2. Read related root architecture docs.
3. Read matching `plans/`.
4. Check `reviews/` if the area has a prior readiness or acceptance record.

### Obsidian Runtime / Sidecar / Sync Work

1. `docs/architecture.md`
2. `docs/cross-platform-offline-runtime.md`
3. `docs/platform-renderer-strategy.md`
4. `docs/solutions/integration-issues/obsidian-ink-rendering-stability-2026-06-28.md`

## Maintenance Rules

- Put stable architectural decisions in root docs.
- Put execution strategy in `plans/`.
- Put review findings in `reviews/`.
- Promote recurring lessons from plans/reviews into `solutions/`.
- Keep `solutions/` searchable with YAML frontmatter: `module`, `problem_type`, `component`, `severity`, and `tags`.
- Avoid duplicating the same root cause across multiple solution docs. If overlap is high, update the existing solution instead.

## Summary

`docs/` is the InkSurface SDK knowledge center: root docs define the system, CE directories capture work in progress, and `solutions/` preserves reusable fixes. The deeper the project uses CE workflows, the more repeated problems should move out of temporary plans and into durable solutions.
