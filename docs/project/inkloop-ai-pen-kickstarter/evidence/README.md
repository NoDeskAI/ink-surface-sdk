# Launch Evidence Templates

Date: 2026-07-03

This directory contains the working evidence records required to move InkLoop AI Pen from local demo readiness to Kickstarter launch readiness. Each file is a fillable record, not a proposal. Keep completed records in this directory or link the external artifact from the matching row.

## Evidence Record Writeback Safety

Evidence record updates are a controlled writeback path, not an approval shortcut.

1. `npm run launch:evidence:intake` creates staging folders only.
2. `npm run launch:evidence:intake-audit` must pass on non-template raw files, analyzer reports, and supporting artifacts before any official record can change.
3. `npm run launch:evidence:record-update-plan` can only promote rows marked `ready_to_update_record`; rows marked `blocked_do_not_update_record` must stay unchanged.
4. `npm run launch:evidence:apply-record-updates` is dry-run only.
5. `npm run launch:evidence:apply-record-updates:write` may write eligible path fields, but it never writes `Decision`.
6. A human reviewer must manually set `Decision` to Pass, Conditional pass, or Fail after checking raw files, analyzer reports, artifacts, and reviewer notes.
7. After writing records, run `npm run launch:evidence:audit`, run `npm run kickstarter:ops-refresh`, and keep strict gates red until all launch evidence is real and approved.

## Evidence Map

| Gate Area | Record | Launch Question Answered |
| --- | --- | --- |
| Real hardware | [hardware-prototype-run-log.md](./hardware-prototype-run-log.md) | Can five AI Pen prototypes run a real 30-minute capture session? |
| Capture Surface | [capture-surface-calibration-report.md](./capture-surface-calibration-report.md) | Does A2/A3 calibration stay within the promised error and stability targets? |
| Live Board | [live-board-latency-report.md](./live-board-latency-report.md) | Does real transport hit P50 <= 150 ms and P95 <= 300 ms? |
| Education demo | [education-demo-review.md](./education-demo-review.md) | Does a real teacher board session become reviewed lesson notes? |
| Business demo | [business-meeting-demo-review.md](./business-meeting-demo-review.md) | Do marked meeting events become reviewed decisions, actions, risks, and diagrams? |
| Supply | [bom-supplier-tracker.md](./bom-supplier-tracker.md) | Are BOM, supplier options, MOQ, lead time, and cost risks credible enough to price rewards? |
| GTM | [gtm-metrics-tracker.md](./gtm-metrics-tracker.md) | Are email, Kickstarter follower, testimonial, and first-day support gates moving every week? |
| Kickstarter page | [kickstarter-page-risk-checklist.md](./kickstarter-page-risk-checklist.md) | Does the campaign page make only claims backed by evidence and disclose risks plainly? |
| Launch freeze signoff | [launch-freeze-signoff.md](./launch-freeze-signoff.md) | Have campaign, hardware, GTM, legal/privacy, operations, and founder/manual-launch owners explicitly approved the frozen launch scope or downgrade? |

## Record Rules

- Every record must include owner, date, source artifact links, result, decision, and next action.
- Attach raw logs, screenshots, exported CSVs, videos, quote PDFs, or CRM snapshots instead of replacing them with summaries.
- If a result is simulated, mark it `Demo-only`; do not count it as launch evidence.
- If a result is blocked by hardware or external assets, mark the blocking dependency and the date of the next review.
- A gate can move to `Verified` only when the evidence record includes raw artifact links, the required local analyzer report path, analyzer `gate_checks` passing the launch thresholds, and a human-readable decision.

## Local Demo Evidence Bundle

For internal handoff of the current software demo, generate the local demo evidence bundle:

```bash
npm run demo:evidence:bundle
```

Output:

```text
test-results/ai-pen-demo-evidence/README.md
test-results/ai-pen-demo-evidence/manifest.json
```

