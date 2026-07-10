---
title: Keep InkLoop Product Docs Separate from SDK Baseline Docs
date: 2026-07-02
category: documentation-gaps
module: InkLoop E-Ink Project Documentation
problem_type: documentation_gap
component: documentation
severity: medium
applies_when:
  - Product, project-management, hardware, and commercial documents need to live beside an SDK repo.
  - Local Markdown documents are the canonical source but also need to sync into Feishu or another rendered doc system.
  - Technical plans mix stable SDK contracts with project-specific milestones, procurement, and external adapter plans.
tags: [project-docs, inkloop-eink, local-first, feishu-sync, sdk-boundary, documentation]
---

# Keep InkLoop Product Docs Separate from SDK Baseline Docs

## Context

The InkLoop e-ink product documents started as a local-first Markdown knowledge base on the Desktop, assembled from Feishu wiki nodes, downloaded design and research files, hardware procurement notes, H2 milestones, weekly meeting templates, and stage-retrospective templates. The first pass created a useful project library, but the docs quickly crossed several boundaries: product goals, hardware procurement, software architecture, meeting-event contracts, Feishu sync behavior, and SDK implementation plans all lived close together.

The repo already has stable SDK baseline docs such as `docs/architecture.md`, `docs/ink-surface-sdk.md`, and runtime/Obsidian solution notes. Putting the whole e-ink product knowledge base directly into those root docs would make the SDK baseline noisy and harder to trust. The better boundary is now explicit: project/product documents live under `docs/project/inkloop-eink/`, and only stable SDK decisions are promoted back into root docs or execution plans.

Session history also showed two important projection failures. First, writing Markdown as raw Feishu document text left `#`, frontmatter, and table delimiters visible. Second, hand-converting Markdown tables into text blocks preserved readability poorly and lost table structure. The working Feishu path was to keep local Markdown canonical, strip local-only metadata and duplicate document titles for the upload copy, then use Feishu's Markdown import so tables render as native Feishu tables (session history).

## Guidance

Use three documentation layers:

| Layer | Canonical location | Responsibility |
| --- | --- | --- |
| SDK baseline | `docs/*.md` | Stable architecture, package boundaries, runtime schema, renderer strategy, sync/offline rules |
| Product/project knowledge | `docs/project/inkloop-eink/` | H2 goals, project dashboard, milestones, hardware procurement, meeting templates, stage retrospectives, project-specific architecture |
| Reusable learnings | `docs/solutions/` | Solved problems, recurring boundaries, sync/rendering failures, and future-agent guidance |

Keep the local Markdown tree as the source of truth:

- Write and review project docs locally first.
- Mirror the local project tree into `docs/project/inkloop-eink/` for repo-level collaboration.
- Treat Feishu as a rendered projection or collaboration snapshot, not as the only source.
- Do not place product-management documents, procurement sheets, or meeting templates in root SDK docs.
- Promote only stable implementation contracts back to root docs or `docs/plans/`.

Use the existing project structure:

```text
docs/project/
  README.md
  inkloop-eink/
    README.md
    00_项目总览/
    01_技术方案/
      README.md
      00_入口与决策_6月方案/
      10_产品与PRD_6月方案/
      20_软件原型与MVP_6-7月/
      30_数据契约与外部投影_7月/
      40_硬件选型与样机_7-8月/
      50_跨端形态与最终联调_9月/
    02_项目管理/
    03_会议纪要/
    04_阶段复盘/
    05_合规与商务/
    90_资料归档/
```

Keep the technical scheme split by function and iteration, not by source-file arrival order:

| Technical area | Directory | Use |
| --- | --- | --- |
| Entry and decisions | `00_入口与决策_6月方案/` | Architecture summary, route decisions, MVP scope |
| Product and PRD | `10_产品与PRD_6月方案/` | Product positioning and complete product solution |
| Software prototype and MVP | `20_软件原型与MVP_6-7月/` | Annotation flow, meeting-event marking, OCR/AI return path |
| Data contracts and projection | `30_数据契约与外部投影_7月/` | Core schema, meeting event schema, KnowledgeObject, Obsidian/Notion adapters |
| Hardware selection and prototype | `40_硬件选型与样机_7-8月/` | Screen, SoC, touch/pen, power, structure, procurement evidence |
| Cross-platform integration | `50_跨端形态与最终联调_9月/` | Paper, Studio, Capture, Web, and final integration boundaries |

