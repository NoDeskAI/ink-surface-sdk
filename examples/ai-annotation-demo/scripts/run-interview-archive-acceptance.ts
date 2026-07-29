import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildEvidenceSnapshot } from '../server/meeting-postprocess/evidence-snapshot';
import { generateInterviewArchiveHtml } from '../server/meeting-postprocess/interview-archive-html';
import { runMeetingPostprocessJson } from '../server/infer';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: tsx run-interview-archive-acceptance.ts <fixture.json> <output-dir> [saved-model-output.json] [audited]\n');
  process.exit(0);
}
if (!process.argv[2] || !process.argv[3]) {
  process.stderr.write('fixture.json and output-dir are required. Run with --help.\n');
  process.exit(2);
}
const fixturePath = resolve(process.argv[2]);
const outputDir = resolve(process.argv[3]);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { title: string; meeting_id?: string; occurrence_id?: string; started_at_ms?: number; ended_at_ms?: number; utterances: Array<{ id?: string; speaker?: string; start_ms: number; end_ms: number; text: string }> };
for (const path of [resolve('.env'), resolve(process.env.HOME || '', '.hermes/.env')]) try { for (const line of readFileSync(path, 'utf8').split('\n')) { const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, ''); } } catch {}
if (!process.env.LLM_GATEWAY_KEY && process.env.NODESK_API_KEY) process.env.LLM_GATEWAY_KEY = process.env.NODESK_API_KEY;
process.env.LLM_GATEWAY_URL ||= 'https://llm-gateway-api.nodesk.tech/default/v1'; process.env.LLM_GATEWAY_TRANSPORT ||= 'openai_chat_completions'; process.env.LLM_MODEL ||= 'gpt-5.5';
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const snapshot = buildEvidenceSnapshot({ tenant_id: 'acceptance', user_id: 'acceptance', meeting_id: fixture.meeting_id || 'interview', occurrence_id: fixture.occurrence_id || 'local:interview', meeting_title: fixture.title, template_id: 'interview_archive', transcript_final: true, ocr_status: 'not_applicable', started_at_ms: fixture.started_at_ms, ended_at_ms: fixture.ended_at_ms, utterances: fixture.utterances });
const started = Date.now(); let modelMs = 0; let modelCalls = 0; let callbackCalls = 0; const savedRawPath = process.argv[4] ? resolve(process.argv[4]) : null;
try {
  const result = await generateInterviewArchiveHtml({ title: fixture.title, snapshot, skipAudit: process.argv[5] === 'audited', generate: async (input) => {
    callbackCalls += 1;
    if (savedRawPath && callbackCalls === 1) return JSON.parse(readFileSync(savedRawPath, 'utf8'));
    const at = Date.now(); const raw = await runMeetingPostprocessJson(input); modelMs += Date.now() - at; modelCalls += 1;
    const name = callbackCalls === 1 ? 'raw-model-output.json' : `raw-model-output-pass-${callbackCalls}.json`;
    writeFileSync(resolve(outputDir, name), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 }); return raw;
  } });
  const htmlPath = resolve(outputDir, result.filename); writeFileSync(htmlPath, result.html, { mode: 0o600 });
  writeFileSync(resolve(outputDir, 'metrics.json'), `${JSON.stringify({ status: 'passed', wall_time_ms: Date.now() - started, model_calls: modelCalls, reused_model_output: !!savedRawPath, model_call_duration_ms: modelMs, html_bytes: Buffer.byteLength(result.html), html_path: htmlPath }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: 'passed', html_path: htmlPath, wall_time_ms: Date.now() - started, model_call_duration_ms: modelMs }, null, 2));
} catch (error) {
  writeFileSync(resolve(outputDir, 'metrics.json'), `${JSON.stringify({ status: 'failed', wall_time_ms: Date.now() - started, model_calls: modelCalls, model_call_duration_ms: modelMs, error: String((error as Error).message || error) }, null, 2)}\n`, { mode: 0o600 });
  throw error;
}
