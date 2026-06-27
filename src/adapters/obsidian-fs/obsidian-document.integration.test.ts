import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeDocumentProjectionBodyHash,
  computeDocumentProjectionHash,
  parseDocumentProjection,
  type DocumentProjection,
} from '../../knowledge/document-projection';
import { parseKnowledgeObject, type KnowledgeObject } from '../../knowledge/knowledge-object';
import { MemoryAdapterStorage } from '../core/memory-storage';
import { ObsidianFsAdapter } from './adapter';
import { ObsidianFsDocumentAdapter } from './document-adapter';
import { fromVaultRelative } from './target';

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inkloop-vault-doc-test-'));
  await mkdir(path.join(dir, '.obsidian'));
  return dir;
}

async function fixtureInput(): Promise<{ projection: DocumentProjection; objects: KnowledgeObject[] }> {
  const projectionRaw = JSON.parse(await readFile('packages/ko-schema/fixtures/document-projections.json', 'utf8')) as { document_projections: unknown[] };
  const objectsRaw = JSON.parse(await readFile('packages/ko-schema/fixtures/knowledge-objects.json', 'utf8')) as { objects: unknown[] };
  return {
    projection: parseDocumentProjection(projectionRaw.document_projections[0]),
    objects: objectsRaw.objects.map(parseKnowledgeObject),
  };
}

async function changedProjection(projection: DocumentProjection): Promise<DocumentProjection> {
  const blocks = projection.blocks.map((block) => (block.block_id === 'blk_p014_h001' ? { ...block, text_md: '量子纠缠（更新版）' } : block));
  const bodyHash = await computeDocumentProjectionBodyHash(blocks);
  const withoutHash = {
    ...projection,
    blocks,
    body_hash: bodyHash,
    revision_id: bodyHash,
    updated_at: '2026-06-26T09:30:00.000Z',
    content_hash: undefined,
  };
  const { content_hash: _contentHash, ...projectionWithoutHash } = withoutHash as Omit<typeof withoutHash, 'content_hash'> & { content_hash?: undefined };
  return { ...projectionWithoutHash, content_hash: await computeDocumentProjectionHash(projectionWithoutHash) };
}

