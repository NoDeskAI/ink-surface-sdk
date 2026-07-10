---
date: 2026-07-06
topic: epaper-reflow-trustworthy-loop
---

# E-Paper Reflow Trustworthy Loop Requirements

## Problem Frame

InkLoop Paper V1 currently has a usable source-file reading loop, but the reflow reading experience is not trustworthy enough for the V1 demo path or the first productized reading workflow. The user can see white screens, slow page turns, confusing page numbers, unused bottom space, residual handwriting, and Obsidian notes that do not obviously trace back to real marks.

The right V1 goal is not to build a perfect PDF reflow engine. The goal is to make reflow a **verified derived reading view**: original source files remain canonical, reflow has measurable quality and provenance, reader pages map back to source pages, marks remain stable, and Obsidian output can prove where it came from.

The first proof path is PDF on the e-paper reader, centered on the current "AI时代的UX范式" demo document. EPUB and Markdown must keep the same source-truth direction, but they are follow-up consumers of the trust contract rather than equal V1 acceptance targets.

Target loop:

```text
Source file
-> original render remains canonical
-> derived reflow artifact is generated and scored
-> reader opens cached/original content without white screen
-> user marks in original or reflow view
-> marks anchor to original source plus reader layout
-> Obsidian projects reading output with source trace and return link
```

## Requirements

**Definitions And Proof Path**

- R0. V1 acceptance is PDF-first: the primary fixture is the current "AI时代的UX范式" PDF, plus a small fixture set covering a simple text PDF, a no-text/scanned PDF fallback case, and a complex/low-quality fallback case.
- R0a. A source locator is the format-neutral source address used by marks and projections. For PDF it is an original page plus text quote/range or bbox; for EPUB it is a spine/href or future CFI-like locator plus quote/range; for Markdown it is a heading/block/range locator.
- R0b. A source revision is the stable source identity plus content revision used to decide whether a derived artifact, mark anchor, or projection link is still valid.

**Canonical Source And Reflow Artifact**

- R1. The original source file must remain the canonical content truth for PDF and for later EPUB/Markdown consumers of the same source-truth model.
- R2. Reflow output must be treated as a derived artifact, not as a replacement document or source-of-truth text.
- R3. Each reflow artifact must carry enough provenance for a planner or reviewer to answer: which source revision produced it, which options produced it, which provider produced it, and whether it is still valid.
- R4. V1 reader reflow must use deterministic local/rule-based text transformation as the main path. AI/VLM rewriting must not be used as the default reader text source because it can alter original text.
- R5. Reflow artifacts must be local-first. Cloud Hub may sync or coordinate them later, but e-paper local import and offline reading must not depend on Cloud Hub availability.
- R5a. A reflow artifact must not become the preferred reader view unless it passes the V1 quality gate for the target fixture class.

**Reader Experience**

- R6. Opening a book in reader mode must not produce a blank or white-screen waiting state when original content or a previously cached reading view is available.
- R7. If reflow is still being generated, the user should continue seeing original or last-known-good reading content with a minimal processing state.
- R8. Each reflow result must receive a quality judgment before it becomes the preferred reader view.
- R9. Low-quality reflow must fall back to original view or a clear non-reflow state instead of showing empty, badly fragmented, or misleading reader pages.
- R9a. The V1 quality gate must block preferred reflow when the result has no usable text, mismatches the extracted source text, lacks a valid source-to-reader page map, loses required source locators for visible text blocks, creates an empty/near-empty reader page while more body text remains, or is classified as a complex layout that V1 local rules should not claim to solve.
- R10. Reader page labels and progress must be based on a source-locator to reader-page map, so original source identity and reader virtual page identity are both preserved.
- R11. Reader mode must not expose confusing labels such as one-page/two-page when it is really showing virtual reading pages. The visible page count should reflect the actual reader-page total.
- R12. Reflow pagination should aim to fill the e-paper screen without cutting off text or forcing large avoidable blank regions. A final partial page or chapter ending may leave space.
- R13. Reader layout options that affect text position, pagination, or mark projection must be treated as part of the derived reading view identity.
- R13a. If a reader artifact is regenerated, invalidated, or replaced by a different layout identity, existing reader-view marks must either migrate to the new reader layout through source locators or degrade explicitly to source-only anchors. They must not silently attach to an unrelated reader layout.

**Reader States**

