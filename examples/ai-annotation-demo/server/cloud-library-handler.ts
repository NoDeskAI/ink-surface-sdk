import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import type { JsonCloudLibraryStore, CloudLibraryDocument, CloudLibraryNamespace, CloudLibrarySource, CloudLibraryTextLayer } from './cloud-library-store';

interface LibrarySessionContext {
  active?: boolean;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
}

interface LibraryStreamClient {
  namespace: CloudLibraryNamespace;
  res: ServerResponse;
}

export interface CloudLibraryHandlerOptions {
  store: JsonCloudLibraryStore;
  resolveSession?: (req: IncomingMessage) => Promise<LibrarySessionContext | null>;
  requireSession?: boolean;
}

const MAX_SOURCE_BODY = 120 * 1024 * 1024;

function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function pipeFile(res: ServerResponse, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    const done = (error?: Error) => {
      stream.destroy();
      if (error) reject(error);
      else resolve();
    };
    stream.on('error', done);
    res.on('finish', () => done());
    res.on('close', () => resolve());
    stream.pipe(res);
  });
}

function readBody(req: IncomingMessage, maxBody = MAX_SOURCE_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decodeDocumentId(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/library\/source-files\/([^/]+)(?:\/blob)?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeSource(value: unknown): CloudLibrarySource {
  return value === 'paper_wifi' || value === 'paper_file' || value === 'cloud' ? value : 'web';
}

function sameNamespace(left: CloudLibraryNamespace, right: CloudLibraryNamespace): boolean {
  return (left.tenant_id || '') === (right.tenant_id || '') && (left.user_id || '') === (right.user_id || '');
}

async function resolveNamespace(req: IncomingMessage, options: CloudLibraryHandlerOptions): Promise<{ namespace: CloudLibraryNamespace; deviceId?: string }> {
  let session: LibrarySessionContext | null = null;
  const hasSessionToken = !!(header(req, 'authorization') || header(req, 'x-inkloop-session'));
  if (options.resolveSession && hasSessionToken) {
    try {
      session = await options.resolveSession(req);
    } catch {
      session = null;
    }
  }
  if (options.requireSession && !session) {
    throw Object.assign(new Error('missing_session_token'), { status: 401 });
  }
  const namespace = {
    tenant_id: session?.tenant_id || header(req, 'x-inkloop-tenant-id') || process.env.INKLOOP_TENANT_ID || 'local',
    user_id: session?.user_id || header(req, 'x-inkloop-user-id') || process.env.INKLOOP_USER_ID || 'local_demo',
  };
  return { namespace, deviceId: session?.device_id || header(req, 'x-inkloop-device-id') || undefined };
}

export function createCloudLibraryHandler(options: CloudLibraryHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const streamClients = new Set<LibraryStreamClient>();

  function broadcastManifestChanged(namespace: CloudLibraryNamespace, payload: unknown): void {
    for (const client of streamClients) {
      if (!sameNamespace(client.namespace, namespace)) continue;
      try {
        sendSse(client.res, 'manifest', payload);
      } catch {
        streamClients.delete(client);
      }
    }
  }

  return async (req, res) => {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = parsed.pathname;
    if (!path.startsWith('/v1/library/')) return false;

    try {
      const { namespace, deviceId } = await resolveNamespace(req, options);

      if (req.method === 'GET' && path === '/v1/library/manifest') {
        sendJson(res, 200, await options.store.list(namespace));
        return true;
      }

      if (req.method === 'GET' && path === '/v1/library/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        const client = { namespace, res };
        streamClients.add(client);
        sendSse(res, 'ready', {
          ok: true,
          generated_at: new Date().toISOString(),
          tenant_id: namespace.tenant_id,
          user_id: namespace.user_id,
        });
        const ping = setInterval(() => sendSse(res, 'ping', { t: Date.now() }), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          streamClients.delete(client);
        });
        return true;
      }

      if (req.method === 'GET' && path.startsWith('/v1/library/source-files/')) {
        const documentId = decodeDocumentId(path);
        if (!documentId) {
          sendJson(res, 404, { error: 'not_found' });
          return true;
        }
        if (path.endsWith('/blob')) {
          const hit = await options.store.getBlobFile(namespace, documentId);
          if (!hit) {
            sendJson(res, 404, { error: 'source_blob_not_found' });
            return true;
          }
          res.statusCode = 200;
          res.setHeader('content-type', hit.document.mime_type || 'application/octet-stream');
          res.setHeader('content-length', String(hit.document.blob.size_bytes || hit.document.size_bytes));
          res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(hit.document.filename)}`);
          await pipeFile(res, hit.path);
          return true;
        }
        const document = await options.store.get(namespace, documentId);
        sendJson(res, document ? 200 : 404, document || { error: 'source_file_not_found' });
        return true;
      }

      if (req.method === 'DELETE' && path.startsWith('/v1/library/source-files/') && !path.endsWith('/blob')) {
        const documentId = decodeDocumentId(path);
        if (!documentId) {
          sendJson(res, 404, { error: 'not_found' });
          return true;
        }
        const deleted = await options.store.deleteSourceFile(namespace, documentId);
        if (deleted) {
          broadcastManifestChanged(namespace, {
            document_id: documentId,
            deleted: true,
            updated_at: new Date().toISOString(),
          });
        }
        sendJson(res, deleted ? 200 : 404, deleted ? { ok: true, deleted: true, document_id: documentId } : { error: 'source_file_not_found' });
        return true;
      }

      if (req.method === 'POST' && path === '/v1/library/source-files') {
        const body = JSON.parse(await readBody(req)) as {
          document_id?: string;
          filename?: string;
          file_hash?: string;
          mime_type?: string;
          size_bytes?: number;
          page_count?: number;
          cover_image_data_url?: string;
          source?: string;
          text_layer?: CloudLibraryTextLayer;
          reading_experience?: CloudLibraryDocument['reading_experience'];
          content_base64?: string;
        };
        if (!body.filename || !body.content_base64) {
          sendJson(res, 400, { error: 'filename_and_content_base64_required' });
          return true;
        }
        const bytes = Buffer.from(body.content_base64, 'base64');
        if (body.size_bytes && body.size_bytes !== bytes.length) {
          sendJson(res, 409, { error: 'size_mismatch' });
          return true;
        }
        const document = await options.store.putSourceFile(namespace, {
          document_id: body.document_id,
          filename: body.filename,
          file_hash: body.file_hash,
          mime_type: body.mime_type,
          page_count: body.page_count,
          cover_image_data_url: body.cover_image_data_url,
          source: normalizeSource(body.source),
          uploaded_by_device_id: deviceId,
          text_layer: body.text_layer,
          reading_experience: body.reading_experience,
        }, bytes);
        broadcastManifestChanged(namespace, {
          document_id: document.document_id,
          source_file_id: document.source_file_id,
          filename: document.filename,
          updated_at: document.updated_at,
        });
        sendJson(res, 200, { ok: true, document });
        return true;
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 500;
      sendJson(res, status, { error: String((error as Error)?.message || error) });
      return true;
    }
  };
}