describe('Obsidian FS document projection export', () => {
  it('creates source documents, records bindings, and skips unchanged exports', async () => {
    const vault = await tempVault();
    const { projection, objects } = await fixtureInput();
    const adapter = new ObsidianFsDocumentAdapter();
    const target = await new ObsidianFsAdapter().resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();

    const first = await adapter.exportDocuments({ projections: [projection], target, storage, knowledgeObjects: objects });
    expect(first.plan.summary.create_count).toBe(1);
    const binding = await storage.getBinding(target.target_id, projection.projection_id);
    expect(binding?.ko_id).toBe(projection.projection_id);
    const markdown = await readFile(fromVaultRelative(vault, binding!.remote_path), 'utf8');
    expect(markdown).toContain('# 量子力学导论');
    expect(markdown).toContain('量子纠缠体现的是测量结果之间的强相关');
    expect(markdown).not.toContain('## Page');
    expect(markdown).not.toContain('inkloop_projection_id');
    expect(markdown).not.toContain('<!-- inkloop:');
    expect(markdown).not.toContain('annotation-json');

    const sidecarDoc = JSON.parse(await readFile(path.join(vault, '.inkloop/docs', projection.document_id, 'document.json'), 'utf8')) as { doc_id: string; source_type: string };
    expect(sidecarDoc).toMatchObject({ doc_id: projection.document_id, source_type: 'markdown' });
    const sidecarBlocks = (await readFile(path.join(vault, '.inkloop/docs', projection.document_id, 'surfaces/markdown.blocks.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { object_id: string; annotations: Array<{ title: string }> });
    expect(sidecarBlocks.map((block) => block.object_id)).toContain('blk_p014_p001');
    expect(sidecarBlocks.flatMap((block) => block.annotations.map((annotation) => annotation.title))).toContain('量子纠缠为什么不传递信息');

    const second = await adapter.exportDocuments({ projections: [projection], target, storage, knowledgeObjects: objects });
    expect(second.plan.summary.skip_count).toBe(1);
    expect(second.results[0].action).toBe('skip_unchanged');

    await rm(vault, { recursive: true, force: true });
  });

  it('skips document projections that are not exportable', async () => {
    const vault = await tempVault();
    const { projection, objects } = await fixtureInput();
    const adapter = new ObsidianFsDocumentAdapter();
    const target = await new ObsidianFsAdapter().resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    const blockedProjection: DocumentProjection = {
      ...projection,
      projection_id: 'dp_blocked_no_full_text',
      export_policy: { ...projection.export_policy, include_full_text: false },
    };

    const run = await adapter.exportDocuments({ projections: [blockedProjection], target, storage, knowledgeObjects: objects });

    expect(run.plan.summary).toMatchObject({ create_count: 0, skip_count: 1, conflict_count: 0 });
    expect(run.plan.items[0]).toMatchObject({
      projection_id: blockedProjection.projection_id,
      action: 'skip_export_blocked',
      reason: 'full text export is not enabled',
    });
    expect(run.results[0]).toMatchObject({ action: 'skip_export_blocked' });
    expect(await storage.getBinding(target.target_id, blockedProjection.projection_id)).toBeNull();

    await rm(vault, { recursive: true, force: true });
  });

  it('updates generated document blocks while preserving editable Obsidian edits', async () => {
    const vault = await tempVault();
    const { projection, objects } = await fixtureInput();
    const adapter = new ObsidianFsDocumentAdapter();
    const target = await new ObsidianFsAdapter().resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportDocuments({ projections: [projection], target, storage, knowledgeObjects: objects });
    const binding = (await storage.getBinding(target.target_id, projection.projection_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    await writeFile(filePath, (await readFile(filePath, 'utf8')).replace('量子纠缠体现的是测量结果之间的强相关，并不是可控的信息发送通道，因此不违反相对论。', '用户在 Obsidian 改写了这一段。'), 'utf8');

    const updated = await changedProjection(projection);
    const run = await adapter.exportDocuments({ projections: [updated], target, storage, knowledgeObjects: objects });
    expect(run.plan.summary.update_count).toBe(1);
    const markdown = await readFile(filePath, 'utf8');
    expect(markdown).toContain('# 量子纠缠（更新版）');
    expect(markdown).toContain('用户在 Obsidian 改写了这一段。');

    await rm(vault, { recursive: true, force: true });
  });

  it('pulls editable source document changes into adapter external edit storage', async () => {
    const vault = await tempVault();
    const { projection, objects } = await fixtureInput();
    const adapter = new ObsidianFsDocumentAdapter();
    const target = await new ObsidianFsAdapter().resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportDocuments({ projections: [projection], target, storage, knowledgeObjects: objects });
    const binding = (await storage.getBinding(target.target_id, projection.projection_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    const before = '量子纠缠体现的是测量结果之间的强相关，并不是可控的信息发送通道，因此不违反相对论。';
    const after = `${before}\n\n这是从 Obsidian 追加的新段落，也应该归到同一个可编辑块。`;
    await writeFile(filePath, (await readFile(filePath, 'utf8')).replace(before, after), 'utf8');

    const pulled = await adapter.pullExternalEdits({
      projections: [projection],
      target,
      storage,
      observed_at: '2026-06-26T10:00:00.000Z',
    });

    expect(pulled.warnings).toEqual([]);
    expect(pulled.external_edits).toHaveLength(1);
    expect(pulled.external_edits[0]).toMatchObject({
      document_id: projection.document_id,
      projection_id: projection.projection_id,
      block_id: 'blk_p014_p001',
      kind: 'document_body',
      status: 'pending',
      payload: {
        after_md: after,
      },
    });
    expect(await storage.listExternalEdits({ projection_id: projection.projection_id })).toHaveLength(1);

    const pulledAgain = await adapter.pullExternalEdits({
      projections: [projection],
      target,
      storage,
      observed_at: '2026-06-26T10:01:00.000Z',
    });
    expect(pulledAgain.external_edits).toHaveLength(1);
    expect(pulledAgain.external_edits[0].edit_id).toBe(pulled.external_edits[0].edit_id);
    expect(await storage.listExternalEdits({ projection_id: projection.projection_id })).toHaveLength(1);

    await rm(vault, { recursive: true, force: true });
  });

  it('records conflicts when generated source document blocks are modified remotely', async () => {
    const vault = await tempVault();
    const { projection, objects } = await fixtureInput();
    const adapter = new ObsidianFsDocumentAdapter();
    const target = await new ObsidianFsAdapter().resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    await adapter.exportDocuments({ projections: [projection], target, storage, knowledgeObjects: objects });
    const binding = (await storage.getBinding(target.target_id, projection.projection_id))!;
    const filePath = fromVaultRelative(vault, binding.remote_path);
    await writeFile(filePath, (await readFile(filePath, 'utf8')).replace('# 量子纠缠', '# 用户改了生成标题'), 'utf8');

    const pulled = await adapter.pullExternalEdits({
      projections: [projection],
      target,
      storage,
      observed_at: '2026-06-26T10:00:00.000Z',
    });

    expect(pulled.external_edits).toEqual([]);
    expect(pulled.conflicts.map((conflict) => conflict.code)).toEqual(['controlled_section_modified']);
    expect((await storage.listConflicts({ ko_id: projection.projection_id }))[0]).toMatchObject({
      code: 'controlled_section_modified',
      remote_path: binding.remote_path,
    });

    await rm(vault, { recursive: true, force: true });
  });
});
