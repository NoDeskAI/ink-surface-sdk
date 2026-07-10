# Kickstarter Launch-Day Comms Pack

Date: 2026-07-03
Status: First launch-day comms draft, not approved for send

This pack turns the source launch-day script into reusable launch emails, social posts, comment replies, update drafts, and support escalation notes. It is a campaign operating asset, not launch approval. Do not send any item until the launch freeze pack, public copy lock, proof-shot audit, GTM evidence, page review, and owner signoff are ready.

Source basis:

- [Kickstarter GTM and page plan](../source/06_Kickstarter_GTM与众筹页面方案.md)
- [Kickstarter page draft](./kickstarter-page-draft.md)
- [Rewards and FAQ draft](./rewards-faq-draft.md)
- [Claim evidence matrix](./claim-evidence-matrix.md)
- [Launch freeze signoff](../evidence/launch-freeze-signoff.md)

## Placeholders

Replace these before approval:

| Placeholder | Meaning | Owner |
| --- | --- | --- |
| `[LAUNCH_URL]` | Kickstarter live project URL | Campaign |
| `[PRELAUNCH_URL]` | Kickstarter pre-launch page URL | Campaign |
| `[LAUNCH_TIME]` | Launch time with timezone | Campaign |
| `[EARLY_BIRD_QTY]` | Early Bird quantity | Campaign / Ops |
| `[EARLY_BIRD_PRICE]` | Early Bird price | Ops |
| `[REWARD_PRICE_RANGE]` | Public reward range | Ops |
| `[DEMO_VIDEO_URL]` | Approved demo or campaign video URL | Campaign |
| `[SUPPORT_EMAIL]` | Support contact address | Ops |
| `[SHIPPING_SUMMARY]` | Reviewed shipping scope and caveat | Ops / Legal |
| `[PRIVACY_SUMMARY]` | Reviewed AI/privacy wording | Legal / Product |

## Approval Rules

| Rule | Required Before Send |
| --- | --- |
| Public product claims | Must match [claim-evidence-matrix.md](./claim-evidence-matrix.md) and current public copy lock |
| Hardware and Capture Surface claims | Must have real prototype and Surface evidence or be framed as prototype/demo wording |
| Pricing and delivery | Must match BOM, supplier, shipping, tax, and support assumptions |
| AI and privacy | Must match legal/privacy review and page copy |
| Founder/team posts | Must use the same non-claims as the Kickstarter page |
| Comment replies | Must stay factual, bounded, and escalation-ready |

## T-24h Seed User Launch Email

Subject options:

1. InkLoop AI Pen launches tomorrow
2. Tomorrow: help us bring real whiteboards into the AI workflow
3. 24 hours until InkLoop AI Pen launches on Kickstarter

Body:

```text
Hi [FIRST_NAME],

Tomorrow at [LAUNCH_TIME], we are launching InkLoop AI Pen on Kickstarter.

InkLoop is built for people who still think best on a real whiteboard: teachers, tutors, product teams, engineering teams, and workshop-heavy teams.

The first version focuses on a clear kit:

- InkLoop AI Pen
- Capture Surface
- Host App and Live Board
- InkLoop Studio
- Reviewed AI lesson notes, diagrams, decisions, risks, and action items

Early Bird quantity will be limited to [EARLY_BIRD_QTY]. The project will go live here:

[LAUNCH_URL]

If the product matches a problem you have seen in teaching or whiteboard meetings, backing early or leaving a thoughtful comment in the first hour would help us a lot.

Thank you for being part of the early group.

[FOUNDER_NAME]
InkLoop
```

Send requirements:

- Segment includes only opted-in seed users.
- Launch time, URL, Early Bird quantity, and reward copy match approved page.
- No unsupported hardware, pricing, delivery, or AI claims.

## T-24h Trial User Reminder

Subject options:

1. One small ask before tomorrow's InkLoop launch
2. InkLoop launches tomorrow - your comment would help
3. Tomorrow's Kickstarter launch: what to watch for

Body:

```text
Hi [FIRST_NAME],

We are launching InkLoop AI Pen on Kickstarter tomorrow at [LAUNCH_TIME].

You have seen the product direction early, so your feedback is especially useful. If you are comfortable doing so, please visit the page after launch, watch the demo, and leave a comment about the whiteboard problem you care about most:

- education notes after board teaching
- hybrid team whiteboard visibility
- meeting decisions and action items
- replaying the reasoning behind a board session

Launch URL:
[LAUNCH_URL]

Please only share your honest view. We want the page to set clear expectations about the first version, including the Capture Surface requirement, AI review step, and delivery risks.

Thanks,
[FOUNDER_NAME]
```

