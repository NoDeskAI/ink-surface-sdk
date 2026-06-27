import { createHash, webcrypto } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DocumentProjectionBuilder,
  KnowledgeBuilder,
  MemoryKnowledgeIdentityStore,
  type DocumentProjectionBuilderStorePort,
  type InkLoopAiTurn,
  type InkLoopDoc,
  type InkLoopDocumentPage,
  type InkLoopMark,
  type KnowledgeBuilderStorePort,
  type KnowledgeQuery,
} from '../src/knowledge-builder';
import type { KnowledgeObject } from '../src/knowledge/knowledge-object';
import { parseKnowledgeObject } from '../src/knowledge/knowledge-object';
import { recomputeKnowledgeHash } from '../src/knowledge/hash';
import { parseDocumentProjection, recomputeDocumentProjectionHash } from '../src/knowledge/document-projection';
import { parseExternalEdit, recomputeExternalEditHash } from '../src/knowledge/external-edit';
import { buildExportPreview } from '../src/adapters/preview/export-preview';
import {
  fromVaultRelative,
  JsonAdapterStorage,
  JsonlWatchOutbox,
  obsidianFsAdapter,
  obsidianFsDocumentAdapter,
  scanObsidianFsChanges,
} from '../src/adapters/obsidian-fs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function installInkLoopPlugin(vaultRoot: string): Promise<void> {
  const pluginId = 'inkloop-sync';
  const pluginSource = path.join(REPO_ROOT, 'plugins', 'obsidian', pluginId);
  const pluginTarget = path.join(vaultRoot, '.obsidian', 'plugins', pluginId);
  await cp(pluginSource, pluginTarget, { recursive: true, force: true });
  await writeJson(path.join(vaultRoot, '.obsidian', 'community-plugins.json'), [pluginId]);
  await writeJson(path.join(pluginTarget, 'data.json'), {
    baseDir: '.inkloop',
    documentsDir: 'InkLoop',
    syncEndpoint: 'http://127.0.0.1:8765/api/obsidian-lab/pull',
    autoSyncOnChange: true,
    debounceMs: 750,
    notifyManualSync: true,
    visualEnhancement: true,
    previewEditing: false,
    surfaceMode: 'thinking',
    inkTool: 'pen',
    inkColors: {
      pen: '#38bdf8',
      highlighter: '#facc15',
    },
  });
}

class RealFlowStore extends MemoryKnowledgeIdentityStore implements KnowledgeBuilderStorePort, DocumentProjectionBuilderStorePort {
  objects: KnowledgeObject[] = [];
  projections: Awaited<ReturnType<DocumentProjectionBuilder['build']>>['projections'] = [];

  constructor(
    private readonly docs: InkLoopDoc[],
    private readonly marks: InkLoopMark[],
    private readonly turns: InkLoopAiTurn[],
    private readonly pages: Record<string, InkLoopDocumentPage[]>,
  ) {
    super();
  }

  async getDoc(documentId: string): Promise<InkLoopDoc | null> {
    return this.docs.find((doc) => doc.document_id === documentId) ?? null;
  }

  async listDocs(): Promise<InkLoopDoc[]> {
    return this.docs;
  }

  async getFoldedMarks(documentId: string): Promise<InkLoopMark[]> {
    return this.marks.filter((mark) => mark.document_id === documentId);
  }

  async getFoldedAiTurns(documentId: string): Promise<InkLoopAiTurn[]> {
    return this.turns.filter((turn) => turn.document_id === documentId);
  }

  async getDocumentProjectionPages(documentId: string): Promise<InkLoopDocumentPage[]> {
    return this.pages[documentId] ?? [];
  }

  async upsertKnowledgeObject(ko: KnowledgeObject): Promise<void> {
    this.objects = this.objects.filter((object) => object.ko_id !== ko.ko_id).concat(ko);
  }

  async listKnowledgeObjects(query: KnowledgeQuery): Promise<KnowledgeObject[]> {
    return this.objects.filter((object) => {
      if (query.document_id && object.source.document_id !== query.document_id) return false;
      if (query.privacy && !query.privacy.includes(object.privacy)) return false;
      if (query.status && !query.status.includes(object.status)) return false;
      return true;
    });
  }

  async upsertDocumentProjection(projection: Awaited<ReturnType<DocumentProjectionBuilder['build']>>['projections'][number]): Promise<void> {
    this.projections = this.projections.filter((item) => item.projection_id !== projection.projection_id).concat(projection);
  }
}

