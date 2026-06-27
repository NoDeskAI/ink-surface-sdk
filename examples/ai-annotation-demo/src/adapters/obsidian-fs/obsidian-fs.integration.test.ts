import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeKnowledgeHash } from '../../knowledge/hash';
import { parseDocumentProjection, type DocumentProjection } from '../../knowledge/document-projection';
import { parseKnowledgeObject, type KnowledgeObject } from '../../knowledge/knowledge-object';
import { MemoryAdapterStorage } from '../core/memory-storage';
import { parseFrontmatter } from '../markdown/frontmatter';
import { ObsidianFsAdapter } from './adapter';
import { ObsidianFsDocumentAdapter } from './document-adapter';
import { JsonAdapterStorage } from './json-storage';
import { fromVaultRelative } from './target';

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inkloop-vault-test-'));
  await mkdir(path.join(dir, '.obsidian'));
  return dir;
}

async function fixtureObjects(): Promise<KnowledgeObject[]> {
  const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/knowledge-objects.json', 'utf8')) as { objects: unknown[] };
  return raw.objects.map(parseKnowledgeObject);
}

async function fixtureProjection(): Promise<DocumentProjection> {
  const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/document-projections.json', 'utf8')) as { document_projections: unknown[] };
  return parseDocumentProjection(raw.document_projections[0]);
}

async function changedBody(ko: KnowledgeObject, body: string): Promise<KnowledgeObject> {
  const { content_hash: _contentHash, ...withoutHash } = ko;
  const next = { ...withoutHash, body_md: body, updated_at: '2026-06-26T07:00:00.000Z' };
  return { ...next, content_hash: await computeKnowledgeHash(next) };
}

async function changedSourceTitle(ko: KnowledgeObject, documentTitle: string): Promise<KnowledgeObject> {
  const { content_hash: _contentHash, ...withoutHash } = {
    ...ko,
    source: { ...ko.source, document_title: documentTitle },
  };
  return { ...withoutHash, content_hash: await computeKnowledgeHash(withoutHash) };
}

