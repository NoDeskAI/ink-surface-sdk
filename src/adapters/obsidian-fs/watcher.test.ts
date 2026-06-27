import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocumentProjection } from '../../knowledge/document-projection';
import type { ExternalBinding } from '../core/types';
import { MemoryAdapterStorage } from '../core/memory-storage';
import { ObsidianFsAdapter } from './adapter';
import { ObsidianFsDocumentAdapter } from './document-adapter';
import { fromVaultRelative } from './target';
import { JsonlWatchOutbox, scanObsidianFsChanges } from './watcher';

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'inkloop-vault-watch-test-'));
  await mkdir(path.join(dir, '.obsidian'));
  return dir;
}

async function fixtureProjection() {
  const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/document-projections.json', 'utf8')) as { document_projections: unknown[] };
  return parseDocumentProjection(raw.document_projections[0]);
}

describe('Obsidian FS watcher fallback', () => {
  it('detects seen, modified, and renamed bound source documents and writes outbox events', async () => {
    const vault = await tempVault();
    const projection = await fixtureProjection();
    const target = await new ObsidianFsAdapter().resolveTarget({ vault_root: vault });
    const storage = new MemoryAdapterStorage();
    const adapter = new ObsidianFsDocumentAdapter();
    await adapter.exportDocuments({ projections: [projection], target, storage });
    const binding = (await storage.getBinding(target.target_id, projection.projection_id)) as ExternalBinding;
    const outboxPath = path.join(vault, 'InkLoop', '.watch.jsonl');
    const outbox = new JsonlWatchOutbox(outboxPath);

    const first = await scanObsidianFsChanges({ target, bindings: [binding], observed_at: '2026-06-26T10:00:00.000Z', outbox });
    expect(first.events.map((event) => event.event_type)).toEqual(['file_seen']);

    const filePath = fromVaultRelative(vault, binding.remote_path);
    await writeFile(filePath, `${await readFile(filePath, 'utf8')}\n用户修改。\n`, 'utf8');
    const second = await scanObsidianFsChanges({ target, bindings: [binding], previous: first.snapshot, observed_at: '2026-06-26T10:01:00.000Z', outbox });
    expect(second.events.map((event) => event.event_type)).toEqual(['file_modified']);

    const renamedPath = path.join(path.dirname(filePath), 'Renamed Source.md');
    await rename(filePath, renamedPath);
    const third = await scanObsidianFsChanges({ target, bindings: [binding], previous: second.snapshot, observed_at: '2026-06-26T10:02:00.000Z', outbox });
    expect(third.events.map((event) => event.event_type)).toEqual(['file_renamed']);
    expect(third.events[0].previous_remote_path).toBe(binding.remote_path);
    expect(await readFile(outboxPath, 'utf8')).toContain('"file_renamed"');

    await rm(vault, { recursive: true, force: true });
  });
});
