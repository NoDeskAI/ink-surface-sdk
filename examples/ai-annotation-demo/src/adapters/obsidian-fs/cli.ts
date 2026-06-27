import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocumentProjection, type DocumentProjection } from '../../knowledge/document-projection';
import { parseKnowledgeObject, type KnowledgeObject } from '../../knowledge/knowledge-object';
import { buildExportPreview } from '../preview/export-preview';
import { JsonAdapterStorage } from './json-storage';
import { obsidianFsAdapter } from './adapter';
import { obsidianFsDocumentAdapter } from './document-adapter';
import { DEFAULT_OBSIDIAN_BASE_DIR, DEFAULT_OBSIDIAN_DOCUMENTS_DIR } from './target';
import { JsonlWatchOutbox, scanObsidianFsChanges, watchOutboxPath, type ObsidianFsWatchSnapshot } from './watcher';

function usage(): never {
  console.error(`Usage:
  npm run inkloop-adapter -- export-obsidian --input <export.json> --vault <vault-path> [--base-dir .inkloop] [--documents-dir InkLoop] [--dry-run]
  npm run inkloop-adapter -- pull-obsidian --input <export.json> --vault <vault-path> [--base-dir .inkloop] [--documents-dir InkLoop]
  npm run inkloop-adapter -- preview-obsidian --input <export.json> --vault <vault-path> [--base-dir .inkloop] [--documents-dir InkLoop]`);
  process.exit(1);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function loadExportInput(inputPath: string): Promise<{ objects: KnowledgeObject[]; projections: DocumentProjection[] }> {
  const raw = JSON.parse(await readFile(resolve(process.cwd(), inputPath), 'utf8')) as unknown;
  const objects = Array.isArray(raw) ? raw : (raw as { objects?: unknown[] }).objects;
  const projections = Array.isArray(raw) ? [] : (raw as { document_projections?: unknown[] }).document_projections;
  if (!Array.isArray(objects) && !Array.isArray(projections)) {
    throw new Error('Input must contain objects or document_projections.');
  }
  return {
    objects: (objects ?? []).map(parseKnowledgeObject),
    projections: (projections ?? []).map(parseDocumentProjection),
  };
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function hasExportConflicts(output: { documentResult?: { plan?: { summary?: { conflict_count?: number } } }; result?: { plan?: { summary?: { conflict_count?: number } } } }): boolean {
  return Boolean((output.documentResult?.plan?.summary?.conflict_count ?? 0) > 0 || (output.result?.plan?.summary?.conflict_count ?? 0) > 0);
}

const args = process.argv.slice(2);
const command = args[0];
if (!['export-obsidian', 'pull-obsidian', 'preview-obsidian'].includes(command)) usage();

const inputPath = argValue(args, '--input');
const vaultRoot = argValue(args, '--vault');
const baseDir = argValue(args, '--base-dir') ?? DEFAULT_OBSIDIAN_BASE_DIR;
const documentsDir = argValue(args, '--documents-dir') ?? DEFAULT_OBSIDIAN_DOCUMENTS_DIR;
const dryRun = args.includes('--dry-run');

if (!inputPath || !vaultRoot) usage();

const { objects, projections } = await loadExportInput(inputPath);
const validation = await obsidianFsAdapter.validateConfig({ vault_root: vaultRoot, base_dir: baseDir, documents_dir: documentsDir });
if (!validation.ok) {
  console.error(JSON.stringify(validation, null, 2));
  process.exit(2);
}
for (const warning of validation.warnings ?? []) console.warn(`[warn] ${warning.code}: ${warning.message}`);

const target = await obsidianFsAdapter.resolveTarget({ vault_root: vaultRoot, base_dir: baseDir, documents_dir: documentsDir });
const storage = JsonAdapterStorage.forVault(target.vault_root, target.base_dir, { readOnly: dryRun });
if (command === 'preview-obsidian') {
  const conflicts = await storage.listConflicts({ target_id: target.target_id });
  console.log(JSON.stringify(buildExportPreview({
    projections,
    knowledgeObjects: objects,
    target: {
      provider: 'obsidian_fs',
      target_id: target.target_id,
      vault_root: target.vault_root,
      base_dir: target.base_dir,
      documents_dir: target.documents_dir,
    },
    conflicts,
  }), null, 2));
  process.exit(0);
}

if (command === 'pull-obsidian') {
  const bindings = await storage.listBindings({ target_id: target.target_id });
  const snapshotPath = join(target.vault_root, target.base_dir, '.inkloop-cli-watch-snapshot.json');
  await mkdir(join(target.vault_root, target.base_dir), { recursive: true });
  const previous = await readJsonFile<ObsidianFsWatchSnapshot>(snapshotPath, {});
  const watch = await scanObsidianFsChanges({
    target,
    bindings,
    previous,
    outbox: new JsonlWatchOutbox(watchOutboxPath(target)),
  });
  await writeFile(snapshotPath, `${JSON.stringify(watch.snapshot, null, 2)}\n`, 'utf8');
  const documentResult = projections.length
    ? await obsidianFsDocumentAdapter.pullExternalEdits({ projections, target, storage, bindings })
    : undefined;
  const metadataResult = objects.length
    ? await obsidianFsAdapter.pullMetadata({ target, bindings: bindings.filter((binding) => objects.some((object) => object.ko_id === binding.ko_id)) })
    : undefined;
  console.log(JSON.stringify({ watch_events: watch.events, documentResult, metadataResult }, null, 2));
  process.exit(0);
}

const documentPlan = projections.length ? await obsidianFsDocumentAdapter.plan({ projections, target, storage, knowledgeObjects: objects }) : undefined;
const plan = objects.length ? await obsidianFsAdapter.plan({ objects, target, storage, documentProjections: projections }) : undefined;

if (dryRun) {
  console.log(JSON.stringify({ documentPlan, plan }, null, 2));
} else {
  const documentResult = projections.length ? await obsidianFsDocumentAdapter.exportDocuments({ projections, target, storage, knowledgeObjects: objects }) : undefined;
  const result = objects.length ? await obsidianFsAdapter.exportObjects({ objects, target, storage, documentProjections: projections }) : undefined;
  const output = { documentResult, result };
  console.log(JSON.stringify(output, null, 2));
  if (hasExportConflicts(output)) {
    console.error('InkLoop Obsidian export completed with conflicts.');
    process.exit(3);
  }
}
