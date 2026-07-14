import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const pluginId = 'inkloop-sync';
const sourceDir = path.join('plugins', 'obsidian', pluginId);
const distDir = path.join('dist', 'obsidian-plugin', pluginId);
const failures = [];
const checked = [];

function absolute(relativePath) {
  return path.resolve(root, relativePath);
}

function note(message) {
  checked.push(message);
}

function fail(message) {
  failures.push(message);
}

function mustExist(relativePath, label = relativePath) {
  if (!existsSync(absolute(relativePath))) {
    fail(`missing ${label}: ${relativePath}`);
    return false;
  }
  return true;
}

function readText(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readAbsoluteJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function hashFile(relativePath) {
  return createHash('sha256').update(readFileSync(absolute(relativePath))).digest('hex');
}

function requireIncludes(relativePath, needles) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${relativePath} does not include required text: ${needle}`);
  }
  note(`${relativePath}: required Obsidian V1 text present`);
}

function requireNotIncludes(relativePath, needles) {
  if (!mustExist(relativePath)) return;
  const text = readText(relativePath);
  for (const needle of needles) {
    if (text.includes(needle)) fail(`${relativePath} includes stale or misleading text: ${needle}`);
  }
  note(`${relativePath}: stale Obsidian V1 text absent`);
}

function requireSameFile(left, right, label) {
  if (!mustExist(left) || !mustExist(right)) return;
  if (hashFile(left) !== hashFile(right)) fail(`${label} differs: ${left} vs ${right}`);
  else note(`${label}: source and dist match`);
}

function verifyManifest() {
  const sourceManifestPath = path.join(sourceDir, 'manifest.json');
  const distManifestPath = path.join(distDir, 'manifest.json');
  if (!mustExist(sourceManifestPath, 'source Obsidian manifest') || !mustExist(distManifestPath, 'dist Obsidian manifest')) return;

  const sourceManifest = readJson(sourceManifestPath);
  const distManifest = readJson(distManifestPath);
  for (const field of ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly']) {
    if (sourceManifest[field] !== distManifest[field]) fail(`manifest field differs between source and dist: ${field}`);
  }
  if (sourceManifest.id !== pluginId) fail(`manifest id must be ${pluginId}`);
  if (sourceManifest.isDesktopOnly !== true) fail('Obsidian plugin must remain desktop-only for the current runtime host');
  for (const phrase of ['runtime sidecar sync', 'AI Pen knowledge projection', 'native Markdown/PDF files']) {
    if (!String(sourceManifest.description || '').includes(phrase)) fail(`manifest description missing: ${phrase}`);
  }
  note('Obsidian source/dist manifests match AI Pen V1 projection boundary');
}

function verifyPackageFiles() {
  for (const file of ['manifest.json', 'main.js', 'styles.css']) {
    requireSameFile(path.join(sourceDir, file), path.join(distDir, file), `Obsidian plugin ${file}`);
  }
  requireSameFile('dist/inkloop-surface-sdk.iife.js', path.join(distDir, 'inkloop-surface-sdk.iife.js'), 'Obsidian packaged SDK IIFE');
}

function verifyRuntimeSyncBoundary() {
  for (const file of [path.join(sourceDir, 'main.js'), path.join(distDir, 'main.js')]) {
    requireIncludes(file, [
      'InkLoop AI Pen V1 boundary',
      'Obsidian is a projection surface',
      'Reading documents show source-linked highlights, handwritten thoughts, AI brush responses, and review-later items',
      'Meeting documents use a separate folder',
      'Meeting output',
      'Meeting marks / tasks / decisions / risks, only under InkLoop/Meetings',
      'Reading output',
      'Highlights / reading notes / handwritten thoughts / AI brush responses',
      'Source unit',
      'Reading documents and meeting sessions stay grouped separately by inkloop://doc/...',
      'Source-linked knowledge projection',
      'Hidden sidecar runtime sync',
      'previewEditing=',
      'runtimePushEndpoint: "http://127.0.0.1:8731/v1/runtime/events:push"',
      'runtimePullEndpoint: "http://127.0.0.1:8731/v1/runtime/events:pull"',
      'knowledgeBaseEndpoint: "http://127.0.0.1:8731/v1/knowledge"',
      'Cloud Knowledge endpoint',
      'function svgForAnnotation',
      'inkloop-cloud-mark-layer',
      '.normalize("NFKC")',
      'renderCloudKnowledgeMarkdown',
      'renderReadingSnapshotBoard',
      'inkloop-snapshot-board',
      'pullCloudKnowledgeProjections',
      'inkloop.obsidian_cloud_knowledge_pull.v1',
      'archiveStaleCloudKnowledgeProjections',
      'inkloop.archived_stale_projection.v1',
      'stale_projection_archive',
      'stale_cloud_knowledge_projection_path',
      'kind === "meeting_action"',
      'kind === "meeting_decision"',
      'kind === "meeting_risk"',
      'previewEditing: false',
      '<!-- inkloop:controlled-fields v1 -->',
      'parseControlledKnowledgeEdit',
      'knowledge.update',
      'inkloop_controlled_knowledge_edit',
      'controlled_schema_version',
      'seedControlledKnowledgeSignaturesFromVault',
      'rememberControlledKnowledgeSignatures',
      'isCloudKnowledgeProjectionMarkdown',
      'if (managedProjection && !controlledEvent) return',
      'const shouldNotify = options.notify ?? false',
      'inkloop_projection_id',
      'origin: { device_id',
      'runtimeNamespaceSegments',
      'legacyCursorPath',
      'migrated_from_legacy_cursor',
      'shouldSkipCloudOnlyAnnotationEvent',
      'event.operation === "annotation.add" || event.operation === "knowledge.update"',
      'cloud_knowledge_projection_only',
      'sync_completed_with_conflicts',
      'cursor_blocked_by_conflicts',
      'const hardFailed = push.failed > 0 || legacy?.ok === false',
      'const hasConflicts = pull.conflicted > 0',
      'status: hardFailed ? "sync_failed" : hasConflicts ? "sync_completed_with_conflicts" : "sync_completed"',
      'sidecar_location: "vault_hidden"',
      'inkloop_runtime_version: "sidecar-runtime.v1"',
      'commit_target: { type: "sidecar_only" }',
      'Canonical runtime sync endpoint for pushing local Obsidian sidecar events.',
      'Canonical runtime sync endpoint for pulling remote Web/WebView/InkLoop Paper events into hidden sidecars.',
      'Runtime sync uses push/pull above',
      'Cloud Hub endpoint for rendering reviewed ai_turn, KnowledgeObject, and DocumentProjection Markdown into Obsidian.',
    ]);
    requireNotIncludes(file, [
      'Obsidian is the capture truth source',
      'Pre-Launch / Notify me',
      'Launch Ops Queue',
      'Launch Freeze Go/No-Go',
      'reverse-parse arbitrary Markdown',
      'reverse parse arbitrary Markdown',
      'whole-vault release is the canonical sync path',
      'const failed = push.failed > 0 || pull.conflicted > 0',
      'status: failed ? "sync_failed" : "sync_completed"',
      'cursor_advanced_despite_conflicts',
    ]);
  }
}

function loadPluginCloudRenderer() {
  const source = readText(path.join(sourceDir, 'main.js'));
  const start = source.indexOf('function normalizeText');
  const end = source.indexOf('module.exports = class');
  if (start < 0 || end < 0 || end <= start) {
    fail('could not locate Obsidian plugin Cloud Knowledge renderer functions');
    return null;
  }
  try {
    const controlledConstants = `
const CONTROLLED_FIELDS_MARKER = "<!-- inkloop:controlled-fields v1 -->";
const KNOWLEDGE_STATUSES = new Set(["inbox", "accepted", "edited", "follow_up", "dismissed", "export_ready", "exported", "archived"]);
const RISK_STATUSES = new Set(["open", "watching", "mitigated", "closed"]);
`;
    return new Function(`${controlledConstants}\n${source.slice(start, end)}\nreturn { renderCloudKnowledgeMarkdown, rememberControlledKnowledgeSignatures, controlledKnowledgeEditsSinceBaseline, beginControlledKnowledgeEdit, rollbackControlledKnowledgeEdit, isCloudKnowledgeProjectionMarkdown };`)();
  } catch (error) {
    fail(`could not evaluate Obsidian plugin Cloud Knowledge renderer: ${String(error?.message || error)}`);
    return null;
  }
}

function verifyCloudProjectionWritesDoNotBecomeControlledEdits() {
  const renderer = loadPluginCloudRenderer();
  if (!renderer) return;
  const signatures = new Map();
  const filePath = 'InkLoop/Reading/Test/Test.md';
  const markdown = `---
inkloop_document_id: "doc_test"
inkloop_knowledge_object_id: "ko_test"
inkloop_knowledge_kind: "reading_note"
---

<!-- inkloop:controlled-fields v1 -->
- Status: accepted
- Tags: inkloop, reading
`;
  renderer.rememberControlledKnowledgeSignatures(signatures, filePath, markdown);
  if (!renderer.isCloudKnowledgeProjectionMarkdown(markdown)) {
    fail('Cloud Knowledge Markdown was not recognized as a managed projection');
  }
  const unchanged = renderer.controlledKnowledgeEditsSinceBaseline(signatures, filePath, markdown);
  if (unchanged.length !== 0) fail('Cloud-rendered controlled fields were incorrectly emitted as user edits');

  const edited = markdown.replace('- Status: accepted', '- Status: archived');
  const changed = renderer.controlledKnowledgeEditsSinceBaseline(signatures, filePath, edited);
  if (changed.length !== 1 || changed[0].edit.patch.status !== 'archived') {
    fail('A real user controlled-field edit was not emitted after projection baseline seeding');
  }
  renderer.beginControlledKnowledgeEdit(signatures, changed[0]);
  if (renderer.controlledKnowledgeEditsSinceBaseline(signatures, filePath, edited).length !== 0) {
    fail('An in-flight controlled-field edit was emitted more than once');
  }
  renderer.rollbackControlledKnowledgeEdit(signatures, changed[0]);
  if (renderer.controlledKnowledgeEditsSinceBaseline(signatures, filePath, edited).length !== 1) {
    fail('A failed controlled-field edit could not be retried after signature rollback');
  }
  note('Cloud-rendered controlled fields are baselined, deduplicated in flight, and retried after failure');
}

function verifyCloudKnowledgeMeetingHubRendersKoWithoutQuote() {
  const renderer = loadPluginCloudRenderer();
  if (!renderer) return;
  const docId = 'mtgdoc_verify_meeting_hub';
  const files = renderer.renderCloudKnowledgeMarkdown({ documentsDir: 'InkLoop' }, [{
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: 'ko_verify_meeting_decision',
    kind: 'meeting_decision',
    title: 'Decision: Web 导入、墨水屏标记、Obsidian 投影',
    body_md: 'Web 导入、墨水屏标记、Obsidian 投影作为 V1 演示闭环。',
    source: {
      document_id: docId,
      document_title: 'InkLoop V1 Meeting Demo',
      object_refs: ['evt_verify_meeting_decision'],
      inkloop_uri: `inkloop://doc/${docId}/page/0?anchor=evt_verify_meeting_decision`,
    },
    provenance: { created_from: 'mark', mark_ids: ['evt_verify_meeting_decision'] },
    tags: ['inkloop', 'inkloop/meeting-decision'],
    status: 'export_ready',
    privacy: 'export_allowed',
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
    controlled_fields: {},
  }], [{
    schema_version: 'inkloop.document_projection.v1',
    projection_id: `dp_${docId}`,
    document_id: docId,
    document_title: 'InkLoop V1 Meeting Demo',
    document_uri: `inkloop://doc/${docId}`,
    blocks: [{
      kind: 'heading',
      text_md: '（这段附近没有转写）　〔0:00–0:10〕',
      knowledge_object_ids: ['ko_verify_meeting_decision'],
    }],
  }], []);
  const hub = files.find((file) => file.path === 'InkLoop/Meetings/InkLoop V1 Meeting Demo/InkLoop V1 Meeting Demo.md');
  if (!hub) {
    fail('Cloud Knowledge renderer did not create the meeting hub file');
    return;
  }
  for (const needle of [
    '## 原始文字记录',
    '## InkLoop 手写记录',
    '## 后处理结果',
    'Decision: Web 导入、墨水屏标记、Obsidian 投影',
    'Web 导入、墨水屏标记、Obsidian 投影作为 V1 演示闭环。',
    `inkloop://doc/${docId}/page/0?anchor=evt_verify_meeting_decision`,
  ]) {
    if (!hub.markdown.includes(needle)) fail(`Cloud Knowledge meeting hub missing rendered KO content: ${needle}`);
  }
  if (hub.markdown.includes('## 会议标记')) fail('Cloud Knowledge meeting hub still uses the old meeting mark section');
  if (hub.markdown.includes('暂无有效标记。')) fail('Cloud Knowledge meeting hub incorrectly rendered empty state despite a valid KO without quote');
  note('Cloud Knowledge meeting hub renders meeting KO content even when source.quote is absent');
}