const body = {
  title: 'Hello SurfaceIndex Title',
  p1: 'The first paragraph talks about a quiet morning routine.\nIt mentions coffee, soft sunlight, and a tidy desk before work.',
  p2: 'A second, unrelated paragraph shifts entirely to the weather.\nRain had been falling since midnight and the streets were grey.',
  p3: 'The third paragraph is about writing code late at night.\nBugs hide in tall paragraphs, and clean structure helps find them.',
};

const now = '2026-06-26T12:00:00.000Z';
const pdfPath = path.resolve(argValue('--pdf') ?? 'public/sample.pdf');
const pdfBytes = await readFile(pdfPath);
const pdfHash = sha256(pdfBytes);
const documentId = `doc_${pdfHash.slice(0, 12)}`;
const pageId = `pg_${pdfHash.slice(0, 8)}_0`;
const outDirArg = argValue('--out-dir');
const outDir = path.resolve(outDirArg ?? (await mkdtemp(path.join(os.tmpdir(), 'inkloop-real-flow-'))));
const forceClean = hasFlag('--force-clean');
const reuse = hasFlag('--reuse');
if (forceClean && reuse) throw new Error('--force-clean and --reuse are mutually exclusive.');
if (outDirArg && await pathExists(outDir)) {
  if (forceClean) await rm(outDir, { recursive: true, force: true });
  else if (!reuse) throw new Error(`Output directory already exists: ${outDir}. Use --force-clean or --reuse explicitly.`);
}
const vaultRoot = path.resolve(argValue('--vault') ?? path.join(outDir, 'obsidian-vault'));
await mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
await installInkLoopPlugin(vaultRoot);

const doc: InkLoopDoc = {
  document_id: documentId,
  filename: 'sample.pdf',
  title: body.title,
  page_count: 1,
};

const pages: InkLoopDocumentPage[] = [
  {
    page_id: pageId,
    page_index: 0,
    reflow_engine: 'local',
    status: 'reflowed',
    reflow: [
      { id: 'title_surfaceindex', type: 'heading', level: 1, text: body.title, source: [0.12, 0.08, 0.46, 0.05], sourceRunIds: ['run_title'] },
      { id: 'morning_paragraph', type: 'para', text: body.p1, source: [0.12, 0.14, 0.74, 0.07], sourceRunIds: ['run_p1_l1', 'run_p1_l2'] },
      { id: 'weather_paragraph', type: 'para', text: body.p2, source: [0.12, 0.24, 0.76, 0.07], sourceRunIds: ['run_p2_l1', 'run_p2_l2'] },
      { id: 'code_paragraph', type: 'para', text: body.p3, source: [0.12, 0.34, 0.76, 0.07], sourceRunIds: ['run_p3_l1', 'run_p3_l2'] },
    ],
  },
];

const marks: InkLoopMark[] = [
  {
    mark_id: 'mark_morning_highlight',
    document_id: documentId,
    page_id: pageId,
    page_index: 0,
    bbox: [0.12, 0.14, 0.74, 0.07],
    marked_text: body.p1,
    feature_type: 'markup',
    hmp: { target_object_refs: ['run_p1_l1', 'run_p1_l2'], anchor_bbox: [0.12, 0.14, 0.74, 0.07] },
    created_at: '2026-06-26T12:01:00.000Z',
    updated_at: '2026-06-26T12:01:00.000Z',
  },
  {
    mark_id: 'mark_weather_question',
    document_id: documentId,
    page_id: pageId,
    page_index: 0,
    bbox: [0.12, 0.24, 0.76, 0.07],
    marked_text: 'Why does this switch to rain here?',
    feature_type: 'handwriting',
    kind: 'handwriting',
    hmp: { text_hint: 'Why does this switch to rain here?', anchor_bbox: [0.12, 0.24, 0.76, 0.07] },
    created_at: '2026-06-26T12:02:00.000Z',
    updated_at: '2026-06-26T12:02:00.000Z',
  },
  {
    mark_id: 'mark_code_task',
    document_id: documentId,
    page_id: pageId,
    page_index: 0,
    bbox: [0.12, 0.34, 0.76, 0.07],
    marked_text: 'TODO: Turn the code paragraph into a refactor note.',
    feature_type: 'handwriting',
    kind: 'handwriting',
    hmp: { text_hint: 'TODO: Turn the code paragraph into a refactor note.', anchor_bbox: [0.12, 0.34, 0.76, 0.07] },
    created_at: '2026-06-26T12:03:00.000Z',
    updated_at: '2026-06-26T12:03:00.000Z',
  },
];

