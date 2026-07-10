# Claim Evidence Matrix

Date: 2026-07-03
Status: Working guardrail for campaign copy

Use this file before moving campaign copy to Kickstarter. The page can only use public wording that matches the current evidence status.

## Evidence Status Labels

| Status | Meaning |
| --- | --- |
| Verified | Real artifact proves the claim for launch conditions |
| Demo-only | Local or simulated demo proves the workflow shape, not real launch performance |
| Missing evidence | Claim is strategically intended but not yet proven |
| Blocked until hardware | Requires AI Pen, firmware, Capture Surface, real transport, or physical material evidence |
| External | Requires supplier, GTM, pricing, testimonial, or Kickstarter dashboard evidence |

## Claims

| Claim ID | Claim | Current Status | Required Evidence | Allowed Current Wording | Wording To Avoid |
| --- | --- | --- | --- | --- | --- |
| C-HW-1 | AI Pen writes with real dry-erase ink | Blocked until hardware | [Hardware prototype run log](../evidence/hardware-prototype-run-log.md), prototype video | "The product is being built as a real dry-erase AI whiteboard pen." | "Verified real-ink hardware is ready." |
| C-HW-2 | AI Pen captures pen down/up and coordinates | Demo-only | [Hardware prototype run log](../evidence/hardware-prototype-run-log.md), RawPenFrame logs | "The software contract and sample analyzer support pen frame logs." | "Real prototype capture is validated." |
| C-SURF-1 | Capture Surface enables accurate spatial capture | Demo-only | [Capture Surface calibration report](../evidence/capture-surface-calibration-report.md), material test | "Capture Surface is the intended spatial reference layer." | "Works on any whiteboard without setup." |
| C-SURF-2 | A2/A3 accuracy target <= 5 mm | Demo-only | Physical calibration CSV/JSON and analyzer report | "The calibration gate is <= 5 mm and the analyzer is ready." | "A2/A3 accuracy is proven." |
| C-LIVE-1 | Live Board latency target P50 <= 150 ms, P95 <= 300 ms | Demo-only | [Live Board latency report](../evidence/live-board-latency-report.md) from real BLE/wired logs | "The latency gate is P50 <= 150 ms and P95 <= 300 ms; sample analyzer is ready." | "Instant / zero latency." |
| C-EDU-1 | Education sessions become lesson notes | Demo-only | [Education demo review record](../evidence/education-demo-review.md), real lesson video, exported notes | "In our local demo, education board events become reviewed lesson-note candidates." | "Perfect lesson generation." |
| C-MTG-1 | Meeting boards become actions, decisions, risks, and diagrams | Demo-only | [Business meeting demo review record](../evidence/business-meeting-demo-review.md), real meeting video, exported outputs | "In our local demo, marked board events become reviewed meeting-output candidates. Audio/subtitles/timeline may be optional context only." | "Fully automatic meeting assistant." / "Automatic meeting minutes from audio or subtitles." |
| C-AI-1 | AI outputs are reviewable and traceable | Verified for demo contract | Runtime schema tests, knowledge projection tests, AI Pen smoke | "AI outputs are designed to be reviewed, edited, accepted, or dismissed with source references." | "AI is always correct." |
| C-OBS-1 | Obsidian receives reviewed knowledge projection grouped by source file/session units | Verified for demo contract | Obsidian adapter tests, plugin build, browser projection smoke, source-unit frontmatter in demo vault | "Obsidian can receive reviewed knowledge projection grouped by source file or meeting session with backlinks." | "Obsidian is the capture truth source." |
| C-EPAPER-1 | E-paper is not base Kickstarter scope | Verified in docs | Project README, runbook, Android docs | "InkLoop Paper is roadmap/runtime reuse, not the base October reward." | "E-paper tablet included in base kit." |
| C-SUPPLY-1 | Reward pricing is reliable | External | [BOM and supplier tracker](../evidence/bom-supplier-tracker.md), supplier quotes, pricing model | "Pricing is draft until BOM and supplier quotes are reviewed." | "Final price and delivery are guaranteed." |
| C-GTM-1 | Demand goals are on track | External | [GTM metrics tracker](../evidence/gtm-metrics-tracker.md), CRM/dashboard exports | "Pre-launch targets are email list >= 1,000 and KS followers >= 300." | "Audience demand is already proven." |

## Publish Copy Gate

| Page Section | Minimum Evidence Before Publish |
| --- | --- |
| Hero | Prototype video or clear demo-only label |
| Product | Hardware run log and Capture Surface limitations |
| Education demo | Real teacher session and reviewed output |
| Meeting demo | Real meeting session and reviewed output |
| Rewards | BOM/pricing model and supplier quote assumptions |
| Timeline | Supplier/manufacturing route and buffer |
| AI/privacy | Reviewability and data-use wording present |
| Risks | Hardware, Surface, AI, supply, delivery risks present |

## Downgrade Rule

If a claim has only `Demo-only` evidence, write it as a prototype/demo workflow, not as a launch performance fact. If a claim is `Missing evidence`, keep it out of public copy or put it in internal draft notes only.