function verifyCloudKnowledgeReadingHubUsesProjectionAnnotationBody() {
  const renderer = loadPluginCloudRenderer();
  if (!renderer) return;
  const docId = 'doc_verify_reading_annotation_body';
  const files = renderer.renderCloudKnowledgeMarkdown({ documentsDir: 'InkLoop' }, [{
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: 'ko_verify_reading_note',
    kind: 'reading_note',
    title: 'AI时代的UX范式.pdf · p1',
    body_md: '这是读者在 PDF 上的页面引用/标注记录，不是对 AI 的提问或指令。',
    source: {
      document_id: docId,
      document_title: 'AI时代的UX范式.pdf',
      quote: 'AI时代的UX范式.pdf · p1',
      object_refs: ['evt_verify_reading_note'],
      inkloop_uri: `inkloop://doc/${docId}?anchor=evt_verify_reading_note`,
    },
    provenance: { created_from: 'mark', mark_ids: ['evt_verify_reading_note'] },
    tags: ['inkloop', 'inkloop/reading-note'],
    status: 'inbox',
    privacy: 'export_allowed',
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
    controlled_fields: {},
  }, {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: 'ko_verify_plain_ink_snapshot',
    kind: 'reading_note',
    title: 'AI时代的UX范式.pdf · p1',
    body_md: `AI时代的UX范式.pdf · p1\n\nMarked evidence: 不断成长。\n\nBacklink: inkloop://doc/${docId}/page/1?anchor=evt_verify_plain_ink`,
    source: {
      document_id: docId,
      document_title: 'AI时代的UX范式.pdf',
      quote: '不断成长。',
      object_refs: ['evt_verify_plain_ink'],
      inkloop_uri: `inkloop://doc/${docId}/page/1?anchor=evt_verify_plain_ink`,
    },
    provenance: { created_from: 'mark', mark_ids: ['evt_verify_plain_ink'] },
    tags: ['inkloop', 'inkloop/reading-note'],
    status: 'inbox',
    privacy: 'export_allowed',
    visual_strokes: [{
      tool: 'pen',
      color: '#1A1A1A',
      points: [
        { x: 0.12, y: 0.18, pressure: 0.5 },
        { x: 0.16, y: 0.24, pressure: 0.5 },
        { x: 0.13, y: 0.31, pressure: 0.5 },
        { x: 0.10, y: 0.25, pressure: 0.5 },
        { x: 0.13, y: 0.20, pressure: 0.5 },
      ],
    }],
    created_at: '2026-07-05T00:02:00.000Z',
    updated_at: '2026-07-05T00:02:00.000Z',
    controlled_fields: {},
  }, {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: 'ko_verify_ink_mark_placeholder',
    kind: 'reading_note',
    title: 'Ink mark',
    body_md: `Ink mark Marked evidence: Ink mark Backlink: inkloop://doc/${docId}?anchor=evt_verify_ink_mark_placeholder`,
    source: {
      document_id: docId,
      document_title: 'AI时代的UX范式.pdf',
      quote: 'Ink mark',
      object_refs: ['evt_verify_ink_mark_placeholder'],
      inkloop_uri: `inkloop://doc/${docId}?anchor=evt_verify_ink_mark_placeholder`,
    },
    provenance: { created_from: 'ai_turn', mark_ids: ['evt_verify_ink_mark_placeholder'] },
    tags: ['inkloop', 'inkloop/reading-note'],
    status: 'inbox',
    privacy: 'export_allowed',
    created_at: '2026-07-05T00:01:00.000Z',
    updated_at: '2026-07-05T00:01:00.000Z',
    controlled_fields: {},
  }], [{
    schema_version: 'inkloop.document_projection.v1',
    projection_id: `dp_${docId}`,
    document_id: docId,
    document_title: 'AI时代的UX范式.pdf',
    document_uri: `inkloop://doc/${docId}`,
    blocks: [{
      kind: 'paragraph',
      text_md: '摘要：UX 范式进入智能时代。',
      knowledge_object_ids: ['ko_verify_reading_note'],
      annotations: [{
        ko_id: 'ko_verify_reading_note',
        body_md: `手写边注 Marked evidence: PDF 原文摘录 Backlink: inkloop://doc/${docId}?anchor=evt_verify_reading_note`,
        title: 'AI时代的UX范式.pdf · p1',
      }, {
        ko_id: 'ko_verify_ink_mark_placeholder',
        body_md: 'Ink mark',
        title: 'Ink mark',
      }],
    }],
  }], []);
  const hub = files.find((file) => file.path === 'InkLoop/Reading/AI时代的UX范式/AI时代的UX范式.md');
  if (!hub) {
    fail('Cloud Knowledge renderer did not create the reading hub file');
    return;
  }
  for (const needle of [
    '## 阅读标记',
    'class="inkloop-snapshot-board"',
    '原文标记',
    'class="inkloop-snapshot-markline',
    '手写边注',
    `inkloop://doc/${docId}?anchor=evt_verify_reading_note`,
    '手写快照',
    'inkloop-cloud-mark-layer',
    `inkloop://doc/${docId}/page/1?anchor=evt_verify_plain_ink`,
  ]) {
    if (!hub.markdown.includes(needle)) fail(`Cloud Knowledge reading hub missing projection annotation body: ${needle}`);
  }
  if (hub.markdown.includes('暂无有效标记。')) fail('Cloud Knowledge reading hub incorrectly rendered empty state despite a valid projection annotation body');
  if (/Marked evidence:|Backlink:/i.test(hub.markdown)) fail('Cloud Knowledge reading hub leaked machine-only annotation fields into visible reading notes');
  if (hub.markdown.includes('不断成长。')) fail('Cloud Knowledge reading hub rendered a stray source quote for a plain ink snapshot');
  if (hub.markdown.includes('ko_verify_ink_mark_placeholder') || hub.markdown.includes('>Ink mark<')) fail('Cloud Knowledge reading hub rendered low-signal Ink mark placeholder');
  note('Cloud Knowledge reading hub renders projection annotation body when KO title is only a page reference');
}

