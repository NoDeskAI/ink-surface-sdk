import { indexedDB } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbOfflineRuntimeStore } from 'ink-surface-sdk/offline-store';
import { LocalEventLogTransport, RuntimeSyncRunner } from 'ink-surface-sdk/sync-client';
import type { RuntimeDocumentSnapshot, RuntimeSyncEvent } from 'ink-surface-sdk/runtime-schema';
import { RuntimeStoreInbox } from './runtime-inbox';

function snapshot(docId: string, options: { includeWebAnnotation?: boolean } = {}): RuntimeDocumentSnapshot {
  return {
    doc_id: docId,
    doc_dir: `indexeddb://${docId}`,
    document: { doc_id: docId, title: 'Runtime Flow Doc', source_type: 'markdown' },
    source: { doc_id: docId, kind: 'native_markdown', vault_file: { path: 'Runtime Flow Doc.md' } },
    blocks: [{
      schema_version: 'inkloop.surface_object.v1',
      object_id: 'blk_flow',
      doc_id: docId,
      text: 'Original runtime paragraph.',
      source_anchor: { quote: 'Original runtime paragraph.' },
      projection: { block_id: 'blk_flow', kind: 'paragraph', region: 'editable', knowledge_object_ids: [] },
      annotations: options.includeWebAnnotation ? [{
        ko_id: 'ko_flow',
        title: 'Blue pencil',
        render_mode: 'stroke_only',
        visual_strokes: [{ tool: 'pen', color: '#38bdf8', opacity: 0.92, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.3 }] }],
      }] : [],
    }],
    nodes: [],
  };
}

function runtimeEvent(input: Partial<RuntimeSyncEvent> & { event_id: string; doc_id: string; deviceId: string }): RuntimeSyncEvent {
  return {
    schema_version: 'inkloop.runtime_sync_event.v1',
    event_id: input.event_id,
    source: input.source ?? 'inkloop_device',
    doc_id: input.doc_id,
    operation: input.operation ?? 'annotation.add',
    target: input.target ?? { type: 'annotation', id: 'ko_flow', block_id: 'blk_flow' },
    payload: input.payload ?? {
      block_id: 'blk_flow',
      annotation: {
        ko_id: 'ko_flow',
        title: 'Blue pencil',
        render_mode: 'stroke_only',
        visual_strokes: [{ tool: 'pen', color: '#38bdf8', opacity: 0.92, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.3 }] }],
      },
    },
    origin: { device_id: input.deviceId },
    status: input.status ?? 'pending',
    dedupe_key: input.dedupe_key ?? input.event_id,
    created_at: input.created_at ?? '2026-07-02T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-07-02T00:00:00.000Z',
  };
}

describe('runtime sync flow', () => {
  it('syncs Web/e-paper marks to Obsidian and Obsidian edits back to Web without duplicate strokes', async () => {
    const docId = 'doc_runtime_flow';
    const web = new IndexedDbOfflineRuntimeStore({ dbName: `flow-web-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const obsidian = new IndexedDbOfflineRuntimeStore({ dbName: `flow-obs-${Date.now()}-${Math.random()}`, factory: indexedDB });
    const transport = new LocalEventLogTransport({ now: () => '2026-07-02T00:00:00.000Z' });
    await web.writeDocumentSnapshot(snapshot(docId, { includeWebAnnotation: true }));
    await obsidian.writeDocumentSnapshot(snapshot(docId));

    await web.appendSyncEvent(runtimeEvent({ event_id: 'evt_web_pen', doc_id: docId, deviceId: 'web-demo' }));
    await new RuntimeSyncRunner(web, transport, { deviceId: 'web-demo' }).syncOnce();
    await new RuntimeSyncRunner(obsidian, transport, {
      deviceId: 'obsidian-plugin',
      inbox: new RuntimeStoreInbox(obsidian, { deviceId: 'obsidian-plugin' }),
      now: () => '2026-07-02T00:00:01.000Z',
    }).pullOnce();

    const obsidianAnnotations = (await obsidian.loadDocument(docId))?.blocks[0].annotations ?? [];
    expect(obsidianAnnotations).toHaveLength(1);
    expect(obsidianAnnotations[0].visual_strokes?.[0]).toMatchObject({ color: '#38bdf8', opacity: 0.92 });

    await obsidian.appendSyncEvent(runtimeEvent({
      event_id: 'evt_obs_text',
      doc_id: docId,
      deviceId: 'obsidian-plugin',
      source: 'obsidian_plugin',
      operation: 'block.update',
      target: { type: 'block', id: 'blk_flow', block_id: 'blk_flow' },
      payload: { block_id: 'blk_flow', content_md: 'Edited from Obsidian.' },
    }));
    await obsidian.appendSyncEvent(runtimeEvent({
      event_id: 'evt_obs_pen',
      doc_id: docId,
      deviceId: 'obsidian-plugin',
      source: 'obsidian_plugin',
      target: { type: 'annotation', id: 'ko_obs_pen', block_id: 'blk_flow' },
      payload: {
        block_id: 'blk_flow',
        annotation: {
          ko_id: 'ko_obs_pen',
          title: 'Obsidian handwriting',
          render_mode: 'stroke_only',
          visual_strokes: [{ tool: 'highlighter', color: '#facc15', opacity: 0.56, points: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.2 }] }],
        },
      },
    }));
    await new RuntimeSyncRunner(obsidian, transport, { deviceId: 'obsidian-plugin' }).syncOnce();
    await new RuntimeSyncRunner(web, transport, {
      deviceId: 'web-demo',
      inbox: new RuntimeStoreInbox(web, { deviceId: 'web-demo' }),
      now: () => '2026-07-02T00:00:02.000Z',
    }).pullOnce();
    await new RuntimeSyncRunner(web, transport, {
      deviceId: 'web-demo',
      inbox: new RuntimeStoreInbox(web, { deviceId: 'web-demo' }),
      now: () => '2026-07-02T00:00:03.000Z',
    }).pullOnce();

    const webRuntime = await web.loadDocument(docId);
    expect(webRuntime?.blocks[0].text).toBe('Edited from Obsidian.');
    const annotations = webRuntime?.blocks[0].annotations ?? [];
    expect(annotations.map((annotation) => annotation.ko_id).sort()).toEqual(['ko_flow', 'ko_obs_pen']);
    expect(annotations.filter((annotation) => annotation.ko_id === 'ko_obs_pen')).toHaveLength(1);
    expect(annotations.find((annotation) => annotation.ko_id === 'ko_obs_pen')?.visual_strokes?.[0]).toMatchObject({ tool: 'highlighter', color: '#facc15', opacity: 0.56 });

    await web.close();
    await obsidian.close();
  });
});
