import { describe, expect, it } from 'vitest';
import { resolveRuntimeDocumentIdentity } from './runtime-identity';

describe('runtime identity', () => {
  it('keeps imported PDF identity tied to the InkLoop document id across source revisions', () => {
    const first = resolveRuntimeDocumentIdentity({
      sourceKind: 'imported_pdf',
      documentId: 'doc_pdf_existing',
      fileHash: 'sha256:pdf-a',
      contentHash: 'sha256:rev-a',
      updatedAt: '2026-06-28T00:00:00.000Z',
    });
    const second = resolveRuntimeDocumentIdentity({
      sourceKind: 'imported_pdf',
      documentId: 'doc_pdf_existing',
      fileHash: 'sha256:pdf-a',
      contentHash: 'sha256:rev-b',
      existingIdentity: first.identity,
      updatedAt: '2026-06-28T00:01:00.000Z',
    });

    expect(second.identity.doc_id).toBe('doc_pdf_existing');
    expect(second.identity.stable_key).toBe(first.identity.stable_key);
    expect(second.sourceRevision.content_hash).toBe('sha256:rev-b');
  });

  it('persists one runtime id for native Markdown while content and path metadata change', () => {
    const first = resolveRuntimeDocumentIdentity({
      sourceKind: 'native_markdown',
      sourcePath: 'Notes/One.md',
      contentHash: 'sha256:one',
      updatedAt: '2026-06-28T00:00:00.000Z',
    });
    const renamed = resolveRuntimeDocumentIdentity({
      sourceKind: 'native_markdown',
      sourcePath: 'Notes/Renamed.md',
      contentHash: 'sha256:two',
      existingIdentity: first.identity,
      updatedAt: '2026-06-28T00:02:00.000Z',
    });

    expect(renamed.identity.doc_id).toBe(first.identity.doc_id);
    expect(renamed.identity.stable_key).toBe(first.identity.stable_key);
    expect(renamed.identity.source_path).toBe('Notes/Renamed.md');
    expect(renamed.sourceRevision).toMatchObject({ content_hash: 'sha256:two', source_path: 'Notes/Renamed.md' });
  });

  it('keeps imported Markdown identity tied to the Cloud Library document id', () => {
    const first = resolveRuntimeDocumentIdentity({
      sourceKind: 'native_markdown',
      documentId: 'doc_cloud_markdown',
      sourcePath: 'InkLoop-E2E.md',
      contentHash: 'sha256:one',
      updatedAt: '2026-07-03T00:00:00.000Z',
    });
    const second = resolveRuntimeDocumentIdentity({
      sourceKind: 'native_markdown',
      documentId: 'doc_cloud_markdown',
      sourcePath: 'InkLoop-E2E.md',
      contentHash: 'sha256:two',
      existingIdentity: first.identity,
      updatedAt: '2026-07-03T00:01:00.000Z',
    });

    expect(first.identity.doc_id).toBe('doc_cloud_markdown');
    expect(second.identity.doc_id).toBe('doc_cloud_markdown');
    expect(second.identity.stable_key).toBe(first.identity.stable_key);
  });

  it('creates stable ids for new InkLoop documents before export exists', () => {
    const first = resolveRuntimeDocumentIdentity({
      sourceKind: 'inkloop_created',
      title: 'Daily note',
      updatedAt: '2026-06-28T00:00:00.000Z',
    });
    const second = resolveRuntimeDocumentIdentity({
      sourceKind: 'inkloop_created',
      title: 'Daily note',
      updatedAt: '2026-06-28T00:01:00.000Z',
    });

    expect(second.identity.doc_id).toBe(first.identity.doc_id);
    expect(second.identity.source_ref_id).toBe(first.identity.source_ref_id);
  });
});
