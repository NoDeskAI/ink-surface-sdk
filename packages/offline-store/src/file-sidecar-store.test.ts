import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SidecarRuntimeStore } from './file-sidecar-store';
import type { RuntimeSurfaceBlock, RuntimeSyncEvent } from '../../runtime-schema/src/index.js';

const DOC_ID = 'doc_runtime';
const SOURCE_PATH = 'InkLoop/Runtime Doc.md';
const EXISTING_KO_ID = 'ko_existing_annotation';

const tempRoots: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonLines(filePath: string, values: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, values.map((value) => JSON.stringify(value)).join('\n') + '\n', 'utf8');
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  return (await readFile(filePath, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function makeVault(): Promise<{ vaultRoot: string; store: SidecarRuntimeStore; blocksPath: string; sourcePath: string }> {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'inkloop-runtime-'));
  tempRoots.push(vaultRoot);
  const docDir = path.join(vaultRoot, '.inkloop', 'docs', DOC_ID);
  const blocksPath = path.join(docDir, 'surfaces', 'markdown.blocks.jsonl');
  const sourcePath = path.join(vaultRoot, SOURCE_PATH);

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, '# Runtime Doc\n\nFirst paragraph.\n\nSecond paragraph.\n', 'utf8');
  await writeJson(path.join(docDir, 'document.json'), {
    schema_version: 'inkloop.document.v1',
    doc_id: DOC_ID,
    title: 'Runtime Doc',
    source_type: 'markdown',
    updated_at: '2026-06-27T00:00:00.000Z',
  });
  await writeJson(path.join(docDir, 'source.json'), {
    schema_version: 'inkloop.source_ref.v1',
    doc_id: DOC_ID,
    kind: 'obsidian_vault_file',
    vault_file: { path: SOURCE_PATH, extension: '.md' },
    identity: { current_content_hash: 'sha256:old' },
  });
  await writeJsonLines(blocksPath, [
    {
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_first',
      doc_id: DOC_ID,
      text: 'First paragraph.',
      source_anchor: { type: 'markdown', quote: 'First paragraph.', range: { start_line: 3, start_col: 0, end_line: 3, end_col: 16 } },
      projection: { block_id: 'blk_first', kind: 'paragraph', region: 'editable', knowledge_object_ids: [EXISTING_KO_ID] },
      annotations: [{ ko_id: EXISTING_KO_ID, kind: 'ai_note', title: 'Old note', body_md: 'Old body', status: 'accepted' }],
    },
    {
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_second',
      doc_id: DOC_ID,
      text: 'Second paragraph.',
      source_anchor: { type: 'markdown', quote: 'Second paragraph.', range: { start_line: 5, start_col: 0, end_line: 5, end_col: 17 } },
      projection: { block_id: 'blk_second', kind: 'paragraph', region: 'editable', knowledge_object_ids: [] },
      annotations: [],
    },
  ]);

  return { vaultRoot, store: new SidecarRuntimeStore({ vaultRoot }), blocksPath, sourcePath };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SidecarRuntimeStore', () => {
  it('updates markdown source blocks through the runtime port and shifts later ranges', async () => {
    const { store, blocksPath, sourcePath } = await makeVault();

    const result = await store.updateBlockContent({
      doc_id: DOC_ID,
      block_id: 'blk_first',
      content: 'First paragraph edited.\nStill first block.',
      source: 'web_lab',
      commit_target: { type: 'markdown_source_patch' },
    });

    expect(await readFile(sourcePath, 'utf8')).toContain('First paragraph edited.\nStill first block.');
    const blocks = await readJsonLines<RuntimeSurfaceBlock>(blocksPath);
    expect(blocks[0].source_anchor?.quote).toBe('First paragraph edited. Still first block.');
    expect(blocks[0].source_anchor?.range).toMatchObject({ start_line: 3, end_line: 4 });
    expect(blocks[1].source_anchor?.range).toMatchObject({ start_line: 6, end_line: 6 });
    expect(result.sync_event).toMatchObject({
      schema_version: 'inkloop.runtime_sync_event.v1',
      operation: 'block.update',
      source: 'web_lab',
      target: { type: 'block', id: 'blk_first' },
      status: 'pending',
    });
  });

  it('rejects source paths that escape the vault before patching markdown', async () => {
    const { vaultRoot, store, sourcePath } = await makeVault();
    const escapedPath = path.join(path.dirname(vaultRoot), 'outside-runtime.md');
    tempRoots.push(escapedPath);
    await writeFile(escapedPath, 'outside should stay unchanged\n', 'utf8');
    await writeJson(path.join(vaultRoot, '.inkloop', 'docs', DOC_ID, 'source.json'), {
      schema_version: 'inkloop.source_ref.v1',
      doc_id: DOC_ID,
      kind: 'obsidian_vault_file',
      vault_file: { path: '../outside-runtime.md', extension: '.md' },
      identity: { current_content_hash: 'sha256:old' },
    });

    await expect(store.updateBlockContent({
      doc_id: DOC_ID,
      block_id: 'blk_first',
      content: 'escaped write',
      source: 'web_lab',
      commit_target: { type: 'markdown_source_patch' },
    })).rejects.toThrow(/escapes the vault/);
    expect(await readFile(escapedPath, 'utf8')).toBe('outside should stay unchanged\n');
    expect(await readFile(sourcePath, 'utf8')).toContain('First paragraph.');
  });

  it('updates sidecar annotations and appends a cloud-shaped outbox event', async () => {
    const { store, blocksPath } = await makeVault();

    const result = await store.updateAnnotation({
      doc_id: DOC_ID,
      ko_id: EXISTING_KO_ID,
      patch: { title: 'Edited note', body_md: 'Edited body', ignored: undefined },
      source: 'obsidian_plugin',
    });

    const blocks = await readJsonLines<RuntimeSurfaceBlock>(blocksPath);
    expect(blocks[0].annotations?.[0]).toMatchObject({ ko_id: EXISTING_KO_ID, title: 'Edited note', body_md: 'Edited body' });
    expect(result.sync_event.payload.patch).toEqual({ title: 'Edited note', body_md: 'Edited body' });
    expect(await store.listOutboxEvents()).toHaveLength(1);
  });

  it('adds stroke-only annotations and records the projection binding in sidecar', async () => {
    const { store, blocksPath } = await makeVault();

    const result = await store.addAnnotation({
      doc_id: DOC_ID,
      block_id: 'blk_second',
      source: 'web_lab',
      kind: 'annotation',
      title: 'Hand mark',
      render_mode: 'stroke_only',
      visual_bbox: [0.1, 0.2, 0.3, 0.4],
      visual_strokes: [{ tool: 'pen', points: [{ x: 0.1, y: 0.2, pressure: 0.5 }] }],
    });

    const blocks = await readJsonLines<RuntimeSurfaceBlock>(blocksPath);
    expect(blocks[1].annotations?.[0]).toMatchObject({ ko_id: result.annotation?.ko_id, title: 'Hand mark', render_mode: 'stroke_only' });
    expect(blocks[1].projection?.knowledge_object_ids).toContain(result.annotation?.ko_id);
    const outbox = await store.listOutboxEvents();
    expect(outbox.map((event: RuntimeSyncEvent) => event.operation)).toEqual(['annotation.add']);
  });
});
