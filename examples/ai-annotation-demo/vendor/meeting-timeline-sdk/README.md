# Meeting Timeline SDK vendor subset

- Source: https://github.com/xzq-xu/Lark-Meeting-Timeline
- Branch: `codex/meeting-timeline-sdk`
- Commit: `475cd6c`
- Copied: `2026-07-14`

This directory contains only the meeting platform adapters needed by the InkLoop
host. Files remain ESM (`.mjs`) with adjacent declarations (`.d.ts`). The small
`time.mjs` and `adapters/transcript-payload.mjs` files are attributed extracts
from the package entrypoint; the full `index.mjs` is intentionally not vendored.

## Local patches (must reapply when updating)

- `adapters/platform-timeline-view.mjs`: upstream imports `compactObject` and
  `normalizeAbsoluteMs` from `../index.mjs`; this vendor subset rewires the
  import to `./internal-utils.mjs` and `../time.mjs`. Added 2026-07-14 together
  with `adapters/platform-setup.mjs` (its only sibling dependency) to replace
  the inert 909-byte stub under `Lark-Meeting-Timeline-main/` — the stub
  rendered the recap SDK timeline empty on every build from this tree, and
  `src/integration/lark-meeting-timeline/epaper-timeline.ts` now imports the
  real implementation from this directory instead.

## Updating

1. Check out the source branch and verify the intended commit.
2. Copy the listed adapter `.mjs`/`.d.ts` pairs and `adapters/internal-utils.*`.
3. Reapply the local import-only rewrites from `../index.mjs` to
   `./internal-utils.mjs` and `./transcript-payload.mjs`, plus the self-contained
   declaration types in `core.d.ts` and `transcript.d.ts`.
4. Refresh the attributed entrypoint extracts when their upstream functions
   change.
5. Run the vendor unit test and the Node ESM import smoke check before commit.
