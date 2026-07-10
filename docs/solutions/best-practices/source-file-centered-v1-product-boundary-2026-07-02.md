---
title: Use Source Files as the InkLoop v1 Product Boundary
date: 2026-07-02
category: best-practices
module: InkLoop v1 Product Architecture
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Defining InkLoop v1 product scope across Web, e-ink device, Obsidian, Cloud Hub, and meeting or classroom workflows.
  - Deciding whether a feature belongs to source-file import, reading marks, knowledge projection, controlled writeback, or runtime sync.
  - Preventing the product from drifting into a generic cloud drive, full Obsidian clone, or AI chat workspace.
tags: [source-file, product-boundary, local-first, obsidian, cloud-hub, meeting-events, eink, sync]
---

# Use Source Files as the InkLoop v1 Product Boundary

## Context

InkLoop v1 needed a sharper product boundary after the project direction expanded across Web import, e-ink reading, Obsidian output, Cloud Hub sync, local Wi-Fi transfer, and meeting or classroom use cases. The risk was not missing features. The risk was building a generic cloud drive, a full Obsidian clone, or an AI chat workspace that happens to have an e-ink screen.

The useful v1 framing is source-file centered:

```text
Source file
-> Web import or e-ink LAN import
-> E-ink reading and thinking marks
-> Meeting or classroom event marks
-> Cloud Hub sync and indexing
-> Obsidian Reading Note / Highlight / Task / Decision / Risk
-> inkloop:// source link back to the original context
```

The implemented project document is:

- `docs/project/inkloop-eink/01_技术方案/10_产品与PRD_6月方案/InkLoop_v1_产品化定位与三端体验.md`

## Guidance

Use this product definition:

> Web handles input. The e-ink device handles reading and thinking marks. Obsidian handles lightweight knowledge output and controlled edits. Cloud Hub handles sync, indexing, and device state.

Keep four product roles distinct:

| Surface | Primary job | P0 behaviors | Explicit non-goal |
| --- | --- | --- | --- |
| Web | Import, organize, search, and batch-manage source files | Drag in PDF/EPUB/Markdown/web pages, manage Library, preview source files, inspect sync state | Immersive reading |
| E-ink device | Read, think, mark, and capture meeting/classroom events | Open documents, read offline, underline/circle/write/star, mark meeting events, LAN import | Complex cloud-drive management |
| Obsidian | Long-term knowledge output and lightweight editing | Reading Note, Highlight, Task, Decision, Risk, Meeting Note, source links, controlled status writeback | Full runtime database or arbitrary annotation editor |
| Cloud Hub | Coordinate sync and identity | Document identity, object storage, event log, index, device manifest, conflict state | User-facing knowledge-base replacement |

Treat the source file as the product unit. A source file can be a PDF, EPUB, Markdown file, web clip, image, or meeting material. Everything else hangs from that identity:

```ts
interface SourceFile {
  doc_id: string;
  title: string;
  mime_type: 'pdf' | 'epub' | 'markdown' | 'html' | 'image' | 'meeting_material';
  content_hash: string;
  revision: string;
  source:
    | 'web_upload'
    | 'eink_lan_drop'
    | 'obsidian_import'
    | 'meeting_attachment'
    | 'web_clip';
  cloud_state: 'local_only' | 'uploading' | 'synced' | 'conflict' | 'failed';
  local_availability: 'not_downloaded' | 'downloaded' | 'pinned';
  created_by_device_id: string;
  created_at: string;
  updated_at: string;
}
```

Do not use file transfer as the product boundary. E-ink LAN transfer is an import path, not a separate document universe:

```text
E-ink opens "Wi-Fi transfer"
-> user uploads file to http://inkloop.local:8731
-> file enters local Library immediately
-> device can read offline
-> Cloud Hub upload runs in the background
-> the same doc_id becomes visible to Web and Obsidian projection
```

Keep Obsidian lightweight through controlled projection:

| Obsidian action | v1 behavior |
| --- | --- |
| Edit free-note area | Keep it user-owned; InkLoop does not parse or overwrite it |
| Check a task | Write back task status |
| Change risk status or add structured comment | Write back controlled fields |
| Add tags or comments to a highlight | Write back structured metadata |
| Draw inside an arbitrary Obsidian PDF plugin | Do not parse it into primary InkLoop marks in v1 |
| Rewrite arbitrary Markdown paragraphs | Do not guess whether they are new Highlights, Decisions, or Risks |

