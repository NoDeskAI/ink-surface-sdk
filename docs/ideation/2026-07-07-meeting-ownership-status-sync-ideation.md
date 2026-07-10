---
date: 2026-07-07
topic: meeting-ownership-status-sync
focus: meeting status reconciliation, group ownership, handwritten notes, CloudHub and Obsidian projection
---

# Ideation: Meeting Ownership, Status, and Output Binding

## Codebase Context

This ideation is grounded in the current InkLoop meeting implementation:

- `src/mobile/meeting.ts` already has three meeting-source paths: panel VC events, calendar events, and `/api/feishu/meeting-sources`. The home sync flow runs `syncPanelMeetingsObserved()`, `syncCalendarMeetings()`, Feishu workspaces sync, and then `syncMeetingSources()`.
- `server/lark-meeting-sources.ts` derives status with `statusFor()` and merges sources in `mergeSources()`. The current merge key prefers `calendar_event_id`, then `feishu_meeting_id`, then `meeting_no + date`, so the same recurring meeting can remain split when calendar and VC sources use different IDs.
- Live local probe on `2026-07-07` showed the same "出海创新周会" as two source rows: `user_calendar` says `ended` for `2026-07-07T07:00:00.000Z` to `2026-07-07T08:00:00.000Z`, while `lark_meeting_timeline` says `live` for `2026-07-07T07:01:00.000Z` and has no `ended_at`.
- `syncMeetingSources()` currently skips calendar updates for an existing VC-owned local meeting (`existing.source_kind === 'vc' && source.source !== 'lark_meeting_timeline'`). That protects real VC state from calendar noise, but it also means a stale VC `live` state can remain live after the scheduled calendar end.
- `src/features/meeting/group-claims.ts` documents the current product assumption: Feishu only gives `group_ids` for meetings started in groups, while calendar or personal meetings often lack group. A user claim is stored by meeting number and normalized title in localStorage.
- `renderDetail()` shows `归到群` when the current meeting workspace is not a Feishu workspace. If it is assigned to a Feishu workspace, it displays the workspace name and an "移除" action.
- Meeting handwritten notes are already modeled as a materialized diary-like document `mtgboard_<meeting_id>`, and marks are aggregated by `context_id = mtg_<meeting_id>`.
- `src/integration/inksurface/meeting-export.ts` exports meeting marks and summaries into KnowledgeObjects and document projections. `src/mobile/meeting-recap.ts` exposes an on-demand "导出知识库" flow via `publishEntityToVault({ mode: 'meeting', meetingId })`.

## Ranked Ideas

### 1. Source-Fused Meeting Status State Machine

**Description:** Merge calendar, VC, and chat-derived sources into one canonical meeting row by `meeting_no + occurrence date`, then compute status from all evidence. Rules: real VC `ended` wins; real VC `live` wins only before calendar end plus a configurable grace window; calendar ended can close stale VC live when no VC heartbeat or end event arrives; any conflict is retained as diagnostic metadata.

**Rationale:** Directly fixes the July 7 "calendar says ended, SDK still says live" state. It also prevents recurring meetings from splitting into duplicated cards.

**Downsides:** Needs careful tests around long meetings, delayed VC end events, and meetings that intentionally run over the calendar end time.

**Confidence:** 94%

**Complexity:** Medium

**Status:** Unexplored

### 2. Group Ownership Confidence Model

**Description:** Replace the binary "归到群" fallback with ownership states: `confirmed_auto`, `confirmed_user`, `suggested`, and `unassigned`. Auto-confirm only when Feishu provides `group_ids/chat_id` or a stored recurring claim exists. Suggest when a meeting link or meeting number appears in a bot-visible group message. Require one-tap confirmation for ambiguous matches.

**Rationale:** The system can automatically assign safe cases, but should not leak meeting materials or handwritten notes into the wrong group. This turns "归到群" from a vague action into a clear safety state.

**Downsides:** Requires a small ownership resolver and UI copy changes. Suggestion quality depends on bot-visible group messages.

**Confidence:** 91%

**Complexity:** Medium

**Status:** Unexplored

### 3. Meeting Asset Package as the CloudHub Unit

**Description:** Introduce a CloudHub-facing `MeetingAssetPackage` concept: one package per meeting occurrence containing schedule metadata, canonical status, group ownership, attached materials, handwritten notes, mark events, AI outputs, and export status. The e-paper detail page, Web, and Obsidian all read from this package.

**Rationale:** It answers the product question "will every person's handwritten meeting notes bind to this meeting?" with a concrete unit of record. It also keeps meeting sync separate from reading document sync.

**Downsides:** Needs schema and migration design. If added too broadly, it can become a vague super-object, so V1 must stay limited to status, ownership, materials, marks, and projection status.

**Confidence:** 88%

**Complexity:** Medium

**Status:** Unexplored

### 4. Participant-Laned Handwritten Notes

**Description:** Keep all handwritten marks bound to `meeting_id`, but display and export them by participant lane: current user, device, and optional Feishu participant identity. Raw strokes stay append-only; AI summaries reference the source mark IDs.

**Rationale:** Multiple people can write notes in the same meeting without losing authorship. This supports later collaboration while keeping V1 understandable: "我的手写", "团队手写", and "资料上的标记".

