import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: tsx import-pasted-interview-transcript.ts <source.txt> <output.json> [interviewee]\n');
  process.exit(0);
}
if (!process.argv[2] || !process.argv[3]) {
  process.stderr.write('source.txt and output.json are required. Run with --help.\n');
  process.exit(2);
}
const sourcePath = resolve(process.argv[2]);
const outputPath = resolve(process.argv[3]);
const interviewee = process.argv[4]?.trim() || '受访者';
const source = readFileSync(sourcePath, 'utf8');
const transcriptMarker = 'Transcript:';
const markerIndex = source.indexOf(transcriptMarker);

if (markerIndex < 0) {
  throw new Error(`Missing ${transcriptMarker} marker in ${sourcePath}`);
}

const header = source.slice(0, markerIndex);
const title = header.match(/^Meeting Title:\s*(.+)$/m)?.[1]?.trim();
if (!title) {
  throw new Error(`Missing Meeting Title header in ${sourcePath}`);
}

const transcript = source.slice(markerIndex + transcriptMarker.length);
const startedAtMs = Date.parse('2026-07-22T02:00:00.000Z');
const utteranceSpacingMs = 15_000;
const utterances = transcript
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    const match = line.match(/^(Me|Them):\s*(.*)$/);
    if (!match) {
      throw new Error(`Unsupported transcript line ${index + 1}: ${line}`);
    }
    const startMs = index * utteranceSpacingMs;
    return {
      id: `u${String(index + 1).padStart(3, '0')}`,
      speaker: match[1] === 'Me' ? 'Wang Chenwei' : interviewee,
      start_ms: startMs,
      end_ms: startMs + utteranceSpacingMs - 1,
      text: match[2].trim(),
    };
  })
  .filter((utterance) => utterance.text);

if (!utterances.length) {
  throw new Error(`No utterances found in ${sourcePath}`);
}

const fixture = {
  title,
  meeting_id: `interview-${outputPath.split('/').at(-1)?.replace(/\.json$/i, '') || 'imported'}`,
  occurrence_id: `local:owned-interview:${outputPath.split('/').at(-1)?.replace(/\.json$/i, '') || 'imported'}`,
  started_at_ms: startedAtMs,
  ended_at_ms: startedAtMs + utterances.at(-1)!.end_ms,
  transcript_origin: 'inkloop_media',
  import_metadata: {
    source_format: 'pasted_me_them_transcript',
    evidence_scope: 'content_after_transcript_marker_only',
    timestamp_policy: 'synthetic_for_ordering_only',
    source_path: sourcePath,
  },
  utterances,
};

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output: outputPath, title, interviewee, utterances: utterances.length })}\n`);
