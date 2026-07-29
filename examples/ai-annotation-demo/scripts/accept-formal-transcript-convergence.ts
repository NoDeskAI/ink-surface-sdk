import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { MeetingAudioChunk } from '../../../packages/meeting-media-core/src/index';
import {
  createConfiguredFormalTranscriptConverger,
  type FormalTranscriptAudioChunk,
} from '../server/meeting-media/provider';

const [sessionDirectory, outputPath] = process.argv.slice(2);
if (!sessionDirectory) {
  throw new Error('usage: accept-formal-transcript-convergence <session-directory> [output.json]');
}
const modelDirectory = process.env.INKLOOP_SHERPA_MODEL_DIR?.trim();
if (!modelDirectory) throw new Error('INKLOOP_SHERPA_MODEL_DIR is required');
const converger = createConfiguredFormalTranscriptConverger({
  INKLOOP_STREAMING_ASR_PROVIDER: 'sherpa',
  INKLOOP_SHERPA_MODEL_DIR: modelDirectory,
});
if (!converger) throw new Error('formal transcript converger is not configured');

const startedAt = performance.now();
const chunks: FormalTranscriptAudioChunk[] = [];
for (const track of ['mic', 'remote'] as const) {
  const directory = resolve(sessionDirectory, 'raw', track);
  const names = await readdir(directory).catch(() => []);
  for (const metadataName of names.filter((name) => name.endsWith('.json')).sort()) {
    const stem = metadataName.slice(0, -'.json'.length);
    const chunk = JSON.parse(await readFile(resolve(directory, metadataName), 'utf8')) as MeetingAudioChunk;
    const audioPath = resolve(directory, `${stem}.audio`);
    chunks.push({
      chunk,
      loadAudio: async () => await readFile(audioPath),
    });
  }
}
const utterances = await converger.converge({
  session_id: chunks[0]?.chunk.session_id || '',
  chunks,
});
const result = {
  schema_version: 'inkloop.formal_transcript_acceptance.v1',
  converger_id: converger.converger_id,
  session_id: chunks[0]?.chunk.session_id,
  input_chunk_count: chunks.length,
  utterance_count: utterances.length,
  duration_ms: Math.round(performance.now() - startedAt),
  hallucination_phrase_count: utterances.filter((value) =>
    /(?:字幕|翻译|校对).{0,8}(?:志愿者|组|提供|制作)/u.test(value.text)).length,
  tail_243_247: utterances.filter((value) => value.source_chunk_ids.some((id) =>
    /:mic:(?:243|244|245|246|247)$/.test(id))),
  utterances,
};
const destination = outputPath || resolve(sessionDirectory, 'formal-transcript-acceptance.json');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.info(JSON.stringify({
  output: destination,
  input_chunk_count: result.input_chunk_count,
  utterance_count: result.utterance_count,
  duration_ms: result.duration_ms,
  hallucination_phrase_count: result.hallucination_phrase_count,
  tail_243_247: result.tail_243_247,
}, null, 2));
