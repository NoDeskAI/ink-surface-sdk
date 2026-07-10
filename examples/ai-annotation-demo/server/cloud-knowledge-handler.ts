import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DocumentProjection, KnowledgeObject } from '../../../packages/knowledge-schema/src/index';
import type { CloudAiTurnRecord, CloudKnowledgeNamespace, JsonCloudKnowledgeStore } from './cloud-knowledge-store';

interface KnowledgeSessionContext {
  active?: boolean;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
}

export interface CloudKnowledgeHandlerOptions {
  store: JsonCloudKnowledgeStore;
  resolveSession?: (req: IncomingMessage) => Promise<KnowledgeSessionContext | null>;
  requireSession?: boolean;
}

const MAX_BODY = 12 * 1024 * 1024;

function header(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBody = MAX_BODY): Promise<string> {
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

async function resolveNamespace(req: IncomingMessage, options: CloudKnowledgeHandlerOptions): Promise<CloudKnowledgeNamespace> {
  let session: KnowledgeSessionContext | null = null;
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
  return {
    tenant_id: session?.tenant_id || header(req, 'x-inkloop-tenant-id') || process.env.INKLOOP_TENANT_ID || 'local',
    user_id: session?.user_id || header(req, 'x-inkloop-user-id') || process.env.INKLOOP_USER_ID || 'local_demo',
  };
}

function assertAiTurn(input: unknown): CloudAiTurnRecord {
  const turn = input as Partial<CloudAiTurnRecord>;
  if (turn?.schema_version !== 'inkloop.cloud_hub.ai_turn.v1' || !turn.ai_turn_id || !turn.document_id) {
    throw Object.assign(new Error('invalid_ai_turn'), { status: 400 });
  }
  return turn as CloudAiTurnRecord;
}

function assertKnowledgeObject(input: unknown): KnowledgeObject {
  const object = input as Partial<KnowledgeObject>;
  if (object?.schema_version !== 'inkloop.knowledge_object.v1' || !object.ko_id || !object.source?.document_id) {
    throw Object.assign(new Error('invalid_knowledge_object'), { status: 400 });
  }
  return object as KnowledgeObject;
}

function assertDocumentProjection(input: unknown): DocumentProjection {
  const projection = input as Partial<DocumentProjection>;
  if (projection?.schema_version !== 'inkloop.document_projection.v1' || !projection.projection_id || !projection.document_id) {
    throw Object.assign(new Error('invalid_document_projection'), { status: 400 });
  }
  return projection as DocumentProjection;
}

export function createCloudKnowledgeHandler(options: CloudKnowledgeHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = parsed.pathname;
    if (!path.startsWith('/v1/knowledge/')) return false;

    try {
      const namespace = await resolveNamespace(req, options);
      const documentId = parsed.searchParams.get('document_id') || undefined;

      if (path === '/v1/knowledge/ai-turns') {
        if (req.method === 'GET') {
          sendJson(res, 200, { schema_version: 'inkloop.cloud_hub.ai_turn.list.v1', ai_turns: await options.store.listAiTurns(namespace, documentId) });
          return true;
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { ai_turn?: unknown };
          const aiTurn = await options.store.upsertAiTurn(namespace, assertAiTurn(body.ai_turn));
          sendJson(res, 200, { ok: true, ai_turn: aiTurn });
          return true;
        }
      }

      if (path === '/v1/knowledge/objects') {
        if (req.method === 'GET') {
          sendJson(res, 200, { schema_version: 'inkloop.knowledge_export.v1', objects: await options.store.listKnowledgeObjects(namespace, documentId) });
          return true;
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { object?: unknown };
          const object = await options.store.upsertKnowledgeObject(namespace, assertKnowledgeObject(body.object));
          sendJson(res, 200, { ok: true, object });
          return true;
        }
      }

      if (path === '/v1/knowledge/document-projections') {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            schema_version: 'inkloop.document_projection.export.v1',
            document_projections: await options.store.listDocumentProjections(namespace, documentId),
          });
          return true;
        }
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { document_projection?: unknown };
          const documentProjection = await options.store.upsertDocumentProjection(namespace, assertDocumentProjection(body.document_projection));
          sendJson(res, 200, { ok: true, document_projection: documentProjection });
          return true;
        }
      }

      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    } catch (error) {
      sendJson(res, Number((error as { status?: number })?.status) || 500, { error: String((error as Error)?.message || error) });
      return true;
    }
  };
}
