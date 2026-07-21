import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayEventStream } from './infer';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function configureOpenAi(): void {
  process.env.LLM_GATEWAY_URL = 'https://gateway.example/v1';
  process.env.LLM_GATEWAY_KEY = 'test-key';
  process.env.LLM_GATEWAY_TRANSPORT = 'chat_completions';
  process.env.LLM_MODEL = 'glm-test';
}

describe('OpenAI chat-completions streaming', () => {
  it('requests SSE and yields each text delta incrementally', async () => {
    configureOpenAi();
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const stream = gatewayEventStream({ system: 'system', messages: [{ role: 'user', content: 'hello' }], maxTokens: 99 });
    const firstPending = stream.next();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ stream: true, max_tokens: 99 });
    expect(new Headers(request?.[1]?.headers).get('accept')).toBe('text/event-stream');

    controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    await expect(firstPending).resolves.toEqual({ done: false, value: { type: 'text', delta: 'first' } });
    const secondPending = stream.next();
    controller!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" second"}}]}\n\ndata: [DONE]\n\n'));
    controller!.close();
    await expect(secondPending).resolves.toEqual({ done: false, value: { type: 'text', delta: ' second' } });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('safely falls back to a non-SSE JSON response', async () => {
    configureOpenAi();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'complete response' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const events = [];
    for await (const event of gatewayEventStream({ system: '', messages: [], maxTokens: 10 })) events.push(event);
    expect(events).toEqual([{ type: 'text', delta: 'complete response' }]);
  });

  it('rejects an SSE response that finishes without正文', async () => {
    configureOpenAi();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const consume = async () => {
      for await (const _event of gatewayEventStream({ system: '', messages: [], maxTokens: 10 })) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow('网关返回空正文');
  });
});
