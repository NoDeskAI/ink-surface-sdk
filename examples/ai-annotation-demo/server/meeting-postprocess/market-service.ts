import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { buildEvidenceSnapshot } from './evidence-snapshot';
import { generateBriefV2, type JsonGenerator } from './brief-v2';
import { generateInterviewArchiveHtml } from './interview-archive-html';
import { renderMeetingSummary } from './summary-renderer';
import { MeetingPostprocessMarketStore, marketPromptStorePath } from './market-store';
import { MEETING_POSTPROCESS_TEMPLATES, MEETING_TEMPLATE_IDS, meetingTemplate, type MeetingTemplateId } from './templates';

const runSchema = z.object({
  template_id: z.enum(MEETING_TEMPLATE_IDS),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(160),
  fixture_id: z.string().trim().max(500).optional(),
  title: z.string().trim().min(1).max(300).default('后处理调试会议'),
  transcript: z.string().max(2_000_000).optional(),
  conclusions: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  deepest_impressions: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  pain_points: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
}).strict();

const saveSchema = z.object({
  template_id: z.enum(MEETING_TEMPLATE_IDS),
  base_version: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(160),
}).strict();

interface Fixture {
  title: string;
  meeting_id?: string;
  occurrence_id?: string;
  started_at_ms?: number;
  ended_at_ms?: number;
  transcript_final?: boolean;
  ocr_status?: 'ready' | 'pending' | 'failed' | 'not_applicable';
  utterances: Array<{ id?: string; speaker?: string; start_ms: number; end_ms: number; text: string }>;
  handwriting?: Array<{ id: string; text: string; revision: number; mark_ids?: string[]; confidence?: number | null; corrected_by_user?: boolean }>;
}

type MarketRunInput = z.infer<typeof runSchema>;
type MarketModelCall = { index: number; started_at: string; duration_ms: number | null; status: 'running' | 'succeeded' | 'failed'; error?: string };
type MarketRunResult = Record<string, unknown> & { elapsed_ms: number; model_calls: MarketModelCall[] };
type MarketJob = {
  run_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  template_id: MeetingTemplateId;
  model: string;
  title: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number;
  stage: string;
  model_calls: MarketModelCall[];
  result?: MarketRunResult;
  error?: string;
};

export interface MeetingPostprocessMarketServiceOptions {
  root: string;
  generate: JsonGenerator;
  readBody: (req: IncomingMessage, max?: number) => Promise<string>;
  defaultModel?: string;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

function walkJson(root: string, directory = root): string[] {
  try {
    return readdirSync(directory).flatMap((name) => {
      const path = resolve(directory, name);
      const info = statSync(path);
      return info.isDirectory() ? walkJson(root, path) : name.endsWith('.json') ? [relative(root, path)] : [];
    });
  } catch {
    return [];
  }
}

function safeFixturePath(root: string, id: string): string {
  const path = resolve(root, id);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('market_fixture_invalid');
  return path;
}

function parseTranscript(text: string): Fixture['utterances'] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const match = line.match(/^(?:\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*)?([^：:]{1,80})[：:]\s*(.+)$/u);
    const seconds = match ? Number(match[1] || 0) * (match[3] ? 3600 : 60) + Number(match[2] || 0) * (match[3] ? 60 : 1) + Number(match[3] || 0) : index * 5;
    return {
      id: `pasted-${String(index + 1).padStart(4, '0')}`,
      speaker: match?.[4]?.trim() || undefined,
      start_ms: seconds * 1_000,
      end_ms: seconds * 1_000 + 4_000,
      text: match?.[5]?.trim() || line,
    };
  });
}

