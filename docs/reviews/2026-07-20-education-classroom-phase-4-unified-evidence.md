---
title: Education classroom Phase 4 unified evidence implementation
date: 2026-07-20
status: automated-pass-human-semantic-pending
scope: two-web education classroom
---

# Phase 4 — Unified classroom evidence

## Outcome

Unit 7 now routes student live explanation, missed-segment explanation, post-class summary/practice, participant-private practice anchors, and teacher `LessonGraph` generation through one immutable classroom evidence builder.

The bundle contains the active material page/region, bounded ink events, teacher-confirmed/corrected recognition revisions, final/corrected transcript revisions, time range, source allowlist, missing-source state, and a combined evidence fingerprint. Formula or transcript corrections mark affected derived results stale.

## Student workflows

- `这一步没听懂`: uses confirmed focus by default or an explicit participant selection.
- `我错过了一段`: uses at most the preceding 60 seconds and the most recent focus boundary; missing trusted math returns insufficient evidence.
- `生成课后练习`: after class, generates exercises from the whole classroom evidence rather than a private step anchor.
- Summary and practice remain post-class only and reject pending formula evidence.

## Automated evidence

- Focused Unit 7 checks: 33 tests passed across evidence, AI, lesson, handler, and student helpers.
- Classroom application: 112 test files / 683 tests passed before the final inference-boundary test was added; the final focused gate includes that additional test.
- Root SDK: 14 test files / 98 tests passed.
- `npm run check`, `npm run lint:ci`, root build, classroom production build, and `git diff --check` passed.
- Three-student browser smoke passed with 12 durable strokes, late join, reconnect, private AI isolation, teacher review, and deletion propagation.

The browser smoke was hardened after diagnosing false negatives caused by fixed mouse coordinates leaving the teacher canvas and by not waiting for server commit before asserting student convergence.

## Remaining human acceptance

This implementation does not claim the fixed completing-square semantic hard gate yet. Unit 8 must still run the real AI/STT path and manually verify:

- the current-step explanation correctly states why the same value is added to both sides;
- the class summary covers the complete derivation without inventing formulas;
- the generated problem, hint, and answer are mathematically correct and source-bound;
- the raw `LessonGraph` mainline is correct without the teacher rewriting every candidate;
- HTTPS microphone/audio behavior is accepted with real browsers and devices.
