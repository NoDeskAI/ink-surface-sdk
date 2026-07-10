# Hardware Prototype Run Log

Gate: G-Tech-1 Engineering prototypes

Target: 5 AI Pen prototypes can each run a 30-minute education or meeting capture session with pen down/up, coordinates, timestamp, battery, firmware version, and local cache status recorded.

## Run Summary

| Field | Value |
| --- | --- |
| Run date | TBD |
| Owner | TBD |
| Scenario | Education / Business meeting |
| Location | TBD |
| Host device | TBD |
| Capture Surface | A3 / A2 / other |
| Firmware version | TBD |
| Host app build | TBD |
| Raw log path | TBD |
| Analyzer report path | TBD |
| Replay/export path | TBD |
| Video path | TBD |
| Decision | Not run / Pass / Conditional pass / Fail |

## Prototype Inventory

| Unit ID | Hardware Rev | Firmware | Battery Start | Battery End | Session Minutes | Event Count | Drop Count | Cache Recovery | Result |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| PEN-001 | TBD | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Not run |
| PEN-002 | TBD | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Not run |
| PEN-003 | TBD | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Not run |
| PEN-004 | TBD | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Not run |
| PEN-005 | TBD | TBD | TBD | TBD | 0 | 0 | 0 | TBD | Not run |

## Required Raw Event Fields

Contract fields follow `RawPenFrame` in `inkloop.ai_pen.v1`.

| Field | Present | Notes |
| --- | --- | --- |
| schema_version | TBD | `inkloop.ai_pen.v1` |
| pen_id | TBD | Unit identifier |
| session_id | TBD | Capture session |
| surface_id | TBD | Capture Surface identifier |
| ts_device_ms | TBD | Required device timestamp |
| ts_host_ms | TBD | Host receive timestamp, needed for pen-to-host latency |
| tip_state | TBD | `down` / `hover` / `up` |
| optical.x_raw | TBD | Surface coordinate raw x |
| optical.y_raw | TBD | Surface coordinate raw y |
| optical.quality | TBD | 0-1 localization quality |
| pressure | TBD | Optional for V1 if unavailable |
| battery | TBD | 0-1 battery estimate |
| firmware_version | TBD | Required |

## Analyzer Command

Run the raw frame analyzer and attach the JSON report path:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:ai-pen-run -- /path/to/raw-pen-run.jsonl --out /tmp/ai-pen-run-report.json
```

Report fields to paste into this record:

| Report Field | Value |
| --- | --- |
| frame_count | TBD |
| valid_frame_count | TBD |
| schema_pass_rate | TBD |
| pen_ids | TBD |
| firmware_versions | TBD |
| complete_strokes | TBD |
| open_strokes | TBD |
| orphan_up_frames | TBD |
| host_latency_ms.p50_ms | TBD |
| host_latency_ms.p95_ms | TBD |

## Failure Log

| Time | Unit ID | Symptom | Repro Steps | Severity | Owner | Fix / Follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## Gate Decision

| Question | Answer |
| --- | --- |
| Did all 5 units complete 30 minutes? | TBD |
| Were pen down/up and coordinate streams complete? | TBD |
| Were any drops recovered from local cache? | TBD |
| Is this evidence real hardware, not simulator? | TBD |
| Can this be used in Kickstarter page/video claims? | TBD |

Decision notes:

TBD
