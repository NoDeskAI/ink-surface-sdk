---
date: 2026-07-06
topic: epaper-pdf-epub-reflow
focus: Deep Research analysis for e-paper PDF/EPUB reflow, V1 reading experience, annotations, M103/T10, and Obsidian projection
---

# Ideation: E-Paper PDF / EPUB Reflow

## Codebase Context

The input research document is `/Users/ethan/Downloads/epaper_pdf_epub_reflow_research.md`. Its strongest conclusion is correct for InkLoop Paper: PDF and EPUB should not share one reflow strategy. PDF is fixed-layout and should keep the original file as the source of truth, with V1 using PDF.js text-layer rules only as a derived reading view. EPUB/HTML should eventually use a real reflowable reading model such as Readium or a WebView EPUB renderer.

Current repo evidence:

- PDF original mode uses PDF.js, extracts text blocks and image regions, builds a `SurfaceIndex`, stores the original blob, and creates stable document/page metadata in `examples/ai-annotation-demo/src/surface/renderer.ts`.
- Reader mode hides the original canvas, runs `reflowLocal`, caches `PersistedPage.reflow`, paginates inside each original PDF page, and restores marks through reader layout anchors in `examples/ai-annotation-demo/src/surface/reader.ts`.
- The product path is currently pinned to local deterministic rules. AI/VLM providers exist in `examples/ai-annotation-demo/src/surface/reflow-provider.ts`, but V1 reader mode intentionally avoids them because they may rewrite or distort source text.
- EPUB and Markdown currently enter as synthetic `article` pages. There is no Readium, epub.js, Foliate, CFI, or stable EPUB locator contract yet.
- Obsidian projection depends on `PersistedDoc.pages[].reflow` through `examples/ai-annotation-demo/src/integration/inksurface/document-projection.ts`; pages without reflow become weaker synthetic placeholders.
- M103 low-latency handwriting already has content-signature and OSD cleanup concepts, but the contract is not yet promoted into a reusable reader identity layer.

Main gap: the current implementation treats reflow mostly as a page cache. The research document points toward a better boundary: reflow should be a verified derived artifact with hashes, page maps, options, quality score, provider identity, and source anchors.

## Ranked Ideas

### 1. Persisted Reflow Artifact Contract

**Description:** Promote `PersistedPage.reflow` into a first-class derived artifact. Store `originalSha256`, extracted text hash, normalized text hash, page map hash, options hash, engine/provider id, provider version, source kind, artifact id, and timestamps beside the current block list.

**Rationale:** This is the foundation. It makes reflow invalidation deterministic, preserves the "original is source of truth" rule, gives Obsidian projection provenance, and lets future providers such as K2pdfopt or Readium fit the same contract instead of becoming parallel systems.

**Downsides:** Requires store migration, artifact versioning, and test fixtures. It will not immediately make bad reflow look better unless paired with scoring and page-map work.

**Confidence:** 94%

**Complexity:** Medium

**Status:** Unexplored

### 2. ReflowQualityScore And Original-First Fallback

**Description:** Score every page/artifact on text coverage, page fill, empty-output risk, anchor coverage, chrome stripping, orphan lines, bbox validity, and table/multi-column suspicion. If the score is weak, keep original view or show a clear fallback instead of swapping to a blank or poor reader view.

**Rationale:** This directly addresses the white-screen and poor-layout complaints. The app should not treat "local reflow returned something" as "reader mode is good." Quality scoring also creates regression metrics for the UX范式 PDF and future fixtures.

**Downsides:** Needs thresholds tuned on real documents. It can temporarily keep some PDFs in original mode until better V2 providers are available.

**Confidence:** 91%

**Complexity:** Medium

**Status:** Unexplored

### 3. Reader Page Map And Dual Addressing

**Description:** Persist an explicit map from original source pages to reader virtual pages. Every displayed page/progress/mark should carry both source address and reader address, for example original PDF page plus reader virtual page index. Do not use reader page number as annotation truth.

**Rationale:** Current reader mode paginates inside a PDF page, which causes page-number confusion and weak return links. A page map also helps reading progress, Obsidian backlinks, "回到原文", and future K2pdfopt optimized PDFs.

