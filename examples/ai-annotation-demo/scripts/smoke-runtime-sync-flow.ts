/**
 * Runtime Sync smoke: Web/e-paper-shaped sidecar store <-> Obsidian-shaped sidecar store.
 *
 * Usage:
 *   npx tsx scripts/smoke-runtime-sync-flow.ts
 *
 * The script prints structured JSON evidence. It intentionally does not call
 * the clean Markdown vault release path; this validates the canonical runtime
 * store + event-log + inbox path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarRuntimeStore } from '../../../packages/offline-store/src/file-sidecar-store';
import { LocalEventLogTransport, RuntimeSyncRunner } from '../../../packages/sync-client/src/index';
import type { RuntimeDocumentSnapshot, RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';
import { RuntimeStoreInbox } from '../src/integration/inksurface/runtime-inbox';

function snapshot(docId: string, options: { includeWebAnnotation?: boolean } = {}): RuntimeDocumentSnapshot {
  return {
    doc_id: docId,
    doc_dir: `.inkloop/docs/${docId}`,
    document: { doc_id: docId, title: 'Runtime Smoke Doc', source_type: 'markdown' },
    source: { doc_id: docId, kind: 'native_markdown', vault_file: { path: 'InkLoop/Runtime Smoke Doc.md' } },
    blocks: [{
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_smoke',
      doc_id: docId,
      text: 'Original smoke paragraph.',
      source_anchor: { quote: 'Original smoke paragraph.' },
      projection: { block_id: 'blk_smoke', kind: 'paragraph', region: 'editable', knowledge_object_ids: [] },
      annotations: options.includeWebAnnotation ? [{
        ko_id: 'ko_smoke_web_pen',
        title: 'Smoke pencil',
        render_mode: 'stroke_only',
        visual_strokes: [{ tool: 'pen', color: '#38bdf8', opacity: 0.92, points: [{ x: 0.12, y: 0.2 }, { x: 0.38, y: 0.24 }] }],
      }] : [],
    }],
    nodes: [],
  };
}

function event(input: Partial<RuntimeSyncEvent> & { event_id: string; doc_id: string; deviceId: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'inkloop_device',
    doc_id: input.doc_id,
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: 'ko_smoke_web_pen', block_id: 'blk_smoke' },
    payload: input.payload ?? {
      block_id: 'blk_smoke',
      annotation: {
        ko_id: 'ko_smoke_web_pen',
        title: 'Smoke pencil',
        render_mode: 'stroke_only',
        visual_strokes: [{ tool: 'pen', color: '#38bdf8', opacity: 0.92, points: [{ x: 0.12, y: 0.2 }, { x: 0.38, y: 0.24 }] }],
      },
    },
    origin: { device_id: input.deviceId },
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-07-02T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-07-02T00:00:00.000Z',
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), 'inkloop-runtime-smoke-'));
  const webRoot = join(root, 'web');
  const obsidianRoot = join(root, 'obsidian');
  const docId = 'doc_runtime_smoke';
  const web = new SidecarRuntimeStore({ vaultRoot: webRoot });
  const obsidian = new SidecarRuntimeStore({ vaultRoot: obsidianRoot });
  const transport = new LocalEventLogTransport();

  try {
    await web.writeDocumentSnapshot(snapshot(docId, { includeWebAnnotation: true }));
    await obsidian.writeDocumentSnapshot(snapshot(docId));

    await web.appendSyncEvent(event({ event_id: 'evt_smoke_web_pen', doc_id: docId, deviceId: 'web-smoke' }));
    const webPush = await new RuntimeSyncRunner(web, transport, { deviceId: 'web-smoke' }).syncOnce();
    const obsPull = await new RuntimeSyncRunner(obsidian, transport, {
      deviceId: 'obsidian-smoke',
      inbox: new RuntimeStoreInbox(obsidian, { deviceId: 'obsidian-smoke' }),
      now: () => '2026-07-02T00:00:01.000Z',
    }).pullOnce();

    await obsidian.appendSyncEvent(event({
      event_id: 'evt_smoke_obs_text',
      doc_id: docId,
      deviceId: 'obsidian-smoke',
      source: 'obsidian_plugin',
      operation: 'block.update',
      target: { type: 'block', id: 'blk_smoke', block_id: 'blk_smoke' },
      payload: { block_id: 'blk_smoke', content_md: 'Edited from Obsidian smoke.' },
    }));
    await obsidian.appendSyncEvent(event({
      event_id: 'evt_smoke_obs_knowledge',
      doc_id: docId,
      deviceId: 'obsidian-smoke',
      source: 'obsidian_plugin',
      operation: 'knowledge.update',
      target: { type: 'knowledge_object', id: 'ko_smoke_web_pen' },
      payload: {
        ko_id: 'ko_smoke_web_pen',
        patch: {
          status: 'archived',
          tags: ['inkloop', 'inkloop/task'],
          task_done: true,
        },
        source: 'obsidian_controlled_fields',
      },
    }));
    const obsPush = await new RuntimeSyncRunner(obsidian, transport, { deviceId: 'obsidian-smoke' }).syncOnce();
    const webPull = await new RuntimeSyncRunner(web, transport, {
      deviceId: 'web-smoke',
      inbox: new RuntimeStoreInbox(web, { deviceId: 'web-smoke' }),
      now: () => '2026-07-02T00:00:02.000Z',
    }).pullOnce();

    const webRuntime = await web.loadDocument(docId);
    const obsidianRuntime = await obsidian.loadDocument(docId);
    const annotations = webRuntime?.blocks[0].annotations ?? [];
    const knowledgePatch = annotations.find((annotation) => annotation.ko_id === 'ko_smoke_web_pen')?.controlled_fields as Record<string, unknown> | undefined;
    const evidence = {
      ok: webRuntime?.blocks[0].text === 'Edited from Obsidian smoke.' && annotations.length === 1 && knowledgePatch?.task_done === true,
      latency_ms: Date.now() - started,
      temp_root: root,
      web_to_obsidian: {
        push: webPush.push,
        pull: obsPull,
        obsidian_annotation_count: obsidianRuntime?.blocks[0].annotations?.length ?? 0,
        obsidian_stroke_color: obsidianRuntime?.blocks[0].annotations?.[0]?.visual_strokes?.[0]?.color,
      },
      obsidian_to_web: {
        push: obsPush.push,
        pull: webPull,
        web_text: webRuntime?.blocks[0].text,
        web_annotation_count: annotations.length,
        controlled_knowledge_patch: knowledgePatch,
      },
      release_path_used: false,
    };
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.ok) process.exitCode = 1;
  } finally {
    if (!process.argv.includes('--keep')) await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
