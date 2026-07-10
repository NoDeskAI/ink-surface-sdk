import type { OcrTextBlock } from '../core/contracts';
import {
  groupLines,
  isPageChromeReflowBlock,
  reflowLocal,
  type ReflowBlock,
} from './reflow';

export type ReflowQualityStatus = 'text_ready' | 'no_text' | 'low_quality' | 'complex_layout';

export type ReflowFalsificationDecision =
  | 'continue_local_reflow'
  | 'fallback_first'
  | 'reopen_engine_scope';

export type ReflowFalsificationExpectation = 'promote' | 'fallback';

export interface ReflowQualityReport {
  page: number;
  status: ReflowQualityStatus;
  ok: boolean;
  source_chars: number;
  reflow_chars: number;
  reflow_block_count: number;
  normalized_text_matches: boolean;
  source_run_count: number;
  covered_run_count: number;
  source_run_coverage: number;
  missing_source_run_ids: boolean;
  source_order_monotonic: boolean;
  duplicate_text_risk: boolean;
  ambiguous_duplicate_without_locator: boolean;
  complex_layout_risk: boolean;
  page_chrome_blocks: number;
  promotion_blockers: string[];
  warnings: string[];
}

export interface AnalyzeReflowCandidateInput {
  page: number;
  blocks: OcrTextBlock[];
  reflowBlocks?: ReflowBlock[];
  minSourceRunCoverage?: number;
}

export interface ReflowFalsificationCaseReport {
  label: string;
  expectation: ReflowFalsificationExpectation;
  pages: ReflowQualityReport[];
}

export interface ReflowFalsificationReport {
  decision: ReflowFalsificationDecision;
  reasons: string[];
  summary: {
    promote_pages: number;
    promoted_pages: number;
    fallback_pages: number;
    blocked_fallback_pages: number;
    reopened_pages: number;
  };
}

export function normalizeReflowIntegrityText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '');
}

export function reflowBlocksText(blocks: ReflowBlock[]): string {
  return blocks.map((block) => block.type === 'list' && block.items?.length ? block.items.join('') : block.text).join('');
}

function sourceLinesText(blocks: OcrTextBlock[]): string {
  return groupLines(blocks).map((line) => line.text).join('');
}

function sourceRunIds(blocks: OcrTextBlock[]): string[] {
  return groupLines(blocks).flatMap((line) => line.runIds);
}

function duplicateLineTextRisk(blocks: OcrTextBlock[]): boolean {
  const counts = new Map<string, number>();
  for (const line of groupLines(blocks)) {
    const normalized = normalizeReflowIntegrityText(line.text);
    if (normalized.length < 6) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count > 1);
}

function looksLikeChromeRun(block: OcrTextBlock): boolean {
  const text = block.text.trim();
  if (!text) return true;
  const yCenter = block.bbox[1] + block.bbox[3] / 2;
  const short = text.length <= 8;
  const pageNumber = /^\d{1,4}$/.test(text) || /^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(text);
  return (yCenter < 0.055 && short) || (yCenter > 0.9 && (short || pageNumber));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function detectTwoColumnRisk(blocks: OcrTextBlock[]): boolean {
  const bodyRuns = blocks
    .filter((block) => block.text.trim() && !looksLikeChromeRun(block))
    .sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));
  if (bodyRuns.length < 4) return false;
  const medianHeight = median(bodyRuns.map((block) => block.bbox[3])) || 0.012;
  const lineGap = 0.6 * medianHeight;
  const rows: OcrTextBlock[][] = [];
  let currentY = -1;
  for (const block of bodyRuns) {
    const yCenter = block.bbox[1] + block.bbox[3] / 2;
    if (rows.length && Math.abs(yCenter - currentY) <= lineGap) {
      rows[rows.length - 1].push(block);
    } else {
      rows.push([block]);
      currentY = yCenter;
    }
  }

  let splitRows = 0;
  for (const row of rows) {
    row.sort((a, b) => a.bbox[0] - b.bbox[0]);
    let largestGap = 0;
    let splitIndex = -1;
    for (let index = 1; index < row.length; index++) {
      const previousRight = row[index - 1].bbox[0] + row[index - 1].bbox[2];
      const gap = row[index].bbox[0] - previousRight;
      if (gap > largestGap) {
        largestGap = gap;
        splitIndex = index;
      }
    }
    if (largestGap < 0.1 || splitIndex < 1) continue;
    const left = row.slice(0, splitIndex);
    const right = row.slice(splitIndex);
    const leftRightEdge = Math.max(...left.map((block) => block.bbox[0] + block.bbox[2]));
    const rightLeftEdge = Math.min(...right.map((block) => block.bbox[0]));
    const splitStraddlesPageCenter = leftRightEdge <= 0.55 && rightLeftEdge >= 0.45;
    if (!splitStraddlesPageCenter) continue;
    const leftChars = normalizeReflowIntegrityText(left.map((block) => block.text).join('')).length;
    const rightChars = normalizeReflowIntegrityText(right.map((block) => block.text).join('')).length;
    if (leftChars >= 6 && rightChars >= 6) splitRows += 1;
  }
  return splitRows >= 2;
}

