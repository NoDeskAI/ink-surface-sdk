# Kickstarter Campaign Draft Pack

Date: 2026-07-03

This directory contains the first formal campaign draft pack for the October 2026 InkLoop AI Pen Kickstarter plan. It is page-ready in structure, but not publish-ready until the evidence gates referenced below are filled with real artifacts.

## Files

| File | Use |
| --- | --- |
| [kickstarter-page-draft.md](./kickstarter-page-draft.md) | Main Kickstarter page draft with evidence-bound public copy |
| [campaign-video-script.md](./campaign-video-script.md) | 90-second campaign video script and required proof shots |
| [rewards-faq-draft.md](./rewards-faq-draft.md) | Reward tier draft, pricing inputs, FAQ, AI/privacy copy, and risks |
| [claim-evidence-matrix.md](./claim-evidence-matrix.md) | Claim-by-claim wording guardrail tied to current evidence records |
| [prelaunch-page-pack.md](./prelaunch-page-pack.md) | Kickstarter pre-launch page fields, Notify me funnel, channel copy, tracking, and pre-launch readiness checks |
| [launch-day-comms-pack.md](./launch-day-comms-pack.md) | T-24h to T+24h email, social, comment FAQ, update, and support escalation drafts |

The pre-launch page pack is draft copy only until Kickstarter preview URL, pre-launch URL, public copy lock, claim downgrade, GTM tracking, owner review, and founder review are ready.

The launch-day comms pack is draft copy only until launch freeze, public copy lock, proof-shot audit, GTM evidence, and owner signoff are ready.

## Publish Rule

Before anything from this directory is pasted into Kickstarter, every public claim must be checked against [claim-evidence-matrix.md](./claim-evidence-matrix.md) and the matching evidence record under [../evidence/](../evidence/).

If a gate has only sample/demo evidence, use demo wording. If a gate has no real artifact, keep the copy as draft-only or downgrade the claim.

## Rehearsal Handoff

Before an external demo, founder walkthrough, or campaign-video rehearsal, run:

```bash
npm run kickstarter:claim-downgrade
npm run kickstarter:proof-shot-audit
npm run kickstarter:public-copy-lock
npm run kickstarter:supplier-quote-audit
npm run kickstarter:page-review-audit
npm run kickstarter:prelaunch-page-pack
npm run kickstarter:risk-register
npm run kickstarter:ops-refresh
npm run kickstarter:launch-signoff-audit
npm run kickstarter:launch-freeze-pack
npm run kickstarter:launch-day-command-center
npm run kickstarter:proof-shot-intake
npm run kickstarter:rehearsal-pack
```

`npm run kickstarter:claim-downgrade` writes the Kickstarter claim downgrade pack under `test-results/ai-pen-kickstarter-claim-downgrade/README.md` and `claim-downgrade.json`. Use it before any claim is copied into Kickstarter, video narration, ads, landing pages, launch emails, social posts, or comment replies: it classifies each claim as public claim allowed, guardrail copy allowed, demo wording only, or draft-only until evidence.

`npm run kickstarter:public-copy-lock` writes the Kickstarter public copy lock under `test-results/ai-pen-kickstarter-public-copy-lock/README.md` and `copy-lock.json`. Use it before campaign-copy review: it combines claim downgrade decisions, proof-shot readiness, launch evidence state, and campaign draft sources into one copy lock for Kickstarter page, video narration, ads, landing pages, launch emails, social posts, and comment replies. It is not publish approval.

`npm run kickstarter:supplier-quote-audit` writes the Kickstarter supplier quote audit under `test-results/ai-pen-kickstarter-supplier-quote-audit/README.md` and `report.json`. Use it before reward/pricing review: it checks the latest supplier quote intake for BOM cost completeness, confirmed quote coverage, backup supplier coverage, usable quote artifacts, a passing reward-pricing analyzer report, and a human supply-review decision. It is not reward pricing approval.

`npm run kickstarter:page-review-audit` writes the Kickstarter page review audit under `test-results/ai-pen-kickstarter-page-review-audit/README.md` and `report.json`. Use it before page freeze: it checks the latest formal page review intake for preview/legal links, reviewed page sections, AI/privacy and risk decisions, and owner/founder approval. It is not publish approval.

