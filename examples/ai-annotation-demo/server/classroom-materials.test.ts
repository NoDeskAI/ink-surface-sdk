import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClassroomMaterialService } from './classroom-materials';
import { ClassroomService } from './classroom-service';
import { JsonClassroomStore } from './classroom-store';

describe('ClassroomMaterialService', () => {
  it('validates, stores, deduplicates and reloads a native PDF', async () => {
    const root = await mkdtemp(join(tmpdir(), 'classroom-materials-'));
    const store = await JsonClassroomStore.open(root);
    const service = new ClassroomService(store);
    const materials = new ClassroomMaterialService(store, service);
    const created = await store.createClassroom('Textbook');
    const id = created.classroom.classroom_id;
    const bytes = new Uint8Array(await readFile(join(process.cwd(), 'public/sample.pdf')));

    const first = await materials.publish(id, { bytes, title: 'Sample', idempotencyKey: 'upload_1' });
    const second = await materials.publish(id, { bytes, title: 'Sample', idempotencyKey: 'upload_1' });
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ material: first.material, inserted: false });
    expect(first.material).toMatchObject({ page_count: 1, mime_type: 'application/pdf', byte_size: bytes.byteLength });

    const restarted = await JsonClassroomStore.open(root);
    expect(await restarted.getMaterial(id, first.material.material_id)).toEqual(first.material);
    expect(await restarted.getMaterialBytes(id, first.material.material_id)).toEqual(bytes);
    expect((await restarted.getTimeline(id)).at(-1)).toMatchObject({ kind: 'material_published', material: { material_id: first.material.material_id } });
  });

  it('rejects disguised and empty PDFs without publishing material state', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-materials-invalid-')));
    const created = await store.createClassroom('Invalid');
    const materials = new ClassroomMaterialService(store, new ClassroomService(store));
    await expect(materials.publish(created.classroom.classroom_id, { bytes: new TextEncoder().encode('not pdf'), title: 'Bad', idempotencyKey: 'bad_1' })).rejects.toThrow('pdf_invalid_magic');
    await expect(materials.publish(created.classroom.classroom_id, { bytes: new Uint8Array(), title: 'Empty', idempotencyKey: 'bad_2' })).rejects.toThrow('pdf_empty');
    expect((await store.getSharedState(created.classroom.classroom_id)).materials).toEqual([]);
  });

  it('publishes the distributable completing-square handout as builtin material', async () => {
    const store = await JsonClassroomStore.open(await mkdtemp(join(tmpdir(), 'classroom-materials-builtin-')));
    const created = await store.createClassroom('Builtin');
    const result = await new ClassroomMaterialService(store, new ClassroomService(store)).publishBuiltin(created.classroom.classroom_id);
    expect(result.material).toMatchObject({ source: 'builtin', page_count: 2, title: '配方法课堂讲义' });
  });

  it('lazily derives and atomically caches page geometry for historical material metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'classroom-materials-legacy-'));
    const store = await JsonClassroomStore.open(root);
    const created = await store.createClassroom('Legacy material'); const id = created.classroom.classroom_id;
    const bytes = new Uint8Array(await readFile(join(process.cwd(), 'public/sample.pdf')));
    const published = await new ClassroomMaterialService(store, new ClassroomService(store)).publish(id, { bytes, title: 'Legacy', idempotencyKey: 'legacy_upload' });
    const metaPath = join(root, id, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { materials: Array<Record<string, unknown>> };
    delete meta.materials[0].page_geometries;
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const historical = await JsonClassroomStore.open(root);
    const derived = await historical.getMaterial(id, published.material.material_id);
    expect(derived?.page_geometries).toEqual(published.material.page_geometries);
    const restarted = await JsonClassroomStore.open(root);
    expect((await restarted.getMaterial(id, published.material.material_id))?.page_geometries).toEqual(published.material.page_geometries);
  });
});
