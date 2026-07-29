import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMeetingPostprocessJson } from './infer';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function configure(): void {
  process.env.LLM_GATEWAY_URL = 'https://gateway.example/v1';
  process.env.LLM_GATEWAY_KEY = 'test-key';
  process.env.LLM_GATEWAY_TRANSPORT = 'chat_completions';
  process.env.LLM_MODEL = 'gpt-5.5';
}

describe('meeting postprocess GPT reasoning budget', () => {
  it('uses low reasoning effort for structured meeting extraction', async () => {
    configure();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"theme":"ok"}' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(runMeetingPostprocessJson({ system: 'system', user: 'meeting', max_tokens: 8_000, model: 'gpt-5.5' })).resolves.toEqual({ theme: 'ok' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: 'gpt-5.5', max_tokens: 8_000, reasoning_effort: 'low' });
  });

  it('does not duplicate a paid request when the requested budget is exhausted', async () => {
    configure();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'length' }],
        usage: { completion_tokens: 24_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(runMeetingPostprocessJson({ system: 'system', user: 'meeting', max_tokens: 4_000, model: 'gpt-5.5' })).rejects.toThrow('finish=length');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['trailing comma', '{"theme":"ok",}', { theme: 'ok' }],
    ['truncated object', '{"theme":"ok"', { theme: 'ok' }],
    ['truncated string', '{"theme":"ok', { theme: 'ok' }],
    ['truncated array', '{"items":[1,2', { items: [1, 2] }],
  ])('repairs %s JSON without a second provider request', async (_name, content, expected) => {
    configure();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(runMeetingPostprocessJson({
      system: 'system',
      user: 'meeting',
      max_tokens: 1_024,
      model: 'gpt-5.5',
    })).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects irreparable JSON without hiding it as empty output', async () => {
    configure();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"theme": nope}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await expect(runMeetingPostprocessJson({
      system: 'system',
      user: 'meeting',
      max_tokens: 1_024,
      model: 'gpt-5.5',
    })).rejects.toThrow('meeting_postprocess_json_invalid');
  });
});
