import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readingExperienceForSource } from '../src/core/reading-experience';
import { JsonCloudLibraryStore } from './cloud-library-store';

function epubFixtureWithCover(): Buffer {
  const files: Record<string, Uint8Array> = {
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>'),
    'OPS/content.opf': strToU8(`<?xml version="1.0"?>
      <package>
        <metadata><meta name="cover" content="cover-image"/></metadata>
        <manifest>
          <item id="cover-image" href="Images/cover.jpg" media-type="image/jpeg"/>
          <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        </manifest>
        <spine><itemref idref="chapter"/></spine>
      </package>`),
    'OPS/Images/cover.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    'OPS/chapter.xhtml': strToU8('<html><body><p>demo</p></body></html>'),
  };
  return Buffer.from(zipSync(files));
}

describe('JsonCloudLibraryStore', () => {
  it('persists source file manifest and blob across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const first = new JsonCloudLibraryStore(dir);
      const document = await first.putSourceFile(namespace, {
        document_id: 'doc_demo',
        filename: 'demo.md',
        mime_type: 'text/markdown',
        page_count: 1,
        cover_image_data_url: 'data:image/jpeg;base64,cover-a',
        source: 'web',
      }, Buffer.from('# Demo'));

      const second = new JsonCloudLibraryStore(dir);
      const manifest = await second.list(namespace);
      const blob = await second.readBlob(namespace, 'doc_demo');

      expect(manifest.documents).toHaveLength(1);
      expect(manifest.documents[0].document_id).toBe('doc_demo');
      expect(manifest.documents[0].source_file_id).toBe(document.source_file_id);
      expect(manifest.documents[0].cover_image_data_url).toBe('data:image/jpeg;base64,cover-a');
      expect(blob?.bytes.toString('utf8')).toBe('# Demo');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates the existing document instead of duplicating the same doc_id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const store = new JsonCloudLibraryStore(dir);
      await store.putSourceFile(namespace, { document_id: 'doc_same', filename: 'first.pdf', page_count: 2, source: 'web' }, Buffer.from('first'));
      await store.putSourceFile(namespace, { document_id: 'doc_same', filename: 'second.pdf', page_count: 3, source: 'paper_wifi' }, Buffer.from('second'));

      const manifest = await store.list(namespace);
      const blob = await store.readBlob(namespace, 'doc_same');

      expect(manifest.documents).toHaveLength(1);
      expect(manifest.documents[0].filename).toBe('second.pdf');
      expect(manifest.documents[0].page_count).toBe(3);
      expect(manifest.documents[0].source).toBe('paper_wifi');
      expect(blob?.bytes.toString('utf8')).toBe('second');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts an EPUB cover when the client upload omits cover metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const store = new JsonCloudLibraryStore(dir);
      await store.putSourceFile(namespace, {
        document_id: 'doc_epub_cover',
        filename: 'cover-demo.epub',
        mime_type: 'application/epub+zip',
        page_count: 1,
        source: 'web',
      }, epubFixtureWithCover());

      const manifest = await store.list(namespace);

      expect(manifest.documents[0].cover_image_data_url).toBe('data:image/jpeg;base64,/9j/2Q==');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a source file from the manifest and blob store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const store = new JsonCloudLibraryStore(dir);
      await store.putSourceFile(namespace, { document_id: 'doc_delete', filename: 'delete.pdf', page_count: 1, source: 'web' }, Buffer.from('delete'));

      await expect(store.deleteSourceFile(namespace, 'doc_delete')).resolves.toBe(true);

      expect((await store.list(namespace)).documents).toHaveLength(0);
      expect(await store.readBlob(namespace, 'doc_delete')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats deleting a missing source file as a no-op miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const store = new JsonCloudLibraryStore(dir);

      await expect(store.deleteSourceFile(namespace, 'doc_missing')).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('allows a later parsed upload to promote text layer status to ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const store = new JsonCloudLibraryStore(dir);
      await store.putSourceFile(namespace, { document_id: 'doc_text', filename: 'demo.pdf', page_count: 1, source: 'web' }, Buffer.from('first'));
      await store.putSourceFile(namespace, {
        document_id: 'doc_text',
        filename: 'demo.pdf',
        page_count: 3,
        source: 'web',
        text_layer: {
          status: 'ready',
          source: 'pdfjs',
          page_count: 3,
          sampled_page_count: 1,
          text_block_count: 42,
        },
      }, Buffer.from('second'));

      const manifest = await store.list(namespace);

      expect(manifest.documents).toHaveLength(1);
      expect(manifest.documents[0].text_layer).toMatchObject({
        status: 'ready',
        source: 'pdfjs',
        page_count: 3,
        sampled_page_count: 1,
        text_block_count: 42,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists reading experience metadata in the Cloud Library manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const namespace = { tenant_id: 'tenant_a', user_id: 'user_a' };
      const store = new JsonCloudLibraryStore(dir);
      await store.putSourceFile(namespace, {
        document_id: 'doc_pdf_experience',
        filename: 'paper.pdf',
        mime_type: 'application/pdf',
        page_count: 12,
        source: 'web',
        reading_experience: readingExperienceForSource('pdf'),
      }, Buffer.from('%PDF demo'));

      const manifest = await store.list(namespace);

      expect(manifest.documents[0].reading_experience).toMatchObject({
        schema: 'inkloop.reading_experience.v1',
        source_kind: 'pdf',
        primary_engine: 'pdfjs-original@v1',
        preprocess: {
          status: 'none',
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('copies missing documents between namespaces when a local device upgrades to a Feishu identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-'));
    try {
      const local = { tenant_id: 'tenant_a', user_id: 'local_demo' };
      const feishu = { tenant_id: 'tenant_a', user_id: 'feishu_ou_user' };
      const store = new JsonCloudLibraryStore(dir);
      await store.putSourceFile(local, {
        document_id: 'doc_a',
        filename: 'a.pdf',
        mime_type: 'application/pdf',
        page_count: 2,
        cover_image_data_url: 'data:image/png;base64,a',
        source: 'web',
        reading_experience: readingExperienceForSource('pdf'),
      }, Buffer.from('a'));
      await store.putSourceFile(local, {
        document_id: 'doc_b',
        filename: 'b.md',
        mime_type: 'text/markdown',
        page_count: 3,
        source: 'paper_wifi',
      }, Buffer.from('b'));
      await store.putSourceFile(feishu, {
        document_id: 'doc_b',
        filename: 'existing-b.md',
        mime_type: 'text/markdown',
        page_count: 1,
        source: 'web',
      }, Buffer.from('existing'));

      const result = await store.copyMissingDocuments(local, feishu);
      const manifest = await store.list(feishu);
      const copiedBlob = await store.readBlob(feishu, 'doc_a');
      const existingBlob = await store.readBlob(feishu, 'doc_b');

      expect(result.copied).toEqual(['doc_a']);
      expect(result.skipped).toEqual(['doc_b']);
      expect(manifest.documents.map((doc) => doc.document_id).sort()).toEqual(['doc_a', 'doc_b']);
      expect(manifest.documents.find((doc) => doc.document_id === 'doc_a')).toMatchObject({
        filename: 'a.pdf',
        cover_image_data_url: 'data:image/png;base64,a',
        reading_experience: expect.objectContaining({ source_kind: 'pdf' }),
      });
      expect(copiedBlob?.bytes.toString('utf8')).toBe('a');
      expect(existingBlob?.bytes.toString('utf8')).toBe('existing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