This bundle collects browser smoke output, projection screenshots, RawPenFrame ingress bridge source, M103 socket RawPenFrame adapter source, Android/Paper same-LAN import bridge source, Android/Paper APK metadata, Android/Paper runtime boundary bridge/status assets, Obsidian packaged plugin artifacts including the V1 settings boundary panel, Kickstarter ops/pre-launch/operator boundary artifacts, and current V1 docs. It is not a substitute for the launch evidence records below because it still relies on fixtures and local software artifacts.

For the full presentation handoff gate, run:

```bash
npm run verify:local-demo-handoff
```

This runs Runtime Sync smoke, browser AI Pen smoke, Android/Paper debug APK assembly, Obsidian demo vault generation, and then regenerates the evidence bundle.

For the real launch evidence state, run:

```bash
npm run kickstarter:ops-refresh
```

For single-step debugging, run the manual chain:

```bash
npm run launch:evidence:audit
npm run launch:action-plan
npm run launch:critical-path
npm run launch:weekly-sprint
npm run launch:kpi-dashboard
npm run kickstarter:claim-downgrade
npm run kickstarter:proof-shot-audit
npm run kickstarter:public-copy-lock
npm run kickstarter:supplier-quote-audit
npm run kickstarter:page-review-audit
npm run kickstarter:prelaunch-page-intake-audit
npm run kickstarter:prelaunch-page-pack
npm run kickstarter:risk-register
npm run kickstarter:launch-signoff-audit
npm run launch:review-pack
npm run kickstarter:rehearsal-pack
npm run kickstarter:proof-shot-intake
npm run launch:evidence:intake-audit
npm run launch:evidence:record-update-plan
npm run launch:evidence:apply-record-updates
npm run launch:operator-pack
npm run kickstarter:launch-freeze-pack
npm run kickstarter:launch-day-command-center
npm run launch:evidence:audit:strict
```

The default audit generates `test-results/ai-pen-launch-evidence-audit/README.md` and `report.json` with the current gate status. The strict audit is expected to fail until every launch evidence record has resolvable raw artifact links, local analyzer reports that pass required `gate_checks`, and human-readable pass or conditional-pass decisions.

`npm run launch:action-plan` reads the latest audit report and writes `test-results/ai-pen-launch-action-plan/README.md` plus `action-plan.json`. Use it for the weekly project-management queue: it maps each not-ready gate to priority, owner role, source milestone, due target, analyzer command, evidence record, and done condition.

`npm run launch:critical-path` reads the latest action plan plus launch/intake audits and writes `test-results/ai-pen-kickstarter-critical-path/README.md` plus `critical-path.json`. Use the Kickstarter critical path before weekly launch review: it maps source milestone dates to current red gates and shows due-this-week, at-risk, overdue, and days-to-launch pressure.

`npm run launch:weekly-sprint` reads the latest Kickstarter critical path, action plan, and intake audit, then writes `test-results/ai-pen-kickstarter-weekly-sprint/README.md` plus `weekly-sprint.json`. Use the Kickstarter weekly sprint as the next 7-day execution package: each task keeps the gate, source milestone, owner role, current intake folder, expected raw/report targets, runnable analyzer command, evidence checklist, First 48 Hours capture plan, and done condition visible.

`npm run launch:kpi-dashboard` reads the latest launch audit, intake audit, action plan, critical path, and weekly sprint, then writes `test-results/ai-pen-launch-kpi-dashboard/README.md` plus `dashboard.json`. Use the Launch KPI dashboard as the weekly KR board; it keeps demo/sample evidence separate from real launch KPI values.

`npm run kickstarter:claim-downgrade` reads the claim evidence matrix, launch evidence audit, and Launch KPI dashboard, then writes `test-results/ai-pen-kickstarter-claim-downgrade/README.md` plus `claim-downgrade.json`. Use the Kickstarter claim downgrade pack before page, video, ad, landing-page, launch email, social, or comment copy moves out of draft; it keeps demo-only and draft-only claims explicit.