function sourceRunOrderIsMonotonic(reflowBlocks: ReflowBlock[], orderedSourceRunIds: string[]): boolean {
  if (!reflowBlocks.length) return true;
  const order = new Map(orderedSourceRunIds.map((id, index) => [id, index]));
  const seen = reflowBlocks.flatMap((block) => block.sourceRunIds ?? []).filter((id) => order.has(id));
  if (!seen.length) return false;
  let previous = -1;
  for (const id of seen) {
    const current = order.get(id);
    if (current === undefined) continue;
    if (current < previous) return false;
    previous = current;
  }
  return true;
}

export function analyzeReflowCandidate(input: AnalyzeReflowCandidateInput): ReflowQualityReport {
  const minSourceRunCoverage = input.minSourceRunCoverage ?? 0.98;
  const orderedSourceRunIds = sourceRunIds(input.blocks);
  const sourceRunSet = new Set(orderedSourceRunIds);
  const reflowBlocks = input.reflowBlocks ?? reflowLocal(input.blocks);
  const source = normalizeReflowIntegrityText(sourceLinesText(input.blocks));
  const reflow = normalizeReflowIntegrityText(reflowBlocksText(reflowBlocks));
  const normalizedTextMatches = source === reflow;
  const coveredRunIds = new Set(
    reflowBlocks.flatMap((block) => block.sourceRunIds ?? []).filter((id) => sourceRunSet.has(id)),
  );
  const sourceRunCoverage = sourceRunSet.size ? coveredRunIds.size / sourceRunSet.size : 0;
  const missingSourceRunIds = reflowBlocks.some((block) => !block.sourceRunIds?.length);
  const duplicateTextRisk = duplicateLineTextRisk(input.blocks);
  const sourceOrderMonotonic = sourceRunOrderIsMonotonic(reflowBlocks, orderedSourceRunIds);
  const complexLayoutRisk = detectTwoColumnRisk(input.blocks);
  const pageChromeBlocks = reflowBlocks.filter((block) => isPageChromeReflowBlock(block)).length;
  const ambiguousDuplicateWithoutLocator = duplicateTextRisk && (missingSourceRunIds || sourceRunCoverage < 1);

  const promotionBlockers: string[] = [];
  const warnings: string[] = [];

  if (orderedSourceRunIds.length < 2 || source.length < 8) promotionBlockers.push('no_usable_text');
  if (!reflowBlocks.length || reflow.length < 8) promotionBlockers.push('empty_reflow');
  if (!normalizedTextMatches) promotionBlockers.push('text_mismatch');
  if (sourceRunSet.size > 0 && sourceRunCoverage < minSourceRunCoverage) {
    promotionBlockers.push('source_run_coverage_low');
  }
  if (missingSourceRunIds) promotionBlockers.push('missing_source_run_ids');
  if (!sourceOrderMonotonic) promotionBlockers.push('source_run_order_inversion');
  if (ambiguousDuplicateWithoutLocator) promotionBlockers.push('ambiguous_duplicate_without_locator');
  if (complexLayoutRisk) promotionBlockers.push('complex_layout_risk');
  if (pageChromeBlocks > 0) promotionBlockers.push('page_chrome_not_removed');
  if (duplicateTextRisk && !ambiguousDuplicateWithoutLocator) warnings.push('duplicate_text_disambiguated_by_runs');

  let status: ReflowQualityStatus = 'text_ready';
  if (promotionBlockers.includes('no_usable_text') || promotionBlockers.includes('empty_reflow')) {
    status = 'no_text';
  } else if (complexLayoutRisk) {
    status = 'complex_layout';
  } else if (promotionBlockers.length) {
    status = 'low_quality';
  }

  return {
    page: input.page,
    status,
    ok: status === 'text_ready',
    source_chars: source.length,
    reflow_chars: reflow.length,
    reflow_block_count: reflowBlocks.length,
    normalized_text_matches: normalizedTextMatches,
    source_run_count: sourceRunSet.size,
    covered_run_count: coveredRunIds.size,
    source_run_coverage: sourceRunCoverage,
    missing_source_run_ids: missingSourceRunIds,
    source_order_monotonic: sourceOrderMonotonic,
    duplicate_text_risk: duplicateTextRisk,
    ambiguous_duplicate_without_locator: ambiguousDuplicateWithoutLocator,
    complex_layout_risk: complexLayoutRisk,
    page_chrome_blocks: pageChromeBlocks,
    promotion_blockers: promotionBlockers,
    warnings,
  };
}