const turns: InkLoopAiTurn[] = [
  {
    entry_id: 'turn_weather_qa',
    document_id: documentId,
    page_id: pageId,
    page_index: 0,
    overlay_state: 'shown',
    trigger: 'handwriting',
    user_question: 'Why does this switch to rain here?',
    ai_reply: 'The weather paragraph is intentionally unrelated. It is a contrast case for checking whether the document projection keeps separate topics anchored to the right block.',
    anchor: { mark_ids: ['mark_weather_question'], object_refs: ['run_p2_l1', 'run_p2_l2'] },
    inference_view: { question: 'Why does this switch to rain here?', anchor_bbox: [0.12, 0.24, 0.76, 0.07] },
    created_at: '2026-06-26T12:02:30.000Z',
    updated_at: '2026-06-26T12:02:30.000Z',
  },
  {
    entry_id: 'turn_code_note',
    document_id: documentId,
    page_id: pageId,
    page_index: 0,
    overlay_state: 'accepted',
    trigger: 'idle',
    ai_reply: 'The code paragraph works as a debugging metaphor: structure makes hidden bugs easier to isolate, just as stable document blocks make external edits easier to merge.',
    anchor: { mark_ids: ['mark_code_task'], object_refs: ['run_p3_l1', 'run_p3_l2'] },
    inference_view: { anchor_bbox: [0.12, 0.34, 0.76, 0.07] },
    created_at: '2026-06-26T12:04:00.000Z',
    updated_at: '2026-06-26T12:04:00.000Z',
  },
];

const store = new RealFlowStore([doc], marks, turns, { [documentId]: pages });
const knowledge = await new KnowledgeBuilder(store).build({ document_id: documentId, now });
assert(knowledge.objects.length === 5, `expected 5 KOs, got ${knowledge.objects.length}`);

const projectionResult = await new DocumentProjectionBuilder(store).build({
  document_id: documentId,
  now,
  app_version: '0.1.0-smoke',
  reflow_engine: 'local',
});
assert(projectionResult.projections.length === 1, `expected 1 projection, got ${projectionResult.projections.length}`);
const [projection] = projectionResult.projections;

for (const object of knowledge.objects) {
  assert(parseKnowledgeObject(object).ko_id === object.ko_id, `KO parse failed for ${object.ko_id}`);
  assert((await recomputeKnowledgeHash(object)) === object.content_hash, `KO hash mismatch for ${object.ko_id}`);
}
assert(parseDocumentProjection(projection).projection_id === projection.projection_id, 'projection parse failed');
assert((await recomputeDocumentProjectionHash(projection)) === projection.content_hash, 'projection hash mismatch');

const exportEnvelope = {
  schema_version: 'inkloop.real_flow_export.v1',
  generated_at: now,
  source: { app: 'inkloop', app_version: '0.1.0-smoke', document_id: documentId, pdf_path: pdfPath, pdf_sha256: pdfHash },
  ledger_evidence: { documents: [doc], marks, ai_turns: turns, pages },
  objects: knowledge.objects,
  document_projections: [projection],
};
const exportPath = path.join(outDir, 'scenario-export.json');
await writeJson(exportPath, exportEnvelope);

const validation = await obsidianFsAdapter.validateConfig({ vault_root: vaultRoot });
assert(validation.ok, `vault validation failed: ${JSON.stringify(validation)}`);
const target = await obsidianFsAdapter.resolveTarget({ vault_root: vaultRoot });
const storage = JsonAdapterStorage.forVault(target.vault_root, target.base_dir);
const preview = buildExportPreview({
  projections: [projection],
  knowledgeObjects: knowledge.objects,
  target: { provider: 'obsidian_fs', target_id: target.target_id, vault_root: target.vault_root, base_dir: target.base_dir },
});
assert(preview.requires_full_text_gate, 'preview should require full text gate');

const documentExport = await obsidianFsDocumentAdapter.exportDocuments({
  projections: [projection],
  target,
  storage,
  knowledgeObjects: knowledge.objects,
});
const objectExport = await obsidianFsAdapter.exportObjects({ objects: knowledge.objects, target, storage, documentProjections: [projection] });
const bindingsAfterExport = await storage.listBindings({ target_id: target.target_id });
const initialWatch = await scanObsidianFsChanges({
  target,
  bindings: bindingsAfterExport,
  observed_at: '2026-06-26T12:05:00.000Z',
  outbox: new JsonlWatchOutbox(path.join(outDir, 'watch-events.jsonl')),
});