`npm run kickstarter:public-copy-lock` reads the Kickstarter claim downgrade pack, latest proof-shot audit, launch evidence audit, and campaign draft sources, then writes `test-results/ai-pen-kickstarter-public-copy-lock/README.md` plus `copy-lock.json`. Use it before page, video, ad, landing-page, launch email, social, or comment copy moves out of draft; it keeps allowed wording, wording to avoid, blocked public claims, and proof-shot blockers in one place.

`npm run kickstarter:supplier-quote-intake` writes `test-results/ai-pen-kickstarter-supplier-quote-intake/YYYY-MM-DD/README.md` plus `manifest.json`, `raw/bom.csv`, `raw/supplier-quotes.csv`, `raw/supplier-risk-review.csv`, `quotes/`, `reports/`, and `reviews/supply-review.md`. Use it before supplier outreach or reward-pricing review so BOM rows, primary quotes, backup quotes, MOQ, lead time, quote artifacts, reward-pricing report, and human supply review land in one dated package.

`npm run kickstarter:supplier-quote-audit` reads the latest supplier quote intake and writes `test-results/ai-pen-kickstarter-supplier-quote-audit/README.md` plus `report.json`. Use it after filling real BOM and quote artifacts and running the reward pricing analyzer: it checks BOM completeness, confirmed quote coverage, backup supplier coverage, usable quote paths, `supplier_backed_for_public_page`, and the human supply review. It is not reward pricing approval.

`npm run kickstarter:page-review-intake` writes `test-results/ai-pen-kickstarter-page-review-intake/YYYY-MM-DD/README.md` plus `manifest.json`, `raw/page-review-fields.csv`, `raw/page-section-review.csv`, `raw/legal-privacy-review.csv`, screenshots/exports/artifacts folders, and owner/legal/founder review files. Use it before formal Kickstarter preview, page, AI/privacy, and legal/privacy review.

`npm run kickstarter:page-review-audit` reads the latest page review intake and writes `test-results/ai-pen-kickstarter-page-review-audit/README.md` plus `report.json`. Use it after filling real preview URL, legal/privacy review link, reviewed page sections, legal/privacy check decisions, and owner/founder approval. It is not publish approval.

`npm run kickstarter:prelaunch-page-intake` writes `test-results/ai-pen-kickstarter-prelaunch-page-intake/YYYY-MM-DD/README.md` plus `manifest.json`, `raw/page-fields.csv`, `raw/notify-me-tracking.csv`, `raw/owner-review.csv`, `reviews/founder-review.md`, and screenshots/exports/artifacts folders. Use it before creating or updating the Kickstarter pre-launch page so preview URL, live URL, Notify me UTM rows, screenshots, owner review, founder review, and dashboard exports land in one dated package. It is not publish approval.

`npm run kickstarter:prelaunch-page-intake-audit` reads the latest pre-launch page intake package and writes `test-results/ai-pen-kickstarter-prelaunch-page-intake-audit/README.md` plus `report.json`. Use it after filling real Kickstarter and GTM artifacts but before treating the pre-launch page as ready: it checks actual URL values, resolved screenshots/artifacts, ready Notify me tracking rows, and owner/founder review decisions. Template rows with TBD intentionally stay red.

`npm run kickstarter:prelaunch-page-pack` reads the pre-launch page draft, pre-launch page intake audit, public copy lock, claim downgrade pack, launch evidence audit, GTM tracker, page checklist, and source GTM plan, then writes `test-results/ai-pen-kickstarter-prelaunch-page/README.md` plus `prelaunch-page.json`. Use it before publishing or promoting the Kickstarter pre-launch page; it keeps Kickstarter preview URL, pre-launch URL, Notify me funnel, UTM tracking, owner review, pre-launch intake readiness, and GTM readiness visible. It is not publish approval and follower counts need real Kickstarter dashboard exports.

`npm run kickstarter:risk-register` reads the source risk matrix, launch audit, action plan, critical path, weekly sprint, Launch KPI dashboard, Kickstarter claim downgrade pack, and public copy lock, then writes `test-results/ai-pen-kickstarter-risk-register/README.md` plus `risk-register.json`. Use the Kickstarter risk register as the weekly P0 board: it tracks open P0 risks, launch-impacting risks, next-week actions, and downgrade paths. It is not launch approval.

