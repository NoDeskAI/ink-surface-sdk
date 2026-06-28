---
title: Stabilize Obsidian Ink Rendering and Vault Opening
date: 2026-06-28
category: integration-issues
module: Obsidian Runtime Host
problem_type: integration_issue
component: tooling
symptoms:
  - Obsidian reported "Vault not found" for obsidian://open links that used absolute paths.
  - Saved pencil and highlighter strokes changed color after pointer-up.
  - The Obsidian preview flashed after local handwriting edits.
  - Web and Obsidian rendering could diverge for the same sidecar stroke data.
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [obsidian, ink-rendering, svg, sidecar-sync, vault-uri]
---

# Stabilize Obsidian Ink Rendering and Vault Opening

## Problem

The Obsidian Runtime MVP exposed three user-visible failures in the Web/Obsidian integration: test vault links could open with a `Vault not found` dialog, saved ink strokes could lose their selected color, and local Obsidian drawing could flash after a stroke was committed.

This mattered because the product depends on Obsidian and Web rendering the same `.inkloop` sidecar state. If the host can open the wrong vault, repaint the whole preview on every local mutation, or render sidecar SVG attributes differently from Web, validation becomes noisy and user trust drops.

## Symptoms

- macOS Obsidian showed `Vault not found. Unable to find a vault for the URL obsidian://open?path=...`.
- Pencil color looked correct while drawing, then became black after the stroke was saved and re-rendered.
- Obsidian flashed after local handwriting stopped because the plugin refreshed the preview immediately after writing the sidecar.
- The SDK renderer and Obsidian plugin fallback renderer did not apply the same SVG style precedence for persisted freehand strokes.

## What Didn't Work

- Treating the vault error as a missing folder was misleading. The folder existed; the problem was that `obsidian://open?path=<absolute-file>` asks Obsidian to resolve that file against registered vaults, which is brittle when multiple stale or same-named vaults exist.
- Refreshing the whole preview after every local sidecar mutation made sync feel current, but it caused visible flashing and replaced the live SVG path immediately after pointer-up.
- Setting only SVG attributes such as `stroke="#ff6b81"` was not enough. Existing CSS rules like `.inkloop-mark-freehand { stroke: var(--inkloop-ink); }` can override presentation attributes. Saved strokes therefore needed inline styles, not only attributes.
- Session history search was partially useful but not authoritative: the local `session-historian` extraction scripts were unavailable, so only bounded keyword search was used. Current code and commit evidence remained the primary source.

## Solution

Prefer vault-relative Obsidian URIs when both a vault name and file path are available. Keep absolute `path` only as a last-resort fallback:

```ts
const params = new URLSearchParams();
if (input.vault) params.set('vault', input.vault);
if (input.file) params.set('file', input.headingOrBlock ? `${input.file}#${input.headingOrBlock}` : input.file);
if (!input.vault && !input.file && input.absolutePath) params.set('path', input.absolutePath);
return `obsidian://open?${params.toString()}`;
```

Preserve stroke color and opacity as inline SVG styles in the shared Web renderer:

```ts
for (const [key, value] of Object.entries(attrs)) {
  path.setAttribute(key, String(value));
  if (key === 'stroke' || key === 'stroke-opacity' || key === 'stroke-width' || key === 'fill') {
    path.style.setProperty(key, String(value));
  }
}
```

Apply the same rule in the Obsidian fallback renderer and the runtime canvas path renderer:

```js
if (node.payload?.color) {
  path.setAttribute("stroke", node.payload.color);
  path.style.setProperty("stroke", node.payload.color);
}
if (node.payload?.opacity !== undefined) {
  path.setAttribute("stroke-opacity", String(node.payload.opacity));
  path.style.setProperty("stroke-opacity", String(node.payload.opacity));
}
```

For live Obsidian drawing, set inline styles when the temporary path is created:

```js
path.setAttribute("stroke", this.inkColor(tool));
path.style.setProperty("stroke", this.inkColor(tool));
path.setAttribute("stroke-opacity", String(this.inkOpacity(tool)));
path.style.setProperty("stroke-opacity", String(this.inkOpacity(tool)));
```

Avoid refreshing the current preview after local sidecar writes. Update the preview signature instead, so the plugin knows the open preview already reflects the mutation and does not immediately re-render:

```js
this.scheduleSync("inkloop_handwriting_add");
void this.rememberDocPreviewSignature(docId, { ...runtime, blocks });
```

Add a focused regression test that asserts persisted freehand strokes retain both SVG attributes and inline styles:

```ts
expect(path.getAttribute('stroke')).toBe('#ff6b81');
expect(path.style.getPropertyValue('stroke')).toBe('#ff6b81');
expect(path.getAttribute('stroke-opacity')).toBe('0.8');
expect(path.style.getPropertyValue('stroke-opacity')).toBe('0.8');
```

## Why This Works

The fixes align the integration boundaries with each host's actual behavior:

- Obsidian URI opening is vault-centric. `vault + file` uses Obsidian's native vault resolution path; `path` is fragile because it relies on Obsidian mapping an absolute file back to a registered vault.
- SVG presentation attributes have lower precedence than authored CSS. Inline styles win over the plugin/theme stylesheet, so saved sidecar colors survive both light/dark themes and `.is-highlighter` CSS defaults.
- Local sidecar writes already mutate the current in-memory surface. Refreshing the preview right after that mutation destroys the live interaction state and causes flicker. Recording the new signature preserves sync bookkeeping without repainting the visible surface.
- Keeping the shared SDK renderer and plugin fallback renderer behavior identical prevents Web/Obsidian parity drift.

## Prevention

- When opening Obsidian from code, prefer `obsidian://open?vault=<vault>&file=<vault-relative-file>` or `open -a Obsidian <vault-folder>` for local automation. Do not use `obsidian://open?path=<absolute-file>` unless no vault/file identity is available.
- Any persisted SVG visual property that must override theme or plugin CSS should be written as both an attribute and an inline style.
- Treat local host mutations differently from remote sync mutations. Local writes should update signatures and schedule sync; remote or external writes may refresh open previews.
- Add renderer parity tests at the shared SDK layer whenever plugin fallback rendering duplicates SDK behavior.
- After rebuilding the SDK, reinstall the Obsidian plugin into the active validation vault before manual verification:

```bash
npm run build
npm run obsidian:install-plugin -- --vault examples/ai-annotation-demo/.inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
```

Verification commands used for this fix:

```bash
npm run check
npm run lint:ci
npm test
npm run build
```

## Related Issues

- Commit: `173ed98 fix: stabilize Obsidian ink rendering`
- Related code:
  - `examples/ai-annotation-demo/src/adapters/obsidian-fs/obsidian-uri.ts`
  - `packages/surface-web/src/index.ts`
  - `packages/surface-web/src/index.test.ts`
  - `plugins/obsidian/inkloop-sync/main.js`
- Existing `docs/solutions/` overlap: none found. This was the first solution document in the repository.
