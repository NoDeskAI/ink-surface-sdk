import { describe, expect, it } from 'vitest';

import type { NormBBox, OcrTextBlock } from '../core/contracts';
import type { ReflowBlock } from './reflow';
import {
  analyzeReflowCandidate,
  decideReflowFalsification,
} from './reflow-quality';

function block(id: string, text: string, bbox: NormBBox): OcrTextBlock {
  return { id, text, bbox, confidence: 1, language: 'zh-CN' };
}

function singleColumnBlocks(): OcrTextBlock[] {
  return [
    block('run-1', '回顾 UX 发展历史，根据技术平台、应用领域、用户需求。', [0.12, 0.12, 0.74, 0.03]),
    block('run-2', 'UX 的发展可以初步被划分为三个阶段。', [0.12, 0.18, 0.68, 0.03]),
    block('run-3', '进入智能时代后，阅读标记必须保留源文档定位。', [0.12, 0.24, 0.72, 0.03]),
  ];
}

describe('reflow quality gate', () => {
  it('promotes simple single-column text with full source run coverage', () => {
    const report = analyzeReflowCandidate({ page: 1, blocks: singleColumnBlocks() });

    expect(report.status).toBe('text_ready');
    expect(report.ok).toBe(true);
    expect(report.normalized_text_matches).toBe(true);
    expect(report.source_run_coverage).toBe(1);
    expect(report.source_order_monotonic).toBe(true);
    expect(report.promotion_blockers).toEqual([]);
  });

  it('classifies scanned or empty pages as fallback, not successful empty reflow', () => {
    const report = analyzeReflowCandidate({ page: 1, blocks: [] });

    expect(report.status).toBe('no_text');
    expect(report.ok).toBe(false);
    expect(report.promotion_blockers).toContain('no_usable_text');
    expect(report.promotion_blockers).toContain('empty_reflow');
  });

  it('blocks duplicate text when the candidate has no stable source run locators', () => {
    const blocks = [
      block('dup-1', '同一句话重复出现时必须靠 run id 和 bbox 消歧。', [0.12, 0.16, 0.72, 0.03]),
      block('dup-2', '同一句话重复出现时必须靠 run id 和 bbox 消歧。', [0.12, 0.22, 0.72, 0.03]),
    ];
    const reflowBlocks: ReflowBlock[] = [{
      id: 'dup-rfl',
      type: 'para',
      level: 0,
      text: '同一句话重复出现时必须靠 run id 和 bbox 消歧。同一句话重复出现时必须靠 run id 和 bbox 消歧。',
      source: [0.12, 0.16, 0.72, 0.09],
    }];

    const report = analyzeReflowCandidate({ page: 1, blocks, reflowBlocks });

    expect(report.normalized_text_matches).toBe(true);
    expect(report.status).toBe('low_quality');
    expect(report.ambiguous_duplicate_without_locator).toBe(true);
    expect(report.promotion_blockers).toContain('missing_source_run_ids');
    expect(report.promotion_blockers).toContain('ambiguous_duplicate_without_locator');
  });

  it('blocks order-inverted candidates even when they carry run ids', () => {
    const blocks = [
      block('order-1', '第一段必须保持在前面。', [0.12, 0.16, 0.7, 0.03]),
      block('order-2', '第二段必须保持在中间。', [0.12, 0.22, 0.7, 0.03]),
      block('order-3', '第三段必须保持在后面。', [0.12, 0.28, 0.7, 0.03]),
    ];
    const reflowBlocks: ReflowBlock[] = [{
      id: 'order-rfl',
      type: 'para',
      level: 0,
      text: '第二段必须保持在中间。第一段必须保持在前面。第三段必须保持在后面。',
      source: [0.12, 0.16, 0.7, 0.15],
      sourceRunIds: ['order-2', 'order-1', 'order-3'],
    }];

    const report = analyzeReflowCandidate({ page: 1, blocks, reflowBlocks });

    expect(report.status).toBe('low_quality');
    expect(report.source_order_monotonic).toBe(false);
    expect(report.promotion_blockers).toContain('text_mismatch');
    expect(report.promotion_blockers).toContain('source_run_order_inversion');
  });

  it('routes obvious two-column layouts to complex-layout fallback', () => {
    const report = analyzeReflowCandidate({
      page: 1,
      blocks: [
        block('left-1', '左栏第一行说明阅读链路。', [0.08, 0.14, 0.34, 0.03]),
        block('right-1', '右栏第一行说明会议链路。', [0.56, 0.14, 0.34, 0.03]),
        block('left-2', '左栏第二行仍属于阅读。', [0.08, 0.2, 0.34, 0.03]),
        block('right-2', '右栏第二行仍属于会议。', [0.56, 0.2, 0.34, 0.03]),
      ],
    });

    expect(report.status).toBe('complex_layout');
    expect(report.complex_layout_risk).toBe(true);
    expect(report.promotion_blockers).toContain('complex_layout_risk');
  });

  it('returns an explicit continue, fallback, or reopen decision', () => {
    const promoted = analyzeReflowCandidate({ page: 1, blocks: singleColumnBlocks() });
    const noText = analyzeReflowCandidate({ page: 2, blocks: [] });
    expect(decideReflowFalsification([
      { label: 'target', expectation: 'promote', pages: [promoted] },
      { label: 'no_text_control', expectation: 'fallback', pages: [noText] },
    ]).decision).toBe('continue_local_reflow');

    expect(decideReflowFalsification([
      { label: 'target', expectation: 'promote', pages: [noText] },
    ]).decision).toBe('fallback_first');

    const brokenPromotion = analyzeReflowCandidate({
      page: 3,
      blocks: singleColumnBlocks(),
      reflowBlocks: [{
        id: 'broken-rfl',
        type: 'para',
        level: 0,
        text: '这不是原文。',
        source: [0.12, 0.12, 0.74, 0.03],
      }],
    });
    expect(decideReflowFalsification([
      { label: 'broken_target', expectation: 'promote', pages: [brokenPromotion] },
    ]).decision).toBe('reopen_engine_scope');
  });
});