Meeting and classroom workflows are v1, but their primary input is event marks, not full media ingestion:

```text
MeetingSession
-> question/risk/action/decision/note marks
-> MeetingEventMark on the timeline
-> schema alignment with the current source file, slide, project, or memory
-> Meeting Note / Task / Decision / Risk / KnowledgeObject
```

Full audio, transcript, speaker diarization, and automatic minutes can become later supplementary evidence. They should not be required for the v1 meeting loop because they increase permission, privacy, latency, and accuracy risk before the user has even made a useful mark.

## Why This Matters

The source-file boundary keeps the product simple without making it shallow.

It preserves the reading experience because the e-ink device only needs to show a Library, source-file preview, reading state, and a small mark set. It preserves Obsidian because Obsidian receives useful notes and controlled objects without becoming the runtime store for page coordinates, strokes, OCR state, sync cursors, and device conflicts. It preserves Cloud Hub because the cloud coordinates identity and sync rather than becoming another full knowledge workspace.

This boundary also gives implementation teams a decision rule. If a feature does not improve source-file import, reading marks, meeting/classroom event marks, sync reliability, Obsidian projection, controlled writeback, or source-context return, it probably does not belong in v1.

## When to Apply

- A new feature proposal touches Web, e-ink, Obsidian, sync, or meetings.
- A feature seems useful but may turn InkLoop into a generic file manager or cloud drive.
- A contributor wants Obsidian to become a full annotation runtime.
- A meeting feature depends on recording, transcript, speaker, or minutes permissions before event marks work.
- A source file can enter through multiple paths and must not duplicate across Web upload, e-ink LAN drop, Obsidian import, or meeting attachment.

## Examples

### Keep

These are v1-shaped:

| Feature | Reason |
| --- | --- |
| Web drag-and-drop import | Fastest desktop input path |
| E-ink LAN import | Lets the device receive files without cables or cloud availability |
| Source-file Library | Gives users a simple unit: "the document I am reading" |
| Underline/circle/handwritten note/star | Keeps thinking marks close to reading |
| Meeting event mark | Captures business and classroom intent without full transcript dependency |
| Obsidian Reading Note | Lets users keep long-term knowledge in their own vault |
| Controlled task/risk/status writeback | Useful editing without arbitrary Markdown interpretation |
| `inkloop://doc/...` source links | Lets knowledge objects return to the original page and mark |

### Cut or Defer

These are not v1-shaped:

| Feature | Why defer |
| --- | --- |
| General cloud drive folders | Dilutes the reading and marking loop |
| Multi-cloud bidirectional file sync | Too much conflict and permission surface for v1 |
| Obsidian arbitrary PDF mark import | Plugin formats and coordinate systems are not stable enough |
| Arbitrary Markdown-to-KnowledgeObject parser | Too likely to misread user notes |
| Full meeting audio/transcript as required input | Heavy privacy, permission, latency, and quality cost |
| AI chat as the main surface | Breaks the "mark is the intent" product principle |

### Use This Scope Checklist

Before accepting a v1 feature, answer:

1. Which source file or meeting/classroom session does this attach to?
2. Does it improve import, reading, marking, sync, projection, controlled edit, or source return?
3. Is the user still able to read and mark offline?
4. Does Obsidian remain a lightweight knowledge surface rather than a runtime store?
5. Does Cloud Hub remain a coordinator rather than a user-facing knowledge-base replacement?
6. Can the feature be explained without exposing bbox, sidecar, cursor, queue, or conflict internals to the user?

## Related

- [InkLoop v1 product positioning and three-surface experience](../../project/inkloop-eink/01_技术方案/10_产品与PRD_6月方案/InkLoop_v1_产品化定位与三端体验.md)
- [Technical scheme overview](../../project/inkloop-eink/01_技术方案/00_入口与决策_6月方案/技术方案总览.md)
- [Meeting event schema contract](../../project/inkloop-eink/01_技术方案/30_数据契约与外部投影_7月/InkLoop_Meeting_Event_Schema_Contract_v0.1.md)
- [Runtime sync as the canonical Obsidian path](../integration-issues/runtime-sync-canonical-path-2026-07-02.md)
- [Project docs boundary and Feishu projection](../documentation-gaps/project-docs-boundary-and-feishu-projection-2026-07-02.md)