For Feishu sync, keep conversion rules out of the canonical Markdown:

- Local Markdown may keep one normal H1 title.
- Upload copies should remove duplicate opening H1 headings if Feishu page title already provides the title.
- YAML/frontmatter or local sync metadata should not appear in the rendered Feishu body.
- Use official Markdown import when tables matter.
- If API permissions block app/tenant sync, distinguish node-level read permission from wiki-space or parent-directory edit permission. A token that can read one node is not enough to rebuild a wiki tree (session history).

## Why This Matters

The e-ink project has broader scope than the standalone InkSurface SDK. It includes commercial milestones, procurement decisions, meeting workflows, Feishu projections, and product strategy. Mixing all of that into root SDK architecture files would make root docs unstable and would force future agents to guess which statements are product-specific versus stable implementation baseline.

The separation also prevents sync tools from dictating content shape. Feishu needs rendered blocks and native tables; local Markdown needs clean, reviewable source. Those are different formats. Treating Feishu as a projection keeps the repo readable and lets the sync pipeline evolve without rewriting the product knowledge base.

## When to Apply

- A document is about H2 goals, business validation, project management, procurement, meeting templates, or stage review.
- A technical plan is project-specific and has not yet become a stable SDK contract.
- A source document comes from Feishu or Downloads and needs cleanup before entering the repo.
- Feishu rendering, permissions, or title behavior differ from local Markdown behavior.
- A meeting-scenario SDK or hardware plan needs to align with InkLoop schema but is still product/project planning material.

## Examples

Keep product material under the project tree:

```text
docs/project/inkloop-eink/00_项目总览/项目总看板.md
docs/project/inkloop-eink/00_项目总览/2026H2_量化目标与月度追踪.md
docs/project/inkloop-eink/01_技术方案/30_数据契约与外部投影_7月/InkLoop_Meeting_Event_Schema_Contract_v0.1.md
docs/project/inkloop-eink/02_项目管理/硬件采购清单.md
```

Promote only stable implementation decisions into SDK-level docs:

| If the content says... | Keep it in... | Promote when... |
| --- | --- | --- |
| "7 月中旬第一版 MVP" | `docs/project/inkloop-eink/00_项目总览/` | It does not promote; it is project management |
| "Hardware procurement table fields" | `docs/project/inkloop-eink/02_项目管理/` or `05_合规与商务/` | It affects implementation only if a hardware interface becomes a runtime contract |
| "`MeetingEventMark` aligns meeting side marks with document schema refs" | `docs/project/inkloop-eink/01_技术方案/30_数据契约与外部投影_7月/` | The schema is implemented in `packages/runtime-schema` |
| "Runtime sync is canonical for Obsidian live edits" | `docs/solutions/` and root runtime docs | It becomes a recurring SDK/host boundary |

Run lightweight validation after mirroring:

```bash
find docs/project/inkloop-eink -type f -name '*.md' | wc -l
find docs/project/inkloop-eink -name .DS_Store -print
rg -n '(cli_[A-Za-z0-9]+|[ut]-[A-Za-z0-9._-]{12,}|Bearer\\s+)' docs/project
git status --short -- docs/project docs/documentation-structure-summary.md docs/solutions
```

Expected checks for the current mirror:

- Project docs live under `docs/project/inkloop-eink/`.
- `docs/project/README.md` explains the SDK baseline versus project-doc boundary.
- `docs/documentation-structure-summary.md` includes the InkLoop E-Ink reading order.
- The technical solution directory root only keeps `README.md`; the detailed docs are under function/iteration subdirectories.
- No real Feishu app id, app secret, user token, tenant token, or `.DS_Store` file is committed.

## Related

- [Project documents index](../../project/README.md)
- [InkLoop e-ink project README](../../project/inkloop-eink/README.md)
- [Documentation structure summary](../../documentation-structure-summary.md)
- [Technical scheme directory](../../project/inkloop-eink/01_技术方案/README.md)
- [Meeting event schema contract](../../project/inkloop-eink/01_技术方案/30_数据契约与外部投影_7月/InkLoop_Meeting_Event_Schema_Contract_v0.1.md)
- [Runtime sync Obsidian boundary](../integration-issues/runtime-sync-canonical-path-2026-07-02.md)
