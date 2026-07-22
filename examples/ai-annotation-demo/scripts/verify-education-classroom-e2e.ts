import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnv } from 'vite';
import { runEducationLessonStructured, runEducationStructured } from '../server/infer';
import { evaluateCompletingSquareResult, type CompletingSquareResultKind } from './education-completing-square-acceptance';

interface FixtureLine {
  order: number;
  event_ids: string[];
  bbox_norm: [number, number, number, number];
  text: string;
  latex: string;
}

interface Fixture {
  fixture_id: string;
  title: string;
  material_id: string;
  page_index: number;
  lines: FixtureLine[];
}

const packageRoot = process.cwd();
const output = resolve(process.argv[2] || 'test-results/education-classroom-real-ai.json');
const env = loadEnv(process.env.NODE_ENV || 'development', packageRoot, '');
for (const key of ['LLM_GATEWAY_URL', 'LLM_GATEWAY_BASE', 'LLM_GATEWAY_KEY', 'LLM_GATEWAY_TRANSPORT', 'LLM_MODEL']) {
  if (env[key] && !process.env[key]) process.env[key] = env[key];
}

function safeErrorCode(error: unknown): string {
  const value = error as { name?: string; message?: string };
  const message = String(value?.message || 'education_real_ai_unknown_error');
  if (value?.name === 'ZodError') return 'education_invalid_structured_output';
  if (message.startsWith('education_')) return message.slice(0, 160);
  return 'education_real_ai_provider_failed';
}

async function structuredAttempt<T>(operation: () => Promise<T>): Promise<{ result: T; attempts: number }> {
  try {
    return { result: await operation(), attempts: 1 };
  } catch (error) {
    const code = safeErrorCode(error);
    if (code !== 'education_invalid_json' && code !== 'education_invalid_structured_output') throw error;
    return { result: await operation(), attempts: 2 };
  }
}