`npm run kickstarter:ops-refresh` runs the weekly operating refresh chain and writes `test-results/ai-pen-kickstarter-ops-refresh/README.md` plus `ops-refresh.json`. Use it before weekly review, rehearsal status review, campaign-copy review, supplier review, formal page/legal review, pre-launch page review, or launch signoff review. It also refreshes the public copy lock, supplier quote audit, page review audit, pre-launch page intake audit, Kickstarter pre-launch page pack, Launch operator pack, Kickstarter launch signoff audit, Kickstarter launch freeze pack, and Kickstarter launch-day command center, and strict mode stays red until launch evidence, P0 risk, final-cut proof shots, public copy lock, supplier quotes, page review, pre-launch intake, pre-launch page, launch signoff, launch freeze, and launch-day command center are ready. It does not create a new proof-shot intake package, supplier quote intake package, page review intake package, or pre-launch page intake package; run `npm run kickstarter:proof-shot-intake` explicitly before filming, `npm run kickstarter:supplier-quote-intake` explicitly before supplier review, `npm run kickstarter:page-review-intake` explicitly before formal page/legal review, and `npm run kickstarter:prelaunch-page-intake` explicitly before page setup.

`npm run kickstarter:launch-signoff-audit` reads [launch-freeze-signoff.md](./launch-freeze-signoff.md), then writes `test-results/ai-pen-kickstarter-launch-signoff-audit/README.md` plus `report.json`. Use it before launch freeze review to check campaign, hardware, GTM, legal/privacy, operations, founder/manual-launch signoffs, manual launch operator, launch-room coverage, final decision, and T-24h to T+24h task evidence. It is not launch approval.

`npm run kickstarter:launch-freeze-pack` reads the launch audit, public copy lock, risk register, proof-shot audit, supplier quote audit, page review audit, launch signoff audit, Kickstarter page checklist, BOM/supplier tracker, GTM tracker, launch freeze signoff, rehearsal pack, operator pack, and launch review pack, then writes `test-results/ai-pen-kickstarter-launch-freeze/README.md` plus `launch-freeze.json`. Use it for final page-freeze or Go/No-Go review; it is not launch approval by itself and must stay red while preview, page review, legal/privacy, supplier quotes, rewards, GTM, proof shots, P0 risk, launch evidence, launch signoff, rehearsal, operator, weekly review, or human signoff gates are missing.

`npm run kickstarter:launch-day-command-center` reads the launch freeze pack, public copy lock, risk register, proof-shot audit, launch signoff audit, launch freeze signoff, GTM tracker, Kickstarter page checklist, campaign drafts, launch-day comms pack, and source GTM launch-day script, then writes `test-results/ai-pen-kickstarter-launch-day-command-center/README.md` plus `command-center.json`. Use it after page-freeze review to check the T-24h to T+24h operating board, including seed email, launch-soon email, manual Kickstarter launch owner, social posts, FAQ response rotation, short demo clip, first update, conversion review, thank-you update, and support escalation. It is not launch approval; Kickstarter launch is a manual action.

`npm run launch:review-pack` reads the latest local demo evidence bundle, browser smoke, launch evidence intake audit, evidence record update plan, evidence record apply dry run, Kickstarter critical path, Kickstarter weekly sprint, Launch KPI dashboard, Kickstarter claim downgrade pack, public copy lock, supplier quote audit, page review audit, Kickstarter risk register, launch audit, and action plan, then writes `test-results/ai-pen-launch-review-pack/README.md` plus `review-pack.json`. Use it as the weekly launch review handoff; it keeps the status boundary explicit when the local demo is ready but Kickstarter launch evidence is still missing.

`npm run launch:evidence:intake-audit` reads the latest launch evidence intake package and writes `test-results/ai-pen-launch-evidence-intake-audit/README.md` plus `report.json`. Use the Launch evidence intake audit after copying real raw files and running gate analyzers, but before editing Markdown evidence records: it checks that staging folders are not template-only, expected analyzer inputs and reports exist, analyzer JSON parses, `ok=true`, `gate_checks` pass, and supporting artifacts are present. It is not publish approval.

