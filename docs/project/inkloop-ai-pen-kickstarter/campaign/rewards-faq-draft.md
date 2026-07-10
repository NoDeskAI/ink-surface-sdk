# Rewards, FAQ, AI/Privacy, And Risk Draft

Date: 2026-07-03
Status: First formal draft, pricing not final

## Reward Tier Draft

Pricing is intentionally marked TBD until [BOM and supplier tracker](../evidence/bom-supplier-tracker.md), assembly route, shipping, taxes, Kickstarter/Stripe fees, failure buffer, support cost, and AI credit cost are modeled.

| Tier | Draft Contents | Public Positioning | Pricing Status |
| --- | --- | --- | --- |
| Supporter | Updates, community access, thank-you credit | Follow the build and support the project | TBD |
| Educator Early Bird | 1 AI Pen, A2 Capture Surface, Host App, AI credits | Best first kit for teachers and tutors | Requires BOM |
| Educator Kit | 1 AI Pen, A2/A1 Surface option, more AI credits | Standard education kit | Requires BOM |
| Meeting Kit Beta | 2 AI Pens, larger Capture Surface, Team Workspace Beta | Beta workflow for teams and workshops | Must not overpromise multi-pen |
| Founder Edition | Numbered kit, founder community, early API/SDK access | Limited founder tier | Requires fulfillment plan |
| Pilot Pack | 5-10 kits for education or business pilots | Small teams, tutors, schools, workshops | Requires support and supplier plan |

## Pricing Analyzer

Use the reward pricing analyzer before locking any public price:

```bash
npm --workspace ./examples/ai-annotation-demo run evidence:reward-pricing -- /path/to/bom.csv --out /tmp/reward-pricing-report.json
```

The analyzer converts BOM lines into base unit cost, landed unit cost, minimum pledge price, rounded minimum pledge price, expected net after fees, and expected margin. It also checks BOM completeness, estimate/quote coverage, confirmed quote coverage, and backup supplier coverage.

Only `supplier_backed_for_public_page` should be used to approve public pricing. A passing sample or estimated BOM only proves the pricing model shape.

Current sample fixture is only a model shape, not a real price commitment:

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:reward-pricing-evidence
```

## Pricing Inputs

| Input | Required Before Price Lock |
| --- | --- |
| AI Pen BOM | TBD |
| Capture Surface material cost | TBD |
| Assembly and test cost | TBD |
| Packaging | TBD |
| Shipping and duty buffer | TBD |
| Kickstarter platform fee | Include in model |
| Stripe/payment processing | Include in model |
| Failure and replacement buffer | TBD |
| AI credit cost | TBD |
| Support and pledge manager cost | TBD |

## FAQ

### Does it work on any whiteboard?

InkLoop works with our Capture Surface. You can place the Capture Surface on a regular whiteboard and write with real dry-erase ink. The Capture Surface gives the pen the spatial reference needed for accurate digital capture.

Avoid saying: Works on any whiteboard without setup.

### Is it a camera?

No. InkLoop captures pen strokes directly instead of recording a video of your whiteboard. This is what enables replay, search, source references, and structured notes.

### Does the pen use real ink?

Yes. The goal is to preserve natural whiteboard writing. The prototype direction uses a real dry-erase writing module.

Public claim requires hardware prototype evidence.

### Do I need the cloud?

Live capture and recording should work locally through the Host App. AI-generated notes and meeting outputs may use cloud processing in the first version. We will provide clear privacy controls and explain what data is sent.

### What does AI do?

AI helps organize captured whiteboard sessions into editable lesson notes, diagrams, decisions, risks, and action item candidates. It does not replace the original teaching or meeting content.

### Does it generate automatic meeting minutes from audio?

No. V1 meeting outputs are board-event-first. Decisions, risks, diagrams, and action items must trace back to board/ink evidence. Audio, subtitles, speaker, agenda, and timeline data may be optional context, but they are not the main proof path for a meeting output.

### What happens if AI is wrong?

AI outputs are editable, dismissible, and traceable. The system keeps source references to original strokes and board regions so users can verify the result.

### Will it support multiple pens?

Single-pen capture is the core Kickstarter commitment. Multi-pen and multi-color workflows are planned for Meeting Kit Beta and future versions.

### Can it export to Notion, Jira, Slack, or Miro?

The first version prioritizes Markdown, PDF, PNG, Mermaid, and Obsidian projection. Deep integrations can roll out after the core capture and AI workflow is stable.

### Is Obsidian required?

No. Obsidian is an export/projection path for people who use it. The capture truth source remains InkLoop's session ledger and source references.

### Is e-paper included in the base Kickstarter reward?

No. InkLoop Paper and e-paper review are second-loop runtime reuse and roadmap work. The October 2026 base Kickstarter product is AI Pen + Capture Surface + Host App + Live Board + InkLoop Studio.

## AI And Privacy Copy

InkLoop uses AI to help organize captured whiteboard sessions into editable lesson notes, reviewable meeting-output candidates, diagrams, decisions, and action item candidates.

The AI does not replace the creator's original teaching or meeting content. It processes the writing and context captured by the user's own session.

For meetings, board/ink events are the required evidence path. Audio, subtitles, speaker, agenda, and timeline data may be optional context, but they are not the main proof path and should not be presented as automatic meeting minutes.

By default, InkLoop aims to upload only the minimum necessary context for AI processing, such as recognized text snippets, structured scene summaries, and source references. Raw whiteboard video is not required because InkLoop captures pen strokes directly.

Users can review, edit, accept, or dismiss AI-generated results. Only accepted or edited results are intended to become long-term KnowledgeObjects. Users should be able to delete sessions and exports.

## Risks And Challenges Copy

InkLoop is a hardware and software system. The first version depends on prototype reliability, firmware stability, Capture Surface material behavior, calibration accuracy, assembly and test process, supplier lead times, and certification or battery/charging decisions.

Capture Surface is required for accurate capture. Ink, glare, wipe behavior, lighting, mounting, and calibration can affect performance. We will share calibration and material test results as the prototypes mature.

AI-generated outputs may be incomplete or wrong. InkLoop is designed around reviewable outputs: users can accept, edit, or dismiss candidates before they become long-term knowledge.

The first Kickstarter scope is intentionally narrow: one AI Pen, Capture Surface, Host App, Live Board, Studio, and exports. Multi-pen, multi-color, and deep third-party integrations are planned as staged improvements after the core product is stable.

Manufacturing, shipping, taxes, supplier lead times, testing, and fulfillment can change cost or delivery dates. Reward pricing will be locked only after the BOM, supplier quotes, assembly route, and shipping assumptions are reviewed.