| State | Primary surface | User-facing behavior | Mark ownership |
| --- | --- | --- | --- |
| Original available | Original source view | Reader can open immediately; reflow can process in background | Marks attach to canonical source locator |
| Cached reflow ready | Last valid reader artifact | Reader opens cached artifact and may refresh readiness in background | Marks attach to that stable artifact plus source locator |
| Processing | Original or cached content stays visible | Minimal "processing reading view" state; no blank screen | Pending artifact receives no mark anchors until promoted |
| Low-quality reflow | Original or cached content stays visible | Show clear fallback status; do not prefer bad reflow | Marks attach to visible original/cached surface only |
| No text layer | Original view | Explain that reflow is unavailable for this page/document class | Marks attach to canonical source locator |
| Ready | Current valid reader artifact | Reader mode is preferred when user opens reflow | Marks attach to artifact/layout plus source locator |
| Stale artifact | Original or last-known-good artifact | Show stale/refreshing state; do not overwrite valid anchors | Marks attach to the visible stable surface |
| Hard error | Original view | Show non-blocking error and keep reading possible | Marks attach to canonical source locator |

**Marks, Handwriting, And Return Links**

- R14. Marks created in original source view and marks created in reflow reader view must converge on the same canonical source-file mark ledger.
- R15. A mark made in reflow view must retain enough source anchoring to return to the original page and enough reader anchoring to restore its visual position when the same reader artifact is reopened.
- R16. Switching pages, switching original/reflow mode, opening mark lists, or returning to the shelf must not leave stale handwriting or fast-ink residue visible on unrelated screens.
- R16a. Existing marks and cached reflow records that lack the new artifact/source-locator data must remain readable. They may be restored approximately or labeled as approximate in trusted output, but they must not be silently presented as fully verified.
- R17. "Back to source" behavior from AI reply markers, mark summaries, and Obsidian return links must first open the canonical source at the source locator and visibly highlight the target. If the matching reader artifact is available and valid, the user may also return to the reader-page location.
- R17a. The mark lifecycle must be explicit in the reader flow: creation, immediate visual feedback, page switch, original/reflow mode switch, mark list entry, reopen, return-link highlight, and cleanup after leaving the reader.

**Obsidian Projection**

- R18. Obsidian reading output must be generated from real reading marks, accepted AI replies, or source-linked reading artifacts with locator granularity precise enough to support a visible source highlight. Detached demo content is not acceptable.
- R19. Reading projections must remain separate from meeting projections. Reading notes should not include meeting-only concepts such as decisions and risks unless they came from a reading mark type explicitly intended to produce them.
- R20. Each projected reading item should expose a user-comprehensible source trace: source title, source locator label, marked quote or nearby excerpt, mark type, AI acceptance state when relevant, and `inkloop://doc/...` return link.
- R21. Detailed debug/provenance data should live in hidden runtime sidecars or plugin-rendered detail, not clutter visible Markdown.

**Preprocessing And Performance**

- R22. E-paper local import and local library open are the V1 preprocessing proof path. Web import should later consume the same readiness contract, but it is not required to prove this focused reflow trust loop.
- R23. Background reflow work must never block local readability. The user should be able to read original content before derived reflow is ready.
- R24. The reader should prioritize current, next, previous, and last-read pages before full-document processing.
- R25. The product should distinguish "no text layer", "processing", "low-quality reflow", and "ready" states so support and demo verification are not ambiguous.
- R26. Planning must include a falsification check for the local/rule-based baseline: if the V1 fixture set cannot pass the quality gate through local rules plus fallback behavior, engine integration or fixture-scope reduction must be reconsidered explicitly.
- R27. Reader controls, processing states, mark summaries, and return-link highlights should preserve basic accessibility: visible focus where applicable, readable state labels, and touch targets suitable for e-paper interaction.

## User Flows

**Happy Path**

1. User opens the book from the e-paper shelf.
2. Original or cached reader content appears immediately.
3. Reflow readiness runs or refreshes in the background.
4. When the valid artifact is ready, reader mode can show the derived reading view with coherent page labels.
5. User marks text or writes a note.
6. The mark appears immediately, persists through page changes and reopen, and is listed in the mark summary.
7. Obsidian receives a reading projection with a source trace and return link.
8. Opening the return link highlights the source location.

**Fallback Path**