const sourceBinding = await storage.getBinding(target.target_id, projection.projection_id);
assert(sourceBinding, 'missing source document binding');
const sourcePath = fromVaultRelative(vaultRoot, sourceBinding.remote_path);
let sourceMarkdown = await readFile(sourcePath, 'utf8');
await writeJson(path.join(vaultRoot, '.obsidian', 'workspace.json'), {
  main: {
    id: 'inkloop-main',
    type: 'split',
    children: [
      {
        id: 'inkloop-tabs',
        type: 'tabs',
        children: [
          {
            id: 'inkloop-source',
            type: 'leaf',
            state: {
              type: 'markdown',
              state: { file: sourceBinding.remote_path, mode: 'preview', source: false },
              icon: 'lucide-file-text',
              title: projection.document_title,
            },
          },
        ],
      },
    ],
    direction: 'vertical',
  },
  left: {
    id: 'inkloop-left',
    type: 'split',
    children: [
      {
        id: 'inkloop-file-explorer-tabs',
        type: 'tabs',
        children: [
          {
            id: 'inkloop-file-explorer',
            type: 'leaf',
            state: {
              type: 'file-explorer',
              state: { sortOrder: 'alphabetical', autoReveal: true },
              icon: 'lucide-folder-closed',
              title: 'Files',
            },
          },
        ],
      },
    ],
    direction: 'horizontal',
    width: 280,
    collapsed: false,
  },
  right: { id: 'inkloop-right', type: 'split', children: [], direction: 'horizontal', collapsed: true },
  active: 'inkloop-source',
});

const blockChecks = projection.blocks.map((block) => ({
  block_id: block.block_id,
  text_present: sourceMarkdown.includes(block.text_md.trim()),
  ko_ids: block.knowledge_object_ids,
}));
assert(blockChecks.every((check) => check.text_present), `source markdown missing block text: ${JSON.stringify(blockChecks)}`);
assert(!sourceMarkdown.includes('inkloop_projection_id'), 'source markdown should not contain InkLoop frontmatter');
assert(!sourceMarkdown.includes('<!-- inkloop:'), 'source markdown should not contain InkLoop HTML comments');