`npm run launch:evidence:record-update-plan` reads the latest intake audit and writes `test-results/ai-pen-launch-evidence-record-update-plan/README.md` plus `record-update-plan.json`. Use it before editing Markdown evidence records: only gates marked `ready_to_update_record` should be copied into these files, and gates marked `blocked_do_not_update_record` must stay unchanged.

`npm run launch:evidence:apply-record-updates` reads the latest record update plan and writes `test-results/ai-pen-launch-evidence-record-apply/README.md` plus `apply-report.json`. It is dry-run by default and previews only safe path fields from `ready_to_update_record` rows. After manual review, `npm run launch:evidence:apply-record-updates:write` can write eligible path fields into the matching Markdown records, but it never writes human gate decisions.

`npm run launch:operator-pack` reads the latest action plan, weekly sprint, intake audit, evidence record update plan, launch audit, proof-shot audit, and Kickstarter pre-launch page pack, then writes `test-results/ai-pen-launch-operator-pack/README.md` plus `operator-pack.json`. Use the Launch operator pack as the field handoff for real capture days and pre-launch-page operations: it keeps all 8 launch-gate field work orders, First 48 Hours capture sessions, raw/report/artifact targets, Pre-Launch / Notify me work order, the after-capture command loop, the evidence-record writeback guard, and proof-shot capture queue in one place. It is not launch approval and does not edit evidence records. Strict operator readiness requires both launch evidence readiness and `prelaunch_page_ready`; otherwise it must stay red.

`npm run kickstarter:rehearsal-pack` reads the latest local demo assets, campaign draft pack, proof-shot gaps, claim boundaries, public copy lock status, supplier quote audit, page review audit, and launch review status, then writes `test-results/ai-pen-kickstarter-rehearsal/README.md` plus `rehearsal-pack.json`. Use it before external demos and campaign-video rehearsals; it is not publish approval.

`npm run kickstarter:proof-shot-intake` reads the campaign video final-cut checklist and writes `test-results/ai-pen-kickstarter-proof-shot-intake/YYYY-MM-DD/` with one folder per proof shot, `raw/shot-log.csv`, `raw/claim-review.csv`, required artifacts, and linked evidence records. Use it before filming real Kickstarter video proof shots; it is not publish approval.

`npm run kickstarter:proof-shot-audit` reads the latest proof-shot intake package and writes `test-results/ai-pen-kickstarter-proof-shot-audit/README.md` plus `report.json`. Use it after filming real proof shots and before final-cut review; it checks usable clip paths, public approvals, required visibility fields, and claim-review decisions. It is not launch approval.

## Launch Evidence Intake Package

Before a real rehearsal or supplier/GTM evidence review, generate a dated intake package:

```bash
npm run launch:evidence:intake
```

Output:

```text
test-results/ai-pen-launch-evidence-intake/YYYY-MM-DD/README.md
test-results/ai-pen-launch-evidence-intake/YYYY-MM-DD/manifest.json
```

The intake package creates one folder per launch gate with raw/report/artifact subfolders, CSV or JSONL templates, analyzer commands, and the exact Markdown evidence fields to update. It is a staging area only: fixture rows, template rows, and empty folders are not launch evidence. After a real run, copy the real artifacts into the matching folder, run the analyzer command, run `npm run launch:evidence:intake-audit`, run `npm run launch:evidence:record-update-plan`, run `npm run launch:evidence:apply-record-updates`, write only reviewed `ready_to_update_record` values into the matching evidence record, set the human `Decision` row manually, then run `npm run launch:evidence:audit`.

For a directly openable Obsidian demo vault:

```bash
npm run obsidian:demo-vault
```

Output:

```text
test-results/obsidian-demo-vault/
```

This vault is useful for showing the current education and meeting projection output in Obsidian with the plugin installed. It is still demo data and cannot close the real education, real meeting, or real hardware evidence gates.