await mkdir(dirname(output), { recursive: true });
if (!process.env.LLM_GATEWAY_KEY) {
  const pending = {
    ok: false, status: 'pending', evidence_kind: 'real_gateway_acceptance', fixture_id: 'completing-square-x2-plus-4x-minus-5',
    blocker: 'education_real_ai_gateway_not_configured', required: ['LLM_GATEWAY_KEY'],
    note: 'Deterministic fallback and fixture tests do not count as the mathematical semantic gate.',
  };
  await writeFile(output, `${JSON.stringify(pending, null, 2)}\n`);
  console.error(JSON.stringify(pending, null, 2));
  process.exitCode = 2;
} else try {
  const fixture = JSON.parse(await readFile(resolve('fixtures/education-completing-square-evidence.json'), 'utf8')) as Fixture;
  const material = { material_id: fixture.material_id, title: fixture.title, page_index: fixture.page_index, bbox_norm: [0, 0, 1, 1] };
  const events = fixture.lines.map((line, index) => ({
    event_id: line.event_ids[0], sequence: line.order, ts_start_ms: 10_000 + index * 10_000, ts_end_ms: 10_500 + index * 10_000,
    bbox_norm: line.bbox_norm, tool: 'pen', points: [],
  }));
  const recognitions = fixture.lines.map((line) => ({
    recognition_id: `recognition_${line.order}`, revision: line.order === 5 ? 2 : 1, status: line.order === 5 ? 'corrected' as const : 'confirmed' as const,
    kind: 'formula' as const, text: line.text, latex: line.latex, event_ids: line.event_ids,
  }));
  const transcripts = [
    { transcript_id: 'transcript_1', revision: 1, status: 'final' as const, start_ms: 8_000, end_ms: 14_000, text: '先把负五移到等式右边，得到 x 平方加四 x 等于五。' },
    { transcript_id: 'transcript_2', revision: 2, status: 'corrected' as const, start_ms: 18_000, end_ms: 26_000, text: '一次项系数四的一半是二，平方是四，所以等式两边同时加四，右边变成九。' },
    { transcript_id: 'transcript_3', revision: 1, status: 'final' as const, start_ms: 28_000, end_ms: 36_000, text: '左边正好是 x 加二的完全平方。' },
    { transcript_id: 'transcript_4', revision: 2, status: 'corrected' as const, start_ms: 38_000, end_ms: 46_000, text: '两边开平方要保留正负两个分支，x 加二等于正负三。' },
    { transcript_id: 'transcript_5', revision: 1, status: 'final' as const, start_ms: 48_000, end_ms: 56_000, text: '最终 x 等于一或者负五。' },
  ];

  const runStudent = async (input: {
    name: CompletingSquareResultKind;
    kind: 'live_explanation' | 'class_summary' | 'practice';
    intent: 'current_step' | 'selected_region' | 'class_summary' | 'practice';
    eventIndexes: number[];
    transcriptIndexes: number[];
    materialBox?: [number, number, number, number];
  }) => {
    const selectedEvents = input.eventIndexes.map((index) => events[index]);
    const selectedRecognitions = input.eventIndexes.map((index) => recognitions[index]);
    const selectedTranscripts = input.transcriptIndexes.map((index) => transcripts[index]);
    const attempted = await structuredAttempt(() => runEducationStructured({
      kind: input.kind, intent: input.intent, material: { ...material, ...(input.materialBox ? { bbox_norm: input.materialBox } : {}) },
      time_window: { start_ms: selectedEvents[0].ts_start_ms, end_ms: selectedEvents.at(-1)!.ts_end_ms },
      evidence: selectedEvents, recognitions: selectedRecognitions, transcripts: selectedTranscripts, missing_sources: [],
    }));
    const result = attempted.result;
    const allowed = new Set(selectedEvents.map((item) => item.event_id));
    const unknownIds = result.sections.flatMap((section) => section.event_ids.filter((id) => !allowed.has(id)));
    const content = result.sections.map((section) => section.content).join('\n');
    const semantic = evaluateCompletingSquareResult(input.name, content);
    return {
      kind: input.name, execution_mode: 'real' as const, title: result.title, raw_result: result,
      section_count: result.sections.length, provider_attempts: attempted.attempts, input_source_types: ['material_page', 'ink_event', 'audio_segment'],
      source_validation: unknownIds.length === 0 ? 'passed' as const : 'failed' as const,
      unknown_source_ids: unknownIds, semantic,
    };
  };

  const student = [];
  student.push(await runStudent({ name: 'current_step', kind: 'live_explanation', intent: 'current_step', eventIndexes: [2], transcriptIndexes: [1], materialBox: fixture.lines[2].bbox_norm }));
  student.push(await runStudent({ name: 'selected_region', kind: 'live_explanation', intent: 'selected_region', eventIndexes: [2, 3], transcriptIndexes: [1, 2], materialBox: [0.1, 0.38, 0.55, 0.22] }));
  student.push(await runStudent({ name: 'class_summary', kind: 'class_summary', intent: 'class_summary', eventIndexes: [0, 1, 2, 3, 4, 5], transcriptIndexes: [0, 1, 2, 3, 4] }));
  student.push(await runStudent({ name: 'practice', kind: 'practice', intent: 'practice', eventIndexes: [1, 2, 3, 4, 5], transcriptIndexes: [1, 2, 3, 4] }));

  const lessonEvidence: unknown[] = [
    { evidence_type: 'material_page', ...material },
    ...events.map((item) => ({ evidence_type: 'ink_event', ...item })),
    ...recognitions.map((item) => ({ evidence_type: 'trusted_recognition', ...item })),
    ...transcripts.map((item) => ({ evidence_type: 'trusted_transcript', ...item })),
  ];
  const lessonAttempt = await structuredAttempt(() => runEducationLessonStructured({ evidence: lessonEvidence }));
  const lesson = lessonAttempt.result;
  const allowed = new Set(events.map((item) => item.event_id));
  const lessonUnknownIds = lesson.candidates.flatMap((candidate) => candidate.event_ids.filter((id) => !allowed.has(id)));
  const lessonContent = lesson.candidates.map((candidate) => `${candidate.content}${candidate.latex ? ` ${candidate.latex}` : ''}`).join('\n');
  const lessonSemantic = evaluateCompletingSquareResult('lesson_graph', lessonContent);
  const sourcePassed = student.every((item) => item.source_validation === 'passed') && lessonUnknownIds.length === 0;
  const semanticPassed = student.every((item) => item.semantic.passed) && lessonSemantic.passed;
  const report = {
    ok: sourcePassed && semanticPassed,
    status: sourcePassed && semanticPassed ? 'passed' : 'failed',
    evidence_kind: 'real_gateway_acceptance', fixture_id: fixture.fixture_id, equation: 'x² + 4x - 5 = 0',
    prompt_contract: { student: 'inkloop.education.v2', lesson_graph: 'inkloop.education.v3' }, model: process.env.LLM_MODEL || 'configured-default',
    student,
    teacher_lesson: {
      execution_mode: 'real', candidate_count: lesson.candidates.length, provider_attempts: lessonAttempt.attempts, raw_result: lesson,
      source_validation: lessonUnknownIds.length === 0 ? 'passed' : 'failed', unknown_source_ids: lessonUnknownIds,
      semantic: lessonSemantic,
    },
    human_review: {
      status: 'required',
      checks: ['Chinese usefulness', 'formula uncertainty', 'source navigation in both Web clients', 'teacher can accept raw LessonGraph without rewriting every step'],
    },
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const failed = {
    ok: false, status: 'failed', evidence_kind: 'real_gateway_acceptance', fixture_id: 'completing-square-x2-plus-4x-minus-5',
    error_code: safeErrorCode(error), note: 'Provider failure is not counted as a semantic pass. Raw provider bodies and credentials are omitted.',
  };
  await writeFile(output, `${JSON.stringify(failed, null, 2)}\n`);
  console.error(JSON.stringify(failed, null, 2));
  process.exitCode = 1;
}
