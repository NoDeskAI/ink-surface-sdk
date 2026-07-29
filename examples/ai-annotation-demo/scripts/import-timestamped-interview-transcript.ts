import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: tsx import-timestamped-interview-transcript.ts <source.txt> <output.json>\n');
  process.exit(0);
}
if (!process.argv[2] || !process.argv[3]) {
  process.stderr.write('source.txt and output.json are required. Run with --help.\n');
  process.exit(2);
}
const sourcePath = resolve(process.argv[2]);
const outputPath = resolve(process.argv[3]);
const source = readFileSync(sourcePath, 'utf8');
const lines = source.split(/\r?\n/);
const dateHeader = lines[0]?.trim();
const titleHeader = lines[1]?.trim();
const startedAtMs = Date.parse(`${dateHeader} 10:00:00 GMT+0800`);

if (!Number.isFinite(startedAtMs) || !titleHeader?.endsWith(' - Transcript')) {
  throw new Error(`Unsupported timestamped interview header in ${sourcePath}`);
}

const title = titleHeader.replace(/\s+-\s+Transcript$/, '');
const timePattern = /^(\d{2}):(\d{2}):(\d{2})$/;
const speakerPattern = /^([^:]{1,160}):\s*(.*)$/;
let currentOffsetMs = 0;
let stopped = false;
const utterances: Array<{ id: string; speaker: string; start_ms: number; end_ms: number; text: string }> = [];

for (const rawLine of lines.slice(2)) {
  const line = rawLine.trim();
  if (!line || stopped) continue;
  if (line.startsWith('Transcription ended after ')) {
    stopped = true;
    continue;
  }
  const time = line.match(timePattern);
  if (time) {
    currentOffsetMs = (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000;
    continue;
  }
  const speaker = line.match(speakerPattern);
  if (!speaker) throw new Error(`Unsupported transcript line: ${line}`);
  const index = utterances.length;
  const startMs = currentOffsetMs + index;
  utterances.push({
    id: `u${String(index + 1).padStart(3, '0')}`,
    speaker: speaker[1].trim(),
    start_ms: startMs,
    end_ms: startMs + 1,
    text: speaker[2].trim(),
  });
}

if (!utterances.length) throw new Error(`No utterances found in ${sourcePath}`);

const fixture = {
  title,
  meeting_id: `interview-${outputPath.split('/').at(-1)?.replace(/\.json$/i, '') || 'imported'}`,
  occurrence_id: `local:owned-interview:${outputPath.split('/').at(-1)?.replace(/\.json$/i, '') || 'imported'}`,
  started_at_ms: startedAtMs,
  ended_at_ms: startedAtMs + Math.max(...utterances.map((utterance) => utterance.end_ms)),
  transcript_origin: 'inkloop_media',
  import_metadata: {
    source_format: 'timestamped_named_speaker_transcript',
    evidence_scope: 'dialogue_before_transcription_footer_only',
    timestamp_policy: 'source_section_timestamp_with_stable_intra_section_order',
    transcript_quality: 'computer_generated_may_contain_errors',
    source_path: sourcePath,
  },
  utterances,
};

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output: outputPath, title, utterances: utterances.length, duration_ms: Math.max(...utterances.map((utterance) => utterance.end_ms)) })}\n`);
