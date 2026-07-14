const { ItemView, Notice, Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const INKLOOP_VIEW_TYPE = "inkloop-runtime-view";

const DEFAULT_SETTINGS = {
  baseDir: ".inkloop",
  documentsDir: "InkLoop",
  syncEndpoint: "",
  runtimePushEndpoint: "http://127.0.0.1:8731/v1/runtime/events:push",
  runtimePullEndpoint: "http://127.0.0.1:8731/v1/runtime/events:pull",
  knowledgeBaseEndpoint: "http://127.0.0.1:8731/v1/knowledge",
  deviceCommandEndpoint: "http://127.0.0.1:8731/v1/devices/commands",
  tenantId: "local",
  userId: "local_demo",
  sessionToken: "",
  deviceId: "obsidian-plugin",
  autoSyncOnChange: true,
  debounceMs: 120,
  runtimePollMs: 500,
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

function randomRuntimeDeviceId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${String(random).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function normalizeRuntimeDeviceId(input, prefix) {
  const value = String(input || "").trim();
  if (!value || value === DEFAULT_SETTINGS.deviceId) return randomRuntimeDeviceId(prefix);
  return value;
}

function cleanRuntimeNamespaceSegment(input, fallback) {
  const value = String(input || "").trim();
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) return fallback;
  return value;
}

function runtimeNamespaceHeaders(settings) {
  const headers = {
    "x-inkloop-tenant-id": settings.tenantId || DEFAULT_SETTINGS.tenantId,
    "x-inkloop-user-id": settings.userId || DEFAULT_SETTINGS.userId,
  };
  const token = String(settings.sessionToken || "").trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function cleanEndpoint(input) {
  return String(input || "").trim().replace(/\/+$/, "");
}

function appendPath(base, path) {
  const cleanBase = cleanEndpoint(base);
  if (!cleanBase) return "";
  return `${cleanBase}/${String(path || "").replace(/^\/+/, "")}`;
}

function deriveDeviceCommandEndpoint(settings) {
  const explicit = cleanEndpoint(settings.deviceCommandEndpoint);
  if (explicit) return explicit;
  const knowledge = cleanEndpoint(settings.knowledgeBaseEndpoint);
  const suffix = "/v1/knowledge";
  if (knowledge.endsWith(suffix)) return `${knowledge.slice(0, -suffix.length)}/v1/devices/commands`;
  return DEFAULT_SETTINGS.deviceCommandEndpoint;
}

const DEFAULT_INK_OPACITY = {
  pen: 0.92,
  highlighter: 0.56,
};

const INK_SWATCHES = ["#38bdf8", "#f8fafc", "#111827", "#facc15", "#fb7185", "#34d399"];
const CONTROLLED_FIELDS_MARKER = "<!-- inkloop:controlled-fields v1 -->";
const KNOWLEDGE_STATUSES = new Set(["inbox", "accepted", "edited", "follow_up", "dismissed", "export_ready", "exported", "archived"]);
const RISK_STATUSES = new Set(["open", "watching", "mitigated", "closed"]);

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

function cleanLegacySyncEndpoint(input) {
  const value = String(input || "").trim();
  return value === "http://127.0.0.1:8765/api/obsidian-lab/pull" ? "" : value;
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

function unquoteYamlScalar(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}

function parseProjectionFrontmatter(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return {};
  const out = {};
  let listKey = null;
  for (const line of normalized.slice(4, end).split("\n")) {
    const list = line.match(/^\s*-\s*(.+?)\s*$/);
    if (listKey && list) {
      out[listKey] = Array.isArray(out[listKey]) ? out[listKey] : [];
      out[listKey].push(unquoteYamlScalar(list[1]));
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!entry) {
      listKey = null;
      continue;
    }
    const key = entry[1];
    const raw = entry[2] || "";
    if (!raw.trim()) {
      out[key] = [];
      listKey = key;
    } else {
      out[key] = unquoteYamlScalar(raw);
      listKey = null;
    }
  }
  return out;
}

function controlledSection(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  const markerIndex = normalized.indexOf(CONTROLLED_FIELDS_MARKER);
  if (markerIndex === -1) return "";
  const afterMarker = normalized.slice(markerIndex + CONTROLLED_FIELDS_MARKER.length);
  const nextHeading = afterMarker.search(/\n##\s+/);
  return (nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading)).trim();
}

function controlledLineValue(section, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`^\\s*-\\s*${escaped}:\\s*(.*)$`, "im"));
  return match ? match[1].trim() : undefined;
}

function controlledTaskDone(section) {
  const match = section.match(/^\s*-\s*\[([ xX])\]\s*Task done\s*$/im);
  return match ? match[1].toLowerCase() === "x" : undefined;
}

function parseTagsLine(input) {
  if (input === undefined) return undefined;
  return String(input).split(",").map((item) => item.trim()).filter(Boolean);
}

function controlledPatchFromSection(section) {
  if (!section) return null;
  const patch = {};
  const status = controlledLineValue(section, "Status");
  const tags = parseTagsLine(controlledLineValue(section, "Tags"));
  const taskDone = controlledTaskDone(section);
  const riskStatus = controlledLineValue(section, "Risk status");
  const riskNote = controlledLineValue(section, "Risk note");
  const comment = controlledLineValue(section, "Comment");
  if (KNOWLEDGE_STATUSES.has(status)) patch.status = status;
  if (tags?.length) patch.tags = tags;
  if (taskDone !== undefined) patch.task_done = taskDone;
  if (RISK_STATUSES.has(riskStatus)) patch.risk_status = riskStatus;
  if (riskNote !== undefined) patch.risk_note = riskNote.trim();
  if (comment !== undefined) patch.comment_md = comment.trim();
  return Object.keys(patch).length ? patch : null;
}

function buildControlledKnowledgeEdit({ documentId, documentUri, koId, kind, section }) {
  if (!documentId || !koId || !kind) return null;
  const patch = controlledPatchFromSection(section);
  if (!patch) return null;
  return {
    schema_version: "inkloop.obsidian_controlled_knowledge_edit.v1",
    document_id: documentId,
    document_uri: documentUri,
    ko_id: koId,
    kind,
    patch,
    source: "obsidian_controlled_fields",
  };
}

function inlineKoAttributes(input) {
  const attrs = {};
  for (const match of String(input || "").matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g)) {
    attrs[match[1]] = unescapeHtml(match[2]);
  }
  return attrs;
}

function parseControlledKnowledgeEdit(markdown) {
  const front = parseProjectionFrontmatter(markdown);
  const section = controlledSection(markdown);
  return buildControlledKnowledgeEdit({
    documentId: typeof front.inkloop_document_id === "string" ? front.inkloop_document_id : "",
    documentUri: typeof front.inkloop_document_uri === "string" ? front.inkloop_document_uri : undefined,
    koId: typeof front.inkloop_knowledge_object_id === "string" ? front.inkloop_knowledge_object_id : "",
    kind: typeof front.inkloop_knowledge_kind === "string" ? front.inkloop_knowledge_kind : "",
    section,
  });
}

function parseControlledKnowledgeEdits(markdown) {
  const edits = [];
  const frontEdit = parseControlledKnowledgeEdit(markdown);
  if (frontEdit) edits.push(frontEdit);
  const front = parseProjectionFrontmatter(markdown);
  const fallbackDocumentId = typeof front.inkloop_document_id === "string" ? front.inkloop_document_id : "";
  const fallbackDocumentUri = typeof front.inkloop_document_uri === "string" ? front.inkloop_document_uri : undefined;
  const seen = new Set(edits.map((edit) => `${edit.document_id}::${edit.ko_id}`));
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  for (const match of normalized.matchAll(/<!--\s*inkloop:begin-ko\s+([^>]*)-->([\s\S]*?)<!--\s*inkloop:end-ko\s*-->/g)) {
    const attrs = inlineKoAttributes(match[1]);
    const edit = buildControlledKnowledgeEdit({
      documentId: attrs.document_id || fallbackDocumentId,
      documentUri: attrs.document_uri || fallbackDocumentUri,
      koId: attrs.ko_id || "",
      kind: attrs.kind || "",
      section: controlledSection(match[2]),
    });
    if (!edit) continue;
    const key = `${edit.document_id}::${edit.ko_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edits.push(edit);
  }
  return edits;
}

function isCloudKnowledgeProjectionMarkdown(markdown) {
  const front = parseProjectionFrontmatter(markdown);
  const hasDocumentId = typeof front.inkloop_document_id === "string" && front.inkloop_document_id.length > 0;
  return hasDocumentId && (
    front.inkloop_projection_role === "source_file_unit"
    || typeof front.inkloop_knowledge_object_id === "string"
    || String(markdown || "").includes("<!-- inkloop:begin-ko ")
  );
}

function controlledKnowledgeSignatureKey(filePath, edit) {
  return `${filePath}::${edit.document_id}::${edit.ko_id}`;
}

function controlledKnowledgeSignature(edit) {
  return JSON.stringify({ document_id: edit.document_id, ko_id: edit.ko_id, patch: edit.patch });
}

function rememberControlledKnowledgeSignatures(signatures, filePath, markdown) {
  const edits = parseControlledKnowledgeEdits(markdown);
  for (const edit of edits) {
    signatures.set(controlledKnowledgeSignatureKey(filePath, edit), controlledKnowledgeSignature(edit));
  }
  return edits.length;
}

function controlledKnowledgeEditsSinceBaseline(signatures, filePath, markdown) {
  const changed = [];
  for (const edit of parseControlledKnowledgeEdits(markdown)) {
    const key = controlledKnowledgeSignatureKey(filePath, edit);
    const signature = controlledKnowledgeSignature(edit);
    const previousSignature = signatures.get(key);
    if (previousSignature === signature) continue;
    changed.push({ edit, key, signature, previousSignature });
  }
  return changed;
}

function beginControlledKnowledgeEdit(signatures, change) {
  signatures.set(change.key, change.signature);
}

function rollbackControlledKnowledgeEdit(signatures, change) {
  if (signatures.get(change.key) !== change.signature) return;
  if (change.previousSignature === undefined) signatures.delete(change.key);
  else signatures.set(change.key, change.previousSignature);
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

function appendQuery(endpoint, params) {
  const [withoutHash, hash] = String(endpoint || "").split("#", 2);
  const [base, query] = withoutHash.split("?", 2);
  const search = new URLSearchParams(query || "");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const nextQuery = search.toString();
  return `${base}${nextQuery ? `?${nextQuery}` : ""}${hash ? `#${hash}` : ""}`;
}

function parseRuntimeTime(input) {
  const value = Date.parse(String(input || ""));
  return Number.isFinite(value) ? value : 0;
}

function nextRuntimeRetryAt(now, retryDelayMs = 2000) {
  return new Date(parseRuntimeTime(now) + retryDelayMs).toISOString();
}

function shouldAttemptRuntimeEvent(event, now, maxAttempts = 5) {
  if (event.status === "sent") return false;
  if ((event.attempt_count || 0) >= maxAttempts) return false;
  if (event.status === "failed" && event.next_retry_at && parseRuntimeTime(event.next_retry_at) > parseRuntimeTime(now)) return false;
  return event.status === "pending" || event.status === "failed" || !event.status;
}

function normalizeRuntimePollMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.runtimePollMs;
  return Math.max(0, Math.round(parsed));
}

function isRuntimeAck(value) {
  return !!value && typeof value === "object" && typeof value.event_id === "string" && typeof value.ok === "boolean";
}

function mergeRuntimeOutboxEvents(latestEvents, updatedEvents) {
  const updatedById = new Map(updatedEvents.map((event) => [event.event_id, event]));
  const seen = new Set();
  const merged = latestEvents.map((event) => {
    seen.add(event.event_id);
    return updatedById.get(event.event_id) || event;
  });
  for (const event of updatedEvents) {
    if (!seen.has(event.event_id)) merged.push(event);
  }
  return merged;
}

function assertRuntimePullPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Runtime sync pull response must be an object.");
  if (payload.schema_version !== "inkloop.runtime_sync_pull.v1") throw new Error("Runtime sync pull response has an unsupported schema_version.");
  if (!Array.isArray(payload.events)) throw new Error("Runtime sync pull response must include events.");
  if (typeof payload.next_cursor !== "string") throw new Error("Runtime sync pull response must include next_cursor.");
  for (const event of payload.events) {
    if (!event || typeof event !== "object" || typeof event.event_id !== "string" || typeof event.doc_id !== "string" || event.schema_version !== "inkloop.runtime_sync_event.v1") {
      throw new Error("Runtime sync pull response contains a malformed event.");
    }
  }
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

function safeFileSegment(input, fallback = "InkLoop Document") {
  const value = String(input || fallback)
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
  return value || fallback;
}

function escapeHtmlComment(input) {
  return String(input || "").replace(/--/g, "- -");
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
  for (const [key, value] of Object.entries(attrs)) {
    path.setAttribute(key, String(value));
    if (key === "stroke" || key === "stroke-opacity" || key === "stroke-width" || key === "fill") {
      path.style.setProperty(key, String(value));
    }
  }
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

function compactMarkdownText(input, fallback = "") {
  return normalizeText(input || fallback).replace(/\|/g, "\\|");
}

function annotationText(annotation, fallback = "Ink mark") {
  return compactMarkdownText(annotation.body_md || annotation.text || annotation.title || annotation.description || fallback);
}

function blockQuoteText(block) {
  return compactMarkdownText(block.source_anchor?.quote || block.text || "");
}

const READING_RUNTIME_SECTIONS = ["阅读摘要", "阅读笔记"];
const MEETING_RUNTIME_SECTIONS = ["飞书智能纪要", "原始文字记录", "InkLoop 手写记录", "后处理结果"];
const MEETING_ONLY_KINDS = new Set(["task", "decision", "risk", "meeting_action", "meeting_decision", "meeting_risk"]);

function cloudKind(value) {
  return String(value || "").toLowerCase();
}

function isMeetingOnlyKnowledgeObject(ko) {
  return MEETING_ONLY_KINDS.has(cloudKind(ko?.kind));
}

function knowledgeObjectsForProjectionMode(entity) {
  const objects = Array.isArray(entity?.knowledgeObjects) ? entity.knowledgeObjects : [];
  if (entity?.mode !== "reading") return objects;
  return objects.filter((ko) => !isMeetingOnlyKnowledgeObject(ko));
}

function runtimeProjectionMode(snapshot) {
  const docId = String(snapshot.doc_id || "").toLowerCase();
  const title = String(snapshot.document?.title || snapshot.identity?.title || "").toLowerCase();
  const sourceKind = String(snapshot.identity?.source_kind || snapshot.source?.kind || "").toLowerCase();
  return docId.startsWith("mtg") || sourceKind.includes("meeting") || title.includes("会议") ? "meeting" : "reading";
}

function meetingAnnotationGroup(annotation) {
  const kind = String(annotation.kind || "").toLowerCase();
  if (kind === "summary" || kind === "meeting_summary") return "飞书智能纪要";
  if (kind === "ai_note" || kind === "postprocess" || kind === "meeting_postprocess") return "后处理结果";
  return "InkLoop 手写记录";
}

function readingAnnotationGroup(annotation) {
  const kind = String(annotation.kind || "").toLowerCase();
  if (kind === "summary" || kind === "reading_summary") return "阅读摘要";
  return "阅读笔记";
}

function annotationGroup(annotation, mode = "reading") {
  return mode === "meeting" ? meetingAnnotationGroup(annotation) : readingAnnotationGroup(annotation);
}

function annotationLabel(annotation, mode = "reading") {
  const kind = String(annotation.kind || "").toLowerCase();
  const tool = String(annotation.tool || annotation.ink_tool || "").toLowerCase();
  if (mode === "meeting") {
    if (kind === "meeting_action" || kind === "task" || kind === "todo" || kind === "action") return "任务";
    if (kind === "meeting_decision" || kind === "decision") return "决策";
    if (kind === "meeting_risk" || kind === "risk") return "风险";
    if (kind === "meeting_summary" || kind === "summary") return "摘要";
    return "会议标记";
  }
  if (kind === "ai_note" || kind.includes("ai") || tool === "aipen") return "AI 回应";
  if (kind === "excerpt" || kind === "quote") return "摘录";
  if (kind === "highlight" || tool === "highlighter") return "高亮";
  if (kind === "review_later") return "待回看";
  if (isStrokeOnlyAnnotation(annotation)) return "手写标记";
  return "阅读标记";
}

function annotationLine(docId, block, annotation, mode = "reading") {
  const label = annotationLabel(annotation, mode);
  const text = annotationText(annotation, label);
  const quote = blockQuoteText(block);
  const uri = cloudSourceUri(docId, {
    anchor: annotation.mark_id || annotation.entry_id || annotation.event_id,
    koId: annotation.ko_id,
  });
  const suffix = quote && quote !== text ? ` — ${quote.slice(0, 160)}` : "";
  return `- **${label}**：${text}${suffix} ([回到原文](${uri}))`;
}

function annotationProjectionScore(annotation) {
  let score = 0;
  if (annotation.render_mode !== "stroke_only") score += 2;
  if (normalizeText(annotation.body_md || annotation.text || annotation.description)) score += 4;
  if (annotation.kind === "ai_note") score += 1;
  return score;
}

function groupedRuntimeAnnotations(snapshot, mode = "reading") {
  const sections = mode === "meeting" ? MEETING_RUNTIME_SECTIONS : READING_RUNTIME_SECTIONS;
  const groupMaps = Object.fromEntries(sections.map((section) => [section, new Map()]));
  const put = (group, key, entry) => {
    const previous = groupMaps[group].get(key);
    if (!previous || entry.score > previous.score || (entry.score === previous.score && entry.line.length > previous.line.length)) {
      groupMaps[group].set(key, entry);
    }
  };
  for (const block of snapshot.blocks || []) {
    for (const annotation of block.annotations || []) {
      if (annotation.status === "deleted") continue;
      if (mode === "reading" && MEETING_ONLY_KINDS.has(String(annotation.kind || "").toLowerCase())) continue;
      const group = annotationGroup(annotation, mode);
      const key = annotation.ko_id || `${group}:${annotationText(annotation)}`;
      const entry = {
        score: annotationProjectionScore(annotation),
        line: annotationLine(snapshot.doc_id, block, annotation, mode),
      };
      put(group, key, entry);
    }
  }
  return Object.fromEntries(Object.entries(groupMaps).map(([group, map]) => [group, [...map.values()].map((entry) => entry.line)]));
}

function renderRuntimeWrapperMarkdown(snapshot) {
  const docId = snapshot.doc_id;
  const title = snapshot.document?.title || docId;
  const sourceKind = snapshot.identity?.source_kind || snapshot.source?.kind || "";
  const mode = runtimeProjectionMode(snapshot);
  const sections = mode === "meeting" ? MEETING_RUNTIME_SECTIONS : READING_RUNTIME_SECTIONS;
  const groups = groupedRuntimeAnnotations(snapshot, mode);
  const lines = [
    `# ${title}`,
    "",
    `<!-- inkloop:runtime-doc doc_id="${escapeHtmlComment(docId)}" source_kind="${escapeHtmlComment(sourceKind)}" mode="${mode}" -->`,
    "",
    `原文： [inkloop://doc/${docId}](inkloop://doc/${encodeURIComponent(docId)})`,
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${section}`, "");
    const items = groups[section];
    lines.push(items.length ? items.join("\n") : "暂无");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function isPlaceholderRuntimeTitle(title) {
  const value = normalizeText(title || "");
  return !value || value === "(未命名)" || value === "未命名" || value.toLowerCase() === "untitled";
}

function runtimeSnapshotHasProjectionContent(snapshot) {
  for (const block of snapshot?.blocks || []) {
    if (normalizeText(block.text || block.text_md || block.content)) return true;
    const annotations = Array.isArray(block.annotations) ? block.annotations : [];
    if (annotations.some((annotation) => annotation?.status !== "deleted")) return true;
  }
  return false;
}

function shouldSkipRuntimeWrapperSnapshot(snapshot) {
  const title = snapshot?.document?.title || "";
  const sourceKind = String(snapshot?.identity?.source_kind || snapshot?.source?.kind || "").toLowerCase();
  const hasContent = runtimeSnapshotHasProjectionContent(snapshot);
  if (isPlaceholderRuntimeTitle(title) && !hasContent) return true;
  return sourceKind === "inkloop_created" && !hasContent;
}

function cloudDocumentUri(docId) {
  return `inkloop://doc/${encodeURIComponent(docId)}`;
}

function cloudSourceUri(docId, options = {}) {
  const id = String(docId || "").trim();
  if (!id) return "";
  const anchor = String(options.anchor || "").trim();
  const koId = String(options.koId || "").trim();
  const pageIndex = Number.isFinite(Number(options.pageIndex)) ? Math.max(0, Number(options.pageIndex)) : null;
  const suffix = pageIndex === null ? "" : `/page/${pageIndex + 1}`;
  const params = [];
  if (anchor) params.push(["anchor", anchor]);
  else if (koId) params.push(["ko", koId]);
  const query = params.length ? `?${params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}` : "";
  return `${cloudDocumentUri(id)}${suffix}${query}`;
}

function firstCloudKoAnchor(ko) {
  const anchors = [
    ko?.provenance?.mark_ids?.[0],
    ko?.source?.event_id,
    ko?.source?.object_refs?.[0],
    ko?.source?.mark_id,
    ko?.mark_id,
    ko?.event_id,
  ];
  return String(anchors.find((value) => String(value || "").trim()) || "").trim();
}

function cloudKoSourceUri(entity, ko) {
  const existing = String(ko?.source?.inkloop_uri || "").trim();
  if (/^inkloop:\/\/doc\//i.test(existing) && /[?&](anchor|mark)=/i.test(existing)) return existing;
  const docId = ko?.source?.document_id || ko?.document_id || entity?.documentId || "";
  const pageIndex = Number.isFinite(Number(ko?.source?.page_index)) ? Number(ko.source.page_index) : undefined;
  return cloudSourceUri(docId, { pageIndex, anchor: firstCloudKoAnchor(ko), koId: ko?.ko_id });
}

function cleanCloudDocumentTitle(input, fallback = "InkLoop Document") {
  return safeFileSegment(String(input || fallback).replace(/\s*\.(?:md|markdown|pdf|epub)$/i, ""), fallback);
}

function cloudKnowledgeFolder(settings, documentTitle, mode = "reading") {
  const section = mode === "meeting" ? "Meetings" : "Reading";
  return `${settings.documentsDir}/${section}/${cleanCloudDocumentTitle(documentTitle)}`;
}

function projectionBlockHasMeetingOnlyAnnotation(block) {
  if (Array.isArray(block?.annotations)) {
    return block.annotations.some((annotation) => MEETING_ONLY_KINDS.has(String(annotation?.kind || "").toLowerCase()));
  }
  return false;
}

function renderCloudProjectionBlocks(projections, mode = "reading") {
  const seen = new Set();
  const lines = [];
  for (const projection of projections || []) {
    for (const block of projection.blocks || []) {
      if (mode === "reading" && projectionBlockHasMeetingOnlyAnnotation(block)) continue;
      const text = String(block.text_md || block.text || "").trim();
      if (!text) continue;
      const key = normalizeText(text);
      if (!key || seen.has(key) || isCloudNoiseText(key, projection.document_title)) continue;
      seen.add(key);
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(text);
    }
  }
  return lines.join("\n");
}

function isCloudNoiseText(text, documentTitle = "") {
  const value = normalizeText(text);
  if (!value) return true;
  if (value === "稍后处理") return true;
  const title = normalizeText(documentTitle).replace(/\.(pdf|epub|md|markdown)$/i, "");
  if (title && value === title) return true;
  if (/\.pdf\s*·\s*p\d+$/i.test(value)) return true;
  return false;
}

function isCloudPlaceholderMarkText(text) {
  const value = normalizeText(stripCloudMachineTrail(text || ""));
  if (!value) return true;
  const compact = value.replace(/[\s()（）/／·.。:：-]/g, "").toLowerCase();
  if (["inkmark", "mark", "手写笔划标记", "图形标注圈画", "图形标注待识别", "待补充的ux范式标注"].includes(compact)) return true;
  return /未识别出文本摘录|仅有图形|只有图形|仅包含图形|图形圈画|图形标注|缺少文本内容|需补充文字|暂无法提取|暂时无法提炼|无法提炼具体洞察|待补充|原文摘录与边注均显示为墨水标记|尚未形成文字注解|待二次回顾|后续补充/.test(value);
}

function isCloudDocumentMetadataFragment(text) {
  const value = normalizeText(text || "");
  return value.length < 96 && /中图分类号|文献标识码|文章编号|收稿日期|作者简介|基金项目/.test(value);
}

function isReferenceLikeCloudText(text) {
  const value = normalizeText(text);
  if (value.length < 80) return false;
  const citationSignals = [
    /\b[A-Z][a-z]+,\s+[A-Z]\./,
    /\(\s*(19|20)\d{2}[a-z]?\s*\)/i,
    /\b(pp\.|doi|isbn|arxiv|proceedings|conference|journal|ergonomics|interactions)\b/i,
    /https?:\/\//i,
  ].filter((pattern) => pattern.test(value)).length;
  return citationSignals >= 2;
}

function isMeaningfulCloudSnapshotAnchor(text, documentTitle = "") {
  const value = normalizeText(text);
  return Boolean(value)
    && !isCloudNoiseText(value, documentTitle)
    && !isCloudDocumentMetadataFragment(value)
    && !isReferenceLikeCloudText(value)
    && !isCloudPlaceholderMarkText(value);
}

function isCloudLowSignalKo(ko, documentTitle = "") {
  const title = normalizeText(ko.title || "");
  const quote = normalizeText(ko.source?.quote || "");
  const body = normalizeText(ko.body_md || "");
  if (!isMeaningfulCloudSnapshotAnchor(title, documentTitle)
    && !isMeaningfulCloudSnapshotAnchor(quote, documentTitle)
    && !isMeaningfulCloudSnapshotAnchor(body, documentTitle)) return true;
  if (title && isCloudNoiseText(title, documentTitle)) return true;
  if (quote && isCloudNoiseText(quote, documentTitle)) return true;
  if (String(ko.kind || "") === "excerpt" && isReferenceLikeCloudText(`${title} ${quote || body}`)) return true;
  if (/^只是|并非向\s*AI|不是对\s*AI|属于读者/.test(body) && /\.pdf\s*·\s*p\d+$/i.test(title || quote)) return true;
  return false;
}

function cloudProjectionAnnotationForKo(entity, koId) {
  if (!koId) return null;
  for (const projection of entity.documentProjections || []) {
    for (const block of projection.blocks || []) {
      for (const annotation of block.annotations || []) {
        if (annotation?.ko_id === koId) return annotation;
      }
    }
  }
  return null;
}

function stripCloudMachineTrail(value) {
  return String(value || "")
    .replace(/\s+Marked evidence:\s*[\s\S]*?(?=\s+Backlink:|$)/gi, "")
    .replace(/\s+Backlink:\s*\S+/gi, "")
    .split("\n")
    .filter((line) => !/^\s*(Marked evidence|Backlink):/i.test(line))
    .join("\n")
    .trim();
}

function cleanCloudAnnotationBody(annotation) {
  return normalizeText(stripCloudMachineTrail(annotation?.body_md || annotation?.text || annotation?.title || ""));
}

function cloudDisplayKoTitle(ko, annotation, documentTitle = "") {
  const title = normalizeText(ko.title || "");
  if (title && !isCloudNoiseText(title, documentTitle)) return title;
  const annotationBody = cleanCloudAnnotationBody(annotation);
  if (annotationBody && !isCloudNoiseText(annotationBody, documentTitle)) return annotationBody.slice(0, 48);
  return normalizeText(ko.kind || "标记") || "标记";
}

function isCloudLowSignalKoForEntity(entity, ko) {
  if (String(ko.kind || "") === "excerpt" && isReferenceLikeCloudText(`${ko.title || ""} ${ko.source?.quote || ""} ${ko.body_md || ""}`)) return true;
  const annotation = cloudProjectionAnnotationForKo(entity, ko.ko_id);
  const annotationBody = cleanCloudAnnotationBody(annotation);
  if (entity?.mode === "reading" && ![ko.source?.quote, annotationBody].some((text) => isMeaningfulCloudSnapshotAnchor(text, entity.documentTitle))) return true;
  if (annotationBody && isMeaningfulCloudSnapshotAnchor(annotationBody, entity.documentTitle)) return false;
  return isCloudLowSignalKo(ko, entity.documentTitle);
}

function cleanCloudKoBody(ko) {
  return stripCloudMachineTrail(ko.body_md || "");
}

function cleanCloudTurnText(value) {
  return normalizeText(value || "").replace(/\s+/g, " ").trim();
}

function cleanCloudAiAnswer(turn) {
  return cleanCloudTurnText(turn.ai_reply || turn.response_md || turn.overlay?.display_text || turn.result?.content || "");
}

function cleanCloudAiQuestion(turn) {
  const view = turn.inference_view || {};
  const metadata = turn.metadata || {};
  return cleanCloudTurnText(view.question || turn.question || metadata.user_note || view.marked || turn.marked_text || metadata.marked_text || "");
}

function cleanCloudAiReferent(turn) {
  const view = turn.inference_view || {};
  const metadata = turn.metadata || {};
  return cleanCloudTurnText(view.referent_lines || metadata.quote_text || view.marked || turn.marked_text || metadata.marked_text || turn.anchor?.quote || "");
}

function shouldRenderCloudAiTurn(turn) {
  return turn?.metadata?.classifier_respond !== false;
}

function cloudTurnUri(entity, turn) {
  const docId = turn.document_id || entity.documentId;
  const pageIndex = Number.isFinite(Number(turn.page_index)) ? Number(turn.page_index) : undefined;
  return cloudSourceUri(docId, { pageIndex, anchor: turn.overlay_id || turn.mark_ids?.[0] });
}

function renderCloudAiTurnSections(entity) {
  const seen = new Set();
  const sections = [];
  for (const turn of entity.aiTurns || []) {
    if (!shouldRenderCloudAiTurn(turn)) continue;
    const answer = cleanCloudAiAnswer(turn);
    const question = cleanCloudAiQuestion(turn);
    const referent = cleanCloudAiReferent(turn);
    if (!answer || isCloudNoiseText(answer, entity.documentTitle)) continue;
    if (isCloudNoiseText(question, entity.documentTitle) && isCloudNoiseText(referent, entity.documentTitle)) continue;
    const key = `${question}|${referent}|${answer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = [];
    if (referent && !isCloudNoiseText(referent, entity.documentTitle)) lines.push(`> 原文：${referent}`);
    if (question && !isCloudNoiseText(question, entity.documentTitle)) lines.push(`> 手写：${question}`);
    lines.push(`> AI：${answer}`);
    lines.push(`[回到原文](${cloudTurnUri(entity, turn)})`);
    sections.push(lines.join("\n"));
  }
  return sections;
}

function cloudSnapshotTime(input) {
  const value = Date.parse(String(input || ""));
  if (!Number.isFinite(value)) return "";
  try {
    return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return String(input || "");
  }
}

function cloudSnapshotLabel(kind, source = "mark") {
  const value = cloudKind(kind);
  if (source === "ai_turn" || value === "ai_note" || value === "ai_response" || value.includes("ai")) return "AI 旁注";
  if (value === "highlight" || value === "excerpt" || value === "quote") return "高亮摘录";
  if (value === "review_later") return "稍后回看";
  if (value === "reading_summary" || value === "summary") return "阅读摘要";
  if (value === "reading_note" || value === "note") return "阅读笔记";
  return "手写标记";
}

function normalizeSnapshotBBox(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : input && typeof input === "object"
        ? [input.x ?? input.left, input.y ?? input.top, input.w ?? input.width, input.h ?? input.height]
        : [];
  if (raw.length < 4) return null;
  const nums = raw.slice(0, 4).map((value) => Number(value));
  if (!nums.every(Number.isFinite)) return null;
  const x = Math.min(1, Math.max(0, nums[0]));
  const y = Math.min(1, Math.max(0, nums[1]));
  const w = Math.min(1 - x, Math.max(0.006, nums[2]));
  const h = Math.min(1 - y, Math.max(0.006, nums[3]));
  return [x, y, w, h];
}

function snapshotAnnotationForKo(entity, ko) {
  const projectionAnnotation = cloudProjectionAnnotationForKo(entity, ko.ko_id);
  const koAnnotation = cloudAnnotationForKo(ko);
  if (projectionAnnotation && koAnnotation && !snapshotHasInk(projectionAnnotation) && snapshotHasInk(koAnnotation)) {
    return {
      ...projectionAnnotation,
      visual_strokes: koAnnotation.visual_strokes,
      surface_strokes: koAnnotation.surface_strokes,
    };
  }
  return projectionAnnotation || koAnnotation;
}

function snapshotTextLine(label, value) {
  const text = normalizeText(value || "");
  return text ? `<div class="inkloop-snapshot-field"><span>${escapeHtml(label)}</span><p>${escapeHtml(text)}</p></div>` : "";
}

function snapshotPageLabel(pageIndex) {
  return Number.isFinite(Number(pageIndex)) ? `原文第 ${Number(pageIndex) + 1} 页` : "原文";
}

function snapshotStrokeTools(annotation) {
  return [...(annotation?.visual_strokes || []), ...(annotation?.surface_strokes || [])]
    .map((stroke) => String(stroke?.tool || "").toLowerCase())
    .filter(Boolean);
}

function snapshotHasStrokeTool(annotation, tools) {
  const wanted = new Set(tools);
  return snapshotStrokeTools(annotation).some((tool) => wanted.has(tool));
}

function snapshotHasInk(annotation) {
  return Boolean((annotation?.visual_strokes || []).length || (annotation?.surface_strokes || []).length);
}

function snapshotInkStrokeCount(annotation) {
  return [...(annotation?.visual_strokes || []), ...(annotation?.surface_strokes || [])]
    .filter((stroke) => Array.isArray(stroke?.points) && stroke.points.length > 1)
    .length;
}

function isPlainInkSnapshot(snapshot) {
  if (!snapshotHasInk(snapshot?.annotation)) return false;
  if (snapshot.source === "ai_turn") return false;
  const label = normalizeText(snapshot.label || "").toLowerCase();
  const tools = snapshotStrokeTools(snapshot.annotation);
  if (tools.some((tool) => tool === "highlighter" || tool === "underline" || tool === "aipen" || tool === "ai_pen")) return false;
  return !/高亮|highlight|摘录|quote|excerpt|下划线|underline|ai|旁注/.test(label);
}

function cloudSnapshotLabelForKo(kind, annotation) {
  if (snapshotHasStrokeTool(annotation, ["highlighter"])) return "高亮摘录";
  if (snapshotHasStrokeTool(annotation, ["underline"])) return "下划线";
  if (snapshotHasStrokeTool(annotation, ["aipen", "ai_pen"])) return "AI 笔";
  return cloudSnapshotLabel(kind);
}

function snapshotTone(snapshot) {
  const label = normalizeText(snapshot.label || snapshot.title || "").toLowerCase();
  const strokes = snapshotStrokeTools(snapshot.annotation);
  if (snapshot.source === "ai_turn" || /ai|旁注/.test(label)) return "ai";
  if (/下划线|underline/.test(label)) return "underline";
  if (/高亮|highlight|摘录|quote|excerpt/.test(label) || strokes.some((tool) => tool === "highlighter")) return "highlight";
  return "pen";
}

function snapshotPrimaryText(snapshot) {
  if (isPlainInkSnapshot(snapshot)) {
    const count = snapshotInkStrokeCount(snapshot.annotation);
    return count > 1 ? `手写快照 · ${count} 笔` : "手写快照";
  }
  const text = normalizeText(snapshot.quote || snapshot.handwriting || snapshot.body || snapshot.title || snapshot.label || "标记");
  return isCloudPlaceholderMarkText(text) ? "手写/圈画" : text;
}

function sameSnapshotText(a, b) {
  return normalizeText(a || "") === normalizeText(b || "");
}

function snapshotDetailLine(label, value, primary) {
  if (!value || sameSnapshotText(value, primary)) return "";
  if (isCloudPlaceholderMarkText(value)) return "";
  return snapshotTextLine(label, value);
}

function readingSnapshotForKo(entity, ko) {
  if (entity?.mode === "reading" && ko.provenance?.created_from === "ai_turn") return null;
  const annotation = snapshotAnnotationForKo(entity, ko);
  const plainInk = snapshotHasInk(annotation)
    && !snapshotHasStrokeTool(annotation, ["highlighter", "underline", "aipen", "ai_pen"])
    && !["highlight", "excerpt", "quote"].includes(cloudKind(ko.kind));
  const annotationBody = cleanCloudAnnotationBody(annotation);
  const body = plainInk ? "" : annotationBody && !isCloudNoiseText(annotationBody, entity.documentTitle) ? annotationBody : cleanCloudKoBody(ko);
  const rawQuote = normalizeText(ko.source?.quote || "");
  const quote = plainInk || isReferenceLikeCloudText(rawQuote) || isCloudNoiseText(rawQuote, entity.documentTitle) ? "" : rawQuote;
  const uri = cloudKoSourceUri(entity, ko);
  const bbox = normalizeSnapshotBBox(annotation?.visual_bbox || annotation?.anchor_bbox || ko.source?.anchor_bbox || ko.visual_bbox);
  const hasSnapshotSignal = Boolean(body || quote || snapshotHasInk(annotation) || bbox);
  if (!hasSnapshotSignal) return null;
  const displayTitle = cloudDisplayKoTitle(ko, annotation, entity.documentTitle);
  const title = /^(reading_note|annotation|excerpt|highlight|note|标记|阅读笔记)$/i.test(displayTitle) && body
    ? body.slice(0, 56)
    : displayTitle;
  return {
    id: ko.ko_id || localId("ko"),
    title,
    body,
    quote,
    handwriting: annotationBody && annotationBody !== body ? annotationBody : "",
    uri,
    pageIndex: Number.isFinite(Number(ko.source?.page_index)) ? Number(ko.source.page_index) : annotation?.page_index,
    bbox,
    annotation,
    createdAt: ko.created_at || ko.updated_at,
    source: "knowledge_object",
    label: plainInk ? "手写快照" : cloudSnapshotLabelForKo(ko.kind, annotation),
  };
}

function readingSnapshots(entity) {
  const snapshots = [];
  const seen = new Set();
  const add = (snapshot) => {
    if (!snapshot) return;
    const key = normalizeText(`${snapshot.source}:${snapshot.uri}:${snapshot.title}:${snapshot.body}:${snapshot.quote}`);
    if (!key || seen.has(key)) return;
    seen.add(key);
    snapshots.push(snapshot);
  };
  for (const ko of knowledgeObjectsForProjectionMode(entity)) {
    if (cloudReadingKoSection(ko) === "summary") continue;
    add(readingSnapshotForKo(entity, ko));
  }
  return snapshots.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function koForAiTurn(entity, turn) {
  const markIds = new Set(Array.isArray(turn.mark_ids) ? turn.mark_ids.map(String) : []);
  if (!markIds.size) return null;
  return (entity.knowledgeObjects || []).find((ko) =>
    (ko.provenance?.mark_ids || ko.source?.object_refs || []).some((markId) => markIds.has(String(markId))),
  ) || null;
}

function readingAiSnapshots(entity) {
  const snapshots = [];
  const seen = new Set();
  for (const turn of entity.aiTurns || []) {
    if (!shouldRenderCloudAiTurn(turn)) continue;
    const answer = cleanCloudAiAnswer(turn);
    if (!answer || isCloudNoiseText(answer, entity.documentTitle) || isCloudPlaceholderMarkText(answer)) continue;
    const ko = koForAiTurn(entity, turn);
    const kind = cloudKind(ko?.kind);
    const question = cleanCloudAiQuestion(turn);
    const referent = cleanCloudAiReferent(turn);
    const hasExplicitPrompt = isMeaningfulCloudSnapshotAnchor(question, entity.documentTitle) || isMeaningfulCloudSnapshotAnchor(referent, entity.documentTitle);
    const linkedToHighlightedText = kind === "highlight" || kind === "excerpt" || kind === "quote";
    if (!hasExplicitPrompt && !linkedToHighlightedText) continue;
    const pageIndex = Number.isFinite(Number(turn.page_index))
      ? Number(turn.page_index)
      : Number.isFinite(Number(ko?.source?.page_index))
        ? Number(ko.source.page_index)
        : undefined;
    const quote = isMeaningfulCloudSnapshotAnchor(referent, entity.documentTitle)
      ? referent
      : isMeaningfulCloudSnapshotAnchor(ko?.source?.quote, entity.documentTitle)
        ? normalizeText(ko.source.quote)
        : "";
    const id = turn.ai_turn_id || turn.turn_id || turn.overlay_id || localId("ai");
    const key = normalizeText(`${id}:${quote}:${answer}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    snapshots.push({
      id,
      label: "AI 旁注",
      title: question && !isCloudNoiseText(question, entity.documentTitle) ? question.slice(0, 56) : "AI 旁注",
      body: answer,
      quote,
      handwriting: question && !isCloudNoiseText(question, entity.documentTitle) ? question : "",
      uri: ko ? cloudKoSourceUri(entity, ko) : cloudTurnUri(entity, turn),
      pageIndex,
      bbox: normalizeSnapshotBBox(turn.inference_view?.anchor_bbox || turn.anchor?.anchor_bbox || turn.overlay?.geometry?.anchor_bbox || ko?.source?.anchor_bbox),
      annotation: null,
      createdAt: turn.created_at || turn.updated_at || ko?.created_at,
      source: "ai_turn",
    });
  }
  return snapshots.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function renderReadingSnapshotBoard(snapshots, options = {}) {
  const title = options.title || "原文标记";
  const empty = options.empty || `暂无${title}。`;
  if (!snapshots.length) return empty;
  const items = snapshots.map((snapshot, index) => {
    const detailId = `inkloop-snapshot-${escapeHtml(String(snapshot.id || index)).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const primary = snapshotPrimaryText(snapshot);
    const tone = snapshotTone(snapshot);
    const meta = [
      snapshotPageLabel(snapshot.pageIndex),
      cloudSnapshotTime(snapshot.createdAt),
    ].filter(Boolean).join(" · ");
    const details = [
      snapshotDetailLine("原文摘录", snapshot.quote, primary),
      snapshotDetailLine(snapshot.source === "ai_turn" ? "手写问题" : "手写内容", snapshot.handwriting, primary),
      snapshot.source === "ai_turn" ? snapshotDetailLine("AI 旁注", snapshot.body, primary) : "",
    ].filter(Boolean).join("");
    const inkPreview = svgForAnnotation(snapshot.annotation);
    return [
      `<details class="inkloop-snapshot-card"${index === 0 ? " open" : ""} id="${detailId}">`,
      `<summary class="inkloop-snapshot-summary">`,
      `<span class="inkloop-snapshot-summary-text"><strong>${escapeHtml(snapshot.label || "标记")}</strong><em>${escapeHtml(meta)}</em></span>`,
      `<span class="inkloop-snapshot-markline is-${escapeHtml(tone)}">${escapeHtml(primary)}</span>`,
      `</summary>`,
      `<div class="inkloop-snapshot-detail">`,
      inkPreview ? `<div class="inkloop-snapshot-ink-preview">${inkPreview}</div>` : "",
      `<div class="inkloop-snapshot-detail-copy">`,
      details || `<p class="inkloop-snapshot-muted">已保留原文位置；这是一条原始标记快照。</p>`,
      `<a class="inkloop-snapshot-open" href="${escapeHtml(snapshot.uri)}">回到原文</a>`,
      `</div>`,
      `</div>`,
      `</details>`,
    ].join("");
  }).join("\n");
  return [
    `<section class="inkloop-snapshot-board" data-count="${snapshots.length}">`,
    `<div class="inkloop-snapshot-board-head"><strong>${escapeHtml(title)}</strong><span>${snapshots.length} 项</span></div>`,
    items,
    `</section>`,
  ].join("\n");
}

function renderedCloudAiTurnDedupeKeys(entity) {
  const keys = new Set();
  for (const turn of entity.aiTurns || []) {
    if (!shouldRenderCloudAiTurn(turn)) continue;
    const answer = cleanCloudAiAnswer(turn);
    const question = cleanCloudAiQuestion(turn);
    const referent = cleanCloudAiReferent(turn);
    if (!answer || isCloudNoiseText(answer, entity.documentTitle)) continue;
    if (isCloudNoiseText(question, entity.documentTitle) && isCloudNoiseText(referent, entity.documentTitle)) continue;
    const contentKey = normalizeText(`${referent}|${answer}`);
    if (contentKey) keys.add(`content:${contentKey}`);
    if (turn.overlay_id) keys.add(`anchor:${turn.overlay_id}`);
    for (const markId of turn.mark_ids || []) keys.add(`anchor:${markId}`);
  }
  return keys;
}

function cloudKoDedupeKeys(ko) {
  const keys = new Set();
  const quote = normalizeText(ko.source?.quote || "");
  const body = normalizeText(cleanCloudKoBody(ko));
  const contentKey = normalizeText(`${quote}|${body}`);
  if (contentKey) keys.add(`content:${contentKey}`);
  const bodyKey = normalizeText(`${ko.kind || ""}|${ko.title || ""}|${body}`);
  if (bodyKey) keys.add(`body:${bodyKey}`);
  for (const ref of ko.source?.object_refs || []) keys.add(`anchor:${ref}`);
  for (const markId of ko.provenance?.mark_ids || []) keys.add(`anchor:${markId}`);
  const uriAnchor = String(ko.source?.inkloop_uri || "").match(/[?&]anchor=([^&]+)/)?.[1];
  if (uriAnchor) {
    try {
      keys.add(`anchor:${decodeURIComponent(uriAnchor)}`);
    } catch {
      keys.add(`anchor:${uriAnchor}`);
    }
  }
  return keys;
}

function renderCloudKoSections(entity, aiTurnDedupeKeys = new Set(), includeKo = null) {
  const seen = new Set();
  const sections = [];
  for (const ko of knowledgeObjectsForProjectionMode(entity)) {
    if (includeKo && !includeKo(ko)) continue;
    if (isCloudLowSignalKoForEntity(entity, ko)) continue;
    const annotation = cloudProjectionAnnotationForKo(entity, ko.ko_id);
    const annotationBody = cleanCloudAnnotationBody(annotation);
    const body = annotationBody && !isCloudNoiseText(annotationBody, entity.documentTitle) ? annotationBody : cleanCloudKoBody(ko);
    const title = cloudDisplayKoTitle(ko, annotation, entity.documentTitle);
    const rawQuote = normalizeText(ko.source?.quote || "");
    const quote = isReferenceLikeCloudText(rawQuote) ? "" : rawQuote;
    const key = normalizeText(`${ko.kind || ""}|${title}|${body || quote}`);
    if (seen.has(key)) continue;
    const dedupeKeys = cloudKoDedupeKeys(ko);
    if ([...dedupeKeys].some((dedupeKey) => aiTurnDedupeKeys.has(dedupeKey))) continue;
    seen.add(key);
    const uri = cloudKoSourceUri(entity, ko);
    const lines = [`### ${title}`];
    if (quote && !isCloudNoiseText(quote, entity.documentTitle)) lines.push(`> 原文：${quote}`);
    if (body) lines.push(body);
    if (uri) lines.push(`[回到原文](${uri})`);
    const svg = svgForAnnotation(cloudAnnotationForKo(ko));
    if (svg) lines.push(svg);
    sections.push(lines.join("\n\n"));
  }
  return sections;
}

function isMeetingSummaryKo(ko) {
  const kind = cloudKind(ko?.kind);
  return kind === "summary" || kind === "meeting_summary";
}

function isFeishuMeetingSummaryKo(ko) {
  if (!isMeetingSummaryKo(ko)) return false;
  return /飞书智能纪要|智能纪要|feishu|lark/i.test(`${ko?.title || ""}\n${ko?.body_md || ""}`);
}

function isMeetingPostprocessKo(ko) {
  const kind = cloudKind(ko?.kind);
  if (ko?.provenance?.created_from === "ai_turn") return true;
  return ["meeting_action", "meeting_decision", "meeting_risk", "qa", "task", "decision", "risk"].includes(kind)
    && Array.isArray(ko?.source_refs)
    && ko.source_refs.some((ref) => ref?.ref_type === "meeting_mark");
}

function isMeetingHandwritingKo(ko) {
  if (isMeetingSummaryKo(ko) || isMeetingPostprocessKo(ko)) return false;
  if (ko?.provenance?.created_from === "mark") return true;
  return !!cloudAnnotationForKo(ko);
}

function cloudReadingKoSection(ko) {
  if (isMeetingOnlyKnowledgeObject(ko)) return null;
  const kind = cloudKind(ko?.kind);
  const titleAndBody = `${ko?.title || ""} ${ko?.body_md || ""}`;
  const title = String(ko?.title || "");
  if (kind === "summary" || kind === "reading_summary") return "summary";
  if (kind === "highlight" || kind === "excerpt" || kind === "markup" || kind === "quote") return "highlight";
  if (kind === "ai_note" || kind === "ai_response") return "ai";
  if (kind === "review_later" || /待回看|稍后回看|review later/i.test(titleAndBody)) return "review";
  if (/^阅读笔记[:：]/.test(title) || /^读后笔记[:：]/.test(title)) return "note";
  if (cloudAnnotationForKo(ko) || /手写|边注|普通笔刷|笔迹|划线|圈出|验收项|freehand|hand/i.test(titleAndBody)) return "thought";
  if (kind === "annotation" || kind === "note") return "thought";
  if (kind === "reading_note") return "note";
  return "thought";
}

function cloudAnnotationForKo(ko) {
  const visualStrokes = Array.isArray(ko.visual_strokes)
    ? ko.visual_strokes
    : Array.isArray(ko.source?.visual_strokes)
      ? ko.source.visual_strokes
      : [];
  const surfaceStrokes = Array.isArray(ko.surface_strokes)
    ? ko.surface_strokes
    : Array.isArray(ko.source?.surface_strokes)
      ? ko.source.surface_strokes
      : [];
  const strokes = visualStrokes.length ? visualStrokes : surfaceStrokes;
  if (!strokes.length) return null;
  return {
    ko_id: ko.ko_id,
    kind: ko.kind,
    title: ko.title,
    body_md: ko.body_md,
    render_mode: "stroke_only",
    visual_strokes: strokes,
    surface_strokes: surfaceStrokes,
  };
}

function svgNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function svgPoint(point) {
  if (Array.isArray(point)) return { x: svgNumber(point[0]), y: svgNumber(point[1]) };
  return { x: svgNumber(point?.x), y: svgNumber(point?.y) };
}

function svgPointValue(value, normalized) {
  const number = normalized ? value * 100 : value;
  return Math.round(number * 100) / 100;
}

function svgStrokePath(points, normalized) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${svgPointValue(point.x, normalized)},${svgPointValue(point.y, normalized)}`)
    .join(" ");
}

function svgForAnnotation(annotation) {
  const rawStrokes = (annotation?.visual_strokes?.length ? annotation.visual_strokes : annotation?.surface_strokes) || [];
  if (!rawStrokes.length) return "";
  const strokes = rawStrokes
    .map((stroke) => ({
      ...stroke,
      points: Array.isArray(stroke?.points) ? stroke.points.map(svgPoint).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) : [],
    }))
    .filter((stroke) => stroke.points.length > 1);
  if (!strokes.length) return "";

  const allPoints = strokes.flatMap((stroke) => stroke.points);
  const normalized = allPoints.every((point) => point.x >= -0.05 && point.x <= 1.05 && point.y >= -0.05 && point.y <= 1.05);
  const xs = allPoints.map((point) => svgPointValue(point.x, normalized));
  const ys = allPoints.map((point) => svgPointValue(point.y, normalized));
  const minX = normalized ? 0 : Math.min(...xs);
  const minY = normalized ? 0 : Math.min(...ys);
  const maxX = normalized ? 100 : Math.max(...xs);
  const maxY = normalized ? 100 : Math.max(...ys);
  const pad = normalized ? 0 : 12;
  const viewBox = [
    Math.round((minX - pad) * 100) / 100,
    Math.round((minY - pad) * 100) / 100,
    Math.max(1, Math.round((maxX - minX + pad * 2) * 100) / 100),
    Math.max(1, Math.round((maxY - minY + pad * 2) * 100) / 100),
  ].join(" ");
  const paths = strokes.map((stroke) => {
    const tool = String(stroke.tool || "pen").replace(/[^a-zA-Z0-9_-]/g, "");
    const color = /^#[0-9a-fA-F]{6}$/.test(String(stroke.color || "")) ? String(stroke.color) : "#38bdf8";
    const opacity = Math.min(1, Math.max(0.08, Number(stroke.opacity) || (tool === "highlighter" ? 0.48 : 0.92)));
    const width = tool === "highlighter" ? 4.8 : 2.4;
    return `<path class="inkloop-cloud-mark-freehand is-${escapeHtml(tool)}" d="${escapeHtml(svgStrokePath(stroke.points, normalized))}" fill="none" stroke="${escapeHtml(color)}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const aspectStyle = normalized
    ? "aspect-ratio:3/4;height:auto;min-height:120px;max-height:260px;"
    : "height:120px;";
  const preserve = normalized ? "none" : "xMidYMid meet";
  return [
    `<svg class="inkloop-cloud-mark-layer" data-inkloop-knowledge-object="${escapeHtml(annotation.ko_id || "")}" viewBox="${escapeHtml(viewBox)}" preserveAspectRatio="${preserve}" role="img" aria-label="InkLoop mark" style="display:block;width:100%;${aspectStyle}margin:12px 0;border:1px solid rgba(148,163,184,0.35);border-radius:8px;background:rgba(248,250,252,0.72)">`,
    paths,
    "</svg>",
  ].join("");
}

function renderCloudSourceHub(settings, entity) {
  const folder = cloudKnowledgeFolder(settings, entity.documentTitle, entity.mode);
  const title = cleanCloudDocumentTitle(entity.documentTitle, entity.documentId);
  const uri = cloudDocumentUri(entity.documentId);
  const aiTurnSections = renderCloudAiTurnSections(entity);
  const aiTurnDedupeKeys = renderedCloudAiTurnDedupeKeys(entity);
  const summarySections = renderCloudKoSections(entity, aiTurnDedupeKeys, (ko) => cloudReadingKoSection(ko) === "summary");
  const projectionBody = renderCloudProjectionBlocks(entity.documentProjections, entity.mode);
  const lines = [
    `[在 InkLoop 打开原文](${uri})`,
  ];
  const noteBlocks = [...aiTurnSections, ...renderCloudKoSections(entity, aiTurnDedupeKeys)];
  if (entity.mode === "meeting") {
    const feishuSummarySections = renderCloudKoSections(entity, aiTurnDedupeKeys, isFeishuMeetingSummaryKo);
    const handwritingSections = renderCloudKoSections(entity, aiTurnDedupeKeys, isMeetingHandwritingKo);
    const postprocessSections = renderCloudKoSections(entity, aiTurnDedupeKeys, isMeetingPostprocessKo);
    lines.push("## 飞书智能纪要", feishuSummarySections.length ? feishuSummarySections.join("\n\n---\n\n") : "暂无飞书智能纪要。");
    if (projectionBody) lines.push("## 原始文字记录", projectionBody);
    lines.push("## InkLoop 手写记录", handwritingSections.length ? handwritingSections.join("\n\n---\n\n") : "暂无手写记录。");
    lines.push("## 后处理结果", postprocessSections.length ? postprocessSections.join("\n\n---\n\n") : (noteBlocks.length ? noteBlocks.join("\n\n---\n\n") : "暂无后处理结果。"));
  } else {
    lines.push("## 阅读摘要", summarySections.length ? summarySections.join("\n\n---\n\n") : "暂无阅读摘要。");
    const snapshots = readingSnapshots(entity);
    const aiSnapshots = readingAiSnapshots(entity);
    lines.push("## 阅读标记", renderReadingSnapshotBoard(snapshots, { title: "原文标记", empty: "暂无原文标记。" }));
    if (aiSnapshots.length) lines.push("## AI 旁注", renderReadingSnapshotBoard(aiSnapshots, { title: "AI 旁注", empty: "暂无 AI 旁注。" }));
  }
  return { path: `${folder}/${title}.md`, markdown: `${lines.join("\n\n").trimEnd()}\n` };
}

function renderCloudKnowledgeMarkdown(settings, objects, projections, aiTurns = []) {
  const byDoc = new Map();
  const ensure = (docId, title) => {
    const id = String(docId || "").trim();
    if (!id) return null;
    const current = byDoc.get(id) || {
      documentId: id,
      documentTitle: title || id,
      mode: id.startsWith("mtgdoc_") ? "meeting" : "reading",
      knowledgeObjects: [],
      documentProjections: [],
      aiTurns: [],
    };
    if (title && current.documentTitle === id) current.documentTitle = title;
    byDoc.set(id, current);
    return current;
  };
  for (const projection of projections || []) {
    ensure(projection.document_id, projection.document_title)?.documentProjections.push(projection);
  }
  for (const ko of objects || []) {
    const docId = ko.source?.document_id || ko.document_id;
    ensure(docId, ko.source?.document_title)?.knowledgeObjects.push(ko);
  }
  for (const turn of aiTurns || []) {
    ensure(turn.document_id, turn.document_title || turn.inference_view?.document_title)?.aiTurns.push(turn);
  }
  const files = [];
  for (const entity of [...byDoc.values()].sort((a, b) => a.documentTitle.localeCompare(b.documentTitle))) {
    entity.knowledgeObjects.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    entity.documentProjections.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    entity.aiTurns.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    files.push(renderCloudSourceHub(settings, entity));
  }
  return files;
}

function isCloudKnowledgeTestRun(item) {
  const metadata = item?.metadata || {};
  return metadata.inkloop_test_run === true || metadata.test_run === true;
}

function isCloudKnowledgeHiddenDoc(docId, title = "") {
  const id = String(docId || "").toLowerCase();
  const name = String(title || "").toLowerCase();
  if (/inkloop v1 demo|product e2e|v1 product e2e|last verify|verify|测试文档|\be2e\b|\btest\b|\bsmoke\b/.test(name)) return true;
  if (/^doc_v1_/.test(id)) return true;
  return id.includes("test") || id.includes("e2e");
}

function filterCloudKnowledgeForObsidian(objects, projections) {
  const testDocIds = new Set();
  for (const projection of projections || []) {
    if (isCloudKnowledgeTestRun(projection) && projection.document_id) testDocIds.add(projection.document_id);
    if (isCloudKnowledgeHiddenDoc(projection.document_id, projection.document_title) && projection.document_id) testDocIds.add(projection.document_id);
  }
  for (const ko of objects || []) {
    const docId = ko.source?.document_id || ko.document_id;
    const title = ko.source?.document_title || ko.document_title || ko.title;
    if ((isCloudKnowledgeTestRun(ko) || isCloudKnowledgeHiddenDoc(docId, title)) && docId) testDocIds.add(docId);
  }
  const visibleObjects = (objects || []).filter((ko) => {
    const docId = ko.source?.document_id || ko.document_id;
    return !isCloudKnowledgeTestRun(ko) && !testDocIds.has(docId);
  });
  const visibleProjections = (projections || []).filter((projection) => {
    const docId = projection.document_id;
    return !isCloudKnowledgeTestRun(projection) && !testDocIds.has(docId);
  });
  return {
    objects: visibleObjects,
    projections: visibleProjections,
    skipped_objects: (objects || []).length - visibleObjects.length,
    skipped_projections: (projections || []).length - visibleProjections.length,
    skipped_document_ids: [...testDocIds].sort(),
  };
}

function cloudProjectionIdentityFromMarkdown(markdown) {
  const comment = markdown.match(/<!--\s*inkloop:cloud-note\s+([^>]*)-->/);
  if (comment) {
    const attrs = parseAttrs(comment[1]);
    const documentId = attrs.document_id || "";
    const role = attrs.role || "";
    if (documentId && (role === "reading_note" || role === "meeting_note")) {
      return { document_id: documentId, ko_id: "", key: `${documentId}::source` };
    }
  }
  const front = parseProjectionFrontmatter(markdown);
  const role = front.inkloop_projection_role;
  const documentId = typeof front.inkloop_document_id === "string" ? front.inkloop_document_id : "";
  if (!documentId) return null;
  if (role === "reading_note" || role === "meeting_note" || role === "source_file_unit") {
    return { document_id: documentId, ko_id: "", key: `${documentId}::source` };
  }
  if (role !== "knowledge_projection") return null;
  const koId = typeof front.inkloop_knowledge_object_id === "string" ? front.inkloop_knowledge_object_id : "";
  if (!koId) return null;
  return { document_id: documentId, ko_id: koId, key: `${documentId}::${koId}` };
}

function archiveStamp() {
  return nowIso().replace(/[:.]/g, "-");
}

function stablePathHash(input) {
  let hash = 5381;
  for (const char of String(input || "")) hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function archiveFileNameForPath(path) {
  const cleaned = String(path || "projection.md")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("__")
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]+/g, "_");
  return `${stablePathHash(path)}__${cleaned}`;
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

function unescapeHtml(input) {
  return String(input)
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
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
    this.runtimePollTimer = null;
    this.runtimePollInFlight = false;
    this.lastRuntimePollError = null;
    this.lastChange = null;
    this.nativeEditTimers = new Map();
    this.previewSignatures = new Map();
    this.controlledKnowledgeSignatures = new Map();
    this.cloudProjectionPaths = new Set();
    this.appendQueues = new Map();
    this.refreshPreviewsRunning = false;
    this.statusPath = `${this.settings.baseDir}/.obsidian-plugin-status.json`;
    await this.seedControlledKnowledgeSignaturesFromVault();

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
    this.registerDomEvent(document, "click", (event) => this.onInkLoopSourceLinkClick(event), true);
    this.previewRefreshTimer = window.setInterval(() => void this.refreshOpenInkLoopPreviews(), 1500);
    this.registerInterval?.(this.previewRefreshTimer);
    this.startRuntimePolling();
    void this.ensureRemoteRuntimeWrappersForSidecars()
      .then((repaired) => repaired ? this.writeStatus({ status: "runtime_wrappers_repaired", repaired }) : null)
      .catch((error) => this.writeStatus({ status: "runtime_wrapper_repair_failed", error: String(error?.message || error) }));
    void this.writeStatus({ loaded_at: new Date().toISOString(), status: "loaded", error: null });
  }

  onunload() {
    if (this.pendingTimer) window.clearTimeout(this.pendingTimer);
    if (this.runtimePollTimer) window.clearInterval(this.runtimePollTimer);
    if (this.previewRefreshTimer) window.clearInterval(this.previewRefreshTimer);
    for (const timer of this.nativeEditTimers?.values?.() || []) window.clearTimeout(timer);
    this.nativeEditTimers?.clear?.();
    this.previewSignatures?.clear?.();
    this.controlledKnowledgeSignatures?.clear?.();
    this.cloudProjectionPaths?.clear?.();
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

  async requestCloudKnowledge(path, params = {}) {
    const base = this.settings.knowledgeBaseEndpoint || "";
    if (!base) return null;
    const response = await requestUrl({
      url: appendQuery(appendPath(base, path), params),
      method: "GET",
      headers: runtimeNamespaceHeaders(this.settings),
    });
    return typeof response.json === "object" ? response.json : JSON.parse(response.text || "{}");
  }

  inkLoopSourceHrefFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return "";
    const link = target.closest("a[href^=\"inkloop://doc/\"]");
    if (!link) return "";
    return link.getAttribute("href") || "";
  }

  onInkLoopSourceLinkClick(event) {
    const href = this.inkLoopSourceHrefFromEvent(event);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    void this.openSourceOnInkLoopDevice(href);
  }

  async openSourceOnInkLoopDevice(uri) {
    const endpoint = deriveDeviceCommandEndpoint(this.settings);
    if (!endpoint) {
      new Notice("InkLoop device command endpoint is not configured");
      return;
    }
    try {
      const response = await requestUrl({
        url: endpoint,
        method: "POST",
        contentType: "application/json",
        headers: runtimeNamespaceHeaders(this.settings),
        body: JSON.stringify({
          type: "open_source",
          source_device_id: this.settings.deviceId,
          requested_by: this.settings.deviceId,
          payload: {
            uri,
            source: "obsidian-plugin",
          },
        }),
      });
      const payload = typeof response.json === "object" ? response.json : JSON.parse(response.text || "{}");
      const target = payload?.command?.target_device_id || "InkLoop Paper";
      new Notice(`已发送到 ${target}`);
      await this.writeStatus({ status: "open_source_command_sent", uri, target_device_id: payload?.command?.target_device_id || null });
    } catch (error) {
      new Notice(`回到原文失败：${String(error?.message || error)}`);
      await this.writeStatus({ status: "open_source_command_failed", uri, error: String(error?.message || error) });
    }
  }

  async writeRenderedMarkdownFile(file) {
    await this.app.vault.adapter.mkdir(file.path.split("/").slice(0, -1).join("/")).catch(() => {});
    const existing = await this.app.vault.adapter.read(file.path).catch(() => null);
    if (existing === file.markdown) return false;
    await this.app.vault.adapter.write(file.path, file.markdown);
    return true;
  }

  async seedControlledKnowledgeSignaturesFromVault() {
    const prefix = `${this.settings.documentsDir}/`;
    const previousPull = await this.readJson(this.sidecarPath("cloud-knowledge-pull.json"), null);
    for (const path of Array.isArray(previousPull?.rendered_paths) ? previousPull.rendered_paths : []) {
      if (typeof path === "string" && path.startsWith(prefix)) this.cloudProjectionPaths.add(path);
    }
    const files = typeof this.app.vault.getMarkdownFiles === "function" ? this.app.vault.getMarkdownFiles() : [];
    let seeded = 0;
    for (const file of files) {
      if (!file?.path?.startsWith(prefix)) continue;
      const markdown = await this.app.vault.cachedRead(file).catch(() => this.app.vault.adapter.read(file.path));
      seeded += rememberControlledKnowledgeSignatures(this.controlledKnowledgeSignatures, file.path, markdown);
    }
    return seeded;
  }

  async removePath(path) {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (abstract && typeof this.app.vault.delete === "function") {
      await this.app.vault.delete(abstract);
      return;
    }
    if (typeof this.app.vault.adapter.remove === "function") {
      await this.app.vault.adapter.remove(path);
      return;
    }
    throw new Error("Obsidian adapter cannot remove archived stale projection.");
  }

  async archivePath(sourcePath, archivePath) {
    await this.app.vault.adapter.mkdir(archivePath.split("/").slice(0, -1).join("/")).catch(() => {});
    if (typeof this.app.vault.adapter.rename === "function") {
      await this.app.vault.adapter.rename(sourcePath, archivePath);
      return;
    }
    const content = await this.app.vault.adapter.read(sourcePath);
    await this.app.vault.adapter.write(archivePath, content);
    await this.removePath(sourcePath);
  }

  async archiveStaleCloudKnowledgeProjections(files) {
    const canonicalByIdentity = new Map();
    const folders = new Set();
    for (const file of files) {
      const identity = cloudProjectionIdentityFromMarkdown(file.markdown);
      if (!identity) continue;
      canonicalByIdentity.set(identity.key, file.path);
      folders.add(file.path.split("/").slice(0, -1).join("/"));
    }
    if (!canonicalByIdentity.size) return { archived: 0, files: [] };

    const archivedAt = nowIso();
    const archiveRoot = this.sidecarPath("archived-projections", archiveStamp());
    const archived = [];
    for (const folder of folders) {
      const listing = await this.app.vault.adapter.list(folder).catch(() => null);
      const folderFiles = Array.isArray(listing?.files) ? listing.files : [];
      for (const path of folderFiles) {
        if (!/\.md$/i.test(path)) continue;
        const markdown = await this.app.vault.adapter.read(path).catch(() => null);
        if (!markdown) continue;
        const identity = cloudProjectionIdentityFromMarkdown(markdown);
        if (!identity) continue;
        const canonicalPath = canonicalByIdentity.get(identity.key);
        if (!canonicalPath || path === canonicalPath) continue;
        const archivedPath = `${archiveRoot}/${archiveFileNameForPath(path)}`;
        await this.archivePath(path, archivedPath);
        const record = {
          schema_version: "inkloop.archived_stale_projection.v1",
          reason: "stale_cloud_knowledge_projection_path",
          archived_at: archivedAt,
          original_path: path,
          archived_path: archivedPath,
          canonical_path: canonicalPath,
          document_id: identity.document_id,
          knowledge_object_id: identity.ko_id,
        };
        await this.writeJson(`${archivedPath}.json`, record);
        archived.push(record);
      }
    }
    if (archived.length) {
      await this.writeJson(this.sidecarPath("archived-projections", "latest.json"), {
        schema_version: "inkloop.archived_stale_projection_manifest.v1",
        archived_at: archivedAt,
        archive_root: archiveRoot,
        archived_count: archived.length,
        files: archived,
      });
    }
    return { archived: archived.length, archive_root: archived.length ? archiveRoot : undefined, files: archived };
  }

  async pullCloudKnowledgeProjections(reason = "manual") {
    if (!this.settings.knowledgeBaseEndpoint) {
      return { rendered: 0, changed: 0, skipped_reason: "knowledge_endpoint_missing" };
    }
    const [objectsPayload, projectionsPayload, aiTurnsPayload] = await Promise.all([
      this.requestCloudKnowledge("objects"),
      this.requestCloudKnowledge("document-projections"),
      this.requestCloudKnowledge("ai-turns"),
    ]);
    const objects = Array.isArray(objectsPayload?.objects) ? objectsPayload.objects : [];
    const projections = Array.isArray(projectionsPayload?.document_projections) ? projectionsPayload.document_projections : [];
    const aiTurns = Array.isArray(aiTurnsPayload?.ai_turns) ? aiTurnsPayload.ai_turns : [];
    const filtered = filterCloudKnowledgeForObsidian(objects, projections);
    const hiddenDocIds = new Set(filtered.skipped_document_ids || []);
    const visibleAiTurns = aiTurns.filter((turn) =>
      !hiddenDocIds.has(turn.document_id) && !isCloudKnowledgeHiddenDoc(turn.document_id, turn.document_title || turn.inference_view?.document_title),
    );
    const files = renderCloudKnowledgeMarkdown(this.settings, filtered.objects, filtered.projections, visibleAiTurns);
    let changed = 0;
    for (const file of files) {
      this.cloudProjectionPaths.add(file.path);
      rememberControlledKnowledgeSignatures(this.controlledKnowledgeSignatures, file.path, file.markdown);
      if (await this.writeRenderedMarkdownFile(file)) changed += 1;
    }
    const staleProjectionArchive = await this.archiveStaleCloudKnowledgeProjections(files);
    const result = {
      schema_version: "inkloop.obsidian_cloud_knowledge_pull.v1",
      reason,
      endpoint: this.settings.knowledgeBaseEndpoint,
      namespace: `${this.runtimeNamespaceSegments().tenantId}/${this.runtimeNamespaceSegments().userId}`,
      ai_turns: visibleAiTurns.length,
      knowledge_objects: objects.length,
      document_projections: projections.length,
      skipped_test_run_objects: filtered.skipped_objects,
      skipped_test_run_document_projections: filtered.skipped_projections,
      skipped_test_run_document_ids: filtered.skipped_document_ids,
      rendered: files.length,
      changed,
      stale_projection_archive: staleProjectionArchive,
      rendered_paths: files.map((file) => file.path).slice(0, 50),
      synced_at: nowIso(),
    };
    await this.writeJson(this.sidecarPath("cloud-knowledge-pull.json"), result);
    return result;
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
      origin: { device_id: this.settings.deviceId || DEFAULT_SETTINGS.deviceId },
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

  async writeRuntimeOutboxEventsPreservingAppends(updatedEvents) {
    const path = this.runtimeOutboxPath();
    const operation = (this.appendQueues.get(path) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const latestEvents = await this.readJsonLines(path);
        await this.writeJsonLines(path, mergeRuntimeOutboxEvents(latestEvents, updatedEvents));
      });
    this.appendQueues.set(path, operation);
    try {
      await operation;
    } finally {
      if (this.appendQueues.get(path) === operation) this.appendQueues.delete(path);
    }
  }

  appliedEventsPath(docId) {
    return this.sidecarPath("docs", docId, "applied-events.jsonl");
  }

  runtimeNamespaceSegments() {
    return {
      tenantId: cleanRuntimeNamespaceSegment(this.settings?.tenantId, DEFAULT_SETTINGS.tenantId),
      userId: cleanRuntimeNamespaceSegment(this.settings?.userId, DEFAULT_SETTINGS.userId),
    };
  }

  legacyCursorPath(deviceId = this.settings.deviceId) {
    const safeDeviceId = cleanRuntimeNamespaceSegment(deviceId, DEFAULT_SETTINGS.deviceId);
    return this.sidecarPath("cursors", `${safeDeviceId}.json`);
  }

  cursorPath(deviceId = this.settings.deviceId) {
    const { tenantId, userId } = this.runtimeNamespaceSegments();
    const safeDeviceId = cleanRuntimeNamespaceSegment(deviceId, DEFAULT_SETTINGS.deviceId);
    return this.sidecarPath("cursors", tenantId, userId, `${safeDeviceId}.json`);
  }

  conflictsPath() {
    return this.sidecarPath("conflicts", "runtime-conflicts.jsonl");
  }

  async readDeviceCursor(deviceId = this.settings.deviceId) {
    const current = await this.readJson(this.cursorPath(deviceId), null);
    if (current) return current;
    const legacy = await this.readJson(this.legacyCursorPath(deviceId), null);
    if (legacy?.cursor !== undefined) {
      const migrated = {
        ...legacy,
        device_id: cleanRuntimeNamespaceSegment(legacy.device_id || deviceId, DEFAULT_SETTINGS.deviceId),
        migrated_from_legacy_cursor: true,
        migrated_at: nowIso(),
      };
      await this.writeJson(this.cursorPath(deviceId), migrated);
      return migrated;
    }
    return null;
  }

  async writeDeviceCursor(cursor) {
    await this.writeJson(this.cursorPath(cursor.device_id), cursor);
  }

  async hasAppliedRuntimeEvent(event) {
    const applied = await this.readJsonLines(this.appliedEventsPath(event.doc_id));
    return applied.some((item) => item.event_id === event.event_id);
  }

  async markAppliedRuntimeEvent(event, extra = {}) {
    const record = { event_id: event.event_id, doc_id: event.doc_id, applied_at: nowIso(), ...extra };
    await this.appendJsonLine(this.appliedEventsPath(event.doc_id), record);
    await this.appendJsonLine(this.sidecarPath("applied-events.jsonl"), record);
  }

  async recordRuntimeConflict(event, error) {
    const conflict = {
      conflict_id: `conflict_${event.event_id}_${Date.now().toString(36)}`,
      event_id: event.event_id,
      doc_id: event.doc_id,
      reason: String(error?.message || error),
      created_at: nowIso(),
      remote_revision: event.source_revision,
    };
    await this.appendJsonLine(this.conflictsPath(), conflict);
    return conflict;
  }

  shouldSkipCloudOnlyAnnotationEvent(event, error) {
    if (!this.settings.knowledgeBaseEndpoint) return false;
    const message = String(error?.message || error);
    if (message === `InkLoop runtime document is missing: ${event.doc_id}`) {
      return event.operation === "annotation.add" || event.operation === "knowledge.update";
    }
    if (event.operation !== "annotation.add") return false;
    const blockId = String(event.payload?.block_id || event.target?.block_id || "");
    return !blockId && message === "Remote annotation block was not found: ";
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
    const blocksPath = documentRecord.source_type === "markdown" ? "markdown.blocks.jsonl" : "pdf.pages.jsonl";
    const blocks = await this.readJsonLines(`${docDir}/surfaces/${blocksPath}`);
    const nodes = await this.readJsonLines(`${docDir}/canvas/nodes.jsonl`);
    const readingProgress = await this.readJson(`${docDir}/progress.json`, null);
    const sourceRevision = await this.readJson(`${docDir}/source-revision.json`, null);
    return { doc_id: docId, docDir, document: documentRecord, source, source_revision: sourceRevision, reading_progress: readingProgress, blocks, nodes };
  }

  async pathExists(path) {
    if (!path) return false;
    if (this.app.vault.getAbstractFileByPath(path)) return true;
    try {
      if (typeof this.app.vault.adapter.stat === "function") return Boolean(await this.app.vault.adapter.stat(path));
      await this.app.vault.adapter.read(path);
      return true;
    } catch {
      return false;
    }
  }

  remoteRuntimeWrapperPath(snapshot) {
    const title = cleanCloudDocumentTitle(snapshot.document?.title || snapshot.doc_id, snapshot.doc_id);
    const mode = runtimeProjectionMode(snapshot);
    return `${cloudKnowledgeFolder(this.settings, title, mode)}/${title}.md`;
  }

  async ensureRemoteRuntimeWrapper(snapshot) {
    const currentPath = snapshot.source?.vault_file?.path;
    const docId = snapshot.doc_id;
    const documentTitle = snapshot.document?.title || currentPath || "";
    if (shouldSkipRuntimeWrapperSnapshot(snapshot)) return snapshot;
    if (isCloudKnowledgeHiddenDoc(docId, documentTitle)) return snapshot;
    const managedCurrentPath = currentPath && currentPath.startsWith(`${this.settings.documentsDir}/`) ? currentPath : "";
    if (currentPath && !managedCurrentPath && await this.pathExists(currentPath)) return snapshot;

    const path = managedCurrentPath || this.remoteRuntimeWrapperPath(snapshot);
    await this.app.vault.adapter.mkdir(path.split("/").slice(0, -1).join("/")).catch(() => {});
    const markdown = renderRuntimeWrapperMarkdown(snapshot);
    const existing = await this.app.vault.adapter.read(path).catch(() => null);
    const existingProjection = existing ? parseProjectionFrontmatter(existing) : {};
    if (existingProjection.inkloop_projection_role === "source_file_unit") {
      return {
        ...snapshot,
        source: {
          ...(snapshot.source || {}),
          vault_file: {
            ...(snapshot.source?.vault_file || {}),
            path,
          },
        },
      };
    }
    if (existing !== markdown) {
      await this.app.vault.adapter.write(path, markdown);
    }

    return {
      ...snapshot,
      source: {
        ...(snapshot.source || {}),
        vault_file: {
          ...(snapshot.source?.vault_file || {}),
          path,
          extension: ".md",
        },
      },
    };
  }

  async ensureRemoteRuntimeWrappersForSidecars() {
    const docsRoot = this.sidecarPath("docs");
    const listing = await this.app.vault.adapter.list(docsRoot).catch(() => null);
    const folders = Array.isArray(listing?.folders) ? listing.folders : [];
    let repaired = 0;
    for (const docDir of folders) {
      const docId = String(docDir || "").split("/").filter(Boolean).at(-1);
      if (!docId) continue;
      const runtime = await this.loadRuntimeDocument(docId);
      if (!runtime?.document || !runtime.source) continue;
      const currentPath = runtime.source?.vault_file?.path || "";
      const documentTitle = runtime.document?.title || currentPath;
      if (isCloudKnowledgeHiddenDoc(docId, documentTitle)) continue;
      const remoteRuntime = runtime.source?.kind !== "obsidian_vault_file" || currentPath.startsWith(`${this.settings.documentsDir}/`);
      if (!remoteRuntime) continue;
      const beforePath = currentPath;
      const beforeExists = beforePath ? await this.pathExists(beforePath) : false;
      const snapshot = await this.ensureRemoteRuntimeWrapper({
        doc_id: docId,
        document: runtime.document,
        source: runtime.source,
        source_revision: runtime.source_revision,
        reading_progress: runtime.reading_progress,
        blocks: runtime.blocks,
        nodes: runtime.nodes,
      });
      const nextPath = snapshot.source?.vault_file?.path;
      if (!nextPath) continue;
      await this.writeJson(`${runtime.docDir}/source.json`, snapshot.source);
      if (nextPath !== beforePath || !beforeExists) repaired += 1;
      await this.upsertPathIndex(nextPath, {
        path: nextPath,
        doc_id: docId,
        source_ref_id: snapshot.source.source_ref_id,
        last_seen_content_hash: snapshot.source_revision?.content_hash,
        last_seen_at: nowIso(),
      });
      await this.upsertDocIndex({
        doc_id: docId,
        title: snapshot.document?.title,
        source_type: snapshot.document?.source_type,
        source_ref_id: snapshot.source.source_ref_id,
        current_path: nextPath,
        updated_at: nowIso(),
      });
    }
    return repaired;
  }

  async writeRuntimeSnapshot(snapshot) {
    snapshot = await this.ensureRemoteRuntimeWrapper(snapshot);
    const docId = snapshot.doc_id;
    const docDir = this.sidecarPath("docs", docId);
    await Promise.all([
      this.app.vault.adapter.mkdir(`${docDir}/surfaces`).catch(() => {}),
      this.app.vault.adapter.mkdir(`${docDir}/canvas`).catch(() => {}),
    ]);
    await this.writeJson(`${docDir}/document.json`, snapshot.document || { doc_id: docId });
    await this.writeJson(`${docDir}/source.json`, snapshot.source || { doc_id: docId });
    if (snapshot.identity) await this.writeJson(`${docDir}/identity.json`, snapshot.identity);
    if (snapshot.source_revision) await this.writeJson(`${docDir}/source-revision.json`, snapshot.source_revision);
    if (snapshot.reading_progress) await this.writeJson(`${docDir}/progress.json`, snapshot.reading_progress);
    const sourceType = snapshot.document?.source_type === "markdown" ? "markdown" : "pdf";
    await this.writeJsonLines(`${docDir}/surfaces/${sourceType === "markdown" ? "markdown.blocks" : "pdf.pages"}.jsonl`, snapshot.blocks || []);
    await this.writeJsonLines(`${docDir}/canvas/nodes.jsonl`, snapshot.nodes || []);
    const path = snapshot.source?.vault_file?.path;
    if (path) {
      await this.upsertPathIndex(path, { path, doc_id: docId, source_ref_id: snapshot.source.source_ref_id, last_seen_content_hash: snapshot.source_revision?.content_hash, last_seen_at: nowIso() });
      await this.upsertDocIndex({ doc_id: docId, title: snapshot.document?.title, source_type: snapshot.document?.source_type, source_ref_id: snapshot.source.source_ref_id, current_path: path, updated_at: nowIso() });
    }
  }

  async writeRuntimeBlocks(runtime, blocks) {
    const blocksPath = runtime.document?.source_type === "markdown" ? "markdown.blocks.jsonl" : "pdf.pages.jsonl";
    await this.writeJsonLines(`${runtime.docDir}/surfaces/${blocksPath}`, blocks);
  }

  async applyRemoteRuntimeEvent(event) {
    if (event.origin?.device_id && event.origin.device_id === this.settings.deviceId) {
      return { status: "skipped", event_id: event.event_id, echo: true };
    }
    if (await this.hasAppliedRuntimeEvent(event)) return { status: "skipped", event_id: event.event_id };
    try {
      await this.applyRemoteRuntimeEventUnchecked(event);
      await this.markAppliedRuntimeEvent(event);
      return { status: "applied", event_id: event.event_id, doc_id: event.doc_id };
    } catch (error) {
      if (this.shouldSkipCloudOnlyAnnotationEvent(event, error)) {
        const skippedReason = "cloud_knowledge_projection_only";
        await this.markAppliedRuntimeEvent(event, { status: "skipped", skipped_reason: skippedReason });
        return { status: "skipped", event_id: event.event_id, doc_id: event.doc_id, skipped_reason: skippedReason };
      }
      const conflict = await this.recordRuntimeConflict(event, error);
      return { status: "conflicted", event_id: event.event_id, doc_id: event.doc_id, conflict };
    }
  }

  async applyRemoteRuntimeEventUnchecked(event) {
    if (event.schema_version !== "inkloop.runtime_sync_event.v1") throw new Error("Unsupported runtime event schema.");
    if (event.operation === "runtime.bootstrap") {
      const snapshot = event.payload?.snapshot;
      if (!snapshot || snapshot.doc_id !== event.doc_id) throw new Error("Remote bootstrap snapshot is missing or mismatched.");
      await this.writeRuntimeSnapshot(snapshot);
      return;
    }

    const runtime = await this.loadRuntimeDocument(event.doc_id);
    if (!runtime) throw new Error(`InkLoop runtime document is missing: ${event.doc_id}`);
    const blockIdOf = (block) => block.projection?.block_id || block.object_id;

    if (event.operation === "block.update") {
      const blockId = String(event.payload?.block_id || event.target?.block_id || event.target?.id || "");
      const index = runtime.blocks.findIndex((block) => blockIdOf(block) === blockId);
      if (index === -1) throw new Error(`Remote block was not found: ${blockId}`);
      const quote = normalizeText(event.payload?.content_md ?? event.payload?.quote ?? "");
      const blocks = [...runtime.blocks];
      blocks[index] = {
        ...blocks[index],
        text: quote,
        source_anchor: { ...(blocks[index].source_anchor || {}), quote, ...(event.payload?.range ? { range: event.payload.range } : {}) },
      };
      await this.writeRuntimeBlocks(runtime, blocks);
      return;
    }

    if (event.operation === "annotation.add") {
      const blockId = String(event.payload?.block_id || event.target?.block_id || "");
      const annotation = event.payload?.annotation;
      if (!annotation?.ko_id) throw new Error("Remote annotation.add is missing annotation payload.");
      const index = runtime.blocks.findIndex((block) => blockIdOf(block) === blockId);
      if (index === -1) throw new Error(`Remote annotation block was not found: ${blockId}`);
      const blocks = [...runtime.blocks];
      const block = blocks[index];
      const annotations = (block.annotations || []).filter((item) => item.ko_id !== annotation.ko_id);
      blocks[index] = {
        ...block,
        annotations: [...annotations, annotation],
        projection: {
          ...(block.projection || {}),
          knowledge_object_ids: [...new Set([...(block.projection?.knowledge_object_ids || []), annotation.ko_id])],
        },
      };
      await this.writeRuntimeBlocks(runtime, blocks);
      return;
    }

    if (event.operation === "annotation.update" || event.operation === "annotation.delete") {
      const koId = String(event.payload?.ko_id || event.target?.id || "");
      if (!koId) throw new Error("Remote annotation event is missing ko_id.");
      let didUpdate = false;
      const blocks = runtime.blocks.map((block) => {
        const annotations = (block.annotations || []).map((annotation) => {
          if (annotation.ko_id !== koId) return annotation;
          didUpdate = true;
          if (event.operation === "annotation.delete") return { ...annotation, status: "deleted", deleted_at: event.updated_at };
          return { ...annotation, ...(event.payload?.patch || {}), updated_at: event.updated_at };
        });
        return { ...block, annotations };
      });
      if (!didUpdate) throw new Error(`Remote annotation was not found: ${koId}`);
      await this.writeRuntimeBlocks(runtime, blocks);
      return;
    }

    if (event.operation === "knowledge.update") {
      const koId = String(event.payload?.ko_id || event.target?.id || "");
      if (!koId) throw new Error("Remote knowledge.update event is missing ko_id.");
      const patch = event.payload?.patch && typeof event.payload.patch === "object" ? event.payload.patch : {};
      let didUpdate = false;
      const blocks = runtime.blocks.map((block) => {
        const annotations = (block.annotations || []).map((annotation) => {
          if (annotation.ko_id !== koId) return annotation;
          didUpdate = true;
          return {
            ...annotation,
            ...(typeof patch.status === "string" ? { status: patch.status } : {}),
            ...(Array.isArray(patch.tags) ? { tags: patch.tags } : {}),
            controlled_fields: { ...(annotation.controlled_fields || {}), ...patch },
            updated_at: event.updated_at,
          };
        });
        return { ...block, annotations };
      });
      if (didUpdate) await this.writeRuntimeBlocks(runtime, blocks);
      return;
    }

    if (event.operation === "progress.update") {
      if (!event.payload?.progress) throw new Error("Remote progress.update is missing progress payload.");
      await this.writeJson(`${runtime.docDir}/progress.json`, event.payload.progress);
      return;
    }

    if (event.operation === "source.rename") {
      const sourcePath = String(event.payload?.source_path || "");
      if (!sourcePath) throw new Error("Remote source.rename is missing source_path.");
      const source = {
        ...runtime.source,
        vault_file: runtime.source.vault_file ? { ...runtime.source.vault_file, path: sourcePath } : { path: sourcePath },
        identity: { ...(runtime.source.identity || {}), source_path: sourcePath, current_path: sourcePath },
      };
      await this.writeJson(`${runtime.docDir}/source.json`, source);
      await this.writeJson(`${runtime.docDir}/source-revision.json`, { ...(runtime.source_revision || {}), source_path: sourcePath, updated_at: event.updated_at });
      return;
    }

    if (event.operation === "canvas.node.add" || event.operation === "canvas.node.delete") {
      const nodeId = String(event.payload?.node_id || event.target?.id || "");
      const nodes = (runtime.nodes || []).filter((node) => String(node.id || node.node_id || "") !== nodeId);
      await this.writeJsonLines(`${runtime.docDir}/canvas/nodes.jsonl`, event.operation === "canvas.node.add" ? [...nodes, event.payload.node].filter(Boolean) : nodes);
      return;
    }

    throw new Error(`Unsupported runtime operation: ${event.operation}`);
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
    void this.rememberDocPreviewSignature(docId, { ...runtime, blocks });
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
    void this.rememberDocPreviewSignature(docId, { ...runtime, blocks });
  }

  async updateControlledKnowledgeProjection(file) {
    if (!file?.path || !/\.md$/i.test(file.path) || !file.path.startsWith(`${this.settings.documentsDir}/`)) return null;
    const markdown = await this.app.vault.cachedRead(file).catch(() => this.app.vault.adapter.read(file.path));
    const changes = controlledKnowledgeEditsSinceBaseline(this.controlledKnowledgeSignatures, file.path, markdown);
    if (!changes.length) return null;
    const events = [];
    for (const change of changes) {
      const { edit } = change;
      beginControlledKnowledgeEdit(this.controlledKnowledgeSignatures, change);
      let event;
      try {
        event = await this.appendRuntimeSyncEvent({
          doc_id: edit.document_id,
          operation: "knowledge.update",
          target: { type: "knowledge_object", id: edit.ko_id },
          payload: {
            ko_id: edit.ko_id,
            kind: edit.kind,
            patch: edit.patch,
            projection_path: file.path,
            source: "obsidian_controlled_fields",
            controlled_schema_version: edit.schema_version,
          },
        });
      } catch (error) {
        rollbackControlledKnowledgeEdit(this.controlledKnowledgeSignatures, change);
        throw error;
      }
      events.push(event);
      this.lastChange = {
        event_type: "inkloop_controlled_knowledge_edit",
        path: file.path,
        doc_id: edit.document_id,
        ko_id: edit.ko_id,
        runtime_event_id: event.event_id,
        observed_at: nowIso(),
      };
    }
    return events.at(-1) || null;
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
    void this.rememberDocPreviewSignature(docId, { ...runtime, blocks });
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
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.settings.baseDir = cleanDir(this.settings.baseDir, DEFAULT_SETTINGS.baseDir);
    this.settings.documentsDir = cleanDir(this.settings.documentsDir, DEFAULT_SETTINGS.documentsDir);
    this.settings.syncEndpoint = cleanLegacySyncEndpoint(this.settings.syncEndpoint);
    this.settings.runtimePushEndpoint = String(this.settings.runtimePushEndpoint || "").trim();
    this.settings.runtimePullEndpoint = String(this.settings.runtimePullEndpoint || "").trim();
    this.settings.knowledgeBaseEndpoint = cleanEndpoint(this.settings.knowledgeBaseEndpoint);
    this.settings.deviceCommandEndpoint = deriveDeviceCommandEndpoint(this.settings);
    this.settings.tenantId = cleanRuntimeNamespaceSegment(this.settings.tenantId, DEFAULT_SETTINGS.tenantId);
    this.settings.userId = cleanRuntimeNamespaceSegment(this.settings.userId, DEFAULT_SETTINGS.userId);
    this.settings.sessionToken = String(this.settings.sessionToken || "").trim();
    const loadedDeviceId = String(loaded?.deviceId || "").trim();
    this.settings.deviceId = normalizeRuntimeDeviceId(loadedDeviceId, "obsidian");
    this.settings.autoSyncOnChange = this.settings.autoSyncOnChange !== false;
    this.settings.notifyManualSync = this.settings.notifyManualSync !== false;
    this.settings.visualEnhancement = this.settings.visualEnhancement !== false;
    this.settings.debounceMs = Math.max(100, Number(this.settings.debounceMs) || DEFAULT_SETTINGS.debounceMs);
    this.settings.runtimePollMs = normalizeRuntimePollMs(this.settings.runtimePollMs);
    this.settings.previewEditing = false;
    this.settings.surfaceMode = this.settings.surfaceMode === "focus" ? "focus" : "thinking";
    this.settings.inkTool = normalizeInkTool(this.settings.inkTool);
    this.settings.inkColors = {
      pen: normalizeHexColor(this.settings.inkColors?.pen, DEFAULT_SETTINGS.inkColors.pen),
      highlighter: normalizeHexColor(this.settings.inkColors?.highlighter, DEFAULT_SETTINGS.inkColors.highlighter),
    };
    if (this.settings.deviceId !== loadedDeviceId) await this.saveData(this.settings);
  }

  async saveSettings() {
    this.settings.baseDir = cleanDir(this.settings.baseDir, DEFAULT_SETTINGS.baseDir);
    this.settings.documentsDir = cleanDir(this.settings.documentsDir, DEFAULT_SETTINGS.documentsDir);
    this.settings.syncEndpoint = cleanLegacySyncEndpoint(this.settings.syncEndpoint);
    this.settings.runtimePushEndpoint = String(this.settings.runtimePushEndpoint || "").trim();
    this.settings.runtimePullEndpoint = String(this.settings.runtimePullEndpoint || "").trim();
    this.settings.knowledgeBaseEndpoint = cleanEndpoint(this.settings.knowledgeBaseEndpoint);
    this.settings.deviceCommandEndpoint = deriveDeviceCommandEndpoint(this.settings);
    this.settings.tenantId = cleanRuntimeNamespaceSegment(this.settings.tenantId, DEFAULT_SETTINGS.tenantId);
    this.settings.userId = cleanRuntimeNamespaceSegment(this.settings.userId, DEFAULT_SETTINGS.userId);
    this.settings.sessionToken = String(this.settings.sessionToken || "").trim();
    this.settings.deviceId = normalizeRuntimeDeviceId(this.settings.deviceId, "obsidian");
    this.settings.autoSyncOnChange = this.settings.autoSyncOnChange !== false;
    this.settings.notifyManualSync = this.settings.notifyManualSync !== false;
    this.settings.visualEnhancement = this.settings.visualEnhancement !== false;
    this.settings.debounceMs = Math.max(100, Number(this.settings.debounceMs) || DEFAULT_SETTINGS.debounceMs);
    this.settings.runtimePollMs = normalizeRuntimePollMs(this.settings.runtimePollMs);
    this.settings.surfaceMode = this.settings.surfaceMode === "focus" ? "focus" : "thinking";
    this.settings.inkTool = normalizeInkTool(this.settings.inkTool);
    this.settings.inkColors = {
      pen: normalizeHexColor(this.settings.inkColors?.pen, DEFAULT_SETTINGS.inkColors.pen),
      highlighter: normalizeHexColor(this.settings.inkColors?.highlighter, DEFAULT_SETTINGS.inkColors.highlighter),
    };
    this.statusPath = `${this.settings.baseDir}/.obsidian-plugin-status.json`;
    await this.saveData(this.settings);
    this.startRuntimePolling?.();
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
    const managedProjection = eventType === "modify" ? await this.isCloudKnowledgeProjectionFile(file) : false;
    const controlledEvent = eventType === "modify" ? await this.updateControlledKnowledgeProjection(file) : null;
    if (managedProjection && !controlledEvent) return;
    const refreshDocId = trackedDocId || oldTrackedDocId || sidecarDocId || oldSidecarDocId || controlledEvent?.doc_id;
    this.lastChange = {
      event_type: controlledEvent ? "inkloop_controlled_knowledge_edit" : eventType,
      path: file.path,
      old_path: oldPath,
      doc_id: refreshDocId || undefined,
      runtime_event_id: controlledEvent?.event_id,
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

  async isCloudKnowledgeProjectionFile(file) {
    if (!file?.path || !/\.md$/i.test(file.path) || !file.path.startsWith(`${this.settings.documentsDir}/`)) return false;
    if (this.cloudProjectionPaths.has(file.path)) return true;
    const markdown = await this.app.vault.cachedRead(file).catch(() => this.app.vault.adapter.read(file.path));
    return isCloudKnowledgeProjectionMarkdown(markdown);
  }

  startRuntimePolling() {
    if (this.runtimePollTimer) window.clearInterval(this.runtimePollTimer);
    this.runtimePollTimer = null;
    const pollMs = normalizeRuntimePollMs(this.settings.runtimePollMs);
    if (pollMs <= 0 || !this.settings.runtimePullEndpoint) return;
    this.runtimePollTimer = window.setInterval(() => {
      void this.pollRuntimeInbox();
    }, pollMs);
    this.registerInterval?.(this.runtimePollTimer);
  }

  async pollRuntimeInbox() {
    if (this.runtimePollInFlight || !this.settings.runtimePullEndpoint) return;
    this.runtimePollInFlight = true;
    try {
      const previousError = this.lastRuntimePollError;
      const pull = await this.pullRuntimeInbox();
      const cloudKnowledge = await this.pullCloudKnowledgeProjections("runtime_poll");
      this.lastRuntimePollError = null;
      if (pull.received > 0 || pull.applied > 0 || pull.conflicted > 0 || cloudKnowledge.changed > 0 || previousError) {
        await this.writeStatus({
          status: pull.conflicted > 0 ? "sync_completed_with_conflicts" : "sync_completed",
          reason: "runtime_poll",
          error: null,
          pull,
          cloudKnowledge,
          synced_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      const message = String(error?.message || error);
      if (message !== this.lastRuntimePollError) {
        this.lastRuntimePollError = message;
        await this.writeStatus({
          status: "sync_failed",
          reason: "runtime_poll",
          error: message,
          synced_at: new Date().toISOString(),
        });
      }
    } finally {
      this.runtimePollInFlight = false;
    }
  }

  runtimeOutboxPath() {
    return this.sidecarPath("outbox", "runtime-events.jsonl");
  }

  async pushRuntimeOutbox(reason) {
    if (!this.settings.runtimePushEndpoint) {
      return { scanned: 0, eligible: 0, sent: 0, failed: 0, skipped: 0, attempted_event_ids: [], skipped_reason: "push_endpoint_missing" };
    }
    const now = nowIso();
    const events = await this.readJsonLines(this.runtimeOutboxPath());
    const eligibleIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => shouldAttemptRuntimeEvent(event, now));
    if (!eligibleIndexes.length) {
      return { scanned: events.length, eligible: 0, sent: 0, failed: 0, skipped: events.length, attempted_event_ids: [] };
    }

    let payload = null;
    let requestError = null;
    try {
      const response = await requestUrl({
        url: this.settings.runtimePushEndpoint,
        method: "POST",
        contentType: "application/json",
        headers: runtimeNamespaceHeaders(this.settings),
        body: JSON.stringify({
          schema_version: "inkloop.runtime_sync_batch.v1",
          device_id: this.settings.deviceId,
          reason,
          events: eligibleIndexes.map(({ event }) => event),
        }),
      });
      payload = typeof response.json === "object" ? response.json : JSON.parse(response.text || "{}");
      if (!Array.isArray(payload.acks) || !payload.acks.every(isRuntimeAck)) throw new Error("Runtime sync push response must include valid acks.");
    } catch (error) {
      requestError = String(error?.message || error);
      payload = { acks: eligibleIndexes.map(({ event }) => ({ event_id: event.event_id, ok: false, error: requestError })) };
    }

    const ackById = new Map(payload.acks.map((ack) => [ack.event_id, ack]));
    let sent = 0;
    let failed = 0;
    const nextEvents = events.map((event, index) => {
      const selected = eligibleIndexes.some((item) => item.index === index);
      if (!selected) return event;
      const ack = ackById.get(event.event_id) || { ok: false, error: "missing runtime sync ack" };
      if (ack.ok) {
        sent += 1;
        return {
          ...event,
          status: "sent",
          attempt_count: (event.attempt_count || 0) + 1,
          sent_at: now,
          updated_at: now,
          ack_id: ack.ack_id,
          server_sequence: ack.server_sequence,
          last_error: undefined,
          next_retry_at: undefined,
        };
      }
      failed += 1;
      return {
        ...event,
        status: "failed",
        attempt_count: (event.attempt_count || 0) + 1,
        last_error: String(ack.error || requestError || "runtime sync push failed"),
        next_retry_at: nextRuntimeRetryAt(now),
        updated_at: now,
      };
    });
    await this.writeRuntimeOutboxEventsPreservingAppends(nextEvents);
    return {
      scanned: events.length,
      eligible: eligibleIndexes.length,
      sent,
      failed,
      skipped: events.length - eligibleIndexes.length,
      attempted_event_ids: eligibleIndexes.map(({ event }) => event.event_id),
    };
  }

  async pullRuntimeInbox() {
    const deviceId = this.settings.deviceId || DEFAULT_SETTINGS.deviceId;
    if (!this.settings.runtimePullEndpoint) {
      return { device_id: deviceId, received: 0, applied: 0, skipped: 0, conflicted: 0, skipped_reason: "pull_endpoint_missing" };
    }
    const cursor = await this.readDeviceCursor(deviceId);
    const response = await requestUrl({
      url: appendQuery(this.settings.runtimePullEndpoint, { device_id: deviceId, cursor: cursor?.cursor, limit: 100 }),
      method: "GET",
      headers: runtimeNamespaceHeaders(this.settings),
    });
    const payload = typeof response.json === "object" ? response.json : JSON.parse(response.text || "{}");
    assertRuntimePullPayload(payload);

    const result = {
      device_id: deviceId,
      previous_cursor: cursor?.cursor,
      next_cursor: payload.next_cursor,
      received: payload.events.length,
      applied: 0,
      skipped: 0,
      conflicted: 0,
      applied_event_ids: [],
      skipped_event_ids: [],
      conflict_event_ids: [],
    };
    const changedDocIds = new Set();
    for (const event of payload.events) {
      const applied = await this.applyRemoteRuntimeEvent(event);
      if (applied.status === "applied") {
        result.applied += 1;
        result.applied_event_ids.push(event.event_id);
        changedDocIds.add(event.doc_id);
      } else if (applied.status === "skipped") {
        result.skipped += 1;
        result.skipped_event_ids.push(event.event_id);
      } else {
        result.conflicted += 1;
        result.conflict_event_ids.push(event.event_id);
      }
    }
    if (result.conflicted === 0) {
      await this.writeDeviceCursor({ device_id: deviceId, cursor: payload.next_cursor, updated_at: nowIso() });
      result.next_cursor = payload.next_cursor;
      result.cursor_advanced = cursor?.cursor !== payload.next_cursor;
      result.cursor_blocked_by_conflicts = false;
    } else {
      result.next_cursor = cursor?.cursor || "0";
      result.server_next_cursor = payload.next_cursor;
      result.cursor_advanced = false;
      result.cursor_blocked_by_conflicts = true;
    }
    for (const docId of changedDocIds) await this.refreshDocPreview(docId);
    return result;
  }

  async legacyWakeSync(reason) {
    if (!this.settings.syncEndpoint) return null;
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
    return typeof response.json === "object" ? response.json : {};
  }

  async syncNow(reason, options = {}) {
    const shouldNotify = options.notify ?? false;
    if (!this.settings.runtimePushEndpoint && !this.settings.runtimePullEndpoint && !this.settings.syncEndpoint) {
      if (shouldNotify) new Notice("InkLoop runtime sync endpoint is not configured");
      await this.writeStatus({ status: "sync_skipped", reason, last_change: this.lastChange });
      return;
    }

    const started = performance.now();
    await this.writeStatus({ status: "sync_started", reason, last_change: this.lastChange, sync_started_at: new Date().toISOString() });
    try {
      const push = await this.pushRuntimeOutbox(reason);
      const pull = await this.pullRuntimeInbox();
      const cloudKnowledge = await this.pullCloudKnowledgeProjections(reason);
      const legacy = (!this.settings.runtimePushEndpoint && !this.settings.runtimePullEndpoint) ? await this.legacyWakeSync(reason) : null;
      const latency = Math.round(performance.now() - started);
      const hardFailed = push.failed > 0 || legacy?.ok === false;
      const hasConflicts = pull.conflicted > 0;
      if (shouldNotify) {
        const message = hardFailed
          ? `InkLoop runtime sync needs attention (${latency}ms)`
          : hasConflicts
            ? `InkLoop runtime sync completed with conflicts (${latency}ms)`
            : `InkLoop runtime sync completed in ${latency}ms`;
        new Notice(message);
      }
      await this.writeStatus({
        status: hardFailed ? "sync_failed" : hasConflicts ? "sync_completed_with_conflicts" : "sync_completed",
        reason,
        last_change: this.lastChange,
        latency_ms: latency,
        push,
        pull,
        cloudKnowledge,
        legacy,
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
      if (shouldNotify) new Notice(`InkLoop sync failed: ${String(error?.message || error)}`);
    }
  }

  async writeStatus(patch) {
    const base = {
      plugin_id: "inkloop-sync",
      documents_dir: this.settings.documentsDir,
      base_dir: this.settings.baseDir,
      sync_endpoint: this.settings.syncEndpoint,
      runtime_push_endpoint: this.settings.runtimePushEndpoint,
      runtime_pull_endpoint: this.settings.runtimePullEndpoint,
      knowledge_base_endpoint: this.settings.knowledgeBaseEndpoint,
      runtime_cursor_namespace: `${this.runtimeNamespaceSegments().tenantId}/${this.runtimeNamespaceSegments().userId}/${this.settings.deviceId || DEFAULT_SETTINGS.deviceId}`,
      device_id: this.settings.deviceId,
      auto_sync_on_change: this.settings.autoSyncOnChange,
      debounce_ms: this.settings.debounceMs,
      runtime_poll_ms: this.settings.runtimePollMs,
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
        if (runtime?.blocks?.length) {
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
      path.style.setProperty("stroke", this.inkColor(tool));
      path.setAttribute("stroke-opacity", String(this.inkOpacity(tool)));
      path.style.setProperty("stroke-opacity", String(this.inkOpacity(tool)));
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
      if (node.payload?.color) {
        path.setAttribute("stroke", node.payload.color);
        path.style.setProperty("stroke", node.payload.color);
      }
      if (node.payload?.opacity !== undefined) {
        path.setAttribute("stroke-opacity", String(node.payload.opacity));
        path.style.setProperty("stroke-opacity", String(node.payload.opacity));
      }
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
      path.style.setProperty("stroke", this.plugin.inkColor("pen"));
      path.setAttribute("stroke-opacity", String(this.plugin.inkOpacity("pen")));
      path.style.setProperty("stroke-opacity", String(this.plugin.inkOpacity("pen")));
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

  renderV1BoundaryPanel(containerEl) {
    const panel = containerEl.createDiv({ cls: "inkloop-v1-boundary-card" });
    panel.createEl("h3", { text: "InkLoop AI Pen V1 boundary" });
    panel.createEl("p", {
      text: "Obsidian is a projection surface. Reading documents show source-linked highlights, handwritten thoughts, AI brush responses, and review-later items. Meeting documents use a separate folder and show meeting marks, tasks, decisions, and risks only when the source document is a meeting session.",
    });

    const rows = panel.createDiv({ cls: "inkloop-v1-boundary-grid" });
    for (const item of [
      ["Product role", "Source-linked knowledge projection"],
      ["Reading output", "Highlights / reading notes / handwritten thoughts / AI brush responses"],
      ["Meeting output", "Meeting marks / tasks / decisions / risks, only under InkLoop/Meetings"],
      ["Source unit", "Reading documents and meeting sessions stay grouped separately by inkloop://doc/..."],
      ["Runtime state", "Hidden sidecar runtime sync"],
      ["Backlinks", "inkloop://doc/... keeps jump-back to the InkLoop source"],
      ["Preview editing", `previewEditing=${this.plugin.settings.previewEditing === true ? "true" : "false"}`],
      ["Runtime push", this.plugin.settings.runtimePushEndpoint || "not configured"],
      ["Runtime pull", this.plugin.settings.runtimePullEndpoint || "not configured"],
      ["Cloud Knowledge", this.plugin.settings.knowledgeBaseEndpoint || "not configured"],
      ["Runtime namespace", `${this.plugin.settings.tenantId || DEFAULT_SETTINGS.tenantId}/${this.plugin.settings.userId || DEFAULT_SETTINGS.userId}`],
    ]) {
      const row = rows.createDiv({ cls: "inkloop-v1-boundary-row" });
      row.createEl("span", { text: item[0] });
      row.createEl("strong", { text: item[1] });
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.replaceChildren();
    containerEl.createEl("h2", { text: "InkLoop Sync" });
    this.renderV1BoundaryPanel(containerEl);

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
      .setName("Runtime device id")
      .setDesc("Stable local device id used for runtime sync echo suppression and cursor tracking.")
      .addText((text) => text
        .setPlaceholder("auto-generated")
        .setValue(this.plugin.settings.deviceId)
        .onChange(async (value) => {
          this.plugin.settings.deviceId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Runtime tenant")
      .setDesc("Tenant namespace used by Runtime Sync and Cloud Hub.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.tenantId)
        .setValue(this.plugin.settings.tenantId)
        .onChange(async (value) => {
          this.plugin.settings.tenantId = cleanRuntimeNamespaceSegment(value, DEFAULT_SETTINGS.tenantId);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Runtime user")
      .setDesc("User namespace used by Runtime Sync and Cloud Hub.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.userId)
        .setValue(this.plugin.settings.userId)
        .onChange(async (value) => {
          this.plugin.settings.userId = cleanRuntimeNamespaceSegment(value, DEFAULT_SETTINGS.userId);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Runtime push endpoint")
      .setDesc("Canonical runtime sync endpoint for pushing local Obsidian sidecar events.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.runtimePushEndpoint)
        .setValue(this.plugin.settings.runtimePushEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.runtimePushEndpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Runtime pull endpoint")
      .setDesc("Canonical runtime sync endpoint for pulling remote Web/WebView/InkLoop Paper events into hidden sidecars.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.runtimePullEndpoint)
        .setValue(this.plugin.settings.runtimePullEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.runtimePullEndpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Cloud Knowledge endpoint")
      .setDesc("Cloud Hub endpoint for rendering reviewed ai_turn, KnowledgeObject, and DocumentProjection Markdown into Obsidian.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.knowledgeBaseEndpoint)
        .setValue(this.plugin.settings.knowledgeBaseEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.knowledgeBaseEndpoint = cleanEndpoint(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Device command endpoint")
      .setDesc("Cloud Hub endpoint used by inkloop://doc links to open the source on the bound InkLoop Paper device.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.deviceCommandEndpoint)
        .setValue(this.plugin.settings.deviceCommandEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.deviceCommandEndpoint = cleanEndpoint(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Legacy wake endpoint")
      .setDesc("Compatibility endpoint only. Runtime sync uses push/pull above; leave this empty unless a legacy lab flow needs it.")
      .addText((text) => text
        .setPlaceholder("leave empty")
        .setValue(this.plugin.settings.syncEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.syncEndpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Auto-sync on change")
      .setDesc("Run runtime push/pull after Obsidian saves, renames, or deletes InkLoop files.")
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
        .setPlaceholder(String(DEFAULT_SETTINGS.debounceMs))
        .setValue(String(this.plugin.settings.debounceMs))
        .onChange(async (value) => {
          this.plugin.settings.debounceMs = Math.max(100, Number(value) || DEFAULT_SETTINGS.debounceMs);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Runtime pull interval")
      .setDesc("Milliseconds between background runtime pulls. Set to 0 to disable polling.")
      .addText((text) => text
        .setPlaceholder(String(DEFAULT_SETTINGS.runtimePollMs))
        .setValue(String(this.plugin.settings.runtimePollMs))
        .onChange(async (value) => {
          this.plugin.settings.runtimePollMs = normalizeRuntimePollMs(value);
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
