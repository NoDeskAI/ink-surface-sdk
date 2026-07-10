# Live Board Latency Report

Gate: G-Tech-3 Live Board latency

Target: Real AI Pen transport to Live Board renders at P50 <= 150 ms and P95 <= 300 ms for education and business meeting sessions.

## Test Summary

| Field | Value |
| --- | --- |
| Test date | TBD |
| Owner | TBD |
| Scenario | Education / Business meeting |
| Pen unit IDs | TBD |
| Firmware version | TBD |
| Transport | BLE / wired / simulator |
| Host device | TBD |
| Host app build | TBD |
| Raw event log path | TBD |
| Render timing log path | TBD |
| Analyzer report path | TBD |
| Replay path | TBD |
| Decision | Not run / Pass / Conditional pass / Fail |

## Measurement Definition

Latency is measured from the earliest available raw pen frame timestamp to the Live Board render commit timestamp for the corresponding stroke segment.

| Timestamp | Source |
| --- | --- |
| raw_frame_timestamp_ms | Pen firmware or host receive timestamp |
| host_receive_timestamp_ms | Host app ingestion |
| ink_event_timestamp_ms | Runtime ledger append |
| render_commit_timestamp_ms | Live Board render completion |
| projection_timestamp_ms | Optional AI/Studio projection timing |

The raw frame analyzer reports the first leg only:

```text
pen_to_host_latency_ms = ts_host_ms - ts_device_ms
```

Use it to verify transport health before render instrumentation is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:ai-pen-run -- /path/to/raw-pen-run.jsonl --out /tmp/ai-pen-run-report.json
```

Use the Live Board latency analyzer after render timing instrumentation is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:live-board-latency -- /path/to/live-board-timing.csv --out /tmp/live-board-latency-report.json
```

Required input fields:

| Field | Required | Notes |
| --- | --- | --- |
| `run_id` | Yes | Latency test session |
| `scenario` | Yes | `education`, `meeting`, or another scenario label |
| `event_id` | Yes | Stroke segment, frame, or render event ID |
| `raw_frame_timestamp_ms` | Yes | Earliest available raw pen frame timestamp |
| `host_receive_timestamp_ms` | Yes | Host ingestion timestamp |
| `ink_event_timestamp_ms` | Yes for delivered events | Runtime ledger append timestamp |
| `render_commit_timestamp_ms` | Yes for delivered events | Live Board render completion timestamp |
| `dropped` | No | `true`, `1`, `yes`, or `dropped` counts as dropped |
| `transport`, `pen_id`, `session_id` | No | Evidence dimensions |

## Results

| Run ID | Scenario | Duration Min | Frame Count | Event Count | P50 ms | P95 ms | P99 ms | Max ms | Drop Count | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| LAT-001 | Education | 0 | 0 | 0 | TBD | TBD | TBD | TBD | 0 | Not run |
| LAT-002 | Meeting | 0 | 0 | 0 | TBD | TBD | TBD | TBD | 0 | Not run |

## Breakdown

| Stage | P50 ms | P95 ms | Notes |
| --- | ---: | ---: | --- |
| Pen to host receive | TBD | TBD |  |
| Host receive to InkEvent append | TBD | TBD |  |
| InkEvent append to render commit | TBD | TBD |  |
| End to end | TBD | TBD |  |

Paste the generated JSON summary here before gate review:

```json
{}
```

## Gate Decision

| Question | Answer |
| --- | --- |
| Is this real transport, not simulator? | TBD |
| Does P50 meet <= 150 ms? | TBD |
| Does P95 meet <= 300 ms? | TBD |
| Are there visible strokes that feel delayed to a user? | TBD |
| Can this evidence support Kickstarter demo claims? | TBD |

Decision notes:

TBD
