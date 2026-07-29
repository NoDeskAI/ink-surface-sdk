import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEvidenceSnapshot } from '../server/meeting-postprocess/evidence-snapshot';
import { MeetingPostprocessScheduler } from '../server/meeting-postprocess/scheduler';
import { MeetingPostprocessStore } from '../server/meeting-postprocess/store';
import { MEETING_TEMPLATE_IDS, type MeetingTemplateId } from '../server/meeting-postprocess/templates';
import { runMeetingPostprocessJson } from '../server/infer';

interface Fixture { title: string; meeting_id?: string; occurrence_id?: string; transcript_final?: boolean; ocr_status?: 'ready' | 'pending' | 'failed' | 'not_applicable'; started_at_ms?: number; ended_at_ms?: number; debug_chunk_chars?: number; utterances: Array<{ id?: string; speaker?: string; start_ms: number; end_ms: number; text: string }>; handwriting?: Array<{ id: string; text: string; revision: number; mark_ids?: string[]; confidence?: number | null; corrected_by_user?: boolean }> }

function option(args: string[], name: string): string | undefined {
  return args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function repeatedOption(args: string[], name: string): string[] {
  return args
    .filter((value) => value.startsWith(`--${name}=`))
    .map((value) => value.slice(name.length + 3).trim())
    .filter(Boolean);
}

const debugUsage = 'usage: debug-meeting-postprocess [fixture.json] [--template=<id>] [--output=<report.json>]';

export function validateDebugMeetingPostprocessArgs(args: string[]): void {
  const switches = new Set(['--real-model', '--production-chunks', '--cards-only']);
  const valueOptions = new Set([
    'template',
    'root',
    'started-at-ms',
    'conclusion',
    'impression',
    'pain-point',
    'raw-output',
    'output',
  ]);
  let positionalCount = 0;
  for (const argument of args) {
    if (!argument.startsWith('--')) {
      positionalCount += 1;
      if (positionalCount > 1) throw new Error(`unexpected_positional:${argument}`);
      continue;
    }
    if (switches.has(argument)) continue;
    const equals = argument.indexOf('=');
    const name = equals > 2 ? argument.slice(2, equals) : '';
    const value = equals >= 0 ? argument.slice(equals + 1).trim() : '';
    if (!valueOptions.has(name)) throw new Error(`unknown_argument:${argument}`);
    if (!value) throw new Error(`missing_value:--${name}`);
  }
}

function requestedTemplate(args: string[]): MeetingTemplateId {
  const value = option(args, 'template') || 'meeting_expert';
  if (!MEETING_TEMPLATE_IDS.includes(value as MeetingTemplateId)) {
    throw new Error(`unknown meeting template: ${value}`);
  }
  return value as MeetingTemplateId;
}

function loadModelEnvironment(): void {
  for (const path of [resolve('.env'), resolve(homedir(), '.hermes/.env')]) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* Local debug can also rely entirely on the process environment. */ }
  }
  if (!process.env.LLM_GATEWAY_KEY && process.env.NODESK_API_KEY) process.env.LLM_GATEWAY_KEY = process.env.NODESK_API_KEY;
  if (!process.env.LLM_GATEWAY_URL) process.env.LLM_GATEWAY_URL = 'https://llm-gateway-api.nodesk.tech/default/v1';
  if (!process.env.LLM_GATEWAY_TRANSPORT) process.env.LLM_GATEWAY_TRANSPORT = 'openai_chat_completions';
  if (!process.env.LLM_MODEL) process.env.LLM_MODEL = 'gpt-5.5';
}