1. User opens a page with no text layer or low-quality local reflow.
2. Original source view remains visible.
3. Reader mode shows a clear unavailable or fallback state.
4. Any mark made during fallback attaches to the visible original or last-known-good surface, not to a pending failed artifact.

**Regeneration Path**

1. Reader options, source revision, or provider identity changes.
2. Existing valid artifacts are marked stale instead of overwritten silently.
3. Existing marks remain source-locator anchored.
4. If reader anchors cannot migrate to the new artifact, the UI and Obsidian trace treat them as source-only or approximate rather than fully verified.

## Success Criteria

- S1. Opening the current demo PDF in reader mode does not show a blank screen when original or cached content is available.
- S2. Switching between original and reflow view keeps source page identity, reader page identity, and reading progress coherent.
- S3. Flipping through reflow pages does not reset to page 1 or display stale page labels.
- S4. Low-quality or no-text pages do not silently render as empty successful reflow pages.
- S5. Marking in reader mode, returning to shelf, reopening the book, and opening the mark summary preserves visible marks without stale residue.
- S6. "Back to source" from an AI reply or mark summary highlights the relevant source/reader location.
- S7. Obsidian reading output for the demo document can be traced to actual source marks and does not contain meeting-only categories unless intentionally produced by reading marks.
- S8. Reflow readiness and fallback behavior can be verified by deterministic tests or smoke evidence, not only manual inspection.
- S9. The V1 fixture set demonstrates one preferred reflow success case, one no-text fallback case, and one low-quality/complex-layout fallback case.
- S10. Existing legacy marks remain visible or are explicitly labeled approximate; they are not silently lost from the reader or projected as fully verified when required anchors are missing.

## Scope Boundaries

- V1 does not require K2pdfopt, MuPDF, OCRmyPDF, Readium, epub.js, or Foliate integration.
- V1 does not attempt perfect PDF semantic reconstruction for multi-column papers, formulas, scanned books, complex tables, or image-heavy documents.
- V1 does not use AI/VLM rewriting as the default reader text source.
- V1 does not make Cloud Hub mandatory for local import, local reading, or local reflow readiness.
- V1 does not require Web import to prove the focused reflow trust loop, though Web import should later reuse the same readiness contract.
- V1 does not require EPUB or Markdown to pass the full PDF reflow artifact quality gate in the first acceptance pass.
- V1 does not turn Obsidian into the runtime source of truth for arbitrary PDF annotations or arbitrary Markdown edits.
- T10-specific low-latency handwriting optimization is outside this brainstorm. T10 should later consume the same reader identity and source-map contract.

## Key Decisions

- **Make artifact trust the foundation:** The first implementation plan should start with source truth, derived artifact identity, quality judgment, and page mapping before introducing new reflow engines.
- **Keep original view as fallback:** A bad reflow experience is worse than no reflow. Original PDF view must remain usable and trusted.
- **Separate reading from meeting output:** Reading projection should focus on highlights, handwritten thoughts, source-linked notes, summaries, and follow-up items. Meeting concepts must not leak into reading documents by default.
- **Defer engine replacement:** K2pdfopt and Readium are valid future directions, but they should plug into the same artifact/provenance/page-map boundary after V1 is stable.

## Dependencies / Assumptions

- The current PDF.js original rendering and local `reflowLocal` path remain available as the V1 baseline.
- The existing mark ledger, reader layout snapshots, and Runtime Sync boundaries remain the underlying source of annotation truth.
- The existing Cloud Hub direction remains: it coordinates source files, runtime sync, and device state, but it is not required for local-first reading.
- The existing Obsidian projection path remains the user-facing knowledge output surface for this V1 loop.
- Existing marks and cached reader data may lack the new trust metadata; the V1 plan must account for compatibility instead of assuming a clean store.

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R3, R8, R10][Technical] Decide the exact artifact metadata and page-map representation that best fits the existing local store and Runtime Sync contracts.
- [Affects R8, R9, R12][Technical] Tune measurable quality thresholds for the first fixture set, including the current UX范式 PDF.
- [Affects R16][Technical] Audit the current fast-ink and canvas layer cleanup points against reader mode transitions.
- [Affects R18-R21][Technical] Decide how much source trace appears in visible Obsidian Markdown versus hidden sidecar/plugin-rendered detail.

## Next Steps

-> /ce:plan for structured implementation planning.
