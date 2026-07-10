# InkLoop AI Pen Kickstarter Page Draft

Date: 2026-07-03
Status: First formal draft, evidence-bound, not publish-ready

Source basis:

- [06 Kickstarter GTM and campaign page plan](../source/06_Kickstarter_GTM与众筹页面方案.md)
- [01 Product strategy and Kickstarter plan](../source/01_产品战略与Kickstarter总方案.md)
- [07 Risks, acceptance metrics, and downgrade plan](../source/07_风险_验收指标_降级方案.md)
- [Launch readiness tracker](../launch-readiness-tracker.md)
- [Claim evidence matrix](./claim-evidence-matrix.md)

## Page Title

InkLoop AI Pen: Turn Real Whiteboard Writing into Live Notes, Diagrams & Action Items

## Subtitle

A real dry-erase smart pen and capture surface for teachers, tutors, and hybrid teams.

## Hero Section

Turn every whiteboard session into live notes, diagrams, and action items.

InkLoop AI Pen is a real dry-erase smart pen and capture surface for teachers, tutors, and hybrid teams. Write naturally. Share your board live. Replay every stroke. Review AI-generated lesson notes, diagrams, decisions, and action items afterward.

Primary visual:

- Teacher writes a short formula sequence on a real whiteboard with InkLoop AI Pen and Capture Surface.
- Live Board shows strokes in the Host App.
- InkLoop Studio turns the session into editable lesson notes.

CTA copy:

- Notify me on launch
- Watch the prototype demo
- See how it works

Evidence status:

- Hero flow is supported by local software demo today.
- Public hardware wording must wait for real prototype video, hardware run log, Capture Surface calibration report, and Live Board latency report.

## Problem

Whiteboards are still one of the fastest ways to teach, explain, brainstorm, and make decisions. The problem is not the whiteboard. The problem is what happens after the writing.

For teachers, the board is where the real reasoning happens: math steps, science diagrams, architecture sketches, and corrections in the moment. Remote students often miss details, and teachers spend extra time turning board work into notes, screenshots, and follow-up materials.

For teams, the whiteboard is where architecture, product planning, design reviews, and workshops move fastest. But remote teammates miss the details, and the final artifact is usually a blurry photo instead of editable decisions, diagrams, and action items.

InkLoop keeps the speed of the physical whiteboard and brings the session into a structured digital workflow.

## Product

InkLoop AI Pen Starter Kit includes:

- InkLoop AI Pen
- A2 Capture Surface
- Capture Host App
- Live Board Viewer
- InkLoop Studio
- AI credits for lesson notes and meeting outputs

Current launch scope:

- Single AI Pen capture is the core Kickstarter promise.
- Capture Surface is required for accurate spatial capture.
- Education and business whiteboard meetings are the first scenarios.
- E-paper reading and review remain part of the InkLoop Paper roadmap, not the October 2026 base reward.
- Multi-pen, multi-color, and deep third-party integrations are later-stage workflows.

## How It Works

1. Place the Capture Surface on your whiteboard.
2. Write with real dry-erase ink.
3. The AI Pen captures stroke events and sends them to the Host App.
4. Live Board shows the session as it happens.
5. InkLoop Studio replays the full session.
6. AI organizes the reviewed session into lesson notes, diagrams, decisions, risks, and action items.
7. Export to Markdown, PDF, PNG, Mermaid, or Obsidian projection.

Technical chain:

```text
RawPenFrame
-> Stroke
-> InkEvent
-> BoardGraph / InkGraph
-> LessonGraph or MeetingGraph
-> user accept / edit / dismiss
-> KnowledgeObject
-> Studio / Obsidian projection / export
```

AI outputs are editable, dismissible, and traceable. InkLoop keeps source references back to the original strokes and board regions so users can verify what the AI produced.

## Education Demo Section

Teach naturally on a real whiteboard.

InkLoop is designed for teachers, tutors, and technical educators who still explain best by writing. A lesson can be captured live, replayed stroke by stroke, and converted into editable notes after class.

Launch demo target:

- 5-8 minute real teacher session.
- One math, science, engineering, or technical lesson.
- Live Board visible to a student viewer.
- Studio replay of the full sequence.
- Reviewed lesson notes with formula steps and source references.

Evidence required before public claim:

- [Education demo review record](../evidence/education-demo-review.md)
- Real prototype video
- Exported lesson notes
- Reviewer accept/edit/dismiss metrics

Draft-only phrase until evidence exists:

> In our local demo, InkLoop turns a teaching board session into reviewed lesson notes and formula steps.

Publish phrase after real evidence:

> In our prototype lesson demo, InkLoop captured the board session live and generated editable lesson notes with traceable source references.

## Business Meeting Demo Section

Keep the speed of a physical whiteboard.

InkLoop is designed for architecture reviews, product workshops, planning sessions, and hybrid meetings where the board is the shared thinking surface.

Launch demo target:

- 5-8 minute real whiteboard meeting.
- Architecture, workflow, or product planning board.
- Marked decisions, risks, and next steps.
- Exported decisions, action items, and diagram draft.
- Human review before anything becomes long-term knowledge.

Evidence required before public claim:

- [Business meeting demo review record](../evidence/business-meeting-demo-review.md)
- Real meeting capture video
- Exported decisions/actions/risks
- Reviewer accept/edit/dismiss metrics

Draft-only phrase until evidence exists:

> In our local demo, marked whiteboard events become candidate decisions, action items, risks, and diagrams.

Publish phrase after real evidence:

> In our prototype meeting demo, InkLoop captured the whiteboard session and produced editable decisions, action items, risks, and diagram drafts.

## Hardware Prototype Section

