import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ImportedUtterance {
  id: string;
  speaker: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

interface ImportedMeetingFixture {
  title: string;
  meeting_id: string;
  occurrence_id: string;
  transcript_final: true;
  ocr_status: 'pending';
  utterances: ImportedUtterance[];
  handwriting: [];
  import_metadata: {
    source_format: 'inkloop-meeting-markdown';
    source_sha256: string;
    source_bytes: number;
    stripped_svg_chars: number;
    imported_at: string;
  };
}

const timeRangePattern = /〔\s*(-?\d{1,5}):([0-5]\d)\s*[–—-]\s*(-?\d{1,5}):([0-5]\d)\s*〕/u;
const speakerLinePattern = /^\s*([^#\-*`|][^：:\n]{0,80})[：:]\s*(\S[\s\S]*)$/u;

function toMs(minutes: string, seconds: string): number {
  return Math.max(0, Number(minutes) * 60_000 + Number(seconds) * 1_000);
}

function pseudonym(value: string): string {
  return `speaker-${createHash('sha256').update(value.trim()).digest('hex').slice(0, 8)}`;
}

function stripSvg(source: string): { markdown: string; strippedChars: number } {
  let strippedChars = 0;
  const markdown = source.replace(/<svg\b[\s\S]*?<\/svg>/giu, (value) => {
    strippedChars += value.length;
    return '';
  });
  return { markdown, strippedChars };
}

export function importInkloopMeetingMarkdown(source: string, preserveIdentities = false): ImportedMeetingFixture {
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const { markdown, strippedChars } = stripSvg(source);
  const lines = markdown.split(/\r?\n/);
  const sourceTitle = lines.find((line) => /^#\s+\S/u.test(line))?.replace(/^#\s+/u, '').trim();
  const utterances: ImportedUtterance[] = [];
  let sectionStart = 0;
  let sectionEnd = 0;
  let sectionIndexes: number[] = [];

  const finalizeSection = () => {
    const count = sectionIndexes.length;
    if (!count) return;
    const duration = Math.max(count * 1_000, sectionEnd - sectionStart);
    sectionIndexes.forEach((utteranceIndex, index) => {
      const start = sectionStart + Math.floor(duration * index / count);
      const end = sectionStart + Math.floor(duration * (index + 1) / count);
      utterances[utteranceIndex].start_ms = start;
      utterances[utteranceIndex].end_ms = Math.max(start + 1, end);
    });
    sectionIndexes = [];
  };

  let inFrontmatter = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (lineIndex === 0 && line === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (line === '---') inFrontmatter = false; continue; }
    const range = line.match(timeRangePattern);
    if (range) {
      finalizeSection();
      sectionStart = toMs(range[1], range[2]);
      sectionEnd = Math.max(sectionStart, toMs(range[3], range[4]));
      continue;
    }
    if (/^(?:#|\^|<!--|[-*+]\s)/u.test(line.trim())) continue;
    const match = line.match(speakerLinePattern);
    if (!match) continue;
    const rawSpeaker = match[1].trim();
    const text = match[2].trim();
    if (!text || /^(?:https?|inkloop_|created_|updated_|schema_|id$)/iu.test(rawSpeaker)) continue;
    const index = utterances.length;
    utterances.push({ id: `u${index + 1}`, speaker: preserveIdentities ? rawSpeaker : pseudonym(rawSpeaker), start_ms: sectionStart, end_ms: sectionStart + 1, text });
    sectionIndexes.push(index);
  }
  finalizeSection();

  return {
    title: preserveIdentities && sourceTitle ? sourceTitle : `历史会议样本 ${sourceHash.slice(0, 8)}`,
    meeting_id: `historical-${sourceHash.slice(0, 16)}`,
    occurrence_id: `import:${sourceHash.slice(0, 16)}`,
    transcript_final: true,
    ocr_status: 'pending',
    utterances,
    handwriting: [],
    import_metadata: {
      source_format: 'inkloop-meeting-markdown',
      source_sha256: sourceHash,
      source_bytes: Buffer.byteLength(source),
      stripped_svg_chars: strippedChars,
      imported_at: new Date().toISOString(),
    },
  };
}

export function main(args = process.argv.slice(2)): void {
  const input = args.find((arg) => !arg.startsWith('--'));
  if (!input) throw new Error('Usage: import-inkloop-meeting-markdown <input.md> [--out=<fixture.json>]');
  const inputPath = resolve(input);
  const outputPath = resolve(args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length)
    || `${inputPath.replace(/\.md$/iu, '')}.fixture.json`);
  const fixture = importInkloopMeetingMarkdown(readFileSync(inputPath, 'utf8'), args.includes('--preserve-identities'));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, utterances: fixture.utterances.length, source_bytes: fixture.import_metadata.source_bytes, stripped_svg_chars: fixture.import_metadata.stripped_svg_chars })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
