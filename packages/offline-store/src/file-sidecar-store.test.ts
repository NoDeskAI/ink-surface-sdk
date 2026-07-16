import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SidecarRuntimeStore } from './file-sidecar-store';
import type { RuntimeDocumentSnapshot, RuntimeSurfaceBlock, RuntimeSyncEvent } from '../../runtime-schema/src/index.js';

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

function runtimeEvent(input: Partial<RuntimeSyncEvent> & { event_id: string; operation: RuntimeSyncEvent['operation'] }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'cloud',
    doc_id: input.doc_id ?? DOC_ID,
    operation: input.operation,
    target: input.target ?? { type: 'document', id: input.doc_id ?? DOC_ID },
    payload: input.payload ?? {},
    status: input.status ?? 'sent',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-06-28T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-06-28T00:00:00.000Z',
  };
}

function bootstrapSnapshot(): RuntimeDocumentSnapshot {
  return {
    doc_id: 'doc_bootstrap',
    doc_dir: '.inkloop/docs/doc_bootstrap',
    document: { doc_id: 'doc_bootstrap', title: 'Bootstrap', source_type: 'markdown' },
    identity: {
      schema_version: 'inkloop.runtime_document_identity.v1',
      doc_id: 'doc_bootstrap',
      source_kind: 'native_markdown',
      stable_key: 'obsidian://vault/Bootstrap.md',
      source_path: 'Bootstrap.md',
      created_at: '2026-06-28T00:00:00.000Z',
      updated_at: '2026-06-28T00:00:00.000Z',
    },
    source: { doc_id: 'doc_bootstrap', kind: 'obsidian_vault_file', vault_file: { path: 'Bootstrap.md' } },
    blocks: [{
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_bootstrap',
      doc_id: 'doc_bootstrap',
      text: 'Bootstrapped text.',
      projection: { block_id: 'blk_bootstrap', kind: 'paragraph', region: 'editable', knowledge_object_ids: [] },
      annotations: [],
    }],
    nodes: [],
  };
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

  it('applies bootstrap snapshots and records applied remote events without touching outbox', async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'inkloop-runtime-'));
    tempRoots.push(vaultRoot);
    const store = new SidecarRuntimeStore({ vaultRoot });
    const snapshot = bootstrapSnapshot();

    const result = await store.applyRemoteEvent(runtimeEvent({
      event_id: 'evt_bootstrap',
      doc_id: 'doc_bootstrap',
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: 'doc_bootstrap' },
      payload: { snapshot },
    }));

    expect(result.status).toBe('applied');
    expect(await store.loadDocument('doc_bootstrap')).toMatchObject({ doc_id: 'doc_bootstrap', blocks: [{ object_id: 'blk_bootstrap' }] });
    expect(await store.listAppliedEventIds('doc_bootstrap')).toEqual(['evt_bootstrap']);
    expect(await store.listOutboxEvents()).toEqual([]);
  });

  it('drops stale sidecar annotations when a remote bootstrap snapshot has no marks', async () => {
    const { store, blocksPath } = await makeVault();
    const current = await store.loadDocument(DOC_ID);
    if (!current) throw new Error('test setup missing runtime doc');
    const emptyBootstrap: RuntimeDocumentSnapshot = {
      ...current,
      blocks: current.blocks.map((block) => ({
        ...block,
        annotations: [],
        projection: { ...(block.projection || {}), knowledge_object_ids: [] },
      })),
    };

    const result = await store.applyRemoteEvent(runtimeEvent({
      event_id: 'evt_empty_bootstrap_drops_marks',
      operation: 'runtime.bootstrap',
      target: { type: 'document', id: DOC_ID },
      payload: { snapshot: emptyBootstrap },
    }));

    expect(result.status).toBe('applied');
    const blocks = await readJsonLines<RuntimeSurfaceBlock>(blocksPath);
    expect(blocks[0].annotations).toEqual([]);
    expect(blocks[0]?.projection?.knowledge_object_ids).toEqual([]);
  });

  it('retains a deleted annotation stub when delete follows an annotation-stripping bootstrap', async () => {
    const { store, blocksPath } = await makeVault();
    const current = await store.loadDocument(DOC_ID);
    if (!current) throw new Error('test setup missing runtime doc');
    const emptyBootstrap: RuntimeDocumentSnapshot = {
      ...current,
      blocks: current.blocks.map((block) => ({
        ...block,
        annotations: [],
        projection: { ...(block.projection || {}), knowledge_object_ids: [] },
      })),
    };
    expect((await store.applyRemoteEvent(runtimeEvent({
      event_id: 'evt_delete_chain_bootstrap_sidecar',
      operation: 'runtime.bootstrap',
      payload: { snapshot: emptyBootstrap },
    }))).status).toBe('applied');
    expect((await readJsonLines<RuntimeSurfaceBlock>(blocksPath))[0].annotations).toEqual([]);

    const deletion = runtimeEvent({
      event_id: 'evt_delete_chain_sidecar',
      operation: 'annotation.delete',
      target: { type: 'annotation', id: EXISTING_KO_ID, block_id: 'blk_first' },
      payload: {
        ko_id: EXISTING_KO_ID,
        mark_id: 'mark_deleted_after_bootstrap',
        block_id: 'blk_first',
        deleted_at: '2026-07-15T00:00:02.000Z',
      },
    });
    expect((await store.applyRemoteEvent(deletion)).status).toBe('applied');
    expect((await store.applyRemoteEvent(deletion)).status).toBe('skipped');
    expect((await readJsonLines<RuntimeSurfaceBlock>(blocksPath))[0].annotations).toEqual([
      {
        ko_id: EXISTING_KO_ID,
        status: 'deleted',
        deleted_at: '2026-07-15T00:00:02.000Z',
        inkloop_mark: { mark_id: 'mark_deleted_after_bootstrap' },
      },
    ]);
    expect(await store.listOutboxEvents()).toEqual([]);
  });

  it('applies and dedupes remote annotation events through the sidecar inbox', async () => {
    const { store, blocksPath } = await makeVault();
    const remote = runtimeEvent({
      event_id: 'evt_remote_add',
      operation: 'annotation.add',
      target: { type: 'annotation', id: 'ko_remote', block_id: 'blk_second' },
      payload: {
        block_id: 'blk_second',
        mark_id: 'mark_remote',
        marked_text: 'Remote marked text',
        page_id: 'pg_sidecar_1',
        page_index: 1,
        bbox: [0.1, 0.2, 0.3, 0.04],
        annotation: { ko_id: 'ko_remote', title: 'Remote mark', render_mode: 'stroke_only', visual_bbox: [-4, -1, 9, 1.2], visual_strokes: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] },
      },
    });

    expect((await store.applyRemoteEvent(remote)).status).toBe('applied');
    expect((await store.applyRemoteEvent(remote)).status).toBe('skipped');

    const blocks = await readJsonLines<RuntimeSurfaceBlock>(blocksPath);
    expect(blocks[1].annotations?.find((annotation) => annotation.ko_id === 'ko_remote')).toMatchObject({
      visual_bbox: [0.1, 0.2, 0.3, 0.04],
      inkloop_mark: {
        mark_id: 'mark_remote',
        marked_text: 'Remote marked text',
        page_id: 'pg_sidecar_1',
        page_index: 1,
        bbox: [0.1, 0.2, 0.3, 0.04],
      },
    });
    expect(await store.listPendingEvents()).toEqual([]);
  });

  it('dedupes sidecar remote annotation adds by mark_id before falling back to ko_id', async () => {
    const { store, blocksPath } = await makeVault();

    for (const item of [
      { event_id: 'evt_remote_same_ko_a', mark_id: 'mark_a', bbox: [0.1, 0.2, 0.3, 0.04] },
      { event_id: 'evt_remote_same_ko_b', mark_id: 'mark_b', bbox: [0.2, 0.3, 0.3, 0.04] },
    ] as const) {
      expect((await store.applyRemoteEvent(runtimeEvent({
        event_id: item.event_id,
        operation: 'annotation.add',
        target: { type: 'annotation', id: 'ko_shared', block_id: 'blk_first' },
        payload: {
          block_id: 'blk_first',
          mark_id: item.mark_id,
          page_id: 'pg_sidecar_0',
          page_index: 0,
          bbox: item.bbox,
          annotation: { ko_id: 'ko_shared', title: item.mark_id, render_mode: 'stroke_only' },
        },
      }))).status).toBe('applied');
    }

    const blocks = await readJsonLines<RuntimeSurfaceBlock>(blocksPath);
    const markIds = (blocks[0].annotations ?? [])
      .map((annotation) => (annotation.inkloop_mark as { mark_id?: string } | undefined)?.mark_id)
      .filter(Boolean)
      .sort();
    expect(markIds).toEqual(['mark_a', 'mark_b']);
    expect(markIds).toHaveLength(2);
  });

  it('records conflicts and cursors in hidden sidecar files', async () => {
    const { store } = await makeVault();

    const result = await store.applyRemoteEvent(runtimeEvent({
      event_id: 'evt_missing_remote',
      operation: 'annotation.update',
      target: { type: 'annotation', id: 'ko_missing' },
      payload: { ko_id: 'ko_missing', patch: { title: 'Missing' } },
    }));
    await store.writeDeviceCursor({ device_id: 'obsidian_device', cursor: 'cursor_1', updated_at: '2026-06-28T00:00:00.000Z' });

    expect(result.status).toBe('conflicted');
    expect(await store.getDeviceCursor('obsidian_device')).toMatchObject({ cursor: 'cursor_1' });
    expect((await store.listConflicts(DOC_ID))[0]).toMatchObject({ event_id: 'evt_missing_remote', doc_id: DOC_ID });
  });
});