## Comment FAQ Macros

Use these as starting replies. Update facts before posting.

### Does InkLoop work on any whiteboard?

```text
InkLoop uses our Capture Surface. You can place it on a regular whiteboard and write with real dry-erase ink, but the Capture Surface gives the system the spatial reference needed for accurate capture. We are not claiming no-setup compatibility with every ordinary whiteboard in the first version.
```

### Is this a camera product?

```text
No. InkLoop is designed around pen and stroke capture rather than recording a video of the board. That is what enables stroke replay, source references, and structured exports. Demo videos may show the product in use, but video is not the core capture mechanism.
```

### What happens if AI gets something wrong?

```text
AI outputs are reviewable. The user can edit, accept, or dismiss candidates before they become long-term notes, diagrams, decisions, risks, or action items. We keep source references back to the captured board work so users can verify the result.
```

### Is Obsidian required?

```text
No. Obsidian is an optional projection/export path for people who use it. The capture source of truth is the InkLoop session ledger and source references.
```

### Is an e-paper tablet included?

```text
No. The October Kickstarter base scope is AI Pen, Capture Surface, Host App, Live Board, InkLoop Studio, and exports. InkLoop Paper and e-paper review are roadmap/runtime reuse work, not the base reward.
```

### Will it support multiple pens?

```text
Single-pen capture is the core first-version commitment. Multi-pen and multi-color workflows are staged after the core capture and AI review workflow is stable.
```

### What about shipping and delivery dates?

```text
We will publish the current timeline, known risks, and updates as the hardware, supplier, testing, and fulfillment plan matures. Hardware, certification, supplier lead time, and shipping can affect delivery, so we will keep the risk section and updates explicit.
```

### What data is sent to AI?

```text
InkLoop is designed to process the minimum necessary session context for AI outputs, such as structured writing context and source references. Raw whiteboard video is not required for the core workflow because InkLoop captures pen strokes directly. Final data-use wording must match the AI/privacy section on the page.
```

Escalate instead of answering when:

- A backer asks for a guaranteed delivery date, certified compliance, or final price not approved in the page.
- A journalist asks for claims beyond the current evidence matrix.
- A backer reports payment, pledge, refund, account, or Kickstarter platform issues.
- A question involves privacy, school data, student data, or enterprise procurement terms.

## T-2h Launch-Soon Email

Subject options:

1. InkLoop AI Pen launches in 2 hours
2. Launching soon: InkLoop AI Pen on Kickstarter
3. Two hours until launch

Body:

```text
Hi [FIRST_NAME],

InkLoop AI Pen launches on Kickstarter in 2 hours:

[LAUNCH_URL]

The first version is focused: a real whiteboard workflow for education and business meetings, built around AI Pen, Capture Surface, Host App, Live Board, InkLoop Studio, and reviewable AI outputs.

If you plan to back the project, the Early Bird tier will be limited to [EARLY_BIRD_QTY].

Thank you for following the build.

[FOUNDER_NAME]
```

## T Manual Launch Checklist

| Check | Owner | Required Evidence |
| --- | --- | --- |
| Final Go/No-Go decision is Ready | Founder | Launch freeze signoff |
| Kickstarter page preview reviewed | Campaign | Preview link and reviewer notes |
| Rewards, shipping, and risks match approved copy | Ops / Campaign | Page checklist and rewards FAQ |
| Video playback checked | Campaign | Proof-shot audit and page QA |
| Support contact active | Ops | Support roster and escalation path |
| First-hour response team online | Founder / Ops | Launch room roster |

Manual launch operator note:

```text
Kickstarter launch is manual. The assigned operator must be present at [LAUNCH_TIME], confirm final Go/No-Go in the launch room, publish the page, capture the live URL, and notify the email/social owners only after the live page is verified.
```

## T+5m Email Blast

Subject options:

1. InkLoop AI Pen is live on Kickstarter
2. We are live: InkLoop AI Pen
3. Back InkLoop AI Pen on Kickstarter

Body:

```text
Hi [FIRST_NAME],

InkLoop AI Pen is now live on Kickstarter:

[LAUNCH_URL]

InkLoop is for teachers, tutors, and teams who still use whiteboards because writing is the fastest way to explain, think, and decide.

The first kit focuses on:

- real dry-erase writing with AI Pen
- Capture Surface for spatial capture
- Live Board for remote visibility
- Studio replay and review
- editable lesson notes, diagrams, decisions, risks, and action items
- Markdown, PDF, PNG, Mermaid, and Obsidian projection exports

Please read the page carefully. We are keeping the first version intentionally focused and explaining the current risks and limits clearly.

Back or follow here:
[LAUNCH_URL]

Thank you,
[FOUNDER_NAME]
```

## T+15m Social Posts

### LinkedIn

```text
We just launched InkLoop AI Pen on Kickstarter.

InkLoop is built for teachers, tutors, and teams who still think best on a real whiteboard.

The first kit focuses on AI Pen + Capture Surface + Host App + Live Board + InkLoop Studio, so whiteboard sessions can become live board views, replayable sessions, and reviewable AI lesson or meeting outputs.

We are keeping the first version focused and transparent about limits: Capture Surface is required, AI outputs need review, and hardware delivery carries real risk.

[LAUNCH_URL]
```

### X / Short Post

```text
InkLoop AI Pen is live on Kickstarter.

Write naturally on a real whiteboard. Capture strokes live. Replay the session. Review AI lesson notes, diagrams, decisions, and action items.

AI Pen + Capture Surface + Host App + Live Board + Studio.

[LAUNCH_URL]
```

### Education Community

```text
We launched InkLoop AI Pen for teachers and tutors who still teach best on a whiteboard.

The goal: keep natural board teaching, make it visible live, then turn the session into editable lesson notes after class.

We are looking for feedback from educators on the first kit, risks, and lesson workflow:

[LAUNCH_URL]
```

### Business / Product Community

```text
We launched InkLoop AI Pen for teams that still rely on physical whiteboards for architecture, product planning, workshops, and design reviews.

The goal: keep the speed of the board, then turn marked board work into reviewed decisions, action items, risks, and diagrams.

[LAUNCH_URL]
```

## T+30m Seed Supporter DM

```text
Hi [FIRST_NAME], InkLoop AI Pen is live now:

[LAUNCH_URL]

If the project still matches the whiteboard problem we discussed, an early back or comment in the first hour would help. Honest feedback is also welcome, especially around the education or meeting workflow.
```

## T+3h Short Demo Clip Caption

```text
Whiteboards are fast, but follow-up is painful.

InkLoop AI Pen captures a board session as strokes, shows it live, replays it afterward, and turns reviewed board evidence into lesson notes, diagrams, decisions, risks, and action items.

Now live on Kickstarter:
[LAUNCH_URL]
```

Clip approval checks:

- Shows Capture Surface requirement.
- Shows user review before export.
- Does not speed up Live Board timing without disclosure.
- Does not claim perfect AI, any-whiteboard support, zero latency, or guaranteed delivery.

## T+6h First Progress Update

Title:

```text
We are live - thank you for the first wave of support
```

Body:

```text
Thank you to everyone who backed, followed, commented, or shared InkLoop AI Pen today.

Our goal with this Kickstarter is focused: bring real whiteboard teaching and meeting work into a structured digital workflow without forcing people to switch to a tablet-first process.

Early questions we are seeing:

1. Capture Surface is required for the first version.
2. Single-pen capture is the core commitment.
3. AI outputs are reviewable and traceable, not final truth.
4. Obsidian is an optional projection/export path, not the capture source of truth.
5. We will keep hardware, supply, and delivery risks visible as the project moves forward.

We will keep answering questions in the comments and updating the FAQ as patterns emerge.

[FOUNDER_NAME]
```

## T+12h Conversion Review Checklist

| Question | Data Source | Action |
| --- | --- | --- |
| Which reward tier is converting best? | Kickstarter dashboard | Move the most relevant FAQ higher |
| Which segment is commenting more: education or business? | Comments and CRM tags | Adjust the first visible use-case block if needed |
| Which objection repeats most? | Comments and support log | Add or revise top-page FAQ |
| Are people confused about Capture Surface? | Comments, refunds, DMs | Make Surface requirement more visible |
| Are people asking for e-paper, multi-pen, or integrations? | Comments | Reply with roadmap boundary and avoid base-scope expansion |
| Are payment or shipping questions increasing? | Support queue | Escalate to Ops and update FAQ only after review |

