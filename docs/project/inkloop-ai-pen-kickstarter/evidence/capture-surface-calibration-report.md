# Capture Surface Calibration Report

Gate: G-Tech-2 Capture Surface accuracy

Target: A2 Capture Surface median error and edge-case behavior support a public claim of error <= 5 mm, with A3/A2 stable in at least 95% of sessions.

## Test Summary

| Field | Value |
| --- | --- |
| Test date | TBD |
| Owner | TBD |
| Surface size | A3 / A2 |
| Surface material batch | TBD |
| Calibration method | TBD |
| Pen unit IDs | TBD |
| Firmware version | TBD |
| Host app build | TBD |
| Raw trace path | TBD |
| Measurement sheet path | TBD |
| Analyzer report path | TBD |
| Photo/video path | TBD |
| Decision | Not run / Pass / Conditional pass / Fail |

## Environment

| Variable | Value |
| --- | --- |
| Room lighting | TBD |
| Board type | TBD |
| Surface mounting | TBD |
| Marker type | TBD |
| Surface condition | New / used / wiped / stained |
| Temperature / humidity | TBD |

## Calibration Runs

| Run ID | Surface | Grid Points | Center Median Error mm | Edge Median Error mm | P95 Error mm | Max Error mm | Session Stable | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| CAL-001 | A3 | 0 | TBD | TBD | TBD | TBD | TBD | Not run |
| CAL-002 | A2 | 0 | TBD | TBD | TBD | TBD | TBD | Not run |

## Edge Cases

| Case | Tested | Result | Evidence Link | Notes |
| --- | --- | --- | --- | --- |
| Top-left corner | TBD | TBD | TBD |  |
| Top-right corner | TBD | TBD | TBD |  |
| Bottom-left corner | TBD | TBD | TBD |  |
| Bottom-right corner | TBD | TBD | TBD |  |
| Long horizontal line | TBD | TBD | TBD |  |
| Long vertical line | TBD | TBD | TBD |  |
| Fast writing | TBD | TBD | TBD |  |
| Small formula text | TBD | TBD | TBD |  |
| Diagram arrows | TBD | TBD | TBD |  |
| After wipe | TBD | TBD | TBD |  |
| Glare / bright light | TBD | TBD | TBD |  |

## Stability Calculation

| Metric | Value |
| --- | --- |
| Total sessions | TBD |
| Stable sessions | TBD |
| Stability rate | TBD |
| Target met: >= 95% stable | TBD |
| Target met: <= 5 mm error | TBD |

## Analyzer Command

Run this after exporting the measurement sheet as CSV or JSON:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:capture-surface -- /path/to/calibration.csv --out /tmp/capture-surface-report.json
```

Required input fields:

| Field | Required | Notes |
| --- | --- | --- |
| `run_id` | Yes | One calibration session per run ID |
| `surface_id` | Yes | Physical Capture Surface ID |
| `surface_size` | Yes | A2/A3 for launch evidence |
| `point_id` | Yes | Grid point or writing-case point |
| `region` | Yes | `center`, `edge`, `corner`, or `unknown` |
| `expected_x_mm`, `expected_y_mm` | Yes | Ground-truth coordinate |
| `observed_x_mm`, `observed_y_mm` | Yes | Captured coordinate |
| `lighting` | No | Example: `office_500lux` |
| `condition` | No | Example: `new_surface`, `wiped_surface`, `fast_writing` |

Paste the generated JSON summary here before gate review:

```json
{}
```

## Gate Decision

| Question | Answer |
| --- | --- |
| Can the page claim A2 error <= 5 mm? | TBD |
| Is the claim limited to Capture Surface only? | TBD |
| What conditions must be disclosed? | TBD |
| What material or calibration changes are required? | TBD |

Decision notes:

TBD
