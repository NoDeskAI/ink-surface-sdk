import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const vaultArgIndex = process.argv.indexOf('--vault');
const vaultRoot = path.resolve(vaultArgIndex >= 0 ? process.argv[vaultArgIndex + 1] : '/Users/ethan/Desktop/InkLoop-Obsidian-Test-Vault');
const pluginDir = path.join(vaultRoot, '.obsidian/plugins/inkloop-sync');
const pluginSource = path.join(root, 'plugins/obsidian/inkloop-sync/main.js');
const settingsPath = path.join(pluginDir, 'data.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function loadCloudRenderer() {
  const source = globalThis.__pluginSource;
  const start = source.indexOf('function normalizeText');
  const end = source.indexOf('module.exports = class');
  if (start < 0 || end < 0 || end <= start) fail('could not locate Obsidian plugin Cloud Knowledge renderer functions');
  return new Function(`${source.slice(start, end)}\nreturn { renderCloudKnowledgeMarkdown, filterCloudKnowledgeForObsidian };`)();
}

async function cloudGet(settings, suffix) {
  const base = String(settings.knowledgeBaseEndpoint || '').replace(/\/+$/, '');
  if (!base) fail('knowledgeBaseEndpoint is missing in Obsidian plugin settings');
  const response = await fetch(`${base}/${suffix}`, {
    headers: {
      authorization: `Bearer ${settings.sessionToken}`,
      'x-inkloop-tenant-id': settings.tenantId || 'local',
      'x-inkloop-user-id': settings.userId || 'local_demo',
      'x-inkloop-device-id': settings.deviceId || 'obsidian-render-script',
    },
  });
  const text = await response.text();
  if (!response.ok) fail(`Cloud Knowledge ${suffix} failed HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function writeRenderedFile(vaultRoot, file) {
  const target = path.join(vaultRoot, file.path);
  await mkdir(path.dirname(target), { recursive: true });
  let existing = null;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === file.markdown) return false;
  await writeFile(target, file.markdown, 'utf8');
  return true;
}

async function listMarkdownFiles(rootDir) {
  let entries = [];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...await listMarkdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files;
}

async function pruneGeneratedInkLoopFiles(vaultRoot, keepRelativePaths) {
  const inkLoopRoot = path.join(vaultRoot, 'InkLoop');
  const keep = new Set(keepRelativePaths.map((item) => path.normalize(item)));
  const files = await listMarkdownFiles(inkLoopRoot);
  let removed = 0;
  for (const file of files) {
    const relativePath = path.normalize(path.relative(vaultRoot, file));
    if (keep.has(relativePath)) continue;
    const markdown = await readFile(file, 'utf8').catch(() => '');
    const managed = markdown.includes('inkloop_projection_role:')
      || markdown.includes('<!-- inkloop:cloud-note')
      || markdown.includes('<!-- inkloop:runtime-doc')
      || markdown.includes('inkloop_document_id:');
    if (!managed) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  const dirs = [
    path.join(inkLoopRoot, 'Reading'),
    path.join(inkLoopRoot, 'Meetings'),
    inkLoopRoot,
  ];
  for (const dir of dirs) {
    try {
      await rmdir(dir);
    } catch {
      // Directory is not empty or does not exist.
    }
  }
  return removed;
}

globalThis.__pluginSource = await readFile(pluginSource, 'utf8');
const renderer = loadCloudRenderer();
const settings = await readJson(settingsPath);
const [objectsPayload, projectionsPayload, aiTurnsPayload] = await Promise.all([
  cloudGet(settings, 'objects'),
  cloudGet(settings, 'document-projections'),
  cloudGet(settings, 'ai-turns'),
]);

const objects = Array.isArray(objectsPayload.objects) ? objectsPayload.objects : [];
const projections = Array.isArray(projectionsPayload.document_projections) ? projectionsPayload.document_projections : [];
const aiTurns = Array.isArray(aiTurnsPayload.ai_turns) ? aiTurnsPayload.ai_turns : [];
const filtered = renderer.filterCloudKnowledgeForObsidian(objects, projections);
const hiddenDocIds = new Set(filtered.skipped_document_ids || []);
const visibleAiTurns = aiTurns.filter((turn) =>
  !hiddenDocIds.has(turn.document_id) && !/inkloop v1 demo|product e2e|v1 product e2e|last verify|verify|测试文档|\be2e\b|\btest\b|\bsmoke\b/i.test(`${turn.document_id || ''} ${turn.document_title || turn.inference_view?.document_title || ''}`),
);
const files = renderer.renderCloudKnowledgeMarkdown(settings, filtered.objects, filtered.projections, visibleAiTurns);
const pruned = await pruneGeneratedInkLoopFiles(vaultRoot, files.map((file) => file.path));
let changed = 0;
for (const file of files) if (await writeRenderedFile(vaultRoot, file)) changed += 1;

console.log(JSON.stringify({
  ok: true,
  vault_root: vaultRoot,
  rendered: files.length,
  changed,
  pruned,
  knowledge_objects: objects.length,
  document_projections: projections.length,
  ai_turns: visibleAiTurns.length,
  skipped_document_ids: filtered.skipped_document_ids,
  rendered_paths: files.map((file) => file.path),
}, null, 2));
