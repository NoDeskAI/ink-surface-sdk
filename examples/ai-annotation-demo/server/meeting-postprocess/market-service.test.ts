import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMeetingPostprocessMarketService } from './market-service';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function host(generate: Parameters<typeof createMeetingPostprocessMarketService>[0]['generate']) {
  const root = mkdtempSync(join(tmpdir(), 'market-service-'));
  const fixtures = join(root, 'fixtures/meeting-postprocess');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'sample.json'), JSON.stringify({ title: 'Sample', transcript_final: true, ocr_status: 'not_applicable', utterances: [{ id: 'u1', speaker: 'Alice', start_ms: 0, end_ms: 1000, text: '我们确认下周发布。' }] }));
  const handler = createMeetingPostprocessMarketService({
    root, generate, defaultModel: 'gpt-5.5',
    readBody: async (req) => await new Promise<string>((resolve) => { const chunks: Buffer[] = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); }),
  });
  const server = createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, root };
}

describe('meeting postprocess market service', () => {
  it('lists six templates and fixture data', async () => {
    const app = await host(async () => ({}));
    const body = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/bootstrap`).then((response) => response.json()) as { templates: unknown[]; fixtures: unknown[]; default_model: string };
    expect(body.templates).toHaveLength(6);
    expect(body.fixtures).toHaveLength(1);
    expect(body.default_model).toBe('gpt-5.5');
  });

  it('passes prompt override and model into a debug run', async () => {
    const calls: Array<{ system: string; model?: string }> = [];
    const app = await host(async (input) => {
      calls.push({ system: input.system, model: input.model });
      return {
        theme: '发布确认', overview: '下周发布', section_titles: { background: '背景', discussion: '讨论', next_steps: '后续' },
        key_points: [{ id: 'k1', text: '确认下周发布', evidence_refs: ['u1'] }],
        decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [], template_sections: [],
      };
    });
    const response = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: 'meeting_expert', prompt: 'CUSTOM PROMPT MARKER', model: 'gpt-5.5-custom', fixture_id: 'sample.json', title: 'Sample' }),
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.model).toBe('gpt-5.5-custom');
    expect(calls[0]?.system).toContain('CUSTOM PROMPT MARKER');
  });

  it('persists prompt versions', async () => {
    const app = await host(async () => ({}));
    const response = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: 'interview_memo', base_version: 'interview_memo.v3', name: '访谈 A', prompt: 'keep facts', model: 'gpt-5.5' }),
    });
    expect(response.status).toBe(201);
    const list = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/prompts?template_id=interview_memo`).then((item) => item.json()) as { prompts: Array<{ name: string }> };
    expect(list.prompts[0]?.name).toBe('访谈 A');
  });

  it('runs asynchronously and exposes progress before completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = await host(async () => {
      await gate;
      return {
        theme: '后台任务', overview: '已完成', section_titles: { background: '背景', discussion: '讨论', next_steps: '后续' },
        key_points: [{ id: 'k1', text: '确认下周发布', evidence_refs: ['u1'] }],
        decisions: [], action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: [], template_sections: [],
      };
    });
    const created = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: 'meeting_expert', prompt: 'ASYNC', model: 'gpt-5.5', fixture_id: 'sample.json', title: 'Sample' }),
    });
    expect(created.status).toBe(202);
    const { run_id } = await created.json() as { run_id: string };
    const running = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/runs/${run_id}`).then((response) => response.json()) as { status: string; stage: string; model_calls: Array<{ status: string }> };
    expect(running.status).toBe('running');
    expect(running.stage).toBe('模型生成');
    expect(running.model_calls[0]?.status).toBe('running');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = await fetch(`${app.base}/api/__debug/meeting-postprocess-market/runs/${run_id}`).then((response) => response.json()) as { status: string; result?: { output_kind: string } };
    expect(completed.status).toBe('succeeded');
    expect(completed.result?.output_kind).toBe('summary_cards');
  });
});