function verifySettingsBoundaryStyles() {
  for (const file of [path.join(sourceDir, 'styles.css'), path.join(distDir, 'styles.css')]) {
    requireIncludes(file, [
      '.inkloop-v1-boundary-card',
      '.inkloop-v1-boundary-grid',
      '.inkloop-v1-boundary-row',
      '.inkloop-snapshot-board',
      '.inkloop-snapshot-card',
      '.inkloop-snapshot-markline',
    ]);
  }
}

function verifyInstaller() {
  requireIncludes('scripts/install-obsidian-plugin.mjs', [
    "const PLUGIN_ID = 'inkloop-sync'",
    'builtPluginSource',
    "syncEndpoint: ''",
      'runtimePushEndpoint',
      'runtimePullEndpoint',
      'knowledgeBaseEndpoint',
      'restricted-mode.json',
      'sessionToken',
      'previewEditing: false',
  ]);
  requireNotIncludes('scripts/install-obsidian-plugin.mjs', [
    "syncEndpoint: 'http://127.0.0.1:8765/api/obsidian-lab/pull'",
  ]);
}

function verifyInstallerSmoke() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'inkloop-obsidian-vault-'));
  try {
    const preexistingPluginTarget = path.join(tempRoot, '.obsidian', 'plugins', pluginId);
    mkdirSync(preexistingPluginTarget, { recursive: true });
    writeFileSync(path.join(preexistingPluginTarget, 'data.json'), `${JSON.stringify({
      syncEndpoint: 'http://127.0.0.1:8765/api/obsidian-lab/pull',
      runtimePushEndpoint: 'http://127.0.0.1:8765/api/obsidian-lab/push',
      runtimePullEndpoint: 'http://127.0.0.1:8765/api/obsidian-lab/pull',
      previewEditing: true,
    }, null, 2)}\n`, 'utf8');

    const output = execFileSync(process.execPath, [
      absolute('scripts/install-obsidian-plugin.mjs'),
      '--vault',
      tempRoot,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, INKLOOP_DISABLE_LOCAL_SESSION_DISCOVERY: '1', INKLOOP_SESSION_TOKEN: '', INKLOOP_DEVICE_SESSION_TOKEN: '' },
    });
    const result = JSON.parse(output);
    if (result.ok !== true) fail('Obsidian installer smoke did not return ok=true');
    if (result.plugin_id !== pluginId) fail(`Obsidian installer smoke returned wrong plugin_id: ${result.plugin_id}`);
    if (result.sdk_bundle_installed !== true) fail('Obsidian installer smoke did not install the SDK IIFE bundle');

    const pluginTarget = path.join(tempRoot, '.obsidian', 'plugins', pluginId);
    for (const file of ['manifest.json', 'main.js', 'styles.css', 'inkloop-surface-sdk.iife.js', 'data.json']) {
      if (!existsSync(path.join(pluginTarget, file))) fail(`Obsidian installer smoke missing installed file: ${file}`);
    }

    const enabled = readAbsoluteJson(path.join(tempRoot, '.obsidian', 'community-plugins.json'));
    if (!Array.isArray(enabled) || !enabled.includes(pluginId)) fail('Obsidian installer smoke did not enable the plugin');
    const restrictedMode = readAbsoluteJson(path.join(tempRoot, '.obsidian', 'restricted-mode.json'));
    if (restrictedMode.restrictedMode !== false) fail('Obsidian installer smoke did not disable restricted mode for the plugin vault');

    const data = readAbsoluteJson(path.join(pluginTarget, 'data.json'));
    if (data.syncEndpoint !== '') fail('Obsidian installer smoke did not clear a legacy syncEndpoint compatibility field');
    if (data.runtimePushEndpoint !== 'http://127.0.0.1:8731/v1/runtime/events:push') fail('Obsidian installer smoke wrote wrong runtimePushEndpoint');
    if (data.runtimePullEndpoint !== 'http://127.0.0.1:8731/v1/runtime/events:pull') fail('Obsidian installer smoke wrote wrong runtimePullEndpoint');
    if (data.knowledgeBaseEndpoint !== 'http://127.0.0.1:8731/v1/knowledge') fail('Obsidian installer smoke wrote wrong knowledgeBaseEndpoint');
    if (data.sessionToken !== '') fail('Obsidian installer smoke should keep sessionToken empty unless env provides one');
    if (data.previewEditing !== false) fail('Obsidian installer smoke must keep previewEditing=false');
    if (data.documentsDir !== 'InkLoop') fail('Obsidian installer smoke wrote wrong documentsDir');
    note('Obsidian installer smoke installed plugin, SDK bundle, enabled plugin, and V1 runtime settings into a temp vault');
  } catch (error) {
    fail(`Obsidian installer smoke failed: ${String(error?.message || error)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

verifyManifest();
verifyPackageFiles();
verifyRuntimeSyncBoundary();
verifyCloudKnowledgeMeetingHubRendersKoWithoutQuote();
verifyCloudKnowledgeReadingHubUsesProjectionAnnotationBody();
verifyCloudProjectionWritesDoNotBecomeControlledEdits();
verifySettingsBoundaryStyles();
verifyInstaller();
verifyInstallerSmoke();

if (failures.length > 0) {
  console.error('Obsidian V1 plugin verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Obsidian V1 plugin verification passed:');
for (const message of checked) console.log(`- ${message}`);
