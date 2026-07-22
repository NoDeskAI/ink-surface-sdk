import { describe, expect, it, vi } from 'vitest';
import { ClassroomClient, classroomApiUrl, createClassroomClientId, parseClassroomSse } from './classroom-client';

describe('ClassroomClient', () => {
  it('keeps classroom requests on the Vite origin during development', () => {
    expect(classroomApiUrl('/v1/classrooms', true)).toBe('/v1/classrooms');
  });

  it('keeps classroom requests on the HTTPS launcher origin in production builds', () => {
    expect(classroomApiUrl('/v1/classrooms', false, (path) => `https://172.168.20.94:8731${path}`)).toBe('/v1/classrooms');
  });

  it('adds the classroom bearer token without placing it in the URL', async () => {
    const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new ClassroomClient({ token: 'participant_secret', fetcher });
    await client.get('/v1/classrooms/classroom_1/snapshot');
    expect(fetcher).toHaveBeenCalledWith(expect.not.stringContaining('participant_secret'), expect.objectContaining({ headers: expect.any(Headers) }));
    const headers = fetcher.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer participant_secret');
  });

  it('parses SSE frames split across chunks and keeps event ids', () => {
    const parser = parseClassroomSse();
    expect(parser.push('id: 2\nevent: board_')).toEqual([]);
    expect(parser.push('event\ndata: {"sequence":2}\n\n')).toEqual([{ id: '2', event: 'board_event', data: { sequence: 2 } }]);
  });

  it('surfaces stream authorization error codes so the viewer can stop reconnecting', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const client = new ClassroomClient({ token: 'expired', fetcher });
    await expect(client.stream('/v1/classrooms/classroom_1/stream?cursor=0', () => undefined, new AbortController().signal)).rejects.toThrow('unauthorized');
  });

  it('creates client ids on LAN HTTP where crypto.randomUUID is unavailable', () => {
    const cryptoApi = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        if (array instanceof Uint8Array) array.set(Array.from({ length: array.length }, (_, index) => index));
        return array;
      },
    } as Crypto;
    expect(createClassroomClientId('client', cryptoApi)).toBe('client_000102030405060708090a0b0c0d0e0f');
  });
});
