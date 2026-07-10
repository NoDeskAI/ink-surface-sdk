# Campaign Video Script

Date: 2026-07-03
Status: First formal draft, proof-shot dependent

Target length: 90 seconds

## Video Objective

Show that InkLoop is not a generic AI note app. It is a real whiteboard writing system for education and business meetings:

```text
real dry-erase writing
-> Capture Surface
-> Live Board
-> replay
-> reviewed AI outputs
-> export / Obsidian projection
```

## Required Proof Shots

| Shot | Required Evidence |
| --- | --- |
| AI Pen writes real dry-erase ink | Hardware prototype run log |
| Capture Surface mounted on whiteboard | Capture Surface calibration report |
| Live Board follows strokes | Live Board latency report |
| Teacher lesson becomes reviewed notes | Education demo review record |
| Meeting board becomes decisions/actions/risks | Business meeting demo review record |
| User reviews AI outputs before export | Web/Desktop demo and review UI |
| Obsidian receives projection | Obsidian projection smoke / plugin build |
| Risks and limits are acknowledged | Claim evidence matrix and risk checklist |

## 90-Second Script

| Time | Visual | Voiceover |
| --- | --- | --- |
| 0-8s | Teacher picks up InkLoop AI Pen and starts writing on a whiteboard | Whiteboards are still one of the fastest ways to teach and think. But the content usually disappears into blurry photos and messy follow-up notes. |
| 8-18s | Close shot of pen writing on Capture Surface; Host App receives strokes | InkLoop AI Pen lets you write with real dry-erase ink while the Capture Surface gives the pen the spatial reference it needs for digital capture. |
| 18-28s | Live Board shows strokes on a laptop/tablet viewer | Students and teammates can follow the board live, stroke by stroke, without turning the session into a camera feed. |
| 28-42s | Teacher solves a formula or diagrams a concept | For education, InkLoop records the reasoning process: equations, diagrams, corrections, and the sequence behind the lesson. |
| 42-56s | InkLoop Studio replay, then generated lesson notes with source refs | After class, Studio can organize the session into editable lesson notes with source references back to the original board work. |
| 56-68s | Business meeting whiteboard: architecture diagram, risk, next step | For meetings, teams can keep the speed of a physical whiteboard while marking decisions, risks, diagrams, and action items. |
| 68-78s | Reviewed meeting outputs; user accepts/edits/dismisses candidates | AI results are not treated as final truth. You review, edit, accept, or dismiss them before they become long-term knowledge. |
| 78-86s | Export to Markdown, PDF, PNG, Mermaid, Obsidian projection | Export the work into the formats your team already uses, including Markdown and Obsidian projection. |
| 86-90s | Product kit shot and Kickstarter title | InkLoop AI Pen: turn real whiteboard writing into live notes, diagrams, and action items. |

## Education Demo Insert

Use one of these:

- Completing the square
- Physics force diagram
- Chemistry equation balancing
- Programming architecture sketch

Proof required:

- Real 5-8 minute session recording.
- Live Board visible during capture.
- Exported lesson notes.
- Reviewer actions logged.

## Business Demo Insert

Use one of these:

- API gateway to services to database architecture.
- Product launch workflow.
- User journey map.
- Sprint planning board.

Proof required:

- Real 5-8 minute session recording.
- Marked decisions, risks, and actions on the board.
- Exported meeting outputs.
- Reviewer actions logged.

## Lines To Avoid

- Works on any whiteboard.
- Perfect AI transcription.
- Fully autonomous meeting assistant.
- Zero latency.
- Replaces tablets, cameras, and every meeting tool.
- Multi-pen is included in the base product.

## Final Cut Checklist

| Check | Evidence record | Current status | Publish rule |
| --- | --- | --- | --- |
| Shows Capture Surface requirement clearly | [Capture Surface calibration report](../evidence/capture-surface-calibration-report.md) | Waiting for real proof shot and calibration evidence | Final cut must show the Surface before any accuracy or whiteboard-capture claim. |
| Shows real pen writing, not only UI mock | [Hardware prototype run log](../evidence/hardware-prototype-run-log.md) | Waiting for real prototype take and raw run log | Final cut must show real dry-erase writing and a real AI Pen/prototype path, not only UI animation. |
| Shows Live Board timing without speed-up deception | [Live Board latency report](../evidence/live-board-latency-report.md) | Waiting for real-time take and latency report | Final cut must either use real-time footage or label any edited timing clearly. |
| Shows user review step for AI output | [Education demo review](../evidence/education-demo-review.md) and [business meeting demo review](../evidence/business-meeting-demo-review.md) | Waiting for reviewed education and meeting takes | Final cut must show accept/edit/dismiss before any output is exported or projected. |
| Mentions risks/limits in page or video | [Kickstarter page risk checklist](../evidence/kickstarter-page-risk-checklist.md) | Waiting for page checklist and legal/privacy review | Final cut or page copy must disclose prototype status, Capture Surface requirement, AI limitations, and delivery risk. |
| Avoids unsupported claims | [Claim evidence matrix](./claim-evidence-matrix.md) | Guardrail active; final transcript still requires review | Final cut must pass `npm run verify:kickstarter-claims` and the proof-shot claim review before publication. |
