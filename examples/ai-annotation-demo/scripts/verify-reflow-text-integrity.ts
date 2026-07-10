import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { NormBBox, OcrTextBlock } from '../src/core/contracts';
import { groupLines, reflowLocal } from '../src/surface/reflow';
import {
  analyzeReflowCandidate,
  normalizeReflowIntegrityText,
  reflowBlocksText,
  type ReflowQualityReport,
} from '../src/surface/reflow-quality';

interface PageReport {
  page: number;
  ok: boolean;
  quality: ReflowQualityReport;
  source_hash: string;
  reflow_hash: string;
  source_chars: number;
  reflow_chars: number;
  diff?: string;
}

function usage(): never {
  console.error('Usage: tsx scripts/verify-reflow-text-integrity.ts <file.pdf> [--pages=N]');
  process.exit(2);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function firstDiff(a: string, b: string): string {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
    aEnd -= 1;
    bEnd -= 1;
  }
  const left = Math.max(0, start - 24);
  const rightA = Math.min(a.length, aEnd + 25);
  const rightB = Math.min(b.length, bEnd + 25);
  return [
    `at char ${start}`,
    `source: ${a.slice(left, rightA)}`,
    `reflow: ${b.slice(left, rightB)}`,
  ].join('\n');
}

export async function extractPageBlocks(page: pdfjsLib.PDFPageProxy, pageIndex: number): Promise<OcrTextBlock[]> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items
    .filter((item): item is TextItem => 'str' in item && typeof item.str === 'string' && item.str.trim().length > 0)
    .map((item, index) => {
      const [, b, , d, e, f] = item.transform;
      const fontH = Math.hypot(b, d) || Math.abs(d) || 10;
      const [vx1, vy1] = vp.convertToViewportPoint(e, f) as [number, number];
      const [vx2, vy2] = vp.convertToViewportPoint(e + item.width, f + fontH) as [number, number];
      const x0 = Math.min(vx1, vx2) / vp.width;
      const x1 = Math.max(vx1, vx2) / vp.width;
      const y0 = Math.min(vy1, vy2) / vp.height;
      const y1 = Math.max(vy1, vy2) / vp.height;
      return {
        id: `p${pageIndex + 1}_tl_${index}`,
        text: item.str,
        bbox: [x0, y0, x1 - x0, y1 - y0] as NormBBox,
        confidence: 1,
        language: 'auto',
      };
    });
}

export async function main(): Promise<void> {
  const pdfPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!pdfPath) usage();
  const pageLimit = Number(argValue('--pages') || 0) || Number.POSITIVE_INFINITY;
  const bytes = await readFile(pdfPath);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const reports: PageReport[] = [];
  for (let i = 0; i < Math.min(pdf.numPages, pageLimit); i++) {
    const page = await pdf.getPage(i + 1);
    const blocks = await extractPageBlocks(page, i);
    const reflowBlocks = reflowLocal(blocks);
    const quality = analyzeReflowCandidate({ page: i + 1, blocks, reflowBlocks });
    const source = normalizeReflowIntegrityText(groupLines(blocks).map((line) => line.text).join(''));
    const reflow = normalizeReflowIntegrityText(reflowBlocksText(reflowBlocks));
    const ok = source === reflow;
    reports.push({
      page: i + 1,
      ok,
      quality,
      source_hash: hash(source),
      reflow_hash: hash(reflow),
      source_chars: source.length,
      reflow_chars: reflow.length,
      ...(ok ? {} : { diff: firstDiff(source, reflow) }),
    });
  }
  const failed = reports.filter((report) => !report.ok);
  console.log(JSON.stringify({
    schema_version: 'inkloop.reflow_text_integrity_report.v1',
    file: pdfPath,
    pages_checked: reports.length,
    passed: failed.length === 0,
    failed_pages: failed.map((report) => report.page),
    reports,
  }, null, 2));
  if (failed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