Current message:

InkLoop is being built as a real dry-erase AI whiteboard pen paired with a lightweight Capture Surface. The Capture Surface gives the pen the spatial reference needed for accurate digital capture.

Required proof shots before launch:

- Pen writing real dry-erase ink.
- Pen down/up and coordinate stream visible in Host App.
- Capture Surface mounted on whiteboard.
- Live Board stroke replay.
- Prototype run log and firmware version.
- Known limitations shown plainly.

Do not claim yet:

- Works on any ordinary whiteboard with no setup.
- Perfect capture under all lighting/material conditions.
- Multi-pen or multi-color as the base Kickstarter commitment.

Evidence required:

- [Hardware prototype run log](../evidence/hardware-prototype-run-log.md)
- [Capture Surface calibration report](../evidence/capture-surface-calibration-report.md)
- [Live Board latency report](../evidence/live-board-latency-report.md)

## Software Section

InkLoop software has four roles:

| Surface | Role |
| --- | --- |
| Capture Host | Receives pen events, stores sessions, renders Live Board |
| Live Board | Shows strokes as they happen for students or remote teammates |
| InkLoop Studio | Replays sessions, reviews AI outputs, exports knowledge |
| Obsidian projection | Receives reviewed knowledge objects with backlinks |

Current local evidence:

- Web/Desktop AI Pen demo exists.
- Education and meeting flows exist.
- Obsidian projection preview exists.
- Android/InkLoop Paper runtime reuse builds as a second-loop host.

Boundary:

Obsidian receives reviewed knowledge projection. It is not the capture truth source for arbitrary AI Pen events in V1.

## Rewards

Draft reward structure:

| Tier | Includes | Status |
| --- | --- | --- |
| Supporter | Updates, community access, thank-you credit | Draft |
| Educator Early Bird | 1 AI Pen, A2 Capture Surface, Host App, AI credits | Needs BOM/pricing |
| Educator Kit | 1 AI Pen, A2/A1 Surface option, more AI credits | Needs BOM/pricing |
| Meeting Kit Beta | 2 AI Pens, larger Surface, Team Workspace Beta | Must be framed as beta/future |
| Founder Edition | Numbered kit, founder community, early API/SDK access | Needs fulfillment model |
| Pilot Pack | 5-10 kits for tutors, schools, workshops, or small teams | Needs supplier and support plan |

Pricing cannot be finalized until BOM, assembly, shipping, tax, Kickstarter/Stripe fees, failure buffer, and AI credit cost are modeled.

Evidence required:

- [BOM and supplier tracker](../evidence/bom-supplier-tracker.md)
- Reward pricing spreadsheet
- Supplier quotes

## Timeline

Draft timeline:

| Milestone | Target |
| --- | --- |
| Product scope freeze | July 2026 |
| Prototype and Capture Surface validation | July-August 2026 |
| Education and meeting demo recordings | August-September 2026 |
| Kickstarter page 90% complete | 2026-09-30 |
| Pre-launch page public | Early October 2026 |
| Final page, rewards, risk review | Mid-October 2026 |
| Kickstarter launch | 2026-10-27 to 2026-10-30 |

This timeline must be updated with hardware, supplier, and campaign evidence weekly.

## AI And Privacy

InkLoop uses AI to help organize captured whiteboard sessions into editable lesson notes, reviewable meeting-output candidates, diagrams, decisions, and action item candidates.

The AI does not replace the creator's original teaching or meeting content. It processes the writing and context captured by the user's own session.

For meetings, board/ink events are the required evidence path. Audio, subtitles, speaker, agenda, and timeline data may be optional context, but they are not the main proof path and should not be presented as automatic meeting minutes.

By default, InkLoop aims to upload only the minimum necessary context for AI processing, such as recognized text snippets, structured scene summaries, and source references. Raw whiteboard video is not required because InkLoop captures pen strokes directly.

Users can review, edit, accept, or dismiss AI-generated results. Only accepted or edited results are intended to become long-term KnowledgeObjects. Users should be able to delete sessions and exports.

## Risks And Challenges

Hardware maturity:

We are building a real hardware product, not only a software app. Prototype maturity, firmware stability, battery/charging safety, and manufacturing test fixtures are real risks.

Capture Surface limits:

InkLoop requires our Capture Surface for accurate capture. Surface material, lighting, wipe behavior, mounting, and calibration can affect performance.

AI accuracy:

AI-generated lesson notes, meeting outputs, diagrams, decisions, and action items may be wrong or incomplete. Outputs are designed to be reviewed, edited, accepted, or dismissed by the user.

Supply chain and delivery:

BOM, assembly, testing, packaging, shipping, taxes, certification, and supplier lead times can affect pricing and delivery schedule.

Scope control:

The first version focuses on one AI Pen, Capture Surface, Host App, Live Board, Studio, and exports. Multi-pen, multi-color, and deep third-party integrations are staged after the core product is stable.

## FAQ

See [rewards-faq-draft.md](./rewards-faq-draft.md) for the working FAQ.

## Evidence Checklist Before Publish

| Area | Required Before Publish |
| --- | --- |
| Hardware | Prototype video, run log, firmware version, failure notes |
| Capture Surface | A2/A3 calibration report and material test |
| Live Board | Real BLE or wired P50/P95 render timing report |
| Education | Real lesson video and reviewed lesson output |
| Meeting | Real whiteboard meeting video and reviewed output |
| Supply | BOM, supplier quotes, assembly route, pricing model |
| GTM | Email list, Kickstarter followers, testimonials, first-day likely backers |
| Page safety | All claims checked against [claim-evidence-matrix.md](./claim-evidence-matrix.md) |
