# Education Classroom Phase 0 Baseline Acceptance

Date: 2026-07-19 (Asia/Shanghai)

Status: Phase 0 passed; multimodal plan remains active

Plan: `docs/plans/2026-07-18-001-feat-middle-school-math-multimodal-classroom-plan.md`

Fixed manual case: `x² + 6x + 5 = 0`. This review deliberately records workflow correctness separately from mathematical semantic correctness.

## Decision

- **Phase 0 workflow gate: Go.** The existing two-Web classroom can create/start/join, accept teacher pointer strokes after class starts, converge on student viewers, recover late join/reconnect, run private student jobs, end/delete a class and expose teacher review controls.
- **Mathematical semantic gate: Not passed, as expected for Phase 0.** The current AI receives stroke geometry rather than confirmed formulas or teacher transcript. A real-AI visual run described a short pen stroke, the summary reported insufficient teaching content, and the practice asked about stroke trajectory. These outputs are source-valid but do not understand completing the square.
- **Phase 1 prerequisite: Satisfied.** Textbook evidence work may start without treating geometry-only AI output as trusted mathematics.

## Automated Evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Classroom unit/integration tests | Pass | 10 files, 38 tests before the visual fixes; classroom frontend rerun after fixes passed 15 tests; full demo suite passed 618 tests |
| TypeScript | Pass | Browser and server projects both passed |
| Production build | Pass | Teacher and student classroom entries emitted successfully |
| Multi-browser smoke | Pass | 1 teacher, 3 isolated students, 12 converged strokes, late join, reconnect, private AI isolation, teacher review and deletion propagation |
| Browser simulation latency | Pass | 19 samples; P50 3 ms; P95 16 ms, within the 300 ms gate |
| Real AI/source validation | Pass for workflow only | Live explanation, summary, practice and teacher candidates used `execution_mode=real`; all returned source IDs passed the allowlist |
| Android/Paper assets | Pass | `mobile.html` remains the default Android entry; classroom pages are additive |
| Reading/reflow freeze | Pass | Reflow trust loop passed |
| Meeting freeze | Pass | AI Pen education/meeting contract smoke and Meeting V1 E2E passed |

Generated browser and gateway reports remain under ignored `examples/ai-annotation-demo/test-results/`.

## Headed Browser Verification

Server: `http://127.0.0.1:8765`

Pages:

- `/teacher-classroom.html`
- `/student-classroom.html`

Observed flow:

1. Teacher created “配方法 Phase 0 可视验收” and started class `CLUYPH`.
2. Student “学生A” joined and displayed `实时同步`.
3. A real headed-browser mouse stroke after class start produced exactly one committed SVG path on both teacher and student pages.
4. Live explanation returned a private real-AI result with the committed ink event as its source.
5. Ending the class disabled live explanation/selection and enabled summary/practice plus teacher candidate generation.
6. Summary and practice completed and remained private to the student session.
7. Deleting the test class propagated to the student and removed the temporary classroom data.

## Issues Found and Fixed

### Development classroom API routing

The headed run exposed that classroom pages served by Vite on port 8765 used the generic API base and sent `/v1/classrooms` to an already-running Cloud Hub on port 8731. That service did not include the current uncommitted classroom handler and returned `no such route`.

Fix: classroom requests stay same-origin in Vite development, where `classroomDevServer` owns the routes. Production builds still resolve the configured Cloud Hub base. Regression tests cover both modes.

### Silent LessonGraph generation refusal

With only one stroke, the server correctly rejected LessonGraph generation as `insufficient_evidence`, but the teacher UI only re-enabled the button and showed no reason.

Fix: the teacher panel now shows a visible, localized alert while preserving the evidence gate. It does not generate or fabricate candidates from insufficient evidence.

### Stale student empty-board notice

The synchronized stroke rendered correctly, but the student's side panel still said “课堂还没有板书” because only action-button state was refreshed when the first stream event arrived.

Fix: the first successfully applied board event replaces only that stale empty-board notice with “板书已同步，可以解释当前步骤”. It does not overwrite AI job progress, reconnect or resync messages, and duplicate/gapped events cannot report a successful sync.

## Fixed-Case Acceptance Matrix

| Item | Workflow | Mathematical semantics | Execution mode | Source validation | Notes |
| --- | --- | --- | --- | --- | --- |
| Current-step explanation | Pass | Fail / deferred | Real AI | Pass | Described stroke geometry, not the equation |
| Selected-region explanation | Covered by existing classroom tests and acceptance script; full six-line manual run deferred | Fail / deferred | Not claimed in this headed one-stroke run | Contract covered | Re-run with formula recognition in Phase 2 |
| Complete summary | Pass | Fail / deferred | Real AI | Pass | Correctly admitted insufficient content |
| Practice | Pass | Fail / deferred | Real AI | Pass | Produced a stroke-observation task, not completing-square practice |
| LessonGraph generation | Guard passed | Fail / deferred | Refused on insufficient evidence | N/A | Visible teacher error; automated 12-stroke smoke covers review workflow |
| Reviewed LessonGraph | Automated workflow pass | Fail / deferred | Real AI in automated gateway check | Pass | Mathematical correctness requires recognized formulas/transcript |

## Residual Risks and Next Gate

- Phase 0 does not prove formula recognition, textbook navigation, audio/transcription, or mathematical correctness.
- The headed run used one teacher and one student for visual confirmation; the repeatable smoke provides the 1+3 convergence evidence.
- Browser-simulation latency is not physical AI Pen latency.
- Phase 1 must add textbook evidence without weakening the whiteboard-only rollback path.
- Phase 2 must make the fixed six-line completing-square derivation teacher-correctable and prevent unconfirmed formulas from entering trusted AI outputs.

## Post-Deploy Monitoring & Validation

- Search logs for `classroom_not_found`, `invalid_board_event`, `insufficient_evidence`, `education_queue_full`, `education_rate_limited` and repeated stream resyncs.
- Healthy signals: teacher strokes commit after start, student cursors converge, private jobs never appear in shared streams, and expected evidence refusals are visible to the user.
- Failure triggers: a Vite classroom request targets port 8731 unexpectedly, a committed teacher stroke is missing after reconnect, a student sees another student's AI result, or LessonGraph silently fails.
- Mitigation: disable the classroom entry, preserve `.inkloop/classrooms` for diagnosis, and revert the education feature branch without modifying meeting/reading data.
- Validation owner/window: education classroom operator during the first complete Phase 1 textbook classroom run.
