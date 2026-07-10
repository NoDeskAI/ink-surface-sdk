import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { NormBBox, OcrTextBlock } from '../src/core/contracts';
import { type ReflowBlock } from '../src/surface/reflow';
import {
  analyzeReflowCandidate,
  decideReflowFalsification,
  type ReflowFalsificationCaseReport,
} from '../src/surface/reflow-quality';
import { extractPageBlocks } from './verify-reflow-text-integrity';

const DEFAULT_DEMO_PDF = fileURLToPath(new URL('../public/demo/AI时代的UX范式.pdf', import.meta.url));

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positionalPdfPath(): string | undefined {
  return process.argv.slice(2).find((arg) => !arg.startsWith('--'));
}

function selectedPages(numPages: number): number[] {
  const raw = argValue('--pages');
  if (!raw) return Array.from({ length: Math.min(numPages, 3) }, (_, index) => index + 1);
  if (raw.includes(',')) {
    return raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= numPages);
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) return Array.from({ length: Math.min(numPages, 3) }, (_, index) => index + 1);
  return Array.from({ length: Math.min(numPages, limit) }, (_, index) => index + 1);
}

function block(id: string, text: string, bbox: NormBBox): OcrTextBlock {
  return { id, text, bbox, confidence: 1, language: 'zh-CN' };
}

function syntheticCases(): ReflowFalsificationCaseReport[] {
  const simple = [
    block('simple-title', '2.1 UX 跨时代演进', [0.12, 0.08, 0.52, 0.035]),
    block('simple-1', '回顾 UX 发展历史，根据技术平台、应用领域、用户需求、人机交互等特征。', [0.12, 0.16, 0.76, 0.03]),
    block('simple-2', 'UX 的发展可以初步被划分为三个阶段，并持续进入智能时代。', [0.12, 0.21, 0.72, 0.03]),
    block('simple-3', '标记、回跳和阅读笔记必须保留源文档定位。', [0.12, 0.27, 0.62, 0.03]),
  ];
  const duplicate = [
    block('dup-1', '相同的结论需要依赖源页面和 run id 定位。', [0.12, 0.16, 0.72, 0.03]),
    block('dup-2', '相同的结论需要依赖源页面和 run id 定位。', [0.12, 0.22, 0.72, 0.03]),
  ];
  const duplicateWithoutLocators: ReflowBlock[] = [
    {
      id: 'dup-rfl-1',
      type: 'para',
      level: 0,
      text: '相同的结论需要依赖源页面和 run id 定位。相同的结论需要依赖源页面和 run id 定位。',
      source: [0.12, 0.16, 0.72, 0.09],
    },
  ];
  const orderSource = [
    block('order-1', '第一段必须在第二段之前。', [0.12, 0.16, 0.7, 0.03]),
    block('order-2', '第二段必须在第三段之前。', [0.12, 0.22, 0.7, 0.03]),
    block('order-3', '第三段保留原文顺序。', [0.12, 0.28, 0.7, 0.03]),
  ];
  const orderInverted: ReflowBlock[] = [
    {
      id: 'order-rfl-1',
      type: 'para',
      level: 0,
      text: '第二段必须在第三段之前。第一段必须在第二段之前。第三段保留原文顺序。',
      source: [0.12, 0.16, 0.7, 0.15],
      sourceRunIds: ['order-2', 'order-1', 'order-3'],
    },
  ];
  const twoColumn = [
    block('left-1', '左栏第一行说明产品阅读链路。', [0.08, 0.14, 0.34, 0.03]),
    block('right-1', '右栏第一行说明会议链路。', [0.56, 0.14, 0.34, 0.03]),
    block('left-2', '左栏第二行仍然属于阅读。', [0.08, 0.2, 0.34, 0.03]),
    block('right-2', '右栏第二行仍然属于会议。', [0.56, 0.2, 0.34, 0.03]),
  ];

  return [
    {
      label: 'synthetic_simple_single_column',
      expectation: 'promote',
      pages: [analyzeReflowCandidate({ page: 1, blocks: simple })],
    },
    {
      label: 'synthetic_scanned_no_text',
      expectation: 'fallback',
      pages: [analyzeReflowCandidate({ page: 1, blocks: [] })],
    },
    {
      label: 'synthetic_duplicate_missing_locator',
      expectation: 'fallback',
      pages: [analyzeReflowCandidate({ page: 1, blocks: duplicate, reflowBlocks: duplicateWithoutLocators })],
    },
    {
      label: 'synthetic_order_inverted',
      expectation: 'fallback',
      pages: [analyzeReflowCandidate({ page: 1, blocks: orderSource, reflowBlocks: orderInverted })],
    },
    {
      label: 'synthetic_two_column',
      expectation: 'fallback',
      pages: [analyzeReflowCandidate({ page: 1, blocks: twoColumn })],
    },
  ];
}

async function pdfCase(pdfPath: string): Promise<ReflowFalsificationCaseReport> {
  const bytes = await readFile(pdfPath);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages = [];
  for (const pageNumber of selectedPages(pdf.numPages)) {
    const page = await pdf.getPage(pageNumber);
    const blocks = await extractPageBlocks(page, pageNumber - 1);
    pages.push(analyzeReflowCandidate({ page: pageNumber, blocks }));
  }
  return {
    label: `target_pdf:${pdfPath}`,
    expectation: 'promote',
    pages,
  };
}

async function main(): Promise<void> {
  const explicitPdf = positionalPdfPath();
  const pdfPath = explicitPdf ?? (existsSync(DEFAULT_DEMO_PDF) ? DEFAULT_DEMO_PDF : undefined);
  const cases = syntheticCases();
  if (pdfPath) cases.unshift(await pdfCase(pdfPath));
  const gate = decideReflowFalsification(cases);
  const report = JSON.stringify({
    schema_version: 'inkloop.reader_reflow_falsification_report.v1',
    generated_at: new Date().toISOString(),
    target_pdf: pdfPath ?? null,
    decision: gate.decision,
    reasons: gate.reasons,
    summary: gate.summary,
    cases,
  }, null, 2);
  const outPath = argValue('--out');
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${report}\n`, 'utf8');
  }
  console.log(report);
  if (gate.decision === 'reopen_engine_scope') process.exit(1);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
