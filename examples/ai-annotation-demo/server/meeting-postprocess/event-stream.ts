import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostprocessEvent } from './contracts';
import type { MeetingPostprocessStore, PostprocessScope } from './store';

export function parseLastEventId(req: IncomingMessage, url: URL): number {
  const raw = String(req.headers['last-event-id'] || url.searchParams.get('after') || '0');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('invalid_last_event_id'), { status: 400 });
  return value;
}

export function eventScopeMatches(event: PostprocessEvent, scope: PostprocessScope): boolean {
  return event.tenant_id === scope.tenant_id && event.user_id === scope.user_id && event.meeting_id === scope.meeting_id && (!scope.occurrence_id || event.occurrence_id === scope.occurrence_id);
}

function writeEvent(res: ServerResponse, event: PostprocessEvent): void {
  res.write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function streamPostprocessEvents(input: { req: IncomingMessage; res: ServerResponse; store: MeetingPostprocessStore; scope: PostprocessScope; heartbeat_ms?: number; poll_ms?: number; on_close?: () => void }): () => void {
  const { req, res, store, scope } = input;
  let cursor = parseLastEventId(req, new URL(req.url || '/', 'http://inkloop.local'));
  let closed = false;
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
  const flush = () => {
    for (const event of store.listEvents(scope, cursor)) { if (!eventScopeMatches(event, scope)) continue; writeEvent(res, event); cursor = event.event_id; }
  };
  flush();
  const poll = setInterval(flush, input.poll_ms || 500);
  const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), input.heartbeat_ms || 15_000);
  const close = () => { if (closed) return; closed = true; clearInterval(poll); clearInterval(heartbeat); input.on_close?.(); if (!res.writableEnded) res.end(); };
  req.once('close', close);
  res.once('close', close);
  res.once('finish', close);
  res.once('error', close);
  return close;
}