function fixtureList(root: string): Array<{ id: string; title: string; utterances: number; bytes: number }> {
  return walkJson(root).flatMap((id) => {
    try {
      const path = safeFixturePath(root, id);
      const raw = readFileSync(path, 'utf8');
      const fixture = JSON.parse(raw) as Fixture;
      if (!Array.isArray(fixture.utterances)) return [];
      return [{ id, title: fixture.title || basename(id, '.json'), utterances: fixture.utterances.length, bytes: Buffer.byteLength(raw) }];
    } catch {
      return [];
    }
  }).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

async function executeMarketRun(input: MarketRunInput, fixtureRoot: string, generateModel: JsonGenerator, job?: MarketJob): Promise<MarketRunResult> {
  let fixture: Fixture;
  if (input.transcript?.trim()) {
    fixture = { title: input.title, transcript_final: true, ocr_status: 'not_applicable', utterances: parseTranscript(input.transcript), handwriting: [] };
  } else if (input.fixture_id) {
    fixture = JSON.parse(readFileSync(safeFixturePath(fixtureRoot, input.fixture_id), 'utf8')) as Fixture;
  } else {
    throw Object.assign(new Error('market_fixture_or_transcript_required'), { status: 400 });
  }
  if (!fixture.utterances.length) throw Object.assign(new Error('market_transcript_empty'), { status: 400 });
  const template = meetingTemplate(input.template_id);
  const snapshot = buildEvidenceSnapshot({
    tenant_id: 'postprocess-market',
    user_id: 'local-debugger',
    meeting_id: fixture.meeting_id || 'market-debug',
    occurrence_id: fixture.occurrence_id || `market:${Date.now()}`,
    meeting_title: input.title || fixture.title,
    transcript_final: fixture.transcript_final ?? true,
    transcript_converged: fixture.transcript_final ?? true,
    ocr_status: fixture.ocr_status || 'not_applicable',
    started_at_ms: fixture.started_at_ms,
    ended_at_ms: fixture.ended_at_ms,
    template_id: input.template_id,
    user_guidance: { conclusions: input.conclusions, deepest_impressions: input.deepest_impressions, pain_points: input.pain_points },
    utterances: fixture.utterances,
    handwriting: fixture.handwriting || [],
  });
  const started = Date.now();
  const calls: MarketModelCall[] = job?.model_calls || [];
  const generate: JsonGenerator = async (request) => {
    const callStarted = Date.now();
    const call: MarketModelCall = { index: calls.length + 1, started_at: new Date().toISOString(), duration_ms: null, status: 'running' };
    calls.push(call);
    if (job) job.stage = input.template_id === 'interview_archive' && call.index === 2 ? '事实审校' : call.index === 1 ? '模型生成' : `模型调用 ${call.index}`;
    try {
      const result = await generateModel({ ...request, model: input.model });
      call.duration_ms = Date.now() - callStarted;
      call.status = 'succeeded';
      return result;
    } catch (error) {
      call.duration_ms = Date.now() - callStarted;
      call.status = 'failed';
      call.error = String((error as Error)?.message || error);
      throw error;
    }
  };
  if (input.template_id === 'interview_archive') {
    const artifact = await generateInterviewArchiveHtml({ title: input.title || fixture.title, snapshot, generate, template_prompt: input.prompt });
    return {
      debug_only: true, template_id: input.template_id, template_version: template.version, model: input.model,
      elapsed_ms: Date.now() - started, model_calls: calls, output_kind: 'html', html: artifact.html, filename: artifact.filename,
      input_stats: { utterances: snapshot.utterances.length, handwriting: snapshot.handwriting.length },
    };
  }
  const cards = await generateBriefV2({ title: input.title || fixture.title, snapshot, generate, template_prompt: input.prompt });
  return {
    debug_only: true, template_id: input.template_id, template_version: template.version, model: input.model,
    elapsed_ms: Date.now() - started, model_calls: calls, output_kind: 'summary_cards', cards, markdown: renderMeetingSummary(cards),
    input_stats: { utterances: snapshot.utterances.length, handwriting: snapshot.handwriting.length },
  };
}

export function createMeetingPostprocessMarketService(options: MeetingPostprocessMarketServiceOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const fixtureRoot = resolve(options.root, 'fixtures/meeting-postprocess');
  const promptStore = new MeetingPostprocessMarketStore(marketPromptStorePath(options.root));
  const jobs = new Map<string, MarketJob>();
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://inkloop.local');
    if (!url.pathname.startsWith('/api/__debug/meeting-postprocess-market')) return false;
    try {
      if (req.method === 'GET' && url.pathname.endsWith('/bootstrap')) {
        json(res, 200, {
          debug_only: true,
          default_model: options.defaultModel || 'gpt-5.5',
          models: [...new Set([options.defaultModel || 'gpt-5.5', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2'])],
          templates: MEETING_TEMPLATE_IDS.map((id) => MEETING_POSTPROCESS_TEMPLATES[id]),
          fixtures: fixtureList(fixtureRoot),
          saved_prompts: promptStore.list(),
        });
        return true;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/prompts')) {
        json(res, 200, { prompts: promptStore.list(url.searchParams.get('template_id') || undefined) });
        return true;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/prompts')) {
        const saved = promptStore.save(saveSchema.parse(JSON.parse(await options.readBody(req, 120_000))));
        json(res, 201, { saved });
        return true;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/runs')) {
        const input = runSchema.parse(JSON.parse(await options.readBody(req, 2_200_000)));
        // Validate local input before acknowledging a background job.
        if (!input.transcript?.trim() && !input.fixture_id) throw Object.assign(new Error('market_fixture_or_transcript_required'), { status: 400 });
        if (input.fixture_id) JSON.parse(readFileSync(safeFixturePath(fixtureRoot, input.fixture_id), 'utf8'));
        const runId = randomUUID();
        const job: MarketJob = {
          run_id: runId, status: 'queued', template_id: input.template_id, model: input.model, title: input.title,
          created_at: new Date().toISOString(), started_at: null, completed_at: null, elapsed_ms: 0, stage: '排队中', model_calls: [],
        };
        jobs.set(runId, job);
        void (async () => {
          const started = Date.now();
          job.status = 'running';
          job.started_at = new Date(started).toISOString();
          job.stage = '准备会议事实';
          try {
            job.result = await executeMarketRun(input, fixtureRoot, options.generate, job);
            job.status = 'succeeded';
            job.stage = '完成';
          } catch (error) {
            job.status = 'failed';
            job.stage = '失败';
            job.error = String((error as Error)?.message || error);
          } finally {
            job.elapsed_ms = Date.now() - started;
            job.completed_at = new Date().toISOString();
          }
        })();
        json(res, 202, { run_id: runId, status: job.status, created_at: job.created_at });
        return true;
      }
      if (req.method === 'GET' && /\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = decodeURIComponent(url.pathname.split('/').pop() || '');
        const job = jobs.get(runId);
        if (!job) { json(res, 404, { error: 'market_run_not_found' }); return true; }
        const liveElapsed = job.status === 'running' && job.started_at ? Date.now() - Date.parse(job.started_at) : job.elapsed_ms;
        json(res, 200, { ...job, elapsed_ms: liveElapsed });
        return true;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/run')) {
        const input = runSchema.parse(JSON.parse(await options.readBody(req, 2_200_000)));
        json(res, 200, await executeMarketRun(input, fixtureRoot, options.generate));
        return true;
      }
      json(res, 404, { error: 'market_route_not_found' });
      return true;
    } catch (error) {
      const issue = error instanceof z.ZodError ? error.issues.map((item) => `${item.path.join('.')}: ${item.message}`).join('; ') : String((error as Error)?.message || error);
      json(res, Number((error as { status?: number })?.status) || (error instanceof z.ZodError ? 400 : 500), { error: issue });
      return true;
    }
  };
}