function isEngineScopeFailure(report: ReflowQualityReport): boolean {
  return report.promotion_blockers.some((blocker) => (
    blocker === 'text_mismatch'
    || blocker === 'source_run_coverage_low'
    || blocker === 'missing_source_run_ids'
    || blocker === 'source_run_order_inversion'
    || blocker === 'ambiguous_duplicate_without_locator'
    || blocker === 'page_chrome_not_removed'
  ));
}

export function decideReflowFalsification(cases: ReflowFalsificationCaseReport[]): ReflowFalsificationReport {
  const promotePages = cases.flatMap((entry) => entry.expectation === 'promote' ? entry.pages : []);
  const fallbackPages = cases.flatMap((entry) => entry.expectation === 'fallback' ? entry.pages : []);
  const failedPromotions = promotePages.filter((page) => !page.ok);
  const reopenedPages = [
    ...failedPromotions.filter(isEngineScopeFailure),
    ...fallbackPages.filter((page) => page.ok),
  ];

  const reasons: string[] = [];
  if (reopenedPages.length) {
    reasons.push('trust_gate_failed_for_simple_or_negative_control');
    return {
      decision: 'reopen_engine_scope',
      reasons,
      summary: {
        promote_pages: promotePages.length,
        promoted_pages: promotePages.filter((page) => page.ok).length,
        fallback_pages: fallbackPages.length,
        blocked_fallback_pages: fallbackPages.filter((page) => !page.ok).length,
        reopened_pages: reopenedPages.length,
      },
    };
  }

  if (failedPromotions.length || !promotePages.length) {
    reasons.push(failedPromotions.length ? 'target_pages_require_original_fallback' : 'no_promotable_target_pages');
    return {
      decision: 'fallback_first',
      reasons,
      summary: {
        promote_pages: promotePages.length,
        promoted_pages: promotePages.filter((page) => page.ok).length,
        fallback_pages: fallbackPages.length,
        blocked_fallback_pages: fallbackPages.filter((page) => !page.ok).length,
        reopened_pages: 0,
      },
    };
  }

  reasons.push('target_and_control_pages_satisfy_local_reflow_gate');
  return {
    decision: 'continue_local_reflow',
    reasons,
    summary: {
      promote_pages: promotePages.length,
      promoted_pages: promotePages.length,
      fallback_pages: fallbackPages.length,
      blocked_fallback_pages: fallbackPages.filter((page) => !page.ok).length,
      reopened_pages: 0,
    },
  };
}