export async function debugMeetingPostprocess(args = process.argv.slice(2)): Promise<Record<string, unknown>> {
  validateDebugMeetingPostprocessArgs(args);
  if (args.includes('--real-model')) loadModelEnvironment();
  const fixturePath = resolve(args.find((x) => !x.startsWith('--')) || 'fixtures/meeting-postprocess/ordinary.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const rootArg = option(args, 'root');
  const root = rootArg ? resolve(rootArg) : mkdtempSync(resolve(tmpdir(), 'inkloop-meeting-postprocess-'));
  const scope = { tenant_id: 'debug', user_id: 'debug', meeting_id: fixture.meeting_id || 'debug-meeting', occurrence_id: fixture.occurrence_id || 'debug:occurrence' };
  const startedAtOption = Number(option(args, 'started-at-ms'));
  const snapshot = buildEvidenceSnapshot({
    ...scope,
    meeting_title: fixture.title,
    transcript_final: fixture.transcript_final ?? true,
    ocr_status: fixture.ocr_status || 'ready',
    started_at_ms: Number.isFinite(startedAtOption) ? startedAtOption : fixture.started_at_ms,
    ended_at_ms: fixture.ended_at_ms,
    template_id: requestedTemplate(args),
    user_guidance: {
      conclusions: repeatedOption(args, 'conclusion'),
      deepest_impressions: repeatedOption(args, 'impression'),
      pain_points: repeatedOption(args, 'pain-point'),
    },
    utterances: fixture.utterances,
    handwriting: (fixture.handwriting || []).map((x) => ({ mark_ids: [], confidence: null, corrected_by_user: false, ...x })),
  });
  const store = new MeetingPostprocessStore(root, scope);
  await store.saveSnapshot(snapshot);
  const firstHandwriting = snapshot.handwriting[0];
  let modelCalls = 0;
  let activeModelCalls = 0;
  let maxConcurrentModelCalls = 0;
  const modelCallDurationsMs: number[] = [];
  const mockGenerate = async (input: { system: string; user: string }) => {
    modelCalls += 1;
    const referencedIds = new Set([...input.user.matchAll(/utterance:([^\s\]"',}]+)/g)].map((match) => match[1]));
    const allowed = snapshot.utterances.filter((utterance) => referencedIds.has(utterance.id));
    const candidates = allowed.length ? allowed : snapshot.utterances;
    const firstRef = candidates[0]?.id;
    return { theme: fixture.title, overview: `${snapshot.utterances.length} 条发言，${snapshot.handwriting.length} 条手写证据`, key_points: firstRef ? [{ id: `kp-${firstRef}`, text: candidates[0].text, evidence_refs: [firstRef] }] : [], decisions: candidates.filter((x) => /决定|decid/i.test(x.text)).slice(0, 1).map((x) => ({ id: `decision-${x.id}`, text: x.text, status: 'confirmed', evidence_refs: [x.id] })), action_items: [], highlights: [], risks: [], open_questions: [], personal_notes: firstHandwriting ? [{ id: 'pn1', text: firstHandwriting.text, kind: 'thought', mark_refs: firstHandwriting.mark_ids.length ? firstHandwriting.mark_ids : [firstHandwriting.id], supporting_utterance_refs: [] }] : [] };
  };
  const generate = args.includes('--real-model')
    ? async (input: { system: string; user: string; max_tokens: number }) => {
        modelCalls += 1; activeModelCalls += 1; maxConcurrentModelCalls = Math.max(maxConcurrentModelCalls, activeModelCalls);
        const started = Date.now();
        try {
          const raw = await runMeetingPostprocessJson(input);
          if (option(args, 'raw-output')) writeFileSync(resolve(`${option(args, 'raw-output')}.${modelCalls}.json`), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
          return raw;
        }
        finally { modelCallDurationsMs.push(Date.now() - started); activeModelCalls -= 1; }
      }
    : mockGenerate;
  const scheduler = fixture.debug_chunk_chars && !args.includes('--production-chunks')
    ? new MeetingPostprocessScheduler(store, generate, () => new Date(), fixture.debug_chunk_chars)
    : new MeetingPostprocessScheduler(store, generate);
  const wallStarted = Date.now();
  await scheduler.enqueue(snapshot, snapshot.template_id === 'interview_archive' ? 'meeting.interview_archive_html' : 'meeting.summary_cards', { title: fixture.title });
  await scheduler.drain();
  if (args.includes('--real-model')) {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const pending = store.listRuns(scope).filter((run) => run.status === 'queued' || run.status === 'running');
      if (!pending.length) break;
      const queued = pending.filter((run) => run.status === 'queued');
      const delay = queued.length ? Math.max(0, Math.min(...queued.map((run) => Date.parse(run.available_at))) - Date.now()) : 250;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(10_000, delay + 25)));
      await scheduler.drain();
    }
  }
  const events = store.listEvents(scope);
  const output = { root, wall_time_ms: Date.now() - wallStarted, model_calls: modelCalls, model_call_durations_ms: modelCallDurationsMs, max_concurrent_model_calls: maxConcurrentModelCalls, metrics: events.filter((event) => event.type === 'stage.metric').map((event) => event.data), snapshot: { id: snapshot.snapshot_id, fingerprint: snapshot.fingerprint, finality: snapshot.finality, template_id: snapshot.template_id, template_version: snapshot.template_version, user_guidance: snapshot.user_guidance, missing_reasons: snapshot.missing_reasons, utterance_count: snapshot.utterances.length, handwriting_count: snapshot.handwriting.length }, runs: store.listRuns(scope).map((x) => ({ id: x.run_id, kind: x.artifact_kind, status: x.status, attempt: x.attempt, error_code: x.error_code })), artifacts: store.listArtifacts(scope).map((x) => ({ id: x.artifact_id, kind: x.kind, revision: x.revision, finality: x.finality, status: x.status, bytes: Buffer.byteLength(JSON.stringify(x.content), 'utf8'), content: x.content })), events: events.map((x) => ({ id: x.event_id, type: x.type, data: x.data })) };
  const outputPath = option(args, 'output');
  if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(debugUsage);
  } else {
    debugMeetingPostprocess(argv).then((output) => {
      if (!argv.some((x) => x.startsWith('--output='))) console.log(JSON.stringify(output, null, 2));
      else console.log(JSON.stringify({ output: argv.find((x) => x.startsWith('--output='))?.slice('--output='.length), wall_time_ms: output.wall_time_ms, model_calls: output.model_calls, runs: output.runs }));
    }).catch((error) => {
      console.error(String((error as Error).message || error));
      process.exitCode = 2;
    });
  }
}