**Downsides:** Requires stable user/device identity in Runtime Sync and careful privacy defaults.

**Confidence:** 86%

**Complexity:** Medium

**Status:** Unexplored

### 5. Meeting-Specific Obsidian Projection

**Description:** Export meetings into a separate Obsidian `Meetings/` projection, not Reading. The note should include meeting metadata, group, materials, personal notes, selected team marks, AI output, and `inkloop://meeting/...` backlinks. Reading notes remain source-file oriented and should not contain `Risk/Decision` sections unless they came from a meeting export.

**Rationale:** This preserves the product distinction between reading and meetings. It also makes Obsidian useful without turning it into the source of truth.

**Downsides:** Requires cleanup of existing mixed demo output and more deterministic export naming.

**Confidence:** 90%

**Complexity:** Low to Medium

**Status:** Unexplored

### 6. Group Materials Gateway

**Description:** Gate "导入群资料" behind a confirmed or suggested ownership state. When unassigned, show "先选择归属群" with the top suggestion if available. After ownership is confirmed, group files become a filtered material source for the current meeting asset package.

**Rationale:** It matches the user's observed flow: group materials are available only after a meeting belongs to a group. It avoids silent failure and explains why the group name matters.

**Downsides:** Slightly more UI state, but much less confusion than a generic "归到群" button.

**Confidence:** 89%

**Complexity:** Low

**Status:** Unexplored

### 7. Status and Ownership Diagnostics for Dev/Test

**Description:** Add a compact debug panel or dev-only detail section showing source rows, merge key, ownership resolver result, and last CloudHub sync/export timestamp.

**Rationale:** Current failures are hard to explain from the UI. A one-screen diagnostic would make future live tests faster without exposing raw implementation details to normal users.

**Downsides:** Not user-facing value by itself. Should stay dev-only or behind a long-press gesture.

**Confidence:** 84%

**Complexity:** Low

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Always trust VC status over calendar status | Rejected because the current July 7 case shows VC can stay stale live without an end event. |
| 2 | Always trust calendar status over VC status | Rejected because real meetings can run over the scheduled end and calendar alone would prematurely close them. |
| 3 | Add a manual "结束会议" button as the main solution | Rejected because it makes users fix a sync bug and conflicts with the current design that meeting status should be source-driven. |
| 4 | Auto-assign every ungrouped meeting to the most recent Feishu group | Rejected because it risks cross-group data leakage. |
| 5 | Auto-assign by title similarity only | Rejected because recurring meetings and similarly named groups make title-only matching unsafe. |
| 6 | Store group claims only in localStorage forever | Rejected because it does not sync across devices and can break CloudHub consistency. |
| 7 | Require users to assign every meeting manually | Rejected because deterministic cases can be automated and recurring meetings should not ask again. |
| 8 | Put all meeting handwritten notes into one shared freeform whiteboard | Rejected because it loses participant authorship and makes later Obsidian output untrustworthy. |
| 9 | Export raw strokes directly as the main Obsidian content | Rejected because Obsidian should receive projections, not become the raw ledger. |
| 10 | Mix meeting actions, risks, and decisions into Reading notes | Rejected because it repeats the current product confusion between reading and meeting scenarios. |
| 11 | Treat meeting materials as ordinary reading library files only | Rejected because meeting materials need meeting context and group provenance. |
| 12 | Hide ownership until the user clicks "添加资料" | Rejected because it makes the flow fail late and does not explain why group materials are unavailable. |
| 13 | Make group ownership permanent and irreversible | Rejected because existing code already supports reversible unclaim, and users need correction for wrong matches. |
| 14 | Export every team member's notes to every participant by default | Rejected because privacy and access rules are not defined. |
| 15 | Use meeting transcript/audio as the primary V1 truth source | Rejected because project docs already define V1 as event marks aligned to the schema layer, not full transcript/audio summarization. |
| 16 | Add another standalone "会议资料库" separate from CloudHub | Rejected because it fragments the source of truth and duplicates CloudHub responsibility. |
| 17 | Show only raw SDK source rows in the product UI | Rejected because it is useful for diagnostics, not for normal user experience. |
| 18 | Delay all meeting output until Obsidian export succeeds | Rejected because meeting capture must remain local-first and export is a projection step. |
| 19 | Treat "归到群" as just a wording issue | Rejected because the underlying ownership model affects materials, permissions, and CloudHub sync. |
| 20 | Build a fully general multi-tenant meeting collaboration suite now | Rejected because it is too broad for V1; the immediate need is status, ownership, handwritten binding, and projection. |

## Recommended Product Decision

Use a conservative automation policy:

1. Auto-bind only when the source has `chat_id/group_ids` or an existing recurring claim.
2. Suggest a group when the meeting number or link is observed in a visible group message.
3. Require one-tap confirmation for ambiguous ownership.
4. Once confirmed, bind the meeting asset package, group materials, handwritten notes, AI outputs, CloudHub sync, and Obsidian projection to the same `meeting_id`.
5. If status sources conflict, keep the meeting usable but display a dev diagnostic and choose the canonical status with the fused state machine.

## Session Log

- 2026-07-07: Initial ideation. Generated 27 candidate ideas across status, ownership, meeting assets, handwritten notes, and Obsidian projection. Kept 7 survivors after rejection filtering.