describe('Obsidian FS adapter temp vault flow', () => {
  it('creates notes, source notes, bindings, and skips unchanged exports', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();

    const first = await adapter.exportObjects({ objects: [aiNote], target, storage });
    expect(first.plan.summary.create_count).toBe(1);
    const binding = await storage.getBinding(target.target_id, aiNote.ko_id);
    expect(binding?.sync_state).toBe('active');
    expect(await readFile(fromVaultRelative(vault, binding!.remote_path), 'utf8')).toContain('## My notes');
    expect(await readFile(path.join(vault, 'InkLoop', '量子力学导论 - doc_3f9a1c2b7e04.md'), 'utf8')).toContain('# 量子力学导论');

    const second = await adapter.exportObjects({ objects: [aiNote], target, storage });
    expect(second.plan.summary.skip_count).toBe(1);
    expect(second.results[0].action).toBe('skip_unchanged');

    await rm(vault, { recursive: true, force: true });
  });

  it('normalizes KO source links to the exported document projection title', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const projection = await fixtureProjection();
    const mismatchedTitle = await changedSourceTitle(aiNote, 'source-file.pdf');
    const adapter = new ObsidianFsAdapter();
    const documentAdapter = new ObsidianFsDocumentAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();

    await documentAdapter.exportDocuments({ projections: [projection], target, storage, knowledgeObjects: [mismatchedTitle] });
    await adapter.exportObjects({ objects: [mismatchedTitle], target, storage, documentProjections: [projection] });

    const sourceFiles = (await readdir(path.join(vault, 'InkLoop'))).filter((file) => file.endsWith('.md')).sort();
    expect(sourceFiles).toEqual(['量子力学导论 - doc_3f9a1c2b7e04.md']);
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    const noteMarkdown = await readFile(fromVaultRelative(vault, binding.remote_path), 'utf8');
    expect(noteMarkdown).toContain('[[量子力学导论 - doc_3f9a1c2b7e04|量子力学导论]]');
    expect(noteMarkdown).not.toContain('source-file.pdf');

    await rm(vault, { recursive: true, force: true });
  });

  it('updates the controlled section while preserving user free notes', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage });
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}\n用户自己的自由笔记。\n`, 'utf8');

    const updated = await changedBody(aiNote, '更新后的 AI 旁注正文。');
    const run = await adapter.exportObjects({ objects: [updated], target, storage });
    expect(run.plan.summary.update_count).toBe(1);
    const markdown = await readFile(filePath, 'utf8');
    expect(markdown).toContain('更新后的 AI 旁注正文。');
    expect(markdown).toContain('用户自己的自由笔记。');

    await rm(vault, { recursive: true, force: true });
  });

  it('snapshots user-edited controlled sections and records a conflict', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage });
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    await writeFile(filePath, (await readFile(filePath, 'utf8')).replace('量子纠缠体现的是', '用户改了：量子纠缠体现的是'), 'utf8');

    const updated = await changedBody(aiNote, '新版本正文。');
    await adapter.exportObjects({ objects: [updated], target, storage });
    const conflicts = await storage.listConflicts({ ko_id: aiNote.ko_id });
    expect(conflicts.some((conflict) => conflict.code === 'controlled_section_modified')).toBe(true);
    const markdown = await readFile(filePath, 'utf8');
    expect(markdown).toContain('inkloop:snapshot-begin');
    expect(markdown).toContain('新版本正文。');

    await rm(vault, { recursive: true, force: true });
  });

  it('relinks when a user renames a note', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage });
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    const oldPath = fromVaultRelative(vault, binding.remote_path);
    const newPath = path.join(path.dirname(oldPath), 'Renamed InkLoop Note.md');
    await rename(oldPath, newPath);

    const updated = await changedBody(aiNote, '重命名后继续更新。');
    const run = await adapter.exportObjects({ objects: [updated], target, storage });
    expect(run.plan.items[0].action).toBe('relink_then_update');
    const nextBinding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    expect(nextBinding.remote_path.endsWith('Renamed InkLoop Note.md')).toBe(true);
    expect(await readFile(newPath, 'utf8')).toContain('重命名后继续更新。');

    await rm(vault, { recursive: true, force: true });
  });

  it('relinks an existing note when binding state is missing instead of duplicating it', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const originalStorage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage: originalStorage });

    const freshStorage = new MemoryAdapterStorage();
    const run = await adapter.exportObjects({ objects: [aiNote], target, storage: freshStorage });
    expect(run.plan.items[0].action).toBe('relink_then_update');
    const relinked = await freshStorage.getBinding(target.target_id, aiNote.ko_id);
    expect(relinked?.remote_path).toBe((await originalStorage.getBinding(target.target_id, aiNote.ko_id))?.remote_path);
    const files = await readdir(path.join(vault, '.inkloop', 'Notes'));
    expect(files.filter((file) => file.endsWith('.md'))).toHaveLength(1);

    await rm(vault, { recursive: true, force: true });
  });

  it('creates a new projection and records remote_missing after deletion', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage });
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    await unlink(fromVaultRelative(vault, binding.remote_path));

    const updated = await changedBody(aiNote, '删除后重建。');
    await adapter.exportObjects({ objects: [updated], target, storage });
    const conflicts = await storage.listConflicts({ ko_id: aiNote.ko_id });
    expect(conflicts.some((conflict) => conflict.code === 'remote_file_missing')).toBe(true);
    const nextBinding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    expect(await readFile(fromVaultRelative(vault, nextBinding.remote_path), 'utf8')).toContain('删除后重建。');

    await rm(vault, { recursive: true, force: true });
  });

  it('detects duplicate remote files with the same inkloop_id', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage });
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    const original = fromVaultRelative(vault, binding.remote_path);
    await copyFile(original, path.join(path.dirname(original), 'Copy.md'));

    const updated = await changedBody(aiNote, '重复文件时不要写。');
    const plan = await adapter.plan({ objects: [updated], target, storage });
    expect(plan.items[0].action).toBe('conflict');
    expect(plan.items[0].conflict_code).toBe('duplicate_remote_files');

    await rm(vault, { recursive: true, force: true });
  });

  it('reports duplicate controlled sections separately from duplicate remote files', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [aiNote], target, storage });
    const binding = (await storage.getBinding(target.target_id, aiNote.ko_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    const markdown = await readFile(filePath, 'utf8');
    const section = markdown.slice(markdown.indexOf('<!-- inkloop:begin'), markdown.indexOf('---\n\n## My notes'));
    await writeFile(filePath, markdown.replace('---\n\n## My notes', `${section}\n\n---\n\n## My notes`), 'utf8');

    const updated = await changedBody(aiNote, '重复 controlled section 时不要写。');
    await adapter.exportObjects({ objects: [updated], target, storage });
    const conflicts = await storage.listConflicts({ ko_id: aiNote.ko_id });
    expect(conflicts.some((conflict) => conflict.code === 'duplicate_controlled_sections')).toBe(true);
    expect(conflicts.some((conflict) => conflict.code === 'duplicate_remote_files')).toBe(false);

    await rm(vault, { recursive: true, force: true });
  });

  it('pulls limited metadata only from frontmatter', async () => {
    const vault = await tempVault();
    const [, , , task] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportObjects({ objects: [task], target, storage });
    const binding = (await storage.getBinding(target.target_id, task.ko_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    const markdown = await readFile(filePath, 'utf8');
    const parsed = parseFrontmatter(markdown)!;
    expect(parsed.frontmatter.completed).toBe(false);
    await writeFile(filePath, markdown.replace('inkloop_status: "export_ready"', 'inkloop_status: "archived"').replace('completed: false', 'completed: true'), 'utf8');

    const pulled = await adapter.pullMetadata({ target, bindings: [binding] });
    expect(pulled.updates[0].metadata.status).toBe('archived');
    expect(pulled.updates[0].metadata.completed).toBe(true);

    await rm(vault, { recursive: true, force: true });
  });

  it('does not persist adapter state when JSON storage is opened read-only for dry-run', async () => {
    const vault = await tempVault();
    const [aiNote] = await fixtureObjects();
    const adapter = new ObsidianFsAdapter();
    const target = await adapter.resolveTarget({ vault_root: vault });
    const storage = JsonAdapterStorage.forVault(vault, 'InkLoop', { readOnly: true });

    await adapter.plan({ objects: [aiNote], target, storage });
    await expect(stat(path.join(vault, 'InkLoop', '.inkloop-adapter-state.json'))).rejects.toThrow();

    await rm(vault, { recursive: true, force: true });
  });

  it('does not treat corrupted JSON adapter state as an empty first-run state', async () => {
    const vault = await tempVault();
    const statePath = path.join(vault, 'InkLoop', '.inkloop-adapter-state.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, '{ broken json', 'utf8');

    const storage = JsonAdapterStorage.forVault(vault, 'InkLoop');
    await expect(storage.listBindings({})).rejects.toThrow();

    await rm(vault, { recursive: true, force: true });
  });
});