**Downsides:** Requires revisiting progress UI and stored progress semantics. Existing cached reader page counts are estimated and need to become persisted artifact data.

**Confidence:** 89%

**Complexity:** Medium

**Status:** Unexplored

### 4. Progressive Import-Time Reflow Readiness Pipeline

**Description:** Move from reader-time reflow toward staged readiness: extracted, hashed, rule-reflowed, scored, paginated, projection-ready. Web import and e-paper local import should both enqueue background preprocessing, while reader open keeps original/cached content visible until a usable artifact exists.

**Rationale:** This is the practical answer to slow page turns. Current prewarm is adjacent-page oriented and opportunistic. A readiness pipeline makes import-time CPU useful and lets Cloud Hub/Runtime Sync advertise artifact readiness without blocking reading.

**Downsides:** Adds queue/state complexity and must not make local-first import depend on Cloud Hub. Needs careful cancellation and battery behavior on e-paper.

**Confidence:** 86%

**Complexity:** Medium-High

**Status:** Unexplored

### 5. Stable EPUB Locator Shim Before Full Readium

**Description:** For current synthetic EPUB pages, add V1 locators using spine/href, block ordinal, text hash, char range, and optional future CFI field. Later Readium, epub.js, or Foliate can populate the same anchor shape.

**Rationale:** EPUB does not need the PDF page/bbox model as its truth. This gives EPUB marks durable anchors now without forcing a full EPUB engine into the V1 demo path.

**Downsides:** It is a shim, not a complete EPUB reader. Complex EPUB layout, fixed-layout EPUB, CJK edge cases, and true CFI compatibility remain future work.

**Confidence:** 81%

**Complexity:** Medium

**Status:** Unexplored

### 6. Mark Projection Audit Bundle For Obsidian

**Description:** Emit a trace for each projected reading object: mark id -> anchor runs/source locator -> reflow block -> reader layout id -> projection block -> Obsidian location. Surface a compact source quote and `inkloop://doc/...` backlink in Obsidian.

**Rationale:** This addresses the trust problem where Obsidian notes can look detached from actual marks. It also gives debugging evidence when a mark appears in the wrong page, wrong block, or wrong projection folder.

**Downsides:** Adds metadata and debug surfaces. The user-facing Obsidian document must stay clean, so most trace data should live in `.inkloop` sidecars or collapsible plugin-rendered detail.

**Confidence:** 84%

**Complexity:** Medium

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Replace V1 with K2pdfopt immediately | Too expensive for the current V1 loop; better as V2 provider behind the artifact contract. |
| 2 | Replace V1 PDF renderer with MuPDF now | Licensing, native integration, and memory risk are too high before artifact/page-map boundaries exist. |
| 3 | Use AI/VLM as the main reflow engine | Conflicts with the requirement that original text must not be modified; current code already pins V1 to local rules for this reason. |
| 4 | Build a full EPUB reader immediately | Valuable later, but V1 first needs stable locator anchors and the current synthetic path is enough for continuity. |
| 5 | Add a large operator diagnostics panel as a user feature | Useful for QA, but secondary to artifact contract and quality scoring; can be a dev-only view later. |
| 6 | Make page fill optimizer the first project | Page fill matters, but without artifact/options hashes it can silently invalidate anchors. |
| 7 | Treat Obsidian Markdown as the runtime source of truth | Already rejected by existing Runtime Sync boundary; Obsidian should receive projections and controlled edits. |
| 8 | Model all PDF tables/formulas/columns in local rules | Too much custom PDF semantics for V1; quality score should detect and fall back. |
| 9 | Make Cloud Hub run all reflow before device reading | Breaks local-first and offline reading; Cloud Hub can coordinate artifacts but should not be required for local import/read. |
| 10 | Build device-specific T10 reflow tuning first | Device tuning should consume a shared content signature and artifact/options contract, not become another branch. |

## Session Log

- 2026-07-06: Initial ideation from Deep Research document and live repo scan - 40 raw candidates generated across four frames, deduped into 12 major ideas, 6 survived adversarial filtering.
