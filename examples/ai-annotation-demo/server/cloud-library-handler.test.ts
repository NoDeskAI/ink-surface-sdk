import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readingExperienceForSource } from '../src/core/reading-experience';
import { createCloudLibraryHandler } from './cloud-library-handler';
import { JsonCloudLibraryStore } from './cloud-library-store';

let server: Server | null = null;

async function start(store: JsonCloudLibraryStore): Promise<string> {
  const handler = createCloudLibraryHandler({ store });
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function postSource(base: string, userId: string, documentId: string): Promise<Response> {
  const content = Buffer.from('# Demo\n');
  return await fetch(`${base}/v1/library/source-files`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-inkloop-tenant-id': 'tenant_a',
      'x-inkloop-user-id': userId,
    },
    body: JSON.stringify({
      document_id: documentId,
      filename: `${documentId}.md`,
      mime_type: 'text/markdown',
      size_bytes: content.length,
      page_count: 1,
      source: 'web',
      reading_experience: readingExperienceForSource('markdown'),
      content_base64: content.toString('base64'),
    }),
  });
}

async function openStream(base: string, userId: string): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/library/stream`, {
    headers: {
      'x-inkloop-tenant-id': 'tenant_a',
      'x-inkloop-user-id': userId,
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.body).toBeTruthy();
  const reader = response.body!.getReader();
  return {
    reader,
    close: () => {
      void reader.cancel().catch(() => undefined);
      controller.abort();
    },
  };
}

function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  eventName: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let buffer = '';
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);
  });
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (timedOut) return new Promise<Record<string, unknown>>(() => {});
        throw new Error('stream closed');
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
          if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
        }
        if (event === eventName) return JSON.parse(data.join('\n')) as Record<string, unknown>;
      }
    }
  })();
  return Promise.race([read, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = null;
});

describe('cloud library handler', () => {
  it('pushes manifest stream updates only to the matching tenant/user namespace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkloop-cloud-library-handler-'));
    const userAStream = { close: () => {}, reader: null as ReadableStreamDefaultReader<Uint8Array> | null };
    const userBStream = { close: () => {}, reader: null as ReadableStreamDefaultReader<Uint8Array> | null };
    try {
      const base = await start(new JsonCloudLibraryStore(dir));
      Object.assign(userAStream, await openStream(base, 'user_a'));
      Object.assign(userBStream, await openStream(base, 'user_b'));

      await readSseEvent(userAStream.reader!, 'ready', 500);
      await readSseEvent(userBStream.reader!, 'ready', 500);

      const pendingA = readSseEvent(userAStream.reader!, 'manifest', 1000);
      const pendingB = readSseEvent(userBStream.reader!, 'manifest', 120).then(
        () => 'unexpected',
        () => 'timeout',
      );
      const posted = await postSource(base, 'user_a', 'doc_stream_demo');

      expect(posted.status).toBe(200);
      await expect(pendingA).resolves.toMatchObject({ document_id: 'doc_stream_demo' });
      await expect(pendingB).resolves.toBe('timeout');
    } finally {
      userAStream.close();
      userBStream.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
