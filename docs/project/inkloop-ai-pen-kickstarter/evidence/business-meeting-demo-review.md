# Business Meeting Demo Review Record

Gate: G-Tech-8 Meeting output

Target: A real business whiteboard session produces reviewed decisions, actions, risks, and diagram outputs from marked board events aligned to source_refs.

## Session Summary

| Field | Value |
| --- | --- |
| Review date | TBD |
| Owner | TBD |
| Team / reviewer | TBD |
| Meeting type | TBD |
| Duration | TBD |
| Pen unit ID | TBD |
| Capture Surface | TBD |
| Host app build | TBD |
| Raw session path | TBD |
| Replay path | TBD |
| Video path | TBD |
| Exported meeting output path | TBD |
| Analyzer input path | TBD |
| Analyzer report path | TBD |
| Decision | Not run / Pass / Conditional pass / Fail |

## Analyzer Input

Run the shared demo review analyzer after the meeting reviewer has reviewed every generated candidate:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:demo-review -- /path/to/business-meeting-demo-review.csv --out /tmp/business-meeting-demo-review-report.json
```

Required row shape:

| Field | Meeting value |
| --- | --- |
| `session_id` | One reviewed business whiteboard session |
| `scenario` | `meeting` |
| `real_hardware` | `true` only for real AI Pen + Capture Surface evidence |
| `duration_min` | 5 to 8 minutes for campaign demo readiness |
| `candidate_id` | Generated meeting candidate ID |
| `kind` | `meeting_decision`, `meeting_action`, `meeting_risk`, or `diagram` |
| `source_ref_valid` | `true` for promoted candidates |
| `source_ref_type` | `ink_event` or `board_object` for promoted candidates |
| `reviewer_action` | `accept`, `edit`, `dismiss`, or `follow_up` |
| `hallucination_severity` | `none`, `minor`, or `severe` |
| `audio_only` | `true` only for candidates that came from audio/subtitle context without board evidence |
| `diagram_was_drawn` | `true` when the whiteboard session included a drawn diagram |
| `final_use` | `meeting_output` or `none` |

Analyzer report placeholder:

```json
{
  "ok": "TBD",
  "summary": {
    "sessions": [],
    "meeting_sessions": "TBD",
    "campaign_ready_sessions": "TBD"
  },
  "gate_checks": {
    "has_meeting_session": "TBD",
    "all_promoted_items_have_valid_source_refs": "TBD",
    "no_severe_hallucinations": "TBD",
    "meeting_campaign_demo_ready": "TBD"
  }
}
```

## Context Inputs

Meeting audio, subtitles, agenda, speaker labels, and timeline events are context only. A promoted item must include `ink_event` or `board_object` evidence.

| Context Source | Present | Used For | Artifact Link |
| --- | --- | --- | --- |
| Board marks | TBD | Required evidence | TBD |
| Meeting audio | TBD | Optional context | TBD |
| Transcript/subtitles | TBD | Optional context | TBD |
| Agenda | TBD | Optional context | TBD |
| Speaker labels | TBD | Optional context | TBD |
| Timeline events | TBD | Optional context | TBD |

## Output Quality

| Metric | Count / Rate | Target | Result |
| --- | ---: | ---: | --- |
| Meeting candidates generated | TBD | >= 4 | TBD |
| Candidates with valid ink_event or board_object source_refs | TBD | 100% promoted items | TBD |
| Decisions accepted/edited | TBD | >= 1 | TBD |
| Actions accepted/edited | TBD | >= 1 | TBD |
| Risks accepted/edited | TBD | >= 1 if present | TBD |
| Diagram objects usable | TBD | >= 1 if diagram was drawn | TBD |
| Audio-only items blocked | TBD | 100% | TBD |
| Hallucinated claims | TBD | 0 severe | TBD |

## Human Review

| Item ID | Kind | Source Ref Type | Reviewer Action | Edit Summary | Final Use |
| --- | --- | --- | --- | --- | --- |
| TBD | meeting_decision / meeting_action / meeting_risk / diagram | ink_event / board_object | Accept / Edit / Dismiss | TBD | TBD |

## Gate Decision

| Question | Answer |
| --- | --- |
| Is the session real hardware? | TBD |
| Did board marks drive the promoted outputs? | TBD |
| Were audio/subtitle inputs only context? | TBD |
| Can this be used as one campaign meeting demo? | TBD |
| What claim must be avoided? | TBD |

Decision notes:

TBD