## Hardware Log Analyzer

Use the AI Pen run analyzer when a real or simulated RawPenFrame log is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:ai-pen-run -- /path/to/raw-pen-run.jsonl --out /tmp/ai-pen-run-report.json
```

The analyzer accepts JSONL or JSON arrays of `RawPenFrame` records, validates the `inkloop.ai_pen.v1` frame contract, counts pen down/up completeness, and reports pen-to-host latency percentiles from `ts_host_ms - ts_device_ms`.

On M103 Android/Paper devices, `window.InkLoopM103RawPenCapture.exportJsonl()` exposes the latest vendor `hqunifiedsocket` stroke as RawPenFrame JSONL after a successful socket-backed stroke commit. Treat that export as raw input for the hardware prototype record only after it is paired with device ID, video/replay proof, latency analysis, and a human evidence decision.

Smoke fixture:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:ai-pen-evidence
```

## Capture Surface Calibration Analyzer

Use the Capture Surface calibration analyzer when a measured point table is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:capture-surface -- /path/to/calibration.csv --out /tmp/capture-surface-report.json
```

Required fields:

| Field | Meaning |
| --- | --- |
| `run_id` | Calibration session identifier |
| `surface_id` | Physical Capture Surface identifier |
| `surface_size` | `A2`, `A3`, or the measured surface label |
| `point_id` | Measured point identifier |
| `region` | `center`, `edge`, `corner`, or `unknown` |
| `expected_x_mm`, `expected_y_mm` | Ground-truth point coordinate in millimeters |
| `observed_x_mm`, `observed_y_mm` | Captured point coordinate in millimeters |
| `lighting` | Optional lighting condition |
| `condition` | Optional surface condition or writing case |

The analyzer reports Euclidean error in millimeters, overall and per-region P50/P95/max error, per-run stability, and gate checks for `P95 <= 5 mm`, `>= 95%` stable sessions, edge/corner coverage, and A2/A3 coverage.

Smoke fixture:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:capture-surface-evidence
```

## Live Board Latency Analyzer

Use the Live Board latency analyzer when a render timing log is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:live-board-latency -- /path/to/live-board-timing.csv --out /tmp/live-board-latency-report.json
```

Required fields:

| Field | Meaning |
| --- | --- |
| `run_id` | Latency test session identifier |
| `scenario` | `education`, `meeting`, or another scenario label |
| `event_id` | Stroke segment, frame, or render event identifier |
| `raw_frame_timestamp_ms` | Earliest available pen frame timestamp |
| `host_receive_timestamp_ms` | Host ingestion timestamp |
| `ink_event_timestamp_ms` | Runtime ledger append timestamp for delivered events |
| `render_commit_timestamp_ms` | Live Board render completion timestamp for delivered events |
| `dropped` | Optional boolean/drop marker |
| `transport`, `pen_id`, `session_id` | Optional evidence dimensions |

The analyzer reports pen-to-host, host-to-InkEvent, InkEvent-to-render, and end-to-end latency percentiles. Gate checks cover `P50 <= 150 ms`, `P95 <= 300 ms`, drop rate `<= 1%`, delivered render events, and education/meeting scenario coverage.

Smoke fixture:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:live-board-latency-evidence
```

## Demo Review Analyzer

Use the demo review analyzer when a human-reviewed education or business meeting candidate table is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:demo-review -- /path/to/demo-review.csv --out /tmp/demo-review-report.json
```

Required fields:

| Field | Meaning |
| --- | --- |
| `session_id` | Education or meeting demo session identifier |
| `scenario` | `education` or `meeting` |
| `real_hardware` | Whether the session came from a real AI Pen and Capture Surface run |
| `duration_min` | Session duration in minutes |
| `candidate_id` | Reviewed AI output candidate identifier |
| `kind` | Output kind such as `formula_step`, `concept`, `lesson_note`, `meeting_decision`, `meeting_action`, `meeting_risk`, or `diagram` |
| `source_ref_valid` | Whether the candidate has a valid source reference |
| `source_ref_type` | `ink_event`, `board_object`, `audio`, or another source label |
| `reviewer_action` | `accept`, `edit`, `dismiss`, or `follow_up` |
| `hallucination_severity` | `none`, `minor`, or `severe` |
| `audio_only` | Whether the candidate depends only on audio/subtitle context |
| `diagram_was_drawn` | Whether the meeting included a drawn diagram |
| `final_use` | Final destination such as `lesson_note`, `meeting_output`, or `none` |

The analyzer reports schema validity, session duration gates, promoted-item source reference gates, education formula/concept usability, meeting decision/action/risk/diagram usability, audio-only blocking, and whether a session is ready to use as a campaign demo.

Smoke fixture:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:demo-review-evidence
```

