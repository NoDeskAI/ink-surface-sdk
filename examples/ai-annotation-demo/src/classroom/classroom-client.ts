import { fetchWithLocalCloudHubFallback } from '../core/api';

export function classroomApiUrl(
  path: string,
  _development = import.meta.env.DEV,
  _resolveApiUrl?: (value: string) => string,
): string {
  // The secure classroom launcher serves its UI and /v1/classrooms API from
  // the same origin. Reusing the general Cloud Hub route here can rewrite a
  // LAN HTTPS request to the legacy HTTP/8731 service and break TLS/CORS.
  return path;
}

export interface ClassroomSseFrame {
  id?: string;
  event: string;
  data: Record<string, unknown>;
}

export function createClassroomClientId(prefix: string, cryptoApi: Crypto = globalThis.crypto): string {
  const randomUuid = cryptoApi?.randomUUID;
  if (typeof randomUuid === 'function') return `${prefix}_${randomUuid.call(cryptoApi)}`;
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function parseClassroomSse(): { push: (chunk: string) => ClassroomSseFrame[] } {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n/g, '\n');
      const output: ClassroomSseFrame[] = [];
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        try { output.push({ id, event, data: JSON.parse(data.join('\n') || '{}') as Record<string, unknown> }); } catch { /* invalid frames are ignored */ }
      }
      return output;
    },
  };
}

export class ClassroomClient {
  private token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { token?: string; fetcher?: typeof fetch } = {}) {
    this.token = options.token || '';
    this.fetcher = options.fetcher || ((input, init) => fetchWithLocalCloudHubFallback(String(input), init, null));
  }

  setToken(token: string): void { this.token = token; }

  private headers(body: boolean): Headers {
    const headers = new Headers();
    if (body) headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    return headers;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = init.body !== undefined;
    const headers = this.headers(body);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const response = await this.fetcher(classroomApiUrl(path), { ...init, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `classroom_http_${response.status}`);
    }
    return await response.json() as T;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> { return this.request(path, { method: 'GET', signal }); }
  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request(path, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body), signal });
  }
  delete<T>(path: string): Promise<T> { return this.request(path, { method: 'DELETE' }); }

  async uploadPdf<T>(path: string, bytes: ArrayBuffer | Uint8Array, title: string, idempotencyKey: string): Promise<T> {
    const headers = this.headers(false);
    headers.set('content-type', 'application/pdf');
    headers.set('idempotency-key', idempotencyKey);
    headers.set('x-material-title', encodeURIComponent(title));
    const body = bytes instanceof Uint8Array ? new Blob([bytes.slice().buffer as ArrayBuffer]) : new Blob([bytes]);
    const response = await this.fetcher(classroomApiUrl(path), { method: 'POST', headers, body });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `classroom_http_${response.status}`);
    }
    return await response.json() as T;
  }

  async pdf(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await this.fetcher(classroomApiUrl(path), { headers: this.headers(false), signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `classroom_http_${response.status}`);
    }
    return response.arrayBuffer();
  }

  async stream(path: string, onFrame: (frame: ClassroomSseFrame) => void, signal: AbortSignal): Promise<void> {
    const response = await this.fetcher(classroomApiUrl(path), { headers: this.headers(false), signal });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `classroom_stream_${response.status}`);
    }
    const parser = parseClassroomSse();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) onFrame(frame);
    }
  }
}
