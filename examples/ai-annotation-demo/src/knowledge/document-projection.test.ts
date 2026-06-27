import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  computeDocumentProjectionBodyHash,
  parseDocumentProjection,
  recomputeDocumentProjectionHash,
  safeParseDocumentProjection,
  type DocumentProjection,
} from './document-projection';
import { parseExternalEdit, recomputeExternalEditHash, safeParseExternalEdit, type ExternalEdit } from './external-edit';

async function fixtureEnvelope(): Promise<{ document_projections: DocumentProjection[]; external_edits: ExternalEdit[] }> {
  const raw = JSON.parse(await readFile('packages/ko-schema/fixtures/document-projections.json', 'utf8')) as {
    document_projections: unknown[];
    external_edits: unknown[];
  };
  return {
    document_projections: raw.document_projections.map(parseDocumentProjection),
    external_edits: raw.external_edits.map(parseExternalEdit),
  };
}

describe('DocumentProjection schema and hashing', () => {
  it('validates shared projection fixtures and their hashes', async () => {
    const { document_projections: projections, external_edits: edits } = await fixtureEnvelope();
    expect(projections).toHaveLength(1);
    expect(edits).toHaveLength(1);

    const [projection] = projections;
    await expect(computeDocumentProjectionBodyHash(projection.blocks)).resolves.toBe(projection.body_hash);
    await expect(recomputeDocumentProjectionHash(projection)).resolves.toBe(projection.content_hash);

    const [edit] = edits;
    await expect(recomputeExternalEditHash(edit)).resolves.toBe(edit.content_hash);
  });

  it('rejects duplicate block anchors', async () => {
    const { document_projections: projections } = await fixtureEnvelope();
    const [projection] = projections;
    const duplicate = {
      ...projection,
      blocks: projection.blocks.concat({ ...projection.blocks[0] }),
    };

    expect(safeParseDocumentProjection(duplicate).success).toBe(false);
  });

  it('rejects local-only projections that include full text', async () => {
    const { document_projections: projections } = await fixtureEnvelope();
    const [projection] = projections;

    expect(
      safeParseDocumentProjection({
        ...projection,
        privacy: 'local_only',
        export_policy: { ...projection.export_policy, include_full_text: true },
      }).success,
    ).toBe(false);
  });

  it('requires document body edits to target a block', async () => {
    const { external_edits: edits } = await fixtureEnvelope();
    const [edit] = edits;
    const { block_id: _blockId, ...withoutBlock } = edit;

    expect(safeParseExternalEdit(withoutBlock).success).toBe(false);
  });
});
