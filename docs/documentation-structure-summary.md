# InkLoop Documentation Structure

## Purpose

`docs/` is the long-lived knowledge base for InkLoop. It is not only public usage documentation. It carries four kinds of information:

1. Stable baseline: AI Pen system architecture, SDK usage, platform strategy, and cross-platform runtime decisions.
2. Product strategy: the current AI Pen Kickstarter launch baseline and the historical e-paper second-loop material.
3. CE workflow artifacts: brainstorms, ideation, plans, and reviews.
4. Reusable learnings: `solutions/` documents recurring bugs, integration issues, workflow patterns, and best practices.

## Directory Layout

```text
docs/
  ink-surface-sdk.md
  architecture.md
  cross-platform-offline-runtime.md
  platform-renderer-strategy.md
  documentation-structure-summary.md

  project/
    inkloop-ai-pen-kickstarter/
    inkloop-eink/

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

### `project/`

Product and project management documents that inform runtime direction and launch scope beyond the reusable SDK/package layer.

- `project/inkloop-ai-pen-kickstarter/`: current 2026-10 launch source of truth. It covers AI Pen + Capture Surface positioning, Surface Intelligence OS, InkGraph contracts, education/business meeting scope, GTM, risks, and launch gates.
- `project/inkloop-eink/`: historical/local-first knowledge base for the e-paper effort and second product loop. Use it for InkLoop Paper references, not October 2026 Kickstarter launch commitments.

The AI Pen Kickstarter source package under `project/inkloop-ai-pen-kickstarter/source/` is the unique current factual basis for launch scope until a newer package explicitly supersedes it. Legacy e-paper documents may inform the InkLoop Paper roadmap, but they must not be used to expand, weaken, or contradict the October 2026 AI Pen Kickstarter commitments.

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

### InkLoop AI Pen Kickstarter Work

1. `docs/project/inkloop-ai-pen-kickstarter/README.md`
2. `docs/project/inkloop-ai-pen-kickstarter/source/01_产品战略与Kickstarter总方案.md`
3. `docs/project/inkloop-ai-pen-kickstarter/source/02_系统架构设计.md`
4. `docs/project/inkloop-ai-pen-kickstarter/source/04_AI与InkGraph数据契约.md`
5. `docs/project/inkloop-ai-pen-kickstarter/source/05_目标与里程碑_10月底Kickstarter倒排.md`

### InkLoop E-Paper / Second Loop Work

1. `docs/project/inkloop-eink/README.md`
2. `docs/project/inkloop-eink/00_项目总览/项目总看板.md`
3. `docs/project/inkloop-eink/01_技术方案/00_入口与决策_6月方案/系统架构设计.md`
4. `docs/project/inkloop-eink/01_技术方案/30_数据契约与外部投影_7月/InkLoop_Meeting_Event_Schema_Contract_v0.1.md`

### Obsidian Runtime / Sidecar / Sync Work

1. `docs/architecture.md`
2. `docs/cross-platform-offline-runtime.md`
3. `docs/platform-renderer-strategy.md`
4. `docs/solutions/integration-issues/obsidian-ink-rendering-stability-2026-06-28.md`

## Maintenance Rules

- Put stable architectural decisions in root docs.
- Put product/project context under `docs/project/`.
- Put execution strategy in `plans/`.
- Put review findings in `reviews/`.
- Promote recurring lessons from plans/reviews into `solutions/`.
- Keep `solutions/` searchable with YAML frontmatter: `module`, `problem_type`, `component`, `severity`, and `tags`.
- Avoid duplicating the same root cause across multiple solution docs. If overlap is high, update the existing solution instead.

## Summary

`docs/` is the InkLoop knowledge center: root docs define the runtime system, `project/inkloop-ai-pen-kickstarter/` defines the current launch product, CE directories capture work in progress, and `solutions/` preserves reusable fixes. The deeper the project uses CE workflows, the more repeated problems should move out of temporary plans and into durable solutions.