`npm run kickstarter:prelaunch-page-pack` writes the Kickstarter pre-launch page pack under `test-results/ai-pen-kickstarter-prelaunch-page/README.md` and `prelaunch-page.json`. Use it before publishing or promoting the Kickstarter pre-launch page: it checks the page fields, Notify me funnel, UTM convention, owner review placeholders, public copy lock, claim downgrade, launch evidence, and GTM decision. It is not publish approval and a drafted pre-launch page does not prove demand.

`npm run kickstarter:risk-register` writes the Kickstarter risk register under `test-results/ai-pen-kickstarter-risk-register/README.md` and `risk-register.json`. Use it before rehearsal or page review so open P0 risks, launch-impacting risks, next-week actions, and downgrade paths are visible next to claim decisions and public copy lock status. It is not publish approval.

`npm run kickstarter:ops-refresh` writes the Kickstarter ops refresh package under `test-results/ai-pen-kickstarter-ops-refresh/README.md` and `ops-refresh.json`. Use it before campaign-copy review so claim downgrade, public copy lock, supplier quote state, page review state, open P0 risk, rehearsal status, proof-shot audit status, launch-signoff state, launch-freeze state, and launch-day command center state are all refreshed together. Strict mode stays red until launch evidence, P0 risk, final-cut proof shots, public copy lock, supplier quotes, page review, launch signoff, launch freeze, and launch-day command center are ready. It is not publish approval.

`npm run kickstarter:launch-signoff-audit` writes the Kickstarter launch signoff audit under `test-results/ai-pen-kickstarter-launch-signoff-audit/README.md` and `report.json`. Use it before final Go/No-Go review: it checks owner signoffs, manual launch operator, launch-room coverage, final decision, and T-24h to T+24h task evidence. It is not publish approval.

`npm run kickstarter:launch-freeze-pack` writes the Kickstarter launch freeze pack under `test-results/ai-pen-kickstarter-launch-freeze/README.md` and `launch-freeze.json`. Use it before page freeze or final Go/No-Go review: it requires launch evidence, public copy lock, no open P0 risks, final-cut proof shots, Kickstarter preview, page review audit, legal/privacy review, supplier quote audit, rewards/pricing evidence, GTM evidence, launch signoff audit, rehearsal handoff, operator closeout, and weekly review agreement. It is not publish approval.

`npm run kickstarter:launch-day-command-center` writes the Kickstarter launch-day command center under `test-results/ai-pen-kickstarter-launch-day-command-center/README.md` and `command-center.json`. Use it after launch freeze review to keep T-24h, manual launch, T+5m/T+15m/T+30m, T+1h/T+3h/T+6h/T+12h/T+24h, and first-24h support tasks tied to launch signoff evidence and [launch-day-comms-pack.md](./launch-day-comms-pack.md). It is not publish approval, and Kickstarter launch is a manual action.

This writes `test-results/ai-pen-kickstarter-rehearsal/README.md` and `rehearsal-pack.json`. The Kickstarter rehearsal pack combines this campaign draft pack with local demo assets, proof-shot gaps from the video script, claim boundaries, public copy lock status, risk register status, and the current launch review status. It is not publish approval.

`npm run kickstarter:proof-shot-intake` writes the Kickstarter proof-shot intake under `test-results/ai-pen-kickstarter-proof-shot-intake/YYYY-MM-DD/README.md` and `manifest.json`. Use it before filming campaign proof shots: it creates one folder per final-cut checklist item, plus `raw/shot-log.csv` and `raw/claim-review.csv` templates that must be filled before a shot can be treated as public campaign evidence.

## Kickstarter Proof-Shot Audit

`npm run kickstarter:proof-shot-audit` writes `test-results/ai-pen-kickstarter-proof-shot-audit/README.md` and `report.json`. Use the Kickstarter proof-shot audit after filming to close the loop on shot logs, usable clip paths, public approval decisions, and claim-review decisions before moving a take into final cut.
