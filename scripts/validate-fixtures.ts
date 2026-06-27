import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseKnowledgeObject } from '../src/knowledge/knowledge-object';
import { recomputeKnowledgeHash } from '../src/knowledge/hash';
import { computeDocumentProjectionBodyHash, parseDocumentProjection, recomputeDocumentProjectionHash } from '../src/knowledge/document-projection';
import { parseExternalEdit, recomputeExternalEditHash } from '../src/knowledge/external-edit';

interface FixtureEnvelope {
  objects?: unknown[];
  document_projections?: unknown[];
  external_edits?: unknown[];
}

let failures = 0;
let validatedKnowledgeObjects = 0;
let validatedDocumentProjections = 0;
let validatedExternalEdits = 0;

const inputs = process.argv.slice(2);
const fixturePaths = inputs.length
  ? inputs
  : [
      'packages/ko-schema/fixtures/knowledge-objects.json',
      'packages/ko-schema/fixtures/document-projections.json',
    ];

for (const input of fixturePaths) {
  const path = resolve(process.cwd(), input);
  const raw = JSON.parse(await readFile(path, 'utf8')) as FixtureEnvelope | unknown[];
  const envelope = Array.isArray(raw) ? { objects: raw } : raw;
  const objects = envelope.objects;
  const documentProjections = envelope.document_projections;
  const externalEdits = envelope.external_edits;

  if (!Array.isArray(objects) && !Array.isArray(documentProjections) && !Array.isArray(externalEdits)) {
    throw new Error(`Fixture file must contain objects, document_projections, or external_edits; got ${path}`);
  }

  for (const item of objects ?? []) {
    const object = parseKnowledgeObject(item);
    const expected = await recomputeKnowledgeHash(object);
    if (object.content_hash !== expected) {
      failures += 1;
      console.error(`[fixture] ${object.ko_id} content_hash mismatch: ${object.content_hash} !== ${expected}`);
    }
    validatedKnowledgeObjects += 1;
  }

  for (const item of documentProjections ?? []) {
    const projection = parseDocumentProjection(item);
    const expectedBodyHash = await computeDocumentProjectionBodyHash(projection.blocks);
    const expectedContentHash = await recomputeDocumentProjectionHash(projection);
    if (projection.body_hash !== expectedBodyHash) {
      failures += 1;
      console.error(`[fixture] ${projection.projection_id} body_hash mismatch: ${projection.body_hash} !== ${expectedBodyHash}`);
    }
    if (projection.content_hash !== expectedContentHash) {
      failures += 1;
      console.error(`[fixture] ${projection.projection_id} content_hash mismatch: ${projection.content_hash} !== ${expectedContentHash}`);
    }
    validatedDocumentProjections += 1;
  }

  for (const item of externalEdits ?? []) {
    const edit = parseExternalEdit(item);
    const expected = await recomputeExternalEditHash(edit);
    if (edit.content_hash !== expected) {
      failures += 1;
      console.error(`[fixture] ${edit.edit_id} content_hash mismatch: ${edit.content_hash} !== ${expected}`);
    }
    validatedExternalEdits += 1;
  }
}

if (failures > 0) process.exit(1);
console.log(
  `[fixture] validated ${validatedKnowledgeObjects} KnowledgeObjects, ${validatedDocumentProjections} DocumentProjections, ${validatedExternalEdits} ExternalEdits from ${fixturePaths.length} file(s)`,
);