Top FAQ adjustment rule:

```text
Only move or add FAQ copy that matches the approved page, risk checklist, and claim evidence matrix. If a repeated question requires new claims, add an internal note first and wait for owner review.
```

## T+24h First-Day Thank-You Update

Title:

```text
Day 1: thank you, and what we are watching next
```

Body:

```text
Thank you for the first day of support for InkLoop AI Pen.

The first 24 hours have helped us learn which parts of the product story matter most: education board teaching, business whiteboard meetings, Live Board visibility, replay, and reviewable AI outputs.

What we are watching next:

- reward tier feedback
- education vs business demand
- questions about Capture Surface setup
- questions about AI/privacy and review controls
- manufacturing, delivery, and support questions

We will keep the page and updates honest about what is included in the first version and what remains roadmap work.

Thank you for helping us build this carefully.

[FOUNDER_NAME]
```

Metrics to fill before posting:

| Metric | Value |
| --- | --- |
| Backers | TBD |
| Funding | TBD |
| Most selected reward | TBD |
| Top education question | TBD |
| Top business question | TBD |
| Top risk/support question | TBD |

## Support Escalation

| Topic | First Reply Owner | Escalation Owner | Response Rule |
| --- | --- | --- | --- |
| Reward contents | Campaign | Ops | Match rewards FAQ exactly |
| Shipping and taxes | Support | Ops | Do not invent shipping promises |
| Delivery timing | Support | Founder / Ops | Use approved timeline and risk wording |
| Capture Surface setup | Product | Hardware | Explain requirement and current limits |
| AI/privacy | Product | Legal/privacy | Use reviewed AI/privacy copy only |
| School or enterprise procurement | Sales / Founder | Legal / Ops | Move to private follow-up |
| Refund/payment/platform issue | Support | Kickstarter support path | Keep platform boundaries clear |
| Press or partnership | Founder | Campaign | Keep claims within evidence matrix |

Support log fields:

| Field | Required |
| --- | --- |
| Timestamp | Yes |
| Channel | Kickstarter comment / DM / email / social |
| Topic | Yes |
| Segment | Education / Business / Supporter / Press / Other |
| Owner | Yes |
| Current status | Open / Waiting / Resolved / Escalated |
| Link | Yes |
| Follow-up needed | Yes / No |

## Launch-Day Readiness Mapping

| Launch-Day Command Center Item | Asset In This Pack | Approval State |
| --- | --- | --- |
| Seed user launch email prepared | T-24h seed user launch email | Draft, requires final launch URL/time/list |
| Trial user reminder prepared | T-24h trial user reminder | Draft, requires consent-backed segment |
| Comment FAQ template prepared | Comment FAQ macros | Draft, requires campaign/legal/privacy review |
| Page rewards shipping risk and video final check complete | Manual launch checklist and clip approval checks | Draft, requires page QA evidence |
| Founder and team online shift confirmed | Support escalation and launch-room owner notes | Draft, requires roster |
| Launch soon email prepared | T-2h launch-soon email | Draft, requires final launch URL/time |
| Manual Kickstarter launch owner assigned | T manual launch checklist | Draft, requires named owner |
| Email blast prepared | T+5m email blast | Draft, requires final segment and send approval |
| Social posts prepared | T+15m social posts | Draft, requires approved assets and accounts |
| Seed supporter outreach prepared | T+30m seed supporter DM | Draft, requires seed supporter list |
| Comment FAQ response rotation prepared | Comment FAQ macros and support escalation | Draft, requires live owner rotation |
| Short demo clip prepared | T+3h short demo clip caption | Draft, requires approved clip |
| First progress update and FAQ supplement prepared | T+6h progress update | Draft, requires first questions and page state |
| Conversion review and top FAQ adjustment prepared | T+12h conversion review checklist | Draft, requires dashboard and support data |
| First-day thank-you update prepared | T+24h thank-you update | Draft, requires day-one metrics |
| Support escalation path prepared | Support escalation matrix | Draft, requires owner roster |

## Non-Claims

- This comms pack is not launch approval.
- Draft copy does not prove hardware, GTM, supplier, privacy, or proof-shot readiness.
- Do not send these messages until the Kickstarter page, rewards, shipping, risks, video, and owner signoffs are approved.
- Do not add claims outside the claim evidence matrix during live comments.
