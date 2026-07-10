import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateRuntimeSyncEvent, type RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';
import { MemoryRuntimeSyncEventStore, type RuntimeSyncEventStore, type RuntimeSyncNamespace, type StoredRuntimeEvent } from './runtime-sync-store';

export interface RuntimeSyncSessionContext {
  active?: boolean;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
}

export interface RuntimeSyncDevHandlerOptions {
  token?: string;
  allowOrigins?: string[];
  requireSession?: boolean;
  defaultSession?: RuntimeSyncSessionContext | null;
  store?: RuntimeSyncEventStore;
  resolveSession?: (req: IncomingMessage) => RuntimeSyncSessionContext | null | Promise<RuntimeSyncSessionContext | null>;
  onAcceptedEvent?: (event: RuntimeSyncEvent, namespace: RuntimeSyncNamespace) => void | Promise<void>;
  logger?: (entry: { operation: 'push' | 'pull'; event_ids: string[]; doc_ids: string[]; count: number; latency_ms: number; device_id?: string; cursor?: string; tenant_id?: string; user_id?: string }) => void;
}

const DEFAULT_ALLOWED_ORIGINS = [
  'https://appassets.androidplatform.net',
  'http://appassets.androidplatform.net',
];

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error('runtime sync request body is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function requestToken(req: IncomingMessage, url: URL): string {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || String(req.headers['x-inkloop-runtime-token'] || '').trim() || url.searchParams.get('token') || '';
}

function requestOrigin(req: IncomingMessage): URL | null {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return null;
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

function hostName(req: IncomingMessage): string {
  const value = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1).toLowerCase();
  return value.split(':')[0].toLowerCase();
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isLanDevHost(hostname: string): boolean {
  return /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\./.test(hostname);
}

function allowedOrigins(options: RuntimeSyncDevHandlerOptions): Set<string> {
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...(options.allowOrigins || [])]);
}

