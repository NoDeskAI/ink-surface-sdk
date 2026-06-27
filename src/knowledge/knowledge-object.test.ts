import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical-json';
import { computeKnowledgeHash, recomputeKnowledgeHash } from './hash';
import { parseKnowledgeObject, safeParseKnowledgeObject, type KnowledgeObject } from './knowledge-object';
import { buildInkloopKoUri, buildInkloopPageUri } from './uri';

async function fixtureObjects(): Promise<KnowledgeObject[]> {
  const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/knowledge-objects.json', 'utf8')) as { objects: unknown[] };
  return raw.objects.map(parseKnowledgeObject);
}

describe('KnowledgeObject schema and hashing', () => {
  it('validates shared fixtures and their content hashes', async () => {
    const objects = await fixtureObjects();
    expect(objects).toHaveLength(5);
    for (const object of objects) {
      await expect(recomputeKnowledgeHash(object)).resolves.toBe(object.content_hash);
    }
  });

  it('rejects a fixture missing ko_id', async () => {
    const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/invalid-missing-ko-id.json', 'utf8')) as unknown;
    expect(safeParseKnowledgeObject(raw).success).toBe(false);
  });

  it('canonicalizes object keys while preserving array order', async () => {
    expect(canonicalize({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: ['x', 'y'] })).not.toBe(canonicalize({ a: ['y', 'x'] }));

    const [object] = await fixtureObjects();
    const reordered = {
      updated_at: object.updated_at,
      created_at: object.created_at,
      render_hints: object.render_hints,
      privacy: object.privacy,
      status: object.status,
      tags: object.tags,
      provenance: object.provenance,
      source: object.source,
      body_md: object.body_md,
      title: object.title,
      kind: object.kind,
      ko_id: object.ko_id,
      schema_version: object.schema_version,
    };
    await expect(computeKnowledgeHash(reordered)).resolves.toBe(object.content_hash);
  });

  it('changes content_hash when body_md changes', async () => {
    const [object] = await fixtureObjects();
    const { content_hash: _contentHash, ...withoutHash } = object;
    await expect(computeKnowledgeHash({ ...withoutHash, body_md: `${withoutHash.body_md}\nnew` })).resolves.not.toBe(object.content_hash);
  });

  it('builds encoded InkLoop URIs', () => {
    expect(buildInkloopPageUri({ documentId: 'doc a/b', pageIndex: 3, anchorObjectId: 'run 1' })).toBe(
      'inkloop://doc/doc%20a%2Fb/page/3?anchor=run%201',
    );
    expect(buildInkloopKoUri('ko_abc/1')).toBe('inkloop://ko/ko_abc%2F1');
  });
});