const sidecarBlocksPath = path.join(vaultRoot, target.base_dir, 'docs', projection.document_id, 'surfaces', 'markdown.blocks.jsonl');
const sidecarBlocks = (await readFile(sidecarBlocksPath, 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { annotations?: Array<{ title?: string }> });
const koLinkChecks = knowledge.objects.map((object) => ({
  ko_id: object.ko_id,
  kind: object.kind,
  title: object.title,
  linked_in_sidecar: sidecarBlocks.some((block) => block.annotations?.some((annotation) => annotation.title === object.title)),
}));
assert(koLinkChecks.every((check) => check.linked_in_sidecar), `sidecar missing KO annotation titles: ${JSON.stringify(koLinkChecks)}`);

const taskObject = knowledge.objects.find((object) => object.kind === 'task');
assert(taskObject, 'missing task object');
const taskBinding = await storage.getBinding(target.target_id, taskObject.ko_id);
assert(taskBinding, 'missing task binding');
const taskPath = fromVaultRelative(vaultRoot, taskBinding.remote_path);

const sourceEditBefore = body.p3;
const sourceEditAfter = `${body.p3}\n\nObsidian edit: the reviewer adds that stable block ids make this paragraph safe to round-trip.`;
assert(sourceMarkdown.includes(sourceEditBefore), 'source edit target not found');
sourceMarkdown = sourceMarkdown.replace(sourceEditBefore, sourceEditAfter);
await writeFile(sourcePath, sourceMarkdown, 'utf8');

let taskMarkdown = await readFile(taskPath, 'utf8');
assert(taskMarkdown.includes('completed: false'), 'task completed frontmatter not found');
taskMarkdown = taskMarkdown.replace('completed: false', 'completed: true').replace('inkloop_status: "export_ready"', 'inkloop_status: "accepted"');
await writeFile(taskPath, taskMarkdown, 'utf8');

const postEditWatch = await scanObsidianFsChanges({
  target,
  bindings: bindingsAfterExport,
  previous: initialWatch.snapshot,
  observed_at: '2026-06-26T12:06:00.000Z',
  outbox: new JsonlWatchOutbox(path.join(outDir, 'watch-events.jsonl')),
});
assert(postEditWatch.events.some((event) => event.remote_path === sourceBinding.remote_path && event.event_type === 'file_modified'), 'watcher did not detect source document modification');
assert(postEditWatch.events.some((event) => event.remote_path === taskBinding.remote_path && event.event_type === 'file_modified'), 'watcher did not detect task note modification');

const documentPull = await obsidianFsDocumentAdapter.pullExternalEdits({
  projections: [projection],
  target,
  storage,
  bindings: bindingsAfterExport,
  observed_at: '2026-06-26T12:07:00.000Z',
});
assert(documentPull.external_edits.length === 1, `expected 1 external edit, got ${documentPull.external_edits.length}`);
assert(documentPull.external_edits[0].payload.after_md === sourceEditAfter, 'external edit payload did not preserve Obsidian body edit');
assert(documentPull.conflicts.length === 0, `unexpected document conflicts: ${JSON.stringify(documentPull.conflicts)}`);

for (const edit of documentPull.external_edits) {
  assert(parseExternalEdit(edit).edit_id === edit.edit_id, `external edit parse failed for ${edit.edit_id}`);
  assert((await recomputeExternalEditHash(edit)) === edit.content_hash, `external edit hash mismatch for ${edit.edit_id}`);
}
const persistedExternalEdits = await storage.listExternalEdits({ projection_id: projection.projection_id });
assert(persistedExternalEdits.length === 1, `expected 1 persisted external edit, got ${persistedExternalEdits.length}`);

const metadataPull = await obsidianFsAdapter.pullMetadata({ target, bindings: [taskBinding] });
assert(metadataPull.updates[0]?.metadata.completed === true, 'task metadata pull did not read completed=true');
assert(metadataPull.updates[0]?.metadata.status === 'accepted', 'task metadata pull did not read accepted status');

const finalEnvelope = {
  ...exportEnvelope,
  external_edits: documentPull.external_edits,
};
const finalEnvelopePath = path.join(outDir, 'scenario-export-with-external-edits.json');
await writeJson(finalEnvelopePath, finalEnvelope);

const statePath = path.join(vaultRoot, target.base_dir, '.inkloop-adapter-state.json');
const state = JSON.parse(await readFile(statePath, 'utf8')) as { externalEdits?: unknown[]; bindings?: unknown[]; events?: unknown[] };
assert((state.externalEdits ?? []).length === 1, 'adapter state did not persist external edit');

const report = {
  ok: true,
  out_dir: outDir,
  vault_root: vaultRoot,
  pdf: { path: pdfPath, sha256: pdfHash, document_id: documentId },
  schema: {
    export_path: exportPath,
    final_export_path: finalEnvelopePath,
    ko_count: knowledge.objects.length,
    projection_count: projectionResult.projections.length,
    external_edit_count: documentPull.external_edits.length,
  },
  preview,
  obsidian: {
    source_path: sourcePath,
    source_remote_path: sourceBinding.remote_path,
    task_path: taskPath,
    task_remote_path: taskBinding.remote_path,
    state_path: statePath,
  },
  fidelity: {
    block_checks: blockChecks,
    ko_link_checks: koLinkChecks,
    sidecar_results: objectExport.results.map((result) => ({ action: result.action, remote_path: result.remote_path })),
    document_result: documentExport.results.map((result) => ({ action: result.action, remote_path: result.remote_path })),
  },
  pull_back: {
    document_external_edits: documentPull.external_edits,
    document_conflicts: documentPull.conflicts,
    document_warnings: documentPull.warnings,
    task_metadata_updates: metadataPull.updates,
    task_metadata_warnings: metadataPull.warnings,
    persisted_external_edits: persistedExternalEdits,
  },
  watcher: {
    initial_events: initialWatch.events,
    post_edit_events: postEditWatch.events,
    outbox_path: path.join(outDir, 'watch-events.jsonl'),
  },
};
const reportPath = path.join(outDir, 'real-flow-report.json');
await writeJson(reportPath, report);

console.log(JSON.stringify({
  ok: true,
  report_path: reportPath,
  export_path: exportPath,
  final_export_path: finalEnvelopePath,
  vault_root: vaultRoot,
  source_path: sourcePath,
  task_path: taskPath,
  ko_count: knowledge.objects.length,
  projection_blocks: projection.blocks.length,
  external_edit_count: documentPull.external_edits.length,
  metadata_update_count: metadataPull.updates.length,
  watcher_post_edit_events: postEditWatch.events.length,
}, null, 2));
