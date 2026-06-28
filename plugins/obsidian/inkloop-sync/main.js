const { ItemView, Notice, Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const INKLOOP_VIEW_TYPE = "inkloop-runtime-view";

const DEFAULT_SETTINGS = {
  baseDir: ".inkloop",
  documentsDir: "InkLoop",
  syncEndpoint: "http://127.0.0.1:8765/api/obsidian-lab/pull",
  autoSyncOnChange: true,
  debounceMs: 750,
  notifyManualSync: true,
  visualEnhancement: true,
  previewEditing: false,
  surfaceMode: "thinking",
  inkTool: "pen",
  inkColors: {
    pen: "#38bdf8",
    highlighter: "#facc15",
  },
};

const DEFAULT_INK_OPACITY = {
  pen: 0.92,
  highlighter: 0.56,
};

const INK_SWATCHES = ["#38bdf8", "#f8fafc", "#111827", "#facc15", "#fb7185", "#34d399"];

function nowIso() {
  return new Date().toISOString();
}

function cleanDir(input, fallback) {
  const value = String(input || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = value.split("/").filter(Boolean);
  if (!parts.length) return fallback;
  if (parts.some((part) => part === "." || part === "..")) return fallback;
  return parts.join("/");
}

function normalizeText(input) {
  return String(input || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Tagged(input) {
  const bytes = new TextEncoder().encode(String(input || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function docIdFromHash(hash) {
  return `doc_${String(hash || "").replace(/^sha256:/, "").slice(0, 16)}`;
}

function sourceRefId(docId) {
  return `src_${String(docId).replace(/^doc_/, "")}`;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function localId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function markdownChunks(markdown) {
  const chunks = [];
  let current = [];
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) chunks.push(value);
    current = [];
  };
  for (const line of String(markdown || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line) && current.length) flush();
    current.push(line);
  }
  flush();
  return chunks;
}

function titleFromMarkdown(markdown, fallback) {
  const heading = String(markdown || "").match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallback || "Untitled";
}

function markdownKind(chunk) {
  if (/^#{1,6}\s+/.test(chunk)) return "heading";
  if (/^>\s+/m.test(chunk)) return "quote";
  if (/^\s*[-*]\s+/m.test(chunk)) return "list";
  if (/^\|.+\|/m.test(chunk)) return "table";
  return "paragraph";
}

function markdownHeadingLevel(chunk) {
  return Math.min(6, Math.max(1, chunk.match(/^#{1,6}/)?.[0]?.length ?? 2));
}

function markdownForEditableBlock(block, visibleText) {
  const text = String(visibleText || "").replace(/\u00a0/g, " ").trimEnd();
  if (block.kind === "heading" || String(block.content || "").startsWith("#")) {
    const level = Math.min(6, Math.max(1, String(block.content || "").match(/^#{1,6}/)?.[0]?.length ?? 1));
    return `${"#".repeat(level)} ${text.replace(/^#{1,6}\s+/, "").trim()}`;
  }
  return text;
}

function bboxOfPoints(points) {
  if (!points.length) return [0, 0, 0, 0];
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

function previewText(annotation) {
  return normalizeText(annotation.body_md || annotation.title).slice(0, 180);
}

function isStrokeOnlyAnnotation(annotation) {
  return annotation.render_mode === "stroke_only"
    || (annotation.visual_strokes?.some((stroke) => stroke.points.length > 1) === true && !normalizeText(annotation.body_md));
}

function normalizeInkTool(tool) {
  return tool === "text" || tool === "highlighter" ? tool : "pen";
}

function isStrokeTool(tool) {
  return tool === "pen" || tool === "highlighter";
}

function normalizeHexColor(input, fallback) {
  const value = String(input || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function createSvgElement(name) {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}

function addSvgPath(svg, cls, d, attrs = {}) {
  const path = createSvgElement("path");
  path.setAttribute("class", cls);
  path.setAttribute("d", d);
  for (const [key, value] of Object.entries(attrs)) path.setAttribute(key, String(value));
  svg.appendChild(path);
}

function addSvgRect(svg, cls, attrs) {
  const rect = createSvgElement("rect");
  rect.setAttribute("class", cls);
  for (const [key, value] of Object.entries(attrs)) rect.setAttribute(key, String(value));
  svg.appendChild(rect);
}

function strokePath(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${(point.x * 100).toFixed(2)},${(point.y * 100).toFixed(2)}`)
    .join(" ");
}

function renderMarkLayer(block) {
  if (!block.annotations.length) return null;
  const svg = createSvgElement("svg");
  svg.setAttribute("class", "inkloop-mark-layer");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  const drawnAnnotations = block.annotations.filter((annotation) => annotation.visual_strokes?.some((stroke) => stroke.points.length > 1));
  for (const annotation of drawnAnnotations) {
    for (const stroke of annotation.visual_strokes || []) {
      if (stroke.points.length <= 1) continue;
      const attrs = {};
      if (stroke.color) attrs.stroke = stroke.color;
      if (stroke.opacity !== undefined) attrs["stroke-opacity"] = Math.min(1, Math.max(0.05, Number(stroke.opacity) || 1));
      addSvgPath(svg, `inkloop-mark-freehand is-${stroke.tool || "pen"}`, strokePath(stroke.points), attrs);
    }
  }

  const kinds = new Set(block.annotations.filter((annotation) => !drawnAnnotations.includes(annotation)).map((annotation) => annotation.kind));
  if (kinds.has("excerpt")) addSvgRect(svg, "inkloop-mark-highlight", { x: 1, y: 13, width: 98, height: 70, rx: 5, ry: 5 });
  if (kinds.has("annotation")) {
    addSvgPath(svg, "inkloop-mark-box", "M3,13 C15,8 83,8 96,14 C99,31 98,71 95,86 C76,95 23,94 5,86 C1,67 1,33 3,13");
  }
  if (kinds.has("qa")) {
    addSvgPath(svg, "inkloop-mark-circle", "M10,19 C31,3 76,6 91,23 C106,40 94,79 72,90 C45,104 9,91 4,62 C1,43 2,28 10,19");
    addSvgPath(svg, "inkloop-mark-underline", "M12,84 C31,78 53,86 88,80");
  }
  if (kinds.has("task")) {
    addSvgPath(svg, "inkloop-mark-task", "M7,20 C19,17 22,28 29,30 C39,34 45,15 57,18 C70,20 69,39 82,38 C88,38 92,35 96,31");
    addSvgPath(svg, "inkloop-mark-underline", "M11,88 C33,83 58,88 90,84");
  }
  if (kinds.has("ai_note")) addSvgPath(svg, "inkloop-mark-rail", "M0,7 C3,28 3,68 0,94");
  if (!svg.childNodes.length) addSvgRect(svg, "inkloop-mark-highlight", { x: 2, y: 16, width: 96, height: 66, rx: 5, ry: 5 });
  return svg;
}

function renderMarginNotes(block) {
  const visibleAnnotations = block.annotations.filter((annotation) => !isStrokeOnlyAnnotation(annotation));
  if (!visibleAnnotations.length) return null;
  const notes = document.createElement("aside");
  notes.className = "inkloop-margin-notes";
  for (const annotation of visibleAnnotations) {
    const note = document.createElement("div");
    note.className = `inkloop-margin-note is-${annotation.kind}`;
    note.dataset.koId = annotation.ko_id;
    note.dataset.annotationKind = annotation.kind;
    const label = document.createElement("div");
    label.className = "inkloop-margin-note-kind";
    label.textContent = annotation.kind.replace(/_/g, " ");
    const title = document.createElement("div");
    title.className = "inkloop-margin-note-title";
    title.textContent = annotation.title;
    note.appendChild(label);
    note.appendChild(title);
    const body = previewText(annotation);
    if (body && body !== annotation.title) {
      const excerpt = document.createElement("div");
      excerpt.className = "inkloop-margin-note-body";
      excerpt.textContent = body;
      note.appendChild(excerpt);
    }
    notes.appendChild(note);
  }
  return notes;
}

function parseAttrs(input) {
  const attrs = {};
  for (const match of input.matchAll(/([A-Za-z0-9_-]+)=([^\s>]+)/g)) attrs[match[1]] = match[2];
  return attrs;
}

function parseAnnotationComments(markdown) {
  const annotations = [];
  for (const match of markdown.matchAll(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g)) {
    try {
      annotations.push(JSON.parse(decodeURIComponent(match[1].trim())));
    } catch {
      // Ignore malformed visual metadata; the Markdown fallback remains readable.
    }
  }
  return annotations;
}

function parseInkLoopVisualModel(markdown) {
  if (!markdown.includes("inkloop_projection_id")) return null;
  const titleMatch = markdown.replace(/^---[\s\S]*?---\s*/m, "").match(/^#\s+(.+)$/m);
  const blocks = [];
  const blockRegex = /<!--\s*inkloop:block-begin\s+([^>]*)-->\s*\n([\s\S]*?)\n<!--\s*inkloop:block-end\s+id=([^>]+?)\s*-->/g;
  const matches = [...markdown.matchAll(blockRegex)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const attrs = parseAttrs(match[1]);
    const blockId = attrs.id || match[3];
    const tailStart = match.index + match[0].length;
    const tailEnd = matches[index + 1]?.index ?? markdown.indexOf("<!-- inkloop:document-end", tailStart);
    const tail = markdown.slice(tailStart, tailEnd === -1 ? undefined : tailEnd);
    blocks.push({
      id: blockId,
      kind: attrs.kind || "paragraph",
      region: attrs.region || "editable",
      page: attrs.page,
      bbox: attrs.bbox,
      content: match[2].trim(),
      annotations: parseAnnotationComments(tail),
    });
  }

  return { documentTitle: titleMatch?.[1]?.trim() || "InkLoop document", blocks };
}

function legacyInkLoopIdentity(markdown) {
  const docId = markdown.match(/inkloop_document_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const projectionId = markdown.match(/inkloop_projection_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  const revisionId = markdown.match(/inkloop_revision_id:\s*"?([^"\n]+)"?/m)?.[1]?.trim();
  return { docId, projectionId, revisionId };
}

function renderVisualBlockContent(block) {
  if (block.kind === "heading" || String(block.content || "").startsWith("#")) {
    const level = Math.min(6, Math.max(1, String(block.content || "").match(/^#{1,6}/)?.[0]?.length ?? 1));
    const heading = document.createElement(`h${level}`);
    heading.textContent = String(block.content || "").replace(/^#{1,6}\s+/, "").trim();
    return heading;
  }
  const paragraph = document.createElement("p");
  const lines = String(block.content || "").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) paragraph.appendChild(document.createElement("br"));
    paragraph.appendChild(document.createTextNode(line));
  }
  return paragraph;
}

function renderInkLoopVisualBlock(block) {
  const wrapper = document.createElement("section");
  const hasVisibleAnnotations = block.annotations.some((annotation) => !isStrokeOnlyAnnotation(annotation));
  wrapper.className = `inkloop-visual-block${hasVisibleAnnotations ? "" : " is-plain"}${isPreviewEditable(block) ? " is-preview-editable" : ""}`;
  wrapper.dataset.blockId = block.id;
  wrapper.dataset.annotationKinds = block.annotations.map((annotation) => annotation.kind).join(" ");
  const contentPlane = document.createElement("div");
  contentPlane.className = "inkloop-content-plane";
  contentPlane.appendChild(renderVisualBlockContent(block));
  const markLayer = renderMarkLayer(block);
  const notes = renderMarginNotes(block);
  if (markLayer) contentPlane.appendChild(markLayer);
  wrapper.appendChild(contentPlane);
  if (notes) wrapper.appendChild(notes);
  return wrapper;
}

function renderInkLoopVisualModel(model) {
  const root = document.createElement("article");
  root.className = "inkloop-surface-root inkloop-native-preview inkloop-native-preview-root";
  const firstHeading = model.blocks.find((block) => block.kind === "heading" || String(block.content || "").startsWith("#"));
  if (normalizeText(firstHeading?.content) !== normalizeText(model.documentTitle)) {
    const title = document.createElement("h1");
    title.textContent = model.documentTitle;
    root.appendChild(title);
  }
  let lastPage;
  for (const block of model.blocks) {
    if (block.page !== undefined && block.page !== lastPage) {
      const pageHeading = document.createElement("h2");
      pageHeading.textContent = `Page ${Number(block.page) + 1}`;
      root.appendChild(pageHeading);
      lastPage = block.page;
    }
    root.appendChild(renderInkLoopVisualBlock(block));
  }
  return root;
}

function cleanMarkdownFromVisualModel(model) {
  const lines = [];
  const pushBlock = (content) => {
    const value = String(content || "").trim();
    if (!value) return;
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(...value.split("\n"));
  };
  const firstHeading = model.blocks.find((block) => block.kind === "heading" || String(block.content || "").startsWith("#"));
  if (normalizeText(firstHeading?.content) !== normalizeText(model.documentTitle)) pushBlock(`# ${model.documentTitle}`);
  for (const block of model.blocks) pushBlock(block.content);
  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function encodeAnnotationComment(annotation) {
  return `<!-- inkloop:annotation-json ${encodeURIComponent(JSON.stringify(annotation))} -->`;
}

function refreshAnnotationFallbackSections(markdown) {
  return markdown.replace(
    /(<!--\s*inkloop:annotations-begin\s+[^>]*-->\s*\n<div class="inkloop-annotation-fallback"[^>]*>\s*\n)([\s\S]*?)(\n<\/div>\s*\n<!--\s*inkloop:annotations-end\s+[^>]*-->)/g,
    (full, prefix, body, suffix) => {
      const comments = [...body.matchAll(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g)];
      const annotations = [];
      const commentLines = [];
      for (const match of comments) {
        try {
          const annotation = JSON.parse(decodeURIComponent(match[1].trim()));
          annotations.push(annotation);
          commentLines.push(encodeAnnotationComment(annotation));
        } catch {
          commentLines.push(match[0]);
        }
      }
      if (!commentLines.length) return full;
      const titles = annotations
        .filter((annotation) => !isStrokeOnlyAnnotation(annotation))
        .map((annotation) => `<li>${escapeHtml(annotation.title)}</li>`)
        .join("\n");
      return `${prefix}${commentLines.join("\n")}\n<strong>InkLoop annotations</strong>\n<ul>\n${titles}\n</ul>${suffix}`;
    },
  );
}

function replaceInkLoopBlockContent(markdown, blockId, nextContent) {
  const begin = `<!--\\s*inkloop:block-begin\\s+[^>]*\\bid=${escapeRegExp(blockId)}\\b[^>]*-->`;
  const end = `<!--\\s*inkloop:block-end\\s+id=${escapeRegExp(blockId)}\\s*-->`;
  const pattern = new RegExp(`(${begin}\\s*\\n)([\\s\\S]*?)(\\n${end})`);
  if (!pattern.test(markdown)) throw new Error(`InkLoop block was not found: ${blockId}`);
  return markdown.replace(pattern, (_full, prefix, _oldBody, suffix) => `${prefix}${String(nextContent || "").trimEnd()}${suffix}`);
}

function updateInkLoopAnnotation(markdown, koId, patch) {
  let didUpdate = false;
  const nextMarkdown = markdown.replace(/<!--\s*inkloop:annotation-json\s+([^>]*)-->/g, (full, encoded) => {
    try {
      const annotation = JSON.parse(decodeURIComponent(encoded.trim()));
      if (annotation.ko_id !== koId) return full;
      const cleanPatch = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== undefined));
      didUpdate = true;
      return encodeAnnotationComment({ ...annotation, ...cleanPatch });
    } catch {
      return full;
    }
  });
  if (!didUpdate) throw new Error(`InkLoop annotation was not found: ${koId}`);
  return refreshAnnotationFallbackSections(nextMarkdown);
}

function isPreviewEditable(block) {
  return block.region === "editable" && block.kind !== "heading";
}

function runtimeSignature(runtime) {
  const blocks = runtime?.blocks || [];
  return JSON.stringify(blocks.map((block) => ({
    id: block.projection?.block_id || block.object_id,
    quote: block.source_anchor?.quote || block.text || "",
    annotations: (block.annotations || []).map((annotation) => ({
      ko_id: annotation.ko_id,
      kind: annotation.kind,
      title: annotation.title,
      body_md: annotation.body_md || "",
      render_mode: annotation.render_mode || "",
      visual_bbox: annotation.visual_bbox || null,
      visual_strokes: (annotation.visual_strokes || []).map((stroke) => ({
        tool: stroke.tool || "pen",
        color: stroke.color || "",
        opacity: stroke.opacity ?? "",
        points: (stroke.points || []).map((point) => [
          Number(point.x || 0).toFixed(4),
          Number(point.y || 0).toFixed(4),
          Number(point.pressure || 0).toFixed(3),
        ]),
      })),
    })),
  })));
}

const fallbackSurfaceSdk = {
  normalizeText,
  parseInkLoopVisualModel,
  replaceInkLoopBlockContent,
  renderInkLoopVisualModel,
  renderMarkLayer,
  renderMarginNotes,
  updateInkLoopAnnotation,
};

module.exports = class InkLoopSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.loadSurfaceSdk();
    this.pendingTimer = null;
    this.lastChange = null;
    this.nativeEditTimers = new Map();
    this.previewSignatures = new Map();
    this.appendQueues = new Map();
    this.refreshPreviewsRunning = false;
    this.statusPath = `${this.settings.baseDir}/.obsidian-plugin-status.json`;

    this.addCommand({ id: "sync-inkloop-now", name: "Sync InkLoop now", callback: () => this.syncNow("command", { notify: true }) });
    this.addCommand({ id: "open-current-file-in-inkloop", name: "Open current file with InkLoop sidecar", callback: () => this.openCurrentFileInInkLoop() });
    this.addCommand({ id: "toggle-inkloop-surface-mode", name: "Toggle InkLoop focus/thinking mode", callback: () => this.toggleSurfaceMode() });
    this.addCommand({ id: "inkloop-tool-text", name: "InkLoop tool: text", callback: () => this.setInkTool("text") });
    this.addCommand({ id: "inkloop-tool-pen", name: "InkLoop tool: pencil", callback: () => this.setInkTool("pen") });
    this.addCommand({ id: "inkloop-tool-highlighter", name: "InkLoop tool: highlighter", callback: () => this.setInkTool("highlighter") });
    this.registerView(INKLOOP_VIEW_TYPE, (leaf) => new InkLoopDocumentView(leaf, this));
    this.addSettingTab(new InkLoopSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      void this.app.workspace.detachLeavesOfType(INKLOOP_VIEW_TYPE);
    });

    this.registerEvent(this.app.vault.on("modify", (file) => void this.onVaultChanged("modify", file)));
    this.registerEvent(this.app.vault.on("delete", (file) => void this.onVaultChanged("delete", file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onVaultChanged("rename", file, oldPath)));
    this.registerMarkdownPostProcessor((el, ctx) => this.enhancePreview(el, ctx), 100);
    this.previewRefreshTimer = window.setInterval(() => void this.refreshOpenInkLoopPreviews(), 1500);
    this.registerInterval?.(this.previewRefreshTimer);
    void this.writeStatus({ loaded_at: new Date().toISOString(), status: "loaded" });
  }

  onunload() {
    if (this.pendingTimer) window.clearTimeout(this.pendingTimer);
    if (this.previewRefreshTimer) window.clearInterval(this.previewRefreshTimer);
    for (const timer of this.nativeEditTimers?.values?.() || []) window.clearTimeout(timer);
    this.nativeEditTimers?.clear?.();
    this.previewSignatures?.clear?.();
    this.app.workspace.detachLeavesOfType(INKLOOP_VIEW_TYPE);
  }

  canOpenSourcePath(path) {
    return /\.(md|pdf)$/i.test(path || "");
  }

  sidecarPath(...parts) {
    return [this.settings.baseDir, ...parts].filter(Boolean).join("/").replace(/\/+/g, "/");
  }

  async readJson(path, fallback = null) {
    try {
      return JSON.parse(await this.app.vault.adapter.read(path));
    } catch {
      return fallback;
    }
  }

  async writeJson(path, value) {
    await this.app.vault.adapter.mkdir(path.split("/").slice(0, -1).join("/")).catch(() => {});
    await this.app.vault.adapter.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async appendJsonLine(path, value) {
    const operation = (this.appendQueues.get(path) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.app.vault.adapter.mkdir(path.split("/").slice(0, -1).join("/")).catch(() => {});
        let current = "";
        try {
          current = await this.app.vault.adapter.read(path);
        } catch {
          current = "";
        }
        await this.app.vault.adapter.write(path, `${current}${jsonLine(value)}`);
      });
    this.appendQueues.set(path, operation);
    try {
      await operation;
    } finally {
      if (this.appendQueues.get(path) === operation) this.appendQueues.delete(path);
    }
  }

  runtimeSyncEvent(input) {
    const now = nowIso();
    const event = {
      schema_version: "inkloop.runtime_sync_event.v1",
      event_id: localId("evt"),
      source: "obsidian_plugin",
      doc_id: input.doc_id,
      operation: input.operation,
      target: input.target,
      payload: input.payload || {},
      status: "pending",
      created_at: now,
      updated_at: now,
    };
    event.dedupe_key = `${event.operation}:${event.doc_id}:${event.target?.id || event.target?.block_id || "document"}:${event.updated_at}`;
    return event;
  }

  async appendRuntimeSyncEvent(input) {
    const event = this.runtimeSyncEvent(input);
    await this.appendJsonLine(this.sidecarPath("outbox", "runtime-events.jsonl"), event);
    return event;
  }

  async readJsonLines(path) {
    try {
      const text = await this.app.vault.adapter.read(path);
      return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async writeJsonLines(path, values) {
    await this.app.vault.adapter.mkdir(path.split("/").slice(0, -1).join("/")).catch(() => {});
    await this.app.vault.adapter.write(path, values.map(jsonLine).join(""));
  }

  async ensureVaultManifest() {
    const now = nowIso();
    const manifestPath = this.sidecarPath("manifest.json");
    const existing = await this.readJson(manifestPath, {});
    const manifest = {
      schema_version: "inkloop.vault_manifest.v1",
      vault_id: existing.vault_id || this.app.vault.getName?.() || "obsidian-vault",
      created_at: existing.created_at || now,
      updated_at: now,
      sidecar_location: "vault_hidden",
      plugin_version: this.manifest.version,
      inkloop_runtime_version: "sidecar-runtime.v1",
      indexes: existing.indexes || {},
    };
    await this.writeJson(manifestPath, manifest);
    return manifest;
  }

  async upsertPathIndex(path, item) {
    const now = nowIso();
    const indexPath = this.sidecarPath("indexes/path-index.json");
    const index = await this.readJson(indexPath, { schema_version: "inkloop.path_index.v1", updated_at: now, items: {} });
    index.updated_at = now;
    index.items = Object.assign({}, index.items, { [path]: item });
    await this.writeJson(indexPath, index);
  }

  async upsertDocIndex(doc) {
    const now = nowIso();
    const indexPath = this.sidecarPath("indexes/doc-index.json");
    const index = await this.readJson(indexPath, { schema_version: "inkloop.doc_index.v1", updated_at: now, items: {} });
    index.updated_at = now;
    index.items = Object.assign({}, index.items, { [doc.doc_id]: doc });
    await this.writeJson(indexPath, index);
  }

  async docIdForPath(path) {
    const index = await this.readJson(this.sidecarPath("indexes/path-index.json"), null);
    return index?.items?.[path]?.doc_id || null;
  }

  docIdForSidecarPath(path) {
    const prefix = `${this.settings.baseDir}/docs/`;
    if (!path?.startsWith(prefix)) return null;
    return path.slice(prefix.length).split("/").filter(Boolean)[0] || null;
  }

  async sourcePathForDocId(docId) {
    const source = await this.readJson(this.sidecarPath("docs", docId, "source.json"), null);
    return source?.vault_file?.path || null;
  }

  async trackedDocIdForPath(path) {
    if (!path) return null;
    return this.docIdForPath(path);
  }

  async sourceHashForFile(file) {
    if (file.extension === "pdf") return sha256Tagged(`${file.path}:${file.stat?.size || 0}:${file.stat?.mtime || 0}`);
    return sha256Tagged(await this.app.vault.cachedRead(file));
  }

  async ensureSidecarDocument(file) {
    if (!file?.path || !this.canOpenSourcePath(file.path)) throw new Error("InkLoop can open Markdown and PDF files only.");
    await this.ensureVaultManifest();
    const existingDocId = await this.docIdForPath(file.path);
    if (existingDocId) return existingDocId;
    return file.extension === "pdf" ? this.createPdfSidecar(file) : this.createMarkdownSidecar(file);
  }

  async createMarkdownSidecar(file) {
    const now = nowIso();
    const originalMarkdown = await this.app.vault.cachedRead(file);
    const legacyModel = parseInkLoopVisualModel(originalMarkdown);
    const legacyIdentity = legacyModel ? legacyInkLoopIdentity(originalMarkdown) : {};
    const markdown = legacyModel ? cleanMarkdownFromVisualModel(legacyModel) : originalMarkdown;
    if (legacyModel && markdown !== originalMarkdown) {
      if (this.app.vault.modify) await this.app.vault.modify(file, markdown);
      else await this.app.vault.adapter.write(file.path, markdown);
    }
    const contentHash = await sha256Tagged(markdown);
    const docId = legacyIdentity.docId || docIdFromHash(contentHash);
    const sourceId = sourceRefId(docId);
    const chunks = legacyModel
      ? legacyModel.blocks.map((block) => String(block.content || "").trim()).filter(Boolean)
      : markdownChunks(markdown);
    const blocks = [];
    let lineCursor = 1;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const legacyBlock = legacyModel?.blocks[index];
      const blockId = legacyBlock?.id || `mdblk_${docId.replace(/^doc_/, "")}_${String(index + 1).padStart(4, "0")}`;
      const lineCount = chunk.split("\n").length;
      blocks.push({
        schema_version: "inkloop.surface_object.v1",
        object_id: blockId,
        doc_id: docId,
        source_revision_id: legacyIdentity.revisionId || contentHash,
        kind: "md_block",
        text: normalizeText(chunk),
        source_anchor: {
          type: "markdown",
          file_path: file.path,
          block_id: blockId,
          heading_path: [],
          range: { start_line: lineCursor, start_col: 0, end_line: lineCursor + lineCount - 1, end_col: chunk.split("\n").at(-1)?.length || 0 },
          quote: normalizeText(chunk),
        },
        reading_order: index,
        fingerprint: { text_hash: await sha256Tagged(normalizeText(chunk)) },
        projection: {
          block_id: blockId,
          kind: legacyBlock?.kind || markdownKind(chunk),
          heading_level: legacyBlock ? markdownHeadingLevel(legacyBlock.content) : markdownHeadingLevel(chunk),
          region: "editable",
          page_index: legacyBlock?.page === undefined ? undefined : Number(legacyBlock.page),
          knowledge_object_ids: (legacyBlock?.annotations || []).map((annotation) => annotation.ko_id).filter(Boolean),
        },
        annotations: legacyBlock?.annotations || [],
      });
      lineCursor += lineCount + 1;
    }
    await this.writeSidecarBasics({
      file,
      docId,
      sourceId,
      title: legacyModel?.documentTitle || titleFromMarkdown(markdown, file.basename),
      sourceType: "markdown",
      contentHash,
      blocks,
      now,
    });
    return docId;
  }

  async createPdfSidecar(file) {
    const now = nowIso();
    const contentHash = await this.sourceHashForFile(file);
    const docId = docIdFromHash(contentHash);
    const sourceId = sourceRefId(docId);
    await this.writeSidecarBasics({
      file,
      docId,
      sourceId,
      title: file.basename,
      sourceType: "pdf",
      contentHash,
      blocks: [],
      now,
    });
    return docId;
  }

  async writeSidecarBasics({ file, docId, sourceId, title, sourceType, contentHash, blocks, now }) {
    const docDir = this.sidecarPath("docs", docId);
    await Promise.all([
      this.app.vault.adapter.mkdir(this.sidecarPath("indexes")).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/surfaces`).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/canvas`).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/marks`).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/overlays`).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/knowledge`).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/assets`).catch(() => {}),
    ]);
    await this.writeJson(`${docDir}/document.json`, {
      schema_version: "inkloop.document.v1",
      doc_id: docId,
      title,
      source_type: sourceType,
      source_ref_id: sourceId,
      created_at: now,
      updated_at: now,
      default_view: "preview",
      capabilities: {
        native_text_editable: sourceType === "markdown",
        paginated: sourceType === "pdf",
        infinite_canvas: true,
        supports_handwriting: true,
        supports_ai_overlay: true,
      },
    });
    await this.writeJson(`${docDir}/source.json`, {
      schema_version: "inkloop.source_ref.v1",
      source_ref_id: sourceId,
      doc_id: docId,
      kind: "obsidian_vault_file",
      vault_file: { vault_id: this.app.vault.getName?.() || "obsidian-vault", path: file.path, extension: `.${file.extension}` },
      identity: {
        original_path: file.path,
        current_path: file.path,
        initial_content_hash: contentHash,
        current_content_hash: contentHash,
        size: file.stat?.size,
        mtime: file.stat?.mtime,
        fingerprint: contentHash,
      },
      status: "active",
    });
    await this.writeJson(`${docDir}/surfaces/surface-manifest.json`, {
      schema_version: "inkloop.surface_manifest.v1",
      doc_id: docId,
      source_revision_id: contentHash,
      source_type: sourceType,
      object_count: blocks.length,
      blocks_path: sourceType === "markdown" ? "surfaces/markdown.blocks.jsonl" : "surfaces/pdf.pages.jsonl",
      updated_at: now,
    });
    if (sourceType === "markdown") await this.app.vault.adapter.write(`${docDir}/surfaces/markdown.blocks.jsonl`, blocks.map(jsonLine).join(""));
    else await this.app.vault.adapter.write(`${docDir}/surfaces/pdf.pages.jsonl`, "");
    await this.writeJson(`${docDir}/canvas/canvas.json`, {
      schema_version: "inkloop.canvas.v1",
      doc_id: docId,
      canvas_id: `canvas_${docId.replace(/^doc_/, "")}`,
      coordinate_space: { unit: "world_px", origin: "top_left", scale_base: 1 },
      mode_defaults: { preview_layout: "source_first", edit_layout: "free_canvas" },
      layers: [
        { layer_id: "layer_source", kind: "source_render", visible: true, locked: true, z_index: 0 },
        { layer_id: "layer_ink", kind: "ink", visible: true, locked: false, z_index: 10 },
        { layer_id: "layer_typed_text", kind: "typed_text", visible: true, locked: false, z_index: 20 },
        { layer_id: "layer_ai_overlay", kind: "ai_overlay", visible: true, locked: false, z_index: 30 },
      ],
      updated_at: now,
    });
    await this.upsertPathIndex(file.path, { path: file.path, doc_id: docId, source_ref_id: sourceId, last_seen_content_hash: contentHash, last_seen_at: now });
    await this.upsertDocIndex({ doc_id: docId, title, source_type: sourceType, source_ref_id: sourceId, current_path: file.path, updated_at: now });
  }

  async loadRuntimeDocument(docId) {
    const docDir = this.sidecarPath("docs", docId);
    const documentRecord = await this.readJson(`${docDir}/document.json`, null);
    const source = await this.readJson(`${docDir}/source.json`, null);
    if (!documentRecord || !source) return null;
    const blocks = documentRecord.source_type === "markdown"
      ? await this.readJsonLines(`${docDir}/surfaces/markdown.blocks.jsonl`)
      : [];
    const nodes = await this.readJsonLines(`${docDir}/canvas/nodes.jsonl`);
    return { docDir, document: documentRecord, source, blocks, nodes };
  }

  async writeRuntimeBlocks(runtime, blocks) {
    await this.writeJsonLines(`${runtime.docDir}/surfaces/markdown.blocks.jsonl`, blocks);
  }

  async updateMarkdownBlockContent(docId, blockId, nextContent) {
    const runtime = await this.loadRuntimeDocument(docId);
    if (!runtime?.source?.vault_file?.path) throw new Error("InkLoop source is missing.");
    const blocks = runtime.blocks || [];
    const index = blocks.findIndex((block) => (block.projection?.block_id || block.object_id) === blockId);
    if (index === -1) throw new Error(`InkLoop block was not found: ${blockId}`);
    const block = blocks[index];
    const range = block.source_anchor?.range;
    if (!range) throw new Error(`InkLoop block has no editable source range: ${blockId}`);

    const sourcePath = runtime.source.vault_file.path;
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    const markdown = file ? await this.app.vault.cachedRead(file) : await this.app.vault.adapter.read(sourcePath);
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const nextLines = String(nextContent || "").trimEnd().split("\n");
    const oldLineCount = range.end_line - range.start_line + 1;
    const lineDelta = nextLines.length - oldLineCount;
    lines.splice(range.start_line - 1, oldLineCount, ...nextLines);
    const nextMarkdown = lines.join("\n");
    if (file && this.app.vault.modify) await this.app.vault.modify(file, nextMarkdown);
    else await this.app.vault.adapter.write(sourcePath, nextMarkdown);

    const quote = normalizeText(nextContent);
    blocks[index] = {
      ...block,
      text: quote,
      source_anchor: {
        ...(block.source_anchor || {}),
        quote,
        range: {
          ...range,
          end_line: range.start_line + nextLines.length - 1,
          end_col: nextLines[nextLines.length - 1]?.length || 0,
        },
      },
      fingerprint: { ...(block.fingerprint || {}), text_hash: await sha256Tagged(quote) },
    };
    if (lineDelta !== 0) {
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        if (blockIndex === index) continue;
        const otherRange = blocks[blockIndex]?.source_anchor?.range;
        if (!otherRange || otherRange.start_line <= range.end_line) continue;
        blocks[blockIndex] = {
          ...blocks[blockIndex],
          source_anchor: {
            ...(blocks[blockIndex].source_anchor || {}),
            range: {
              ...otherRange,
              start_line: otherRange.start_line + lineDelta,
              end_line: otherRange.end_line + lineDelta,
            },
          },
        };
      }
    }
    await this.writeRuntimeBlocks(runtime, blocks);
    const event = await this.appendRuntimeSyncEvent({
      doc_id: docId,
      operation: "block.update",
      target: { type: "block", id: blockId, block_id: blockId },
      payload: {
        block_id: blockId,
        quote,
        content_md: nextContent,
        commit_target: { type: "markdown_source_patch" },
        source_path: sourcePath,
        range: blocks[index]?.source_anchor?.range,
      },
    });
    this.lastChange = { event_type: "inkloop_text_edit", path: sourcePath, doc_id: docId, runtime_event_id: event.event_id, observed_at: nowIso() };
    this.scheduleSync("inkloop_text_edit");
    void this.refreshDocPreview(docId);
  }

  async updateSidecarAnnotation(docId, koId, patch) {
    const runtime = await this.loadRuntimeDocument(docId);
    if (!runtime) throw new Error(`InkLoop runtime document is missing: ${docId}`);
    let didUpdate = false;
    let targetBlockId;
    const now = nowIso();
    const cleanPatch = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== undefined));
    const blocks = (runtime.blocks || []).map((block) => {
      const annotations = (block.annotations || []).map((annotation) => {
        if (annotation.ko_id !== koId) return annotation;
        didUpdate = true;
        targetBlockId = block.projection?.block_id || block.object_id;
        return { ...annotation, ...cleanPatch, updated_at: now };
      });
      return { ...block, annotations };
    });
    if (!didUpdate) throw new Error(`InkLoop annotation was not found: ${koId}`);
    await this.writeRuntimeBlocks(runtime, blocks);
    const event = await this.appendRuntimeSyncEvent({
      doc_id: docId,
      operation: "annotation.update",
      target: { type: "annotation", id: koId, block_id: targetBlockId },
      payload: { ko_id: koId, block_id: targetBlockId, patch: cleanPatch },
    });
    this.lastChange = { event_type: "inkloop_annotation_edit", doc_id: docId, runtime_event_id: event.event_id, observed_at: nowIso() };
    this.scheduleSync("inkloop_annotation_edit");
    void this.refreshDocPreview(docId);
  }

  async addSidecarAnnotation(docId, blockId, annotation) {
    const runtime = await this.loadRuntimeDocument(docId);
    if (!runtime) throw new Error(`InkLoop runtime document is missing: ${docId}`);
    const blocks = runtime.blocks || [];
    const index = blocks.findIndex((block) => (block.projection?.block_id || block.object_id) === blockId);
    if (index === -1) throw new Error(`InkLoop block was not found: ${blockId}`);
    const block = blocks[index];
    const annotations = [...(block.annotations || []), annotation];
    blocks[index] = {
      ...block,
      annotations,
      projection: {
        ...(block.projection || {}),
        knowledge_object_ids: [...new Set([...(block.projection?.knowledge_object_ids || []), annotation.ko_id])],
      },
    };
    await this.writeRuntimeBlocks(runtime, blocks);
    const event = await this.appendRuntimeSyncEvent({
      doc_id: docId,
      operation: "annotation.add",
      target: { type: "annotation", id: annotation.ko_id, block_id: blockId },
      payload: { block_id: blockId, annotation },
    });
    this.lastChange = { event_type: "inkloop_handwriting_add", doc_id: docId, runtime_event_id: event.event_id, observed_at: nowIso() };
    this.scheduleSync("inkloop_handwriting_add");
    void this.refreshDocPreview(docId);
    return annotation;
  }

  async updateTrackedSourcePath(file, oldPath) {
    if (!file?.path || !oldPath || !this.canOpenSourcePath(file.path)) return;
    const now = nowIso();
    const indexPath = this.sidecarPath("indexes/path-index.json");
    const index = await this.readJson(indexPath, null);
    const item = index?.items?.[oldPath];
    if (!item?.doc_id) return;

    const contentHash = await this.sourceHashForFile(file).catch(() => item.last_seen_content_hash);
    delete index.items[oldPath];
    index.items[file.path] = {
      ...item,
      path: file.path,
      last_seen_content_hash: contentHash,
      last_seen_at: now,
    };
    index.updated_at = now;
    await this.writeJson(indexPath, index);

    const docDir = this.sidecarPath("docs", item.doc_id);
    const source = await this.readJson(`${docDir}/source.json`, null);
    if (source?.vault_file) {
      source.vault_file.path = file.path;
      source.vault_file.extension = `.${file.extension}`;
      source.identity = {
        ...(source.identity || {}),
        current_path: file.path,
        current_content_hash: contentHash,
        size: file.stat?.size,
        mtime: file.stat?.mtime,
      };
      await this.writeJson(`${docDir}/source.json`, source);
    }

    const docIndexPath = this.sidecarPath("indexes/doc-index.json");
    const docIndex = await this.readJson(docIndexPath, null);
    if (docIndex?.items?.[item.doc_id]) {
      docIndex.updated_at = now;
      docIndex.items[item.doc_id] = {
        ...docIndex.items[item.doc_id],
        current_path: file.path,
        updated_at: now,
      };
      await this.writeJson(docIndexPath, docIndex);
    }
  }

  sidecarBlockToVisualBlock(block) {
    return {
      id: block.projection?.block_id || block.object_id,
      kind: block.projection?.kind || "paragraph",
      region: block.projection?.region || "editable",
      page: block.projection?.page_index === undefined ? undefined : String(block.projection.page_index),
      content: block.source_anchor?.quote || block.text || "",
      annotations: block.annotations || [],
    };
  }

  async openCurrentFileInInkLoop() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file to open in InkLoop");
      return;
    }
    await this.openFileInInkLoop(file);
  }

  async openFileInInkLoop(file) {
    if (!this.canOpenSourcePath(file.path)) {
      new Notice("InkLoop can open Markdown and PDF files in this MVP");
      return;
    }
    await this.ensureSidecarDocument(file);
    const markdownLeaves = this.app.workspace.getLeavesOfType?.("markdown") || [];
    const existing = markdownLeaves.find((leaf) => leaf.view?.file?.path === file.path);
    const leaf = existing || this.app.workspace.getLeaf("tab");
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    if (leaf.openFile) await leaf.openFile(file, { active: true });
    else await leaf.setViewState({ type: "markdown", active: true, state: { file: file.path, mode: "preview" } });
    this.app.workspace.revealLeaf(leaf);
  }

  surfaceMode() {
    return this.settings.surfaceMode === "focus" ? "focus" : "thinking";
  }

  inkTool() {
    return normalizeInkTool(this.settings.inkTool);
  }

  strokeTool() {
    const tool = this.inkTool();
    return isStrokeTool(tool) ? tool : "pen";
  }

  inkColor(tool = this.strokeTool()) {
    const normalizedTool = isStrokeTool(tool) ? tool : "pen";
    return normalizeHexColor(this.settings.inkColors?.[normalizedTool], DEFAULT_SETTINGS.inkColors[normalizedTool]);
  }

  inkOpacity(tool = this.strokeTool()) {
    const normalizedTool = isStrokeTool(tool) ? tool : "pen";
    return DEFAULT_INK_OPACITY[normalizedTool];
  }

  async setInkColor(color) {
    const tool = this.strokeTool();
    this.settings.inkColors = {
      ...(this.settings.inkColors || {}),
      [tool]: normalizeHexColor(color, this.inkColor(tool)),
    };
    await this.saveSettings();
    this.applySurfaceModeToOpenPreviews();
  }

  async toggleSurfaceMode() {
    await this.setSurfaceMode(this.surfaceMode() === "focus" ? "thinking" : "focus");
  }

  async setInkTool(tool) {
    this.settings.inkTool = normalizeInkTool(tool);
    await this.saveSettings();
    this.applySurfaceModeToOpenPreviews();
  }

  async setSurfaceMode(mode) {
    this.settings.surfaceMode = mode === "focus" ? "focus" : "thinking";
    await this.saveSettings();
    this.applySurfaceModeToOpenPreviews();
  }

  applySurfaceModeToOpenPreviews() {
    for (const root of document.querySelectorAll(".markdown-preview-view.inkloop-native-preview-root")) {
      this.applySurfaceModeToRoot(root);
    }
  }

  applySurfaceModeToRoot(root) {
    const mode = this.surfaceMode();
    const tool = this.inkTool();
    root.dataset.inkloopMode = mode;
    root.dataset.inkloopTool = tool;
    root.classList.toggle("inkloop-focus-mode", mode === "focus");
    root.classList.toggle("inkloop-thinking-mode", mode === "thinking");
    root.classList.toggle("inkloop-tool-text", tool === "text");
    root.classList.toggle("inkloop-tool-pen", tool === "pen");
    root.classList.toggle("inkloop-tool-highlighter", tool === "highlighter");
    for (const surface of root.querySelectorAll(".inkloop-surface-root")) {
      surface.classList.toggle("is-focus-mode", mode === "focus");
      surface.classList.toggle("is-thinking-mode", mode === "thinking");
      surface.dataset.inkloopTool = tool;
    }
    for (const button of root.querySelectorAll(".inkloop-mode-toggle")) {
      button.textContent = mode === "focus" ? "标记思考" : "专注阅读";
      button.setAttribute("aria-label", mode === "focus" ? "进入标记思考模式" : "进入专注阅读模式");
      button.setAttribute("title", mode === "focus" ? "显示标注并开启编辑" : "隐藏标注并进入专注阅读");
    }
    for (const button of root.querySelectorAll(".inkloop-tool-btn")) {
      button.classList.toggle("is-active", button.dataset.tool === tool);
      button.disabled = mode === "focus";
    }
    for (const input of root.querySelectorAll(".inkloop-color-input")) {
      input.value = this.inkColor();
      input.disabled = mode === "focus" || tool === "text";
    }
    for (const swatch of root.querySelectorAll(".inkloop-color-swatch")) {
      const color = normalizeHexColor(swatch.dataset.color, DEFAULT_SETTINGS.inkColors.pen);
      swatch.classList.toggle("is-active", color === this.inkColor());
      swatch.disabled = mode === "focus" || tool === "text";
    }
    for (const content of root.querySelectorAll(".inkloop-visual-block[data-editable=\"true\"] .inkloop-content-plane > :is(p, h1, h2, h3, h4, h5, h6, li, blockquote)")) {
      if (mode === "thinking" && tool === "text") {
        content.contentEditable = "true";
        content.spellcheck = true;
        content.removeAttribute("tabindex");
      } else {
        content.contentEditable = "false";
        content.removeAttribute("contenteditable");
        content.spellcheck = false;
        content.setAttribute("tabindex", "-1");
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.baseDir = cleanDir(this.settings.baseDir, DEFAULT_SETTINGS.baseDir);
    this.settings.documentsDir = cleanDir(this.settings.documentsDir, DEFAULT_SETTINGS.documentsDir);
    this.settings.debounceMs = Math.max(100, Number(this.settings.debounceMs) || DEFAULT_SETTINGS.debounceMs);
    this.settings.previewEditing = false;
    this.settings.surfaceMode = this.settings.surfaceMode === "focus" ? "focus" : "thinking";
    this.settings.inkTool = normalizeInkTool(this.settings.inkTool);
    this.settings.inkColors = {
      pen: normalizeHexColor(this.settings.inkColors?.pen, DEFAULT_SETTINGS.inkColors.pen),
      highlighter: normalizeHexColor(this.settings.inkColors?.highlighter, DEFAULT_SETTINGS.inkColors.highlighter),
    };
  }

  async saveSettings() {
    this.settings.baseDir = cleanDir(this.settings.baseDir, DEFAULT_SETTINGS.baseDir);
    this.settings.documentsDir = cleanDir(this.settings.documentsDir, DEFAULT_SETTINGS.documentsDir);
    this.settings.debounceMs = Math.max(100, Number(this.settings.debounceMs) || DEFAULT_SETTINGS.debounceMs);
    this.settings.surfaceMode = this.settings.surfaceMode === "focus" ? "focus" : "thinking";
    this.settings.inkTool = normalizeInkTool(this.settings.inkTool);
    this.settings.inkColors = {
      pen: normalizeHexColor(this.settings.inkColors?.pen, DEFAULT_SETTINGS.inkColors.pen),
      highlighter: normalizeHexColor(this.settings.inkColors?.highlighter, DEFAULT_SETTINGS.inkColors.highlighter),
    };
    this.statusPath = `${this.settings.baseDir}/.obsidian-plugin-status.json`;
    await this.saveData(this.settings);
  }

  async loadSurfaceSdk() {
    this.surfaceSdk = fallbackSurfaceSdk;
    try {
      const bundlePath = `.obsidian/plugins/${this.manifest.id}/inkloop-surface-sdk.iife.js`;
      const bundle = await this.app.vault.adapter.read(bundlePath);
      const before = globalThis.InkLoopSurfaceSDK;
      const loaded = new Function("globalThis", `var window = globalThis; var self = globalThis;\n${bundle}\n;return typeof InkLoopSurfaceSDK !== "undefined" ? InkLoopSurfaceSDK : (globalThis.InkLoopSurfaceSDK || window.InkLoopSurfaceSDK || self.InkLoopSurfaceSDK);`)(globalThis);
      if (loaded?.parseInkLoopVisualModel && loaded?.renderMarkLayer && loaded?.renderMarginNotes) {
        if (!loaded.renderInkLoopVisualModel) loaded.renderInkLoopVisualModel = renderInkLoopVisualModel;
        this.surfaceSdk = loaded;
        this.surfaceSdkLoadedFrom = bundlePath;
      } else {
        globalThis.InkLoopSurfaceSDK = before;
      }
    } catch (error) {
      this.surfaceSdkLoadError = String(error?.message || error);
    }
  }

  isInkLoopPath(path) {
    const documentsPrefix = `${this.settings.documentsDir}/`;
    const basePrefix = `${this.settings.baseDir}/`;
    return path === this.settings.documentsDir
      || path.startsWith(documentsPrefix)
      || path.startsWith(basePrefix);
  }

  isIgnoredPath(path) {
    return path === this.statusPath;
  }

  async onVaultChanged(eventType, file, oldPath) {
    if (!this.settings.autoSyncOnChange || !file?.path) return;
    if (this.isIgnoredPath(file.path) || (oldPath && this.isIgnoredPath(oldPath))) return;
    const trackedDocId = await this.trackedDocIdForPath(file.path);
    const oldTrackedDocId = oldPath ? await this.trackedDocIdForPath(oldPath) : null;
    const sidecarDocId = this.docIdForSidecarPath(file.path);
    const oldSidecarDocId = oldPath ? this.docIdForSidecarPath(oldPath) : null;
    const isTracked = this.isInkLoopPath(file.path) || trackedDocId || (oldPath && (this.isInkLoopPath(oldPath) || oldTrackedDocId));
    if (!isTracked) return;
    if (eventType === "rename" && oldPath && oldTrackedDocId) await this.updateTrackedSourcePath(file, oldPath);
    const refreshDocId = trackedDocId || oldTrackedDocId || sidecarDocId || oldSidecarDocId;
    this.lastChange = {
      event_type: eventType,
      path: file.path,
      old_path: oldPath,
      doc_id: refreshDocId || undefined,
      observed_at: new Date().toISOString(),
    };
    void this.writeStatus({ status: "event_observed", last_change: this.lastChange });
    if (refreshDocId) void this.refreshDocPreview(refreshDocId);
    this.scheduleSync(eventType);
  }

  scheduleSync(reason) {
    if (this.pendingTimer) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = null;
      void this.syncNow(reason, { notify: false });
    }, this.settings.debounceMs);
  }

  async syncNow(reason, options = {}) {
    if (!this.settings.syncEndpoint) {
      if (options.notify ?? this.settings.notifyManualSync) new Notice("InkLoop sync endpoint is not configured");
      await this.writeStatus({ status: "sync_skipped", reason, last_change: this.lastChange });
      return;
    }

    const started = performance.now();
    await this.writeStatus({ status: "sync_started", reason, last_change: this.lastChange, sync_started_at: new Date().toISOString() });
    try {
      const response = await requestUrl({
        url: this.settings.syncEndpoint,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          reason,
          source: "obsidian-plugin",
          changed: this.lastChange,
        }),
      });
      const latency = Math.round(performance.now() - started);
      const payload = typeof response.json === "object" ? response.json : {};
      const failed = payload.ok === false;
      if (failed || (options.notify ?? this.settings.notifyManualSync)) {
        const message = failed
          ? `InkLoop sync failed in ${latency}ms`
          : `InkLoop sync completed in ${payload.latency_ms ?? latency}ms`;
        new Notice(message);
      }
      await this.writeStatus({
        status: failed ? "sync_failed" : "sync_completed",
        reason,
        last_change: this.lastChange,
        latency_ms: payload.latency_ms ?? latency,
        response: payload,
        synced_at: new Date().toISOString(),
      });
    } catch (error) {
      await this.writeStatus({
        status: "sync_failed",
        reason,
        last_change: this.lastChange,
        error: String(error?.message || error),
        synced_at: new Date().toISOString(),
      });
      new Notice(`InkLoop sync failed: ${String(error?.message || error)}`);
    }
  }

  async writeStatus(patch) {
    const base = {
      plugin_id: "inkloop-sync",
      documents_dir: this.settings.documentsDir,
      base_dir: this.settings.baseDir,
      sync_endpoint: this.settings.syncEndpoint,
      auto_sync_on_change: this.settings.autoSyncOnChange,
      debounce_ms: this.settings.debounceMs,
      visual_enhancement: this.settings.visualEnhancement,
      preview_editing: false,
      surface_mode: this.surfaceMode(),
      ink_tool: this.inkTool(),
      surface_sdk: this.surfaceSdkLoadedFrom ? "bundle" : "inline",
      surface_sdk_error: this.surfaceSdkLoadError,
    };
    let previous = {};
    try {
      previous = JSON.parse(await this.app.vault.adapter.read(this.statusPath));
    } catch {
      previous = {};
    }
    await this.app.vault.adapter.mkdir(this.settings.baseDir).catch(() => {});
    await this.app.vault.adapter.write(this.statusPath, `${JSON.stringify({ ...previous, ...base, ...patch }, null, 2)}\n`);
  }

  async enhancePreview(el, ctx) {
    if (!this.settings.visualEnhancement || !ctx?.sourcePath) return;
    if (el.dataset.inkloopVisualEnhanced === "true" || el.dataset.inkloopVisualEnhanced === "pending") return;
    el.dataset.inkloopVisualEnhanced = "pending";

    let model = null;
    let previewRuntime = null;
    let didEnhance = false;
    try {
      const docId = await this.docIdForPath(ctx.sourcePath);
      if (docId) {
        const runtime = await this.loadRuntimeDocument(docId);
        previewRuntime = runtime;
        if (runtime?.document?.source_type === "markdown") {
          model = {
            documentTitle: runtime.document.title,
            blocks: runtime.blocks.map((block) => this.sidecarBlockToVisualBlock(block)),
          };
        }
      } else if (ctx.sourcePath.startsWith(`${this.settings.documentsDir}/`)) {
        let markdown = "";
        try {
          markdown = await this.app.vault.adapter.read(ctx.sourcePath);
        } catch {
          return;
        }
        model = this.surfaceSdk.parseInkLoopVisualModel(markdown);
        if (model?.blocks.length) {
          const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (file && this.canOpenSourcePath(file.path)) {
            await this.ensureSidecarDocument(file).catch((error) => {
              this.surfaceSdkLoadError = String(error?.message || error);
            });
          }
        }
      }
      if (!model?.blocks.length) return;

      el.dataset.inkloopVisualEnhanced = "true";
      didEnhance = true;
      el.addClass?.("inkloop-native-preview");
      el.addClass?.("inkloop-surface-root");
      this.markPreviewRoot(el);
      this.installModeControl(el);
      this.hideDuplicateDocumentTitle(el, model);
      this.hideAnnotationFallback(el);

      const used = new Set();
      for (const block of model.blocks) {
        if (!block.annotations.length && !isPreviewEditable(block)) continue;
        const target = this.findBlockElement(el, block, used);
        if (!target) continue;
        used.add(target);
        this.decorateBlock(target, block, docId);
      }
      this.applySurfaceModeToRoot(el.closest(".markdown-preview-view") || el);
      if (previewRuntime) this.previewSignatures.set(ctx.sourcePath, runtimeSignature(previewRuntime));
    } finally {
      if (!didEnhance && el.dataset.inkloopVisualEnhanced === "pending") delete el.dataset.inkloopVisualEnhanced;
    }
  }

  requestMarkdownPreviewRerender(view, sourcePath, options = {}) {
    let didRequest = false;
    for (const target of [view?.previewMode, view?.currentMode, view]) {
      if (typeof target?.rerender === "function") {
        target.rerender(true);
        didRequest = true;
        break;
      }
      if (typeof target?.render === "function") {
        target.render(true);
        didRequest = true;
        break;
      }
    }
    window.setTimeout(() => void this.enhanceMarkdownView(view, sourcePath, { force: options.force === true }), didRequest ? 120 : 0);
    return didRequest;
  }

  resetEnhancedPreview(target) {
    for (const wrapper of [...target.querySelectorAll(".inkloop-visual-block")]) {
      const contentPlane = wrapper.querySelector(".inkloop-content-plane");
      const sourceNode = contentPlane?.firstElementChild;
      if (sourceNode && wrapper.parentNode) wrapper.parentNode.insertBefore(sourceNode, wrapper);
      wrapper.remove();
    }
    for (const controls of target.querySelectorAll(".inkloop-surface-controls")) controls.remove();
    delete target.dataset.inkloopVisualEnhanced;
  }

  async enhanceMarkdownView(view, sourcePath, options = {}) {
    if (!sourcePath) return false;
    const root = view?.contentEl?.querySelector?.(".markdown-preview-view")
      || view?.containerEl?.querySelector?.(".markdown-preview-view");
    if (!root) return false;
    const target = root.querySelector(".markdown-preview-sizer") || root;
    const hasExistingSurface = target.querySelector(".inkloop-visual-block");
    if (hasExistingSurface && options.force !== true) {
      this.applySurfaceModeToRoot(root);
      return true;
    }
    if (hasExistingSurface) this.resetEnhancedPreview(target);
    delete target.dataset.inkloopVisualEnhanced;
    await this.enhancePreview(target, { sourcePath });
    return target.querySelector(".inkloop-visual-block") !== null;
  }

  async refreshOpenInkLoopPreviews() {
    if (!this.settings.visualEnhancement || this.refreshPreviewsRunning) return;
    this.refreshPreviewsRunning = true;
    try {
      const leaves = this.app.workspace.getLeavesOfType?.("markdown") || [];
      for (const leaf of leaves) {
        const view = leaf.view;
        const file = view?.file;
        if (!file?.path) continue;
        const docId = await this.docIdForPath(file.path);
        if (!docId) continue;
        const runtime = await this.loadRuntimeDocument(docId);
        if (!runtime) continue;
        const nextSignature = runtimeSignature(runtime);
        const previousSignature = this.previewSignatures.get(file.path);
        if (previousSignature === undefined) {
          this.previewSignatures.set(file.path, nextSignature);
          this.requestMarkdownPreviewRerender(view, file.path, { force: true });
          continue;
        }
        if (previousSignature === nextSignature) continue;
        this.previewSignatures.set(file.path, nextSignature);
        this.requestMarkdownPreviewRerender(view, file.path, { force: true });
      }
    } finally {
      this.refreshPreviewsRunning = false;
    }
  }

  async rememberDocPreviewSignature(docId, runtime = null) {
    const nextRuntime = runtime || await this.loadRuntimeDocument(docId);
    if (!nextRuntime) return;
    const signature = runtimeSignature(nextRuntime);
    const leaves = this.app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of leaves) {
      const file = leaf.view?.file;
      if (!file?.path) continue;
      const leafDocId = await this.docIdForPath(file.path);
      if (leafDocId === docId) this.previewSignatures.set(file.path, signature);
    }
  }

  async refreshDocPreview(docId) {
    const sourcePath = await this.sourcePathForDocId(docId).catch(() => null);
    const leaves = this.app.workspace.getLeavesOfType?.("markdown") || [];
    for (const leaf of leaves) {
      const view = leaf.view;
      const file = view?.file;
      if (!file?.path) continue;
      const leafDocId = await this.docIdForPath(file.path);
      if (leafDocId !== docId && file.path !== sourcePath) continue;
      this.previewSignatures.delete(file.path);
      this.requestMarkdownPreviewRerender(view, file.path, { force: true });
    }
  }

  markPreviewRoot(el) {
    const root = el.closest(".markdown-preview-view");
    root?.addClass?.("inkloop-native-preview-root");
    if (root) this.applySurfaceModeToRoot(root);
    for (const selector of [
      ".metadata-container",
      ".metadata-properties",
      ".metadata-content",
      ".metadata-add-button",
      ".metadata-properties-heading",
      ".frontmatter-container",
      ".inline-title",
    ]) {
      for (const node of root?.querySelectorAll(selector) ?? []) node.addClass?.("inkloop-native-hidden");
    }
  }

  installModeControl(el) {
    const root = el.closest(".markdown-preview-view") || el;
    if (root.querySelector(".inkloop-surface-controls")) return;
    const controls = document.createElement("div");
    controls.className = "inkloop-surface-controls";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inkloop-mode-toggle";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.toggleSurfaceMode();
    });
    controls.appendChild(button);
    const tools = document.createElement("div");
    tools.className = "inkloop-tool-switch";
    const toolLabels = [
      ["text", "文本"],
      ["pen", "铅笔"],
      ["highlighter", "高亮"],
    ];
    for (const [tool, label] of toolLabels) {
      const toolButton = document.createElement("button");
      toolButton.type = "button";
      toolButton.className = "inkloop-tool-btn";
      toolButton.dataset.tool = tool;
      toolButton.textContent = label;
      toolButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.setInkTool(tool);
      });
      tools.appendChild(toolButton);
    }
    controls.appendChild(tools);
    const colors = document.createElement("div");
    colors.className = "inkloop-color-row";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "inkloop-color-input";
    colorInput.setAttribute("aria-label", "标注颜色");
    colorInput.addEventListener("input", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.setInkColor(event.currentTarget.value);
    });
    const swatches = document.createElement("div");
    swatches.className = "inkloop-color-swatches";
    for (const color of INK_SWATCHES) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "inkloop-color-swatch";
      swatch.dataset.color = color;
      swatch.style.setProperty("--inkloop-swatch-color", color);
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-label", `选择 ${color}`);
      swatch.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.setInkColor(color);
      });
      swatches.appendChild(swatch);
    }
    colors.append(colorInput, swatches);
    controls.appendChild(colors);
    el.prepend(controls);
    this.applySurfaceModeToRoot(root);
  }

  hideAnnotationFallback(el) {
    for (const strong of el.querySelectorAll("strong")) {
      if (this.surfaceSdk.normalizeText(strong.textContent) !== "InkLoop annotations") continue;
      const container = strong.closest("p") || strong.parentElement;
      const next = container?.nextElementSibling;
      container?.addClass?.("inkloop-fallback-hidden");
      if (next?.tagName === "UL") next.addClass?.("inkloop-fallback-hidden");
    }
  }

  hideDuplicateDocumentTitle(el, model) {
    const firstHeading = model.blocks.find((block) => block.kind === "heading" || String(block.content || "").startsWith("#"));
    if (this.surfaceSdk.normalizeText(firstHeading?.content) !== this.surfaceSdk.normalizeText(model.documentTitle)) return;
    const root = el.closest(".markdown-preview-view") || el;
    const hide = () => {
      const headings = [...root.querySelectorAll("h1")]
        .filter((heading) => this.surfaceSdk.normalizeText(heading.textContent) === this.surfaceSdk.normalizeText(model.documentTitle));
      if (headings.length <= 1) return;
      const documentHeading = headings.find((heading) => !heading.closest(".inkloop-visual-block"));
      (documentHeading || headings[0])?.addClass?.("inkloop-native-hidden");
    };
    hide();
    window.requestAnimationFrame?.(hide);
    window.setTimeout(hide, 0);
  }

  findBlockElement(el, block, used) {
    const text = this.surfaceSdk.normalizeText(block.content);
    if (!text) return null;
    const firstLine = text.slice(0, Math.min(90, text.length));
    const candidates = [...el.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, h5, h6")]
      .filter((candidate) => !used.has(candidate) && !candidate.closest(".inkloop-visual-block") && !candidate.closest(".inkloop-annotation-fallback"));
    return candidates.find((candidate) => this.surfaceSdk.normalizeText(candidate.textContent).includes(firstLine))
      || candidates.find((candidate) => firstLine.includes(this.surfaceSdk.normalizeText(candidate.textContent).slice(0, 60)))
      || null;
  }

  decorateBlock(target, block, docId = null) {
    const wrapper = document.createElement("section");
    wrapper.className = `inkloop-visual-block${block.annotations.length ? "" : " is-plain"}${isPreviewEditable(block) ? " is-preview-editable" : ""}`;
    wrapper.dataset.blockId = block.id;
    wrapper.dataset.annotationKinds = block.annotations.map((annotation) => annotation.kind).join(" ");
    wrapper.dataset.editable = isPreviewEditable(block) ? "true" : "false";
    const parent = target.parentNode;
    if (!parent) return;
    parent.insertBefore(wrapper, target);
    const contentPlane = document.createElement("div");
    contentPlane.className = "inkloop-content-plane";
    contentPlane.appendChild(target);
    const markLayer = this.surfaceSdk.renderMarkLayer(block, document);
    const notes = this.surfaceSdk.renderMarginNotes(block, document);
    if (markLayer) contentPlane.appendChild(markLayer);
    wrapper.appendChild(contentPlane);
    if (notes) wrapper.appendChild(notes);
    if (docId) this.installNativeBlockInteractions(wrapper, block, docId);
  }

  blockContentElement(wrapper) {
    return wrapper.querySelector(".inkloop-content-plane > :is(p, h1, h2, h3, h4, h5, h6, li, blockquote)");
  }

  installNativeBlockInteractions(wrapper, block, docId) {
    const content = this.blockContentElement(wrapper);
    if (content && isPreviewEditable(block)) {
      const canEditText = this.surfaceMode() === "thinking" && this.inkTool() === "text";
      content.contentEditable = canEditText ? "true" : "false";
      content.spellcheck = canEditText;
      const save = () => {
        if (this.surfaceMode() !== "thinking" || this.inkTool() !== "text") return;
        const key = `${docId}:${block.id}`;
        const existing = this.nativeEditTimers.get(key);
        if (existing) window.clearTimeout(existing);
        this.nativeEditTimers.set(key, window.setTimeout(async () => {
          this.nativeEditTimers.delete(key);
          wrapper.addClass?.("is-saving");
          try {
            await this.updateMarkdownBlockContent(docId, block.id, markdownForEditableBlock(block, content.innerText));
          } catch (error) {
            new Notice(`InkLoop text save failed: ${String(error?.message || error)}`);
          } finally {
            window.setTimeout(() => wrapper.removeClass?.("is-saving"), 450);
          }
        }, 650));
      };
      content.addEventListener("input", save);
      content.addEventListener("blur", save);
    }

    for (const annotation of block.annotations || []) {
      const note = wrapper.querySelector(`.inkloop-margin-note[data-ko-id="${CSS.escape(annotation.ko_id)}"]`);
      if (!note) continue;
      note.tabIndex = 0;
      note.addEventListener("click", (event) => {
        if (this.surfaceMode() !== "thinking") return;
        event.preventDefault();
        event.stopPropagation();
        this.openNativeAnnotationEditor(note, annotation, docId);
      });
      note.addEventListener("keydown", (event) => {
        if (this.surfaceMode() !== "thinking") return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.openNativeAnnotationEditor(note, annotation, docId);
      });
    }

    this.installNativeFreehand(wrapper, block, docId);
  }

  renderNativeAnnotationDisplay(note, annotation, docId) {
    note.replaceChildren();
    note.removeClass?.("is-editing");
    const label = document.createElement("div");
    label.className = "inkloop-margin-note-kind";
    label.textContent = String(annotation.kind || "annotation").replace(/_/g, " ");
    const title = document.createElement("div");
    title.className = "inkloop-margin-note-title";
    title.textContent = annotation.title || "";
    note.append(label, title);
    const body = previewText(annotation);
    if (body && body !== annotation.title) {
      const excerpt = document.createElement("div");
      excerpt.className = "inkloop-margin-note-body";
      excerpt.textContent = body;
      note.appendChild(excerpt);
    }
    note.onclick = (event) => {
      if (this.surfaceMode() !== "thinking") return;
      event.preventDefault();
      event.stopPropagation();
      this.openNativeAnnotationEditor(note, annotation, docId);
    };
  }

  openNativeAnnotationEditor(note, annotation, docId) {
    if (note.classList.contains("is-editing")) return;
    note.replaceChildren();
    note.addClass?.("is-editing");
    const title = document.createElement("input");
    title.className = "inkloop-annotation-field";
    title.value = annotation.title || "";
    const body = document.createElement("textarea");
    body.className = "inkloop-annotation-field inkloop-annotation-textarea";
    body.value = annotation.body_md || "";
    const actions = document.createElement("div");
    actions.className = "inkloop-annotation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "inkloop-annotation-action";
    cancel.textContent = "取消";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "inkloop-annotation-action is-primary";
    save.textContent = "保存";
    actions.append(cancel, save);
    note.append(title, body, actions);
    cancel.onclick = (event) => {
      event.preventDefault();
      this.renderNativeAnnotationDisplay(note, annotation, docId);
    };
    save.onclick = async (event) => {
      event.preventDefault();
      const patch = { title: title.value, body_md: body.value };
      try {
        await this.updateSidecarAnnotation(docId, annotation.ko_id, patch);
        Object.assign(annotation, patch);
        this.renderNativeAnnotationDisplay(note, annotation, docId);
      } catch (error) {
        new Notice(`InkLoop annotation save failed: ${String(error?.message || error)}`);
      }
    };
    title.focus();
  }

  ensureNativeMarkLayer(contentPlane) {
    let layer = contentPlane.querySelector(".inkloop-mark-layer");
    if (layer) return layer;
    layer = createSvgElement("svg");
    layer.setAttribute("class", "inkloop-mark-layer");
    layer.setAttribute("viewBox", "0 0 100 100");
    layer.setAttribute("preserveAspectRatio", "none");
    layer.setAttribute("aria-hidden", "true");
    contentPlane.appendChild(layer);
    return layer;
  }

  nativePoint(event, rect, t0) {
    return {
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
      t: Math.round(performance.now() - t0),
      pressure: event.pressure || 0,
    };
  }

  installNativeFreehand(wrapper, block, docId) {
    const contentPlane = wrapper.querySelector(".inkloop-content-plane");
    if (!contentPlane) return;
    let active = null;
    const canDraw = (event) => {
      if (active) return false;
      if (this.surfaceMode() !== "thinking") return false;
      const tool = this.inkTool();
      if (!isStrokeTool(tool)) return false;
      if (event.button !== 0 && event.pointerType !== "pen" && event.pointerType !== "touch") return false;
      if (event.target.closest?.("button, input, textarea, select, a, .inkloop-margin-note")) return false;
      return true;
    };
    const move = (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      const next = this.nativePoint(event, active.rect, active.t0);
      const last = active.points[active.points.length - 1];
      if (Math.hypot(next.x - last.x, next.y - last.y) < 0.004) return;
      active.points.push(next);
      active.path.setAttribute("d", active.points.map((point, index) => `${index === 0 ? "M" : "L"}${(point.x * 100).toFixed(2)},${(point.y * 100).toFixed(2)}`).join(" "));
    };
    const finish = async (event) => {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      const stroke = active;
      active = null;
      if (stroke.points.length < 2) {
        stroke.path.remove();
        return;
      }
      const tool = stroke.tool || "pen";
      const color = stroke.color || this.inkColor(tool);
      const opacity = stroke.opacity ?? this.inkOpacity(tool);
      const annotation = {
        ko_id: localId("ko"),
        kind: tool === "highlighter" ? "excerpt" : "annotation",
        title: `${tool === "highlighter" ? "Highlight" : "Hand mark"} ${new Date().toLocaleTimeString()}`,
        body_md: "",
        render_mode: "stroke_only",
        visual_bbox: bboxOfPoints(stroke.points),
        visual_strokes: [{ tool, color, opacity, points: stroke.points }],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      try {
        await this.addSidecarAnnotation(docId, block.id, annotation);
      } catch (error) {
        stroke.path.remove();
        new Notice(`InkLoop handwriting save failed: ${String(error?.message || error)}`);
      }
    };
    wrapper.addEventListener("pointerdown", (event) => {
      if (!canDraw(event)) return;
      const tool = this.inkTool();
      const rect = contentPlane.getBoundingClientRect();
      const layer = this.ensureNativeMarkLayer(contentPlane);
      const path = createSvgElement("path");
      path.setAttribute("class", `inkloop-mark-freehand is-${tool}`);
      path.setAttribute("stroke", this.inkColor(tool));
      path.setAttribute("stroke-opacity", String(this.inkOpacity(tool)));
      const t0 = performance.now();
      const point = this.nativePoint(event, rect, t0);
      path.setAttribute("d", `M${(point.x * 100).toFixed(2)},${(point.y * 100).toFixed(2)}`);
      layer.appendChild(path);
      active = { pointerId: event.pointerId, rect, t0, points: [point], path, tool, color: this.inkColor(tool), opacity: this.inkOpacity(tool) };
      wrapper.setPointerCapture?.(event.pointerId);
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

};

class InkLoopDocumentView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = { mode: "preview" };
    this.activeStroke = null;
  }

  getViewType() {
    return INKLOOP_VIEW_TYPE;
  }

  getDisplayText() {
    return this.runtime?.document?.title || "InkLoop";
  }

  getIcon() {
    return "pen-line";
  }

  async setState(state, result) {
    await super.setState(state, result);
    this.state = { mode: "preview", ...state };
    await this.render();
  }

  getState() {
    return this.state;
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const docId = this.state.doc_id;
    const root = this.contentEl;
    root.empty();
    root.addClass("inkloop-runtime-view");
    root.addClass("inkloop-surface-root");
    if (!docId) {
      root.createEl("p", { text: "Open a Markdown or PDF file with InkLoop." });
      return;
    }

    this.runtime = await this.plugin.loadRuntimeDocument(docId);
    if (!this.runtime) {
      root.createEl("p", { text: "InkLoop sidecar document is missing." });
      return;
    }

    this.state.mode = "preview";
    const workspace = root.createDiv({ cls: `inkloop-runtime-workspace is-${this.state.mode}` });
    if (this.runtime.document.source_type === "pdf") await this.renderPdf(workspace);
    else await this.renderMarkdown(workspace);
  }

  sourcePath() {
    return this.runtime?.source?.vault_file?.path || this.state.source_path;
  }

  async renderMarkdown(workspace) {
    const model = this.visualModel();

    if (this.state.mode === "edit") {
      const canvas = workspace.createDiv({ cls: "inkloop-runtime-canvas" });
      const source = canvas.createDiv({ cls: "inkloop-runtime-canvas-source" });
      source.appendChild(this.plugin.surfaceSdk.renderInkLoopVisualModel(model, document));
      const layer = canvas.createDiv({ cls: "inkloop-runtime-canvas-layer" });
      this.renderCanvasNodes(layer);
      this.installCanvasInk(layer);
      this.installTypedText(layer);
      return;
    }

    const source = workspace.createDiv({ cls: "inkloop-runtime-source" });
    source.appendChild(this.plugin.surfaceSdk.renderInkLoopVisualModel(model, document));
  }

  async renderPdf(workspace) {
    const sourcePath = this.sourcePath();
    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    const shell = workspace.createDiv({ cls: "inkloop-runtime-pdf-shell" });
    if (!file) {
      shell.createEl("p", { text: "PDF source is missing." });
      return;
    }
    const src = this.plugin.app.vault.getResourcePath(file);
    shell.createEl("embed", { cls: "inkloop-runtime-pdf", attr: { src, type: "application/pdf" } });
    const gutter = shell.createDiv({ cls: "inkloop-runtime-gutter" });
    gutter.createDiv({ cls: "inkloop-margin-note-kind", text: "PDF" });
    if (this.state.mode === "edit") {
      const layer = shell.createDiv({ cls: "inkloop-runtime-canvas-layer" });
      this.renderCanvasNodes(layer);
      this.installCanvasInk(layer);
      this.installTypedText(layer);
    }
  }

  decorateMarkdown(root) {
    const used = new Set();
    for (const rawBlock of this.runtime.blocks) {
      const block = this.plugin.sidecarBlockToVisualBlock(rawBlock);
      const target = this.plugin.findBlockElement(root, block, used);
      if (!target) continue;
      used.add(target);
      this.plugin.decorateBlock(target, block);
    }
  }

  visualModel() {
    return {
      documentTitle: this.runtime.document.title,
      blocks: this.runtime.blocks.map((block) => this.plugin.sidecarBlockToVisualBlock(block)),
    };
  }

  renderCanvasNodes(layer) {
    for (const node of this.runtime.nodes || []) {
      if (node.deleted_at) continue;
      if (node.kind === "ink_stroke") this.renderInkNode(layer, node);
      if (node.kind === "typed_text") this.renderTextNode(layer, node);
    }
  }

  renderInkNode(layer, node) {
    const svg = createSvgElement("svg");
    svg.setAttribute("class", "inkloop-runtime-node inkloop-runtime-ink-node");
    svg.style.left = `${node.frame?.x || 0}px`;
    svg.style.top = `${node.frame?.y || 0}px`;
    svg.style.width = `${Math.max(1, node.frame?.w || 1)}px`;
    svg.style.height = `${Math.max(1, node.frame?.h || 1)}px`;
    svg.setAttribute("viewBox", `0 0 ${Math.max(1, node.frame?.w || 1)} ${Math.max(1, node.frame?.h || 1)}`);
    const points = node.payload?.points || [];
    if (points.length > 1) {
      const path = createSvgElement("path");
      path.setAttribute("class", "inkloop-runtime-ink-path");
      path.setAttribute("d", points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x - (node.frame?.x || 0)},${point.y - (node.frame?.y || 0)}`).join(" "));
      if (node.payload?.color) path.setAttribute("stroke", node.payload.color);
      if (node.payload?.opacity !== undefined) path.setAttribute("stroke-opacity", String(node.payload.opacity));
      svg.appendChild(path);
    }
    layer.appendChild(svg);
  }

  renderTextNode(layer, node) {
    const el = layer.createDiv({ cls: "inkloop-runtime-node inkloop-runtime-text-node" });
    el.style.left = `${node.frame?.x || 0}px`;
    el.style.top = `${node.frame?.y || 0}px`;
    el.style.width = `${node.frame?.w || 260}px`;
    el.textContent = node.payload?.body_md || "";
  }

  canvasPoint(event, layer) {
    const rect = layer.getBoundingClientRect();
    return { x: event.clientX - rect.left + layer.scrollLeft, y: event.clientY - rect.top + layer.scrollTop, t: Date.now(), pressure: event.pressure || 0.5 };
  }

  installCanvasInk(layer) {
    layer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest?.(".inkloop-runtime-text-node")) return;
      layer.setPointerCapture?.(event.pointerId);
      const point = this.canvasPoint(event, layer);
      const svg = createSvgElement("svg");
      svg.setAttribute("class", "inkloop-runtime-live-ink");
      svg.style.left = "0px";
      svg.style.top = "0px";
      svg.style.width = "100%";
      svg.style.height = "100%";
      const path = createSvgElement("path");
      path.setAttribute("class", "inkloop-runtime-ink-path");
      path.setAttribute("stroke", this.plugin.inkColor("pen"));
      path.setAttribute("stroke-opacity", String(this.plugin.inkOpacity("pen")));
      svg.appendChild(path);
      layer.appendChild(svg);
      this.activeStroke = { points: [point], svg, path, color: this.plugin.inkColor("pen"), opacity: this.plugin.inkOpacity("pen") };
      event.preventDefault();
    });
    layer.addEventListener("pointermove", (event) => {
      if (!this.activeStroke) return;
      const point = this.canvasPoint(event, layer);
      this.activeStroke.points.push(point);
      this.activeStroke.path.setAttribute("d", this.activeStroke.points.map((item, index) => `${index === 0 ? "M" : "L"}${item.x},${item.y}`).join(" "));
    });
    const finish = async () => {
      if (!this.activeStroke) return;
      const stroke = this.activeStroke;
      this.activeStroke = null;
      if (stroke.points.length < 2) {
        stroke.svg.remove();
        return;
      }
      const xs = stroke.points.map((point) => point.x);
      const ys = stroke.points.map((point) => point.y);
      const frame = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs) || 1,
        h: Math.max(...ys) - Math.min(...ys) || 1,
      };
      const node = {
        schema_version: "inkloop.canvas_node.v1",
        node_id: `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        doc_id: this.runtime.document.doc_id,
        canvas_id: `canvas_${this.runtime.document.doc_id.replace(/^doc_/, "")}`,
        layer_id: "layer_ink",
        kind: "ink_stroke",
        frame,
        payload: { type: "ink_stroke", tool: "pen", color: stroke.color, opacity: stroke.opacity, points: stroke.points },
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      await this.plugin.appendJsonLine(`${this.runtime.docDir}/canvas/nodes.jsonl`, node);
    };
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  installTypedText(layer) {
    layer.addEventListener("dblclick", (event) => {
      const point = this.canvasPoint(event, layer);
      const editor = layer.createDiv({ cls: "inkloop-runtime-node inkloop-runtime-text-node is-editing" });
      editor.contentEditable = "true";
      editor.style.left = `${point.x}px`;
      editor.style.top = `${point.y}px`;
      editor.style.width = "280px";
      editor.textContent = "";
      const save = async () => {
        const body = editor.innerText.trim();
        editor.contentEditable = "false";
        editor.removeClass?.("is-editing");
        if (!body) {
          editor.remove();
          return;
        }
        const node = {
          schema_version: "inkloop.canvas_node.v1",
          node_id: `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          doc_id: this.runtime.document.doc_id,
          canvas_id: `canvas_${this.runtime.document.doc_id.replace(/^doc_/, "")}`,
          layer_id: "layer_typed_text",
          kind: "typed_text",
          frame: { x: point.x, y: point.y, w: 280, h: Math.max(48, editor.getBoundingClientRect().height) },
          payload: { type: "typed_text", body_md: body, text_role: "free_note", commit_target: { type: "sidecar_only" } },
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        await this.plugin.appendJsonLine(`${this.runtime.docDir}/canvas/nodes.jsonl`, node);
        await this.plugin.appendRuntimeSyncEvent({
          doc_id: this.runtime.document.doc_id,
          operation: "canvas.node.add",
          target: { type: "canvas_node", id: node.node_id },
          payload: { node },
        });
      };
      editor.addEventListener("blur", () => void save(), { once: true });
      editor.focus();
      event.preventDefault();
    });
  }
}

class InkLoopSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.replaceChildren();
    containerEl.createEl("h2", { text: "InkLoop Sync" });

    new Setting(containerEl)
      .setName("Documents directory")
      .setDesc("Visible vault directory containing InkLoop Markdown documents opened with Obsidian's native editor and preview.")
      .addText((text) => text
        .setPlaceholder("InkLoop")
        .setValue(this.plugin.settings.documentsDir)
        .onChange(async (value) => {
          this.plugin.settings.documentsDir = cleanDir(value, DEFAULT_SETTINGS.documentsDir);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Adapter data directory")
      .setDesc("Hidden directory for InkLoop bindings, state, notes, tasks, and sync outbox files.")
      .addText((text) => text
        .setPlaceholder(".inkloop")
        .setValue(this.plugin.settings.baseDir)
        .onChange(async (value) => {
          this.plugin.settings.baseDir = cleanDir(value, DEFAULT_SETTINGS.baseDir);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Sync endpoint")
      .setDesc("Local or cloud endpoint called when InkLoop documents change.")
      .addText((text) => text
        .setPlaceholder("http://127.0.0.1:8765/api/obsidian-lab/pull")
        .setValue(this.plugin.settings.syncEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.syncEndpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auto-sync on change")
      .setDesc("Call the sync endpoint after Obsidian saves, renames, or deletes InkLoop files.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSyncOnChange)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncOnChange = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Visual preview enhancements")
      .setDesc("Render InkLoop highlights, boxes, handwriting marks, and margin notes in Obsidian reading mode.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.visualEnhancement)
        .onChange(async (value) => {
          this.plugin.settings.visualEnhancement = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Debounce")
      .setDesc("Milliseconds to wait after a file event before syncing.")
      .addText((text) => text
        .setPlaceholder("750")
        .setValue(String(this.plugin.settings.debounceMs))
        .onChange(async (value) => {
          this.plugin.settings.debounceMs = Math.max(100, Number(value) || DEFAULT_SETTINGS.debounceMs);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Manual sync notices")
      .setDesc("Show a notice when Sync InkLoop now is run from the command palette.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.notifyManualSync)
        .onChange(async (value) => {
          this.plugin.settings.notifyManualSync = value;
          await this.plugin.saveSettings();
        }));
  }
}