The smoke fixture is intentionally simulated. It shows that education and meeting review data can pass the candidate-quality gates while `campaign_demo_ready` remains false until `real_hardware` is true and raw session artifacts are attached.

## Reward Pricing Analyzer

Use the reward pricing analyzer when a BOM and supplier cost table is available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- /path/to/bom.csv --out /tmp/reward-pricing-report.json
```

Required fields:

| Field | Meaning |
| --- | --- |
| `reward_sku` | Reward tier or kit identifier |
| `category` | Cost category such as Pen, Surface, Packaging, Assembly, Software |
| `component` | BOM line item |
| `required` | Whether the line is required for the reward |
| `quantity_per_reward` | Quantity per shipped reward |
| `unit_cost_usd` | Unit cost in USD |
| `primary_supplier` | Current supplier option |
| `backup_supplier` | Backup supplier option |
| `quote_status` | `quoted`, `estimated`, or `unknown` |
| `confidence`, `lead_time_days`, `moq`, `risk` | Optional supplier and risk dimensions |

Default pricing assumptions:

| Assumption | Default |
| --- | ---: |
| Target margin | 35% |
| Kickstarter platform fee | 5% |
| Payment processing fee | 4% |
| Pledge manager fee | 2% |
| Duty/tax buffer | 8% |
| Warranty buffer | 8% |
| Contingency buffer | 12% |
| Price rounding | $5 |

The analyzer reports base unit cost, buffer cost, landed unit cost, minimum pledge price, rounded minimum pledge price, expected net after fees, expected margin, category rollup, BOM completeness, estimate/quote coverage, confirmed quote coverage, and backup supplier coverage.

`pricing_model_has_required_inputs` can pass with estimated rows. `supplier_backed_for_public_page` requires confirmed quotes and is the stricter public pricing gate.

Smoke fixture:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:reward-pricing-evidence
```

## GTM Metrics Analyzer

Use the GTM metrics analyzer when weekly CRM, Kickstarter dashboard, testimonial, and first-day backer snapshots are available:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:gtm-metrics -- /path/to/gtm-snapshots.csv --out /tmp/gtm-report.json
```

Required fields:

| Field | Meaning |
| --- | --- |
| `week_ending` | Weekly snapshot date |
| `email_list` | Valid launch-update email opt-ins |
| `ks_followers` | Kickstarter pre-launch followers |
| `testimonials` | Public-use testimonials with consent |
| `first_day_likely_backers` | Leads tagged as likely first-day backers |
| `education_leads` | Education segment leads |
| `business_leads` | Business/meeting segment leads |
| `source_export_link` | CRM/dashboard/export evidence link |
| `decision` | Optional weekly decision note |

Default targets:

| Target | Value |
| --- | ---: |
| 2026-09-30 email checkpoint | 500 |
| 2026-09-30 Kickstarter follower checkpoint | 150 |
| Launch email list | 1,000 |
| Launch Kickstarter followers | 300 |
| Launch public testimonials | 8 |
| Launch first-day likely backers | 50 |

The analyzer reports latest snapshot, week-over-week deltas, progress to launch targets, education/business lead split, checkpoint gates, and final launch demand gates.

Smoke fixture:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:gtm-metrics-evidence
```

The smoke fixture shows the data model and 9/30 checkpoint flow only; it intentionally does not pass `launch_demand_ready`.