function writeCorsHeaders(req: IncomingMessage, res: ServerResponse, options: RuntimeSyncDevHandlerOptions): void {
  const origin = requestOrigin(req);
  if (!origin) return;
  const requestHost = hostName(req);
  const originHost = origin.hostname.toLowerCase();
  if (originHost === requestHost || isLoopback(originHost) || isLanDevHost(originHost) || allowedOrigins(options).has(origin.origin)) {
    res.setHeader('access-control-allow-origin', origin.origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-inkloop-runtime-token,x-inkloop-session,x-inkloop-tenant-id,x-inkloop-user-id,x-inkloop-device-id');
    res.setHeader('vary', 'Origin');
  }
}

function headerSession(req: IncomingMessage): RuntimeSyncSessionContext | null {
  const tenantId = String(req.headers['x-inkloop-tenant-id'] || '').trim();
  const userId = String(req.headers['x-inkloop-user-id'] || '').trim();
  if (!tenantId || !userId) return null;
  return { active: true, tenant_id: tenantId, user_id: userId };
}

async function assertAuthorized(req: IncomingMessage, url: URL, options: RuntimeSyncDevHandlerOptions): Promise<RuntimeSyncSessionContext | null> {
  if (options.token && requestToken(req, url) !== options.token) {
    throw Object.assign(new Error('unauthorized runtime sync token'), { status: 401 });
  }
  const explicitHeaderSession = headerSession(req);

  if (options.requireSession || options.resolveSession) {
    if (!options.resolveSession) throw Object.assign(new Error('runtime sync session resolver is not configured'), { status: 503 });
    const session = await options.resolveSession(req);
    if (!session?.active || !session.tenant_id || !session.user_id) {
      throw Object.assign(new Error('runtime sync requires an active device session'), { status: 401 });
    }
    return session;
  }

  const requestHost = hostName(req);
  const origin = requestOrigin(req);
  if (!origin) {
    if (isLoopback(requestHost)) return explicitHeaderSession ?? options.defaultSession ?? null;
    throw Object.assign(new Error('runtime sync requires loopback, same-origin, or token access'), { status: 403 });
  }

  const originHost = origin.hostname.toLowerCase();
  const allowed = allowedOrigins(options);
  if (originHost === requestHost || isLoopback(originHost) || allowed.has(origin.origin)) return explicitHeaderSession ?? options.defaultSession ?? null;

  throw Object.assign(new Error('runtime sync origin is not allowed'), { status: 403 });
}

function parseCursor(cursor: string | null): number {
  const parsed = Number.parseInt(cursor || '0', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function eventLockKey(namespace: RuntimeSyncNamespace, eventId: string): string {
  return `${namespace.tenant_id || ''}\u0000${namespace.user_id || ''}\u0000${eventId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function roundedNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(6));
}

function normalizedNumberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => roundedNumber(item))
    .filter((item): item is number => typeof item === 'number');
}

function normBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const values = value.map((item) => Number(item));
  return values.every(Number.isFinite) ? values as [number, number, number, number] : null;
}

function isClearlyInvalidPageNormBbox(bbox: [number, number, number, number]): boolean {
  const [x, y, w, h] = bbox;
  if (w <= 0 || h <= 0) return true;
  if (x < -0.05 || y < -0.05) return true;
  if (w > 1.1 || h > 1.1) return true;
  if (x + w > 1.05 || y + h > 1.05) return true;
  return false;
}

function annotationAddPageNormBbox(event: RuntimeSyncEvent): [number, number, number, number] | null {
  if (event.operation !== 'annotation.add') return null;
  const payloadBbox = normBbox(event.payload.bbox);
  if (payloadBbox) return payloadBbox;
  const annotation = isRecord(event.payload.annotation) ? event.payload.annotation : null;
  const markMeta = annotation && isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : null;
  return normBbox(markMeta?.bbox);
}

function shouldDropInvalidAnnotationAdd(event: RuntimeSyncEvent): boolean {
  const bbox = annotationAddPageNormBbox(event);
  return !!bbox && isClearlyInvalidPageNormBbox(bbox);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function runtimeBootstrapSnapshot(event: RuntimeSyncEvent): Record<string, unknown> | null {
  if (event.operation !== 'runtime.bootstrap' || !isRecord(event.payload)) return null;
  const snapshot = event.payload.snapshot;
  return isRecord(snapshot) ? snapshot : null;
}

function stripBootstrapAnnotationsFromBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  const clean: Record<string, unknown> = { ...block };
  delete clean.annotations;
  if (isRecord(clean.projection)) {
    const projection = { ...clean.projection };
    delete projection.knowledge_object_ids;
    clean.projection = projection;
  }
  return clean;
}

function sanitizeRuntimeBootstrapEvent(event: RuntimeSyncEvent): RuntimeSyncEvent {
  const snapshot = runtimeBootstrapSnapshot(event);
  if (!snapshot) return event;
  const blocks = Array.isArray(snapshot.blocks)
    ? snapshot.blocks.map(stripBootstrapAnnotationsFromBlock)
    : [];
  return {
    ...event,
    payload: {
      ...event.payload,
      snapshot: {
        ...snapshot,
        blocks,
      },
    },
  };
}

function sourceStableKey(snapshot: Record<string, unknown>, docId: string): string {
  const source = isRecord(snapshot.source) ? snapshot.source : null;
  const sourceIdentity = source && isRecord(source.identity) ? source.identity : null;
  const identity = isRecord(snapshot.identity) ? snapshot.identity : null;
  return stringValue(sourceIdentity?.file_hash)
    || stringValue(identity?.file_hash)
    || stringValue(sourceIdentity?.stable_key)
    || stringValue(identity?.stable_key)
    || docId;
}

function annotationMarkId(annotation: Record<string, unknown>): string | undefined {
  const inkloopMark = isRecord(annotation.inkloop_mark) ? annotation.inkloop_mark : null;
  return stringValue(inkloopMark?.mark_id) || stringValue(annotation.mark_id) || stringValue(annotation.ko_id);
}

function normalizeStroke(stroke: unknown): Record<string, unknown> | null {
  if (!isRecord(stroke)) return null;
  const points = Array.isArray(stroke.points)
    ? stroke.points.map((point) => {
      if (!isRecord(point)) return null;
      return {
        x: roundedNumber(point.x),
        y: roundedNumber(point.y),
        pressure: roundedNumber(point.pressure),
      };
    }).filter(Boolean)
    : [];
  return {
    tool: stringValue(stroke.tool),
    color: stringValue(stroke.color),
    coord_space: stringValue(stroke.coord_space),
    capture_surface: stringValue(stroke.capture_surface),
    bbox: normalizedNumberList(stroke.bbox),
    points,
  };
}

function normalizeAnnotation(annotation: unknown): Record<string, unknown> | null {
  if (!isRecord(annotation)) return null;
  const strokes = Array.isArray(annotation.visual_strokes)
    ? annotation.visual_strokes.map(normalizeStroke).filter(Boolean)
    : [];
  return {
    mark_id: annotationMarkId(annotation),
    ko_id: stringValue(annotation.ko_id),
    kind: stringValue(annotation.kind),
    title: stringValue(annotation.title),
    body_md: stringValue(annotation.body_md),
    status: stringValue(annotation.status),
    render_mode: stringValue(annotation.render_mode),
    visual_bbox: normalizedNumberList(annotation.visual_bbox),
    strokes,
  };
}

function runtimeBootstrapSemanticKey(event: RuntimeSyncEvent): string | null {
  const snapshot = runtimeBootstrapSnapshot(event);
  if (!snapshot) return null;

  const blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : [];
  const annotatedBlocks = blocks.map((block) => {
    if (!isRecord(block)) return null;
    const projection = isRecord(block.projection) ? block.projection : null;
    const annotations = Array.isArray(block.annotations)
      ? block.annotations.map(normalizeAnnotation).filter(Boolean)
      : [];
    if (!annotations.length) return null;
    annotations.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    return {
      block_id: stringValue(projection?.block_id) || stringValue(block.object_id),
      annotations,
    };
  }).filter(Boolean);

  annotatedBlocks.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return stableJson({
    doc_id: event.doc_id,
    source_key: sourceStableKey(snapshot, event.doc_id),
    annotated_blocks: annotatedBlocks,
  });
}

export function createRuntimeSyncDevHandler(options: RuntimeSyncDevHandlerOptions = {}) {
  const store = options.store ?? new MemoryRuntimeSyncEventStore();
  const inFlightAccepts = new Map<string, Promise<{ record: StoredRuntimeEvent; inserted: boolean }>>();

  function log(operation: 'push' | 'pull', selected: RuntimeSyncEvent[], started: number, meta: { device_id?: string; cursor?: string; tenant_id?: string; user_id?: string } = {}): void {
    options.logger?.({
      operation,
      event_ids: selected.map((event) => event.event_id),
      doc_ids: unique(selected.map((event) => event.doc_id)),
      count: selected.length,
      latency_ms: Date.now() - started,
      ...meta,
    });
  }

  function namespaceOf(session: RuntimeSyncSessionContext | null): RuntimeSyncNamespace {
    return { tenant_id: session?.tenant_id, user_id: session?.user_id };
  }

  function runAcceptedEventSideEffect(event: RuntimeSyncEvent, namespace: RuntimeSyncNamespace): void {
    if (!options.onAcceptedEvent) return;
    const report = (error: unknown): void => {
      console.error('[runtime-sync:onAcceptedEvent]', String((error as Error)?.message || error));
    };
    try {
      void Promise.resolve(options.onAcceptedEvent(event, namespace)).catch(report);
    } catch (error) {
      report(error);
    }
  }

  async function acceptEventOnce(event: RuntimeSyncEvent, namespace: RuntimeSyncNamespace, session: RuntimeSyncSessionContext | null): Promise<{ record: StoredRuntimeEvent; inserted: boolean }> {
    const existing = await store.findByEventId(namespace, event.event_id);
    if (existing) return { record: existing, inserted: false };

    const bootstrapSemanticKey = runtimeBootstrapSemanticKey(event);
    if (bootstrapSemanticKey) {
      const existingBootstrap = await findRuntimeBootstrapBySemanticKey(namespace, bootstrapSemanticKey);
      if (existingBootstrap) return { record: existingBootstrap, inserted: false };
    }

    const key = eventLockKey(namespace, bootstrapSemanticKey ? `runtime.bootstrap:${bootstrapSemanticKey}` : event.event_id);
    const pending = inFlightAccepts.get(key);
    if (pending) return pending;

    const work = (async (): Promise<{ record: StoredRuntimeEvent; inserted: boolean }> => {
      const existingAfterWait = await store.findByEventId(namespace, event.event_id);
      if (existingAfterWait) return { record: existingAfterWait, inserted: false };
      if (bootstrapSemanticKey) {
        const existingBootstrapAfterWait = await findRuntimeBootstrapBySemanticKey(namespace, bootstrapSemanticKey);
        if (existingBootstrapAfterWait) return { record: existingBootstrapAfterWait, inserted: false };
      }
      const record = await store.append({
        event: { ...event, status: 'sent', sent_at: event.sent_at || new Date().toISOString() },
        tenant_id: session?.tenant_id,
        user_id: session?.user_id,
      });
      runAcceptedEventSideEffect(event, namespace);
      return { record, inserted: true };
    })();
    inFlightAccepts.set(key, work);
    try {
      return await work;
    } finally {
      if (inFlightAccepts.get(key) === work) inFlightAccepts.delete(key);
    }
  }

  async function findRuntimeBootstrapBySemanticKey(namespace: RuntimeSyncNamespace, semanticKey: string): Promise<StoredRuntimeEvent | null> {
    const latest = await store.latestSequence(namespace);
    if (!latest) return null;
    const records = await store.eventsAfter(namespace, 0, latest + 1);
    return records.find((record) => runtimeBootstrapSemanticKey(record.event) === semanticKey) ?? null;
  }

  return async function handleRuntimeSyncDev(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (pathname !== '/v1/runtime/events:push' && pathname !== '/v1/runtime/events:pull') return false;
    writeCorsHeaders(req, res, options);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return true;
    }

    const started = Date.now();
    try {
      const session = await assertAuthorized(req, url, options);

      if (pathname === '/v1/runtime/events:push') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return true;
        }
        const body = JSON.parse(await readBody(req)) as { schema_version?: string; device_id?: string; events?: unknown[] };
        if (body.schema_version !== 'inkloop.runtime_sync_batch.v1') {
          sendJson(res, 400, { error: { code: 'unsupported_schema_version' } });
          return true;
        }
        if (!Array.isArray(body.events)) {
          sendJson(res, 400, { error: { code: 'events_required' } });
          return true;
        }

        const acks = [];
        const accepted: RuntimeSyncEvent[] = [];
        for (const raw of body.events) {
          const issues = validateRuntimeSyncEvent(raw);
          if (issues.length) {
            acks.push({ event_id: String((raw as { event_id?: unknown })?.event_id || ''), ok: false, error: issues.map((issue) => `${issue.path} ${issue.message}`).join('; ') });
            continue;
          }
          const event = raw as RuntimeSyncEvent;
          const namespace = namespaceOf(session);
          if (shouldDropInvalidAnnotationAdd(event)) {
            const latest = await store.latestSequence(namespace);
            acks.push({
              event_id: event.event_id,
              ok: true,
              ack_id: 'dev_ack_drop_invalid_annotation_bbox',
              server_sequence: latest ?? 0,
              dropped: true,
              reason: 'invalid_page_norm_bbox',
            });
            continue;
          }
          const eventToStore = sanitizeRuntimeBootstrapEvent(event);
          try {
            const { record, inserted } = await acceptEventOnce(eventToStore, namespace, session);
            if (inserted) accepted.push(eventToStore);
            acks.push({ event_id: event.event_id, ok: true, ack_id: `dev_ack_${record.sequence}`, server_sequence: record.sequence });
          } catch (error) {
            acks.push({ event_id: event.event_id, ok: false, error: String((error as Error)?.message || error) });
          }
        }
        log('push', accepted, started, { device_id: String(body.device_id || '') || undefined, tenant_id: session?.tenant_id, user_id: session?.user_id });
        sendJson(res, 200, { schema_version: 'inkloop.runtime_sync_ack_batch.v1', acks });
        return true;
      }

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'GET only' });
        return true;
      }
      const cursor = parseCursor(url.searchParams.get('cursor'));
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100) || 100));
      const namespace = namespaceOf(session);
      const selected = await store.eventsAfter(namespace, cursor, limit);
      const latestSequence = await store.latestSequence(namespace);
      const nextCursor = String(selected.at(-1)?.sequence ?? latestSequence ?? cursor);
      const payloadEvents = selected.map((item) => ({ ...item.event }));
      log('pull', payloadEvents, started, { device_id: url.searchParams.get('device_id') || undefined, cursor: url.searchParams.get('cursor') || undefined, tenant_id: session?.tenant_id, user_id: session?.user_id });
      sendJson(res, 200, {
        schema_version: 'inkloop.runtime_sync_pull.v1',
        events: payloadEvents,
        next_cursor: nextCursor,
        has_more: await store.hasAfter(namespace, Number(nextCursor)),
      });
      return true;
    } catch (error) {
      sendJson(res, Number((error as { status?: number })?.status) || 500, { error: String((error as Error)?.message || error) });
      return true;
    }
  };
}
