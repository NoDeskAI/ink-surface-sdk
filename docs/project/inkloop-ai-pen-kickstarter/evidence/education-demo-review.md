# Education Demo Review Record

Gate: G-Tech-7 Education output

Target: A real 5-8 minute teacher board session produces reviewed LessonGraph outputs with valid source_refs and usable lesson notes.

## Session Summary

| Field | Value |
| --- | --- |
| Review date | TBD |
| Owner | TBD |
| Teacher / reviewer | TBD |
| Subject | TBD |
| Grade / audience | TBD |
| Duration | TBD |
| Pen unit ID | TBD |
| Capture Surface | TBD |
| Host app build | TBD |
| Raw session path | TBD |
| Replay path | TBD |
| Video path | TBD |
| Exported lesson note path | TBD |
| Analyzer input path | TBD |
| Analyzer report path | TBD |
| Decision | Not run / Pass / Conditional pass / Fail |

## Analyzer Input

Run the shared demo review analyzer after the teacher/reviewer has reviewed every generated candidate:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:demo-review -- /path/to/education-demo-review.csv --out /tmp/education-demo-review-report.json
```

Required row shape:

| Field | Education value |
| --- | --- |
| `session_id` | One reviewed lesson session |
| `scenario` | `education` |
| `real_hardware` | `true` only for real AI Pen + Capture Surface evidence |
| `duration_min` | 5 to 8 minutes for campaign demo readiness |
| `candidate_id` | Generated lesson candidate ID |
| `kind` | `formula_step`, `concept`, or `lesson_note` |
| `source_ref_valid` | `true` for promoted candidates |
| `source_ref_type` | Usually `ink_event` or `board_object` |
| `reviewer_action` | `accept`, `edit`, `dismiss`, or `follow_up` |
| `hallucination_severity` | `none`, `minor`, or `severe` |
| `audio_only` | Usually `false` for education board evidence |
| `diagram_was_drawn` | `false` unless the lesson uses a diagram |
| `final_use` | `lesson_note` or `none` |

Analyzer report placeholder:

```json
{
  "ok": "TBD",
  "summary": {
    "sessions": [],
    "education_sessions": "TBD",
    "campaign_ready_sessions": "TBD"
  },
  "gate_checks": {
    "has_education_session": "TBD",
    "all_promoted_items_have_valid_source_refs": "TBD",
    "no_severe_hallucinations": "TBD",
    "education_campaign_demo_ready": "TBD"
  }
}
```

## Output Quality

| Metric | Count / Rate | Target | Result |
| --- | ---: | ---: | --- |
| Lesson candidates generated | TBD | >= 3 | TBD |
| Candidates with valid source_refs | TBD | >= 90% | TBD |
| Accepted without edit | TBD | Track | TBD |
| Edited then accepted | TBD | Track | TBD |
| Dismissed | TBD | Track | TBD |
| Formula steps usable | TBD | >= 1 | TBD |
| Concepts usable | TBD | >= 1 | TBD |
| Missing or hallucinated claims | TBD | 0 severe | TBD |

## Human Review

| Item ID | Kind | Source Ref Present | Reviewer Action | Edit Summary | Final Use |
| --- | --- | --- | --- | --- | --- |
| TBD | formula_step / concept / lesson_note | TBD | Accept / Edit / Dismiss | TBD | TBD |

## User Feedback

| Question | Answer |
| --- | --- |
| Did the Live Board match what was written? | TBD |
| Did the lesson note save teacher time? | TBD |
| Was any AI output misleading? | TBD |
| Would this be credible in a public demo? | TBD |
| What must improve before Kickstarter filming? | TBD |

## Gate Decision

| Question | Answer |
| --- | --- |
| Is the session real hardware? | TBD |
| Can this be used as one of the campaign education demos? | TBD |
| What claim can be made from this evidence? | TBD |
| What claim must be avoided? | TBD |

Decision notes:

TBD
